import { appendFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createLogger } from './logger.js'

const logger = createLogger('twin-interactions')
const INTERACTIONS_FILE = '.claudetalk/twin/interactions.jsonl'
const OBSERVATIONS_FILE = '.claudetalk/twin/external-observations.jsonl'

export interface InteractionEntry {
  ts: string
  userId: string
  name: string
  level: string
  channel: string
  msgCount: number
}

/**
 * 记录一次交互到 interactions.jsonl（append-only）。
 */
export function logInteraction(opts: {
  workDir: string
  userId: string
  name: string // 显示名称，未注册时可用 fallback
  level: string // owner / friend / stranger
  channel: string
  profile: string
}): void {
  try {
    const { workDir, userId, name, level, channel } = opts
    const logPath = join(workDir, INTERACTIONS_FILE)
    const dir = join(workDir, '.claudetalk', 'twin')
    if (!existsSync(dir)) {
      // parent dir should already exist from users.json, but be safe
      return
    }
    // 读取已有记录，递增 msgCount
    let existingCount = 0
    const lines: string[] = []
    if (existsSync(logPath)) {
      const raw = readFileSync(logPath, 'utf-8').trim()
      if (raw) {
        for (const line of raw.split('\n')) {
          try {
            const entry = JSON.parse(line)
            // 保留当前用户之外的其他记录不变
            // 我们在最后 append，不做重写
            lines.push(line)
            if (entry.userId === userId) {
              existingCount++
            }
          } catch { /* skip corrupt lines */ }
        }
      }
    }
    const entry: InteractionEntry = {
      ts: new Date().toISOString(),
      userId,
      name,
      level,
      channel,
      msgCount: existingCount + 1,
    }
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    logger(`logInteraction error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface UserSummary {
  userId: string
  name: string
  level: string
  channel: string
  msgCount: number
  firstSeen: string
  lastSeen: string
}

export interface InteractionProfile {
  totalUsers: number
  totalMessages: number
  byChannel: Record<string, number>
  byLevel: Record<string, number>
}

/**
 * 从 interactions.jsonl 统计不重复用户列表。
 */
export function listUsers(workDir: string): UserSummary[] {
  const logPath = join(workDir, INTERACTIONS_FILE)
  if (!existsSync(logPath)) return []

  const raw = readFileSync(logPath, 'utf-8').trim()
  if (!raw) return []

  const map = new Map<string, UserSummary>()
  for (const line of raw.split('\n')) {
    try {
      const e: InteractionEntry = JSON.parse(line)
      const existing = map.get(e.userId)
      if (existing) {
        existing.msgCount = e.msgCount
        existing.lastSeen = e.ts
        // level/name 可能后来更新过
        existing.level = e.level
        existing.name = e.name
      } else {
        map.set(e.userId, {
          userId: e.userId,
          name: e.name,
          level: e.level,
          channel: e.channel,
          msgCount: e.msgCount,
          firstSeen: e.ts,
          lastSeen: e.ts,
        })
      }
    } catch { /* skip corrupt lines */ }
  }

  return Array.from(map.values()).sort((a, b) => b.msgCount - a.msgCount)
}

/**
 * 查询某个用户的时间线。
 */
export function searchUser(workDir: string, userId: string): InteractionEntry[] {
  const logPath = join(workDir, INTERACTIONS_FILE)
  if (!existsSync(logPath)) return []

  const raw = readFileSync(logPath, 'utf-8').trim()
  if (!raw) return []

  const results: InteractionEntry[] = []
  for (const line of raw.split('\n')) {
    try {
      const e: InteractionEntry = JSON.parse(line)
      if (e.userId === userId) {
        results.push(e)
      }
    } catch { /* skip */ }
  }
  return results
}

/**
 * 记录群聊中非 owner 的外部消息，用于后续 gap 检测。
 * 写入 twin/external-observations.jsonl（append-only），每条包含：
 *  - ts: 时间戳
 *  - userId: 飞书 open_id
 *  - name: 显示名称
 *  - message: 消息内容（前 200 字）
 *  - chatId: 群 ID
 */
export function logExternalObservation(opts: {
  workDir: string
  userId: string
  name: string
  message: string
  chatId: string
}): void {
  try {
    const dir = join(opts.workDir, '.claudetalk', 'twin')
    if (!existsSync(dir)) return
    const entry = {
      ts: new Date().toISOString(),
      userId: opts.userId,
      name: opts.name,
      message: opts.message.slice(0, 200),
      chatId: opts.chatId,
    }
    appendFileSync(join(dir, 'external-observations.jsonl'), JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    logger(`logExternalObservation error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 读取外部观察日志（最新 N 条）。
 */
export function readExternalObservations(workDir: string, limit = 50): Array<{
  ts: string
  userId: string
  name: string
  message: string
  chatId: string
}> {
  const file = join(workDir, OBSERVATIONS_FILE)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    const tail = lines.slice(-limit)
    return tail.map(l => JSON.parse(l))
  } catch {
    return []
  }
}

/**
 * 总览统计。
 */
export function profile(workDir: string): InteractionProfile {
  const users = listUsers(workDir)
  const byChannel: Record<string, number> = {}
  const byLevel: Record<string, number> = {}

  let totalMessages = 0
  for (const u of users) {
    totalMessages += u.msgCount
    byChannel[u.channel] = (byChannel[u.channel] || 0) + u.msgCount
    byLevel[u.level] = (byLevel[u.level] || 0) + u.msgCount
  }

  return {
    totalUsers: users.length,
    totalMessages,
    byChannel,
    byLevel,
  }
}
