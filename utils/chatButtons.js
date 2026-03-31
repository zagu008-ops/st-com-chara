/**
 * ComfyUI Gen - 选中文本生图按钮模块
 * 监听聊天区选中事件，浮现 🎨 按钮，点击后基于选中文本生成图片
 *
 * 注意：使用 left/top 定位 + display 控制可见性
 * 原因：SillyTavern body 存在 CSS transform，position:fixed + bottom 失效
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
    try {
        createFloatingButton();
        bindSelectionEvents();
        console.log(`${LOG_PREFIX} ✅ 选中文本生图功能已初始化`);
    } catch (e) {
        console.error(`${LOG_PREFIX} ❌ 初始化失败:`, e);
    }
}

/**
 * 创建浮动按钮 DOM（仅创建一次，后续 show/hide）
 */
function createFloatingButton() {
    // 防止重复创建
    const existing = document.getElementById('cg-sel-gen-btn');
    if (existing) {
        floatingBtn = existing;
        return;
    }

    floatingBtn = document.createElement('div');
    floatingBtn.id = 'cg-sel-gen-btn';
    floatingBtn.className = 'cg-sel-gen-btn';
    floatingBtn.innerHTML = '<i class="fa-solid fa-palette"></i><span>生图</span>';
    floatingBtn.style.display = 'none';

    // 点击生图
    floatingBtn.addEventListener('click', onGenerateClick);
    // 阻止 mousedown 导致选区丢失
    floatingBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    document.body.appendChild(floatingBtn);
    console.log(`${LOG_PREFIX} 浮动按钮已创建并挂载到 body`);
}

/**
 * 绑定选区事件
 */
function bindSelectionEvents() {
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    console.log(`${LOG_PREFIX} 选区事件已绑定`);
}

/**
 * 鼠标抬起回调 —— 检测选区
 */
function onMouseUp(e) {
    // 点击按钮本身时忽略
    if (floatingBtn && floatingBtn.contains(e.target)) return;
    // 生成中不响应新选区
    if (isGenerating) return;

    // 延迟一帧确保 selection 已更新
    requestAnimationFrame(() => {
        try {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) {
                console.log(`${LOG_PREFIX} 无选区或 rangeCount=0`);
                hideFloatingButton();
                return;
            }

            const text = (selection.toString() || '').trim();

            // 最少 5 个字符才触发
            if (!text || text.length < 5) {
                if (text) console.log(`${LOG_PREFIX} 选中文本太短 (${text.length} < 5)`);
                hideFloatingButton();
                return;
            }

            // 检查选区是否在 #chat 区域内
            const anchor = selection.anchorNode;
            const chatEl = document.getElementById('chat');

            if (!chatEl) {
                console.log(`${LOG_PREFIX} ⚠️ #chat 容器不存在（可能未打开聊天）`);
                hideFloatingButton();
                return;
            }

            if (!anchor || !chatEl.contains(anchor)) {
                console.log(`${LOG_PREFIX} 选区不在 #chat 内，忽略`);
                hideFloatingButton();
                return;
            }

            selectedText = text;
            console.log(`${LOG_PREFIX} ✅ 检测到选中文本，长度=${text.length}: "${text.substring(0, 50)}..."`);

            // 计算弹出位置：选区末尾的下方
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            console.log(`${LOG_PREFIX} 选区矩形:`, JSON.stringify({
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                bottom: Math.round(rect.bottom),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            }));
            showFloatingButton(rect);
        } catch (err) {
            console.error(`${LOG_PREFIX} 选区检测异常:`, err);
        }
    });
}

/**
 * 鼠标按下回调 —— 隐藏按钮
 */
function onMouseDown(e) {
    if (!floatingBtn) return;
    if (floatingBtn.contains(e.target)) return;
    if (floatingBtn.style.display === 'none') return;

    setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || !sel.toString().trim()) {
            hideFloatingButton();
        }
    }, 250);
}

/**
 * 显示浮动按钮（使用 left/top 定位）
 */
