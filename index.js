/**
 * ComfyUI Gen - SillyTavern Extension
 * 主入口文件：初始化、设置面板绑定、事件注册
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { extensionName, extensionFolderPath, defaultSettings } from './utils/config.js';
import { buildPayload, sendToComfyUI } from './utils/comfyui.js';
import {
    createPreset, getPresets, getPresetById, updatePreset,
    deletePreset, setActivePreset, getActivePreset,
} from './utils/presetManager.js';
import { interrogateImage } from './utils/interrogator.js';
import { insertResultsToChat } from './utils/imageInserter.js';
import { initFab } from './utils/fab.js';

// ============ 初始化 ============

async function init() {
    console.log('[ComfyUI Gen] 初始化插件...');

    // 合并默认设置
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName] = {
        ...JSON.parse(JSON.stringify(defaultSettings)),
        ...extension_settings[extensionName],
    };

    // 加载设置面板 HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    // 绑定设置面板事件
    bindSettingsEvents();

    // 加载设置到 UI
    loadSettingsToUI();

    // 渲染预设列表
    renderPresetGrid('outfit');
    renderPresetGrid('character');

    // 初始化悬浮球
    initFab();

    console.log('[ComfyUI Gen] 插件初始化完成');
}

// ============ 设置面板事件绑定 ============

function bindSettingsEvents() {
    // 关闭模态框
    $('#comfyui-gen-modal-close').on('click', () => {
        $('#comfyui-gen-settings-modal').hide();
    });

    // Tab 切换
    $('.comfyui-gen-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('.comfyui-gen-tab').removeClass('active');
        $(this).addClass('active');
        $('.comfyui-gen-panel').removeClass('active');
        $(`.comfyui-gen-panel[data-panel="${tab}"]`).addClass('active');
    });

    // === ComfyUI 配置保存 ===
    const configInputs = [
        { id: '#comfyui-gen-url', key: 'comfyui_url' },
        { id: '#comfyui-gen-client-mode', key: 'client_mode' },
        { id: '#comfyui-gen-fixed-positive', key: 'fixed_positive_prompt' },
        { id: '#comfyui-gen-fixed-negative', key: 'fixed_negative_prompt' },
        { id: '#comfyui-gen-workflow', key: 'workflow_json' },
        { id: '#comfyui-gen-interrogate-workflow', key: 'interrogate_workflow_json' },
        { id: '#comfyui-gen-model', key: 'default_params.model_name' },
    ];

    configInputs.forEach(({ id, key }) => {
        $(id).on('input change', function () {
            const settings = extension_settings[extensionName];
            const val = $(this).val();
            if (key.includes('.')) {
                const [parent, child] = key.split('.');
                settings[parent][child] = val;
            } else {
                settings[key] = val;
            }
            saveSettingsDebounced();
        });
    });

    // 数字参数
    const numberInputs = [
        { id: '#comfyui-gen-steps', key: 'steps' },
        { id: '#comfyui-gen-cfg', key: 'cfg_scale' },
        { id: '#comfyui-gen-width', key: 'width' },
        { id: '#comfyui-gen-height', key: 'height' },
        { id: '#comfyui-gen-seed', key: 'seed' },
    ];

    numberInputs.forEach(({ id, key }) => {
        $(id).on('input change', function () {
            extension_settings[extensionName].default_params[key] = parseFloat($(this).val()) || 0;
            saveSettingsDebounced();
        });
    });

    // 选择框参数
    $('#comfyui-gen-sampler').on('change', function () {
        extension_settings[extensionName].default_params.sampler_name = $(this).val();
        saveSettingsDebounced();
    });

    $('#comfyui-gen-scheduler').on('change', function () {
        extension_settings[extensionName].default_params.scheduler = $(this).val();
        saveSettingsDebounced();
    });

    // 复选框
    $('#comfyui-gen-jpeg-compress').on('change', function () {
        extension_settings[extensionName].jpeg_compression = this.checked;
        saveSettingsDebounced();
    });

    $('#comfyui-gen-fab-enabled').on('change', function () {
        extension_settings[extensionName].fab_enabled = this.checked;
        saveSettingsDebounced();
        const fab = document.getElementById('comfyui-gen-fab');
        if (fab) fab.style.display = this.checked ? 'flex' : 'none';
    });

    // 测试连接
    $('#comfyui-gen-test-connection').on('click', testConnection);

    // === 服装预设 ===
    bindPresetEvents('outfit');
    bindPresetEvents('character');
}

/**
 * 绑定预设操作事件（服装和角色共用逻辑）
 */
