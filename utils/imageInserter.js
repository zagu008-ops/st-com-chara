/**
 * ComfyUI Gen - 图片插入模块
 * 将生成的图片插入到 SillyTavern 聊天界面
 */

/**
 * 将生成结果插入聊天
 * @param {Array} results - 生成结果数组 [{type, data, filename}]
 * @param {string} prompt - 使用的提示词（用于 alt text）
 */
export function insertResultsToChat(results, prompt = '') {
    const chatContainer = document.querySelector('#chat');
    if (!chatContainer) {
        console.error('[ComfyUI Gen] 未找到聊天容器');
        return;
    }

    for (const result of results) {
        if (result.type === 'image') {
            insertImage(chatContainer, result.data, result.filename, prompt);
        } else if (result.type === 'video') {
            insertVideo(chatContainer, result.data, result.filename);
        }
    }
}

/**
 * 插入图片到聊天
 */
function insertImage(container, base64Data, filename, altText) {
    const wrapper = document.createElement('div');
    wrapper.className = 'comfyui-gen-image-wrapper';

    const img = document.createElement('img');
    img.src = base64Data;
    img.alt = altText || filename;
    img.title = `生成图片: ${filename}`;
    img.className = 'comfyui-gen-image';
    img.style.cssText = 'max-width: 300px; max-height: 400px; border-radius: 12px; cursor: pointer; transition: transform .2s ease;';

    // 点击查看大图
    img.addEventListener('click', () => showFullImage(base64Data, filename));

    // 悬停放大效果
    img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.02)'; });
    img.addEventListener('mouseleave', () => { img.style.transform = 'scale(1)'; });

    // 操作按钮栏
    const actions = document.createElement('div');
    actions.className = 'comfyui-gen-image-actions';
    actions.style.cssText = 'display: flex; gap: 8px; margin-top: 6px;';

    // 下载按钮
    const downloadBtn = document.createElement('button');
    downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
    downloadBtn.title = '下载图片';
    downloadBtn.className = 'comfyui-gen-action-btn';
    downloadBtn.addEventListener('click', () => downloadImage(base64Data, filename));
    actions.appendChild(downloadBtn);

    wrapper.appendChild(img);
    wrapper.appendChild(actions);

    appendToLastMessage(container, wrapper);
}

/**
 * 插入视频到聊天
 */
function insertVideo(container, base64Data, filename) {
    const wrapper = document.createElement('div');
    wrapper.className = 'comfyui-gen-video-wrapper';

    const video = document.createElement('video');
    video.src = base64Data;
    video.controls = true;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.className = 'comfyui-gen-video';
    video.style.cssText = 'max-width: 300px; border-radius: 12px;';

    wrapper.appendChild(video);
    appendToLastMessage(container, wrapper);
}

/**
 * 追加内容到最后一条消息
 */
function appendToLastMessage(container, element) {
    // 尝试找到最后一条消息的内容区域
    const messages = container.querySelectorAll('.mes');
    if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const mesText = lastMsg.querySelector('.mes_text');
        if (mesText) {
            mesText.appendChild(element);
            // 滚动到底部
            container.scrollTop = container.scrollHeight;
            return;
        }
    }

    // 回退：直接追加到聊天容器
    container.appendChild(element);
    container.scrollTop = container.scrollHeight;
}

/**
 * 显示大图查看器
 */
function showFullImage(base64Data, filename) {
    // 移除已有的查看器
    const existing = document.getElementById('comfyui-gen-fullview');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'comfyui-gen-fullview';
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; backdrop-filter: blur(8px);
        animation: comfyui-gen-fadein 0.2s ease;
    `;

    const img = document.createElement('img');
    img.src = base64Data;
    img.style.cssText = 'max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);';

    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}

/**
 * 下载图片
 */
function downloadImage(base64Data, filename) {
    const a = document.createElement('a');
    a.href = base64Data;
    a.download = filename || 'comfyui-gen-output.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
