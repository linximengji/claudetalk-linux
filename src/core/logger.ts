/**
 * 统一日志模块
 *
 * 所有日志格式：[yyyy-MM-dd HH:mm:ss.SSS] [channel profile] message
 * 使用 createLogger(channel?, profile?) 创建带上下文前缀的局部 logger
 */

import * as fs from 'fs'
import * as path from 'path'

// 日志文件路径
let logFilePath: string | null = null
let logFileStream: fs.WriteStream | null = null
let _workDir: string | null = null
let _lastRotateCheck = 0
const ROTATE_INTERVAL_MS = 60_000

/**
 * 初始化日志文件
 * @param workDir - 工作目录
 */
export function initLogFile(workDir: string): void {
  const claudetalkDir = path.join(workDir, '.claudetalk')
  
  // 确保 .claudetalk 目录存在
  if (!fs.existsSync(claudetalkDir)) {
    fs.mkdirSync(claudetalkDir, { recursive: true })
  }
  
  // 创建日志文件路径（按日期命名）
  _workDir = workDir
  const date = new Date()
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  logFilePath = path.join(claudetalkDir, `claudetalk-${dateStr}.log`)
  
  // 创建日志文件写入流（追加模式）
  logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' })
  
  // 写入日志文件头部
  let header = `\n${'='.repeat(80)}\n`
  header += `ClaudeTalk Log Session Started: ${formatTimestamp()}\n`
  header += `${'='.repeat(80)}\n\n`
  logFileStream.write(header)
}

/**
 * 关闭日志文件
 */
export function closeLogFile(): void {
  if (logFileStream) {
    logFileStream.write(`\n${'='.repeat(80)}\n`)
    logFileStream.write(`ClaudeTalk Log Session Ended: ${formatTimestamp()}\n`)
    logFileStream.write(`${'='.repeat(80)}\n`)
    logFileStream.end()
    logFileStream = null
  }
}

function formatTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`
}

/**
 * 日切检测：跨日时关旧流、开新文件（限频 1 分钟）
 */
function rotateLogIfNeeded(): void {
  if (!logFileStream || logFileStream.destroyed || !_workDir || !logFilePath) {
    return
  }
  const now = Date.now()
  if (now - _lastRotateCheck < ROTATE_INTERVAL_MS) return
  _lastRotateCheck = now

  const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`
  if (logFilePath.includes(todayStr)) return  // 日期一致，无需切换

  // 跨日：关旧流、开新文件
  logFileStream.end()
  logFileStream = null
  const claudetalkDir = path.dirname(logFilePath)
  logFilePath = path.join(claudetalkDir, `claudetalk-${todayStr}.log`)
  logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' })
  logFileStream.write(`\n${'='.repeat(80)}\n`)
  logFileStream.write(`ClaudeTalk Log Session Rotated: ${formatTimestamp()}\n`)
  logFileStream.write(`${'='.repeat(80)}\n\n`)
}

/**
 * 基础日志函数，同时输出到 stderr 和日志文件
 */
export function log(msg: string): void {
  rotateLogIfNeeded()
  const logMessage = `[${formatTimestamp()}] ${msg}`
  
  // 输出到控制台
  console.error(logMessage)
  
  // 输出到日志文件
  if (logFileStream && !logFileStream.destroyed) {
    logFileStream.write(logMessage + '\n')
  }
}

/**
 * 创建带上下文前缀的局部 logger
 *
 * @param channel - 消息通道类型，如 feishu、dingtalk、discord
 * @param profile - profile 名称，如 pm、fdev
 *
 * 输出格式示例：
 * - createLogger('feishu', 'pm')    → [2026-04-01 18:00:00.123] [feishu pm] message
 * - createLogger('dingtalk')        → [2026-04-01 18:00:00.123] [dingtalk] message
 * - createLogger(undefined, 'pm')   → [2026-04-01 18:00:00.123] [profile=pm] message
 * - createLogger()                  → [2026-04-01 18:00:00.123] message
 */
export function createLogger(channel?: string, profile?: string): (msg: string) => void {
  let prefix = ''
  if (channel && profile) {
    prefix = `[${channel} ${profile}] `
  } else if (channel) {
    prefix = `[${channel}] `
  } else if (profile) {
    prefix = `[profile=${profile}] `
  }
  return (msg: string) => log(`${prefix}${msg}`)
}