function bindPresetEvents(type) {
    const prefix = `comfyui-gen-${type === 'outfit' ? 'outfit' : 'character'}`;

    // 新增按钮
    $(`#comfyui-gen-add-${type === 'outfit' ? 'outfit' : 'character'}`).on('click', () => {
        openPresetEditor(type, null);
    });

    // 关闭编辑器
    $(`#${prefix}-editor-close`).on('click', () => {
        $(`#${prefix}-editor`).hide();
    });

    // 保存
    $(`#${prefix}-save`).on('click', () => {
        savePresetFromEditor(type);
    });

    // 删除
    $(`#${prefix}-delete`).on('click', () => {
        const id = $(`#${prefix}-edit-id`).val();
        if (id && confirm('确定删除此预设？')) {
            deletePreset(type, id);
            $(`#${prefix}-editor`).hide();
            renderPresetGrid(type);
        }
    });

    // 图片上传区域点击
    $(`#${prefix}-upload`).on('click', () => {
        $(`#${prefix}-image`).trigger('click');
    });

    // 图片选择
    $(`#${prefix}-image`).on('change', function () {
        const file = this.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            $(`#${prefix}-preview`).attr('src', e.target.result).show();
            $(`#${prefix}-upload-placeholder`).hide();
        };
        reader.readAsDataURL(file);
    });

    // 反推提示词
    $(`#${prefix}-interrogate`).on('click', async function () {
        const fileInput = $(`#${prefix}-image`)[0];
        const file = fileInput?.files?.[0];

        if (!file) {
            alert('请先上传图片');
            return;
        }

        const btn = $(this);
        const originalText = btn.html();
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 反推中...').prop('disabled', true);

        try {
            const tags = await interrogateImage(file);
            $(`#${prefix}-positive`).val(tags);
            console.log('[ComfyUI Gen] 反推结果:', tags);
        } catch (e) {
            console.error('[ComfyUI Gen] 反推失败:', e);
            alert('反推失败: ' + e.message);
        } finally {
            btn.html(originalText).prop('disabled', false);
        }
    });
}

/**
 * 打开预设编辑器
 */
function openPresetEditor(type, presetId) {
    const prefix = `comfyui-gen-${type === 'outfit' ? 'outfit' : 'character'}`;
    const editor = $(`#${prefix}-editor`);

    // 重置表单
    $(`#${prefix}-name`).val('');
    $(`#${prefix}-positive`).val('');
    $(`#${prefix}-negative`).val('');
    $(`#${prefix}-preview`).hide();
    $(`#${prefix}-upload-placeholder`).show();
    $(`#${prefix}-image`).val('');
    $(`#${prefix}-edit-id`).val('');

    if (presetId) {
        // 编辑模式
        const preset = getPresetById(type, presetId);
        if (!preset) return;

        $(`#${prefix}-editor-title`).text('编辑' + (type === 'outfit' ? '服装' : '角色'));
        $(`#${prefix}-name`).val(preset.name);
        $(`#${prefix}-positive`).val(preset.positivePrompt);
        $(`#${prefix}-negative`).val(preset.negativePrompt);
        $(`#${prefix}-edit-id`).val(presetId);
        $(`#${prefix}-delete`).show();

        if (preset.thumbnail) {
            $(`#${prefix}-preview`).attr('src', preset.thumbnail).show();
            $(`#${prefix}-upload-placeholder`).hide();
        }
    } else {
        // 新增模式
        $(`#${prefix}-editor-title`).text('新增' + (type === 'outfit' ? '服装' : '角色'));
        $(`#${prefix}-delete`).hide();
    }

    editor.show();
}

/**
 * 从编辑器保存预设
 */
function savePresetFromEditor(type) {
    const prefix = `comfyui-gen-${type === 'outfit' ? 'outfit' : 'character'}`;
    const name = $(`#${prefix}-name`).val().trim();
    const positivePrompt = $(`#${prefix}-positive`).val().trim();
    const negativePrompt = $(`#${prefix}-negative`).val().trim();
    const thumbnail = $(`#${prefix}-preview`).attr('src') || '';
    const editId = $(`#${prefix}-edit-id`).val();

    if (!name) {
        alert('请填写名称');
        return;
    }

    if (editId) {
        // 更新
        updatePreset(type, editId, { name, positivePrompt, negativePrompt, thumbnail });
    } else {
        // 新建
        createPreset(type, { name, positivePrompt, negativePrompt, thumbnail });
    }

    $(`#${prefix}-editor`).hide();
    renderPresetGrid(type);
}

