/**
 * feishu-bridge — 飞书事件接收器独立进程
 *
 * 职责：保持飞书 WebSocket 长连接，接收 im.message.receive_v1 和 card.action.trigger
 * - 系统级指令(服务启停/远程开关) → exec 处理
 * - 非系统消息/卡片 → peer-message 转发给 claudetalk
 *
 * Port 9878 — health check endpoint
 * 由 systemd 管理生命周期，独立于 claudetalk 进程。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'
import { exec, spawnSync } from 'child_process'
import { request as httpRequest } from 'http'
import { randomUUID } from 'crypto'
import { createLarkChannel } from '@larksuite/channel'
import type { NormalizedMessage, CardActionEvent, LarkChannel } from '@larksuite/channel'
import { FEISHU_API_BASE, loadFeishuConfig, SUPPORTED_MSG_TYPES, FeishuApiClient } from './feishu-shared/index.js'

// LoggerLevel enum from @larksuiteoapi/node-sdk (re-exported via channel's dependency chain)
// 0=fatal, 1=error, 2=warn, 3=info, 4=debug, 5=trace
const LOG_DEBUG = 4
import type { PeerMessage } from './types.js'
import { initLogFile } from './core/logger.js'
import { ChatMemberStore, ChatMemberResolver, resolveAtId } from './channels/feishu/chat-members.js'
import { isCloudflaredAlive, getCloudflaredPath } from './core/proc.js'

// OpenTelemetry init — exports trace to local Jaeger
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
const _otelSdk = new NodeSDK({
  serviceName: 'feishu-bridge',
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4317/v1/traces' }),
  instrumentations: [new HttpInstrumentation()],
})
_otelSdk.start()

process.title = 'feishu-bridge'

import {
  appendPeerMessage,
} from './channels/feishu/peer-message.js'
import { OPS_DAEMON_DIR } from './core/paths.js'

// ========== Constants ==========

const BRIDGE_PORT = parseInt(process.env.FEISHU_BRIDGE_PORT || '9878', 10)
const WORK_DIR = process.env.FEISHU_BRIDGE_WORK_DIR || '/home/ubuntu/projects'
const CLAUDETALK_DIR = path.join(WORK_DIR, '.claudetalk')

// API poll constants
const API_POLL_INTERVAL_MS = 4_000
const POLL_PAGE_SIZE = 20
const BOT_APP_ID = 'cli_aa838f41f9f8dbe7'
const DEDUP_MAX_PER_CHAT = 200

// Service keyword → docker compose service name
const SERVICE_KEYWORDS: Record<string, string> = {
  jaeger: 'jaeger', 追踪: 'jaeger', trace: 'jaeger',
  pact: 'pact-broker', 合约: 'pact-broker',
  面板: 'dashboard', dashboard: 'dashboard',
}

// ========== Remote command in-flight guard ==========

let _remoteBusy = false

// ========== API Poll State ==========

const _seenMessageIds = new Map<string, Set<string>>()
let _botOpenId: string | null = null

// ========== Health Check Helpers (from index.ts) ==========

const CLOUDFLARED = getCloudflaredPath()

function httpHealthCheck(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function waitForHttpHealth(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      httpHealthCheck(port).then(ok => {
        if (ok) resolve(true)
        else setTimeout(poll, 1000)
      })
    }
    poll()
  })
}

function httpPortGone(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      httpHealthCheck(port).then(ok => {
        if (ok) setTimeout(poll, 500)
        else resolve(true)
      })
    }
    poll()
  })
}

function tunnelHealthCheck(): Promise<boolean> {
  return new Promise(resolve => {
    exec(`"${CLOUDFLARED}" tunnel info remote-terminal`, { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(false); return }
      resolve(stdout.includes('CONNECTOR ID'))
    })
  })
}

function waitForTunnelHealth(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      tunnelHealthCheck().then(ok => {
        if (ok) resolve(true)
        else setTimeout(poll, 1000)
      })
    }
    poll()
  })
}

function cloudflaredProcAlive(): Promise<boolean> {
  return isCloudflaredAlive()
}

function waitForTunnelGone(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      cloudflaredProcAlive().then(ok => {
        if (ok) setTimeout(poll, 500)
        else resolve(true)
      })
    }
    poll()
  })
}

// ── Docker compose helpers ───────────────────────────────────────────────
const COMPOSE_DIR = path.join(OPS_DAEMON_DIR)
const DOCKER_COMPOSE = ['docker', 'compose', '-p', 'ops-daemon']

function _dockerStart(svc: string): Promise<boolean> {
  return new Promise(resolve => {
    exec([...DOCKER_COMPOSE, 'start', svc].join(' '), { cwd: COMPOSE_DIR, timeout: 30000 }, (err) => {
      resolve(!err)
    })
  })
}

function _dockerStop(svc: string): Promise<boolean> {
  return new Promise(resolve => {
    exec([...DOCKER_COMPOSE, 'stop', svc].join(' '), { cwd: COMPOSE_DIR, timeout: 30000 }, (err) => {
      resolve(!err)
    })
  })
}

function pythonExec(module: string, args: string[], opts: { timeout: number; cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cmd = ['python3', '-m', module, ...args]
    exec(cmd.join(' '), { cwd: opts.cwd || OPS_DAEMON_DIR, timeout: opts.timeout }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout, stderr })
    })
  })
}

// ── System Command Handlers ─────────────────────────────────────────────

function handleSystemCommand(command: string, conversationId: string, channel?: LarkChannel): boolean {
  const lower = command.toLowerCase()
  const maybeSend = (text: string) => {
    if (channel) channel.send(conversationId, { text }).catch(() => {})
  }

  if (lower === '/restart' || lower === '重启' || lower === '/daemon restart' || lower === '重启daemon') {
    return true
  }

  for (const [keyword, svcName] of Object.entries(SERVICE_KEYWORDS)) {
    if (lower.includes('打开' + keyword) || lower.includes('开启' + keyword)) {
      _dockerStart(svcName).then(ok => {
        console.error(`[feishu-bridge] docker start ${svcName}: ${ok}`)
        maybeSend(ok ? `✅ ${svcName} 已启动` : `❌ 启动 ${svcName} 失败`)
      })
      return true
    }
    if (lower.includes('关闭' + keyword)) {
      _dockerStop(svcName).then(ok => {
        console.error(`[feishu-bridge] docker stop ${svcName}: ${ok}`)
        maybeSend(ok ? `✅ ${svcName} 已关闭` : `❌ 关闭 ${svcName} 失败`)
      })
      return true
    }
  }

  if (lower.includes('开启远程') || lower.includes('打开远程')) {
    if (_remoteBusy) { maybeSend('⏳ 上一个远程操作还在执行中，请稍候...'); return true }
    _remoteBusy = true
    maybeSend('⏳ 远程服务正在启动...')

    exec('pkill -f cloudflared 2>/dev/null; sleep 2', { timeout: 10000 }, () => {
      pythonExec('ops_daemon.tunnel_manager', ['start'], { timeout: 60000 })
        .then(() => Promise.all([waitForTunnelHealth(60000), waitForHttpHealth(8765, 60000)]))
        .then(([tunOk, dashOk]) => {
          _remoteBusy = false
          if (tunOk && dashOk) {
            maybeSend('✅ 远程服务已就绪\nDashboard: :8765\nTunnel: 已连接\n访问: https://term.linximengji.com')
          } else {
            const parts: string[] = []
            if (!tunOk) parts.push('Tunnel')
            if (!dashOk) parts.push('Dashboard')
            maybeSend(`❌ ${parts.join('、')} 启动超时，请稍后重试`)
          }
        })
        .catch(e => {
          _remoteBusy = false
          maybeSend(`❌ 远程启动失败: ${e.message?.slice(0, 100) || e}`)
        })
    })
    return true
  }

  if (lower.includes('关闭远程')) {
    if (_remoteBusy) { maybeSend('⏳ 上一个远程操作还在执行中，请稍候...'); return true }
    _remoteBusy = true
    maybeSend('⏳ 正在关闭远程服务...')

    pythonExec('ops_daemon.tunnel_manager', ['stop'], { timeout: 60000 })
      .then(() => Promise.all([httpPortGone(8765, 25000), waitForTunnelGone(15000)]))
      .then(([dashGone, tunGone]) => {
        _remoteBusy = false
        if (dashGone && tunGone) {
          maybeSend('✅ 远程服务已关闭\nDashboard: 已停\nTunnel: 已断开')
        } else {
          const parts: string[] = []
          if (!dashGone) parts.push('Dashboard(8765)')
          if (!tunGone) parts.push('cloudflared')
          maybeSend(`❌ ${parts.join('、')} 关闭超时，请在电脑上手动关闭`)
        }
      })
      .catch(e => {
        _remoteBusy = false
        maybeSend(`❌ 远程关闭失败: ${e.message?.slice(0, 100) || e}`)
      })
    return true
  }

  return false
}

/** Check if a card execute prompt is system-level. */
function isSystemExecute(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  if (lower === '/restart' || lower === '重启' || lower === '/daemon restart' || lower === '重启daemon') return true

  const actions = ['打开', '开启', '关闭']
  const targets = ['远程', 'jaeger', '追踪', 'trace', 'pact', '合约', '面板', 'dashboard']

  for (const action of actions) {
    if (!lower.includes(action)) continue
    for (const target of targets) {
      if (lower.includes(target)) return true
    }
  }
  return false
}

