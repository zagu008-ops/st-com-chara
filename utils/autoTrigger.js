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
    const s = getSettings();

    // 检查总开关
    if (!s.enabled || !s.auto_generate_enabled) return;

    // 防重复触发
    if (isGenerating) {
        console.log('[ComfyUI Gen] 自动生图: 上一张还在生成中，跳过');
        return;
    }

    try {
        // 获取消息内容
        const context = SillyTavern.getContext();
        const chat = context.chat || [];
        const message = chat[messageIndex];
        if (!message) return;

        // 只对角色消息触发（可配置）
        if (s.auto_only_character && message.is_user) {
            console.log('[ComfyUI Gen] 自动生图: 用户消息，跳过');
            return;
        }

        const messageText = message.mes || '';
        console.log('[ComfyUI Gen] 自动生图: 检测到新消息，模式:', s.auto_trigger_mode);

        let dynamicPrompt = '';

        if (s.auto_trigger_mode === 'marker') {
            // === 标记模式 ===
            const extracted = extractMarkerPrompt(messageText, s.auto_marker_start, s.auto_marker_end);
            if (!extracted) {
                console.log('[ComfyUI Gen] 自动生图: 未检测到标记，跳过');
                return;
            }
            dynamicPrompt = extracted;
            console.log('[ComfyUI Gen] 标记提取成功:', dynamicPrompt.substring(0, 80));

        } else if (s.auto_trigger_mode === 'llm') {
            // === LLM 模式 ===
            showToast('正在用 LLM 生成图片描述...', 'info');

            // 获取用户手动附加的标签
            const userTags = s.auto_user_tags || '';
            dynamicPrompt = await generateImagePrompt(userTags);

            if (!dynamicPrompt) {
                console.log('[ComfyUI Gen] 自动生图: LLM 未返回有效提示词');
                return;
            }
            console.log('[ComfyUI Gen] LLM 生成提示词:', dynamicPrompt.substring(0, 100));
        } else {
            return; // 未知模式
        }

        // 开始生图
        isGenerating = true;
        showToast('开始自动生成图片...', 'info');

        const params = buildPayload(dynamicPrompt);
        console.log('[ComfyUI Gen] 自动生图: 发送到 ComfyUI, prompt 长度:', params.prompt?.length);

        const results = await sendToComfyUI(params);
        insertResultsToChat(results, params.prompt);

        showToast('图片生成完成！', 'success');
        console.log('[ComfyUI Gen] 自动生图完成');

    } catch (e) {
        console.error('[ComfyUI Gen] 自动生图失败:', e);
        showToast('自动生图失败: ' + e.message, 'error');
    } finally {
        isGenerating = false;
    }
}

/**
 * 注册自动触发事件监听
 */
export function registerAutoTrigger() {
    const s = getSettings();
    if (s.auto_generate_enabled) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        console.log('[ComfyUI Gen] 自动生图: 事件监听已注册');
    }
}

/**
 * 注销自动触发事件监听
 */
export function unregisterAutoTrigger() {
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onMessageReceived);
    console.log('[ComfyUI Gen] 自动生图: 事件监听已注销');
}

/**
 * 切换自动触发开关
 * @param {boolean} enabled
 */
export function toggleAutoTrigger(enabled) {
    unregisterAutoTrigger();
    if (enabled) {
        registerAutoTrigger();
    }
}
