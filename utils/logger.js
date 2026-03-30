/**
 * ComfyUI Gen - 日志管理模块
 * 复刻智绘姬的日志和任务管理面板
 */

const logEntries = [];
const taskList = [];
let taskIdCounter = 0;

/**
 * 写入日志
 */
export function addLog(msg) {
    const now = new Date();
    const ts = `[${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${now.toLocaleTimeString()}]`;
    const line = `${ts} ${msg}`;
    logEntries.push(line);
    console.log('[ComfyUI Gen]', msg);

    // 写入文本域
    const el = document.getElementById('cg-log-output');
    if (el) {
        el.value = logEntries.join('\n');
        el.scrollTop = el.scrollHeight;
    }

    // 同时写入悬浮面板
    const sysLogBox = document.getElementById('cg-ai-sys-logs');
    if (sysLogBox) {
        const time = now.toLocaleTimeString();
        sysLogBox.innerHTML += `<div>[${time}] ${msg}</div>`;
        sysLogBox.scrollTop = sysLogBox.scrollHeight;
    }
}

/**
 * 添加任务
 */
export function addTask(title) {
    const id = ++taskIdCounter;
    const task = {
        id,
        title,
        status: 'running', // running | done | cancelled
        startTime: new Date().toLocaleTimeString(),
    };
    taskList.push(task);
    renderTaskList();
    return id;
}

/**
 * 更新任务状态
 */
export function updateTask(id, status) {
    const task = taskList.find(t => t.id === id);
    if (task) {
        task.status = status;
        renderTaskList();
    }
}

/**
 * 渲染任务列表
 */
function renderTaskList() {
    const container = document.getElementById('cg-task-list');
    if (!container) return;

    if (taskList.length === 0) {
        container.innerHTML = '<div style="padding: 15px; text-align: center; opacity: 0.4;">暂无任务</div>';
        return;
    }

    container.innerHTML = taskList.map(t => {
        const statusIcon = t.status === 'running'
            ? '<i class="fa-solid fa-spinner fa-spin" style="color: #3498db;"></i>'
            : t.status === 'done'
                ? '<i class="fa-solid fa-check" style="color: #2ecc71;"></i>'
                : '<i class="fa-solid fa-xmark" style="color: #e74c3c;"></i>';

        return `
            <div style="display: flex; align-items: center; gap: 10px; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.9em;">
                ${statusIcon}
                <span style="flex: 1;">${t.title}</span>
                <span style="opacity: 0.4; font-size: 0.85em;">${t.startTime}</span>
                ${t.status === 'running' ? `<button data-task-cancel="${t.id}" class="comfyui-gen-btn danger" style="padding: 2px 8px; font-size: 0.8em;">取消</button>` : ''}
            </div>
        `;
    }).join('');

    // Bind cancel buttons
    container.querySelectorAll('[data-task-cancel]').forEach(btn => {
        btn.addEventListener('click', function () {
            const tid = parseInt(this.getAttribute('data-task-cancel'));
            updateTask(tid, 'cancelled');
        });
    });
}

/**
 * 初始化日志面板事件
 */
export function initLogEvents() {
    // 导出日志
    $('#cg-log-export').off('click').on('click', function () {
        if (logEntries.length === 0) {
            toastr.warning('日志为空');
            return;
        }
        const blob = new Blob([logEntries.join('\n')], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `comfyui-gen-log-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        toastr.success('日志已导出');
    });

    // 清空日志
    $('#cg-log-clear').off('click').on('click', function () {
        logEntries.length = 0;
        const el = document.getElementById('cg-log-output');
        if (el) el.value = '';
        toastr.success('日志已清空');
    });

    // 全部取消
    $('#cg-task-cancel-all').off('click').on('click', function () {
        for (const t of taskList) {
            if (t.status === 'running') t.status = 'cancelled';
        }
        renderTaskList();
    });

    // 清空已完成
    $('#cg-task-clear-done').off('click').on('click', function () {
        for (let i = taskList.length - 1; i >= 0; i--) {
            if (taskList[i].status !== 'running') taskList.splice(i, 1);
        }
        renderTaskList();
    });
}
