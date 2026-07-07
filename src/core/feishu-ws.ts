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

import * as WebSocket from 'ws'
import { randomUUID } from 'crypto'
import { FeishuApiClient } from '../feishu-shared/index.js'
import { createLogger } from './logger.js'

// ========== Protobuf 相关 ==========

// 从 Lark SDK 导出 protobuf 定义（pbbp2 namespace）
// 在 Lark SDK 1.7.x 中用 protobufjs 编解码
let _pbbp2: any = null
function getProto() {
  if (_pbbp2) return _pbbp2
  try {
    // 复用 Lark SDK 内部的 protobuf 定义
    const lark = require('@larksuiteoapi/node-sdk')
    // 直接暴露 SDK 内部的 WS 原型类型
    _pbbp2 = lark
    return _pbbp2
  } catch {
    throw new Error('@larksuiteoapi/node-sdk is required for feishu-ws')
  }
}

// ========== 飞书 WS 协议常量 ==========

const WS_ENDPOINT = '/callback/ws/endpoint'
const DOMAIN = 'https://open.feishu.cn'
const HEADER_KEY_TYPE = 'type'
const HEADER_KEY_MESSAGE_ID = 'message_id'
const HEADER_KEY_SUM = 'sum'
const HEADER_KEY_SEQ = 'seq'
const HEADER_KEY_TRACE_ID = 'trace_id'
const HEADER_KEY_BIZ_RT = 'biz_rt'
const MESSAGE_TYPE_EVENT = 'event'
const MESSAGE_TYPE_PING = 'ping'
const MESSAGE_TYPE_PONG = 'pong'
const FRAME_CONTROL = 0
const FRAME_DATA = 1

// ========== WS 健康检测 ==========

const DEFAULT_PING_INTERVAL = 120_000  // 2min
const DEFAULT_IDLE_MAX = 300_000       // 5min 无事件就断线重连

// ========== 事件处理器签名 ==========

export type FeishuEventHandler = (eventType: string, data: any, traceId: string) => Promise<void> | void

export interface FeishuWsOptions {
  appId: string
  appSecret: string
  apiClient?: FeishuApiClient
  logger?: (msg: string) => void
  /** 最大空闲时间（没有消息事件），超时触发重连，默认 5min */
  maxIdleMs?: number
  /** 日志标签 */
  label?: string
}

export interface WsConnectionState {
  connected: boolean
  connectedAt: number | null
  disconnectedAt: number | null
  reconnectCount: number
  lastEventAt: number | null
  wsUrl: string
  deviceId: string
  serviceId: string
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
export class FeishuWsClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly domain: string
  private readonly api: FeishuApiClient | null
  private readonly log: (msg: string) => void
  private readonly maxIdleMs: number
  private readonly label: string

  // 事件处理器
  private readonly handlers = new Map<string, FeishuEventHandler[]>()

  // WS 连接
  private ws: WebSocket | null = null
  private connectUrl = ''
  private deviceId = ''
  private serviceId = ''
  private pingIntervalMs = DEFAULT_PING_INTERVAL
  private _pingTimer: NodeJS.Timeout | null = null

  // 分片缓存
  private readonly fragmentCache = new Map<string, { buffer: (Buffer | null)[]; traceId: string; createdAt: number }>()

  // 状态
  private _reconnecting = false
  private _reconnectTimer: NodeJS.Timeout | null = null
  private _closing = false
  private _reconnectCount = 0
  private _lastEventAt = 0
  private _connectedAt: number | null = null
  private _disconnectedAt: number | null = null

  // 空闲检测
  private _idleTimer: NodeJS.Timeout | null = null

