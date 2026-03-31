/**
 * ComfyUI Gen - 悬浮球（FAB）模块
 * 可拖拽浮动按钮，展开菜单提供快捷操作
 *
 * 注意：使用 left/top 定位而非 right/bottom
 * 原因：SillyTavern 的 body 存在 CSS transform，导致 position:fixed + bottom 定位异常
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';
import { getPresets, getActivePreset, setActivePreset } from './presetManager.js';
import { buildPayload, sendToComfyUI } from './comfyui.js';
import { insertResultsToChat } from './imageInserter.js';

let fabElement = null;
let menuElement = null;
let isDragging = false;
let isMenuOpen = false;

/**
 * 初始化悬浮球
 */
export function initFab() {
    const settings = extension_settings[extensionName];
    console.log('[ComfyUI Gen][FAB] fab_enabled =', settings.fab_enabled);
    if (!settings.fab_enabled) {
        console.log('[ComfyUI Gen][FAB] ⏭️ 悬浮球未启用，跳过');
        return;
    }

    createFabElement();
    createMenuElement();
    console.log('[ComfyUI Gen] 悬浮球已初始化');

    // 2 秒后诊断 FAB 是否可见
    setTimeout(() => {
        if (!fabElement) return;
        const rect = fabElement.getBoundingClientRect();
        const styles = window.getComputedStyle(fabElement);
        console.log('[ComfyUI Gen][FAB] 🔍 诊断信息:',
            '\n  CSS:', JSON.stringify({ left: fabElement.style.left, top: fabElement.style.top }),
            '\n  视口矩形:', JSON.stringify({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }),
            '\n  display:', styles.display,
            '\n  visibility:', styles.visibility,
            '\n  opacity:', styles.opacity,
            '\n  z-index:', styles.zIndex,
            '\n  窗口:', window.innerWidth, 'x', window.innerHeight,
            '\n  在视口内:', rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        );
    }, 2000);
}

/**
 * 创建悬浮球 DOM（使用 left/top 定位）
 */
function createFabElement() {
    if (fabElement) fabElement.remove();

    fabElement = document.createElement('div');
    fabElement.id = 'comfyui-gen-fab';
    fabElement.innerHTML = '<i class="fa-solid fa-paintbrush"></i>';

    const settings = extension_settings[extensionName];
    const isMobile = window.innerWidth <= 600;
    const fabSize = isMobile ? 44 : 52;

    // 读取位置（兼容旧版 right/bottom → 自动转换为 left/top）
    const pos = settings.fab_position || {};
    let left, top;

    if (pos.left !== undefined && pos.top !== undefined) {
        left = pos.left;
        top = pos.top;
    } else {
        // 旧格式 right/bottom → 转为 left/top
        const r = pos.right ?? 20;
        const b = pos.bottom ?? 80;
        left = window.innerWidth - r - fabSize;
        top = window.innerHeight - b - fabSize;
    }

    // 约束到视口
    left = Math.max(0, Math.min(left, window.innerWidth - fabSize));
    top = Math.max(0, Math.min(top, window.innerHeight - fabSize));

    fabElement.style.left = left + 'px';
    fabElement.style.top = top + 'px';
    fabElement.style.right = 'auto';
    fabElement.style.bottom = 'auto';

    console.log('[ComfyUI Gen][FAB] 位置计算:',
        '\n  保存位置:', JSON.stringify(pos),
        '\n  窗口:', window.innerWidth, 'x', window.innerHeight,
        '\n  最终 left:', left, 'top:', top
    );

    // ===== 拖拽逻辑（基于 left/top）=====
    let startX, startY, startLeft, startTop;

    fabElement.addEventListener('mousedown', onDragStart);
    fabElement.addEventListener('touchstart', onDragStart, { passive: false });

    function onDragStart(e) {
        isDragging = false;
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;
        startLeft = parseInt(fabElement.style.left);
        startTop = parseInt(fabElement.style.top);

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd);
    }

    function onDragMove(e) {
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            isDragging = true;
        }

        const newLeft = Math.max(0, Math.min(window.innerWidth - fabSize, startLeft + dx));
        const newTop = Math.max(0, Math.min(window.innerHeight - fabSize, startTop + dy));

        fabElement.style.left = newLeft + 'px';
        fabElement.style.top = newTop + 'px';

        if (menuElement && isMenuOpen) {
            positionMenu();
        }
    }

    function onDragEnd() {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDragMove);
        document.removeEventListener('touchend', onDragEnd);

        if (!isDragging) {
            toggleMenu();
        } else {
            // 保存位置（新格式 left/top）
            const settings = extension_settings[extensionName];
            settings.fab_position = {
                left: parseInt(fabElement.style.left),
                top: parseInt(fabElement.style.top),
            };
            saveSettingsDebounced();
        }
    }

    document.body.appendChild(fabElement);

    // ===== FAB 位置守护器 =====
    function clampFabPosition(source) {
        if (!fabElement) return;
        const size = window.innerWidth <= 600 ? 44 : 52;
        const curLeft = parseInt(fabElement.style.left) || 0;
        const curTop = parseInt(fabElement.style.top) || 0;

        const newLeft = Math.max(0, Math.min(curLeft, window.innerWidth - size));
        const newTop = Math.max(0, Math.min(curTop, window.innerHeight - size));

        if (newLeft !== curLeft || newTop !== curTop) {
            console.log(`[ComfyUI Gen][FAB] ⚡ 位置修正 (${source}):`,
                `left ${curLeft}→${newLeft}, top ${curTop}→${newTop},`,
                `窗口 ${window.innerWidth}x${window.innerHeight}`);
            fabElement.style.left = newLeft + 'px';
            fabElement.style.top = newTop + 'px';
        }

        if (menuElement && isMenuOpen) positionMenu();
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => clampFabPosition('resize'), 100);
    });
    try {
        const ro = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => clampFabPosition('ResizeObserver'), 100);
        });
        ro.observe(document.documentElement);
    } catch (_) { }
    setInterval(() => clampFabPosition('interval'), 3000);
}

