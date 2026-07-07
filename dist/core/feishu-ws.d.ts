/**
 * 原生飞书 WebSocket 客户端
 *
 * 替换 Lark SDK 的 WSClient，解决 SDK 1.7.0 的"假活"问题：
 * - eventDispatcher.invoke 异常被 SDK 静默吞掉，不重连 WS
 * - 飞书服务端可能因此停止投递消息，但心跳继续
 *
 * 本实现：
 * - 使用飞书 WS endpoint + protobuf 协议
 * - event handler 异常触发 WS 断开重连
 * - 可配置最大空闲检测时间
 *
 * 协议文档参考：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 * 飞书 WS 接入点：POST /callback/ws/endpoint → 返回 { URL: "wss://..." }
 */
import { FeishuApiClient } from '../feishu-shared/index.js';
export type FeishuEventHandler = (eventType: string, data: any, traceId: string) => Promise<void> | void;
export interface FeishuWsOptions {
    appId: string;
    appSecret: string;
    apiClient?: FeishuApiClient;
    logger?: (msg: string) => void;
    /** 最大空闲时间（没有消息事件），超时触发重连，默认 5min */
    maxIdleMs?: number;
    /** 日志标签 */
    label?: string;
}
export interface WsConnectionState {
    connected: boolean;
    connectedAt: number | null;
    disconnectedAt: number | null;
    reconnectCount: number;
    lastEventAt: number | null;
    wsUrl: string;
    deviceId: string;
    serviceId: string;
}
/**
 * 原生飞书 WS 客户端
 *
 * 用法：
 * ```ts
 * const ws = new FeishuWsClient({ appId, appSecret, apiClient })
 * ws.on('im.message.receive_v1', async (data) => { ... })
 * await ws.start()
 * ```
 */
export declare class FeishuWsClient {
    private readonly appId;
    private readonly appSecret;
    private readonly domain;
    private readonly api;
    private readonly log;
    private readonly maxIdleMs;
    private readonly label;
    private readonly handlers;
    private ws;
    private connectUrl;
    private deviceId;
    private serviceId;
    private pingIntervalMs;
    private _pingTimer;
    private readonly fragmentCache;
    private _reconnecting;
    private _reconnectTimer;
    private _closing;
    private _reconnectCount;
    private _lastEventAt;
    private _connectedAt;
    private _disconnectedAt;
    private _idleTimer;
    constructor(options: FeishuWsOptions);
    /** 注册事件处理器 */
    on(eventType: string, handler: FeishuEventHandler): void;
    /** 获取连接状态 */
    getState(): WsConnectionState;
    /** 启动 WS 连接 */
    start(): Promise<void>;
    /** 关闭 WS 连接 */
    close(): void;
    private _doConnect;
    private _fetchWsConfig;
    private _fetchToken;
    private _connect;
    private _onMessage;
    /**
     * 解码并分发 WS 消息
     *
     * Lark SDK 使用 protobuf 协议（pbbp2.Frame），结构：
     *  message Header {
     *    required string key = 1;
     *    required string value = 2;
     *  }
     *  message Frame {
     *    repeated Header headers = 1;
     *    required int32 method = 2;   // 0=control, 1=data
     *    required int32 service = 3;
     *    optional bytes payload = 4;
     *    required int32 SeqID = 5;
     *    required int32 LogID = 6;
     *  }
     *
     * 由于 Lark SDK 的 protobuf 定义在闭包中无法直接导入，
     * 我们手动实现简化版协议解析。
     * 协议是 protobuf 3 wire format。
     */
    private _decodeAndDispatch;
    private _decodeFallback;
    /** 分片合并缓存 */
    private _mergeFragments;
    /** 发送 ACK */
    private _sendAck;
    /** Protobuf 编码 */
    private _encodeFrame;
    /** 发送 Pong 控制帧 */
    private _sendPong;
    /** Ping 循环 */
    private _startPingLoop;
    /** 空闲检测：超过 maxIdleMs 没有事件，主动重连 */
    private _startIdleMonitor;
    /** 分发事件给注册的处理器 */
    private _dispatchEvent;
    /** 调度重连 */
    private _scheduleReconnect;
    private _calcBackoff;
    private _clearTimers;
    private _clearPingTimer;
    private _clearIdleTimer;
    /** 清除分片缓存中的过期条目 */
    startFragmentCleanup(): void;
}
//# sourceMappingURL=feishu-ws.d.ts.map