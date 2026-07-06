/**
 * 后台任务调度器
 * 独立于主会话的子进程追踪与队列体系，不干扰 activeSubprocesses / sessionQueues
 */
import { spawn } from 'child_process';
import { createLogger } from './logger.js';
// Ensure /home/ubuntu/tools is in PATH for `claude` CLI resolution.
const TOOLS_DIR = '/home/ubuntu/tools';
const curPath = process.env.PATH || '';
if (!curPath.split(':').includes(TOOLS_DIR)) {
    process.env.PATH = TOOLS_DIR + ':' + curPath;
}
export const MAX_BG_TASKS = 2;
// 独立子进程追踪
const backgroundSubprocesses = new Map();
// 独立任务状态存储
const taskStore = new Map();
let taskSeq = 0;
/** 生成唯一任务 ID */
function nextTaskId() {
    return `bg_${Date.now().toString(36)}_${(++taskSeq).toString(36)}`;
}
/** 获取运行中的后台任务数 */
export function runningCount() {
    let count = 0;
    for (const entry of taskStore.values()) {
        if (entry.status === 'running')
            count++;
    }
    return count;
}
/** 获取所有后台任务（按创建时间倒序） */
export function getAllTasks() {
    return Array.from(taskStore.values()).sort((a, b) => b.createdAt - a.createdAt);
}
/** 获取单条任务状态 */
export function getTaskStatus(taskId) {
    return taskStore.get(taskId);
}
// 敏感信息正则：扫描结果中的凭证泄露
const REDACT_PATTERN = /(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?\w{20,}/gi;
/** 过滤结果中的敏感信息 */
function filterSensitive(text) {
    return text.replace(REDACT_PATTERN, '$1: [REDACTED]');
}
/** 启动后台任务，返回 taskId */
export function startBackgroundTask(message, workDir, profile, onComplete) {
    if (runningCount() >= MAX_BG_TASKS) {
        return null;
    }
    const taskId = nextTaskId();
    const logger = createLogger(profile);
    const entry = {
        id: taskId,
        summary: message.slice(0, 60),
        status: 'running',
        createdAt: Date.now(),
    };
    taskStore.set(taskId, entry);
    logger(`[bg-task] Starting task ${taskId}: ${message.slice(0, 60)}`);
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (profile)
        args.push('--append-system-prompt', profile);
    const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workDir,
        env: { ...process.env },
    });
    backgroundSubprocesses.set(taskId, child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.stdin.write(message);
    child.stdin.end();
    child.on('close', (code) => {
        backgroundSubprocesses.delete(taskId);
        if (code !== 0) {
            entry.status = 'failed';
            entry.error = (stderr || `exit code ${code}`).slice(0, 500);
            logger(`[bg-task] ${taskId} failed: ${entry.error}`);
        }
        else {
            // 取最后一行 JSON 作为结果
            const lines = stdout.trim().split('\n');
            const lastJson = lines.filter(l => l.startsWith('{')).pop();
            if (lastJson) {
                try {
                    const parsed = JSON.parse(lastJson);
                    entry.result = (parsed.result || stdout.trim().slice(0, 300)).slice(0, 2000);
                }
                catch {
                    entry.result = stdout.trim().slice(0, 2000);
                }
            }
            else {
                entry.result = stdout.trim().slice(0, 2000);
            }
            entry.status = 'completed';
            logger(`[bg-task] ${taskId} completed (${entry.result.length} chars)`);
        }
        entry.completedAt = Date.now();
        if (entry.result)
            entry.result = filterSensitive(entry.result);
        if (entry.error)
            entry.error = filterSensitive(entry.error);
        onComplete?.(entry);
    });
    child.on('error', (err) => {
        backgroundSubprocesses.delete(taskId);
        entry.status = 'failed';
        entry.error = filterSensitive(err.message);
        entry.completedAt = Date.now();
        logger(`[bg-task] ${taskId} spawn error: ${err.message}`);
        onComplete?.(entry);
    });
    return taskId;
}
/** 取消后台任务 */
export function cancelTask(taskId) {
    const child = backgroundSubprocesses.get(taskId);
    if (!child)
        return false;
    child.kill('SIGTERM');
    setTimeout(() => {
        try {
            child.kill('SIGKILL');
        }
        catch { /* ignore */ }
    }, 3000);
    return true;
}
/** 获取所有活跃子进程引用（给 drainThenExit 跳过用，不含 kill） */
export function getBackgroundProcesses() {
    return backgroundSubprocesses;
}
//# sourceMappingURL=background-task.js.map