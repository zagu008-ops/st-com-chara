/**
 * ComfyUI Gen - 工作流 AI 助手模块 (Interactive Dialog)
 * 负责读取工作流 JSON，与用户对话，提取关键节点发送给 LLM，
 * 解析 LLM 指令，并自动格式化 JSON 占位符。
 */

import { extension_settings, saveSettingsExtension } from '../../../../extensions.js';
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
    if (safeSettings.llm_interrogate_key) safeSettings.llm_interrogate_key = '***';

    return `你是一个 ComfyUI 配置 Agent（智能助手）。你可以通过对话帮助用户修改他们的工作流 JSON 以及当前插件的设置。
当前插件支持以下关键工作流占位符：
- %prompt% （正向提示词）
- %negative_prompt% （反向提示词）
- %width% （宽度）
- %height% （高度）
- %steps% （步数，注意输出需保留双引号，如 "%steps%"）
- %cfg_scale%
- %seed%

【全局插件设置状态】
${JSON.stringify(safeSettings, null, 2)}

以下是用户当前工作流提取出的【关键节点】：
${JSON.stringify(importantNodes, null, 2)}

【你的任务】
1. 分析用户的意图。如果用户想要配置 API 地址、模型名、ComfyUI 地址、开启某些开关等，你可以自动帮他们修改设置。
2. 如果用户要求“一键替换”或“修复工作流”，你需要帮他们修改节点占位符。
3. 你可以同时执行多项功能。如果是询问信息，则直接用自然语言解释。无论如何，你的自然语言回复应该友好且简明扼要。
4. 如果你需要执行修改，必须在回复的最后面，输出一个且仅一个 JSON 代码块，包含你要执行的所有动作 (actions)。

【JSON 动作指令块格式要求】
请必须使用以下 markdown 格式输出，actions 是一个数组：
\`\`\`json
{
  "actions": [
    {
      "type": "update_settings",
      "settings": {
        "llm_interrogate_url": "https://api.example.com/v1",
        "llm_interrogate_model": "gpt-4o",
        "comfyui_url": "http://127.0.0.1:8188",
        "auto_generate_enabled": true
      }
    },
    {
      "type": "fix_workflow",
      "replacements": [
        { "node_id": "7", "target": "text", "value": "%prompt%" },
        { "node_id": "8", "target": "text", "value": "%negative_prompt%" },
        { "node_id": "3", "target": "seed", "value": "%seed%" }
      ]
    }
  ]
}
\`\`\`

注意：如果是 Save 格式的节点 (没有具体的 target 属性名，只有 list 时)，修工作流的 target 请填 "widget_text"。`;
}

/**
 * 追加气泡
 */
function appendMessage(sender, text) {
    const chatBody = $('#cg-ai-chat-body');
    const msgDiv = $('<div class="cg-ai-msg"></div>').addClass(sender === 'ai' ? 'system-msg' : 'user-msg');
    const avatar = $('<div class="msg-avatar"></div>').html(sender === 'ai' ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>');

    // 渲染 Markdown / 转义
    let formattedText = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
        .replace(/```json([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    const content = $('<div class="msg-content"></div>').html(formattedText);
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

        let cmdObj = JSON.parse(jsonText);
        let workflowChanged = false;

        // 兼容原版的 replacements
        let actions = cmdObj.actions || [];
        if (cmdObj.replacements) {
            actions.push({ type: 'fix_workflow', replacements: cmdObj.replacements });
        }

        for (const action of actions) {
            if (action.type === 'update_settings' && action.settings) {
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
                    await saveSettingsExtension();
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

        if (workflowChanged) {
            return JSON.stringify(workflowObj, null, 2);
        }
        return null;
    } catch (e) {
        console.error(LOG_PREFIX, '执行 AI 命令失败:', e);
        return null;
    }
}

/**
 * 发送消息并获取回复
 */
async function sendChatMessage(userMessage) {
    const s = getSettings();
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
        toastr.error('未找到任何可分别的节点 (CLIPTextEncode 或 KSampler等)', 'ComfyUI AI 助手');
        return;
    }

    appendMessage('user', userMessage);
    $('#cg-ai-chat-input').val('');

    chatHistory.push({ role: 'user', content: userMessage });
    if (chatHistory.length > 10) chatHistory = chatHistory.slice(chatHistory.length - 10);

    const typingMsg = $('<div class="cg-ai-msg system-msg" id="cg-ai-typing"><div class="msg-avatar"><i class="fa-solid fa-robot"></i></div><div class="msg-content"><div class="cg-ai-typing"><span></span><span></span><span></span></div></div></div>');
    $('#cg-ai-chat-body').append(typingMsg);
    $('#cg-ai-chat-body').scrollTop($('#cg-ai-chat-body')[0].scrollHeight);
    $('#cg-ai-chat-send').prop('disabled', true);

    try {
        const systemPrompt = buildAssistantSystemPrompt(importantNodes);

        let fullUserPrompt = "";
        for (let i = 0; i < chatHistory.length - 1; i++) {
            fullUserPrompt += `[${chatHistory[i].role.toUpperCase()}]\n${chatHistory[i].content}\n\n`;
        }
        fullUserPrompt += `[CURRENT USER MESSAGE]\n${userMessage}`;

        const aiResponse = await callLLM(systemPrompt, fullUserPrompt, 800, 0.7);

        if (!aiResponse) throw new Error('LLM 返回为空');

        chatHistory.push({ role: 'assistant', content: aiResponse });

        // 检查是否有 json 命令块
        const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)```/i);
        if (jsonMatch) {
            const newWorkflowStr = await executeAiCommands(jsonMatch[1], workflowStr);
            if (newWorkflowStr) {
                $('#comfyui-gen-workflow').val(newWorkflowStr).trigger('input');
                toastr.success('AI 已自动应用设置/工作流修改！', 'ComfyUI AI 助手');
            }
        }

        typingMsg.remove();
        appendMessage('ai', aiResponse);

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
