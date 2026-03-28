/**
 * ComfyUI Gen - 自动生图触发模块
 * 监听 SillyTavern 的 MESSAGE_RECEIVED 事件，自动从聊天提取/生成提示词并调用 ComfyUI 生图
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../../script.js';
import { extensionName } from './config.js';
import { buildPayload, sendToComfyUI } from './comfyui.js';
import { insertResultsToChat } from './imageInserter.js';
import { generateImagePrompt } from './promptGen.js';

let isGenerating = false; // 防重复触发锁
const LOG_PREFIX = '[ComfyUI Gen][AutoTrigger]';

/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName] || {};
}

/**
 * 从文本中提取标记包裹的提示词
 * @param {string} text - 消息文本
 * @param {string} startMark - 开始标记
 * @param {string} endMark - 结束标记
 * @returns {string|null} 提取到的提示词，未找到返回 null
 */
function extractMarkerPrompt(text, startMark = '[', endMark = ']') {
    if (!text || !startMark || !endMark) return null;

    // 转义正则特殊字符
    const escStart = startMark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escEnd = endMark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const regex = new RegExp(`${escStart}([^${escEnd}]+)${escEnd}`, 'g');
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const content = match[1].trim();
        // 过滤掉太短或明显不是提示词的内容
        if (content.length > 3 && content.includes(',')) {
            matches.push(content);
        }
    }

    if (matches.length === 0) return null;
    // 返回最后一个匹配（通常是最新的）
    return matches[matches.length - 1];
}

/**
 * 显示生图进度提示
 * @param {string} message
 * @param {string} type - 'info' | 'success' | 'error'
 */
function showToast(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type](message, 'ComfyUI Gen 自动生图');
    }
}

/**
 * MESSAGE_RECEIVED 事件回调
 * @param {number} messageIndex - 消息索引
 */
