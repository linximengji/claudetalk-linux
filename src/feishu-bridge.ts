/**
 * feishu-bridge — 飞书事件接收器独立进程
 *
 * 职责：保持飞书 WebSocket 长连接，接收 im.message.receive_v1 和 card.action.trigger
 * - 系统级指令(/restart, /daemon restart, 服务启停) → 写 marker 文件 / exec 处理
 * - 非系统消息/卡片 → peer-message 转发给 claudetalk
 *
 * Port 9878 — health check endpoint
 * 由 ops-daemon 管理生命周期，独立于 claudetalk 进程。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import { exec } from 'child_process'
import { request as httpRequest } from 'http'
import { randomUUID } from 'crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { PeerMessage } from './types.js'
import { initLogFile } from './core/logger.js'
import { FeishuApiClient, FEISHU_API_BASE, loadFeishuConfig, parseFeishuMessage, SUPPORTED_MSG_TYPES } from './feishu-shared/index.js'
import type { ParsedMessage } from './feishu-shared/index.js'
import { ChatMemberStore, ChatMemberResolver, resolveAtId } from './channels/feishu/chat-members.js'
import { isCloudflaredAlive, getCloudflaredPath, killProcessOnPort } from './core/proc.js'

process.title = 'feishu-bridge'
import {
  appendPeerMessage,
  loadPeerMessages,
  removePeerMessages,
} from './channels/feishu/peer-message.js'
import { OPS_DAEMON_DIR } from './core/paths.js'

// ========== Constants ==========

const BRIDGE_PORT = parseInt(process.env.FEISHU_BRIDGE_PORT || '9878', 10)
const OPS_DATA_DIR = path.join(OPS_DAEMON_DIR, 'data')
const WORK_DIR = process.env.FEISHU_BRIDGE_WORK_DIR || '/home/ubuntu/projects'
const CLAUDETALK_DIR = path.join(WORK_DIR, '.claudetalk')

// Service keyword → docker compose service name
const SERVICE_KEYWORDS: Record<string, string> = {
  jaeger: 'jaeger', 追踪: 'jaeger', trace: 'jaeger',
  pact: 'pact-broker', 合约: 'pact-broker',
  面板: 'dashboard', dashboard: 'dashboard',
}

// ========== Remote command in-flight guard ==========

let _remoteBusy = false

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

// ========== Config Loading ==========

interface BridgeConfig {
  appId: string
  appSecret: string
  defaultReceiveId: string
  defaultReceiveIdType: string
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

// ── System Command Handlers ─────────────────────────────────────────────

function handleSystemCommand(command: string, conversationId: string, api?: FeishuApiClient): boolean {
  const lower = command.toLowerCase()
  const receiveIdType = conversationId.startsWith('ou_') ? 'open_id' : 'chat_id'

  // /restart → kill + respawn claudetalk (self-destruct via marker)
  if (lower === '/restart' || lower === '重启') {
    // Write marker so the environment's supervisor restarts claudetalk
    const markerPath = path.join(OPS_DATA_DIR, '.restart-claudetalk')
    fs.writeFileSync(markerPath, '')
    console.error(`[feishu-bridge] /restart: wrote marker at ${markerPath}, pid=${process.pid}`)
    return true
  }

  // /daemon restart → kill + respawn ops-daemon (self-destruct via marker)
  if (lower === '/daemon restart' || lower === '重启daemon') {
    const markerPath = path.join(OPS_DATA_DIR, '.restart-daemon')
    fs.writeFileSync(markerPath, '')
    console.error(`[feishu-bridge] /daemon restart: wrote marker at ${markerPath}, pid=${process.pid}`)
    return true
  }

  // Service start/stop via docker compose
  for (const [keyword, svcName] of Object.entries(SERVICE_KEYWORDS)) {
    if (lower.includes('打开' + keyword) || lower.includes('开启' + keyword)) {
      console.error(`[feishu-bridge] docker start ${svcName}: keyword=${keyword}`)
      _dockerStart(svcName).then(ok => {
        console.error(`[feishu-bridge] docker start ${svcName} result: ${ok}`)
        if (api) {
          api.sendText(conversationId, ok ? `✅ ${svcName} 已启动` : `❌ 启动 ${svcName} 失败`, receiveIdType).catch(() => {})
        }
      })
      return true
    }
    if (lower.includes('关闭' + keyword)) {
      console.error(`[feishu-bridge] docker stop ${svcName}: keyword=${keyword}`)
      _dockerStop(svcName).then(ok => {
        console.error(`[feishu-bridge] docker stop ${svcName} result: ${ok}`)
        if (api) {
          api.sendText(conversationId, ok ? `✅ ${svcName} 已关闭` : `❌ 关闭 ${svcName} 失败`, receiveIdType).catch(() => {})
        }
      })
      return true
    }
  }

  // 开启远程 → kill stale cloudflared + start cloudflared tunnel + start dashboard
  if (lower.includes('开启远程') || lower.includes('打开远程')) {
    if (_remoteBusy) {
      console.error(`[feishu-bridge] 开启远程: denied by _remoteBusy flag`)
      if (api) api.sendText(conversationId, '⏳ 上一个远程操作还在执行中，请稍候...', receiveIdType).catch(() => {})
      return true
    }
    _remoteBusy = true
    console.error(`[feishu-bridge] 开启远程: START, pid=${process.pid}`)
    if (api) api.sendText(conversationId, '⏳ 远程服务正在启动...', receiveIdType).catch(() => {})

    // Kill stale cloudflared first, then restart both tunnel and dashboard
    exec('pkill -f cloudflared 2>/dev/null; sleep 2', { timeout: 10000 }, (err) => {
      console.error(`[feishu-bridge] 开启远程: pkill done, err=${err}`)
      pythonExec('ops_daemon.tunnel_manager', ['start'], { timeout: 60000 })
        .then(() => {
          console.error(`[feishu-bridge] 开启远程: tunnel_manager start done, waiting for health...`)
          // Wait for tunnel + dashboard health
          return Promise.all([
            waitForTunnelHealth(60000),
            waitForHttpHealth(8765, 60000),
          ])
        })
        .then(([tunOk, dashOk]) => {
          _remoteBusy = false
          console.error(`[feishu-bridge] 开启远程: tunOk=${tunOk} dashOk=${dashOk}`)
          if (tunOk && dashOk) {
            if (api) api.sendText(conversationId, '✅ 远程服务已就绪\nDashboard: :8765\nTunnel: 已连接\n访问: https://term.linximengji.com', receiveIdType).catch(() => {})
          } else {
            const parts: string[] = []
            if (!tunOk) parts.push('Tunnel')
            if (!dashOk) parts.push('Dashboard')
            if (api) api.sendText(conversationId, `❌ ${parts.join('、')} 启动超时，请稍后重试`, receiveIdType).catch(() => {})
          }
        })
        .catch(e => {
          _remoteBusy = false
          console.error(`[feishu-bridge] 开启远程: tunnel_manager start FAILED: ${e.message?.slice(0, 200) || e}`)
          if (api) api.sendText(conversationId, `❌ 远程启动失败: ${e.message?.slice(0, 100) || e}`, receiveIdType).catch(() => {})
        })
    })
    return true
  }

  // 关闭远程 → kill cloudflared + stop dashboard
  if (lower.includes('关闭远程')) {
    if (_remoteBusy) {
      console.error(`[feishu-bridge] 关闭远程: denied by _remoteBusy flag`)
      if (api) api.sendText(conversationId, '⏳ 上一个远程操作还在执行中，请稍候...', receiveIdType).catch(() => {})
      return true
    }
    _remoteBusy = true
    console.error(`[feishu-bridge] 关闭远程: START, pid=${process.pid}`)
    if (api) api.sendText(conversationId, '⏳ 正在关闭远程服务...', receiveIdType).catch(() => {})

    pythonExec('ops_daemon.tunnel_manager', ['stop'], { timeout: 60000 })
      .then((result) => {
        console.error(`[feishu-bridge] 关闭远程: tunnel_manager stop done, waiting for services down...`)
        return Promise.all([
          httpPortGone(8765, 25000),
          waitForTunnelGone(15000),
        ])
      })
      .then(([dashGone, tunGone]) => {
        _remoteBusy = false
        console.error(`[feishu-bridge] 关闭远程: dashGone=${dashGone} tunGone=${tunGone}`)
        if (dashGone && tunGone) {
          if (api) api.sendText(conversationId, '✅ 远程服务已关闭\nDashboard: 已停\nTunnel: 已断开', receiveIdType).catch(() => {})
        } else {
          const parts: string[] = []
          if (!dashGone) parts.push('Dashboard(8765)')
          if (!tunGone) parts.push('cloudflared')
          if (api) api.sendText(conversationId, `❌ ${parts.join('、')} 关闭超时，请在电脑上手动关闭`, receiveIdType).catch(() => {})
        }
      })
      .catch(e => {
        _remoteBusy = false
        console.error(`[feishu-bridge] 关闭远程: tunnel_manager stop FAILED: ${e.message?.slice(0, 200) || e}`)
        if (api) api.sendText(conversationId, `❌ 远程关闭失败: ${e.message?.slice(0, 100) || e}`, receiveIdType).catch(() => {})
      })
    return true
  }

  return false
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

/** Check if an execute prompt is system-level (restart/daemon/service related).
 *
 * 覆盖 handleSystemCommand 中所有精确触发词，但不会误吞普通对话。
 * 规则：必须同时包含动作词（打开/关闭/重启）和目标词（远程/jaeger/pact/面板/dashboard/daemon）。
 * 单"重启"、"代理"等无其他动作限定的词容易误判，这里只匹配长句或特定短词。
 */
