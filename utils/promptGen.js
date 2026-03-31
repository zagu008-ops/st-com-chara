/**
 * ComfyUI Gen - LLM 自动生成图片提示词模块
 * 从聊天上下文 + 角色/服装信息，调用 LLM 生成 danbooru-style tags
 */

import { extension_settings } from '../../../../extensions.js';
import { extensionName } from './config.js';

const LOG_PREFIX = '[ComfyUI Gen][PromptGen]';

/**
 * 获取当前设置
 */
function getSettings() {
    return extension_settings[extensionName] || {};
}

/**
 * 获取当前角色预设信息
 */
function getActiveCharacterInfo() {
    const s = getSettings();
    if (!s.active_character_id || !s.character_presets) return null;
    return s.character_presets.find(p => p.id === s.active_character_id) || null;
}

/**
 * 获取当前服装预设信息
 */
function getActiveOutfitInfo() {
    const s = getSettings();
    if (!s.active_outfit_id || !s.outfit_presets) return null;
    return s.outfit_presets.find(p => p.id === s.active_outfit_id) || null;
}

/**
 * 从 SillyTavern 聊天记录中获取最近 N 条消息
 * @param {number} count - 获取消息条数
 * @returns {Array<{role: string, content: string}>}
 */
function getRecentMessages(count = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];
        console.log(`${LOG_PREFIX} 聊天记录总数: ${chat.length}，取最近 ${count} 条`);
        const recent = chat.slice(-count);
        const result = recent.map(msg => ({
            role: msg.is_user ? 'user' : 'character',
            name: msg.name || (msg.is_user ? '用户' : '角色'),
            content: (msg.mes || '').substring(0, 500), // 截断避免太长
        }));
        console.log(`${LOG_PREFIX} 获取到 ${result.length} 条上下文消息:`);
        result.forEach((msg, i) => {
            console.log(`${LOG_PREFIX}   [${i}] ${msg.name} (${msg.role}): ${msg.content.substring(0, 60)}...`);
        });
        return result;
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ 获取聊天记录失败:`, e);
        return [];
    }
}

/**
 * 构建 LLM 系统提示词
 * @param {object|null} character - 角色预设
 * @param {object|null} outfit - 服装预设
 * @returns {string}
 */
function buildSystemPrompt(character, outfit) {
    const s = getSettings();
    let systemPrompt = s.auto_llm_system_prompt || DEFAULT_SYSTEM_PROMPT;

    // 注入角色信息
    if (character) {
        console.log(`${LOG_PREFIX} 注入角色信息: ${character.name}, tags=${(character.positivePrompt || '').substring(0, 60)}`);
        systemPrompt += `\n\n<角色信息>\n角色名称: ${character.name || '未知'}\n角色外观标签: ${character.positivePrompt || '无'}\n</角色信息>`;
    } else {
        console.log(`${LOG_PREFIX} 无激活角色预设`);
    }

    // 注入服装信息
    if (outfit) {
        console.log(`${LOG_PREFIX} 注入服装信息: ${outfit.name}, tags=${(outfit.positivePrompt || '').substring(0, 60)}`);
        systemPrompt += `\n\n<当前服装>\n服装名称: ${outfit.name || '未知'}\n服装标签: ${outfit.positivePrompt || '无'}\n</当前服装>`;
    } else {
        console.log(`${LOG_PREFIX} 无激活服装预设`);
    }

    console.log(`${LOG_PREFIX} System prompt 长度: ${systemPrompt.length} 字符`);
    return systemPrompt;
}

/**
 * 构建用户消息（包含聊天上下文 + 用户自定义标签）
 * @param {Array} recentMessages - 最近聊天记录
 * @param {string} userTags - 用户手动添加的润色标签
 * @returns {string}
 */
function buildUserPrompt(recentMessages, userTags = '') {
    let prompt = '以下是最近的聊天记录，请根据最新一条角色消息的场景，生成适合的图片标签：\n\n';

    for (const msg of recentMessages) {
        prompt += `[${msg.name}]: ${msg.content}\n`;
    }

    if (userTags && userTags.trim()) {
        prompt += `\n\n用户额外要求的标签/描述（请融合到你的输出中）：\n${userTags.trim()}`;
        console.log(`${LOG_PREFIX} 用户附加标签已注入: ${userTags.trim().substring(0, 60)}`);
    }

    prompt += '\n\n请输出 danbooru-style 逗号分隔标签，不要有任何解释。';

    console.log(`${LOG_PREFIX} User prompt 长度: ${prompt.length} 字符`);
    return prompt;
}

/**
 * 调用 LLM API 生成图片提示词
 * 复用反推 Tab 中的 LLM 配置
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {number} temperature
 * @returns {Promise<string>} 生成的提示词
 */
export async function callLLM(systemPrompt, userPrompt, maxTokens = 500, temperature = 0.7) {
    const s = getSettings();
    const apiUrl = s.llm_interrogate_url;
    const apiKey = s.llm_interrogate_key;
    const model = s.llm_interrogate_model;

    console.log(`${LOG_PREFIX} === 开始调用 LLM ===`);
    console.log(`${LOG_PREFIX} API URL: ${apiUrl || '(未设置!)'}`);
    console.log(`${LOG_PREFIX} Model: ${model || '(未设置!)'}`);
    console.log(`${LOG_PREFIX} API Key: ${apiKey ? '已设置 (长度' + apiKey.length + ')' : '(未设置)'}`);

    if (!apiUrl || !model) {
        throw new Error('LLM 配置未设置，请在「反推」Tab 中配置 LLM API 地址和模型名称');
    }

    const url = apiUrl.replace(/\/+$/, '') + '/chat/completions';
    console.log(`${LOG_PREFIX} 请求地址: ${url}`);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: temperature,
        max_tokens: maxTokens,
    };

    console.log(`${LOG_PREFIX} 请求 body: model=${body.model}, messages=${body.messages.length}条, temperature=${body.temperature}`);
    console.log(`${LOG_PREFIX} 发送 LLM 请求...`);

    const startTime = Date.now();
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
    });
    const elapsed = Date.now() - startTime;

    console.log(`${LOG_PREFIX} LLM 响应: status=${response.status}, 耗时=${elapsed}ms`);

    if (!response.ok) {
        const errText = await response.text();
        console.error(`${LOG_PREFIX} ❌ LLM API 错误:`, errText.substring(0, 300));
        throw new Error(`LLM API 返回错误 (${response.status}): ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    console.log(`${LOG_PREFIX} ✅ LLM 返回成功，内容长度=${content.length}`);
    console.log(`${LOG_PREFIX} LLM 原始返回:\n${content}`);
    return content;
}

