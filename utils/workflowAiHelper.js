/**
 * ComfyUI Gen - 工作流 AI 助手模块 (Interactive Dialog)
 * 负责读取工作流 JSON，与用户对话，提取关键节点发送给 LLM，
 * 解析 LLM 指令，并自动格式化 JSON 占位符。
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';
import { callLLM } from './promptGen.js';

const LOG_PREFIX = '[ComfyUI Gen][AI Helper]';

let chatHistory = [];

/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName] || {};
}

/**
 * 精简工作流 JSON 给 LLM
 * 兼容 API 格式 `{"7": {...}}` 和 Save 格式 `{"nodes": [{"id": 7, ...}]}`
 */
function extractImportantNodes(workflowObj) {
    const importantNodes = {};
    let nodeCount = 0;

    // 适配 Save Format (含有 nodes 数组)
    let nodesIterable = [];
    if (workflowObj.nodes && Array.isArray(workflowObj.nodes)) {
        nodesIterable = workflowObj.nodes.map(n => [n.id || n._name, n]);
    } else {
        nodesIterable = Object.entries(workflowObj);
    }

    for (const [nodeId, nodeData] of nodesIterable) {
        if (!nodeData || typeof nodeData !== 'object' || (!nodeData.class_type && !nodeData.type)) continue;

        const type = nodeData.class_type || nodeData.type;
        // Save format uses nodeData.widgets_values (array) mostly, but API uses inputs (object)
        // Let's try to extract from inputs first (API format)
        const inputs = nodeData.inputs || {};

        let isImportant = false;
        const extractedDesc = { class_type: type };

        // API Format text extraction
        if (typeof inputs.text === 'string' && inputs.text.length > 0) {
            extractedDesc.text = inputs.text.substring(0, 150) + (inputs.text.length > 150 ? '...' : '');
            isImportant = true;
        }

        // Save Format text extraction (usually strings in widgets_values)
        if (nodeData.widgets_values && Array.isArray(nodeData.widgets_values)) {
            const textVals = nodeData.widgets_values.filter(v => typeof v === 'string' && v.length > 5);
            if (textVals.length > 0) {
                extractedDesc.text_values = textVals.map(v => v.substring(0, 100));
                isImportant = true;
            }
        }

        // Number extraction (Width/Height/Seed/Steps/Cfg)
        const checkFields = ['width', 'height', 'seed', 'noise_seed', 'steps', 'cfg'];
        checkFields.forEach(f => {
            if (inputs[f] !== undefined) {
                extractedDesc[f] = inputs[f];
                isImportant = true;
            }
        });

        if (isImportant) {
            importantNodes[nodeId] = extractedDesc;
            nodeCount++;
        }
    }

    return { importantNodes, nodeCount };
}

function buildAssistantSystemPrompt(importantNodes) {
    const currentSettings = getSettings();
    // 隐藏较长且敏感的信息，避免上下文过大
    const safeSettings = { ...currentSettings };
    delete safeSettings.prompt_presets;
    delete safeSettings.workflow_presets;
    delete safeSettings.outfits;
    delete safeSettings.characters;
    delete safeSettings.workers;
    if (safeSettings.llm_interrogate_key) safeSettings.llm_interrogate_key = '***';

    return `你是一个 ComfyUI 配置 Agent（高级智能体）。不仅能陪用户对话，还能直接调用底层系统工具来诊断和修复 ComfyUI 问题！

【全局插件设置状态】
${JSON.stringify(safeSettings, null, 2)}

用户工作流【关键节点】：
${JSON.stringify(importantNodes, null, 2)}

【使用 Agent 工具库 (Tools)】
作为智能体，如果你需要使用工具，你可以输出一段由 \`<SystemQuery>\` ... \`</SystemQuery>\` 包裹的 JSON 代码，以此来触发底层系统功能。你可以返回对象或数组。

支持的工具指令 (type) 有：
1. {"type": "fetch_models"} - 获取 ComfyUI 已经安装的 Checkpoints 和 Loras（将自动返回结果给你）。
2. {"type": "check_comfy_status"} - 测试 ComfyUI 的连接和队列状态（将自动返回结果给你）。
3. {"type": "task_create", "title": "任务面板标题", "steps": ["步骤1", "步骤2"]} - 在界面上渲染一个炫酷的任务执行流面板（提升用户体验）。
4. {"type": "show_options", "options": ["检查模型文件名", "查看堆栈", "尝试重连"]} - 在聊天框渲染供用户点击的快捷回复按钮。
5. {"type": "update_settings", "settings": {"comfyui_url": "..."}} - 修改本插件的系统设置。
6. {"type": "fix_workflow", "replacements": [{"node_id": "3", "target": "seed", "value": "%seed%"}]} - 修复工作流占位符 (%prompt%, %width%, %height%, %seed%, %steps%)，Save 格式需设置 target 为 "widget_text"。

【交互规范】
- 当遇到缺少提示词、节点、模型报错等，务必使用工具帮用户排错！
- 在排错时，你可以先输出自然语言，同时配合 \`<SystemQuery>[{"type":"task_create", ...}, {"type":"fetch_models"}]</SystemQuery>\`，拿回模型列表后再用 \`show_options\` 告诉用户该怎么做。
- 工具执行结果会以 [TOOL RESULT] 前缀作为隐式消息返回给你，你可以根据结果继续回答！
- 如果你已经查明问题并修改了配置，请直接告诉用户结果，不用再展现 options。
`;
}