function isSystemExecute(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  // 精确短句匹配
  if (lower === '/restart' || lower === '重启' || lower === '/daemon restart' || lower === '重启daemon') return true

  // 组合模式：动作 + 目标
  const actions = ['打开', '开启', '关闭']
  const targets = ['远程', 'jaeger', '追踪', 'trace', 'pact', '合约', '面板', 'dashboard']

  for (const action of actions) {
    if (!lower.includes(action)) continue
    for (const target of targets) {
      if (lower.includes(target)) return true
    }
  }
  // 服务关键词（SERVICE_KEYWORDS 中的 key）开头也可触发
  // "面板"、"jaeger"、"pact"、"dashboard" 作为目标已覆盖，不再额外匹配
  return false
}

// ========== Card Action Handler ==========

// In-memory pending approvals (mirror from claudetalk's approval-handler.ts)
const pendingApprovals = new Map<string, (approved: boolean) => void>()
const processedApprovals = new Set<string>()

interface CardActionContext {
  action: Record<string, unknown> | undefined
  value: Record<string, unknown>
  actionType: string
  messageId: string
  chatId: string
  botAppName: string
}

function handleCardAction(ctx: CardActionContext, api: FeishuApiClient): { toast: { type: string; content: string } } {
  const { value, actionType, messageId, chatId } = ctx

  switch (actionType) {
    case 'toast':
      return { toast: { type: 'info', content: (value?.message as string) || '已收到' } }

    case 'dismiss':
      return { toast: { type: 'info', content: '已忽略' } }

    case 'execute': {
      const prompt = (value?.prompt as string) || ''
      if (!prompt) return { toast: { type: 'error', content: 'execute 需要 prompt 参数' } }

      if (isSystemExecute(prompt)) {
        // System-level execute — run locally
        handleSystemCommand(prompt, chatId, api)
        return { toast: { type: 'info', content: '正在执行系统操作...' } }
      }

      // Non-system execute — forward to claudetalk via peer-message
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

      // Async update card
      if (messageId) {
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '✅ 任务已完成' }, template: 'green' },
          elements: [
            { tag: 'markdown', content: `**${(value?.task_summary as string) || taskId}**` },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '已完成' }] },
          ],
        }
        api.updateCard(messageId, card).catch(() => {})
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
          status: 'pending',
          summary,
          type: value?.type || 'task',
          source: 'claudetalk',
          priority: value?.priority || 'medium',
          created_at: new Date().toISOString(),
        }
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
      } catch { /* best-effort */ }

      if (messageId) {
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '📌 待办已创建' }, template: 'blue' },
          elements: [
            { tag: 'markdown', content: `**${summary}**` },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '已创建' }] },
          ],
        }
        api.updateCard(messageId, card).catch(() => {})
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
      // 审批由 claudetalk 注册，bridge 侧 map 通常为空。
      // 转发给 claudetalk（通过 peer-message），由 claudetalk 的 handleApprovalCallback 处理。
      if (requestId) {
        const appTraceId = randomUUID().slice(0, 8)
        const peerMsg: PeerMessage = {
          id: randomUUID(),
          from: 'feishu-bridge',
          chatId: ctx.chatId,
          messageId: ctx.messageId,
          message: JSON.stringify({ __approval_callback__: true, requestId, decision: value?.decision }),
          createdAt: Date.now(),
          traceId: appTraceId,
          isGroup: ctx.chatId.startsWith('oc_'),
        }
        appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
        console.error(`[feishu-bridge] [trace=${appTraceId}] forwarded approval-action to claudetalk: requestId=${requestId}`)
      }
      return { toast: { type: 'silent', content: '' } }
    }

    case 'confirm-archive': {
      // Forward to claudetalk — needs _lastConvGetter which lives in claudetalk
      const archTraceId = randomUUID().slice(0, 8)
      const peerMsg: PeerMessage = {
        id: randomUUID(),
        from: 'feishu-bridge',
        chatId,
        messageId,
        message: '__confirm_archive__',
        createdAt: Date.now(),
        traceId: archTraceId,
        isGroup: chatId.startsWith('oc_'),
      }
      appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
      console.error(`[feishu-bridge] [trace=${archTraceId}] forwarded confirm-archive to claudetalk: chatId=${chatId}`)
      return { toast: { type: 'info', content: '正在加入手机待办...' } }
    }

    default:
      return { toast: { type: 'error', content: `未知操作: ${actionType}` } }
  }
}

