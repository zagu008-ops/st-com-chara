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

    // 提示词预设 UI 绑定
    bindPromptPresetEvents();

    // LORA 管理
    bindLoraEvents();

    // 工作流预设管理
    bindWorkflowPresetEvents();

    // === 服装 & 角色预设 ===
    bindPresetEvents('outfit');
    bindPresetEvents('character');
}

/**
 * 绑定提示词预设相关事件
 */
function bindPromptPresetEvents() {
    $('#comfyui-gen-prompt-preset').on('change', function () {
        loadPromptPreset($(this).val());
    });

    $('#comfyui-gen-new-prompt-preset').on('click', function () {
        const name = prompt('请输入新提示词预设的名称：');
        if (!name) return;

        const s = extension_settings[extensionName];
        if (!s.prompt_presets) s.prompt_presets = [];

        const newPreset = {
            id: Date.now().toString(),
            name: name,
            fixed_positive_prompt: $('#comfyui-gen-fixed-positive').val() || '',
            fixed_positive_prompt_end: $('#comfyui-gen-fixed-positive-end').val() || '',
            fixed_negative_prompt: $('#comfyui-gen-fixed-negative').val() || '',
            positive_quality_preset: $('#comfyui-gen-positive-quality').val() || '',
            negative_quality_preset: $('#comfyui-gen-negative-quality').val() || ''
        };

        s.prompt_presets.push(newPreset);
        s.current_prompt_preset_id = newPreset.id;
        saveSettingsDebounced();
        updatePromptPresetDropdown();
        toastr.success('已新建预设：' + name, 'ComfyUI 生图');
    });

    $('#comfyui-gen-save-prompt-preset').on('click', function () {
        const s = extension_settings[extensionName];
        const id = s.current_prompt_preset_id;
        if (!id) {
            toastr.warning('当前是默认配置，不能保存。请先「新建预设」。', 'ComfyUI 生图');
            return;
        }

        const preset = s.prompt_presets.find(p => p.id === id);
        if (preset) {
            preset.fixed_positive_prompt = $('#comfyui-gen-fixed-positive').val() || '';
            preset.fixed_positive_prompt_end = $('#comfyui-gen-fixed-positive-end').val() || '';
            preset.fixed_negative_prompt = $('#comfyui-gen-fixed-negative').val() || '';
            preset.positive_quality_preset = $('#comfyui-gen-positive-quality').val() || '';
            preset.negative_quality_preset = $('#comfyui-gen-negative-quality').val() || '';
            saveSettingsDebounced();
            toastr.success('已保存当前预设', 'ComfyUI 生图');
        }
    });

    $('#comfyui-gen-delete-prompt-preset').on('click', function () {
        const s = extension_settings[extensionName];
        const id = s.current_prompt_preset_id;
        if (!id) {
            toastr.warning('没有选中预设，无法删除', 'ComfyUI 生图');
            return;
        }

        if (confirm('确定要删除当前预设吗？')) {
            s.prompt_presets = s.prompt_presets.filter(p => p.id !== id);
            s.current_prompt_preset_id = '';
            saveSettingsDebounced();
            updatePromptPresetDropdown();
            loadPromptPreset('');
            toastr.success('预设已删除', 'ComfyUI 生图');
        }
    });

    $('#comfyui-gen-migrate-prompt-presets').on('click', function () {
        console.log('[ComfyUI Gen] 一键迁移按钮被点击');
        console.log('[ComfyUI Gen] extension_settings 所有 key:', Object.keys(extension_settings));

        const oldExt = extension_settings['st-chatu8'];
        console.log('[ComfyUI Gen] st-chatu8 数据:', oldExt ? '存在' : '不存在');

        if (!oldExt) {
            toastr.warning('未在系统中找到原 st-chatu8 插件数据。请确认 st-chatu8 插件已安装并至少打开过一次。\n\n当前已注册的扩展列表:\n' + Object.keys(extension_settings).join(', '), 'ComfyUI 数据迁移');
            return;
        }

        if (!oldExt.yushe) {
            console.log('[ComfyUI Gen] st-chatu8 数据中无 yushe 字段:', Object.keys(oldExt));
            toastr.warning('找到了 st-chatu8 插件数据，但其中不包含预设(yushe)字段。\n\n可用字段: ' + Object.keys(oldExt).slice(0, 15).join(', '), 'ComfyUI 数据迁移');
            return;
        }

        const oldYushe = oldExt.yushe;
        if (typeof oldYushe !== 'object') {
            toastr.error('原预设数据格式异常（类型: ' + typeof oldYushe + '）。', 'ComfyUI 数据迁移');
            return;
        }

        const s = extension_settings[extensionName];
        if (!s.prompt_presets) s.prompt_presets = [];

        let migratedCount = 0;

        const keys = Object.keys(oldYushe);
        console.log('[ComfyUI Gen] 旧预设 key 列表:', keys);

        keys.forEach(key => {
            const oldItem = oldYushe[key];
            if (!oldItem) return;
            if (s.prompt_presets.some(p => p.name === key)) return;

            console.log('[ComfyUI Gen] 迁移预设:', key, '数据 keys:', Object.keys(oldItem));

            // Support both _comfyui suffixed and plain key names from legacy plugin
            s.prompt_presets.push({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                name: key,
                fixed_positive_prompt: oldItem.fixedPrompt_comfyui || oldItem.fixedPrompt || oldItem['fixedPrompt'] || '',
                fixed_positive_prompt_end: oldItem.fixedPrompt_end_comfyui || oldItem.fixedPrompt_end || oldItem['fixedPrompt_end'] || '',
                fixed_negative_prompt: oldItem.negativePrompt_comfyui || oldItem.negativePrompt || oldItem['negativePrompt'] || '',
                positive_quality_preset: (oldItem.AQT_comfyui === false || oldItem.AQT === false) ? '' : (oldItem.AQT_comfyui || oldItem.AQT || s.positive_quality_preset || ''),
                negative_quality_preset: oldItem.UCP_comfyui || oldItem.UCP || ''
            });
            migratedCount++;
        });

        if (migratedCount > 0) {
            saveSettingsDebounced();
            updatePromptPresetDropdown();
            toastr.success(`成功迁移了 ${migratedCount} 个提示词预设！`, 'ComfyUI 数据迁移');
        } else {
            toastr.info('没有找到新的可迁移预设（可能是名称重复已存在）。', 'ComfyUI 数据迁移');
        }
    });
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

// === 提示词预设相关 ===
function updatePromptPresetDropdown() {
    const s = extension_settings[extensionName];
    if (!s.prompt_presets) s.prompt_presets = [];
    const $select = $('#comfyui-gen-prompt-preset');
    $select.empty();
    $select.append('<option value="">默认配置</option>');

    if (s.prompt_presets && s.prompt_presets.length > 0) {
        s.prompt_presets.forEach(p => {
            $select.append($('<option></option>').val(p.id).text(p.name));
        });
    }
    $select.val(s.current_prompt_preset_id || '');
}

function loadPromptPreset(id) {
    const s = extension_settings[extensionName];
    s.current_prompt_preset_id = id;

    if (!id) {
        saveSettingsDebounced();
        return;
    }

    const preset = s.prompt_presets.find(p => p.id === id);
    if (preset) {
        s.fixed_positive_prompt = preset.fixed_positive_prompt || '';
        s.fixed_positive_prompt_end = preset.fixed_positive_prompt_end || '';
        s.fixed_negative_prompt = preset.fixed_negative_prompt || '';
        s.positive_quality_preset = preset.positive_quality_preset || '';
        s.negative_quality_preset = preset.negative_quality_preset || '';

        // 更新 UI
        $('#comfyui-gen-fixed-positive').val(s.fixed_positive_prompt);
        $('#comfyui-gen-fixed-positive-end').val(s.fixed_positive_prompt_end);
        $('#comfyui-gen-fixed-negative').val(s.fixed_negative_prompt);
        $('#comfyui-gen-positive-quality').val(s.positive_quality_preset);
        $('#comfyui-gen-negative-quality').val(s.negative_quality_preset);
    }
    saveSettingsDebounced();
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

    // 加载下拉提示词预设列表
    updatePromptPresetDropdown();
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
        try {
            const infoResp = await fetch(`${url}/object_info`, { signal: AbortSignal.timeout(30000) });
            if (infoResp.ok) {
                const info = await infoResp.json();
                console.log('[ComfyUI Gen] object_info 获取成功，总计', Object.keys(info).length, '个节点');
                populateDropdownsFromObjectInfo(info);
                populateLoraDropdown(info);
            } else {
                console.error('[ComfyUI Gen] object_info 请求失败:', infoResp.status, infoResp.statusText);
                toastr.warning('获取 ComfyUI 模型列表失败 (HTTP ' + infoResp.status + ')。模型下拉框可能为空。');
            }
        } catch (infoErr) {
            console.error('[ComfyUI Gen] object_info 获取异常:', infoErr);
            toastr.warning('获取模型列表超时或失败: ' + infoErr.message + '。请检查 ComfyUI 是否带 --cors-header="*" 启动。');
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

    console.log('[ComfyUI Gen] object_info 包含的节点列表 (前20个):', Object.keys(info).slice(0, 20));

    // 模型（checkpoint）
    const ckptNode = info['CheckpointLoaderSimple'] || info['CheckpointLoader'];
    if (ckptNode) {
        console.log('[ComfyUI Gen] CheckpointLoader 节点结构:', JSON.stringify(ckptNode?.input?.required?.ckpt_name)?.substring(0, 500));
        const ckptList = ckptNode?.input?.required?.ckpt_name?.[0];
        if (Array.isArray(ckptList)) {
            console.log('[ComfyUI Gen] 模型列表:', ckptList.length, '个模型');
            populateSelect('#comfyui-gen-model', ckptList, s.default_params.model_name);
        } else {
            console.warn('[ComfyUI Gen] ckpt_name[0] 不是数组:', typeof ckptList, ckptList);
        }
    } else {
        console.warn('[ComfyUI Gen] 未找到 CheckpointLoaderSimple 或 CheckpointLoader 节点');
    }

    // 采样器
    const samplerNode = info['KSampler'] || info['KSamplerAdvanced'];
    if (samplerNode) {
        const samplerList = samplerNode?.input?.required?.sampler_name?.[0];
        if (Array.isArray(samplerList)) {
            populateSelect('#comfyui-gen-sampler', samplerList, s.default_params.sampler_name);
        }

        // 调度器
        const schedulerList = samplerNode?.input?.required?.scheduler?.[0];
        if (Array.isArray(schedulerList)) {
            populateSelect('#comfyui-gen-scheduler', schedulerList, s.default_params.scheduler);
        }
    } else {
        console.warn('[ComfyUI Gen] 未找到 KSampler 节点');
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
 * 从 object_info 中提取 LORA 列表并填充下拉框
 */
function populateLoraDropdown(info) {
    const loraNode = info['LoraLoader'] || info['LoraLoaderModelOnly'];
    if (loraNode) {
        const loraList = loraNode?.input?.required?.lora_name?.[0];
        if (Array.isArray(loraList)) {
            console.log('[ComfyUI Gen] LORA 列表:', loraList.length, '个');
            const select = $('#comfyui-gen-lora-select');
            select.empty();
            select.append('<option value="">-- 选择 LORA --</option>');
            loraList.forEach(name => {
                const shortName = name.split('/').pop().split('\\').pop();
                select.append(`<option value="${name}">${shortName}</option>`);
            });
        }
    } else {
        console.warn('[ComfyUI Gen] 未找到 LoraLoader 节点');
    }
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
        // 动态获取扩展文件夹名（不硬编码，防止重命名后失效）
        const folderName = extensionFolderPath.split('/').pop();
        console.log('[ComfyUI Gen] 更新扩展，文件夹名:', folderName);

        const headers = { 'Content-Type': 'application/json' };
        if (window.token) {
            headers['X-CSRF-Token'] = window.token;
        }

        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ extension: folderName, global: false }),
        });

        // ★ 核心防御：始终用 text() 读取，手动解析，防止 HTML 导致崩溃
        const responseText = await response.text();
        console.log('[ComfyUI Gen] 更新响应:', response.status, responseText.substring(0, 200));

        // 检测 HTML 响应（404/登录页/代理拦截）
        if (responseText.trimStart().startsWith('<')) {
            toastr.error(
                '更新接口返回了 HTML 页面。\n可能原因：\n' +
                '• 扩展名 "' + folderName + '" 未被酒馆识别\n' +
                '• 酒馆版本不支持此 API\n\n' +
                '请手动执行: cd 扩展目录 && git pull',
                '更新失败'
            );
            return;
        }

        if (response.ok) {
            try {
                const data = JSON.parse(responseText);
                if (data.isUpToDate) {
                    toastr.info('插件已是最新版本', 'ComfyUI Gen');
                    return;
                }
            } catch (_) { /* 非JSON也算成功 */ }
            toastr.success('更新成功，即将刷新页面...');
            setTimeout(() => location.reload(), 1500);
        } else {
            toastr.error('更新失败 (HTTP ' + response.status + '): ' + responseText.substring(0, 150));
        }
    } catch (e) {
        console.error('[ComfyUI Gen] 更新异常:', e);
        toastr.error('更新失败: ' + e.message);
    } finally {
        btn.html(originalHtml).prop('disabled', false);
    }
}

