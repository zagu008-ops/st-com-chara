/**
 * ComfyUI Gen - 小说生成助手模块
 * 负责管理小说生成的各种 Prompt，调用 LLM 生成全局大纲、章节走势等。
 */

import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';
import { sysLog } from './comfyui.js';

const LOG_PREFIX = '[ComfyUI Gen][Novel Helper]';

function getSettings() {
    return extension_settings[extensionName] || {};
}

/**
 * 独立调用大模型生成小说内容
 */
export async function callNovelLLM(systemPrompt, userPrompt) {
    const s = getSettings();
    // 优先使用小说特定配置（如果后期加上），否则 fallback AI 助手配置，最后 fallback 反推配置
    const apiUrl = s.novel_api_url || s.ai_api_url || s.llm_interrogate_url;
    const apiKey = s.novel_api_key || s.ai_api_key || s.llm_interrogate_key;
    const model = s.novel_model || s.ai_model || s.llm_interrogate_model;
    const maxTokens = parseInt(s.novel_max_tokens || s.ai_max_tokens || 4000);
    const temperature = parseFloat(s.novel_temperature != null ? s.novel_temperature : (s.ai_temperature != null ? s.ai_temperature : 0.7));

    if (!apiUrl || !model) {
        throw new Error('缺少 LLM 配置：请在 AI 助手设置或反推 Tab 中填写 API 地址和模型名');
    }

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
        temperature
    };

    sysLog(`${LOG_PREFIX} Calling LLM: ${model} @ ${url}`);
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`LLM API ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

// -------------------------------------------------------------
// Prompts (Translated from ainovel + Character Interactive integration)
// -------------------------------------------------------------
export const NovelPrompts = {
    generateInitialOptions(characterInfo) {
        return `基于以下跑团角色预设：
角色名称：${characterInfo.name || '未知'}
角色设定：${characterInfo.description || '无'}
性格特征：${characterInfo.personality || '无'}
当前场景片段：${characterInfo.scenario || '无'}

请作为专业的小说编剧，为该角色与用户的后续互动，设计 3 个截然不同的小说开局/发展路线（选项 A、B、C）。
每个选项需包含：
1. 路线名称（简短有吸引力）
2. 核心冲突与剧情悬念
3. 世界观延伸（无需改动原有设定，而是往外扩写隐藏背景）

请直接用纯文本输出，分为三个区块，以 "选项A："、"选项B："、"选项C：" 开头，不要包含多余的客套话。`;
    },

    coreSeed(topic, genre, numChapters, wordNumber) {
        return `作为专业作家，请用"雪花写作法"第一步构建故事核心：
主题：${topic}
类型：${genre}
篇幅：约${numChapters}章（每章${wordNumber}字）

请用单句公式概括故事本质，例如：
"当[主角]遭遇[核心事件]，必须[关键行动]，否则[灾难后果]；与此同时，[隐藏的更大危机]正在发酵。"

要求：
1. 必须包含显性冲突与潜在危机
2. 体现人物核心驱动力
3. 暗示世界观关键矛盾
4. 使用25-100字精准表达

仅返回故事核心文本，不要解释任何内容。`;
    },

    characterDynamics(userGuidance, coreSeed) {
        return `基于以下元素：
- 内容指导：${userGuidance}
- 核心种子：${coreSeed}

请设计3-6个具有动态变化潜力的核心角色，每个角色需包含：
特征：
- 背景、外貌、性别、年龄、职业等
- 暗藏的秘密或潜在弱点(可与世界观或其他角色有关)

核心驱动力三角：
- 表面追求（物质目标）
- 深层渴望（情感需求）
- 灵魂需求（哲学层面）

角色弧线设计：
初始状态 → 触发事件 → 认知失调 → 蜕变节点 → 最终状态

关系冲突网：
- 与其他角色的关系或对立点
- 与至少两个其他角色的价值观冲突
- 一个合作纽带
- 一个隐藏的背叛可能性

要求：
仅给出最终文本，不要解释任何内容。`;
    },

    worldBuilding(userGuidance, coreSeed) {
        return `基于以下元素：
- 内容指导：${userGuidance}
- 核心冲突："${coreSeed}"

为服务上述内容，请构建三维交织的世界观：

1. 物理维度：
- 空间结构（地理×社会阶层分布图）
- 时间轴（关键历史事件年表）
- 法则体系（物理/魔法/社会规则的漏洞点）

2. 社会维度：
- 权力结构断层线（可引发冲突的阶层/种族/组织矛盾）
- 文化禁忌（可被打破的禁忌及其后果）
- 经济命脉（资源争夺焦点）

3. 隐喻维度：
- 贯穿全书的视觉符号系统（如反复出现的意象）
- 氣候/环境变化映射的心理状态
- 建筑风格暗示的文明困境

要求：
每个维度至少包含3个可与角色决策产生互动的动态元素。
仅给出最终文本，不要解释任何内容。`;
    },

    plotArchitecture(userGuidance, coreSeed, characterDynamics, worldBuilding) {
        return `基于以下元素：
- 内容指导：${userGuidance}
- 核心种子：${coreSeed}
- 角色体系：${characterDynamics}
- 世界观：${worldBuilding}