// ========== ACK 追踪 ==========

/** 已确认处理的 peer-message ID 集合（内存，重启丢失） */
const ackedPeerIds = new Set<string>()

const ACK_LOG_INTERVAL = 5 * 60 * 1000 // 5min
setInterval(() => {
  if (ackedPeerIds.size > 0) {
    console.error(`[feishu-bridge] ACK-ed ${ackedPeerIds.size} peer messages total since startup`)
  }
}, ACK_LOG_INTERVAL)

// ========== HTTP Server ==========

function createHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'feishu-bridge' }))
      return
    }

    // Graceful shutdown endpoint — daemon calls this before spawning new bridge
    if (url.pathname === '/quit' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', message: 'shutting down' }))
      process.nextTick(() => { process.exit(0) })
      return
    }

    // ACK endpoint — claudetalk 处理后通知 bridge
    if (url.pathname === '/ack' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data.peerId) {
            ackedPeerIds.add(data.peerId)
            const traceTag = data.traceId ? `trace=${data.traceId} ` : ''
            console.error(`[feishu-bridge] ACK received: peerId=${data.peerId} ${traceTag}status=${data.status || 'ok'}`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
        }
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })
  return server
}

// ========== Message Parsing ==========

async function parseBridgeMessage(
  messageType: string,
  rawContent: string,
  messageId: string,
  api: FeishuApiClient,
): Promise<ParsedMessage> {
  const accessToken = messageType !== 'text' ? await api.getAccessToken() : ''
  return parseFeishuMessage(messageType, rawContent, messageId, FEISHU_API_BASE, WORK_DIR, accessToken)
}

