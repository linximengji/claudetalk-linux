/**
 * 飞书审批卡片处理
 * 卡片模板化生成 + 回调处理 + 持久化（进程重启后回调也能正确响应）
 */

import { log } from '../../core/logger.js'
import type { RiskLevel } from '../../core/permission.js'
import * as fs from 'fs'
import * as path from 'path'

const approvalLog = (msg: string) => log(`[approval] ${msg}`)

// ── 持久化 ──

function approvalDbPath(): string {
  const workDir = process.env.CLAUDETALK_WORKDIR || process.cwd()
  return path.join(workDir, '.claudetalk', 'pending-approvals.json')
}

interface ApprovalPersist {
  requestId: string
  riskLevel: RiskLevel
  messageSummary: string
  requesterId: string
  conversationId: string
  createdAt: number
  timeoutAt: number
}

function loadPersisted(): Map<string, ApprovalPersist> {
  const db = new Map<string, ApprovalPersist>()
  try {
    const raw = fs.readFileSync(approvalDbPath(), 'utf-8')
    const arr: ApprovalPersist[] = JSON.parse(raw)
    const now = Date.now()
    for (const p of arr) {
      if (p.timeoutAt <= now) continue // 启动时清理已超时的
      db.set(p.requestId, p)
    }
  } catch { /* 首次运行或文件不存在 */ }
  return db
}

function savePersisted(map: Map<string, ApprovalPersist>): void {
  const arr = [...map.values()]
  const dbPath = approvalDbPath()
  const dir = path.dirname(dbPath)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const tmp = dbPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(arr), 'utf-8')
  fs.renameSync(tmp, dbPath)
}

function addPersisted(p: ApprovalPersist): void {
  const map = loadPersisted()
  map.set(p.requestId, p)
  savePersisted(map)
}

function removePersisted(requestId: string): void {
  const map = loadPersisted()
  map.delete(requestId)
  savePersisted(map)
}

// ── 运行时状态 ──

export interface ApprovalRequest {
  requestId: string
  riskLevel: RiskLevel
  messageSummary: string
  requesterId: string
  conversationId: string
  createdAt: number
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

const pendingApprovals = new Map<string, ApprovalRequest>()
const processedApprovals = new Set<string>()
const PROCESSED_CLEANUP_INTERVAL = 300_000

let seq = 0

setInterval(() => {
  processedApprovals.clear()
}, PROCESSED_CLEANUP_INTERVAL)

/** 生成唯一审批请求 ID */
export function nextRequestId(): string {
  return `apr_${Date.now().toString(36)}_${(++seq).toString(36)}`
}

function finalizeApproval(requestId: string, approved: boolean, reason: string): void {
  const req = pendingApprovals.get(requestId)
  if (!req) {
    approvalLog(`finalize: requestId=${requestId} NOT_FOUND in pendingApprovals (reason=${reason}, mapSize=${pendingApprovals.size}, keys=[${[...pendingApprovals.keys()].join(',')}])`)
    return
  }
  clearTimeout(req.timer)
  pendingApprovals.delete(requestId)
  processedApprovals.add(requestId)
  removePersisted(requestId)
  approvalLog(`finalize: requestId=${requestId}, approved=${approved}, reason=${reason}, pendingApprovals.size=${pendingApprovals.size}`)
  req.resolve(approved)
}

/** 注册待审批请求，返回 requestId */
export function registerApproval(
  requestId: string,
  riskLevel: RiskLevel,
  messageSummary: string,
  requesterId: string,
  conversationId: string,
  resolve: (approved: boolean) => void,
  timeoutMs = 180_000,
): void {
  const timer = setTimeout(() => {
    finalizeApproval(requestId, false, 'timeout')
  }, timeoutMs)

  pendingApprovals.set(requestId, {
    requestId,
    riskLevel,
    messageSummary,
    requesterId,
    conversationId,
    createdAt: Date.now(),
    resolve,
    timer,
  })
  // 持久化：进程重启后回调仍可识别此 requestId
  addPersisted({
    requestId,
    riskLevel,
    messageSummary,
    requesterId,
    conversationId,
    createdAt: Date.now(),
    timeoutAt: Date.now() + timeoutMs,
  })
  approvalLog(`register: requestId=${requestId}, riskLevel=${riskLevel}, timeoutMs=${timeoutMs}, pendingApprovals.size=${pendingApprovals.size}`)
}

/** 处理审批回调（由飞书 card action handler 调用） */
export function handleApprovalCallback(
  value: Record<string, unknown>,
): { toast: { type: string; content: string } } {
  const requestId = (value?.request_id as string) || ''
  const decision = (value?.decision as string) || ''
  const clickerId = (value?.clicker_id as string) || ''

  if (!requestId || !decision) {
    approvalLog(`callback MISSING_PARAMS: requestId=${requestId}, decision=${decision}, rawValue=${JSON.stringify(value)}`)
    return { toast: { type: 'error', content: '缺少审批参数' } }
  }

  // 去重检查：已处理的审批请求
  if (processedApprovals.has(requestId)) {
    approvalLog(`callback DUPLICATE: requestId=${requestId}, decision=${decision}, processedApprovals.size=${processedApprovals.size}`)
    return { toast: { type: 'warning', content: '该审批请求已处理' } }
  }

  const req = pendingApprovals.get(requestId)
  if (!req) {
    const now = Date.now()
    // 进程重启后的场景：persisted 文件中有记录但内存 Map 为空
    const persisted = loadPersisted()
    const p = persisted.get(requestId)
    const age = p ? ` (${Math.round((now - p.createdAt) / 1000)}秒前)` : ''
    const msg = p
      ? `该审批请求的进程已重启，请重新发送指令${age}`
      : '审批请求已过期或不存在'
    const entries = [...pendingApprovals.entries()].map(([id, r]) =>
      `${id}(age=${now - r.createdAt}ms,requester=${r.requesterId},conv=${r.conversationId})`
    ).join('; ')
    approvalLog(`callback NOT_FOUND: requestId=${requestId}, decision=${decision}, clickerId=${clickerId}, persisted=${!!p}, pendingApprovals.size=${pendingApprovals.size}, entries=[${entries}], processedApprovals.has=${processedApprovals.has(requestId)}`)
    return { toast: { type: 'warning', content: msg } }
  }

  // 验证点击者身份
  if (clickerId && req.requesterId && clickerId !== req.requesterId) {
    approvalLog(`callback IDENTITY_MISMATCH: requestId=${requestId}, clickerId=${clickerId}, requesterId=${req.requesterId}`)
    return { toast: { type: 'error', content: '只有请求者本人可以审批' } }
  }

  const approved = decision === 'approve'
  approvalLog(`callback APPROVED: requestId=${requestId}, decision=${decision}, approved=${approved}, mapSizeBeforeFinalize=${pendingApprovals.size}`)
  finalizeApproval(requestId, approved, 'callback')
  return { toast: { type: 'info', content: approved ? '✅ 已批准' : '❌ 已拒绝' } }
}

/** 构建待办任务确认卡片（自动归档 task-pending 时用） */
export function buildTaskConfirmCard(params: {
  summary: string
  taskId: string
  type?: string
  priority?: string
  progressNotes?: string
}): string {
  const { summary, taskId, type, priority, progressNotes } = params
  const typeLabel = type ? { task: '任务', bug: '漏洞', feature: '功能', research: '调研', chore: '杂务' }[type] || type : '任务'
  const priorityLabel = priority ? { low: '低', medium: '中', high: '高', critical: '紧急' }[priority] || priority : '中'

  const body = [
    `**${summary}**`,
    type ? `\n类型：${typeLabel}` : '',
    priority ? `优先级：${priorityLabel}` : '',
    progressNotes ? `\n进度备注：${progressNotes}` : '',
    '\n确认将此对话加入待办？',
  ].filter(Boolean).join('\n')

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📌 确认待办任务' },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: body },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认创建' },
            type: 'primary',
            value: {
              action_type: 'confirm-task-create',
              task_id: taskId,
              summary,
              type: type || 'task',
              priority: priority || 'medium',
              progress_notes: progressNotes || '',
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消' },
            type: 'default',
            value: { action_type: 'dismiss' },
          },
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '如需修改，对话框直接发送新指令即可' }] },
    ],
  })
}

