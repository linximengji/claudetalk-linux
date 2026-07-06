/**
 * 飞书审批卡片处理
 * 卡片模板化生成 + 回调处理 + 持久化（进程重启后回调也能正确响应）
 */
import type { RiskLevel } from '../../core/permission.js';
export interface ApprovalRequest {
    requestId: string;
    riskLevel: RiskLevel;
    messageSummary: string;
    requesterId: string;
    conversationId: string;
    createdAt: number;
    resolve: (approved: boolean) => void;
    timer: NodeJS.Timeout;
}
/** 生成唯一审批请求 ID */
export declare function nextRequestId(): string;
/** 注册待审批请求，返回 requestId */
export declare function registerApproval(requestId: string, riskLevel: RiskLevel, messageSummary: string, requesterId: string, conversationId: string, resolve: (approved: boolean) => void, timeoutMs?: number): void;
/** 处理审批回调（由飞书 card action handler 调用） */
export declare function handleApprovalCallback(value: Record<string, unknown>): {
    toast: {
        type: string;
        content: string;
    };
};
/** 构建待办任务确认卡片（自动归档 task-pending 时用） */
export declare function buildTaskConfirmCard(params: {
    summary: string;
    taskId: string;
    type?: string;
    priority?: string;
    progressNotes?: string;
}): string;
/** 根据消息关键词推断任务类型 */
export declare function inferTaskType(message: string): string;
/** 根据消息关键词推断优先级 */
export declare function inferTaskPriority(message: string): string;
/** 构建存档确认卡片 */
export declare function buildArchiveConfirmCard(messagePreview: string): string;
/** 构建审批卡片（模板化，CC 不能自由构造） */
export declare function buildApprovalCard(params: {
    riskLevel: RiskLevel;
    riskLabel: string;
    messageSummary: string;
    requestId: string;
    requesterId: string;
    reason: string;
}): string;
//# sourceMappingURL=approval-handler.d.ts.map