/**
 * 创建展开菜单 DOM
 */
function createMenuElement() {
    if (menuElement) menuElement.remove();

    menuElement = document.createElement('div');
    menuElement.id = 'comfyui-gen-fab-menu';
    menuElement.style.display = 'none';

    document.body.appendChild(menuElement);

    document.addEventListener('click', (e) => {
        if (isMenuOpen && !menuElement.contains(e.target) && !fabElement.contains(e.target)) {
            closeMenu();
        }
    });
}

/**
 * 切换菜单
 */
function toggleMenu() {
    if (isMenuOpen) {
        closeMenu();
    } else {
        openMenu();
    }
}

/**
 * 打开菜单
 */
function openMenu() {
    isMenuOpen = true;
    renderMenu();
    positionMenu();
    menuElement.style.display = 'block';
    fabElement.classList.add('active');

    requestAnimationFrame(() => {
        menuElement.classList.add('open');
    });
}

/**
 * 关闭菜单
 */
function closeMenu() {
    isMenuOpen = false;
    menuElement.classList.remove('open');
    fabElement.classList.remove('active');
    setTimeout(() => {
        menuElement.style.display = 'none';
    }, 200);
}

/**
 * 定位菜单位置（在悬浮球上方，使用 left/top）
 */
function positionMenu() {
    if (!fabElement || !menuElement) return;
    const fabRect = fabElement.getBoundingClientRect();
    // 菜单放在 FAB 上方，右对齐
    const menuWidth = 260;
    let menuLeft = fabRect.left + fabRect.width - menuWidth;
    let menuBottom = window.innerHeight - fabRect.top + 10;

    // 防止超出左边
    menuLeft = Math.max(8, menuLeft);

    menuElement.style.left = menuLeft + 'px';
    menuElement.style.bottom = menuBottom + 'px';
    menuElement.style.right = 'auto';
}

/**
 * 渲染菜单内容
 */