/** 根据消息关键词推断任务类型 */
export function inferTaskType(message: string): string {
  if (/bug|故障|错误|闪退|crash|崩溃|异常|报错/i.test(message)) return 'bug'
  if (/feature|功能|需求|新增|添加|支持/i.test(message)) return 'feature'
  if (/调研|研究|分析|调查|research/i.test(message)) return 'research'
  if (/配置|部署|安装|迁移|升级|chore/i.test(message)) return 'chore'
  return 'task'
}

/** 根据消息关键词推断优先级 */
export function inferTaskPriority(message: string): string {
  if (/紧急|urgent|critical|暂停|停用|立刻/i.test(message)) return 'critical'
  if (/重要|important|high|严重|crash|闪退/i.test(message)) return 'high'
  return 'medium'
}

/** 构建存档确认卡片 */
export function buildArchiveConfirmCard(messagePreview: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📌 加入手机待办' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: `**确认将以下对话加入待办？**\n\n> ${messagePreview.slice(0, 200)}`,
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认' },
            type: 'primary',
            value: { action_type: 'confirm-archive' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消' },
            type: 'default',
            value: { action_type: 'dismiss' },
          },
        ],
      },
    ],
  })
}

/** 构建审批卡片（模板化，CC 不能自由构造） */
export function buildApprovalCard(params: {
  riskLevel: RiskLevel
  riskLabel: string
  messageSummary: string
  requestId: string
  requesterId: string
  reason: string
}): string {
  const { riskLevel, riskLabel, messageSummary, requestId, requesterId, reason } = params

  const headerColor = riskLevel === 'L3' ? 'red' : riskLevel === 'L2' ? 'yellow' : 'blue'

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ 操作审批 — ${riskLabel}` },
      template: headerColor,
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**风险等级**: ${riskLabel}\n**消息摘要**: ${messageSummary.slice(0, 200)}\n**评估原因**: ${reason}` },
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 批准' },
            type: 'primary',
            value: {
              action_type: 'approval-action',
              request_id: requestId,
              decision: 'approve',
              clicker_id: requesterId,
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: {
              action_type: 'approval-action',
              request_id: requestId,
              decision: 'reject',
              clicker_id: requesterId,
            },
          },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `审批请求: ${requestId} | 180秒后自动拒绝` }],
      },
    ],
  })
}
