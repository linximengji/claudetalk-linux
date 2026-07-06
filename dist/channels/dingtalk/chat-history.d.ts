/**
 * DingTalk Chat History - 群聊历史记录文件中转机制
 *
 * 由于钉钉 API 不支持拉取群聊历史消息，通过本地文件记录历史消息
 * 每个群会话对应一个文件：{claudetalkDir}/dingtalk/history_{conversationId}.json
 * 最多保存 50 条记录，超过上限时删除最早的若干条（保持总数不超过上限）
 *
 * 文件路径：{claudetalkDir}/dingtalk/history_{conversationId}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */
/** 消息来源类型 */
export type MessageRole = 'user' | 'bot';
/** 历史消息条目 */
export interface ChatHistoryEntry {
    /** 消息时间戳（ms） */
    timestamp: number;
    /** 消息来源：user=用户，bot=机器人 */
    role: MessageRole;
    /** 发送者标识（用户 ID 或机器人 profile 名称） */
    senderId: string;
    /** 消息内容 */
    content: string;
}
/**
 * 获取指定会话的历史记录文件路径
 * conversationId 中可能含有特殊字符，做简单 base64 编码保证文件名安全
 */
export declare function getChatHistoryFilePath(claudetalkDir: string, conversationId: string): string;
/**
 * 读取指定会话的历史记录
 */
export declare function loadChatHistory(claudetalkDir: string, conversationId: string): ChatHistoryEntry[];
/**
 * 追加一条历史记录
 * 超过 MAX_HISTORY_SIZE 条时，删除最早的一条（按 timestamp 排序）
 */
export declare function appendChatHistory(claudetalkDir: string, conversationId: string, entry: ChatHistoryEntry): void;
/**
 * 将历史记录格式化为可读文本，供注入到 Claude 上下文中
 * 格式：[时间] 角色(发送者): 内容
 */
export declare function formatChatHistory(entries: ChatHistoryEntry[]): string;
//# sourceMappingURL=chat-history.d.ts.map