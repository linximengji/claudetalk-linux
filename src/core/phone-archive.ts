import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { classifyConversation } from './classifier.js'
import { createLogger } from './logger.js'
import { getPhoneTasksDir } from './paths.js'
import type { TaskCategory } from './classifier.js'

const logger = createLogger('phone-archive')

const FILLER_RE = /这个|那个|哪些|哪个|有没有|能不能|可不可以|分析一下|帮我|帮我看看|一些|一下|关于|对于|目前|现在|怎么|如何|然后|不仅仅|提前|值得|什么|到底|出来|现有|当前|还有|这种|还有别的|补充/g
const MAX_SLUG = 25
const PENDING_INSTRUCTION_RE = /留到终端|加.*待办|加入手机|终端修改/

export interface ArchiveResult {
  category: TaskCategory
  taskId?: string
  summary?: string
  slug: string
  dateStr: string
  seq: string
  dir: string
  userId?: string
}

/** Extract a meaningful summary for the task index entry. */
function extractTaskSummary(message: string, reply: string, category: TaskCategory): string {
  const cleanMsg = message.replace(/\[图片:.*?\]/g, '[图片]')
  if (category === 'task-pending') {
    if (PENDING_INSTRUCTION_RE.test(message)) {
      return cleanMsg.slice(0, 50)
    }
    const cleaned = reply
      .replace(/^["""`]*(好的|可以|已经|已|行|OK|没问题|收到)[\s,。！!]*/, '')
      .replace(/^已将[\s\S]{0,40}(加入|添加)[\s\S]{0,20}[。：]?\s*/, '')
    return cleaned.split(/[。\n]/)[0].trim().slice(0, 50) || cleaned.trim().slice(0, 50)
  }
  return cleanMsg.slice(0, 50)
}

export interface ArchiveOptions {
  message: string
  reply: string
  toolUseCount: number
  toolNames: string[]
  workDir: string
  isGroup: boolean
  /** 发送者标识（可选，用于交互日志关联） */
  userId?: string
  /** 消息通道类型（可选） */
  channel?: string
  /** 对话 profile 名称（可选，如 twin / default） */
  profile?: string
}

export async function archiveConversation(opts: ArchiveOptions): Promise<ArchiveResult> {
  const { message, reply, toolUseCount, workDir, isGroup } = opts

  if (isGroup) {
    return { category: 'reference', slug: '', dateStr: '', seq: '', dir: '' }
  }

  try {
    const dateStr = new Date().toISOString().slice(0, 10)
    const slug = makeSlug(message)
    const tasksRoot = getPhoneTasksDir()
    const seq = nextSeq(tasksRoot, dateStr)
    const dir = join(tasksRoot, dateStr, `${seq}-${slug}`)
    mkdirSync(dir, { recursive: true })
    logger(`archive start: ${dateStr}/${seq}-${slug}, msg="${message.slice(0, 60)}"`)

    let msgText = message
    const imgPaths: string[] = []
    const imgRe = /\[图片:\s*([^\]]+)\]/g
    let m
    while ((m = imgRe.exec(message)) !== null) {
      imgPaths.push(m[1].trim())
    }
    if (imgPaths.length > 0) {
      const attDir = join(dir, 'attachments')
      mkdirSync(attDir, { recursive: true })
      for (const imgPath of imgPaths) {
        const name = basename(imgPath)
        const dest = join(attDir, name)
        try {
          if (existsSync(imgPath) && !existsSync(dest)) {
            linkSync(imgPath, dest)
          }
        } catch { /* 硬链接失败不阻塞 */ }
        msgText = msgText.replace(
          new RegExp(`\\[图片:\\s*${imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`),
          `![${name}](${'attachments/' + name})`
        )
      }
    }

    writeFileSync(join(dir, '消息.md'), msgText + '\n', 'utf-8')
    writeFileSync(join(dir, '回复.md'), reply + '\n', 'utf-8')
    // 用户元数据（仅当有 userId 时写入，用于交互关联）
    if (opts.userId) {
      const meta: Record<string, string> = { userId: opts.userId, ts: new Date().toISOString() }
      if (opts.channel) meta.channel = opts.channel
      if (opts.profile) meta.profile = opts.profile
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf-8')
    }

    // 分类：completed（已终端完成）vs task-pending（需终端处理）vs reference（参考归档）
    const category: TaskCategory = await classifyConversation(message, reply, opts.toolNames)
    const categoryLabel = category === 'task-pending' ? '待办' : category === 'completed' ? '已完成' : '归档'
    logger(`archive classify: ${category}, category=${categoryLabel}, tools=[${opts.toolNames.join(', ')}]`)

    const result: ArchiveResult = { category, slug, dateStr, seq, dir, userId: opts.userId }

    if (category === 'task-pending' || category === 'completed') {
      const taskId = `${dateStr}/${seq}-${slug}`
      const summary = extractTaskSummary(message, reply, category)
      result.taskId = taskId
      result.summary = summary
    }

    // INDEX.md 追加（所有归档都写）
    const replyLines = reply.split('\n').length
    const imgTag = imgPaths.length > 0 ? ` 📎${imgPaths.length}` : ''
    const idxLine = `| ${dateStr} | ${slug} | ${replyLines}行${imgTag} | ${categoryLabel} |\n`
    appendFileSync(join(tasksRoot, 'INDEX.md'), idxLine, 'utf-8')
    logger(`archive done: ${dateStr}/${seq}-${slug}, ${replyLines}行${imgPaths.length > 0 ? `, ${imgPaths.length}图` : ''}`)

    return result
  } catch (err) {
    logger(`archive error: ${err instanceof Error ? err.message : String(err)}`)
    return { category: 'reference', slug: '', dateStr: '', seq: '', dir: '' }
  }
}

/**
 * Write or update a task entry directly in index.json.
 * Format MUST match tasks-mcp / tasks/cli.py (Record<id, entry>, same field schema).
 */
export function writeTaskToIndex(options: {
  taskId: string
  status: string
  summary: string
  type?: string
  source?: string
  priority?: string
  progress?: string
}): void {
  const indexFile = join(getPhoneTasksDir(), 'index.json')
  let index: Record<string, any> = {}
  try { index = JSON.parse(readFileSync(indexFile, 'utf-8')) } catch {
    // file missing or corrupt — start fresh
  }
  if (Array.isArray(index)) {
    // safety: root out any lingering array-format data from old daily-report writer
    index = {}
  }

  const existing = index[options.taskId]
  index[options.taskId] = {
    status: options.status,
    summary: options.summary,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(options.type ? { type: options.type } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.progress ? { progress: options.progress } : {}),
  }
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
}

export { makeSlug, nextSeq }

function makeSlug(text: string): string {
  const cleaned = text
    .replace(/@\S+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[图片|文件\]:\s*[^\]]+\]/g, '')
    .replace(FILLER_RE, '')
    .replace(/[^一-龥a-zA-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'untitled'

  const words = cleaned.split(' ')
  const parts: string[] = []
  let len = 0
  for (const w of words) {
    if (len + w.length > MAX_SLUG) break
    parts.push(w)
    len += w.length + 1
  }
  return parts.length > 0 ? parts.join('-') : cleaned.slice(0, MAX_SLUG)
}

function nextSeq(workDir: string, dateStr: string): string {
  const dateDir = join(workDir, dateStr)
  if (!existsSync(dateDir)) return '001'
  const entries = readdirSync(dateDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
  return String(entries.length + 1).padStart(3, '0')
}
