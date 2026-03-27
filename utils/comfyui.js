/**
 * ComfyUI Gen - ComfyUI API 核心通信模块
 * 负责：工作流占位符替换、生图请求、结果轮询、图片获取
 */

import { extension_settings } from '../../../../script.js';
import { extensionName } from './config.js';

/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * 生成随机 client_id
 */
function generateClientId() {
    return 'comfyui-gen-' + Math.random().toString(36).substring(2, 15);
}

/**
 * 构建生图参数对象
 * 合并固定提示词 + 服装提示词 + 角色提示词 + 动态提示词
 */
export function buildPayload(dynamicPrompt = '', extraNegative = '') {
    const settings = getSettings();
    const params = { ...settings.default_params };

    // === 正面提示词合并 ===
    const promptParts = [];
    if (settings.fixed_positive_prompt) {
        promptParts.push(settings.fixed_positive_prompt.trim());
    }

    // 角色提示词
    const activeCharacter = getActiveCharacterPreset();
    if (activeCharacter?.positivePrompt) {
        promptParts.push(activeCharacter.positivePrompt.trim());
    }

    // 服装提示词
    const activeOutfit = getActiveOutfitPreset();
    if (activeOutfit?.positivePrompt) {
        promptParts.push(activeOutfit.positivePrompt.trim());
    }

    // 动态提示词
    if (dynamicPrompt) {
        promptParts.push(dynamicPrompt.trim());
    }

    params.prompt = deduplicateTags(promptParts.join(', '));

    // === 负面提示词合并 ===
    const negativeParts = [];
    if (settings.fixed_negative_prompt) {
        negativeParts.push(settings.fixed_negative_prompt.trim());
    }
    if (activeCharacter?.negativePrompt) {
        negativeParts.push(activeCharacter.negativePrompt.trim());
    }
    if (activeOutfit?.negativePrompt) {
        negativeParts.push(activeOutfit.negativePrompt.trim());
    }
    if (extraNegative) {
        negativeParts.push(extraNegative.trim());
    }
    params.negative_prompt = deduplicateTags(negativeParts.join(', '));

    // === 种子处理 ===
    if (!params.seed || params.seed <= 0) {
        params.seed = Math.floor(Math.random() * 2147483647);
    }

    // === LORA 处理 ===
    const { prompt: cleanPrompt, loras } = extractLoras(params.prompt);
    params.prompt = cleanPrompt;
    params.loras = loras;

    return params;
}

/**
 * 提取 LORA 标签
 * 格式: <lora:name:weight>
 */
function extractLoras(prompt) {
    const loras = [];
    const loraRegex = /<lora:([^:>]+):?([^>]*)>/gi;
    let match;

    while ((match = loraRegex.exec(prompt)) !== null) {
        loras.push({
            name: match[1].trim(),
            weight: parseFloat(match[2]) || 1.0,
        });
    }

    const cleanPrompt = prompt.replace(loraRegex, '').replace(/,\s*,/g, ',').trim();
    return { prompt: cleanPrompt, loras };
}

/**
 * 标签去重
 */
function deduplicateTags(prompt) {
    if (!prompt) return '';
    const tags = prompt.split(',').map(t => t.trim()).filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const tag of tags) {
        const lower = tag.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            unique.push(tag);
        }
    }
    return unique.join(', ');
}

/**
 * 获取当前激活的角色预设
 */
function getActiveCharacterPreset() {
    const settings = getSettings();
    if (!settings.active_character_id) return null;
    return settings.character_presets.find(p => p.id === settings.active_character_id);
}

/**
 * 获取当前激活的服装预设
 */
function getActiveOutfitPreset() {
    const settings = getSettings();
    if (!settings.active_outfit_id) return null;
    return settings.outfit_presets.find(p => p.id === settings.active_outfit_id);
}

/**
 * 工作流模板占位符替换
 * 将 %placeholder% 替换为实际参数值
 */
