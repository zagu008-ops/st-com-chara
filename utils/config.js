/**
 * ComfyUI Gen - 配置文件
 * 默认设置、事件常量、扩展名
 */

export const extensionName = 'st-com-chara';
export const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// 事件名常量
export const EVENTS = {
    GENERATE_REQUEST: 'comfyui_gen_generate_request',
    GENERATE_RESPONSE: 'comfyui_gen_generate_response',
    PRESET_CHANGED: 'comfyui_gen_preset_changed',
    INTERROGATE_REQUEST: 'comfyui_gen_interrogate_request',
    INTERROGATE_RESPONSE: 'comfyui_gen_interrogate_response',
};

// 默认设置
export const defaultSettings = {
    enabled: true,

    // ComfyUI 连接配置
    comfyui_url: 'http://127.0.0.1:8188',
    client_mode: 'browser',  // 'browser' | 'server'

    // 生图默认参数
    default_params: {
        steps: 20,
        cfg_scale: 7,
        width: 512,
        height: 768,
        sampler_name: 'euler',
        scheduler: 'normal',
        seed: -1,
        model_name: '',
        vae: '',
        clip: '',
    },

    // 固定提示词
    fixed_positive_prompt: 'masterpiece, best quality',
    fixed_positive_prompt_end: '',
    fixed_negative_prompt: 'worst quality, low quality, normal quality, lowres, bad anatomy, bad hands',

    // 质量预设
    positive_quality_preset: 'best quality, amazing quality, very aesthetic, absurdres',
    negative_quality_preset: '',

    // 提示词预设集合
    // { id: string, name: string, fixed_positive_prompt: string, fixed_positive_prompt_end: string, fixed_negative_prompt: string, positive_quality_preset: string, negative_quality_preset: string }
    prompt_presets: [],
    current_prompt_preset_id: '',

    // LORA 列表 [{ name: 'lora_filename', weight: 1.0 }]
    loras: [],

    // 工作流 JSON（用户粘贴 ComfyUI 导出的 API JSON）
    workflow_json: '',

    // 工作流预设集合 [{ id, name, workflow_json }]
    workflow_presets: [],
    current_workflow_preset_id: '',

    // 反推工作流 JSON（用于图片反推提示词）
    interrogate_workflow_json: '',
    interrogate_url: '',

    // 反推模式: 'comfyui' | 'llm'
    interrogate_mode: 'comfyui',

    // LLM Vision 反推配置
    llm_interrogate_url: '',        // OpenAI 兼容 API 地址
    llm_interrogate_key: '',        // API Key
    llm_interrogate_model: '',      // 模型名
    llm_interrogate_prompt: 'Please analyze this image and generate Stable Diffusion / NovelAI style tags (danbooru tags). Output ONLY comma-separated tags, no explanation. Include: character count, hair color/style, eye color, clothing, pose, expression, background, art style.',

    // 预设数据
    outfit_presets: [],
    character_presets: [],

    // 当前选中的预设
    active_outfit_id: '',
    active_character_id: '',

    // 悬浮球设置
    fab_enabled: true,
    fab_position: { right: 20, bottom: 80 },

    // JPEG 压缩
    jpeg_compression: false,
    jpeg_quality: 85,

    // === 自动生图配置 ===
    auto_generate_enabled: false,       // 自动生图总开关
    auto_trigger_mode: 'llm',          // 'marker' | 'llm'
    auto_marker_start: '[',            // 标记开始符
    auto_marker_end: ']',              // 标记结束符
    auto_context_length: 5,            // LLM 上下文消息条数
    auto_only_character: true,         // 只对角色消息触发
    auto_user_tags: '',                // 用户手动附加的标签（与 LLM 结合生成）
    auto_llm_system_prompt: '',        // 自定义 LLM 生图 system prompt（空=使用内置默认）
};