/**
 * 解析 LLM 返回的图片标签
 * 支持: <image>tags</image>, <images>tags</images>, 或纯逗号分隔标签
 * @param {string} llmResponse
 * @returns {string} 清理后的 danbooru tags
 */
function parseImageTags(llmResponse) {
    let text = llmResponse || '';

    // 移除 <thinking> 标签
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    // 尝试提取 <image> 或 <images> 标签内容
    const imageMatch = text.match(/<images?>([\s\S]*?)<\/images?>/i);
    if (imageMatch) {
        console.log(`${LOG_PREFIX} 检测到 <image> 标签，提取内容`);
        text = imageMatch[1];
    }

    // 移除 markdown 代码块
    text = text.replace(/```[\s\S]*?```/g, '');

    // 清理多余空白和换行，统一为逗号分隔
    text = text
        .replace(/\n+/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .replace(/,\s*,/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();

    console.log(`${LOG_PREFIX} 解析后的最终 tags (长度=${text.length}): ${text}`);
    return text;
}

/**
 * 主入口：生成图片提示词
 * @param {string} userTags - 用户手动输入的附加标签（可空）
 * @returns {Promise<string>} 生成的 danbooru-style prompt
 */
export async function generateImagePrompt(userTags = '') {
    console.log(`${LOG_PREFIX} ===== generateImagePrompt 开始 =====`);

    const s = getSettings();
    const contextLength = s.auto_context_length || 5;

    // 收集上下文
    const recentMessages = getRecentMessages(contextLength);
    if (recentMessages.length === 0) {
        throw new Error('没有可用的聊天记录来生成提示词');
    }

    // 获取角色/服装信息
    const character = getActiveCharacterInfo();
    const outfit = getActiveOutfitInfo();

    // 构建提示词
    const systemPrompt = buildSystemPrompt(character, outfit);
    const userPrompt = buildUserPrompt(recentMessages, userTags);

    // 调用 LLM
    const llmResponse = await callLLM(systemPrompt, userPrompt);

    // 解析结果
    const tags = parseImageTags(llmResponse);
    console.log(`${LOG_PREFIX} ===== generateImagePrompt 完成 =====`);
    return tags;
}

/**
 * 从指定文本生成图片提示词（用于选中文本生图）
 * 使用专门的「场景分析 Agent」系统提示词，深度提取场景要素
 * @param {string} text - 用户选中的文本
 * @param {string} userTags - 用户手动输入的附加标签（可空）
 * @returns {Promise<string>} 生成的 danbooru-style prompt
 */
export async function generateImagePromptFromText(text, userTags = '') {
    console.log(`${LOG_PREFIX} ===== generateImagePromptFromText 开始 =====`);
    console.log(`${LOG_PREFIX} 输入文本长度: ${text.length}`);

    // 获取角色/服装信息
    const character = getActiveCharacterInfo();
    const outfit = getActiveOutfitInfo();

    // ===== 专用场景分析 Agent 系统提示词 =====
    let systemPrompt = SCENE_ANALYSIS_SYSTEM_PROMPT;

    // 注入角色信息（如有）
    if (character) {
        console.log(`${LOG_PREFIX} 注入角色信息: ${character.name}`);
        systemPrompt += `\n\n<角色参考>\n角色名称: ${character.name || '未知'}\n角色外观标签: ${character.positivePrompt || '无'}\n说明: 请将角色参考标签融入你的输出中，并根据文本内容补充/调整\n</角色参考>`;
    }

    // 注入服装信息（如有）
    if (outfit) {
        console.log(`${LOG_PREFIX} 注入服装信息: ${outfit.name}`);
        systemPrompt += `\n\n<当前服装>\n服装名称: ${outfit.name || '未知'}\n服装标签: ${outfit.positivePrompt || '无'}\n说明: 如果文本中描述的服装与此不同，以文本描述为准\n</当前服装>`;
    }

    // ===== 专用 User Prompt =====
    let userPrompt = `请深度分析以下叙事文本，提取所有视觉要素并生成高质量的图片提示词。

<待分析文本>
${text.substring(0, 2000)}
</待分析文本>`;

    if (userTags && userTags.trim()) {
        userPrompt += `\n\n<用户额外要求>\n${userTags.trim()}\n</用户额外要求>`;
    }

    userPrompt += `

请按照你的职责，逐维度分析文本后，输出最终的 danbooru-style 逗号分隔标签。
只输出标签，不要输出分析过程或任何解释文字。`;

    console.log(`${LOG_PREFIX} Scene Analysis Agent prompt 长度: system=${systemPrompt.length}, user=${userPrompt.length}`);

    // 调用 LLM
    const llmResponse = await callLLM(systemPrompt, userPrompt);

    // 解析结果
    const tags = parseImageTags(llmResponse);
    console.log(`${LOG_PREFIX} ===== generateImagePromptFromText 完成 =====`);
    return tags;
}

/**
 * 默认的 LLM 系统提示词
 */
const DEFAULT_SYSTEM_PROMPT = `你是一个专业的 AI 图片提示词生成器。你的任务是根据聊天记录中最新的场景描述，生成适合 Stable Diffusion / NovelAI 风格的图片标签（danbooru tags）。

规则：
1. 只输出逗号分隔的英文标签，不要有任何解释或其他文字
2. 标签应该包含：人物数量、发型发色、眼睛颜色、表情、服装、姿势、动作、背景、画风等
3. 如果提供了角色信息和服装信息，请优先使用，并结合聊天内容补充场景细节
4. 如果用户提供了额外的标签或描述，请融合到输出中
5. 标签数量控制在 15-30 个之间
6. 使用 danbooru 标签风格，如: 1girl, long hair, blue eyes, smile, school uniform, sitting, classroom, etc.

示例输出：
1girl, solo, long hair, blonde hair, blue eyes, smile, white dress, standing, flower field, sunny, wind, petals, beautiful detailed eyes, depth of field`;

/**
 * 专用「场景分析 Agent」系统提示词
 * 用于选中文本生图 —— 深度提取叙事文本中的视觉要素
 */
const SCENE_ANALYSIS_SYSTEM_PROMPT = `你是一个专业的「视觉场景分析 Agent」。你的核心任务是：深度分析叙事文字，像导演一样提取画面中所有视觉要素，生成高质量的 Stable Diffusion / NovelAI 图片提示词（danbooru tags 风格）。

## 你的分析流程

当你收到一段叙事文本时，请在内心逐步分析（但不要输出分析过程）：

### 维度 1：人物外观
- 人数（1girl / 2girls / 1boy 1girl ...）
- 发型、发色、发长（如 long hair, purple hair, messy hair, hair over one eye）
- 瞳色（如 purple eyes, glowing eyes）
- 体型特征（如 slim, tall, petite）
- 皮肤描写（如 pale skin, flushed skin, sweating）

### 维度 2：表情与情绪
- 面部表情（如 blushing, crying, smirk, parted lips, clenched teeth, embarrassed）
- 眼神（如 looking up, looking away, teary eyes, half-closed eyes, empty eyes）
- 情绪状态转化为视觉标签（如 恐惧→wide eyes, trembling; 愤怒→furrowed brows, angry）

### 维度 3：姿势与动作
- 身体姿势（如 standing, sitting, kneeling, lying down, leaning forward）
- 关键动作（如 reaching out, clenching fists, covering mouth, adjusting clothes, unbuttoning）
- 肢体细节（如 crossed arms, hand on chest, legs together, spread arms）

### 维度 4：衣着与配饰
- 当前穿着的具体描述（如 business suit, white shirt, black skirt, unbuttoned shirt）
- 衣物状态（如 torn clothes, wet clothes, loosened tie, clothes falling off shoulder）
- 配饰（如 necklace, ribbon, hairpin, glasses）

### 维度 5：背景与环境
- 场所（如 bedroom, office, rooftop, dark alley, moonlit path）
- 地面/家具（如 carpet, wooden floor, bed, desk, sofa）
- 天气/时间（如 night, moonlight, rain, sunset, dim lighting）

### 维度 6：氛围与画面构成
- 光线（如 dramatic lighting, backlighting, rim light, candlelight, neon lights）
- 画面氛围（如 cinematic, dark atmosphere, romantic, tense, sensual）
- 构图建议（如 close-up, upper body, full body, from below, from above, dutch angle）
- 画质增强（如 masterpiece, best quality, highly detailed, beautiful detailed eyes）

## 输出规则

1. **只输出**逗号分隔的英文 danbooru-style 标签，**不要**有任何解释、分析过程或其他文字
2. 标签数量控制在 **20-50 个**之间，力求全面覆盖上述 6 个维度
3. 从最重要的标签开始排列（人物 → 外观 → 表情 → 动作 → 衣着 → 背景 → 氛围 → 画质）
4. 如果文本包含多个场景，聚焦于**最具画面感**的那个瞬间
5. 将中文叙述转化为对应的英文视觉标签，不要直接翻译句子
6. 如果提供了角色参考/服装参考标签，优先使用并与文本分析结果融合

## 示例

输入文本: "她站在月光与灯光的交界处，像是一只待宰的白羊。她的眼神里那种倔强的光芒还在，但瞳孔深处，那抹属于被征服者的卑微已经开始疯狂蔓延。"

输出:
1girl, solo, purple hair, long hair, purple eyes, standing, moonlight, dramatic lighting, half shadow, defiant eyes, teary eyes, trembling, pale skin, flushed cheeks, dim lighting, from front, cinematic composition, dark atmosphere, emotional, clenched fists, tense pose, indoor, spotlight, deep shadows, beautiful detailed eyes, masterpiece, best quality, highly detailed

输入文本: "外套顺着圆润的肩头滑落到地毯上，发出沉闷的响声。她缓缓解开了西装腰间的扣子。"

输出:
1girl, solo, jacket falling off, bare shoulders, round shoulders, unbuttoning, business suit, skirt, standing, carpet, indoor, dim room, sensual atmosphere, from front, upper body, looking down, concentrated expression, elegant hands, fingers on button, clothes sliding off, soft lighting, warm tones, masterpiece, best quality, highly detailed`;