// ========== Card Action Handler ==========

const pendingApprovals = new Map<string, (approved: boolean) => void>()
const processedApprovals = new Set<string>()

function handleCardAction(ctx: CardActionEvent, channel: LarkChannel, botAppName: string): Record<string, unknown> {
  const { action, messageId, chatId } = ctx
  const value = (action?.value || {}) as Record<string, unknown>
  const actionType = (value?.action_type as string) || ''
  const maybeSend = (text: string) => { channel.send(chatId, { text }).catch(() => {}) }

  switch (actionType) {
    case 'toast':
      return { toast: { type: 'info', content: (value?.message as string) || '已收到' } }

    case 'dismiss':
      return { toast: { type: 'info', content: '已忽略' } }

    case 'execute': {
      const prompt = (value?.prompt as string) || ''
      if (!prompt) return { toast: { type: 'error', content: 'execute 需要 prompt 参数' } }

      if (isSystemExecute(prompt)) {
        handleSystemCommand(prompt, chatId, channel)
        return { toast: { type: 'info', content: '正在执行系统操作...' } }
      }

      const execTraceId = randomUUID().slice(0, 8)
      const peerMsg: PeerMessage = {
        id: randomUUID(),
        from: 'feishu-bridge',
        chatId,
        messageId,
        message: prompt,
        createdAt: Date.now(),
        traceId: execTraceId,
        isGroup: chatId.startsWith('oc_'),
      }
      appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
      console.error(`[feishu-bridge] [trace=${execTraceId}] forwarded execute to claudetalk: ${prompt.substring(0, 80)}`)
      return { toast: { type: 'info', content: '已转发给 ClaudeTalk 处理' } }
    }

    case 'mark-task-done': {
      const taskId = (value?.task_id as string) || ''
      if (!taskId) return { toast: { type: 'error', content: '缺少 task_id' } }
      try {
        const indexFile = path.join(WORK_DIR, 'tasks', 'index.json')
        if (fs.existsSync(indexFile)) {
          const raw = fs.readFileSync(indexFile, 'utf-8')
          const index = JSON.parse(raw)
          if (index[taskId]) {
            index[taskId].status = 'completed'
            index[taskId].updated_at = new Date().toISOString()
            fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
          }
        }
      } catch { /* best-effort */ }
      if (messageId) {
        channel.updateCard(messageId, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '✅ 任务已完成' }, template: 'green' },
          elements: [
            { tag: 'markdown', content: `**${(value?.task_summary as string) || taskId}**` },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '已完成' }] },
          ],
        }).catch(() => {})
      }
      return { toast: { type: 'info', content: '✅ 已标记完成' } }
    }

    case 'confirm-task-create': {
      const taskId = (value?.task_id as string) || ''
      const summary = (value?.summary as string) || ''
      if (!taskId || !summary) return { toast: { type: 'error', content: '缺少参数' } }
      try {
        const indexFile = path.join(WORK_DIR, 'tasks', 'index.json')
        let index: Record<string, any> = {}
        if (fs.existsSync(indexFile)) {
          index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'))
        }
        index[taskId] = {
          status: 'pending', summary, type: value?.type || 'task',
          source: 'claudetalk', priority: value?.priority || 'medium',
          created_at: new Date().toISOString(),
        }
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
      } catch { /* best-effort */ }
      if (messageId) {
        channel.updateCard(messageId, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '📌 待办已创建' }, template: 'blue' },
          elements: [
            { tag: 'markdown', content: `**${summary}**` },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '已创建' }] },
          ],
        }).catch(() => {})
      }
      return { toast: { type: 'info', content: '✅ 待办已创建' } }
    }

    case 'approval-action': {
      const requestId = (value?.request_id as string) || ''
      const approved = value?.approved === 'true' || value?.approved === true
      const resolve = pendingApprovals.get(requestId)
      if (resolve) {
        pendingApprovals.delete(requestId)
        processedApprovals.add(requestId)
        resolve(approved)
        return { toast: { type: 'info', content: approved ? '✅ 已批准' : '已拒绝' } }
      }
      if (requestId) {
        const appTraceId = randomUUID().slice(0, 8)
        const peerMsg: PeerMessage = {
          id: randomUUID(), from: 'feishu-bridge', chatId, messageId,
          message: JSON.stringify({ __approval_callback__: true, requestId, decision: value?.decision }),
          createdAt: Date.now(), traceId: appTraceId, isGroup: chatId.startsWith('oc_'),
        }
        appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
        console.error(`[feishu-bridge] [trace=${appTraceId}] forwarded approval-action to claudetalk: requestId=${requestId}`)
      }
      return { toast: { type: 'silent', content: '' } }
    }

    case 'confirm-archive': {
      const archTraceId = randomUUID().slice(0, 8)
      const peerMsg: PeerMessage = {
        id: randomUUID(), from: 'feishu-bridge', chatId, messageId,
        message: '__confirm_archive__', createdAt: Date.now(),
        traceId: archTraceId, isGroup: chatId.startsWith('oc_'),
      }
      appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
      console.error(`[feishu-bridge] [trace=${archTraceId}] forwarded confirm-archive to claudetalk: chatId=${chatId}`)
      return { toast: { type: 'info', content: '正在加入手机待办...' } }
    }

    default:
      return { toast: { type: 'error', content: `未知操作: ${actionType}` } }
  }
}

