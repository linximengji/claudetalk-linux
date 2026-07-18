/**
 * Peer Message 协作机制
 *
 * 解决飞书平台限制：机器人无法收到其他机器人发送的消息
 * 通过共享文件（bot_{botName}.json）实现同机器上多个 ClaudeTalk 实例之间的协作
 *
 * 文件路径：{claudetalkDir}/bot_{botName}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */
import type { PeerMessage } from '../../types.js';
/**
 * 获取指定 botName 的 peer-message 文件路径
 */
export declare function getPeerMessageFilePath(claudetalkDir: string, botName: string): string;
/**
 * 读取指定 botName 的 peer-messages
 */
export declare function loadPeerMessages(claudetalkDir: string, botName: string): PeerMessage[];
/**
 * 追加一条 peer-message 到指定 botName 的文件
 * 使用原子写入防止并发覆盖
 */
export declare function appendPeerMessage(claudetalkDir: string, botName: string, message: PeerMessage): void;
/**
 * 删除已处理的 peer-messages（根据 id 集合过滤）
 * 使用原子写入防止并发覆盖
 */
export declare function removePeerMessages(claudetalkDir: string, botName: string, processedIds: Set<string>): void;
/**
 * 解析消息内容中的 @标签，返回被@的用户/机器人列表
 * 支持格式：<at user_id="ou_xxx">名称</at>
 */
export declare function parseAtMentions(content: string): Array<{
    userId: string;
    name: string;
}>;
/**
 * 发送消息成功后，解析 @标签，将 peer-message 写入被@机器人的文件
 * 匹配策略（双重兜底）：
 *   1. 优先用 appId 匹配（精确，要求 at_id 填写正确）
 *   2. appId 匹配失败时，fallback 到用 name 匹配（模糊，容错 at_id 填错的情况）
 *
 * @param claudetalkDir - .claudetalk 目录路径
 * @param chatId - 飞书群 chat_id
 * @param messageId - 发送成功后的飞书消息 ID
 * @param content - 发送的消息内容（包含 @标签）
 * @param fromProfile - 发送方 profile 名称
 * @param chatMembers - 当前群的成员列表（从 chat-members.json 读取）
 */
export declare function writePeerMessagesFromContent(claudetalkDir: string, chatId: string, messageId: string, content: string, fromProfile: string, chatMembers: Array<{
    name: string;
    type: string;
    appId?: string;
}>, isGroup?: boolean): void;
//# sourceMappingURL=peer-message.d.ts.map