要求按以下结构设计：
第一幕（触发） 
- 日常状态中的异常征兆（3处铺垫）
- 引出故事：展示主线、暗线、副线的开端
- 关键事件：打破平衡的催化剂（需改变至少3个角色的关系）
- 错误抉择：主角的认知局限导致的错误反应

第二幕（对抗）
- 剧情升级：主线+副线的交叉点
- 双重压力：外部障碍升级+内部挫折
- 虚假胜利：看似解决实则深化危机的转折点
- 灵魂黑夜：世界观认知颠覆时刻

第三幕（解决）
- 代价显现：解决危机必须牺牲的核心价值
- 嵌套转折：至少包含三层认知颠覆（表面解→新危机→终极抉择）
- 余波：留下2个开放式悬念因子

每个阶段需包含3个关键转折点及其对应的伏笔回收方案。
仅给出最终文本，不要解释任何内容。`;
    },

    chunkedBlueprint(userGuidance, novelArchitecture, chapterList, numChapters, startChapter, endChapter) {
        return `基于以下元素：
- 内容指导：${userGuidance}
- 小说架构：
${novelArchitecture}

需要生成总共${numChapters}章的节奏分布。

当前已有章节目录（若为空则说明是初始生成）：
${chapterList}

现在请设计第${startChapter}章到第${endChapter}章的节奏分布：
1. 章节集群划分：
- 每3-5章构成一个悬念单元，包含完整的小高潮
- 单元之间设置"认知过山车"（连续2章紧张→1章缓冲）
- 关键转折章需预留多视角铺垫

2. 每章需明确：
- 章节标题
- 章节定位（角色/事件/主题等）
- 核心悬念类型（信息差/道德困境/时间压力等）
- 情感基调迁移（如从怀疑→恐惧→决绝）
- 伏笔操作（埋设/强化/回收）
- 认知颠覆强度（1-5级）
- 本章简述

输出格式示例：
第n章 - [标题]
本章定位：[角色/事件/主题/...]
核心作用：[推进/转折/揭示/...]
悬念密度：[紧凑/渐进/爆发/...]
伏笔操作：埋设(A线索)→强化(B矛盾)...
认知颠覆：★☆☆☆☆
本章简述：[一句话概括]

要求：
- 使用精炼语言描述，每章字数控制在100字以内。
- 合理安排节奏，确保整体悬念曲线的连贯性。
- 在生成第${numChapters}章前不要出现结局章节。

仅给出最终文本，不要解释任何内容。`;
    },

    summarizeHistory(chatLog) {
        return `作为专业的小说剧情提炼师，请对以下角色扮演对局（RP回合）的原始聊天记录进行大总结。

原始聊天记录：
${chatLog}

要求：
1. 忽略琐碎的闲聊、重复性语气词和系统元提示。
2. 提取出所有推动剧情发展的“关键事件”、“重要情报/决定”、以及“人物关系的变化”。
3. 按照时间发展顺序，生成一份纯净、紧凑的故事大纲纪要（前情提要）。
4. 语言精炼，只需陈述发生的事实，字数强烈压缩。

请直接返回大纲纲要文本，不要包含任何客套话。`;
    }
};

// -------------------------------------------------------------
// APIs
// -------------------------------------------------------------

/**
 * 基于角色设定生成初始小说分支选项
 */
export async function generateInteractiveOptions(characterInfo) {
    const prompt = NovelPrompts.generateInitialOptions(characterInfo);
    return await callNovelLLM('你是一个专业的小说架构师和跑团剧情策划。', prompt);
}

/**
 * 串行执行完整小说的大纲生成
 */
export async function generateGlobalOutline(topic, genre, numChapters, wordNumber, userGuidance = '', onProgress = null) {
    if (onProgress) onProgress('正在生成核心种子...', 10);
    const coreSeed = await callNovelLLM('你是一个专业的小说生成助手。', NovelPrompts.coreSeed(topic, genre, numChapters, wordNumber));

    if (onProgress) onProgress('正在生成角色设定...', 30);
    const characters = await callNovelLLM('你是一个专业的小说角色设计助手。', NovelPrompts.characterDynamics(userGuidance, coreSeed));

    if (onProgress) onProgress('正在构建世界观...', 50);
    const world = await callNovelLLM('你是一个专业的世界观架构助手。', NovelPrompts.worldBuilding(userGuidance, coreSeed));

    if (onProgress) onProgress('正在规划情节架构...', 70);
    const plot = await callNovelLLM('你是一个专业的情节规划助手。', NovelPrompts.plotArchitecture(userGuidance, coreSeed, characters, world));

    if (onProgress) onProgress('生成完毕。', 100);
    return { coreSeed, characters, world, plot };
}

/**
 * 生成章节走势 (每n章)
 */
export async function generateChapterTrend(userGuidance, plotArchitecture, previousChaptersText, totalChapters, startChap, endChap) {
    const prompt = NovelPrompts.chunkedBlueprint(userGuidance, plotArchitecture, previousChaptersText, totalChapters, startChap, endChap);
    return await callNovelLLM('你是一个专业的小说章节编排助手。', prompt);
}

/**
 * 总结冗长的聊天记录为纯净的剧情梗概
 */
export async function summarizeChatHistory(chatLog) {
    const prompt = NovelPrompts.summarizeHistory(chatLog);
    return await callNovelLLM('你是一个专业的小说剧情提炼师。', prompt);
}