async function onMessageReceived(messageIndex) {
    console.log(`${LOG_PREFIX} ========== 事件触发 ==========`);
    console.log(`${LOG_PREFIX} MESSAGE_RECEIVED 触发，消息索引: ${messageIndex}`);

    const s = getSettings();

    // 检查总开关
    if (!s.enabled) {
        console.log(`${LOG_PREFIX} ❌ 插件未启用 (enabled=${s.enabled})，跳过`);
        return;
    }
    if (!s.auto_generate_enabled) {
        console.log(`${LOG_PREFIX} ❌ 自动生图未启用 (auto_generate_enabled=${s.auto_generate_enabled})，跳过`);
        return;
    }
    console.log(`${LOG_PREFIX} ✅ 开关检查通过 (enabled=${s.enabled}, auto_generate_enabled=${s.auto_generate_enabled})`);

    // 防重复触发
    if (isGenerating) {
        console.log(`${LOG_PREFIX} ⏸️ 上一张还在生成中 (isGenerating=true)，跳过`);
        return;
    }

    try {
        // 获取消息内容
        let context;
        try {
            context = SillyTavern.getContext();
        } catch (ctxErr) {
            console.error(`${LOG_PREFIX} ❌ 获取 SillyTavern context 失败:`, ctxErr);
            return;
        }

        const chat = context.chat || [];
        console.log(`${LOG_PREFIX} 当前聊天记录总条数: ${chat.length}`);

        const message = chat[messageIndex];
        if (!message) {
            console.log(`${LOG_PREFIX} ❌ 消息索引 ${messageIndex} 对应的消息不存在，跳过`);
            return;
        }

        console.log(`${LOG_PREFIX} 消息详情: is_user=${message.is_user}, name=${message.name}, 文本前80字=${(message.mes || '').substring(0, 80)}`);

        // 只对角色消息触发（可配置）
        if (s.auto_only_character && message.is_user) {
            console.log(`${LOG_PREFIX} ⏭️ 用户消息，auto_only_character=${s.auto_only_character}，跳过`);
            return;
        }
        console.log(`${LOG_PREFIX} ✅ 消息类型检查通过 (is_user=${message.is_user})`);

        const messageText = message.mes || '';
        console.log(`${LOG_PREFIX} 触发模式: ${s.auto_trigger_mode}`);

        let dynamicPrompt = '';

        if (s.auto_trigger_mode === 'marker') {
            // === 标记模式 ===
            console.log(`${LOG_PREFIX} [标记模式] 开始标记='${s.auto_marker_start}', 结束标记='${s.auto_marker_end}'`);
            const extracted = extractMarkerPrompt(messageText, s.auto_marker_start, s.auto_marker_end);
            if (!extracted) {
                console.log(`${LOG_PREFIX} [标记模式] ❌ 未检测到标记，跳过。消息内容: ${messageText.substring(0, 150)}`);
                return;
            }
            dynamicPrompt = extracted;
            console.log(`${LOG_PREFIX} [标记模式] ✅ 标记提取成功: ${dynamicPrompt.substring(0, 100)}`);

        } else if (s.auto_trigger_mode === 'llm') {
            // === LLM 模式 ===
            console.log(`${LOG_PREFIX} [LLM模式] 开始调用 LLM 生成提示词...`);
            console.log(`${LOG_PREFIX} [LLM模式] LLM 配置: url=${s.llm_interrogate_url || '(未设置)'}, model=${s.llm_interrogate_model || '(未设置)'}, key=${s.llm_interrogate_key ? '已设置' : '(未设置)'}`);
            showToast('正在用 LLM 生成图片描述...', 'info');

            // 获取用户手动附加的标签
            const userTags = s.auto_user_tags || '';
            console.log(`${LOG_PREFIX} [LLM模式] 用户附加标签: ${userTags || '(无)'}`);

            dynamicPrompt = await generateImagePrompt(userTags);

            if (!dynamicPrompt) {
                console.log(`${LOG_PREFIX} [LLM模式] ❌ LLM 未返回有效提示词`);
                showToast('LLM 未返回有效提示词', 'error');
                return;
            }
            console.log(`${LOG_PREFIX} [LLM模式] ✅ LLM 生成的最终 tags: ${dynamicPrompt.substring(0, 200)}`);
        } else {
            console.log(`${LOG_PREFIX} ❌ 未知触发模式: '${s.auto_trigger_mode}'，跳过`);
            return;
        }

        // 开始生图
        isGenerating = true;
        showToast('开始自动生成图片...', 'info');

        console.log(`${LOG_PREFIX} [ComfyUI] 开始构建 payload...`);
        const params = buildPayload(dynamicPrompt);
        console.log(`${LOG_PREFIX} [ComfyUI] ✅ payload 构建完成，prompt 长度=${params.prompt?.length}, negative_prompt 长度=${params.negative_prompt?.length}`);
        console.log(`${LOG_PREFIX} [ComfyUI] 最终 prompt 前 200 字: ${params.prompt?.substring(0, 200)}`);
        console.log(`${LOG_PREFIX} [ComfyUI] 发送生图请求到 ComfyUI...`);

        const results = await sendToComfyUI(params);
        console.log(`${LOG_PREFIX} [ComfyUI] ✅ ComfyUI 返回结果: ${results?.length || 0} 个文件`);

        if (results && results.length > 0) {
            insertResultsToChat(results, params.prompt);
            showToast(`图片生成完成！${results.length} 张`, 'success');
            console.log(`${LOG_PREFIX} ✅ 自动生图完成，已插入 ${results.length} 个结果到聊天`);
        } else {
            console.log(`${LOG_PREFIX} ⚠️ ComfyUI 返回了空结果`);
            showToast('ComfyUI 未返回任何图片', 'warning');
        }

    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ 自动生图失败:`, e);
        console.error(`${LOG_PREFIX} 错误堆栈:`, e.stack);
        showToast('自动生图失败: ' + e.message, 'error');
    } finally {
        isGenerating = false;
        console.log(`${LOG_PREFIX} ========== 事件处理结束 ==========`);
    }
}

/**
 * 注册自动触发事件监听
 */
export function registerAutoTrigger() {
    const s = getSettings();
    console.log(`${LOG_PREFIX} registerAutoTrigger() 调用，auto_generate_enabled=${s.auto_generate_enabled}`);
    if (s.auto_generate_enabled) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        console.log(`${LOG_PREFIX} ✅ 事件监听已注册 (event: ${event_types.MESSAGE_RECEIVED})`);
    } else {
        console.log(`${LOG_PREFIX} ⏭️ 自动生图未启用，不注册事件监听`);
    }
}

/**
 * 注销自动触发事件监听
 */
export function unregisterAutoTrigger() {
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    console.log(`${LOG_PREFIX} 事件监听已注销`);
}

/**
 * 切换自动触发开关
 * @param {boolean} enabled
 */
export function toggleAutoTrigger(enabled) {
    console.log(`${LOG_PREFIX} toggleAutoTrigger(${enabled}) 调用`);
    unregisterAutoTrigger();
    if (enabled) {
        registerAutoTrigger();
    }
}
