/**
 * ComfyUI Gen - 图片缓存管理模块
 * 复刻智绘姬的图片缓存管理功能
 */

const imageCache = [];
let isSelectMode = false;

/**
 * 添加图片到缓存
 */
export function addImageToCache(base64Data, filename = '') {
    const now = new Date();
    const id = 'cache-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    const entry = {
        id,
        data: base64Data,
        filename: filename || `comfyui_${now.toISOString().replace(/[:.]/g, '-')}.png`,
        timestamp: now.toLocaleString(),
        selected: false,
    };
    imageCache.push(entry);
    renderGallery();
    return entry;
}

/**
 * 渲染图片画廊
 */
function renderGallery() {
    const gallery = $('#cg-cache-gallery');
    if (!gallery.length) return;

    gallery.empty();

    if (imageCache.length === 0) {
        gallery.html('<div style="grid-column: 1 / -1; text-align: center; padding: 30px; opacity: 0.4;">尚无缓存图片。生成图片后将自动在此展示。</div>');
        return;
    }

    for (const entry of imageCache) {
        const card = $(`
            <div class="cg-cache-card" data-id="${entry.id}" style="
                position: relative;
                border-radius: 8px;
                overflow: hidden;
                border: 2px solid ${entry.selected ? '#e67e22' : 'transparent'};
                cursor: pointer;
                transition: all 0.2s ease;
                background: rgba(0,0,0,0.3);
            ">
                <img src="${entry.data}" style="width: 100%; height: 120px; object-fit: cover; display: block;" />
                <div style="padding: 4px 6px; font-size: 0.7em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${entry.filename}
                </div>
                ${isSelectMode ? `<div style="position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid #fff; background: ${entry.selected ? '#e67e22' : 'rgba(0,0,0,0.5)'}; display: flex; align-items: center; justify-content: center;">
                    ${entry.selected ? '<i class="fa-solid fa-check" style="font-size: 12px; color: #fff;"></i>' : ''}
                </div>` : ''}
            </div>
        `);

        card.on('click', function () {
            if (isSelectMode) {
                entry.selected = !entry.selected;
                renderGallery();
            } else {
                // Preview: open in new tab
                const w = window.open('');
                w.document.write(`<img src="${entry.data}" style="max-width:100%; background: #1a1a1a;" />`);
                w.document.title = entry.filename;
            }
        });

        gallery.append(card);
    }
}

/**
 * 初始化图片缓存事件
 */
export function initImageCacheEvents() {
    // 多选切换
    $('#cg-cache-toggle-select').off('click').on('click', function () {
        isSelectMode = !isSelectMode;
        $(this).text(isSelectMode ? '退出多选' : '多选');
        if (!isSelectMode) {
            for (const e of imageCache) e.selected = false;
        }
        renderGallery();
    });

    // 全选
    $('#cg-cache-select-all').off('click').on('click', function () {
        isSelectMode = true;
        $('#cg-cache-toggle-select').text('退出多选');
        for (const e of imageCache) e.selected = true;
        renderGallery();
    });

    // 取消全选
    $('#cg-cache-deselect-all').off('click').on('click', function () {
        for (const e of imageCache) e.selected = false;
        renderGallery();
    });

    // 下载选中
    $('#cg-cache-download').off('click').on('click', function () {
        const selected = imageCache.filter(e => e.selected);
        if (selected.length === 0) {
            toastr.warning('请先选择要下载的图片');
            return;
        }
        for (const entry of selected) {
            const a = document.createElement('a');
            a.href = entry.data;
            a.download = entry.filename;
            a.click();
        }
        toastr.success(`已下载 ${selected.length} 张图片`);
    });

    // 删除选中
    $('#cg-cache-delete').off('click').on('click', function () {
        const count = imageCache.filter(e => e.selected).length;
        if (count === 0) {
            toastr.warning('请先选择要删除的图片');
            return;
        }
        if (!confirm(`确认删除 ${count} 张图片？`)) return;
        for (let i = imageCache.length - 1; i >= 0; i--) {
            if (imageCache[i].selected) imageCache.splice(i, 1);
        }
        renderGallery();
        toastr.success(`已删除 ${count} 张图片`);
    });
}
