/**
 * ComfyUI Gen - 聊天消息生图按钮
 * 替换原来的选词生图：为每条消息添加“生成插图”按钮，点击后为整个消息生成 3-5 张图
 */

import { buildPayload, sendToComfyUI } from './comfyui.js';
import { generateImagePromptFromText } from './promptGen.js';
import { insertResultsToChat } from './imageInserter.js';
import { addImageToCache } from './imageCache.js';
import { addLog } from './logger.js';

const LOG_PREFIX = '[ComfyUI Gen][ChatBtn]';
let isGenerating = false;

/**
 * 初始化消息按钮模块
 */
export function initChatButtons() {
    console.log(`${LOG_PREFIX} 初始化聊天消息生图按钮`);

    // 注入自定义 CSS
    const style = document.createElement('style');
    style.innerHTML = `
        .comfyui-gen-mes-btn {
            cursor: pointer;
            color: var(--SmartThemeBodyColor);
            opacity: 0.6;
            transition: opacity 0.2s, color 0.2s;
            margin-left: 8px;
            font-size: 14px;
        }
        .comfyui-gen-mes-btn:hover {
            opacity: 1;
            color: #b785f6;
        }
    `;
    document.head.appendChild(style);

    // 监听 DOM 变化以给新消息添加按钮
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) {
                    if (node.classList && node.classList.contains('mes')) {
                        addGenerateButtonToMessage(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('.mes').forEach(addGenerateButtonToMessage);
                    }
                }
            });
        });
    });

    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        observer.observe(chatContainer, { childList: true, subtree: true });
        // 初始化已有的消息
        chatContainer.querySelectorAll('.mes').forEach(addGenerateButtonToMessage);
    } else {
        console.warn(`${LOG_PREFIX} #chat 元素未找到，将在 2 秒后重试`);
        setTimeout(initChatButtons, 2000);
    }
}

/**
 * 向单条消息添加生成按钮
 */
function addGenerateButtonToMessage(mesElement) {
    if (mesElement.querySelector('.comfyui-gen-mes-btn')) return; // 已添加

    const nameTextContent = mesElement.querySelector('.name_text');
    if (!nameTextContent) return;

    const btn = document.createElement('span');
    btn.className = 'comfyui-gen-mes-btn';
    btn.title = '为此消息生成 3-5 张插图 (ComfyUI Gen)';
    btn.innerHTML = '<i class="fa-solid fa-images"></i>';

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isGenerating) {
            toastr?.warning('已有生成任务正在进行中');
            return;
        }

        const mesTextEl = mesElement.querySelector('.mes_text');
        if (!mesTextEl) return;
        const text = mesTextEl.innerText.trim();
        if (!text) return;

        await handleGenerateIllustrations(text, btn);
    });

    nameTextContent.appendChild(btn);
}

/**
 * 处理生成 3-5 张插图
 */
async function handleGenerateIllustrations(text, btnElement) {
    isGenerating = true;
    const ogHtml = btnElement.innerHTML;
    btnElement.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btnElement.style.color = '#b785f6';
    btnElement.style.opacity = '1';

    try {
        console.log(`${LOG_PREFIX} 开始为文本生成插图 (文本长度: ${text.length})`);
        toastr?.info('正在分析场景并生成 3-5 个插图提示词...');
        try { addLog(`开始为消息生成 3-5 张插图...`); } catch (_) { }

        // 生成 tags 数组
        const tagsArray = await generateImagePromptFromText(text);

        if (!tagsArray || tagsArray.length === 0) {
            toastr?.warning('未能生成出有效的提示词');
            return;
        }

        toastr?.success(`成功生成 ${tagsArray.length} 个场景提示词，开始串行生图...`);

        // 串行生成图片
        for (let i = 0; i < tagsArray.length; i++) {
            const tags = tagsArray[i];
            console.log(`${LOG_PREFIX} 生成第 ${i + 1}/${tagsArray.length} 张图片, tags: ${tags.substring(0, 100)}...`);
            toastr?.info(`正在生成第 ${i + 1}/${tagsArray.length} 张图...`, 'ComfyUI Gen', { timeOut: 3000 });

            try { addLog(`生成第 ${i + 1} 张图片: ${tags.substring(0, 50)}...`); } catch (_) { }

            const params = buildPayload(tags);
            const results = await sendToComfyUI(params);

            if (results && results.length > 0) {
                insertResultsToChat(results, tags);
                for (const r of results) {
                    if (r.type === 'image' && r.data) {
                        try { addImageToCache(r.data, r.filename); } catch (_) { }
                    }
                }
            } else {
                toastr?.warning(`第 ${i + 1} 张图片生成失败 (ComfyUI 无返回)`);
            }
        }

        toastr?.success('所有插图生成完毕！');
        try { addLog(`成功为消息生成了 ${tagsArray.length} 张图片`); } catch (_) { }

    } catch (err) {
        console.error(`${LOG_PREFIX} ❌ 生成插图失败:`, err);
        toastr?.error('生成失败: ' + err.message);
    } finally {
        isGenerating = false;
        btnElement.innerHTML = ogHtml;
        btnElement.style.color = '';
        btnElement.style.opacity = '';
    }
}