// ========== Main ==========

async function main() {
  const cfg = loadFeishuConfig(WORK_DIR)
  if (!cfg) {
    console.error('[feishu-bridge] No feishu config found, exiting')
    process.exit(1)
  }

  initLogFile(WORK_DIR)
  console.error(`[feishu-bridge] Starting on port ${BRIDGE_PORT}...`)

  const api = new FeishuApiClient(cfg.appId, cfg.appSecret)

  // Health check server
  const server = createHealthServer()
  server.listen(BRIDGE_PORT, () => {
    console.error(`[feishu-bridge] Health endpoint: http://localhost:${BRIDGE_PORT}/health`)
  })

  // Fetch bot info (for botAppName + botOpenId, used in peer-message and self-message filter)
  let botAppName = 'claudetalk'
  let botOpenId = ''
  try {
    const botInfo = await api.getAccessToken().then(async (token) => {
      const resp = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return resp.json() as any
    })
    if (botInfo.code === 0 && botInfo.bot) {
      botAppName = botInfo.bot.app_name || 'claudetalk'
      botOpenId = botInfo.bot.open_id || ''
      console.error(`[feishu-bridge] Bot app name: ${botAppName}, open_id: ${botOpenId}`)
    }
  } catch { /* non-blocking */ }

  // Retry bot info every 60s if failed
  const retryBotInfo = setInterval(async () => {
    try {
      const token = await api.getAccessToken()
      const resp = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await resp.json() as any
      if (data.code === 0 && data.bot) {
        botAppName = data.bot.app_name || 'claudetalk'
        botOpenId = data.bot.open_id || ''
        clearInterval(retryBotInfo)
        console.error(`[feishu-bridge] Bot app name (retry): ${botAppName}, open_id: ${botOpenId}`)
      }
    } catch { /* silent */ }
  }, 60000)

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

  // Event dedup
  const processedEventIds = new Map<string, number>()
  const DEDUP_TTL = 24 * 60 * 60 * 1000
  setInterval(() => {
    const now = Date.now()
    for (const [id, ts] of processedEventIds) {
      if (now - ts > DEDUP_TTL) processedEventIds.delete(id)
    }
  }, 3600_000)

  // Pending images cache for multi-image messages
  const pendingImages = new Map<string, string[]>()

  // Chat member store (for group message context — optional, best-effort)
  const chatMembersPath = path.join(CLAUDETALK_DIR, 'feishu', 'chat-members.json')
  const chatMemberStore = new ChatMemberStore(chatMembersPath)

  // EventDispatcher
  const eventDispatcher = new Lark.EventDispatcher({})
  eventDispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      const event = data as any
      const messageId = event.message?.message_id
      const now = Date.now()
      if (messageId && processedEventIds.has(messageId) && now - processedEventIds.get(messageId)! < DEDUP_TTL) return
      if (messageId) processedEventIds.set(messageId, now)

      try {
        const { sender, message } = event
        if (!message || !sender) return

        if (botOpenId && sender.sender_id?.open_id === botOpenId) {
          return
        }

        const isGroup = message.chat_type === 'group'
        const senderId = sender.sender_id?.open_id || ''
        const conversationId = message.chat_id || ''

        const { messageText, imagePaths } = await parseBridgeMessage(
          message.message_type, message.content, message.message_id, api,
        )
        if (!messageText && imagePaths.length === 0) return

        if (isGroup) {
          const mentioned = message.mentions?.some((m: any) => m.id?.open_id)
          if (!mentioned) return
        }

        let stripped = messageText
        if (isGroup && message.mentions) {
          for (const m of message.mentions) {
            stripped = stripped.replace(`@${m.name}`, '').trim()
          }
          stripped = stripped.replace(/@_user_\d+/g, '').trim()
        }

        if (imagePaths.length > 0 && stripped.trim().length === 0) {
          const key = `${conversationId}:${senderId}`
          pendingImages.set(key, [...(pendingImages.get(key) || []), ...imagePaths])
          api.addReaction(message.message_id, 'Get').catch(() => {})
          return
        }

        const key = `${conversationId}:${senderId}`
        const allPaths = [...(pendingImages.get(key) || []), ...imagePaths]
        if (pendingImages.has(key)) pendingImages.delete(key)
        const truncated = allPaths.slice(0, 3)
        let finalText = stripped
        if (truncated.length > 0) {
          const hints = truncated.map((e: string) => {
            const pipe = e.indexOf('|')
            return pipe !== -1 ? `[文件: ${e.slice(0, pipe)} (${e.slice(pipe + 1)})]` : `[图片: ${e}]`
          }).join('\n')
          finalText = [stripped, hints].filter(Boolean).join('\n')
        }
        if (!finalText.trim()) return

        api.addReaction(message.message_id, 'Get').catch(() => {})

        if (handleSystemCommand(finalText, conversationId, api)) return

        const traceId = randomUUID().slice(0, 8)
        const peerMsg: PeerMessage = {
          id: randomUUID(),
          from: botAppName || 'feishu-bridge',
          chatId: conversationId,
          messageId: message.message_id,
          message: finalText,
          createdAt: Date.now(),
          traceId,
          isGroup,
        }
        appendPeerMessage(CLAUDETALK_DIR, 'claudetalk', peerMsg)
        console.error(`[feishu-bridge] [trace=${traceId}] forwarded to claudetalk: ${finalText.substring(0, 80)}`)
      } catch (err) {
        console.error(`[feishu-bridge] message handler error: ${err}`)
      }
    },

    'card.action.trigger': (data: unknown) => {
      const d = data as Record<string, unknown>
      const action = d.action as Record<string, unknown> | undefined
      const value = (action?.value as Record<string, unknown>) || {}
      const actionType = (value?.action_type as string) || ''
      const context = d.context as Record<string, string> | undefined
      const messageId = context?.open_message_id || ''
      const chatId = context?.open_chat_id || ''

      console.error(`[feishu-bridge] card action: ${actionType} chatId=${chatId}`)

      return handleCardAction({
        action, value, actionType, messageId, chatId, botAppName,
      }, api)
    },

    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
  })

  // WSClient — exponential backoff reconnect
  const wsClient = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: Lark.LoggerLevel.debug,
  })
  let _wsRetryDelay = 15000
  const MAX_WS_RETRY = 300_000
  function startWsClient() {
    wsClient.start({ eventDispatcher }).then(() => {
      _wsRetryDelay = 15000 // reset on success
    }).catch((err) => {
      console.error(`[feishu-bridge] WSClient error: ${err}, retrying in ${_wsRetryDelay}ms`)
      setTimeout(startWsClient, _wsRetryDelay)
      _wsRetryDelay = Math.min(_wsRetryDelay * 2, MAX_WS_RETRY)
    })
  }
  startWsClient()

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error(`[feishu-bridge] Received ${signal}, shutting down...`)
    try { wsClient.close() } catch {}
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.error(`[feishu-bridge] Running on port ${BRIDGE_PORT}, WSClient connected`)
}

main().catch((err) => {
  console.error(`[feishu-bridge] Fatal: ${err}`)
  process.exit(1)
})
