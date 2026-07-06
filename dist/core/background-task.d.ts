/**
 * 后台任务调度器
 * 独立于主会话的子进程追踪与队列体系，不干扰 activeSubprocesses / sessionQueues
 */
import { ChildProcess } from 'child_process';
export declare const MAX_BG_TASKS = 2;
export interface BgTaskEntry {
    id: string;
    summary: string;
    status: 'running' | 'completed' | 'failed';
    createdAt: number;
    completedAt?: number;
    result?: string;
    error?: string;
}
/** 获取运行中的后台任务数 */
export declare function runningCount(): number;
/** 获取所有后台任务（按创建时间倒序） */
export declare function getAllTasks(): BgTaskEntry[];
/** 获取单条任务状态 */
export declare function getTaskStatus(taskId: string): BgTaskEntry | undefined;
/** 启动后台任务，返回 taskId */
export declare function startBackgroundTask(message: string, workDir: string, profile?: string, onComplete?: (entry: BgTaskEntry) => void): string | null;
/** 取消后台任务 */
export declare function cancelTask(taskId: string): boolean;
/** 获取所有活跃子进程引用（给 drainThenExit 跳过用，不含 kill） */
export declare function getBackgroundProcesses(): Map<string, ChildProcess>;
//# sourceMappingURL=background-task.d.ts.map