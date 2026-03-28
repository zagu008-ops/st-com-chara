/**
 * ComfyUI Gen - 工作流 AI 助手模块
 * 负责读取工作流 JSON，提取关键节点发送给 LLM，
 * 利用 LLM 推理出需要替换的节点 ID，并自动格式化 JSON 占位符。
 */

import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';
import { callLLM } from './promptGen.js';

const LOG_PREFIX = '[ComfyUI Gen][AI Helper]';

/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName] || {};
}

/**
 * 精简工作流 JSON 给 LLM
 * 只提取包含文本的节点（如 CLIPTextEncode）和可能包含数值的节点（如 KSampler/EmptyLatentImage）
 */
function extractImportantNodes(workflowObj) {
    const importantNodes = {};
    let nodeCount = 0;

    for (const [nodeId, nodeData] of Object.entries(workflowObj)) {
        if (!nodeData || typeof nodeData !== 'object' || !nodeData.class_type) continue;

        const type = nodeData.class_type;
        const inputs = nodeData.inputs || {};

        // 我们关心文本输入节点和采样/潜空间节点
        let isImportant = false;
        const extractedDesc = { class_type: type };

        // 提取文本（寻找可能输入 prompt 的地方）
        if (typeof inputs.text === 'string' && inputs.text.length > 0) {
            extractedDesc.text = inputs.text.substring(0, 150) + (inputs.text.length > 150 ? '...' : '');
            isImportant = true;
        }

        // 提取宽/高/种子/步数/CFG
        if (inputs.width !== undefined) { extractedDesc.width = inputs.width; isImportant = true; }
        if (inputs.height !== undefined) { extractedDesc.height = inputs.height; isImportant = true; }
        if (inputs.seed !== undefined || inputs.noise_seed !== undefined) {
            extractedDesc.seed = inputs.seed !== undefined ? inputs.seed : inputs.noise_seed;
            isImportant = true;
        }
        if (inputs.steps !== undefined) { extractedDesc.steps = inputs.steps; isImportant = true; }
        if (inputs.cfg !== undefined) { extractedDesc.cfg = inputs.cfg; isImportant = true; }

        if (isImportant) {
            importantNodes[nodeId] = extractedDesc;
            nodeCount++;
        }
    }

    return { importantNodes, nodeCount };
}

/**
 * 构建系统系统提示词
 */
function buildAssistantSystemPrompt() {
    return `你是一个 ComfyUI 工作流配置助手。
你的任务是阅读用户提取的 ComfyUI 工作流关键节点列表，分析并找出对应的节点ID，以便后续用作字符串占位符替换。

工作流节点列表以 JSON 格式提供。

你需要返回一个 JSON 对象，必须精确对应以下结构，如果找不到对应的节点，请将该字段设为 null。

【需要填写的字段】
"positive_prompt_node": "正向提示词文本节点的ID（通常 class_type 为 CLIPTextEncode，且有较多正面描述词）",
"negative_prompt_node": "负向提示词文本节点的ID（通常 class_type 为 CLIPTextEncode，且包含 worst quality 等负面词）",
"width_node": "定义图片宽度的节点ID（通常在 EmptyLatentImage 里包含 width）",
"height_node": "定义图片高度的节点ID（通常在 EmptyLatentImage 里包含 height）",
"seed_node": "定义随机种子的节点ID（通常在 KSampler 里包含 seed 或 noise_seed）",
"steps_node": "定义采样步数的节点ID（通常在 KSampler 里）",
"cfg_node": "定义 CFG 比例的节点ID（通常在 KSampler 里）"

返回纯 JSON，不要有任何 Markdown 代码块包裹，也不要有说明文字。`;
}

/**
 * 调用 AI 助手进行智能格式化
 * @param {string} rawJsonStr 原始工作流 JSON 字符串
 * @returns {Promise<string|null>} 替换好的 JSON 字符串，如果失败返回 null
 */
