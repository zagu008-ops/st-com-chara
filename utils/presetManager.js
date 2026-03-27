/**
 * ComfyUI Gen - 预设管理器
 * 统一管理服装预设和角色预设的 CRUD 操作
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extensionName } from './config.js';

/**
 * 生成 UUID
 */
function uuid() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
        Math.floor(Math.random() * 16).toString(16)
    );
}

/**
 * 获取设置引用
 */
function getSettings() {
    return extension_settings[extensionName];
}

// ============ 预设 CRUD ============

/**
 * 创建新预设
 * @param {'outfit'|'character'} type
 * @param {object} data
 */
export function createPreset(type, data) {
    const settings = getSettings();
    const listKey = type === 'outfit' ? 'outfit_presets' : 'character_presets';

    const preset = {
        id: uuid(),
        name: data.name || '未命名',
        type,
        positivePrompt: data.positivePrompt || '',
        negativePrompt: data.negativePrompt || '',
        thumbnail: data.thumbnail || '',
        fields: data.fields || {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    settings[listKey].push(preset);
    saveSettingsDebounced();
    return preset;
}

/**
 * 获取指定类型的所有预设
 * @param {'outfit'|'character'} type
 */
export function getPresets(type) {
    const settings = getSettings();
    const listKey = type === 'outfit' ? 'outfit_presets' : 'character_presets';
    return settings[listKey] || [];
}

/**
 * 获取单个预设
 */
export function getPresetById(type, id) {
    return getPresets(type).find(p => p.id === id) || null;
}

/**
 * 更新预设
 */
export function updatePreset(type, id, updates) {
    const settings = getSettings();
    const listKey = type === 'outfit' ? 'outfit_presets' : 'character_presets';
    const index = settings[listKey].findIndex(p => p.id === id);

    if (index === -1) {
        console.error('[ComfyUI Gen] 预设不存在:', id);
        return null;
    }

    settings[listKey][index] = {
        ...settings[listKey][index],
        ...updates,
        updatedAt: Date.now(),
    };

    saveSettingsDebounced();
    return settings[listKey][index];
}

/**
 * 删除预设
 */
export function deletePreset(type, id) {
    const settings = getSettings();
    const listKey = type === 'outfit' ? 'outfit_presets' : 'character_presets';
    const activeKey = type === 'outfit' ? 'active_outfit_id' : 'active_character_id';

    settings[listKey] = settings[listKey].filter(p => p.id !== id);

    // 如果删除的是当前激活预设，清空激活状态
    if (settings[activeKey] === id) {
        settings[activeKey] = '';
    }

    saveSettingsDebounced();
}

/**
 * 设置激活预设
 */
export function setActivePreset(type, id) {
    const settings = getSettings();
    const activeKey = type === 'outfit' ? 'active_outfit_id' : 'active_character_id';
    settings[activeKey] = id;
    saveSettingsDebounced();
}

/**
 * 获取当前激活预设
 */
export function getActivePreset(type) {
    const settings = getSettings();
    const activeKey = type === 'outfit' ? 'active_outfit_id' : 'active_character_id';
    const activeId = settings[activeKey];
    if (!activeId) return null;
    return getPresetById(type, activeId);
}

/**
 * 导出所有预设为 JSON
 */
export function exportPresets(type) {
    const presets = getPresets(type);
    return JSON.stringify(presets, null, 2);
}

/**
 * 导入预设
 */
export function importPresets(type, jsonStr) {
    const settings = getSettings();
    const listKey = type === 'outfit' ? 'outfit_presets' : 'character_presets';

    try {
        const imported = JSON.parse(jsonStr);
        if (!Array.isArray(imported)) {
            throw new Error('JSON 格式不正确，应为数组');
        }

        for (const preset of imported) {
            // 检查是否已存在同名预设
            const exists = settings[listKey].find(p => p.name === preset.name);
            if (exists) {
                // 更新已有预设
                Object.assign(exists, preset, { updatedAt: Date.now() });
            } else {
                // 添加新预设
                settings[listKey].push({
                    ...preset,
                    id: preset.id || uuid(),
                    type,
                    createdAt: preset.createdAt || Date.now(),
                    updatedAt: Date.now(),
                });
            }
        }

        saveSettingsDebounced();
        return imported.length;
    } catch (e) {
        throw new Error('导入失败: ' + e.message);
    }
}
