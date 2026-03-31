/**
 * ComfyUI Gen - 工作流 AI 助手模块 (Interactive Dialog)
 * 负责读取工作流 JSON，与用户对话，提取关键节点发送给 LLM，
 * 解析 LLM 指令，并自动格式化 JSON 占位符。
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';
import { callLLM } from './promptGen.js';
import { sysLog } from './comfyui.js';

const LOG_PREFIX = '[ComfyUI Gen][AI Helper]';

let chatHistory = [];
let currentSessionId = '';

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
7. {"type": "trigger_test_gen"} - 立即触发一次生图测试（当用户要求你生成图片时调用此工具）。

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
        // 先剥离可能残留的 <SystemQuery>（以防万一）
        let cleanText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // 简单 Markdown 渲染
        cleanText = cleanText
            // 标题
            .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
            .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
            .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
            // 粗体和斜体
            .replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^\*]+)\*/g, '<em>$1</em>')
            // 行内代码
            .replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 3px;">$1</code>')
            // 换行
            .replace(/\n/g, '<br>')
            // 代码块
            .replace(/```json([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

        content.append(cleanText);
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
                    const url = getSettings().comfyui_url.replace(/\/$/, '') + '/object_info';
                    sysLog(`[Agent] Fetching node stats: GET ${url}`);
                    const res = await fetch(url);
                    const data = await res.json();
                    const ckptInput = (data.CheckpointLoaderSimple && data.CheckpointLoaderSimple.input && data.CheckpointLoaderSimple.input.required && data.CheckpointLoaderSimple.input.required.ckpt_name) ? data.CheckpointLoaderSimple.input.required.ckpt_name[0] : [];
                    const loraInput = (data.LoraLoader && data.LoraLoader.input && data.LoraLoader.input.required && data.LoraLoader.input.required.lora_name) ? data.LoraLoader.input.required.lora_name[0] : [];

                    sysLog(`[Agent] Successfully retrieved ${ckptInput.length} checkpionts, ${loraInput.length} loras.`);
                    toolResults.push(`[ComfyUI Models]\nCheckpoints: ${ckptInput.slice(0, 20).join(', ')}\nLoras: ${loraInput.slice(0, 20).join(', ')}`);
                } catch (e) {
                    sysLog(`[Agent] Error fetching models: ${e.message}`);
                    toolResults.push(`[ComfyUI Action Failed] fetch_models error: ${e.message}`);
                }
            }

            else if (action.type === 'check_comfy_status') {
                try {
                    const url = getSettings().comfyui_url.replace(/\/$/, '') + '/system_stats';
                    sysLog(`[Agent] Checking status: GET ${url}`);
                    const res = await fetch(url);
                    const data = await res.json();

                    let os = data.system && data.system.os ? data.system.os : 'Unknown';
                    let gpuName = 'Unknown';
                    let vram = 'Unknown';

                    if (data.system && data.system.devices && data.system.devices.length > 0) {
                        gpuName = data.system.devices[0].name || 'Unknown';
                        vram = data.system.devices[0].vram_total || 'Unknown';
                    }

                    sysLog(`[Agent] Status OK. GPU: ${gpuName}, OS: ${os}`);
                    toolResults.push(`[ComfyUI System Stats]\nOS: ${os}\nGPU: ${gpuName}\nVRAM total: ${vram}`);
                } catch (e) {
                    sysLog(`[Agent] Offline / Error: ${e.message}`);
                    toolResults.push(`[ComfyUI Action Failed] check_comfy_status error: ${e.message} (ComfyUI may be offline)`);
                }
            }

            // == Internal Configuration Modifiers ==
            else if (action.type === 'trigger_test_gen') {
                $('#comfyui-gen-test-workflow').click();
                uiHtml += `
                    <div class="cg-ai-tool-call" style="margin-top: 10px;">
                        <div style="color: #27ae60; font-size: 0.85em; margin-bottom: 5px;">🎨 智绘姬已触发测试生图任务...</div>
                    </div>
                `;
            }

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

// ============ 独立 LLM 调用（优先使用 AI 助手独立配置）============

async function callAiLLM(systemPrompt, userPrompt) {
    const s = getSettings();

    // 优先使用 AI 助手独立配置，fallback 到反推配置
    const apiUrl = s.ai_api_url || s.llm_interrogate_url;
    const apiKey = s.ai_api_key || s.llm_interrogate_key;
    const model = s.ai_model || s.llm_interrogate_model;
    const maxTokens = s.ai_max_tokens || 4000;
    const temperature = s.ai_temperature != null ? s.ai_temperature : 0.7;
    const topP = s.ai_top_p != null ? s.ai_top_p : 1.0;

    if (!apiUrl || !model) {
        throw new Error('缺少 LLM 配置：请在 AI 助手设置或反推 Tab 中填写 API 地址和模型名');
    }

    // 如果有独立配置，直接调用；否则 fallback 到 promptGen.callLLM
    if (s.ai_api_url && s.ai_model) {
        const url = apiUrl.replace(/\/$/, '') + '/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const body = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: maxTokens,
            temperature,
            top_p: topP,
        };

        sysLog(`[Agent] Calling independent AI LLM: ${model} @ ${url}`);
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`LLM API ${resp.status}: ${errText.substring(0, 200)}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
    } else {
        // Fallback to shared callLLM from promptGen
        return await callLLM(systemPrompt, userPrompt, maxTokens, temperature);
    }
}