// ============ LORA 管理 ============

function bindLoraEvents() {
    // 添加 LORA
    $('#comfyui-gen-add-lora').on('click', function () {
        const name = $('#comfyui-gen-lora-select').val();
        const weight = parseFloat($('#comfyui-gen-lora-weight').val()) || 1.0;
        if (!name) {
            toastr.info('请先选择一个 LORA');
            return;
        }

        const s = extension_settings[extensionName];
        if (!s.loras) s.loras = [];

        // 防止重复添加
        if (s.loras.some(l => l.name === name)) {
            toastr.info('该 LORA 已在列表中');
            return;
        }

        s.loras.push({ name, weight });
        saveSettingsDebounced();
        renderLoraList();
        toastr.success('已添加 LORA: ' + name.split('/').pop().split('\\').pop());
    });

    // 删除 LORA（事件委托）
    $('#comfyui-gen-lora-list').on('click', '.lora-remove', function () {
        const idx = parseInt($(this).data('idx'));
        const s = extension_settings[extensionName];
        if (s.loras && s.loras[idx]) {
            s.loras.splice(idx, 1);
            saveSettingsDebounced();
            renderLoraList();
        }
    });

    // 初始渲染
    renderLoraList();
}

function renderLoraList() {
    const s = extension_settings[extensionName];
    const container = $('#comfyui-gen-lora-list');
    container.empty();

    if (!s.loras || s.loras.length === 0) return;

    s.loras.forEach((lora, idx) => {
        const shortName = lora.name.split('/').pop().split('\\').pop();
        container.append(`
            <span class="comfyui-gen-lora-tag">
                ${shortName}
                <span class="lora-weight">${lora.weight}</span>
                <i class="fa-solid fa-xmark lora-remove" data-idx="${idx}" title="移除"></i>
            </span>
        `);
    });
}

