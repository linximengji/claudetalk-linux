/**
 * Claude Code DingTalk Channel - 钉钉 API 客户端
 */
import type { Channel, ChannelMessageContext, DingTalkChannelConfig, DingTalkSendResponse, AICardInstance, DingTalkInboundCallback } from '../../types.js';
type InternalMessageHandler = (callback: DingTalkInboundCallback) => Promise<void>;
/**
 * 钉钉 API 客户端，实现 Channel 接口
 */
export declare class DingTalkClient implements Channel {
    private config;
    private tokenCache;
    private internalMessageHandler;
    private channelMessageHandler;
    private ws;
    private reconnectTimer;
    private isManuallyClosed;
    private reconnectDelayMs;
    private readonly logger;
    private readonly claudetalkDir;
    private readonly profileName;
    private peerPollTimer;
    private processedPeerIds;
    private privateSenderCache;
    private lastFrameAt;
    private heartbeatWatchdog;
    private readonly HEARTBEAT_TIMEOUT_MS;
    constructor(config: DingTalkChannelConfig);
    /**
     * 注册 Channel 统一消息处理器（实现 Channel 接口）
     */
    onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void;
    /**
     * 注册内部钉钉原始消息处理器（内部使用）
     */
    onRawMessage(handler: InternalMessageHandler): void;
    /**
     * 发送上线通知（实现 Channel 接口）
     */
    sendOnlineNotification(userId: string, workDir: string, profile?: string): Promise<void>;
    /**
     * 获取 Access Token
     */
    getAccessToken(): Promise<string>;
    /**
     * 获取 Stream 连接票据
     */
    private getStreamTicket;
    /**
     * 启动 peer-message 轮询
     * 每 5 秒检查一次自己的 bot_{profileName}.json
     * 处理 createdAt + 10秒 <= now 的消息
     */
    private startPeerMessagePolling;
    /**
     * 处理 peer-messages
     * 找到 createdAt + 10秒 <= now 的消息，走 Claude CLI 流程
     */
    private processPeerMessages;
    /**
     * 构建群聊上下文消息（用于注入 Claude 的 prompt）
     * 读取 context-message.template，填充历史记录、发送者信息、@列表等变量后返回完整字符串
     *
     * 模板查找顺序：
     *   1. {workDir}/.claudetalk/dingtalk/context-message.template（用户自定义）
     *   2. dist/channels/dingtalk/context-message.template（内置默认）
     */
    private buildContextMessage;
    /**
     * 启动 Stream WebSocket 连接，开始接收钉钉消息
     */
    start(): Promise<void>;
    /**
     * 停止 WebSocket 连接
     */
    stop(): void;
    /**
     * 建立 WebSocket Stream 连接
     */
    private connectStream;
    /**
     * 启动心跳 watchdog：
     * 1. 每 30 秒主动发送一次 ping 帧，防止钉钉服务器因空闲超时（约 60 秒）断开连接
     * 2. 如果超过 3 分钟没有收到任何帧，则认为连接已死，主动断开并重连
     */
    private startHeartbeatWatchdog;
    /**
     * 停止心跳 watchdog
     */
    private stopHeartbeatWatchdog;
    /**
     * 启动重连循环，持续重连直到成功或手动停止
     */
    private startReconnectLoop;
    /**
     * 处理 Stream 帧
     */
    private handleStreamFrame;
    /**
     * 处理收到的钉钉消息，转发给 Claude Code
     */
    /** chat-members.json 中单个成员的结构 */
    private get chatMembersPath();
    /** 读取 chat-members.json，返回完整配置对象 */
    private loadChatMembersConfig;
    /** 原子写入 chat-members.json */
    private saveChatMembersConfig;
    /**
     * 启动时将自己注册到 chat-members.json 的 _bot_self 列表
     * 使用 clientId（AppKey）作为唯一标识，displayName 从 agent.md 读取
     */
    private registerSelfToChatMembers;
    /**
     * 收到消息时，将发送者信息写入对应群的 chat-members.json
     * 机器人：type=bot，clientId=chatbotUserId（加密ID），profileName=profile名称
     * 真实用户：type=user，staffId=senderStaffId，senderId=senderId
     */
    private updateChatMemberFromCallback;
    /**
     * 从 chat-members.json 的 _bot_self 读取所有已注册的 profile 名称列表
     */
    private loadKnownProfilesFromChatMembers;
    /**
     * 从 agent.md 的第一个正文行（frontmatter 之后）提取机器人的中文名称
     * 例如："你是一个AI论坛项目的**前端开发工程师（Frontend Engineer）**" → "前端开发工程师"
     */
    private readAgentDisplayName;
    /**
     * 构建群成员信息段落：
     * - 机器人列表：从 bot-registry.json 读取，@ 时使用 @profileName 文本格式
     * - 显示机器人的中文名称（从 agent.md 读取）
     */
    private buildChatMembersSection;
    private handleInboundMessage;
    /**
     * 发送消息（实现 Channel 接口，自动判断私聊/群聊，自动选择消息类型）
     * 发送成功后：
     *   - 群聊：写入历史记录 + 解析 @标签写入 peer-message
     */
    sendMessage(conversationId: string, content: string, isGroup: boolean): Promise<void>;
    /**
     * 发送单聊消息
     */
    sendPrivateMessage(userId: string, content: string, msgKey?: string): Promise<DingTalkSendResponse>;
    /**
     * 发送群聊消息
     */
    sendGroupMessage(conversationId: string, content: string, msgKey?: string): Promise<DingTalkSendResponse>;
    /**
     * 发送 Markdown 消息
     * 注意：不能复用 sendGroupMessage/sendPrivateMessage，因为它们会把 content 包成 { content: ... }，
     * 而 sampleMarkdown 的 msgParam 格式是 { title, text }，需要直接构造请求体。
     */
    sendMarkdownMessage(conversationId: string, content: string, isGroup: boolean): Promise<DingTalkSendResponse>;
    /**
     * 创建并投放 AI 卡片
     */
    createAICard(conversationId: string, content: string): Promise<AICardInstance>;
    /**
     * 流式更新 AI 卡片
     */
    streamAICard(card: AICardInstance, content: string, isFinalize?: boolean): Promise<void>;
    /**
     * 下载媒体文件
     */
    downloadMedia(downloadCode: string): Promise<Buffer>;
    /**
     * 发送媒体消息
     */
    sendMediaMessage(conversationId: string, mediaBuffer: Buffer, mediaType: 'image' | 'voice' | 'video' | 'file', fileName: string, isGroup: boolean): Promise<DingTalkSendResponse>;
}
export {};
//# sourceMappingURL=index_dingtalk.d.ts.map