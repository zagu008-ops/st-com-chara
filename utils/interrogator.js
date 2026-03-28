/**
 * ComfyUI Gen - 图片反推提示词模块
 * 支持两种模式：
 * 1. ComfyUI (WD14 Tagger) - 通过 ComfyUI 工作流生成 danbooru 标签
 * 2. LLM Vision - 通过 OpenAI 兼容的视觉大模型 API 分析图片
 */

import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';
import { uploadImageToComfyUI, replaceWorkflowPlaceholders } from './comfyui.js';

/**
 * 对图片进行反推提示词（自动根据设置选择模式）
 * @param {File} imageFile - 图片文件
 * @returns {Promise<string>} - 反推得到的提示词
 */
export async function interrogateImage(imageFile) {
    const settings = extension_settings[extensionName];
    const mode = settings.interrogate_mode || 'comfyui';

    console.log('[ComfyUI Gen] 反推模式:', mode);

    if (mode === 'llm') {
        return await interrogateWithLLM(imageFile);
    } else {
        return await interrogateWithComfyUI(imageFile);
    }
}

// ============ LLM Vision 模式 ============

async function interrogateWithLLM(imageFile) {
    const settings = extension_settings[extensionName];
    const apiUrl = settings.llm_interrogate_url?.replace(/\/$/, '');
    const apiKey = settings.llm_interrogate_key;
    const model = settings.llm_interrogate_model;
    const systemPrompt = settings.llm_interrogate_prompt || 'Please analyze this image and generate Stable Diffusion style tags. Output ONLY comma-separated tags.';

    if (!apiUrl) throw new Error('请先配置 LLM API 地址');
    if (!model) throw new Error('请先配置 LLM 模型名称');

    // 1. 图片转 base64
    console.log('[ComfyUI Gen] 图片转 base64...');
    const base64Data = await fileToBase64(imageFile);
    const mimeType = imageFile.type || 'image/png';

    // 2. 构建 OpenAI 兼容格式的请求
    const endpoint = apiUrl.endsWith('/chat/completions')
        ? apiUrl
        : `${apiUrl}/chat/completions`;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
        model: model,
        messages: [
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${base64Data}`
                        }
                    },
                    {
                        type: 'text',
                        text: '请分析这张图片并生成提示词标签。'
                    }
                ]
            }
        ],
        max_tokens: 1024,
        temperature: 0.3,
    };

    console.log('[ComfyUI Gen] 发送 LLM Vision 请求到:', endpoint);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM API 请求失败 (${response.status}): ${errText.substring(0, 300)}`);
    }

    const data = await response.json();

    // 提取回复内容
    const content = data.choices?.[0]?.message?.content
        || data.choices?.[0]?.text
        || data.output?.text
        || '';

    if (!content) {
        throw new Error('LLM 返回了空内容，请检查模型是否支持图片输入');
    }

    console.log('[ComfyUI Gen] LLM 反推结果:', content.substring(0, 200));
    return content.trim();
}

/**
 * File 转 base64 字符串（不含前缀）
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // 去掉 "data:image/png;base64," 前缀
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ============ ComfyUI WD14 Tagger 模式 ============

async function interrogateWithComfyUI(imageFile) {
    const settings = extension_settings[extensionName];
    const baseUrl = settings.interrogate_url
        ? settings.interrogate_url.replace(/\/$/, '')
        : settings.comfyui_url.replace(/\/$/, '');

    // 1. 上传图片
    console.log('[ComfyUI Gen] 上传图片进行反推到:', baseUrl);
    const uploadResult = await uploadImageToComfyUI(imageFile, 'comfyui-gen', baseUrl);
    const imageName = uploadResult.name;
    const imageSubfolder = uploadResult.subfolder || 'comfyui-gen';

    // 2. 获取反推工作流
    let workflowStr = settings.interrogate_workflow_json;
    if (!workflowStr) {
        workflowStr = getDefaultInterrogateWorkflow();
    }

    // 3. 替换占位符
    workflowStr = workflowStr
        .replaceAll('%interrogate_image%', imageName)
        .replaceAll('%interrogate_subfolder%', imageSubfolder);

    let workflow;
    try {
        workflow = JSON.parse(workflowStr);
    } catch (e) {
        throw new Error('反推工作流 JSON 解析失败: ' + e.message);
    }

    // 4. 发送请求
    const clientId = 'comfyui-gen-interrogate-' + Math.random().toString(36).substring(2, 10);
    const response = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, prompt: workflow }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`反推请求失败 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const promptId = data.prompt_id;

    // 5. 轮询结果
    console.log('[ComfyUI Gen] 等待反推结果...');
    return await pollInterrogateResult(baseUrl, promptId);
}

/**
 * 轮询反推结果
 */
async function pollInterrogateResult(url, promptId, maxRetries = 120) {
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 1000));

        try {
            const response = await fetch(`${url}/history/${promptId}`);
            if (!response.ok) continue;

            const data = await response.json();
            const history = data[promptId];
            if (!history) continue;

            if (history.outputs) {
                return extractTagsFromOutputs(history.outputs);
            }

            if (history.status?.status_str === 'error') {
                throw new Error('反推执行出错');
            }
        } catch (e) {
            if (e.message.includes('反推执行出错')) throw e;
        }
    }

    throw new Error('反推超时');
}

/**
 * 从输出中提取标签文本
 */
function extractTagsFromOutputs(outputs) {
    for (const nodeId of Object.keys(outputs)) {
        const nodeOutput = outputs[nodeId];

        if (nodeOutput.text) {
            if (Array.isArray(nodeOutput.text)) return nodeOutput.text.join(', ');
            return String(nodeOutput.text);
        }

        if (nodeOutput.string) {
            if (Array.isArray(nodeOutput.string)) return nodeOutput.string.join(', ');
            return String(nodeOutput.string);
        }

        if (nodeOutput.tags) {
            return String(nodeOutput.tags);
        }
    }

    throw new Error('未找到反推结果输出，请检查反推工作流是否正确配置输出节点');
}

/**
 * 默认反推工作流（WD14 Tagger）
 */
function getDefaultInterrogateWorkflow() {
    return JSON.stringify({
        "1": {
            "class_type": "LoadImage",
            "inputs": {
                "image": "%interrogate_image%",
                "upload": "image"
            }
        },
        "2": {
            "class_type": "WD14Tagger|pysssss",
            "inputs": {
                "image": ["1", 0],
                "model": "wd-v1-4-moat-tagger-v2",
                "threshold": 0.35,
                "character_threshold": 0.85,
                "replace_underscore": true,
                "trailing_comma": true,
                "exclude_tags": ""
            }
        }
    });
}
