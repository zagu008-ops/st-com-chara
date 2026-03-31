/**
 * ComfyUI Gen - 选中文本生图按钮模块
 * 监听聊天区选中事件，浮现 🎨 按钮，点击后基于选中文本生成图片
 */

import { buildPayload, sendToComfyUI } from './comfyui.js';
import { insertResultsToChat } from './imageInserter.js';
import { generateImagePromptFromText } from './promptGen.js';
import { addImageToCache } from './imageCache.js';
import { addLog } from './logger.js';

const LOG_PREFIX = '[ComfyUI Gen][ChatBtn]';
let floatingBtn = null;
let selectedText = '';
let isGenerating = false;

/**
 * 初始化选中文本生图功能
 */
export function initChatButtons() {
    createFloatingButton();
    bindSelectionEvents();
    console.log(`${LOG_PREFIX} 选中文本生图功能已初始化`);
}

/**
 * 创建浮动按钮 DOM（仅创建一次，后续 show/hide）
 */
function createFloatingButton() {
    floatingBtn = document.createElement('div');
    floatingBtn.id = 'cg-sel-gen-btn';
    floatingBtn.className = 'cg-sel-gen-btn';
    floatingBtn.innerHTML = '<i class="fa-solid fa-palette"></i><span>生图</span>';
    floatingBtn.style.display = 'none';
    floatingBtn.addEventListener('click', onGenerateClick);
    // 阻止 mousedown 导致选区丢失
    floatingBtn.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(floatingBtn);
}

/**
 * 绑定选区事件
 */
function bindSelectionEvents() {
    // 监听 chat 区域的 mouseup（选中完成）
    document.addEventListener('mouseup', (e) => {
        // 点击按钮本身时忽略
        if (floatingBtn && floatingBtn.contains(e.target)) return;

        // 延迟一帧确保 selection 已更新
        requestAnimationFrame(() => {
            const selection = window.getSelection();
            const text = (selection?.toString() || '').trim();

            // 检查选区是否在 #chat 区域内
            if (!text || text.length < 5) {
                hideFloatingButton();
                return;
            }

            const anchor = selection.anchorNode;
            const chatEl = document.getElementById('chat');
            if (!chatEl || !anchor || !chatEl.contains(anchor)) {
                hideFloatingButton();
                return;
            }

            selectedText = text;
            // 计算弹出位置：选区末尾的下方
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            showFloatingButton(rect);
        });
    });

    // 点击空白处 / 滚动时隐藏
    document.addEventListener('mousedown', (e) => {
        if (floatingBtn && !floatingBtn.contains(e.target) && floatingBtn.style.display !== 'none') {
            // 延迟以允许按钮点击先处理
            setTimeout(() => {
                const sel = window.getSelection();
                if (!sel || !sel.toString().trim()) {
                    hideFloatingButton();
                }
            }, 200);
        }
    });
}

/**
 * 显示浮动按钮
 */
function showFloatingButton(rect) {
    if (!floatingBtn) return;

    // 定位在选区下方居中
    const btnWidth = 80;
    let left = rect.left + (rect.width / 2) - (btnWidth / 2) + window.scrollX;
    let top = rect.bottom + 8 + window.scrollY;

    // 防止超出屏幕
    left = Math.max(8, Math.min(left, window.innerWidth - btnWidth - 8));

    floatingBtn.style.left = `${left}px`;
    floatingBtn.style.top = `${top}px`;
    floatingBtn.style.display = 'flex';
    floatingBtn.classList.add('cg-sel-gen-show');
}

/**
 * 隐藏浮动按钮
 */
function hideFloatingButton() {
    if (!floatingBtn) return;
    floatingBtn.style.display = 'none';
    floatingBtn.classList.remove('cg-sel-gen-show');
    selectedText = '';
}

/**
 * 点击生图回调
 */
async function onGenerateClick(e) {
    e.stopPropagation();

    if (isGenerating || !selectedText) return;

    const text = selectedText;
    console.log(`${LOG_PREFIX} 用户选中生图，文本长度: ${text.length}`);
    console.log(`${LOG_PREFIX} 选中内容: ${text.substring(0, 150)}...`);
    addLog(`选中文本生图: "${text.substring(0, 50)}..."`);

    isGenerating = true;
    floatingBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>生成中</span>';
    floatingBtn.classList.add('cg-sel-gen-loading');

    try {
        // 1. LLM 生成 tags
        toastr.info('正在根据选中内容生成图片描述...', 'ComfyUI Gen');
        const dynamicPrompt = await generateImagePromptFromText(text);

        if (!dynamicPrompt) {
            toastr.error('LLM 未返回有效标签', 'ComfyUI Gen');
            return;
        }
        console.log(`${LOG_PREFIX} LLM 生成 tags: ${dynamicPrompt.substring(0, 150)}`);

        // 2. 构建 payload & 发送到 ComfyUI
        toastr.info('正在生成图片...', 'ComfyUI Gen');
        const params = buildPayload(dynamicPrompt);
        const results = await sendToComfyUI(params);

        // 3. 插入结果
        if (results && results.length > 0) {
            insertResultsToChat(results, `选中文本生图: ${text.substring(0, 30)}...`);
            // 加入缓存
            for (const r of results) {
                if (r.type === 'image' && r.data) {
                    addImageToCache(r.data, r.filename);
                }
            }
            addLog(`选中文本生图完成，生成 ${results.length} 张图片`);
            toastr.success(`生成了 ${results.length} 张图片！`, 'ComfyUI Gen');
        } else {
            toastr.warning('ComfyUI 未返回图片', 'ComfyUI Gen');
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} 生图失败:`, err);
        toastr.error('生图失败: ' + err.message, 'ComfyUI Gen');
        addLog(`选中文本生图失败: ${err.message}`);
    } finally {
        isGenerating = false;
        floatingBtn.innerHTML = '<i class="fa-solid fa-palette"></i><span>生图</span>';
        floatingBtn.classList.remove('cg-sel-gen-loading');
        hideFloatingButton();
    }
}