// ============ 工作流预设管理 ============

function bindWorkflowPresetEvents() {
    const s = extension_settings[extensionName];

    // 下拉切换
    $('#comfyui-gen-workflow-preset').on('change', function () {
        const id = $(this).val();
        s.current_workflow_preset_id = id;
        loadWorkflowPreset(id);
        saveSettingsDebounced();
    });

    // 保存
    $('#comfyui-gen-save-workflow-preset').on('click', function () {
        const id = s.current_workflow_preset_id;
        if (!id) {
            // 保存到默认
            s.workflow_json = $('#comfyui-gen-workflow').val();
            saveSettingsDebounced();
            toastr.success('默认工作流已保存');
            return;
        }
        const preset = s.workflow_presets.find(p => p.id === id);
        if (preset) {
            preset.workflow_json = $('#comfyui-gen-workflow').val();
            saveSettingsDebounced();
            toastr.success('工作流预设已保存: ' + preset.name);
        }
    });

    // 新建
    $('#comfyui-gen-new-workflow-preset').on('click', function () {
        const name = prompt('请输入工作流预设名称:');
        if (!name) return;
        if (!s.workflow_presets) s.workflow_presets = [];

        const newPreset = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            name: name,
            workflow_json: $('#comfyui-gen-workflow').val() || '',
        };
        s.workflow_presets.push(newPreset);
        s.current_workflow_preset_id = newPreset.id;
        saveSettingsDebounced();
        updateWorkflowPresetDropdown();
        toastr.success('新建工作流预设: ' + name);
    });

    // 删除
    $('#comfyui-gen-delete-workflow-preset').on('click', function () {
        const id = s.current_workflow_preset_id;
        if (!id) {
            toastr.info('默认工作流无法删除');
            return;
        }
        const preset = s.workflow_presets.find(p => p.id === id);
        if (!preset) return;
        if (!confirm('确定删除工作流预设 "' + preset.name + '" 吗？')) return;

        s.workflow_presets = s.workflow_presets.filter(p => p.id !== id);
        s.current_workflow_preset_id = '';
        saveSettingsDebounced();
        updateWorkflowPresetDropdown();
        loadWorkflowPreset('');
        toastr.success('已删除工作流预设');
    });

    // 上传 JSON 文件
    $('#comfyui-gen-import-workflow-file').on('click', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const content = ev.target.result;
                try {
                    JSON.parse(content); // 验证 JSON
                    $('#comfyui-gen-workflow').val(content).trigger('input');
                    toastr.success('已导入工作流: ' + file.name);
                } catch {
                    toastr.error('JSON 文件格式错误');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // 下载 JSON 文件
    $('#comfyui-gen-export-workflow-file').on('click', function () {
        const json = $('#comfyui-gen-workflow').val();
        if (!json) {
            toastr.info('当前工作流为空');
            return;
        }
        const name = s.workflow_presets.find(p => p.id === s.current_workflow_preset_id)?.name || 'workflow';
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name + '.json';
        a.click();
    });

    // 一键搬运（从 st-chatu8 comfyui_profiles）
    $('#comfyui-gen-migrate-workflow-presets').on('click', function () {
        console.log('[ComfyUI Gen] 一键搬运工作流按钮被点击');

        const oldExt = extension_settings['st-chatu8'];
        if (!oldExt) {
            toastr.warning('未找到 st-chatu8 插件数据。\n当前已注册扩展: ' + Object.keys(extension_settings).join(', '), '工作流搬运');
            return;
        }

        // 旧插件工作流存储在 comfyui_profiles 中
        const profiles = oldExt.comfyui_profiles;
        if (!profiles || typeof profiles !== 'object') {
            console.log('[ComfyUI Gen] st-chatu8 数据中无 comfyui_profiles:', Object.keys(oldExt).slice(0, 20));

            // 也尝试直接读 workerflows 字段
            const workflows = oldExt.workerflows || oldExt.workflows;
            if (!workflows) {
                toastr.warning('找到了 st-chatu8 数据，但无工作流预设。\n可用字段: ' + Object.keys(oldExt).slice(0, 20).join(', '), '工作流搬运');
                return;
            }
        }

        if (!s.workflow_presets) s.workflow_presets = [];
        let migratedCount = 0;

        // 从 comfyui_profiles 迁移
        if (profiles && typeof profiles === 'object') {
            Object.keys(profiles).forEach(key => {
                if (s.workflow_presets.some(p => p.name === key)) return;
                const value = profiles[key];
                let jsonStr = '';

                if (typeof value === 'string') {
                    jsonStr = value;
                } else if (typeof value === 'object') {
                    // 可能是 { workerflow: "..." } 或其他嵌套结构
                    jsonStr = value.workerflow || value.workflow || value.editWorker || JSON.stringify(value);
                }

                s.workflow_presets.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    name: key,
                    workflow_json: jsonStr,
                });
                migratedCount++;
            });
        }

        // 也尝试从 workerflows / workflows 备选字段迁移
        const altWorkflows = oldExt.workerflows || oldExt.workflows;
        if (altWorkflows && typeof altWorkflows === 'object') {
            Object.keys(altWorkflows).forEach(key => {
                if (s.workflow_presets.some(p => p.name === key)) return;
                const value = altWorkflows[key];
                let jsonStr = typeof value === 'string' ? value : JSON.stringify(value);
                s.workflow_presets.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    name: key,
                    workflow_json: jsonStr,
                });
                migratedCount++;
            });
        }

        if (migratedCount > 0) {
            saveSettingsDebounced();
            updateWorkflowPresetDropdown();
            toastr.success('成功搬运了 ' + migratedCount + ' 个工作流预设！', '工作流搬运');
        } else {
            toastr.info('没有新的可搬运工作流（可能已存在同名预设）', '工作流搬运');
        }
    });

    // 初始化下拉框
    updateWorkflowPresetDropdown();
}

function updateWorkflowPresetDropdown() {
    const s = extension_settings[extensionName];
    const select = $('#comfyui-gen-workflow-preset');
    select.empty();
    select.append('<option value="">默认</option>');

    if (s.workflow_presets) {
        s.workflow_presets.forEach(p => {
            const selected = p.id === s.current_workflow_preset_id ? 'selected' : '';
            select.append(`<option value="${p.id}" ${selected}>${p.name}</option>`);
        });
    }
}

function loadWorkflowPreset(id) {
    const s = extension_settings[extensionName];
    if (!id) {
        $('#comfyui-gen-workflow').val(s.workflow_json || '');
        return;
    }
    const preset = s.workflow_presets?.find(p => p.id === id);
    if (preset) {
        $('#comfyui-gen-workflow').val(preset.workflow_json || '');
    }
}

// ============ 提示词预设迁移启动 ============

init();