// ========== HTTP Server ==========

function createHealthServer(channel: LarkChannel): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'feishu-bridge' }))
      return
    }

    if (url.pathname === '/quit' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', message: 'shutting down' }))
      process.nextTick(() => { process.exit(0) })
      return
    }

    if (url.pathname === '/ack' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.peerId) {
            const traceTag = data.traceId ? `trace=${data.traceId} ` : ''
            console.error(`[feishu-bridge] ACK: peerId=${data.peerId} ${traceTag}status=${data.status || 'ok'}`)
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (url.pathname === '/send-media' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', async () => {
        try {
          const { filePath, chatId, msgType } = JSON.parse(body)
          if (!filePath || !chatId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'filePath and chatId required' }))
            return
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'file not found' }))
            return
          }
          const ext = path.extname(filePath).toLowerCase()
          const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
          const isImage = msgType === 'image' || (msgType !== 'file' && imageExts.includes(ext))

          if (isImage) {
            const result = await channel.send(chatId, { image: { source: filePath } })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, messageId: result.messageId }))
          } else {
            const result = await channel.send(chatId, { file: { source: filePath, fileName: path.basename(filePath) } })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, messageId: result.messageId }))
          }
        } catch (err: any) {
          console.error(`[feishu-bridge] /send-media error: ${err}`)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message || 'send failed' }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })
  return server
}