// ============ 模型列表获取 ============

async function fetchAvailableModels() {
    const s = getSettings();
    const apiUrl = s.ai_api_url || s.llm_interrogate_url;
    const apiKey = s.ai_api_key || s.llm_interrogate_key;

    if (!apiUrl) {
        toastr.warning('请先填写 API 地址', 'AI 助手');
        return [];
    }

    const url = apiUrl.replace(/\/$/, '') + '/models';
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    sysLog(`[Agent] Fetching models from: ${url}`);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`获取模型列表失败: ${resp.status}`);
    const data = await resp.json();
    // OpenAI format: data.data = [{ id: 'model-name' }, ...]
    return (data.data || data || []).map(m => m.id || m.name || m).filter(Boolean);
}

// ============ 聊天会话管理 ============

function generateSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function saveChatSession() {
    if (!currentSessionId || chatHistory.length === 0) return;
    const s = getSettings();
    if (!s.ai_chat_sessions) s.ai_chat_sessions = {};

    // 自动标题：取第一条用户消息前 30 字
    const firstUserMsg = chatHistory.find(m => m.role === 'user');
    const title = firstUserMsg ? firstUserMsg.content.substring(0, 30) : '新对话';

    s.ai_chat_sessions[currentSessionId] = {
        messages: chatHistory,
        title,
        updatedAt: Date.now(),
    };
    s.ai_current_session_id = currentSessionId;
    saveSettingsDebounced();
}

function loadChatSession(sessionId) {
    const s = getSettings();
    const session = s.ai_chat_sessions?.[sessionId];
    if (!session) return false;

    chatHistory = session.messages || [];
    currentSessionId = sessionId;
    s.ai_current_session_id = sessionId;

    // 重建聊天 UI
    const chatBody = $('#cg-ai-chat-body');
    chatBody.empty();
    for (const msg of chatHistory) {
        if (msg.role === 'system') continue; // Skip tool results
        appendMessage(msg.role === 'assistant' ? 'ai' : 'user', msg.content);
    }

    saveSettingsDebounced();
    return true;
}

function createNewSession() {
    // 保存当前会话
    saveChatSession();
    // 创建新会话
    chatHistory = [];
    currentSessionId = generateSessionId();
    getSettings().ai_current_session_id = currentSessionId;

    // 重置 UI
    const chatBody = $('#cg-ai-chat-body');
    chatBody.empty();
    chatBody.append(`
        <div class="cg-ai-msg system-msg">
            <div class="msg-avatar"><i class="fa-solid fa-robot"></i></div>
            <div class="msg-content">你好！我是 ComfyUI Gen 的 AI 配置助手。有什么可以帮到你？</div>
        </div>
    `);
    saveSettingsDebounced();
    toastr.info('已创建新对话', 'AI 助手');
}

/**
 * 发送消息并获取回复 (包含自动工具回归机制)
 */