  constructor(options: FeishuWsOptions) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.domain = options.apiClient ? '' : DOMAIN
    this.api = options.apiClient || null
    this.maxIdleMs = options.maxIdleMs ?? DEFAULT_IDLE_MAX
    this.label = options.label || 'feishu-ws'
    this.log = options.logger || ((msg: string) => { console.error(`[${this.label}] ${msg}`) })
  }

  /** 注册事件处理器 */
  on(eventType: string, handler: FeishuEventHandler): void {
    const handlers = this.handlers.get(eventType) || []
    handlers.push(handler)
    this.handlers.set(eventType, handlers)
  }

  /** 获取连接状态 */
  getState(): WsConnectionState {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connectedAt: this._connectedAt,
      disconnectedAt: this._disconnectedAt,
      reconnectCount: this._reconnectCount,
      lastEventAt: this._lastEventAt,
      wsUrl: this.connectUrl,
      deviceId: this.deviceId,
      serviceId: this.serviceId,
    }
  }

  /** 启动 WS 连接 */
  async start(): Promise<void> {
    this._closing = false
    await this._doConnect(true)
  }

  /** 关闭 WS 连接 */
  close(): void {
    this._closing = true
    this._clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch { /* ignore */ }
      this.ws = null
    }
    this._connectedAt = null
    this._disconnectedAt = Date.now()
    this.log('WS client closed')
  }

  // ========== 内部逻辑 ==========

  private async _doConnect(isInitial: boolean): Promise<void> {
    if (this._closing) return

    this._clearTimers()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch { /* ignore */ }
      this.ws = null
    }

    try {
      // Step 1: 获取 WS 连接配置
      this.log('Fetching WS endpoint config...')
      const config = await this._fetchWsConfig()
      if (!config) {
        throw new Error('Failed to fetch WS endpoint config')
      }

      this.connectUrl = config.url
      this.deviceId = config.deviceId
      this.serviceId = config.serviceId
      this.pingIntervalMs = config.pingInterval

      // Step 2: 建立 WS 连接
      await this._connect()
      this._reconnectCount = 0

      if (!isInitial) {
        this.log('WS reconnected successfully')
      }
    } catch (err: any) {
      this._reconnectCount++
      this.log(`WS connect failed: ${err.message}, retry #${this._reconnectCount}`)
      this._scheduleReconnect()
    }
  }

  private async _fetchWsConfig(): Promise<{ url: string; deviceId: string; serviceId: string; pingInterval: number } | null> {
    // 调用飞书 WS endpoint API
    // 如果提供了 apiClient，用它的 token；没有就自己做一次 token 请求
    const accessToken = this.api ? await this.api.getAccessToken() : await this._fetchToken()

    const response = await fetch(`${this.domain}${WS_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
      signal: AbortSignal.timeout(15000),
    })

    const data = await response.json() as any
    if (data.code !== 0) {
      this.log(`WS config fetch error: code=${data.code}, msg=${data.msg}`)
      return null
    }

    const url = data.data?.URL as string
    if (!url) {
      this.log('WS config missing URL')
      return null
    }

    const qs = url.split('?')[1] || ''
    const params = new URLSearchParams(qs)
    const deviceId = params.get('device_id') || ''
    const serviceId = params.get('service_id') || ''
    const pingInterval = (data.data?.ClientConfig?.PingInterval || 120) * 1000

    this.log(`WS endpoint: ${url.slice(0, 60)}..., deviceId=${deviceId}, serviceId=${serviceId}, pingInterval=${pingInterval}ms`)
    return { url, deviceId, serviceId, pingInterval }
  }

  private async _fetchToken(): Promise<string> {
    // fallback: 没有 apiClient，自己做 token 请求
    const resp = await fetch(`https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const data = await resp.json() as any
    if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg}`)
    return data.tenant_access_token
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.connectUrl, {
          handshakeTimeout: 10000,
        })
      } catch (err) {
        reject(err)
        return
      }

      const ws = this.ws!
      let settled = false

      ws.on('open', () => {
        this._connectedAt = Date.now()
        this._lastEventAt = Date.now()
        this._startPingLoop()
        this._startIdleMonitor()
        settled = true
        resolve()
      })

      ws.on('message', (buffer: Buffer) => {
        this._onMessage(buffer)
      })

      ws.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })

      ws.on('close', () => {
        this._connectedAt = null
        this._disconnectedAt = Date.now()
        this._clearTimers()
        if (!this._closing && !settled) {
          settled = true
          reject(new Error('WS closed during connect'))
        }
        if (!this._closing) {
          this._scheduleReconnect()
        }
      })
    })
  }

  private _onMessage(buffer: Buffer): void {
    try {
      // 使用 Lark SDK 的 protobuf 解码（pbbp2.Frame.decode）
      const pbbp2 = require('@larksuiteoapi/node-sdk')
      // 内部使用 protobufjs，没有直接暴露 Frame 类型，必须运行时访问
      const mod = require.cache[require.resolve('@larksuiteoapi/node-sdk')]
      // 回退：通过 ws 模块的 protobuf 实例解码
      // 实际上 Lark SDK 的 protobuf 定义是闭包内的，不能直接引用。
      // 我们用另一种方式：直接从 SDK 模块中找 protobuf 实例

      // 在 SDK 1.7.x 中，protobuf Frame 定义在闭包内，无法外部直接访问。
      // 替代方案：写一个独立的 protobuf 定义
      this._decodeAndDispatch(buffer)
    } catch (err) {
      this.log(`Message decode error: ${err}`)
      // 解码失败不计入 idle，尝试重连
      this._scheduleReconnect()
    }
  }

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
  private _decodeAndDispatch(buffer: Buffer): void {
    // 作为临时解决方案，先硬解码协议头
    // Frame 字段顺序：headers(1,repeated) method(2,varint) service(3,varint) payload(4,bytes) SeqID(5,varint) LogID(6,varint)
    // Header 字段顺序：key(1,string) value(2,string)
    //
    // 简化：使用 protobufjs 库动态解析

    try {
      // 尝试使用 Lark SDK 内部的 protobuf 实例
      // 由于 pbbp2 定义在模块闭包内，通过 eval/hack 方式不可靠
      // 改用直接构建独立的 protobufjs Types
      this._decodeFallback(buffer)
    } catch (err) {
      this.log(`Proto decode error: ${err}`)
    }
  }

  // 独立的 protobuf 解析（轻量，只覆盖飞书 WS 用到的部分）
  private _decodeFallback(buffer: Buffer): void {
    // protobuf wire format: field_number << 3 | wire_type
    // wire types: 0=varint, 1=64bit, 2=length-delimited, 5=32bit
    //
    // Frame:
    // field 1 (headers) = wire type 2 (length-delimited, repeated)
    // field 2 (method)  = wire type 0 (varint)
    // field 3 (service) = wire type 0 (varint)
    // field 4 (payload) = wire type 2 (bytes, optional)
    // field 5 (SeqID)   = wire type 0 (varint)
    // field 6 (LogID)   = wire type 0 (varint)
    //
    // Header:
    // field 1 (key)   = wire type 2 (string)
    // field 2 (value) = wire type 2 (string)

    let offset = 0

    const headers: { key: string; value: string }[] = []
    let method = 0
    let service = 0
    let payload: Buffer | null = null
    let seqId = 0
    let logId = 0

    function readVarint(): { value: number; length: number } {
      let value = 0
      let shift = 0
      const start = offset
      while (offset < buffer.length) {
        const byte = buffer[offset++]
        value |= (byte & 0x7f) << shift
        if (!(byte & 0x80)) return { value, length: offset - start }
        shift += 7
        if (shift > 28) throw new Error('Varint overflow')
      }
      throw new Error('Unexpected end of varint')
    }

    function readString(len: number): string {
      const str = buffer.toString('utf-8', offset, offset + len)
      offset += len
      return str
    }

    // 已内联 protobuf 协议在闭包内，不输出中转
    while (offset < buffer.length) {
      const { value: tag } = readVarint()
      const fieldNum = tag >> 3
      const wireType = tag & 0x7

      if (fieldNum === 1) {
        // headers (length-delimited sub-message)
        const { value: len } = readVarint()
        const headerEnd = offset + len
        const header: { key: string; value: string } = { key: '', value: '' }
        while (offset < headerEnd) {
          const { value: htag } = readVarint()
          const hfield = htag >> 3
          const hwire = htag & 0x7
          if (hwire !== 2) { offset = headerEnd; break }
          const { value: hlen } = readVarint()
          const hval = readString(hlen)
          if (hfield === 1) header.key = hval
          else if (hfield === 2) header.value = hval
        }
        headers.push(header)
        if (offset !== headerEnd) offset = headerEnd
      } else if (fieldNum === 2) {
        // method (varint)
        const { value } = readVarint()
        method = value
      } else if (fieldNum === 3) {
        // service (varint)
        const { value } = readVarint()
        service = value
      } else if (fieldNum === 4) {
        // payload (bytes)
        const { value: len } = readVarint()
        payload = buffer.slice(offset, offset + len)
        offset += len
      } else if (fieldNum === 5) {
        // SeqID (varint)
        const { value } = readVarint()
        seqId = value
      } else if (fieldNum === 6) {
        // LogID (varint)
        const { value } = readVarint()
        logId = value
      } else if (wireType === 0) {
        // skip unknown varint
        readVarint()
      } else if (wireType === 2) {
        // skip unknown length-delimited
        const { value: len } = readVarint()
        offset += len
      } else {
        throw new Error(`Unsupported wire type ${wireType} at offset ${offset}`)
      }
    }

    // 协议分析完毕，分发
    void seqId, logId

    const typeHeader = headers.find(h => h.key === HEADER_KEY_TYPE)
    const messageId = headers.find(h => h.key === HEADER_KEY_MESSAGE_ID)?.value || ''
    const sum = parseInt(headers.find(h => h.key === HEADER_KEY_SUM)?.value || '1', 10)
    const seq = parseInt(headers.find(h => h.key === HEADER_KEY_SEQ)?.value || '0', 10)
    const traceId = headers.find(h => h.key === HEADER_KEY_TRACE_ID)?.value || ''

    if (method === FRAME_CONTROL) {
      // Control frame: ping / pong
      if (typeHeader?.value === MESSAGE_TYPE_PING) {
        // 回 pong
        this._sendPong(service)
        return
      }
      if (typeHeader?.value === MESSAGE_TYPE_PONG && payload) {
        // Server pong — contains updated config
        try {
          const pongData = JSON.parse(payload.toString('utf-8'))
          if (pongData.PingInterval) {
            this.pingIntervalMs = pongData.PingInterval * 1000
          }
        } catch { /* ignore */ }
        return
      }
      return
    }

    if (method === FRAME_DATA && typeHeader?.value === MESSAGE_TYPE_EVENT) {
      // 分片合并
      if (!payload) return
      const merged = this._mergeFragments(messageId, sum, seq, payload, traceId)
      if (!merged) return // 分片未收齐

      // 更新最后事件时间
      this._lastEventAt = Date.now()

      // 构造响应 ACK 并发送
      const bizRt = 0 // 同步调用，不做耗时计算
      const ackHeaders = [
        ...headers,
        { key: HEADER_KEY_BIZ_RT, value: String(bizRt) },
      ]
      // 发送 ACK（200 OK）
      this._sendAck(ackHeaders, service, seqId, logId)

      // 分发事件给处理器
      const event = merged.data || merged
      const eventType = merged.type || event.header?.event_type || event.event?.type || 'unknown'
      this._dispatchEvent(eventType, event, traceId)
    }
  }

  /** 分片合并缓存 */
  private _mergeFragments(
    messageId: string,
    sum: number,
    seq: number,
    data: Buffer,
    traceId: string,
  ): { type?: string; data?: any } | null {
    const cacheKey = messageId || `no-id-${traceId}`
    const timeoutMs = 10000

    const entry = this.fragmentCache.get(cacheKey)
    if (!entry) {
      if (sum <= 1) {
        // 单分片，无需合并
        try {
          return JSON.parse(data.toString('utf-8'))
        } catch { return null }
      }
      const buffer: (Buffer | null)[] = new Array(sum).fill(null)
      buffer[seq] = data
      this.fragmentCache.set(cacheKey, { buffer, traceId, createdAt: Date.now() })
      return null
    }

    entry.buffer[seq] = data
    // 检查是否收齐
    if (entry.buffer.some(b => b === null)) return null

    // 合并所有分片
    const merged = Buffer.concat(entry.buffer as Buffer[])
    this.fragmentCache.delete(cacheKey)
    try {
      return JSON.parse(merged.toString('utf-8'))
    } catch { return null }
  }

  /** 发送 ACK */
  private _sendAck(headers: { key: string; value: string }[], service: number, seqId: number, logId: number): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const respHeaders = headers.filter(h => h.key !== HEADER_KEY_BIZ_RT)
    respHeaders.push({
      key: HEADER_KEY_BIZ_RT,
      value: '0',
    })

    // 构造响应
    const payload = JSON.stringify({ code: 0 })

    // 编码为 protobuf
    const frame = this._encodeFrame(respHeaders, FRAME_DATA, service, Buffer.from(payload, 'utf-8'), seqId, logId)
    ws.send(frame, (err) => {
      if (err) this.log(`ACK send error: ${err.message}`)
    })
  }

  /** Protobuf 编码 */
  private _encodeFrame(
    headers: { key: string; value: string }[],
    method: number,
    service: number,
    payload: Buffer,
    seqId: number,
    logId: number,
  ): Buffer {
    const parts: Buffer[] = []

    function varint(value: number): Buffer {
      const bytes: number[] = []
      while (value >= 0x80) {
        bytes.push((value & 0x7f) | 0x80)
        value >>>= 7
      }
      bytes.push(value & 0x7f)
      return Buffer.from(bytes)
    }

    function tag(fieldNum: number, wireType: number): Buffer {
      return varint((fieldNum << 3) | wireType)
    }

    // headers (repeated field 1, wire type 2)
    for (const h of headers) {
      // sub-message: key field 1 + value field 2
      const keyBytes = Buffer.from(h.key, 'utf-8')
      const valBytes = Buffer.from(h.value, 'utf-8')
      const subLen = tag(1, 2).length + varint(keyBytes.length).length + keyBytes.length +
                     tag(2, 2).length + varint(valBytes.length).length + valBytes.length
      parts.push(tag(1, 2))
      parts.push(varint(subLen))
      parts.push(tag(1, 2))
      parts.push(varint(keyBytes.length))
      parts.push(keyBytes)
      parts.push(tag(2, 2))
      parts.push(varint(valBytes.length))
      parts.push(valBytes)
    }

    // method (field 2, varint)
    parts.push(tag(2, 0))
    parts.push(varint(method))

    // service (field 3, varint)
    parts.push(tag(3, 0))
    parts.push(varint(service))

    // payload (field 4, bytes)
    if (payload && payload.length > 0) {
      parts.push(tag(4, 2))
      parts.push(varint(payload.length))
      parts.push(payload)
    }

    // SeqID (field 5, varint)
    parts.push(tag(5, 0))
    parts.push(varint(seqId))

    // LogID (field 6, varint)
    parts.push(tag(6, 0))
    parts.push(varint(logId))

    return Buffer.concat(parts)
  }

  /** 发送 Pong 控制帧 */
  private _sendPong(service: number): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const frame = this._encodeFrame(
      [{ key: HEADER_KEY_TYPE, value: MESSAGE_TYPE_PONG }],
      FRAME_CONTROL,
      service,
      Buffer.alloc(0),
      0,
      0,
    )
    ws.send(frame, (err) => {
      if (err) this.log(`Pong send error: ${err.message}`)
    })
  }

  /** Ping 循环 */
  private _startPingLoop(): void {
    this._clearPingTimer()
    this._pingTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      const frame = this._encodeFrame(
        [{ key: HEADER_KEY_TYPE, value: MESSAGE_TYPE_PING }],
        FRAME_CONTROL,
        parseInt(this.serviceId, 10) || 0,
        Buffer.alloc(0),
        0,
        0,
      )
      ws.send(frame, (err) => {
        if (err) this.log(`Ping send error: ${err.message}`)
      })
    }, this.pingIntervalMs).unref()
  }

  /** 空闲检测：超过 maxIdleMs 没有事件，主动重连 */
  private _startIdleMonitor(): void {
    this._clearIdleTimer()
    // 首次存活检测：建立连接后至少要等 maxIdleMs 才开始检查
    this._idleTimer = setInterval(() => {
      if (this._closing) return
      const idleMs = Date.now() - this._lastEventAt
      if (idleMs > this.maxIdleMs && this._lastEventAt > 0) {
        this.log(`No events for ${Math.round(idleMs / 1000)}s (> ${this.maxIdleMs / 1000}s), reconnecting...`)
        // 触发重连
        this._connectedAt = null
        this._disconnectedAt = Date.now()
        this._clearTimers()
        if (this.ws) {
          try { this.ws.terminate() } catch { /* ignore */ }
          this.ws = null
        }
        this._scheduleReconnect()
      }
    }, 30000).unref() // 每 30s 检查一次
  }

  /** 分发事件给注册的处理器 */
  private async _dispatchEvent(eventType: string, data: any, traceId: string): Promise<void> {
    const handlers = this.handlers.get(eventType) || []
    // 同时也要触发通配符 handler（如果 eventType 不匹配，尝试匹配完整路径）
    const allHandlers = this.handlers.get('*') || []

    // 有些事件的 event_type 在 data 内部
    const innerEventType = data?.header?.event_type || data?.event?.type || ''

    for (const handler of [...handlers, ...allHandlers]) {
      try {
        await handler(eventType, data, traceId)
      } catch (err: any) {
        this.log(`Handler error for ${eventType}: ${err.message}. Reconnecting WS...`)
        // 任何 handler 异常都触发重连
        this._scheduleReconnect()
      }
    }
  }

  /** 调度重连 */
  private _scheduleReconnect(): void {
    if (this._closing) return
    if (this._reconnecting) return
    this._reconnecting = true

    const delay = this._calcBackoff()
    this.log(`Reconnecting in ${Math.round(delay / 100) * 100}ms...`)

    this._reconnectTimer = setTimeout(() => {
      this._reconnecting = false
      this._doConnect(false).catch((err) => {
        this.log(`Reconnect failed: ${err.message}`)
      })
    }, delay)
  }

  private _calcBackoff(): number {
    // 指数退避: 1s, 2s, 4s, 8s, ... up to 60s
    const base = Math.min(Math.pow(2, this._reconnectCount) * 1000, 60000)
    // 加随机抖动 ±20%
    return Math.round(base * (0.8 + Math.random() * 0.4))
  }

  private _clearTimers(): void {
    this._clearPingTimer()
    this._clearIdleTimer()
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  private _clearPingTimer(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
  }

  private _clearIdleTimer(): void {
    if (this._idleTimer) {
      clearInterval(this._idleTimer)
      this._idleTimer = null
    }
  }

  /** 清除分片缓存中的过期条目 */
  startFragmentCleanup(): void {
    setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.fragmentCache) {
        if (now - entry.createdAt > 15000) this.fragmentCache.delete(key)
      }
    }, 10000).unref()
  }
}