// ========== API Polling (primary message reception; WS on('message') kept for logging only) ==========

/** 首次启动时预热：标记启动时间点之前的历史消息为 seen，不写入 peer-message */
async function warmupSeen(api: FeishuApiClient, chatIds: string[]) {
  const startedAtMs = Date.now()
  try {
    const token = await api.getAccessToken()
    for (const chatId of chatIds) {
      const url = `${FEISHU_API_BASE}/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${POLL_PAGE_SIZE}&sort_type=ByCreateTimeDesc`
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await resp.json()
      if (data.code !== 0 || !data.data?.items) continue
      const seen = new Set<string>()
      for (const item of data.data.items) {
        // 只标记启动时间之前的历史消息，启动后到达的消息留给后续 poll 处理
        const createTime = parseInt(item.create_time) || 0
        if (createTime < startedAtMs && item.message_id) seen.add(item.message_id)
      }
      _seenMessageIds.set(chatId, seen)
      console.error(`[feishu-bridge] warmup: marked ${seen.size} messages as seen for ${chatId}`)
    }
  } catch (err: any) {
    console.error(`[feishu-bridge] warmup error: ${err.message}`)
  }
}

function extractMessageText(item: any): string {
  const msgType = item.msg_type as string
  try {
    const body = typeof item.body === 'string' ? JSON.parse(item.body) : (item.body || {})
    const content = typeof body?.content === 'string' ? JSON.parse(body.content) : (body?.content || {})
    if (msgType === 'text') return content?.text || ''
    if (msgType === 'location') {
      const lat = parseFloat(content?.latitude)
      const lng = parseFloat(content?.longitude)
      const name = content?.name || ''
      if (!isNaN(lat) && !isNaN(lng)) {
        return `[位置] ${name} (${lat}, ${lng})`
      }
    }
    if (msgType === 'post') {
      const parts: string[] = []
      const postContent = content?.content
      if (Array.isArray(postContent)) {
        for (const paragraph of postContent) {
          if (Array.isArray(paragraph)) {
            for (const el of paragraph) {
              if (el.tag === 'text' && el.text) parts.push(el.text)
            }
          }
        }
      }
      const title = content?.title
      return title ? [title, ...parts].join('') : parts.join('')
    }
  } catch {}
  return `[${msgType} message]`
}

