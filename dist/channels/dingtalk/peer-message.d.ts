/**
 * DingTalk Peer Message 协作机制
 *
 * 解决钉钉平台限制：机器人无法收到其他机器人发送的消息（即使被@了也收不到）
 * 通过共享文件（bot_{profileName}.json）实现同机器上多个 ClaudeTalk 实例之间的协作
 *
 * 文件路径：{claudetalkDir}/dingtalk/bot_{profileName}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */
export interface DingTalkPeerMessage {
    /** 消息唯一 ID */
    id: string;
    /** 发送方 profile 名称 */
    from: string;
    /** 群会话 ID */
    conversationId: string;
    /** 消息内容（包含 @标签的原始文本） */
    message: string;
    /** 创建时间戳（ms） */
    createdAt: number;
}
/**
 * 获取指定 profileName 的 peer-message 文件路径
 */
export declare function getPeerMessageFilePath(claudetalkDir: string, profileName: string): string;
/**
 * 读取指定 profileName 的 peer-messages
 */
export declare function loadPeerMessages(claudetalkDir: string, profileName: string): DingTalkPeerMessage[];
/**
 * 追加一条 peer-message 到指定 profileName 的文件
 */
export declare function appendPeerMessage(claudetalkDir: string, profileName: string, message: DingTalkPeerMessage): void;
/**
 * 删除已处理的 peer-messages（根据 id 集合过滤）
 */
export declare function removePeerMessages(claudetalkDir: string, profileName: string, processedIds: Set<string>): void;
/**
 * 解析消息内容中的 @机器人名称
 * 支持两种格式：
 * 1. @profileName 文本格式：例如 "@front 帮我分析一下这段代码"
 * 2. <at id=profile>名称</at> 标签格式：例如 "<at id=front>前端工程师</at>"
 * 返回被@的 profile 名称列表
 */
export declare function parseAtMentions(messageText: string): string[];
/**
 * 发送消息成功后，解析 @标签，将 peer-message 写入被@机器人的文件
 *
 * @param claudetalkDir - .claudetalk 目录路径
 * @param conversationId - 钉钉群会话 ID
 * @param messageText - 发送的消息内容
 * @param fromProfile - 发送方 profile 名称
 * @param knownProfiles - 当前已知的所有 profile 名称列表（用于匹配被@的机器人）
 */
export declare function writePeerMessagesFromContent(claudetalkDir: string, conversationId: string, messageText: string, fromProfile: string, knownProfiles: string[]): void;
//# sourceMappingURL=peer-message.d.ts.map