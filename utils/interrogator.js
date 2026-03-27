/**
 * ComfyUI Gen - 图片反推提示词模块
 * 通过 ComfyUI 的 WD14 Tagger 或 CLIP Interrogator 节点实现
 */

import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';
import { uploadImageToComfyUI, replaceWorkflowPlaceholders } from './comfyui.js';

/**
 * 对图片进行反推提示词
 * @param {File} imageFile - 图片文件
 * @returns {Promise<string>} - 反推得到的提示词
 */
export async function interrogateImage(imageFile) {
    const settings = extension_settings[extensionName];
    const url = settings.comfyui_url.replace(/\/$/, '');

    // 1. 上传图片到 ComfyUI
    console.log('[ComfyUI Gen] 上传图片进行反推...');
    const uploadResult = await uploadImageToComfyUI(imageFile, 'comfyui-gen');
    const imageName = uploadResult.name;
    const imageSubfolder = uploadResult.subfolder || 'comfyui-gen';

    // 2. 检查反推工作流是否配置
    let workflowStr = settings.interrogate_workflow_json;

    if (!workflowStr) {
        // 使用内置默认反推工作流（WD14 Tagger）
        workflowStr = getDefaultInterrogateWorkflow();
    }

    // 3. 替换工作流中的图片占位符
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
    const response = await fetch(`${url}/prompt`, {
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
    const result = await pollInterrogateResult(url, promptId);
    return result;
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
                // 从输出中提取文本结果
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

        // WD14 Tagger 输出格式：text 字段
        if (nodeOutput.text) {
            if (Array.isArray(nodeOutput.text)) {
                return nodeOutput.text.join(', ');
            }
            return String(nodeOutput.text);
        }

        // CLIP Interrogator 输出格式：string 字段
        if (nodeOutput.string) {
            if (Array.isArray(nodeOutput.string)) {
                return nodeOutput.string.join(', ');
            }
            return String(nodeOutput.string);
        }

        // 检查嵌套值
        if (nodeOutput.tags) {
            return String(nodeOutput.tags);
        }
    }

    throw new Error('未找到反推结果输出，请检查反推工作流是否正确配置输出节点');
}

/**
 * 获取默认的反推工作流（WD14 Tagger）
 * 用户也可以在设置中自定义
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