async function sendChatMessage(userMessage, isRecursive = false) {
    const s = getSettings();
    if (!isRecursive) {
        // 确保有 session
        if (!currentSessionId) currentSessionId = generateSessionId();

        // 检查 LLM 配置 (优先 AI 独立，fallback 反推)
        const apiUrl = s.ai_api_url || s.llm_interrogate_url;
        const model = s.ai_model || s.llm_interrogate_model;
        if (!apiUrl || !model) {
            toastr.error('缺少大模型配置 (请点击 ⚙️ 在 AI 助手设置中填写 API 和模型，或在反推 Tab 中配置)', 'ComfyUI AI 助手');
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

        const aiResponse = await callAiLLM(systemPrompt, fullUserPrompt);

        if (!aiResponse) throw new Error('LLM 返回为空');

        chatHistory.push({ role: 'assistant', content: aiResponse });

        // 提取 <SystemQuery> 或者 ```json 动作块
        let jsonText = null;
        let systemQueryMatch = aiResponse.match(/&lt;SystemQuery&gt;([\s\S]*?)(?:&lt;\/SystemQuery&gt;|$)/i) || aiResponse.match(/<SystemQuery>([\s\S]*?)(?:<\/SystemQuery>|$)/i);

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

        // 移除展示文本中的系统块，处理多重 <SystemQuery> 等
        let rawTextToDisplay = aiResponse
            .replace(/<SystemQuery>[\s\S]*?(?:<\/SystemQuery>|$)/gi, '')
            .replace(/```(?:json)?\s*[\s\S]*?\s*```/gi, '')
            .trim();

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

        // 自动保存会话
        saveChatSession();

        if (triggerRecursion) {
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

// ============ 设置面板 UI 辅助函数 ============

function loadAiSettingsToPanel() {
    const s = getSettings();
    $('#cg-ai-api-url').val(s.ai_api_url || '');
    $('#cg-ai-api-key').val(s.ai_api_key || '');
    $('#cg-ai-model').val(s.ai_model || '');
    $('#cg-ai-max-tokens').val(s.ai_max_tokens || 4000);
    $('#cg-ai-temperature').val(s.ai_temperature != null ? s.ai_temperature : 0.7);
    $('#cg-ai-top-p').val(s.ai_top_p != null ? s.ai_top_p : 1.0);
    $('#cg-ai-auto-execute').prop('checked', !!s.ai_auto_execute);
}

function saveAiSettingFromInput(key, value) {
    const s = getSettings();
    s[key] = value;
    saveSettingsDebounced();
}

/**
 * 初始化 AI 助手弹窗与事件
 */
export function initAiHelperEvents() {
    // 恢复上次会话
    const s = getSettings();
    if (s.ai_current_session_id && s.ai_chat_sessions?.[s.ai_current_session_id]) {
        loadChatSession(s.ai_current_session_id);
    } else {
        currentSessionId = generateSessionId();
    }

    // ========= 对话框基本事件 =========

    // 绑定开弹窗按钮
    $('#comfyui-gen-workflow-ai-helper').off('click').on('click', function () {
        $('#cg-ai-dialog').css('display', 'flex');
        setTimeout(() => $('#cg-ai-chat-input').focus(), 100);
    });

    // 关闭弹窗
    $('#cg-ai-dialog-close').off('click').on('click', function () {
        saveChatSession();
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

    // ========= 新建聊天 =========
    $('#cg-ai-new-chat').off('click').on('click', function () {
        createNewSession();
    });

    // ========= 设置面板开关 =========
    $('#cg-ai-settings-btn').off('click').on('click', function () {
        loadAiSettingsToPanel();
        $('#cg-ai-settings-panel').addClass('open');
    });

    $('#cg-ai-settings-close, #cg-ai-save-settings').off('click').on('click', function () {
        $('#cg-ai-settings-panel').removeClass('open');
    });

    // ========= 设置面板 Tab 切换 =========
    $(document).off('click', '.cg-ai-settings-tab').on('click', '.cg-ai-settings-tab', function () {
        const tab = $(this).data('ai-stab');
        $('.cg-ai-settings-tab').removeClass('active');
        $(this).addClass('active');
        $('.cg-ai-settings-tab-content').removeClass('active');
        $(`.cg-ai-settings-tab-content[data-ai-stab-content="${tab}"]`).addClass('active');
    });

    // ========= 设置项自动保存 =========
    $('#cg-ai-api-url').off('change').on('change', function () {
        saveAiSettingFromInput('ai_api_url', $(this).val().trim());
    });
    $('#cg-ai-api-key').off('change').on('change', function () {
        saveAiSettingFromInput('ai_api_key', $(this).val().trim());
    });
    $('#cg-ai-model').off('change').on('change', function () {
        saveAiSettingFromInput('ai_model', $(this).val().trim());
    });
    $('#cg-ai-max-tokens').off('change').on('change', function () {
        saveAiSettingFromInput('ai_max_tokens', parseInt($(this).val()) || 4000);
    });
    $('#cg-ai-temperature').off('change').on('change', function () {
        saveAiSettingFromInput('ai_temperature', parseFloat($(this).val()) || 0.7);
    });
    $('#cg-ai-top-p').off('change').on('change', function () {
        saveAiSettingFromInput('ai_top_p', parseFloat($(this).val()) || 1.0);
    });
    $('#cg-ai-auto-execute').off('change').on('change', function () {
        saveAiSettingFromInput('ai_auto_execute', $(this).prop('checked'));
    });

    // ========= 模型列表获取 =========
    $('#cg-ai-fetch-models').off('click').on('click', async function () {
        const $btn = $(this);
        const originalHtml = $btn.html();
        $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 获取中...').prop('disabled', true);
        try {
            const models = await fetchAvailableModels();
            const $select = $('#cg-ai-model-select');
            $select.empty().append('<option value="">(选择模型)</option>');
            models.forEach(m => $select.append(`<option value="${m}">${m}</option>`));
            toastr.success(`成功获取 ${models.length} 个模型`, 'AI 助手');
        } catch (e) {
            toastr.error('获取模型失败: ' + e.message, 'AI 助手');
        } finally {
            $btn.html(originalHtml).prop('disabled', false);
        }
    });

    // 模型选择联动
    $('#cg-ai-model-select').off('change').on('change', function () {
        const selected = $(this).val();
        if (selected) {
            $('#cg-ai-model').val(selected).trigger('change');
        }
    });
}