function renderMenu() {
    const activeOutfit = getActivePreset('outfit');
    const activeChar = getActivePreset('character');

    menuElement.innerHTML = `
        <div class="comfyui-gen-menu-section">
            <div class="comfyui-gen-menu-item generate" id="comfyui-gen-btn-generate">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>生成图片</span>
            </div>
        </div>

        <div class="comfyui-gen-menu-divider"></div>

        <div class="comfyui-gen-menu-section">
            <div class="comfyui-gen-menu-label">
                <i class="fa-solid fa-shirt"></i> 服装
                <span class="comfyui-gen-active-name">${activeOutfit ? activeOutfit.name : '未选择'}</span>
            </div>
            <div class="comfyui-gen-preset-list" id="comfyui-gen-outfit-list">
                ${renderPresetList('outfit')}
            </div>
        </div>

        <div class="comfyui-gen-menu-divider"></div>

        <div class="comfyui-gen-menu-section">
            <div class="comfyui-gen-menu-label">
                <i class="fa-solid fa-user"></i> 角色
                <span class="comfyui-gen-active-name">${activeChar ? activeChar.name : '未选择'}</span>
            </div>
            <div class="comfyui-gen-preset-list" id="comfyui-gen-char-list">
                ${renderPresetList('character')}
            </div>
        </div>

        <div class="comfyui-gen-menu-divider"></div>

        <div class="comfyui-gen-menu-section">
            <div class="comfyui-gen-menu-item settings" id="comfyui-gen-btn-settings">
                <i class="fa-solid fa-gear"></i>
                <span>设置</span>
            </div>
        </div>
    `;

    bindMenuEvents();
}

/**
 * 渲染预设列表
 */
function renderPresetList(type) {
    const presets = getPresets(type);
    const active = getActivePreset(type);

    if (presets.length === 0) {
        return '<div class="comfyui-gen-empty">暂无预设，请在设置中添加</div>';
    }

    return presets.map(p => `
        <div class="comfyui-gen-preset-item ${active?.id === p.id ? 'active' : ''}"
             data-type="${type}" data-id="${p.id}">
            ${p.thumbnail
            ? `<img src="${p.thumbnail}" class="comfyui-gen-preset-thumb" />`
            : `<div class="comfyui-gen-preset-thumb-placeholder"><i class="fa-solid fa-image"></i></div>`
        }
            <span class="comfyui-gen-preset-name">${p.name}</span>
        </div>
    `).join('');
}

/**
 * 绑定菜单事件
 */
function bindMenuEvents() {
    const generateBtn = document.getElementById('comfyui-gen-btn-generate');
    if (generateBtn) {
        generateBtn.addEventListener('click', handleGenerate);
    }

    const settingsBtn = document.getElementById('comfyui-gen-btn-settings');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            closeMenu();
            openSettingsPanel();
        });
    }

    menuElement.querySelectorAll('.comfyui-gen-preset-item').forEach(item => {
        item.addEventListener('click', () => {
            const type = item.dataset.type;
            const id = item.dataset.id;
            setActivePreset(type, id);
            renderMenu();
        });
    });
}

/**
 * 处理生成请求
 */
async function handleGenerate() {
    const generateBtn = document.getElementById('comfyui-gen-btn-generate');
    if (!generateBtn) return;

    try {
        generateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>生成中...</span>';
        generateBtn.style.pointerEvents = 'none';

        const params = buildPayload();
        console.log('[ComfyUI Gen] 开始生成, 提示词:', params.prompt?.substring(0, 80));

        const results = await sendToComfyUI(params);
        insertResultsToChat(results, params.prompt);

        console.log('[ComfyUI Gen] 生成完成!');
        closeMenu();
    } catch (e) {
        console.error('[ComfyUI Gen] 生成失败:', e);
        alert('生成失败: ' + e.message);
    } finally {
        if (generateBtn) {
            generateBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>生成图片</span>';
            generateBtn.style.pointerEvents = '';
        }
    }
}

/**
 * 打开设置面板
 */
function openSettingsPanel() {
    const modal = document.getElementById('comfyui-gen-settings-modal');
    if (modal) {
        modal.style.display = 'flex';
    }
}