async function pollMessages(api: FeishuApiClient, claudeTalkDir: string, chatIds: string[], botAppName: string) {
  let token: string
  try {
    token = await api.getAccessToken()
  } catch (err: any) {
    console.error(`[feishu-bridge] poll: getAccessToken error: ${err.message}`)
    return
  }
  let totalNew = 0

  for (const chatId of chatIds) {
    const url = `${FEISHU_API_BASE}/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${POLL_PAGE_SIZE}&sort_type=ByCreateTimeDesc`
    let resp: any = null
    try {
      const httpResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      resp = await httpResp.json()
    } catch (err: any) {
      console.error(`[feishu-bridge] poll: fetch error for ${chatId}: ${err.message}`)
      continue
    }

    if (!resp || resp.code !== 0 || !resp.data?.items) {
      if (resp && resp.code !== 0) {
        console.error(`[feishu-bridge] poll: API error for ${chatId}: code=${resp.code} msg=${resp.msg}`)
      }
      continue
    }

    const items: any[] = resp.data.items
    const nonBotItems = items.filter((i: any) => i.sender?.id !== BOT_APP_ID && !_seenMessageIds.get(chatId)?.has(i.message_id))
    if (nonBotItems.length > 0) {
      console.error(`[feishu-bridge] poll: ${nonBotItems.length} non-bot unseen items in API response, first msgId=${nonBotItems[0].message_id}`)
    }
    let seen = _seenMessageIds.get(chatId)
    if (!seen) {
      seen = new Set<string>()
      _seenMessageIds.set(chatId, seen)
    }

    for (const item of items) {
      const msgId = item.message_id as string
      if (!msgId || seen.has(msgId)) continue

      if (item.sender?.id === BOT_APP_ID) {
        seen.add(msgId)
        continue
      }

      const messageText = extractMessageText(item)
      if (!messageText.trim()) {
        seen.add(msgId)
        continue
      }

      // /twin command: route directly to digital twin ingestion, bypass CC
      // MUST check BEFORE @bot filter — /twin in group chat doesn't need @mention
      if (messageText.trim().startsWith('/twin')) {
        const feedContent = messageText.trim().slice(5).trim()
        if (feedContent) {
          const twinPath = '/home/ubuntu/projects/digital-clone'
          const tmpFile = `/tmp/twin_feed_${Date.now()}.txt`
          let ingestOk = false
          try {
            fs.writeFileSync(tmpFile, feedContent, 'utf-8')
            const r = spawnSync('python3', [
              '-c', [
`import sys; sys.path.insert(0, '${twinPath}')`,
`from twin.ingestion import ingest_text`,
`with open('${tmpFile}', 'r', encoding='utf-8') as f:`,
`  content = f.read()`,
`print(ingest_text('feishu_twin', content))`,
              ].join('\n')
            ], { timeout: 60_000, encoding: 'utf-8', stdio: 'pipe' })
            if (r.error) throw r.error
            if (r.status !== 0) throw new Error(`exit code ${r.status}: ${r.stderr?.substring(0, 200) || 'unknown'}`)
            console.error(`[feishu-bridge] /twin ingested: ${feedContent.substring(0, 80)} | result=${r.stdout?.substring(0, 100)}`)
            ingestOk = true

            // Parse ingestion result for rich feedback
            const stdout = r.stdout?.trim() || ''
            let replyText = '✅ 已摄入'
            try {
              if (stdout === 'already ingested (duplicate)') {
                replyText = '♻️ 已摄入（内容重复，跳过）'
              } else if (stdout.startsWith('{')) {
                const result = JSON.parse(stdout)
                const stored = result.stored ?? 0
                const skipped = result.skipped || ''
                if (skipped === 'noise') {
                  replyText = '⏭️ 内容较浅，未收录'
                } else if (skipped === 'duplicate') {
                  replyText = '♻️ 内容重复，未收录'
                } else if (stored > 0) {
                  const types = result.types || []
                  const tag = types.join('+') || '记忆'
                  const p = result.persona_updated ? ' 画像已更新' : ''
                  replyText = `✅ 已摄入（${tag}${p}）`
                }
              }
            } catch { /* fallback to default */ }

            // If this reply has a root_id, check if it answers a gap card
            const rootId = item.root_id as string | undefined
            if (rootId) {
              const gapStatePath = path.join(os.homedir(), '.claude', 'twin_gap_state.json')
              try {
                if (fs.existsSync(gapStatePath)) {
                  const raw = fs.readFileSync(gapStatePath, 'utf-8')
                  const state = JSON.parse(raw)
                  const gaps = state.gaps || []
                  let matched = false
                  for (const gap of gaps) {
                    if (gap.message_id === rootId && !gap.answered) {
                      gap.answered = true
                      gap.answered_at = new Date().toISOString()
                      matched = true
                    }
                  }
                  if (matched) {
                    fs.writeFileSync(gapStatePath, JSON.stringify(state, null, 2) + '\n', 'utf-8')
                    replyText += ' 🎯缺口已回答'
                    console.error(`[feishu-bridge] /twin gap answered: root_id=${rootId}`)
                  }
                }
              } catch (e2: any) {
                console.error(`[feishu-bridge] /twin gap state update failed: ${e2.message}`)
              }
            }

            // Send success reply — rich feedback so user knows what happened
            const receiptType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id'
            api.sendText(chatId, replyText, receiptType).catch((e2: any) => {
              console.error(`[feishu-bridge] /twin reply failed: ${e2.message}`)
            })
          } catch (e: any) {
            console.error(`[feishu-bridge] /twin ingestion failed: ${e.message}`)
            // Send error reply so user knows something went wrong
            const receiptType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id'
            api.sendText(chatId, '❌ 摄入失败，请稍后再试', receiptType).catch((e2: any) => {
              console.error(`[feishu-bridge] /twin error reply failed: ${e2.message}`)
            })
          } finally {
            try { fs.unlinkSync(tmpFile) } catch {}
          }
        }
        seen.add(msgId)
        continue
      }

      // Group chat: only forward messages that @mention the bot
      // Private chat (has mentions field with bot itself or no mentions at all): forward all
      const hasMentions = item.mentions && Array.isArray(item.mentions) && item.mentions.length > 0
      if (hasMentions && _botOpenId) {
        const botMentioned = item.mentions.some((m: any) => {
          const mid = m.id?.open_id || m.open_id || m.id
          return mid === _botOpenId
        })
        if (!botMentioned) {
          seen.add(msgId)
          continue
        }
      }

      seen.add(msgId)

      const _isGroup = chatId.startsWith('oc_')
      const traceId = randomUUID().slice(0, 8)
      const peerMsg: PeerMessage = {
        id: randomUUID(),
        from: botAppName || 'feishu-bridge',
        chatId,
        messageId: msgId,
        message: messageText,
        createdAt: Date.now(),
        traceId,
        isGroup: _isGroup,
      }
      appendPeerMessage(claudeTalkDir, 'claudetalk', peerMsg)
      totalNew++
      console.error(`[feishu-bridge] poll: new message chatId=${chatId} msgId=${msgId} text=${messageText.substring(0, 80)}`)
    }
  }

  if (totalNew > 0) {
    console.error(`[feishu-bridge] poll: found ${totalNew} new message(s)`)
  }
}

