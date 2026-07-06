/**
 * DingTalk Peer Message 协作机制
 *
 * 解决钉钉平台限制：机器人无法收到其他机器人发送的消息（即使被@了也收不到）
 * 通过共享文件（bot_{profileName}.json）实现同机器上多个 ClaudeTalk 实例之间的协作
 *
 * 文件路径：{claudetalkDir}/dingtalk/bot_{profileName}.json
 * 原子写入：写入临时文件后 rename，避免并发写覆盖
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../../core/logger.js';
const logger = createLogger('dingtalk', 'peer-message');
// ========== 文件路径 ==========
/**
 * 获取 dingtalk 目录路径
 */
function getDingTalkDir(claudetalkDir) {
    return path.join(claudetalkDir, 'dingtalk');
}
/**
 * 获取指定 profileName 的 peer-message 文件路径
 */
export function getPeerMessageFilePath(claudetalkDir, profileName) {
    return path.join(getDingTalkDir(claudetalkDir), `bot_${profileName}.json`);
}
// ========== 读写操作 ==========
/**
 * 读取指定 profileName 的 peer-messages
 */
export function loadPeerMessages(claudetalkDir, profileName) {
    const filePath = getPeerMessageFilePath(claudetalkDir, profileName);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
    }
    catch (error) {
        logger(`[peer-message] Failed to load bot_${profileName}.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
}
/**
 * 原子写入 peer-messages 到指定 profileName 的文件
 * 先写入临时文件，再 rename 替换，避免并发写覆盖
 */
function atomicWritePeerMessages(claudetalkDir, profileName, messages) {
    const filePath = getPeerMessageFilePath(claudetalkDir, profileName);
    const tmpFilePath = `${filePath}.tmp`;
    const dingtalkDir = getDingTalkDir(claudetalkDir);
    if (!fs.existsSync(dingtalkDir)) {
        fs.mkdirSync(dingtalkDir, { recursive: true });
    }
    fs.writeFileSync(tmpFilePath, JSON.stringify(messages, null, 2), 'utf-8');
    fs.renameSync(tmpFilePath, filePath);
}
/**
 * 追加一条 peer-message 到指定 profileName 的文件
 */
export function appendPeerMessage(claudetalkDir, profileName, message) {
    const existingMessages = loadPeerMessages(claudetalkDir, profileName);
    existingMessages.push(message);
    atomicWritePeerMessages(claudetalkDir, profileName, existingMessages);
    logger(`[peer-message] Appended message to bot_${profileName}.json: id=${message.id}, from=${message.from}`);
}
/**
 * 删除已处理的 peer-messages（根据 id 集合过滤）
 */
export function removePeerMessages(claudetalkDir, profileName, processedIds) {
    const existingMessages = loadPeerMessages(claudetalkDir, profileName);
    const remainingMessages = existingMessages.filter((msg) => !processedIds.has(msg.id));
    atomicWritePeerMessages(claudetalkDir, profileName, remainingMessages);
    logger(`[peer-message] Removed ${existingMessages.length - remainingMessages.length} processed messages from bot_${profileName}.json`);
}
// ========== @标签解析 ==========
/**
 * 解析消息内容中的 @机器人名称
 * 支持两种格式：
 * 1. @profileName 文本格式：例如 "@front 帮我分析一下这段代码"
 * 2. <at id=profile>名称</at> 标签格式：例如 "<at id=front>前端工程师</at>"
 * 返回被@的 profile 名称列表
 */
export function parseAtMentions(messageText) {
    const mentions = [];
    // 格式1：<at id=profile>名称</at>
    const atTagPattern = /<at\s+id=["']?(\S+?)["']?\s*>[^<]*<\/at>/g;
    let match;
    while ((match = atTagPattern.exec(messageText)) !== null) {
        mentions.push(match[1]);
    }
    // 格式2：@profileName（排除已被 <at> 标签覆盖的部分）
    const strippedText = messageText.replace(/<at\s[^>]*>.*?<\/at>/g, '');
    const atPattern = /@(\S+)/g;
    while ((match = atPattern.exec(strippedText)) !== null) {
        mentions.push(match[1]);
    }
    return mentions;
}
// ========== 写入 peer-message ==========
/**
 * 发送消息成功后，解析 @标签，将 peer-message 写入被@机器人的文件
 *
 * @param claudetalkDir - .claudetalk 目录路径
 * @param conversationId - 钉钉群会话 ID
 * @param messageText - 发送的消息内容
 * @param fromProfile - 发送方 profile 名称
 * @param knownProfiles - 当前已知的所有 profile 名称列表（用于匹配被@的机器人）
 */
export function writePeerMessagesFromContent(claudetalkDir, conversationId, messageText, fromProfile, knownProfiles) {
    const mentionedNames = parseAtMentions(messageText);
    if (mentionedNames.length === 0)
        return;
    for (const mentionedName of mentionedNames) {
        // 在已知 profile 列表中查找匹配的机器人（忽略大小写）
        const matchedProfile = knownProfiles.find((profile) => profile.toLowerCase() === mentionedName.toLowerCase());
        if (!matchedProfile) {
            logger(`[peer-message] No profile matched for mention: @${mentionedName}`);
            continue;
        }
        // 不给自己写 peer-message
        if (matchedProfile === fromProfile) {
            logger(`[peer-message] Skipping self-mention: @${mentionedName}`);
            continue;
        }
        const peerMessage = {
            id: randomUUID(),
            from: fromProfile,
            conversationId,
            message: messageText,
            createdAt: Date.now(),
        };
        appendPeerMessage(claudetalkDir, matchedProfile, peerMessage);
        logger(`[peer-message] Wrote peer message to bot_${matchedProfile}.json: conversationId=${conversationId}, from=${fromProfile}`);
    }
}
//# sourceMappingURL=peer-message.js.map