function showFloatingButton(rect) {
    if (!floatingBtn) return;

    const btnWidth = 80;
    const btnHeight = 32;

    let left = rect.left + (rect.width / 2) - (btnWidth / 2);
    let top = rect.bottom + 8;

    // 防止超出屏幕
    left = Math.max(8, Math.min(left, window.innerWidth - btnWidth - 8));
    if (top + btnHeight > window.innerHeight - 8) {
        top = rect.top - btnHeight - 8;
    }

    // 使用 left/top 并清除 right/bottom（绕开 SillyTavern transform 问题）
    floatingBtn.style.position = 'fixed';
    floatingBtn.style.left = `${left}px`;
    floatingBtn.style.top = `${top}px`;
    floatingBtn.style.right = 'auto';
    floatingBtn.style.bottom = 'auto';

    // 直接设置可见性（不依赖 CSS transition 的 opacity）
    floatingBtn.style.display = 'flex';
    floatingBtn.style.opacity = '1';
    floatingBtn.style.transform = 'translateY(0)';
    floatingBtn.classList.add('cg-sel-gen-show');

    console.log(`${LOG_PREFIX} 🎨 浮动按钮已显示 at (${Math.round(left)}, ${Math.round(top)})`);

    // 即时诊断按钮实际位置
    requestAnimationFrame(() => {
        const btnRect = floatingBtn.getBoundingClientRect();
        const inViewport = btnRect.left >= 0 && btnRect.top >= 0 &&
            btnRect.right <= window.innerWidth && btnRect.bottom <= window.innerHeight;
        console.log(`${LOG_PREFIX} 按钮实际位置:`,
            JSON.stringify({ top: Math.round(btnRect.top), left: Math.round(btnRect.left) }),
            '在视口内:', inViewport);
        if (!inViewport) {
            console.warn(`${LOG_PREFIX} ⚠️ 按钮不在视口内！尝试强制修正...`);
            // 强制修正到可见位置
            floatingBtn.style.left = `${Math.max(8, Math.min(left, window.innerWidth - btnWidth - 8))}px`;
            floatingBtn.style.top = `${Math.max(8, Math.min(top, window.innerHeight - btnHeight - 8))}px`;
        }
    });
}

/**
 * 隐藏浮动按钮
 */
function hideFloatingButton() {
    if (!floatingBtn) return;
    if (floatingBtn.style.display === 'none') return;
    floatingBtn.style.display = 'none';
    floatingBtn.style.opacity = '0';
    floatingBtn.classList.remove('cg-sel-gen-show');
    selectedText = '';
}

/**
 * 点击生图回调
 */
async function onGenerateClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (isGenerating || !selectedText) return;

    const text = selectedText;
    console.log(`${LOG_PREFIX} ▶ 开始生图，文本长度: ${text.length}`);
    console.log(`${LOG_PREFIX}   选中内容: ${text.substring(0, 150)}...`);

    try { addLog(`选中文本生图: "${text.substring(0, 50)}..."`); } catch (_) { }

    isGenerating = true;
    floatingBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>生成中</span>';
    floatingBtn.classList.add('cg-sel-gen-loading');

    try {
        // 1. LLM 生成 tags
        if (typeof toastr !== 'undefined') {
            toastr.info('正在根据选中内容生成图片描述...', 'ComfyUI Gen');
        }
        const dynamicPrompt = await generateImagePromptFromText(text);

        if (!dynamicPrompt) {
            if (typeof toastr !== 'undefined') toastr.error('LLM 未返回有效标签', 'ComfyUI Gen');
            return;
        }
        console.log(`${LOG_PREFIX} ✅ LLM 生成 tags: ${dynamicPrompt.substring(0, 150)}`);

        // 2. 构建 payload & 发送到 ComfyUI
        if (typeof toastr !== 'undefined') toastr.info('正在生成图片...', 'ComfyUI Gen');
        const params = buildPayload(dynamicPrompt);
        const results = await sendToComfyUI(params);

        // 3. 插入结果
        if (results && results.length > 0) {
            insertResultsToChat(results, `选中文本生图: ${text.substring(0, 30)}...`);
            for (const r of results) {
                if (r.type === 'image' && r.data) {
                    try { addImageToCache(r.data, r.filename); } catch (_) { }
                }
            }
            try { addLog(`选中文本生图完成，生成 ${results.length} 张图片`); } catch (_) { }
            if (typeof toastr !== 'undefined') {
                toastr.success(`生成了 ${results.length} 张图片！`, 'ComfyUI Gen');
            }
        } else {
            if (typeof toastr !== 'undefined') toastr.warning('ComfyUI 未返回图片', 'ComfyUI Gen');
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} ❌ 生图失败:`, err);
        if (typeof toastr !== 'undefined') toastr.error('生图失败: ' + err.message, 'ComfyUI Gen');
        try { addLog(`选中文本生图失败: ${err.message}`); } catch (_) { }
    } finally {
        isGenerating = false;
        if (floatingBtn) {
            floatingBtn.innerHTML = '<i class="fa-solid fa-palette"></i><span>生图</span>';
            floatingBtn.classList.remove('cg-sel-gen-loading');
        }
        hideFloatingButton();
    }
}