export function replaceWorkflowPlaceholders(workflowStr, params) {
    if (!workflowStr) {
        console.error('[ComfyUI Gen] 工作流 JSON 为空');
        return null;
    }

    let result = workflowStr;

    // 字符串类型替换（需要保留引号）
    const stringReplacements = {
        '%prompt%': params.prompt || '',
        '%negative_prompt%': params.negative_prompt || '',
        '%sampler_name%': params.sampler_name || 'euler',
        '%MODEL_NAME%': params.model_name || '',
        '%scheduler%': params.scheduler || 'normal',
        '%vae%': params.vae || '',
        '%clip%': params.clip || '',
    };

    // 数字类型替换（去掉引号）
    const numberReplacements = {
        '"%steps%"': params.steps || 20,
        '"%cfg_scale%"': params.cfg_scale || 7,
        '"%width%"': params.width || 512,
        '"%height%"': params.height || 768,
        '"%seed%"': params.seed || Math.floor(Math.random() * 2147483647),
    };

    // 替换字符串类型（提示词中的特殊字符需要转义）
    for (const [placeholder, value] of Object.entries(stringReplacements)) {
        const escaped = String(value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        result = result.replaceAll(placeholder, escaped);
    }

    // 替换数字类型
    for (const [placeholder, value] of Object.entries(numberReplacements)) {
        result = result.replaceAll(placeholder, String(value));
    }

    return result;
}

/**
 * 发送生图请求到 ComfyUI
 */
export async function sendToComfyUI(params) {
    const settings = getSettings();
    const url = settings.comfyui_url.replace(/\/$/, '');
    const workflowStr = settings.workflow_json;

    if (!workflowStr) {
        throw new Error('未配置 ComfyUI 工作流 JSON，请在设置中粘贴工作流');
    }

    // 替换占位符
    const replacedWorkflow = replaceWorkflowPlaceholders(workflowStr, params);
    if (!replacedWorkflow) {
        throw new Error('工作流占位符替换失败');
    }

    let workflow;
    try {
        workflow = JSON.parse(replacedWorkflow);
    } catch (e) {
        throw new Error('工作流 JSON 解析失败：' + e.message);
    }

    const clientId = generateClientId();

    console.log('[ComfyUI Gen] 发送生图请求:', {
        url,
        mode: settings.client_mode,
        prompt: params.prompt?.substring(0, 100) + '...',
    });

    let response;

    if (settings.client_mode === 'server') {
        // 酒馆端模式：通过 SillyTavern 服务器代理
        response = await fetch('/api/plugins/comfyui-gen/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, payload: workflow }),
        });
    } else {
        // 浏览器端模式：直接请求 ComfyUI
        response = await fetch(`${url}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                prompt: workflow,
            }),
        });
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ComfyUI 请求失败 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const promptId = data.prompt_id;

    if (!promptId) {
        throw new Error('未获取到 prompt_id');
    }

    console.log('[ComfyUI Gen] 任务已提交, prompt_id:', promptId);

    // 轮询结果
    const result = await pollResult(url, promptId);
    return result;
}

/**
 * 轮询 ComfyUI 任务结果
 */
async function pollResult(url, promptId, maxRetries = 600) {
    for (let i = 0; i < maxRetries; i++) {
        await sleep(1000);

        try {
            const response = await fetch(`${url}/history/${promptId}`);
            if (!response.ok) continue;

            const data = await response.json();
            const history = data[promptId];

            if (!history) continue;

            // 检查是否完成
            if (history.status?.completed || history.outputs) {
                console.log('[ComfyUI Gen] 生成完成, 获取结果...');
                return await extractOutputs(url, history);
            }

            // 检查是否出错
            if (history.status?.status_str === 'error') {
                throw new Error('ComfyUI 生成出错: ' + JSON.stringify(history.status));
            }
        } catch (e) {
            if (e.message.includes('ComfyUI 生成出错')) throw e;
            // 网络错误继续重试
        }

        if (i % 30 === 0 && i > 0) {
            console.log(`[ComfyUI Gen] 仍在等待生成结果... (${i}s)`);
        }
    }

    throw new Error('生成超时，已等待 ' + maxRetries + ' 秒');
}

/**
 * 从历史记录中提取输出文件
 */
async function extractOutputs(url, history) {
    const outputs = history.outputs || {};
    const results = [];

    for (const nodeId of Object.keys(outputs)) {
        const nodeOutput = outputs[nodeId];

        // 检查图片输出
        if (nodeOutput.images) {
            for (const img of nodeOutput.images) {
                const imageData = await fetchImage(url, img.filename, img.subfolder || '', img.type || 'output');
                if (imageData) {
                    results.push({
                        type: 'image',
                        data: imageData,
                        filename: img.filename,
                    });
                }
            }
        }

        // 检查视频/GIF 输出
        if (nodeOutput.gifs) {
            for (const gif of nodeOutput.gifs) {
                const ext = gif.filename.split('.').pop().toLowerCase();
                const isVideo = ['mp4', 'webm', 'avi'].includes(ext);
                const imageData = await fetchImage(url, gif.filename, gif.subfolder || '', gif.type || 'output');
                if (imageData) {
                    results.push({
                        type: isVideo ? 'video' : 'image',
                        data: imageData,
                        filename: gif.filename,
                    });
                }
            }
        }
    }

    if (results.length === 0) {
        throw new Error('未找到生成结果输出');
    }

    return results;
}

/**
 * 从 ComfyUI 获取图片数据
 */
async function fetchImage(url, filename, subfolder, type = 'output') {
    const params = new URLSearchParams({ filename, subfolder, type });
    const response = await fetch(`${url}/view?${params}`);

    if (!response.ok) {
        console.error('[ComfyUI Gen] 获取图片失败:', filename);
        return null;
    }

    const blob = await response.blob();

    // 可选 JPEG 压缩
    const settings = getSettings();
    if (settings.jpeg_compression && blob.type.startsWith('image/')) {
        return await compressToJpeg(blob, settings.jpeg_quality);
    }

    return await blobToBase64(blob);
}

/**
 * Blob 转 base64
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * JPEG 压缩
 */
function compressToJpeg(blob, quality = 85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', quality / 100));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
    });
}

/**
 * 上传图片到 ComfyUI
 */
export async function uploadImageToComfyUI(file, subfolder = 'comfyui-gen') {
    const settings = getSettings();
    const url = settings.comfyui_url.replace(/\/$/, '');

    const formData = new FormData();
    formData.append('image', file);
    formData.append('subfolder', subfolder);
    formData.append('overwrite', 'true');

    const response = await fetch(`${url}/upload/image`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error('图片上传失败: ' + response.statusText);
    }

    const data = await response.json();
    return data; // { name, subfolder, type }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