function cleanupDedupStore() {
  for (const [chatId, seen] of _seenMessageIds) {
    if (seen.size > DEDUP_MAX_PER_CHAT) {
      const arr = [...seen]
      const keep = new Set(arr.slice(arr.length - DEDUP_MAX_PER_CHAT / 2))
      _seenMessageIds.set(chatId, keep)
      console.error(`[feishu-bridge] dedup: pruned ${chatId} from ${seen.size} to ${keep.size} entries`)
    }
  }
}

// ========== Main ==========

async function main() {
  // Load feishu config
  const cfg = loadFeishuConfig(WORK_DIR)
  if (!cfg) {
    console.error('[feishu-bridge] No feishu config found, exiting')
    process.exit(1)
  }
  const { appId, appSecret } = cfg

  const apiClient = new FeishuApiClient(appId, appSecret)

  initLogFile(WORK_DIR)
  console.error(`[feishu-bridge] Starting on port ${BRIDGE_PORT}...`)

  // Fetch bot info
  let botAppName = 'claudetalk'
  try {
    const tokenResp = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const tokenData = await tokenResp.json() as any
    if (tokenData.code === 0) {
      const botResp = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
      })
      const botInfo = await botResp.json() as any
      if (botInfo.code === 0 && botInfo.bot) {
        botAppName = botInfo.bot.app_name || 'claudetalk'
        _botOpenId = botInfo.bot.open_id || null
        console.error(`[feishu-bridge] Bot app name: ${botAppName}, open_id: ${_botOpenId || ''}`)
      }
    }
  } catch { /* non-blocking */ }

  // Create Lark channel (replaces WSClient + EventDispatcher).
  const channel: LarkChannel = createLarkChannel({
    appId,
    appSecret,
    loggerLevel: LOG_DEBUG,
    includeRawEvent: false,
    keepalive: { enabled: true },
    outbound: {
      allowedFileDirs: [WORK_DIR],
    },
  })

  // Start HTTP server (channel available for /send-media uploads)
  const server = createHealthServer(channel)
  server.listen(BRIDGE_PORT, () => {
    console.error(`[feishu-bridge] Health endpoint: http://localhost:${BRIDGE_PORT}/health`)
  })

  // Self-check: if PID file points to a different PID, exit gracefully
  const bridgePidFile = path.join(CLAUDETALK_DIR, 'feishu-bridge.pid')
  setInterval(() => {
    try {
      if (fs.existsSync(bridgePidFile)) {
        const expectedPid = parseInt(fs.readFileSync(bridgePidFile, 'utf-8').trim(), 10)
        if (!isNaN(expectedPid) && expectedPid !== process.pid) {
          console.error(`[feishu-bridge] PID file points to ${expectedPid}, our PID is ${process.pid} — exiting`)
          process.exit(0)
        }
      }
    } catch { /* silent */ }
  }, 30000)

  // Chat member store (for group message context — optional, best-effort)
  const chatMembersPath = path.join(CLAUDETALK_DIR, 'feishu', 'chat-members.json')
  const chatMemberStore = new ChatMemberStore(chatMembersPath)

  // Card action handler
  channel.on('cardAction', (evt: CardActionEvent) => {
    console.error(`[feishu-bridge] card action: type=${(evt.action?.value as any)?.action_type} chatId=${evt.chatId}`)
    return handleCardAction(evt, channel, botAppName)
  })

  channel.on('reconnecting', () => console.error('[feishu-bridge] reconnecting...'))
  channel.on('reconnected', () => console.error('[feishu-bridge] reconnected'))
  channel.on('error', (err) => console.error(`[feishu-bridge] channel error: ${err.code}: ${err.message}`))

  // WS on('message') disabled — message reception handled by API poll.
  // Keep WS alive for card interactions (approval, execute, toast, etc.)
  // To re-enable: restore the handler block and comment out the poll timer below.
  channel.on('message', async (msg: NormalizedMessage) => {
    const { messageId, chatId, chatType, content } = msg
    console.error(`[feishu-bridge] WS message IGNORED (poll handles it): id=${messageId} chatId=${chatId} type=${chatType} text=${content?.substring(0, 60)}`)
  })

  // Connect (liveness now covered by SDK pingTimeout + keepalive.onUnrecoverable)
  await channel.connect()

  // Start API polling for message reception (primary path; WS path disabled)
  const chatIds = ['oc_44ba0d81afa9189a67ef99d0bce1124d']
  // Warmup: mark historical messages as seen so they don't flood peer-message on restart
  await warmupSeen(apiClient, chatIds)
  console.error(`[feishu-bridge] Starting API poll for ${chatIds.length} chat(s) every ${API_POLL_INTERVAL_MS}ms`)
  const _pollTimer = setInterval(() => {
    pollMessages(apiClient, CLAUDETALK_DIR, chatIds, botAppName).catch(err => {
      console.error(`[feishu-bridge] Poll error: ${err.message}`)
    })
  }, API_POLL_INTERVAL_MS)

  const _dedupCleanupTimer = setInterval(() => {
    cleanupDedupStore()
  }, 300_000)

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error(`[feishu-bridge] Received ${signal}, shutting down...`)
    clearInterval(_pollTimer)
    clearInterval(_dedupCleanupTimer)
    _otelSdk.shutdown()
    channel.disconnect().catch(() => {})
    server.close()
    try {
      const ppid = process.ppid
      const myPid = process.pid
      const pcomm = fs.readFileSync(`/proc/${ppid}/comm`, 'utf-8').trim()
      const myComm = fs.readFileSync(`/proc/${myPid}/comm`, 'utf-8').trim()
      console.error(`[feishu-bridge] shutdown context: myPID=${myPid} myComm=${myComm} parentPID=${ppid} parentComm=${pcomm}`)
    } catch { /* non-critical */ }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.error(`[feishu-bridge] Running on port ${BRIDGE_PORT}`)
}

main().catch((err) => {
  console.error(`[feishu-bridge] Fatal: ${err}`)
  process.exit(1)
})