export async function autoFormatWorkflowWithAI(rawJsonStr) {
    try {
        if (!rawJsonStr || !rawJsonStr.trim()) {
            throw new Error('工作流为空');
        }

        let workflowObj;
        try {
            workflowObj = JSON.parse(rawJsonStr);
        } catch (e) {
            throw new Error('解析原始 JSON 失败，请检查格式');
        }

        // 1. 提取关键节点
        console.log(`${LOG_PREFIX} 正在提取关键节点...`);
        const { importantNodes, nodeCount } = extractImportantNodes(workflowObj);

        if (nodeCount === 0) {
            throw new Error('未找到任何可分析的节点 (CLIPTextEncode 或 KSampler)');
        }

        console.log(`${LOG_PREFIX} 提取到 ${nodeCount} 个关键节点，开始请求 LLM...`);

        // 2. 准备请求
        const s = getSettings();
        if (!s.ai_url || !s.ai_model) {
            throw new Error('未配置 LLM (请先配置全局的大语言模型 API)');
        }

        const systemPrompt = buildAssistantSystemPrompt();
        const userPrompt = `以下是工作流的关键节点列表：\n${JSON.stringify(importantNodes, null, 2)}`;

        // 3. 调用 LLM
        const analysisResultStr = await callLLM(systemPrompt, userPrompt, 800, 0.1);

        if (!analysisResultStr) {
            throw new Error('LLM 返回为空');
        }

        console.log(`${LOG_PREFIX} LLM 返回结果:`, analysisResultStr);

        // 4. 解析结果
        let analysisObj;
        try {
            // 清理可能包含的 markdown 标签
            let cleanStr = analysisResultStr.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();
            analysisObj = JSON.parse(cleanStr);
        } catch (e) {
            throw new Error('解析 LLM 返回的 JSON 失败');
        }

        console.log(`${LOG_PREFIX} 解析 LLM 判断成功:`, analysisObj);

        // 5. 执行替换
        // 注意：因为我们要保留原始字符串格式（为了 sendToComfyUI 的占位符替换能正常工作），
        // 最安全的做法是在 JSON string 上做正则或 replace，而不是在 object 上操作后 stringify (因为原始 JSON 里的占位符会被当成字符串对待，
        // 在 comfyui.js 的 replaceWorkflowPlaceholders 时，%prompt% 是不用加双引号的，而 %steps% 是带双引号的 "%steps%")

        // 简单修改 object，然后再 stringify
        // 正向提示词
        if (analysisObj.positive_prompt_node && workflowObj[analysisObj.positive_prompt_node]) {
            workflowObj[analysisObj.positive_prompt_node].inputs.text = '%prompt%';
        }
        // 负向提示词
        if (analysisObj.negative_prompt_node && workflowObj[analysisObj.negative_prompt_node]) {
            workflowObj[analysisObj.negative_prompt_node].inputs.text = '%negative_prompt%';
        }

        // 数值型替换（为了配合 comfyui.js 的字符串替换 `"%steps%"`，这里需要转成特定字符串）
        const numVars = [
            { key: 'width_node', field: 'width', placeholder: '%width%' },
            { key: 'height_node', field: 'height', placeholder: '%height%' },
            { key: 'steps_node', field: 'steps', placeholder: '%steps%' },
            { key: 'cfg_node', field: 'cfg', placeholder: '%cfg_scale%' },
            { key: 'seed_node', field: 'seed', placeholder: '%seed%' },
            { key: 'seed_node', field: 'noise_seed', placeholder: '%seed%' }
        ];

        for (const v of numVars) {
            const nodeId = analysisObj[v.key];
            if (nodeId && workflowObj[nodeId] && workflowObj[nodeId].inputs) {
                // 如果节点存在且有这个字段，则将该数值替换为一个独一无二的 "占位符字符串"
                if (workflowObj[nodeId].inputs[v.field] !== undefined) {
                    workflowObj[nodeId].inputs[v.field] = v.placeholder;
                }
            }
        }

        // 把对象转回 JSON 字符串
        let finalJsonStr = JSON.stringify(workflowObj, null, 2);

        // 注意，由于 comfyui.js 的旧逻辑，数字类型的占位符期望是 `"%steps%"` 这种包含双引号的模式被替换为实际数字。
        // json.stringify 会把 `%steps%` 变成 `"%steps%"`，这正是 comfyui.js 期待的格式！

        return finalJsonStr;

    } catch (error) {
        console.error(`${LOG_PREFIX} 发生错误:`, error);
        throw error;
    }
}
