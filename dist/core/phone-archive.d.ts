import type { TaskCategory } from './classifier.js';
export interface ArchiveResult {
    category: TaskCategory;
    taskId?: string;
    summary?: string;
    slug: string;
    dateStr: string;
    seq: string;
    dir: string;
    userId?: string;
}
export interface ArchiveOptions {
    message: string;
    reply: string;
    toolUseCount: number;
    toolNames: string[];
    workDir: string;
    isGroup: boolean;
    /** 发送者标识（可选，用于交互日志关联） */
    userId?: string;
    /** 消息通道类型（可选） */
    channel?: string;
    /** 对话 profile 名称（可选，如 twin / default） */
    profile?: string;
}
export declare function archiveConversation(opts: ArchiveOptions): Promise<ArchiveResult>;
/**
 * Write or update a task entry directly in index.json.
 * Format MUST match tasks-mcp / tasks/cli.py (Record<id, entry>, same field schema).
 */
export declare function writeTaskToIndex(options: {
    taskId: string;
    status: string;
    summary: string;
    type?: string;
    source?: string;
    priority?: string;
    progress?: string;
}): void;
export { makeSlug, nextSeq };
declare function makeSlug(text: string): string;
declare function nextSeq(workDir: string, dateStr: string): string;
//# sourceMappingURL=phone-archive.d.ts.map