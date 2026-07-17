/**
 * Claude CLI 调用层 + Session 管理
 * 两个 Channel（钉钉、Discord）共享此模块，各自独立处理消息后调用 callClaude
 */
import { ChildProcess } from 'child_process';
import type { ChannelType, ClaudeTalkConfig } from '../types.js';
export { createLogger, log } from './logger.js';
export interface SessionEntry {
    sessionId: string;
    lastActiveAt: number;
    isGroup: boolean;
    conversationId: string;
    userId: string;
    subagentEnabled: boolean;
    channel: ChannelType;
    needsCompact?: boolean;
    /** 本 session 整个生命周期累积的 input token 数，用于触发层级化管理 */
    cumulatedInputTokens?: number;
    /** summarize+reset 后的会话摘要，注入到新 session 的提示中 */
    sessionSummary?: string;
    /** 用户命名的会话标题，用于 /session list 展示 */
    name?: string;
    /** 累计工具调用次数，用于 /session list 展示 */
    toolCallCount?: number;
    /** 用户最后一条消息（前 200 字符），用于 resume 失败后 context 注入 */
    lastMessage?: string;
    /** 最后一条回复摘要（前 500 字符），用于 resume 失败后 context 注入 */
    lastReply?: string;
}
export declare function saveSessionMap(workDir: string, sessionMap: Map<string, SessionEntry>): void;
export declare function getSessionMap(workDir: string): Map<string, SessionEntry>;
/**
 * 生成 session key
 * 格式：conversationId\x00workDir\x00profile\x00channel[\x00userId（私聊）]
 * 使用 \x00（NUL 字符）作为分隔符。
 * userId 仅用于私聊隔离，群聊中同一群的所有人共享一个 session（共享旅行计划信息）。
 */
export declare function getSessionKey(conversationId: string, workDir: string, profile?: string, channel?: ChannelType, userId?: string, isGroup?: boolean): string;
/**
 * 清除指定会话的 session
 */
export declare function clearSession(conversationId: string, workDir: string, profile?: string, channel?: ChannelType, userId?: string, isGroup?: boolean): boolean;
/**
 * 找当前 workDir、channel、profile 下最近活跃的私聊会话，用于发上线通知
 * @param workDir - 工作目录
 * @param channel - 消息通道类型，避免跨 channel 通知
 * @param profile - profile 名称，避免同一 channel 下不同飞书应用（AppId 不同）互相通知
 */
export declare function findLastActivePrivateSession(workDir: string, channel: ChannelType, profile?: string): SessionEntry | null;
export declare function loadConfig(workDir: string, profile?: string): ClaudeTalkConfig | null;
export interface CallClaudeOptions {
    message: string;
    conversationId: string;
    workDir: string;
    isGroup?: boolean;
    userId?: string;
    profile?: string;
    channel?: ChannelType;
    /** 加工后的消息（由 Channel 处理后生成），有值时替换原始 message 发送给 Claude */
    processedMessage?: string;
}
/** 流式事件类型 */
export interface StreamEvent {
    type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'result';
    text?: string;
    thinking?: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    sessionId: string;
    isFinal: boolean;
    finalResult?: string;
}
/** 活跃中的 claude CLI 子进程，用于 graceful drain */
export declare const activeSubprocesses: Set<ChildProcess>;
/** 全局 draining 标志，由 startBot 的 drainThenExit 设置，子进程在重试前检查此标志 */
export declare let _draining: boolean;
export declare function setDraining(v: boolean): void;
export declare function callClaude(options: CallClaudeOptions, retryCount?: number): Promise<string>;
export declare function callClaudeStreaming(options: CallClaudeOptions, onEvent: (event: StreamEvent) => void, retryCount?: number): Promise<{
    sessionId: string;
    result: string;
}>;
//# sourceMappingURL=claude.d.ts.map