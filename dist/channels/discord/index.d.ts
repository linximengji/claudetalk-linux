/**
 * Discord Channel 实现
 * 使用 discord.js 接收消息，实现 Channel 接口
 * 消息处理逻辑与钉钉完全独立
 */
import type { Channel, ChannelMessageContext } from '../../types.js';
export interface DiscordChannelConfig {
    /** Bot Token */
    token: string;
    /** 限定 Guild ID（可选，不填则响应所有 Guild） */
    guildId?: string;
}
/**
 * Discord Channel 实现，实现 Channel 接口
 * 特有能力：支持获取历史消息（getHistoryMessages）
 */
export declare class DiscordClient implements Channel {
    private config;
    private client;
    private messageHandler;
    private readonly logger;
    constructor(config: DiscordChannelConfig);
    /**
     * 注册消息处理器（实现 Channel 接口）
     */
    onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void;
    /**
     * 启动 Discord Bot（实现 Channel 接口）
     */
    start(): Promise<void>;
    /**
     * 停止 Discord Bot（实现 Channel 接口）
     */
    stop(): void;
    /**
     * 发送消息（实现 Channel 接口）
     * 超过 2000 字符时自动分段发送
     */
    sendMessage(conversationId: string, content: string, _isGroup: boolean): Promise<void>;
    /**
     * 发送上线通知（实现 Channel 接口）
     * 通过 DM 发送给指定用户
     */
    sendOnlineNotification(userId: string, workDir: string, profile?: string): Promise<void>;
    /**
     * 获取频道历史消息（Discord 专有能力）
     * 可在新建 session 时注入上下文
     */
    getHistoryMessages(channelId: string, limit?: number): Promise<string[]>;
}
//# sourceMappingURL=index.d.ts.map