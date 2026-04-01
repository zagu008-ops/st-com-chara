# ComfyUI Gen - AI 小说生成模块架构与实现核心

本文档整理了 `comfyui-gen` 插件中 **AI 小说生成与剧情推进模块** 的所有核心功能、设计思路以及实际使用的底层技术解决方案。

---

## 1. 交互式剧情分支推演 (Interactive Plot Branching)

### 设计思路
传统的剧情生成需要用户手动输入大量的背景设定，体验非常割裂。我们希望实现：用户只需要在酒馆 (SillyTavern) 中打开一个角色，系统就能自动感知该角色的原始设定，并据此推演出多种符合逻辑的“开局互动选项”供用户挑选，然后再基于被选中的分支生成全局小说大纲。

### 实际解决核心
✅ **原生上下文提取**：
通过直接调用 `SillyTavern` 底层的 `getContext()` API，提取 `context.characterId` 并反查 `context.characters[id]`。无需用户干预，系统即可自动截取了当前角色的：`名称 (name)`、`描述 (description)`、`性格 (personality)` 和 `初始场景 (scenario)`。
✅ **二段式推演引擎**：
在 `utils/novelAiHelper.js` 中新增了专用 Prompt (`generateInitialOptions`)，强制大模型以纯文本结构输出 3 个包含“路线名称”、“悬念”和“世界观延伸”的分支。用户挑选后，再通过类似“雪花写作法 (Snowflake Method)”将选定的分支扩写为：核心种子 -> 多维度角色弧光 -> 物理/社会/隐喻三维世界观 -> 结构化的四幕式主线大纲。

---

## 2. 剧情强制底层注入 (Under-the-hood Novel Injection)

### 设计思路
用户希望酒馆里的 AI 回复能彻底“像小说一样发展”，而不仅是生成文本。如果在聊天框里用 System Message 发送设定，会严重污染对话记录，并在长期的上下文滚动中被冲刷遗忘。

### 实际解决核心
✅ **生成事件钩子拦截 (Event Interception)**：
我们侦听了 SillyTavern 最底层的生命周期事件：`eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS)`。
它的运作机制是：
- 在用户点击“发送”，且系统刚刚完成所有的预设组装（准备发给请求接口的前一毫秒）。
- 插件触发拦截，检查 `novel_injection_enabled` 是否开启。
- 若开启，将大纲模块生成的 `【世界背景纲要】`、`【人物发展设定】`、`【后续主线剧情走向】` 组合成一个强力的系统指令块，**静默追加到 `data.main` (System Prompt) 的最末尾**。
- 这保证了 AI 在生成这条回复时具有绝对的剧情约束力，但对用户的 UI 和历史记录保持了 100% 的透明与干净。

---

## 3. 聊天记录极速提取与动态大纲演进 (History Summarization & Trend)

### 设计思路
当跑团进行了一段时间后（例如 5 章），我们需要预测后续 5 章的走势 `/novel-trend`。
但这面临一个严峻的痛点：**跑团的原始聊天记录 (Raw Chat History) 通常包含海量的细节、标点、动作描绘甚至水文字**。如果直接将 Context 塞给 LLM 进行后续演进：
1. 必然触发 Token Limit 溢出。
2. 背景底噪过大，导致大模型无法精准抓取“剧情发生了什么变化”，从而生成出不知所云的后续大纲。

### 实际解决核心
✅ **中间提纯降噪层 (Intermediate Summarization Hook)**：
- **前置切割**：在 `/novel-trend` Slash Command 被触发时，我们首先拦截切片并提取最近的 N 条（如 100 条）真实的 `context.chat`。
- **降维打击**：单独开辟一个 LLM 请求链路 (`summarizeChatHistory` API)，利用严格的 Prompt 指令要求 LLM **“忽略琐碎闲聊，仅提取推动剧情发展的关键事件和人际关系变化”**。
- **纯净喂养**：将几万字的 RP 记录压缩到 10% 以内的纯净“前情提要”，再与全局大纲合并提交给动态推演模块。从此彻底告别爆 Token 闪退，且后续走势推演无比精准。

---

## 4. 全局状态持久化与可视化日志树 (State Persistence & Logging)

### 设计思路
- 新增的独立 UI 和大纲状态应当在浏览器刷新后不丢失。
- 由于上述所有的“系统注入”、“记录提取”操作都在后台静默发生，黑盒运行会让用户不知道系统究竟在干什么，发生了异常也无法排查。

### 实际解决核心
✅ **数据总线持久化**：
所有输入框、大纲生成的结构化 JSON 都实时绑定在 `extension_settings[extensionName]` 字典树上，并挂载 `saveSettingsDebounced()` 防抖保存，重载页面无缝续传。
✅ **透明日志轨道注入**：
复用了现有的 `utils/logger.js`，在所有的关键节点（如开始生成分支、聊天记录总结完成多少字符、系统提示词完成底层静默注入多少字符）插入 `addLog()` 调用。结果同时输出至 Web 终端、面板前端监控台以及可供下载的本地 `.txt` 导出日志。