/**
 * 渲染预设网格
 */
function renderPresetGrid(type) {
    const gridId = type === 'outfit' ? 'comfyui-gen-outfit-grid' : 'comfyui-gen-character-grid';
    const presets = getPresets(type);
    const active = getActivePreset(type);
    const grid = $(`#${gridId}`);

    if (presets.length === 0) {
        grid.html('<div class="comfyui-gen-empty" style="grid-column: 1/-1;">暂无预设，点击上方按钮添加</div>');
        return;
    }

    grid.html(presets.map(p => `
        <div class="comfyui-gen-preset-card ${active?.id === p.id ? 'active' : ''}" data-id="${p.id}" data-type="${type}">
            <button class="comfyui-gen-preset-card-edit" data-id="${p.id}" data-type="${type}" title="编辑">
                <i class="fa-solid fa-pen"></i>
            </button>
            ${p.thumbnail
            ? `<img src="${p.thumbnail}" class="comfyui-gen-preset-card-thumb" />`
            : `<div class="comfyui-gen-preset-card-thumb-placeholder"><i class="fa-solid fa-${type === 'outfit' ? 'shirt' : 'user'}"></i></div>`
        }
            <div class="comfyui-gen-preset-card-name">${p.name}</div>
        </div>
    `).join(''));

    // 点击选择预设
    grid.find('.comfyui-gen-preset-card').on('click', function (e) {
        if ($(e.target).closest('.comfyui-gen-preset-card-edit').length) return;
        const id = $(this).data('id');
        setActivePreset(type, id);
        renderPresetGrid(type);
    });

    // 编辑按钮
    grid.find('.comfyui-gen-preset-card-edit').on('click', function () {
        const id = $(this).data('id');
        openPresetEditor(type, id);
    });
}

/**
 * 加载设置到 UI
 */
function loadSettingsToUI() {
    const s = extension_settings[extensionName];

    $('#comfyui-gen-url').val(s.comfyui_url);
    $('#comfyui-gen-client-mode').val(s.client_mode);
    $('#comfyui-gen-steps').val(s.default_params.steps);
    $('#comfyui-gen-cfg').val(s.default_params.cfg_scale);
    $('#comfyui-gen-width').val(s.default_params.width);
    $('#comfyui-gen-height').val(s.default_params.height);
    $('#comfyui-gen-sampler').val(s.default_params.sampler_name);
    $('#comfyui-gen-scheduler').val(s.default_params.scheduler);
    $('#comfyui-gen-seed').val(s.default_params.seed);
    $('#comfyui-gen-model').val(s.default_params.model_name);
    $('#comfyui-gen-fixed-positive').val(s.fixed_positive_prompt);
    $('#comfyui-gen-fixed-negative').val(s.fixed_negative_prompt);
    $('#comfyui-gen-workflow').val(s.workflow_json);
    $('#comfyui-gen-interrogate-workflow').val(s.interrogate_workflow_json);
    $('#comfyui-gen-jpeg-compress').prop('checked', s.jpeg_compression);
    $('#comfyui-gen-fab-enabled').prop('checked', s.fab_enabled);
}

/**
 * 测试 ComfyUI 连接
 */
async function testConnection() {
    const url = extension_settings[extensionName].comfyui_url.replace(/\/$/, '');
    const status = $('#comfyui-gen-connection-status');
    const btn = $('#comfyui-gen-test-connection');

    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 测试中...').prop('disabled', true);
    status.text('').css('color', '');

    try {
        const response = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
            status.text('✓ 连接成功').css('color', 'var(--cg-success)');
        } else {
            status.text('✗ 连接失败 (' + response.status + ')').css('color', 'var(--cg-danger)');
        }
    } catch (e) {
        status.text('✗ 无法连接: ' + e.message).css('color', 'var(--cg-danger)');
    } finally {
        btn.html('<i class="fa-solid fa-plug"></i> 测试连接').prop('disabled', false);
    }
}

// ============ 启动 ============

init();
