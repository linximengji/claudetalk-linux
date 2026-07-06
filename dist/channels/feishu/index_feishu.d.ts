/**
 * Claude Code Feishu Channel - Feishu API client
 *
 * Runs in peer-message mode: WS connection managed by the independent feishu-bridge process.
 */
import type { Channel, ChannelMessageContext, FeishuChannelConfig } from '../../types.js';
interface FeishuSendMessageResponse {
    code: number;
    msg: string;
    data?: {
        message_id: string;
    };
}
/**
 * 飞书 API 客户端，实现 Channel 接口
 *
 * 接收消息：使用飞书 WebSocket 长连接（需要飞书开放平台开启"使用长连接接收事件"）
 * 发送消息：使用飞书 IM API
 */
export declare class FeishuClient implements Channel {
    private config;
    private tokenCache;
    private botOpenId;
    private channelMessageHandler;
    private readonly claudetalkDir;
    private peerPollTimer;
    private _botInfoRetryTimer;
    private processedPeerIds;
    private botAppName;
    private _lastConvGetter;
    private readonly chatMemberStore;
    private readonly chatMemberResolver;
    private readonly logger;
    constructor(config: FeishuChannelConfig);
    /**
     * 启动 peer-messages 轮询
     * 每 5 秒检查一次自己的 bot_{profileName}.json
     * 处理 createdAt + 10秒 <= now 的消息
     */
    private startPeerMessagePolling;
    /**
     * 处理 peer-messages
     * 找到 createdAt + 10秒 <= now 的消息，回复表情后走 Claude CLI 流程
     */
    private processPeerMessages;
    /**
     * 注册 Channel 统一消息处理器（实现 Channel 接口）
     */
    onMessage(handler: (context: ChannelMessageContext, message: string) => Promise<void>): void;
    /**
     * 注册"最近对话"获取回调（实现 Channel 接口）
     */
    setLastConvGetter(getter: (convId: string) => {
        message: string;
        reply: string;
    } | null): void;
    /**
     * 发送上线通知（实现 Channel 接口）
     */
    sendOnlineNotification(userId: string, workDir: string): Promise<void>;
    /**
     * 获取 Tenant Access Token
     */
    getAccessToken(): Promise<string>;
    /**
     * 初始化机器人信息：启动时查询当前机器人自己并写入配置
     * 机器人查询权限只能查询当前应用创建的机器人，所以在启动时预先查询并写入配置
     * 后续 fetchMemberInfoFromApi 只查询普通用户
     */
    private initializeBotInfo;
    private syncTemplateFile;
    /**
     * Start feishu channel in peer-message mode.
     * WS connection is managed by the independent feishu-bridge process;
     * claudetalk only polls peer-message files.
     */
    start(): Promise<void>;
    /**
     * 处理卡片 action callback (card.action.trigger)
     * 必须在 3 秒内返回响应。异步操作起子进程做，不阻塞。
     *
     * Action types:
     *  - toast:       显示 toast 提示
     *  - dismiss:     忽略（显示已忽略toast）
     *  - execute:     子进程执行命令，完成后回复飞书
     */
    private handleCardAction;
    /**
     * 异步执行卡片点击任务：通过 callClaude 处理 → 完成后回复飞书聊天
     */
    private execCardAction;
    /**
     * 异步执行"确认加入手机待办"：调用 archiveConversation 后回复消息
     */
    private execConfirmArchive;
    /**
     * 更新卡片为"已完成"状态（在 mark-task-done callback 后异步调用）
     * 使用 PATCH /im/v1/messages/:message_id 替换卡片内容
     */
    private updateCardToDone;
    private updateCardToCreated;
    /**
     * Stop timers and clean up resources
     */
    stop(): void;
    private sendAndWritePeerMessage;
    sendMessage(conversationId: string, content: string, isGroup: boolean): Promise<void>;
    sendMessageWithId(conversationId: string, content: string, isGroup: boolean): Promise<string>;
    /**
     * 编辑已发送的文本消息（PUT 方法，最多编辑 20 次）
     * API: PUT /open-apis/im/v1/messages/:message_id
     */
    editMessage(conversationId: string, messageId: string, content: string): Promise<void>;
    /**
     * 发送文本消息
     *
     * @param receiverId - 私聊时为用户 open_id，群聊时为 chat_id
     * @param isGroup - 是否群聊，决定 receive_id_type
     */
    sendTextMessage(receiverId: string, content: string, isGroup: boolean): Promise<FeishuSendMessageResponse>;
    /**
     * 发送交互卡片（interactive message）
     * cardBody 是由 buildApprovalCard() 生成的 JSON 字符串
     */
    sendCard(receiverId: string, cardBody: string, isGroup: boolean): Promise<void>;
    /**
     * 以 Markdown 卡片形式发送消息（支持飞书 lark_md 格式）
     * 与 sendCard 不同：此方法自动将 markdown 文本包装为标准卡片结构
     */
    sendMarkdownCard(receiverId: string, markdown: string, isGroup: boolean): Promise<void>;
    /**
     * 给消息添加表情回复
     *
     * @param messageId - 目标消息 ID
     * @param emojiType - 表情类型，如 "Get"（👌）、"OK"（👍）
     */
    private addMessageReaction;
}
export {};
//# sourceMappingURL=index_feishu.d.ts.map