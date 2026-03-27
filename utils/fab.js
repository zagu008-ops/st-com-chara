/**
 * ComfyUI Gen - 悬浮球（FAB）模块
 * 可拖拽浮动按钮，展开菜单提供快捷操作
 */

import { extension_settings, saveSettingsDebounced } from '../../../../script.js';
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
    if (!settings.fab_enabled) return;

    createFabElement();
    createMenuElement();
    console.log('[ComfyUI Gen] 悬浮球已初始化');
}

/**
 * 创建悬浮球 DOM
 */
function createFabElement() {
    if (fabElement) fabElement.remove();

    fabElement = document.createElement('div');
    fabElement.id = 'comfyui-gen-fab';
    fabElement.innerHTML = '<i class="fa-solid fa-paintbrush"></i>';

    const settings = extension_settings[extensionName];
    const pos = settings.fab_position || { right: 20, bottom: 80 };
    fabElement.style.right = pos.right + 'px';
    fabElement.style.bottom = pos.bottom + 'px';

    // 拖拽逻辑
    let startX, startY, startRight, startBottom;

    fabElement.addEventListener('mousedown', onDragStart);
    fabElement.addEventListener('touchstart', onDragStart, { passive: false });

    function onDragStart(e) {
        isDragging = false;
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;
        startRight = parseInt(fabElement.style.right);
        startBottom = parseInt(fabElement.style.bottom);

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd);
    }

    function onDragMove(e) {
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const dx = startX - touch.clientX;
        const dy = startY - touch.clientY;

        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            isDragging = true;
        }

        const newRight = Math.max(0, Math.min(window.innerWidth - 60, startRight + dx));
        const newBottom = Math.max(0, Math.min(window.innerHeight - 60, startBottom + dy));

        fabElement.style.right = newRight + 'px';
        fabElement.style.bottom = newBottom + 'px';

        // 同步菜单位置
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
            // 保存位置
            const settings = extension_settings[extensionName];
            settings.fab_position = {
                right: parseInt(fabElement.style.right),
                bottom: parseInt(fabElement.style.bottom),
            };
            saveSettingsDebounced();
        }
    }

    document.body.appendChild(fabElement);
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

    // 点击外部关闭菜单
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

    // 动画
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
 * 定位菜单位置（在悬浮球上方）
 */
function positionMenu() {
    if (!fabElement || !menuElement) return;
    const fabRect = fabElement.getBoundingClientRect();
    menuElement.style.right = (window.innerWidth - fabRect.right) + 'px';
    menuElement.style.bottom = (window.innerHeight - fabRect.top + 10) + 'px';
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

    // 绑定事件
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
    // 生成按钮
    const generateBtn = document.getElementById('comfyui-gen-btn-generate');
    if (generateBtn) {
        generateBtn.addEventListener('click', handleGenerate);
    }

    // 设置按钮
    const settingsBtn = document.getElementById('comfyui-gen-btn-settings');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            closeMenu();
            openSettingsPanel();
        });
    }

    // 预设选择
    menuElement.querySelectorAll('.comfyui-gen-preset-item').forEach(item => {
        item.addEventListener('click', () => {
            const type = item.dataset.type;
            const id = item.dataset.id;
            setActivePreset(type, id);
            renderMenu(); // 重新渲染以更新激活状态
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
