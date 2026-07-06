/**
 * Claude Code Feishu Channel - Feishu API client
 *
 * Runs in peer-message mode: WS connection managed by the independent feishu-bridge process.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { registerChannel } from '../registry.js';
import { buildOnlineNotification } from '../../utils/index.js';
import { createLogger } from '../../core/logger.js';
import { getPhoneTasksDir } from '../../core/paths.js';
import { callClaude } from '../../core/claude.js';
import { archiveConversation, writeTaskToIndex } from '../../core/phone-archive.js';
import { handleApprovalCallback } from './approval-handler.js';
import { loadPeerMessages, removePeerMessages, } from './peer-message.js';
import { ChatMemberStore, ChatMemberResolver, } from './chat-members.js';
import { FEISHU_API_BASE } from '../../feishu-shared/index.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * 飞书 API 客户端，实现 Channel 接口
 *
 * 接收消息：使用飞书 WebSocket 长连接（需要飞书开放平台开启"使用长连接接收事件"）
 * 发送消息：使用飞书 IM API
 */
export class FeishuClient {
    config;
    tokenCache = null;
    botOpenId = null;
    channelMessageHandler = null;
    claudetalkDir;
    peerPollTimer = null;
    _botInfoRetryTimer = null;
    processedPeerIds = new Map(); // id → processedAt
    botAppName = null;
    _lastConvGetter = null;
    // 群成员管理（委托给独立模块）
    chatMemberStore;
    chatMemberResolver;
    logger;
    constructor(config) {
        this.config = config;
        const workDir = config.workDir || process.cwd();
        this.claudetalkDir = path.join(workDir, '.claudetalk');
        const chatMembersConfigPath = path.join(this.claudetalkDir, 'feishu', 'chat-members.json');
        const profileName = config.profileName || 'default';
        this.logger = createLogger('feishu', profileName);
        this.chatMemberStore = new ChatMemberStore(chatMembersConfigPath);
        this.chatMemberResolver = new ChatMemberResolver(this.chatMemberStore, FEISHU_API_BASE, () => this.getAccessToken(), this.logger);
    }
    /**
     * 启动 peer-messages 轮询
     * 每 5 秒检查一次自己的 bot_{profileName}.json
     * 处理 createdAt + 10秒 <= now 的消息
     */
    startPeerMessagePolling() {
        // botAppName 在 initializeBotInfo 中获取，此时可能还未初始化，延迟到轮询时动态获取
        // profileName 作为备用文件名，防止 botAppName 与 chat-members.json 中的 name 不一致
        this.logger(`Starting peer message polling (botAppName will be resolved at runtime)`);
        this.peerPollTimer = setInterval(() => {
            const botName = this.botAppName;
            const profileName = this.config.profileName;
            if (!botName && !profileName) {
                this.logger('Neither botAppName nor profileName available, skipping peer message poll');
                return;
            }
            // 收集所有需要轮询的文件名（去重）
            const botNamesToCheck = new Set();
            if (botName)
                botNamesToCheck.add(botName);
            if (profileName)
                botNamesToCheck.add(profileName);
            // feishu-bridge 固定写 bot_claudetalk.json
            botNamesToCheck.add('claudetalk');
            for (const nameToCheck of botNamesToCheck) {
                this.processPeerMessages(nameToCheck).catch((error) => {
                    this.logger(`Error processing peer messages for bot_${nameToCheck}.json: ${error}`);
                });
            }
        }, 2000);
    }
    /**
     * 处理 peer-messages
     * 找到 createdAt + 10秒 <= now 的消息，回复表情后走 Claude CLI 流程
     */
    async processPeerMessages(botName) {
        const messages = loadPeerMessages(this.claudetalkDir, botName);
        if (messages.length === 0)
            return;
        const now = Date.now();
        const pendingMessages = messages.filter((msg) => !this.processedPeerIds.has(msg.id));
        // 二次去重：同一飞书 messageId 只处理一次（防 WS 重复投递）
        const seenMsgIds = new Set();
        const dedupedMessages = pendingMessages.filter(msg => {
            if (seenMsgIds.has(msg.messageId))
                return false;
            seenMsgIds.add(msg.messageId);
            return true;
        });
        if (dedupedMessages.length === 0)
            return;
        this.logger(`Processing ${dedupedMessages.length} peer messages for bot_${botName}.json`);
        const succeededIds = [];
        for (const peerMsg of dedupedMessages) {
            this.processedPeerIds.set(peerMsg.id, now);
            // 1. 给原消息回复 Get 表情（收到确认）
            this.addMessageReaction(peerMsg.messageId, 'Get').catch((error) => {
                this.logger(`Failed to add reaction to peer message ${peerMsg.messageId}: ${error}`);
            });
            // 2a. 审批回调：由 feishu-bridge 转发的 approval-action
            if (peerMsg.message.startsWith('{') && peerMsg.message.includes('__approval_callback__')) {
                try {
                    const payload = JSON.parse(peerMsg.message);
                    const result = handleApprovalCallback({
                        request_id: payload.requestId,
                        decision: payload.decision,
                    });
                    this.logger(`Approval callback result: ${JSON.stringify(result)}`);
                    succeededIds.push(peerMsg.id);
                    continue;
                }
                catch (err) {
                    this.logger(`Failed to handle approval callback: ${err}`);
                }
            }
            // 2b. 走 channelMessageHandler 流程（即 Claude CLI 流程）
            if (this.channelMessageHandler) {
                const context = {
                    conversationId: peerMsg.chatId,
                    senderId: peerMsg.from,
                    isGroup: true,
                    userId: peerMsg.from,
                    channelType: 'feishu',
                    processedMessage: undefined,
                };
                try {
                    await this.channelMessageHandler(context, peerMsg.message);
                    this.logger(`Peer message processed: id=${peerMsg.id}, from=${peerMsg.from}`);
                    succeededIds.push(peerMsg.id);
                }
                catch (error) {
                    this.logger(`Failed to process peer message id=${peerMsg.id}: ${error}`);
                }
            }
        }
        // 原子删除成功处理的消息
        if (succeededIds.length > 0) {
            removePeerMessages(this.claudetalkDir, botName, new Set(succeededIds));
        }
        // 清理过期条目（>1h）
        for (const [id, ts] of this.processedPeerIds.entries()) {
            if (now - ts > 60 * 60 * 1000)
                this.processedPeerIds.delete(id);
        }
    }
    /**
     * 注册 Channel 统一消息处理器（实现 Channel 接口）
     */
    onMessage(handler) {
        this.channelMessageHandler = handler;
    }
    /**
     * 注册"最近对话"获取回调（实现 Channel 接口）
     */
    setLastConvGetter(getter) {
        this._lastConvGetter = getter;
    }
    /**
     * 发送上线通知（实现 Channel 接口）
     */
    async sendOnlineNotification(userId, workDir) {
        const notifyText = buildOnlineNotification(workDir);
        try {
            await this.sendMarkdownCard(userId, notifyText, false);
        }
        catch (error) {
            this.logger(`[notify] Failed to send card notification, falling back to text: ${error}`);
            try {
                await this.sendTextMessage(userId, notifyText, false);
            }
            catch (fallbackError) {
                this.logger(`[notify] Fallback text send also failed: ${fallbackError}`);
            }
        }
    }
    /**
     * 获取 Tenant Access Token
     */
    async getAccessToken() {
        if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
            return this.tokenCache.accessToken;
        }
        const response = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                app_id: this.config.appId,
                app_secret: this.config.appSecret,
            }),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            throw new Error(`Failed to get feishu access token: ${data.msg}`);
        }
        // 缓存 token（提前 60 秒过期）
        this.tokenCache = {
            accessToken: data.tenant_access_token,
            expiresAt: Date.now() + (data.expire - 60) * 1000,
        };
        return data.tenant_access_token;
    }
    /**
     * 初始化机器人信息：启动时查询当前机器人自己并写入配置
     * 机器人查询权限只能查询当前应用创建的机器人，所以在启动时预先查询并写入配置
     * 后续 fetchMemberInfoFromApi 只查询普通用户
     */
    async initializeBotInfo() {
        try {
            const accessToken = await this.getAccessToken();
            const response = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = (await response.json());
            if (data.code === 0 && data.bot) {
                const { open_id, app_name } = data.bot;
                this.botOpenId = open_id;
                this.botAppName = app_name; // 保存 app_name，用于读取 peer-message 文件
                // bot.v3/info 接口不返回 app_id，使用当前应用的 app_id
                const appId = this.config.appId;
                this.logger(`Bot info initialized: open_id=${open_id}, app_name=${app_name}, app_id=${appId}`);
                // 将当前机器人信息写入所有群的配置文件（以 name 作为唯一 key）
                const store = this.chatMemberResolver.getStore();
                const config = store.getAll();
                let updated = false;
                // 遍历所有群聊，更新机器人信息
                for (const chatId in config) {
                    store.updateMembers(chatId, (members) => {
                        const existingIndex = members.findIndex(m => m.name === app_name);
                        if (existingIndex >= 0) {
                            const existing = members[existingIndex];
                            if (existing.type !== 'bot' || existing.openId !== open_id || existing.appId !== appId) {
                                existing.type = 'bot';
                                existing.openId = open_id;
                                existing.appId = appId;
                                this.logger(`Updated bot in chat ${chatId}: name=${app_name}, openId=${open_id}, appId=${appId}`);
                            }
                            return members;
                        }
                        members.push({ name: app_name, type: 'bot', openId: open_id, appId });
                        this.logger(`Added bot to chat ${chatId}: name=${app_name}, openId=${open_id}, appId=${appId}`);
                        return members;
                    });
                    updated = true;
                }
                // 如果配置文件为空（首次启动），创建一个默认群聊条目存储机器人信息
                if (Object.keys(config).length === 0) {
                    store.updateMembers('_bot_self', () => [
                        { name: app_name, type: 'bot', openId: open_id, appId },
                    ]);
                    this.logger(`Created default bot entry: name=${app_name}, openId=${open_id}, appId=${appId}`);
                    updated = true;
                }
                void updated; // keep for audit log
            }
            else {
                throw new Error(`Failed to get bot info: ${data.msg}`);
            }
        }
        catch (error) {
            this.logger(`Error initializing bot info: ${error}`);
            throw error;
        }
    }
    syncTemplateFile() {
        const source = path.join(__dirname, '../../template/context-message.template');
        if (!fs.existsSync(source)) {
            this.logger(`Template not found at ${source}`);
            return;
        }
        const home = process.env.HOME || '';
        const destDir = path.join(home, '.claudetalk');
        if (!fs.existsSync(destDir))
            fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, 'context-message.template');
        fs.copyFileSync(source, dest);
        this.logger(`Template synced to ${dest}`);
    }
    /**
     * Start feishu channel in peer-message mode.
     * WS connection is managed by the independent feishu-bridge process;
     * claudetalk only polls peer-message files.
     */
    async start() {
        if (!this.config.appId || !this.config.appSecret) {
            throw new Error('Missing required feishu configuration.\n' +
                'Please set:\n' +
                '  export FEISHU_APP_ID=your_app_id\n' +
                '  export FEISHU_APP_SECRET=your_app_secret');
        }
        this.logger('[feishu] Peer-message mode — WS managed by feishu-bridge');
        // 预同步模板文件到用户目录，后续 buildContextMessage 直接读取
        this.syncTemplateFile();
        // 非阻塞尝试获取机器人信息，用于 @提及过滤和 peer-message 轮询
        this.initializeBotInfo()
            .then(() => this.logger('Bot info initialized'))
            .catch((err) => {
            this.logger(`Bot info init failed (non-blocking), will retry every 60s: ${err}`);
            this._botInfoRetryTimer = setInterval(() => {
                this.initializeBotInfo()
                    .then(() => {
                    if (this._botInfoRetryTimer) {
                        clearInterval(this._botInfoRetryTimer);
                        this._botInfoRetryTimer = null;
                    }
                    this.logger('Bot info init retry succeeded');
                })
                    .catch(() => { });
            }, 60000);
        });
        // 启动 peer-messages 轮询（从 feishu-bridge 接收转发的消息）
        this.startPeerMessagePolling();
    }
    /**
     * 处理卡片 action callback (card.action.trigger)
     * 必须在 3 秒内返回响应。异步操作起子进程做，不阻塞。
     *
     * Action types:
     *  - toast:       显示 toast 提示
     *  - dismiss:     忽略（显示已忽略toast）
     *  - execute:     子进程执行命令，完成后回复飞书
     */
    handleCardAction(data) {
        const action = data.action;
        const value = action?.value || {};
        const actionType = value?.action_type || '';
        const context = data.context;
        const cardToken = data.token || '';
        const messageId = context?.open_message_id || '';
        const chatId = context?.open_chat_id || '';
        this.logger(`Card action: ${actionType} (messageId=${messageId}, actionValue=${JSON.stringify(value)}, rawAction=${JSON.stringify(action)})`);
        switch (actionType) {
            case 'toast':
                return { toast: { type: 'info', content: value?.message || '已收到' } };
            case 'dismiss':
                return { toast: { type: 'info', content: '已忽略' } };
            case 'execute': {
                const prompt = value?.prompt || '';
                if (!prompt)
                    return { toast: { type: 'error', content: 'execute 需要 prompt 参数' } };
                // 异步执行，不阻塞 3s 响应窗口
                this.execCardAction(chatId, prompt).catch((err) => {
                    this.logger(`execCardAction error: ${err}`);
                });
                return { toast: { type: 'info', content: '正在执行...' } };
            }
            case 'confirm-archive': {
                const pair = this._lastConvGetter?.(chatId);
                if (!pair)
                    return { toast: { type: 'warning', content: '没有找到最近对话' } };
                this.execConfirmArchive(chatId, pair).catch((err) => this.logger(`confirm-archive error: ${err}`));
                return { toast: { type: 'info', content: '正在加入手机待办...' } };
            }
            case 'mark-task-done': {
                const taskId = value?.task_id || '';
                if (!taskId)
                    return { toast: { type: 'error', content: '缺少 task_id' } };
                // 同步标记完成（本地文件操作，很快）
                try {
                    const workDir = this.config.workDir || process.cwd();
                    const indexFile = path.join(getPhoneTasksDir(), 'index.json');
                    const raw = fs.readFileSync(indexFile, 'utf-8');
                    const index = JSON.parse(raw);
                    if (index[taskId]) {
                        index[taskId].status = 'completed';
                        index[taskId].updated_at = new Date().toISOString();
                        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8');
                        this.logger(`mark-task-done: ${taskId}`);
                    }
                    else {
                        this.logger(`mark-task-done: task not found: ${taskId}`);
                        return { toast: { type: 'warning', content: '任务未找到' } };
                    }
                }
                catch (err) {
                    this.logger(`mark-task-done error: ${err}`);
                    return { toast: { type: 'error', content: '标记失败' } };
                }
                // 异步更新卡片内容
                if (messageId) {
                    this.updateCardToDone(messageId, taskId, value).catch((err) => {
                        this.logger(`updateCardToDone error: ${err}`);
                    });
                }
                return { toast: { type: 'info', content: '✅ 已标记完成' } };
            }
            case 'confirm-task-create': {
                const taskId = value?.task_id || '';
                const summary = value?.summary || '';
                const taskType = value?.type || 'task';
                const priority = value?.priority || 'medium';
                const progressNotes = value?.progress_notes || '';
                if (!taskId || !summary) {
                    return { toast: { type: 'error', content: '缺少 task_id 或 summary' } };
                }
                // 同步写 index.json（本地文件操作，很快）
                try {
                    writeTaskToIndex({
                        taskId,
                        status: 'pending',
                        summary,
                        type: taskType,
                        source: 'claudetalk',
                        priority,
                        progress: progressNotes || undefined,
                    });
                    this.logger(`confirm-task-create: ${taskId}, summary="${summary.slice(0, 40)}", type=${taskType}, priority=${priority}`);
                }
                catch (err) {
                    this.logger(`confirm-task-create error: ${err}`);
                    return { toast: { type: 'error', content: '创建失败' } };
                }
                // 异步更新卡片内容
                if (messageId) {
                    this.updateCardToCreated(messageId, taskId, summary).catch((err) => {
                        this.logger(`updateCardToCreated error: ${err}`);
                    });
                }
                return { toast: { type: 'info', content: '✅ 待办已创建' } };
            }
            case 'approval-action': {
                return handleApprovalCallback(value);
            }
            default: {
                return { toast: { type: 'error', content: `未知操作: ${actionType}` } };
            }
        }
    }
    /**
     * 异步执行卡片点击任务：通过 callClaude 处理 → 完成后回复飞书聊天
     */
    async execCardAction(chatId, prompt) {
        try {
            this.logger(`execCardAction: chatId=${chatId}, prompt=${prompt.substring(0, 200)}`);
            const workDir = this.config.workDir || process.cwd();
            const isGroup = chatId.startsWith('oc_');
            const result = await callClaude({
                message: prompt,
                conversationId: chatId,
                workDir,
                isGroup,
                profile: this.config.profileName,
                channel: 'feishu',
            });
            const replyText = result.length > 2000 ? result.substring(0, 2000) + '...' : result;
            await this.sendTextMessage(chatId, `✅ 任务执行完成：\n${replyText}`, isGroup);
            this.logger(`execCardAction done, sent reply to ${chatId}`);
        }
        catch (error) {
            this.logger(`execCardAction failed: ${error.message}`);
            try {
                const isGroup = chatId.startsWith('oc_');
                await this.sendTextMessage(chatId, `❌ 执行失败: ${error.message}`, isGroup);
            }
            catch { /* best effort */ }
        }
    }
    /**
     * 异步执行"确认加入手机待办"：调用 archiveConversation 后回复消息
     */
    async execConfirmArchive(chatId, pair) {
        try {
            this.logger(`execConfirmArchive: chatId=${chatId}`);
            const workDir = this.config.workDir || process.cwd();
            const isGroup = chatId.startsWith('oc_');
            const result = await archiveConversation({
                message: pair.message,
                reply: pair.reply,
                toolUseCount: 0,
                toolNames: [],
                workDir,
                isGroup,
            });
            if (result.taskId && result.summary) {
                writeTaskToIndex({
                    taskId: result.taskId,
                    status: result.category === 'task-pending' ? 'pending' : result.category,
                    summary: result.summary,
                    source: 'claudetalk',
                });
            }
            await this.sendTextMessage(chatId, '✅ 已加入手机待办', isGroup);
        }
        catch (error) {
            this.logger(`execConfirmArchive failed: ${error.message}`);
            try {
                await this.sendTextMessage(chatId, `❌ 加入待办失败: ${error.message}`, chatId.startsWith('oc_'));
            }
            catch { /* best effort */ }
        }
    }
    /**
     * 更新卡片为"已完成"状态（在 mark-task-done callback 后异步调用）
     * 使用 PATCH /im/v1/messages/:message_id 替换卡片内容
     */
    async updateCardToDone(messageId, taskId, value) {
        const token = await this.getAccessToken();
        const summary = value?.task_summary || taskId;
        const doneCard = {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: '✅ 任务已完成' },
                template: 'green',
            },
            elements: [
                { tag: 'markdown', content: `**${summary}**` },
                { tag: 'hr' },
                { tag: 'markdown', content: `ID: \`${taskId}\`` },
                { tag: 'note', elements: [{ tag: 'plain_text', content: `已完成于 ${new Date().toLocaleString('zh-CN')}` }] },
            ],
        };
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                msg_type: 'interactive',
                content: JSON.stringify(doneCard),
            }),
        });
        const data = await resp.json();
        if (data.code !== 0) {
            this.logger(`updateCardToDone API error: ${JSON.stringify(data)}`);
        }
    }
    async updateCardToCreated(messageId, taskId, summary) {
        const token = await this.getAccessToken();
        const createdCard = {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: '📌 待办已创建' },
                template: 'blue',
            },
            elements: [
                { tag: 'markdown', content: `**${summary}**` },
                { tag: 'hr' },
                { tag: 'markdown', content: `ID: \`${taskId}\`` },
                { tag: 'note', elements: [{ tag: 'plain_text', content: `创建于 ${new Date().toLocaleString('zh-CN')}` }] },
            ],
        };
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                msg_type: 'interactive',
                content: JSON.stringify(createdCard),
            }),
        });
        const data = await resp.json();
        if (data.code !== 0) {
            this.logger(`updateCardToCreated API error: ${JSON.stringify(data)}`);
        }
    }
    /**
     * Stop timers and clean up resources
     */
    stop() {
        try {
            if (this.peerPollTimer) {
                clearInterval(this.peerPollTimer);
                this.peerPollTimer = null;
            }
        }
        catch { /* 定时器清理失败为 no-op */ }
        try {
            if (this._botInfoRetryTimer) {
                clearInterval(this._botInfoRetryTimer);
                this._botInfoRetryTimer = null;
            }
        }
        catch { /* 定时器清理失败为 no-op */ }
        this.logger('FeishuClient stopped');
    }
    async sendAndWritePeerMessage(conversationId, content, isGroup) {
        if (content === '⏳ 处理中...') {
            this.logger(`[send-处理中-stack] ${new Error().stack?.split('\n').slice(2, 6).join(' | ')}`);
        }
        const response = await this.sendTextMessage(conversationId, content, isGroup);
        const messageId = response.data?.message_id || '';
        return messageId;
    }
    async sendMessage(conversationId, content, isGroup) {
        await this.sendAndWritePeerMessage(conversationId, content, isGroup);
    }
    async sendMessageWithId(conversationId, content, isGroup) {
        return this.sendAndWritePeerMessage(conversationId, content, isGroup);
    }
    /**
     * 编辑已发送的文本消息（PUT 方法，最多编辑 20 次）
     * API: PUT /open-apis/im/v1/messages/:message_id
     */
    async editMessage(conversationId, messageId, content) {
        void conversationId;
        const accessToken = await this.getAccessToken();
        const requestBody = {
            msg_type: 'text',
            content: JSON.stringify({ text: content }),
        };
        this.logger('===== Edit Message =====');
        this.logger(`Message ID: ${messageId}`);
        this.logger(`Content: ${content.substring(0, 500)}`);
        this.logger(`Full Request Body: ${JSON.stringify(requestBody, null, 2)}`);
        const response = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${messageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(requestBody),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            this.logger(`Edit message failed: code=${data.code}, msg=${data.msg}`);
            if (data.code === 230072) {
                throw new Error('EDIT_LIMIT_REACHED');
            }
        }
    }
    /**
     * 发送文本消息
     *
     * @param receiverId - 私聊时为用户 open_id，群聊时为 chat_id
     * @param isGroup - 是否群聊，决定 receive_id_type
     */
    async sendTextMessage(receiverId, content, isGroup) {
        const accessToken = await this.getAccessToken();
        // 根据 receiverId 前缀自动判断 receive_id_type：
        // - ou_ 开头：用户 open_id（上线通知等直接发给用户的场景）
        // - oc_ 开头：群聊 chat_id
        // - 其他（如 p2p 私聊 chat_id）：兜底用 chat_id
        const receiveIdType = receiverId.startsWith('ou_') ? 'open_id' : 'chat_id';
        void isGroup; // isGroup 保留参数兼容性，实际不影响发送类型
        const requestBody = {
            receive_id: receiverId,
            msg_type: 'text',
            content: JSON.stringify({ text: content }),
        };
        // 打印完整的机器人回复消息，便于定位问题
        this.logger('===== Bot Reply Message (Text) =====');
        this.logger(`Receiver ID: ${receiverId}`);
        this.logger(`Receive ID Type: ${receiveIdType}`);
        this.logger('Message Type: text');
        this.logger(`Content: ${content}`);
        this.logger(`Full Request Body: ${JSON.stringify(requestBody, null, 2)}`);
        this.logger('=====================================');
        const response = await fetch(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(requestBody),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            throw new Error(`Failed to send feishu text message: ${data.msg}`);
        }
        return data;
    }
    /**
     * 发送交互卡片（interactive message）
     * cardBody 是由 buildApprovalCard() 生成的 JSON 字符串
     */
    async sendCard(receiverId, cardBody, isGroup) {
        const accessToken = await this.getAccessToken();
        const receiveIdType = receiverId.startsWith('ou_') ? 'open_id' : 'chat_id';
        void isGroup;
        const requestBody = {
            receive_id: receiverId,
            msg_type: 'interactive',
            content: cardBody,
        };
        // 从卡片 body 中提取 requestId 用于诊断追踪
        let cardRequestId = '(unknown)';
        try {
            const parsed = JSON.parse(cardBody);
            const actions = parsed?.elements?.find((e) => e?.tag === 'action');
            const firstBtn = actions?.actions?.[0];
            cardRequestId = firstBtn?.value?.request_id || '(unknown)';
        }
        catch { }
        this.logger(`[sendCard] sending to ${receiverId} (${receiveIdType}) requestId=${cardRequestId}`);
        const response = await fetch(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(requestBody),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            throw new Error(`Failed to send card: ${data.msg}`);
        }
    }
    /**
     * 以 Markdown 卡片形式发送消息（支持飞书 lark_md 格式）
     * 与 sendCard 不同：此方法自动将 markdown 文本包装为标准卡片结构
     */
    async sendMarkdownCard(receiverId, markdown, isGroup) {
        const accessToken = await this.getAccessToken();
        const receiveIdType = receiverId.startsWith('ou_') ? 'open_id' : 'chat_id';
        void isGroup;
        const truncated = markdown.length > 4000 ? markdown.substring(0, 4000) + '\n\n...(截断)' : markdown;
        const cardBody = JSON.stringify({
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: 'ClaudeTalk' },
                template: 'blue',
            },
            elements: [
                { tag: 'markdown', content: truncated },
            ],
        });
        this.logger(`[sendMarkdownCard] sending to ${receiverId} (${receiveIdType}), length=${truncated.length}`);
        const response = await fetch(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                receive_id: receiverId,
                msg_type: 'interactive',
                content: cardBody,
            }),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            throw new Error(`Failed to send markdown card: ${data.msg}`);
        }
    }
    /**
     * 给消息添加表情回复
     *
     * @param messageId - 目标消息 ID
     * @param emojiType - 表情类型，如 "Get"（👌）、"OK"（👍）
     */
    async addMessageReaction(messageId, emojiType) {
        const accessToken = await this.getAccessToken();
        const response = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${messageId}/reactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                reaction_type: {
                    emoji_type: emojiType,
                },
            }),
        });
        const data = (await response.json());
        if (data.code !== 0) {
            throw new Error(`Failed to add reaction to message ${messageId}: ${data.msg}`);
        }
        this.logger(`Added reaction ${emojiType} to message ${messageId}`);
    }
}
// ========== Channel 自注册 ==========
registerChannel({
    type: 'feishu',
    label: '飞书机器人',
    configFields: [
        {
            key: 'FEISHU_APP_ID',
            label: 'FEISHU_APP_ID (App ID)',
            required: true,
            hint: '在飞书开放平台 (https://open.feishu.cn) 创建应用获取',
        },
        {
            key: 'FEISHU_APP_SECRET',
            label: 'FEISHU_APP_SECRET (App Secret)',
            required: true,
            secret: true,
        },
    ],
    create(config) {
        return new FeishuClient({
            appId: config.FEISHU_APP_ID,
            appSecret: config.FEISHU_APP_SECRET,
            profileName: config.profileName,
            systemPrompt: config.systemPrompt,
        });
    },
});
//# sourceMappingURL=index_feishu.js.map