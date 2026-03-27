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

    // 加载设置面板 HTML（追加到 body，模态框 position:fixed 不依赖父容器）
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('body').append(settingsHtml);
        console.log('[ComfyUI Gen] 设置面板 HTML 加载成功');
    } catch (e) {
        console.error('[ComfyUI Gen] 设置面板 HTML 加载失败:', e);
    }

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

    // 点击背景关闭
    $('#comfyui-gen-settings-modal').on('click', function (e) {
        if (e.target === this) $(this).hide();
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
    const textInputs = [
        { id: '#comfyui-gen-url', key: 'comfyui_url' },
        { id: '#comfyui-gen-client-mode', key: 'client_mode' },
        { id: '#comfyui-gen-fixed-positive', key: 'fixed_positive_prompt' },
        { id: '#comfyui-gen-fixed-positive-end', key: 'fixed_positive_prompt_end' },
        { id: '#comfyui-gen-fixed-negative', key: 'fixed_negative_prompt' },
        { id: '#comfyui-gen-workflow', key: 'workflow_json' },
        { id: '#comfyui-gen-interrogate-workflow', key: 'interrogate_workflow_json' },
        { id: '#comfyui-gen-positive-quality', key: 'positive_quality_preset' },
        { id: '#comfyui-gen-negative-quality', key: 'negative_quality_preset' },
    ];

    textInputs.forEach(({ id, key }) => {
        $(id).on('input change', function () {
            extension_settings[extensionName][key] = $(this).val();
            saveSettingsDebounced();
        });
    });

    // 下拉框 → default_params
    const selectParamInputs = [
        { id: '#comfyui-gen-model', key: 'model_name' },
        { id: '#comfyui-gen-sampler', key: 'sampler_name' },
        { id: '#comfyui-gen-scheduler', key: 'scheduler' },
        { id: '#comfyui-gen-vae', key: 'vae' },
        { id: '#comfyui-gen-clip', key: 'clip' },
    ];

    selectParamInputs.forEach(({ id, key }) => {
        $(id).on('change', function () {
            extension_settings[extensionName].default_params[key] = $(this).val();
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

    // 预设尺寸 → 自动填写宽高
    $('#comfyui-gen-size-preset').on('change', function () {
        const val = $(this).val();
        if (val) {
            const [w, h] = val.split('x').map(Number);
            $('#comfyui-gen-width').val(w).trigger('change');
            $('#comfyui-gen-height').val(h).trigger('change');
        }
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

    // 测试连接 + 刷新下拉数据
    $('#comfyui-gen-test-connection').on('click', testConnectionAndRefresh);

    // 更新插件
    $('#comfyui-gen-update-btn').on('click', updateExtension);

    // === 服装 & 角色预设 ===
    bindPresetEvents('outfit');
    bindPresetEvents('character');
}

/**
 * 绑定预设操作事件（服装和角色共用逻辑）
 */
function bindPresetEvents(type) {
    const prefix = `comfyui-gen-${type}`;

    // 新增按钮
    $(`#comfyui-gen-add-${type}`).on('click', () => {
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

    // 图片选择（file input change，由 label[for] 原生触发）
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
            toastr.warning('请先上传图片');
            return;
        }

        const btn = $(this);
        const originalText = btn.html();
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 反推中...').prop('disabled', true);

        try {
            const tags = await interrogateImage(file);
            $(`#${prefix}-positive`).val(tags);
            toastr.success('反推完成');
            console.log('[ComfyUI Gen] 反推结果:', tags);
        } catch (e) {
            console.error('[ComfyUI Gen] 反推失败:', e);
            toastr.error('反推失败: ' + e.message);
        } finally {
            btn.html(originalText).prop('disabled', false);
        }
    });
}

/**
 * 打开预设编辑器
 */
function openPresetEditor(type, presetId) {
    const prefix = `comfyui-gen-${type}`;
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
        $(`#${prefix}-editor-title`).text('新增' + (type === 'outfit' ? '服装' : '角色'));
        $(`#${prefix}-delete`).hide();
    }

    editor.show();
}

/**
 * 从编辑器保存预设
 */
function savePresetFromEditor(type) {
    const prefix = `comfyui-gen-${type}`;
    const name = $(`#${prefix}-name`).val().trim();
    const positivePrompt = $(`#${prefix}-positive`).val().trim();
    const negativePrompt = $(`#${prefix}-negative`).val().trim();
    const thumbnail = $(`#${prefix}-preview`).attr('src') || '';
    const editId = $(`#${prefix}-edit-id`).val();

    if (!name) {
        toastr.warning('请填写名称');
        return;
    }

    if (editId) {
        updatePreset(type, editId, { name, positivePrompt, negativePrompt, thumbnail });
        toastr.success('预设已更新');
    } else {
        createPreset(type, { name, positivePrompt, negativePrompt, thumbnail });
        toastr.success('预设已创建');
    }

    $(`#${prefix}-editor`).hide();
    renderPresetGrid(type);
}

/**
 * 渲染预设网格
 */
function renderPresetGrid(type) {
    const gridId = `comfyui-gen-${type}-grid`;
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

    grid.find('.comfyui-gen-preset-card').on('click', function (e) {
        if ($(e.target).closest('.comfyui-gen-preset-card-edit').length) return;
        const id = $(this).data('id');
        setActivePreset(type, id);
        renderPresetGrid(type);
    });

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
    $('#comfyui-gen-seed').val(s.default_params.seed);
    $('#comfyui-gen-fixed-positive').val(s.fixed_positive_prompt);
    $('#comfyui-gen-fixed-positive-end').val(s.fixed_positive_prompt_end);
    $('#comfyui-gen-fixed-negative').val(s.fixed_negative_prompt);
    $('#comfyui-gen-workflow').val(s.workflow_json);
    $('#comfyui-gen-interrogate-workflow').val(s.interrogate_workflow_json);
    $('#comfyui-gen-positive-quality').val(s.positive_quality_preset);
    $('#comfyui-gen-negative-quality').val(s.negative_quality_preset);
    $('#comfyui-gen-jpeg-compress').prop('checked', s.jpeg_compression);
    $('#comfyui-gen-fab-enabled').prop('checked', s.fab_enabled);

    // 尝试自动匹配预设尺寸
    const sizeKey = `${s.default_params.width}x${s.default_params.height}`;
    if ($(`#comfyui-gen-size-preset option[value="${sizeKey}"]`).length) {
        $('#comfyui-gen-size-preset').val(sizeKey);
    }
}

/**
 * 测试连接并刷新 ComfyUI 数据列表
 */
async function testConnectionAndRefresh() {
    const url = extension_settings[extensionName].comfyui_url.replace(/\/$/, '');
    const status = $('#comfyui-gen-connection-status');
    const btn = $('#comfyui-gen-test-connection');

    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 连接中...').prop('disabled', true);
    status.text('').css('color', '');

    try {
        // 测试连接
        const sysResp = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
        if (!sysResp.ok) {
            status.text('✗ 连接失败 (' + sysResp.status + ')').css('color', 'var(--cg-danger)');
            return;
        }

        status.text('✓ 已连接，正在加载数据...').css('color', 'var(--cg-success)');

        // 获取 object_info（包含所有节点信息，从中提取模型、采样器等）
        const infoResp = await fetch(`${url}/object_info`, { signal: AbortSignal.timeout(10000) });
        if (infoResp.ok) {
            const info = await infoResp.json();
            populateDropdownsFromObjectInfo(info);
        }

        status.text('✓ 连接成功，数据已刷新').css('color', 'var(--cg-success)');
        toastr.success('ComfyUI 数据已刷新');
    } catch (e) {
        status.text('✗ 无法连接: ' + e.message).css('color', 'var(--cg-danger)');
    } finally {
        btn.html('<i class="fa-solid fa-plug"></i> 测试并刷新').prop('disabled', false);
    }
}

/**
 * 从 ComfyUI object_info 中提取选项列表并填充下拉框
 */
function populateDropdownsFromObjectInfo(info) {
    const s = extension_settings[extensionName];

    // 模型（checkpoint）
    const ckptNode = info['CheckpointLoaderSimple'] || info['CheckpointLoader'];
    if (ckptNode?.input?.required?.ckpt_name?.[0]) {
        populateSelect('#comfyui-gen-model', ckptNode.input.required.ckpt_name[0], s.default_params.model_name);
    }

    // 采样器
    const samplerNode = info['KSampler'] || info['KSamplerAdvanced'];
    if (samplerNode?.input?.required?.sampler_name?.[0]) {
        populateSelect('#comfyui-gen-sampler', samplerNode.input.required.sampler_name[0], s.default_params.sampler_name);
    }

    // 调度器
    if (samplerNode?.input?.required?.scheduler?.[0]) {
        populateSelect('#comfyui-gen-scheduler', samplerNode.input.required.scheduler[0], s.default_params.scheduler);
    }

    // VAE
    const vaeNode = info['VAELoader'];
    if (vaeNode?.input?.required?.vae_name?.[0]) {
        const vaeList = ['', ...vaeNode.input.required.vae_name[0]];
        populateSelect('#comfyui-gen-vae', vaeList, s.default_params.vae, { '': '默认（随模型）' });
    }

    // CLIP
    const clipNode = info['CLIPLoader'];
    if (clipNode?.input?.required?.clip_name?.[0]) {
        const clipList = ['', ...clipNode.input.required.clip_name[0]];
        populateSelect('#comfyui-gen-clip', clipList, s.default_params.clip, { '': '默认' });
    }

    console.log('[ComfyUI Gen] 下拉数据已刷新');
}

/**
 * 填充 select 下拉框
 */
function populateSelect(selector, options, currentValue, labelMap = {}) {
    const select = $(selector);
    select.empty();

    for (const opt of options) {
        const label = labelMap[opt] || opt || '默认';
        const selected = opt === currentValue ? 'selected' : '';
        select.append(`<option value="${opt}" ${selected}>${label}</option>`);
    }

    // 如果当前值不在选项中且不为空，追加一个
    if (currentValue && !options.includes(currentValue)) {
        select.prepend(`<option value="${currentValue}" selected>${currentValue}</option>`);
    }
}

/**
 * 从 GitHub 更新插件
 */
async function updateExtension() {
    const btn = $('#comfyui-gen-update-btn');
    const originalHtml = btn.html();
    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 更新中...').prop('disabled', true);

    try {
        const response = await fetch('/api/extensions/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: 'https://github.com/zagu008-ops/st-com-chara',
                global: false,
            }),
        });

        if (response.ok) {
            toastr.success('更新成功，即将刷新页面...');
            setTimeout(() => location.reload(), 1500);
        } else {
            const errText = await response.text();
            toastr.error('更新失败: ' + errText);
        }
    } catch (e) {
        console.error('[ComfyUI Gen] 更新失败:', e);
        toastr.error('更新失败: ' + e.message);
    } finally {
        btn.html(originalHtml).prop('disabled', false);
    }
}

// ============ 启动 ============

init();