/**
 * 追加气泡
 * 支持纯文本或者 rawHtml
 */
function appendMessage(sender, text, rawHtml = '') {
    const chatBody = $('#cg-ai-chat-body');
    const msgDiv = $('<div class="cg-ai-msg"></div>').addClass(sender === 'ai' ? 'system-msg' : 'user-msg');
    const avatar = $('<div class="msg-avatar"></div>').html(sender === 'ai' ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>');

    const content = $('<div class="msg-content"></div>');

    if (text) {
        // 渲染 Markdown / 转义
        let formattedText = text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\\n/g, '<br>')
            .replace(/\`\`\`json([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
        content.append(formattedText);
    }

    if (rawHtml) {
        content.append(rawHtml);
    }

    msgDiv.append(avatar).append(content);
    chatBody.append(msgDiv);
    chatBody.scrollTop(chatBody[0].scrollHeight);
}

/**
 * 解析并执行 LLM 返回的 JSON 指令 (Skills)
 */
async function executeAiCommands(jsonText, workflowStr) {
    try {
        let workflowObj;
        try { workflowObj = JSON.parse(workflowStr); } catch (e) { }

        // 清理 LLM 常犯的错误：允许末尾逗号和换行
        let cleanJsonText = jsonText.replace(/,\s*([\]}])/g, '$1');
        let cmdObj = JSON.parse(cleanJsonText);

        let workflowChanged = false;
        let toolResults = [];
        let uiHtml = '';

        // 统一为数组
        let actions = Array.isArray(cmdObj) ? cmdObj : (cmdObj.actions || []);
        if (cmdObj.type) actions.push(cmdObj);
        if (cmdObj.replacements) actions.push({ type: 'fix_workflow', replacements: cmdObj.replacements });

        for (const action of actions) {
            // == UI & Tasks ==
            if (action.type === 'task_create') {
                const steps = (action.steps || []).map(s => `<li style="margin-left:20px;list-style:disc;">${s}</li>`).join('');
                uiHtml += `
                    <div class="cg-ai-tool-call" style="margin-top: 10px;">
                        <div style="color: #f39c12; font-size: 0.85em; margin-bottom: 5px;">⚙️ 智绘姬调用了内部工具...</div>
                        <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; border-left: 3px solid #f39c12;">
                            <strong style="color:#d35400;"><i class="fa-solid fa-microchip"></i> 执行内部命令：${action.title || '诊断任务'}</strong>
                            <ul style="margin: 8px 0 0 0; font-size: 0.9em; opacity: 0.85;">${steps}</ul>
                        </div>
                    </div>
                `;
            }

            else if (action.type === 'show_options') {
                const btns = (action.options || []).map(o => `
                    <button class="cg-ai-option-btn default-button" style="text-align: left; padding: 6px 12px; border-radius: 20px; border: 1px solid rgba(243, 156, 18, 0.5); background: transparent; cursor: pointer; color: var(--SmartThemeBodyColor); margin-bottom: 6px;" onclick="document.getElementById('cg-ai-chat-input').value='${o}'; document.getElementById('cg-ai-chat-send').click();">
                        👉 ${o}
                    </button>
                `).join('');
                uiHtml += `
                    <div class="cg-ai-options" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px;">
                        <div style="color: #f39c12; font-weight: bold; margin-bottom: 10px;">
                            <i class="fa-solid fa-hand-pointer"></i> 请选择操作：
                        </div>
                        <div style="display: flex; flex-direction: column;">${btns}</div>
                        <div style="font-size: 0.8em; opacity: 0.5; margin-top: 5px; text-align: center;">点击选项发送，或直接输入新消息取消</div>
                    </div>
                `;
            }

            // == Real Tools ==
            else if (action.type === 'fetch_models') {
                try {
                    const url = getSettings().comfyui_url.replace(/\\/$ /, '') + '/object_info';
                    const res = await fetch(url);
                    const data = await res.json();
                    const checkpoints = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
                    const loras = data.LoraLoader?.input?.required?.lora_name?.[0] || [];
                    toolResults.push(`[ComfyUI Models]\nCheckpoints: ${checkpoints.slice(0, 20).join(', ')}\nLoras: ${loras.slice(0, 20).join(', ')}`);
                } catch (e) {
                    toolResults.push(`[ComfyUI Action Failed] fetch_models error: ${e.message}`);
                }
            }

            else if (action.type === 'check_comfy_status') {
                try {
                    const url = getSettings().comfyui_url.replace(/\\/$ /, '') + '/system_stats';
                    const res = await fetch(url);
                    const data = await res.json();
                    toolResults.push(`[ComfyUI System Stats]\nOS: ${data.system?.os}\nGPU: ${data.system?.devices?.[0]?.name}\nVRAM total: ${data.system?.devices?.[0]?.vram_total}`);
                } catch (e) {
                    toolResults.push(`[ComfyUI Action Failed] check_comfy_status error: ${e.message} (ComfyUI may be offline)`);
                }
            }

            // == Internal Configuration Modifiers ==
            else if (action.type === 'update_settings' && action.settings) {
                const s = getSettings();
                let settingsChanged = false;
                for (const key in action.settings) {
                    if (action.settings.hasOwnProperty(key)) {
                        s[key] = action.settings[key];
                        settingsChanged = true;

                        // 同步更新 UI
                        const uiId = `#comfyui-gen-${key.replace(/_/g, '-')}`;
                        const $el = $(uiId);
                        if ($el.length) {
                            if ($el.is(':checkbox')) {
                                $el.prop('checked', !!action.settings[key]).trigger('change');
                            } else {
                                $el.val(action.settings[key]);
                            }
                        }
                    }
                }
                if (settingsChanged) {
                    saveSettingsDebounced();
                }
            }

            else if (action.type === 'fix_workflow' && action.replacements && workflowObj) {
                const isSaveFormat = workflowObj.nodes && Array.isArray(workflowObj.nodes);

                for (const rep of action.replacements) {
                    const id = String(rep.node_id);
                    let targetNode = null;

                    if (isSaveFormat) {
                        targetNode = workflowObj.nodes.find(n => String(n.id) === id || String(n._name) === id);
                    } else {
                        targetNode = workflowObj[id];
                    }

                    if (targetNode) {
                        // API Format
                        if (targetNode.inputs && rep.target !== 'widget_text') {
                            targetNode.inputs[rep.target] = rep.value;
                            workflowChanged = true;
                        }
                        // Save Format (widgets_values)
                        else if (targetNode.widgets_values && Array.isArray(targetNode.widgets_values)) {
                            for (let i = 0; i < targetNode.widgets_values.length; i++) {
                                if (typeof targetNode.widgets_values[i] === 'string' && targetNode.widgets_values[i].length > 5) {
                                    targetNode.widgets_values[i] = rep.value;
                                    workflowChanged = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        const res = {};
        if (workflowChanged) {
            res.workflowStr = JSON.stringify(workflowObj, null, 2);
        }
        if (toolResults.length > 0) {
            res.toolResults = toolResults.join('\n\n');
        }
        if (uiHtml) {
            res.uiHtml = uiHtml;
        }
        return res;

    } catch (e) {
        console.error(LOG_PREFIX, '执行 AI 命令失败:', e);
        return null;
    }
}

/**
 * 发送消息并获取回复 (包含自动工具回归机制)
 */
async function sendChatMessage(userMessage, isRecursive = false) {
    const s = getSettings();
    if (!isRecursive) {
        if (!s.llm_interrogate_url || !s.llm_interrogate_model) {
            toastr.error('缺少大模型配置 (请在左侧 [反推] -> [LLM 视觉模型配置] 填写 API 和模型)', 'ComfyUI AI 助手');
            return;
        }

        const workflowStr = $('#comfyui-gen-workflow').val();
        if (!workflowStr || !workflowStr.trim()) {
            toastr.warning('请先在左侧输入框填入 ComfyUI 工作流 JSON', 'ComfyUI AI 助手');
            return;
        }

        let workflowObj;
        try {
            workflowObj = JSON.parse(workflowStr);
        } catch (e) {
            toastr.error('解析原始工作流 JSON 失败，请检查格式是否正确', 'ComfyUI AI 助手');
            return;
        }

        const { importantNodes, nodeCount } = extractImportantNodes(workflowObj);
        if (nodeCount === 0) {
            toastr.error('未找到任何核心生图节点，请检查工作流代码！', 'ComfyUI AI 助手');
            return;
        }

        appendMessage('user', userMessage);
        $('#cg-ai-chat-input').val('');

        chatHistory.push({ role: 'user', content: userMessage });
    }

    if (chatHistory.length > 15) chatHistory = chatHistory.slice(chatHistory.length - 15);

    const typingMsg = $('<div class="cg-ai-msg system-msg" id="cg-ai-typing"><div class="msg-avatar"><i class="fa-solid fa-robot"></i></div><div class="msg-content"><div class="cg-ai-typing"><span></span><span></span><span></span></div></div></div>');
    $('#cg-ai-chat-body').append(typingMsg);
    $('#cg-ai-chat-body').scrollTop($('#cg-ai-chat-body')[0].scrollHeight);
    $('#cg-ai-chat-send').prop('disabled', true);

    try {
        const workflowObj = JSON.parse($('#comfyui-gen-workflow').val() || '{}');
        const { importantNodes } = extractImportantNodes(workflowObj);
        const systemPrompt = buildAssistantSystemPrompt(importantNodes);

        let fullUserPrompt = "";
        for (let i = 0; i < chatHistory.length; i++) {
            fullUserPrompt += `[${chatHistory[i].role.toUpperCase()}]\n${chatHistory[i].content}\n\n`;
        }

        const aiResponse = await callLLM(systemPrompt, fullUserPrompt, 800, 0.7);

        if (!aiResponse) throw new Error('LLM 返回为空');

        chatHistory.push({ role: 'assistant', content: aiResponse });

        // 提取 <SystemQuery> 或者 ```json 动作块
        let jsonText = null;

        let systemQueryMatch = aiResponse.match(/<SystemQuery>([\s\S]*?)<\/SystemQuery>/);
        if (systemQueryMatch) {
            jsonText = systemQueryMatch[1];
        } else {
            const jsonBlockMatch = aiResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
            if (jsonBlockMatch) {
                jsonText = jsonBlockMatch[1];
            } else {
                jsonText = aiResponse.match(/(\{(?:[\s\S]*"type"[\s\S]*|"actions"|\[[\s\S]*\])\})/i)?.[1] || null;
            }
        }

        const rawTextToDisplay = aiResponse.replace(/<SystemQuery>[\s\S]*?<\/SystemQuery>/, '').replace(/```(?:json)?\s*[\s\S]*?\s*```/i, '').trim();

        let uiHtml = '';
        let triggerRecursion = false;

        if (jsonText) {
            const actionResult = await executeAiCommands(jsonText, $('#comfyui-gen-workflow').val());
            if (actionResult) {
                if (actionResult.workflowStr) {
                    $('#comfyui-gen-workflow').val(actionResult.workflowStr).trigger('input');
                    toastr.success('AI 已自动应用设置/工作流修改！', 'ComfyUI AI 助手');
                }
                if (actionResult.toolResults) {
                    // Inject tool result into conversation
                    chatHistory.push({ role: 'system', content: `[TOOL RESULT]\n${actionResult.toolResults}` });
                    triggerRecursion = true;
                }
                if (actionResult.uiHtml) {
                    uiHtml = actionResult.uiHtml;
                }
            } else {
                console.warn(LOG_PREFIX, '提取到 JSON 但执行失败', jsonText);
            }
        }

        typingMsg.remove();

        if (rawTextToDisplay || uiHtml) {
            appendMessage('ai', rawTextToDisplay, uiHtml);
        }

        if (triggerRecursion) {
            // Do NOT enable send button yet, trigger LLM again transparently
            return await sendChatMessage(null, true);
        }

    } catch (error) {
        console.error(error);
        typingMsg.remove();
        appendMessage('ai', '❌ 发生错误: ' + error.message);
    } finally {
        $('#cg-ai-chat-send').prop('disabled', false);
    }
}

/**
 * 初始化 AI 助手弹窗与事件
 */
export function initAiHelperEvents() {
    // 绑定开弹窗按钮
    $('#comfyui-gen-workflow-ai-helper').off('click').on('click', function () {
        $('#cg-ai-dialog').css('display', 'flex');
        setTimeout(() => $('#cg-ai-chat-input').focus(), 100);
    });

    // 关闭弹窗
    $('#cg-ai-dialog-close').off('click').on('click', function () {
        $('#cg-ai-dialog').hide();
    });

    // 发送按钮
    $('#cg-ai-chat-send').off('click').on('click', function () {
        const text = $('#cg-ai-chat-input').val().trim();
        if (text) {
            sendChatMessage(text);
        }
    });

    // 回车发送
    $('#cg-ai-chat-input').off('keydown').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            $('#cg-ai-chat-send').click();
        }
    });
}
