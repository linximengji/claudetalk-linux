/**
 * /session 命令处理器
 * 子命令: list, name <标题>, 无参数(显示当前会话摘要)
 */

import { getSessionMap, getSessionKey, saveSessionMap, clearSession } from '../core/claude.js'
import type { Channel, ChannelMessageContext } from '../types.js'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

export async function handleSessionCommand(
  text: string,
  context: ChannelMessageContext,
  channel: Channel,
  workDir: string,
  profile?: string,
): Promise<boolean> {
  const { conversationId, isGroup } = context

  // 解析子命令
  const parts = text.trim().split(/\s+/)
  // parts[0] 是 "/session" 或 "会话"
  const sub = parts[1]?.toLowerCase() || ''

  if (sub === 'list') {
    return handleList(conversationId, workDir, channel, context)
  }

  if (sub === 'name') {
    const name = parts.slice(2).join(' ').trim()
    if (!name) {
      await channel.sendMessage(conversationId, '用法: /session name <会话标题>', isGroup)
      return true
    }
    return handleName(name, conversationId, workDir, profile, channel, context)
  }

  if (sub === 'new') {
    clearSession(conversationId, workDir, profile, context.channelType, context.userId, context.isGroup)
    await channel.sendMessage(conversationId, '🔄 已清空当前会话记忆，下次发消息将开启全新对话。', isGroup)
    return true
  }

  // 无子命令 → 显示当前会话摘要
  return handleStatus(conversationId, workDir, profile, channel, context)
}

/** 列出最近会话 */
async function handleList(
  conversationId: string,
  workDir: string,
  channel: Channel,
  context: ChannelMessageContext,
): Promise<boolean> {
  const sessionMap = getSessionMap(workDir)
  const entries: Array<{ key: string; entry: { lastActiveAt: number; name?: string; sessionId?: string; toolCallCount?: number; cumulatedInputTokens?: number } }> = []

  for (const [key, entry] of sessionMap) {
    entries.push({ key, entry })
  }

  // 按 lastActiveAt 倒序
  entries.sort((a, b) => b.entry.lastActiveAt - a.entry.lastActiveAt)

  const top = entries.slice(0, 10)
  if (top.length === 0) {
    await channel.sendMessage(conversationId, '暂无历史会话记录', context.isGroup)
    return true
  }

  const lines: string[] = ['**最近会话**']
  for (const { key, entry } of top) {
    const name = entry.name || key.slice(0, 24) + (key.length > 24 ? '…' : '')
    const time = formatTime(entry.lastActiveAt)
    const calls = entry.toolCallCount ?? 0
    const tokens = entry.cumulatedInputTokens ?? 0
    lines.push(`  • ${name}`)
    lines.push(`    ${time} | ${calls}次调用 | ${Math.round(tokens / 1000)}k tokens`)
  }
  lines.push(`\n共 ${entries.length} 条记录`)
  await channel.sendMessage(conversationId, lines.join('\n'), context.isGroup)
  return true
}

/** 命名当前会话 */
async function handleName(
  name: string,
  conversationId: string,
  workDir: string,
  profile: string | undefined,
  channel: Channel,
  context: ChannelMessageContext,
): Promise<boolean> {
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, context.channelType, context.userId, context.isGroup)
  const entry = sessionMap.get(sessionKey)
  if (!entry) {
    await channel.sendMessage(conversationId, '当前没有活跃会话，发消息后再命名', context.isGroup)
    return true
  }
  entry.name = name
  saveSessionMap(workDir, sessionMap)
  await channel.sendMessage(conversationId, `✅ 会话已命名为: ${name}`, context.isGroup)
  return true
}

/** 显示当前会话摘要 */
async function handleStatus(
  conversationId: string,
  workDir: string,
  profile: string | undefined,
  channel: Channel,
  context: ChannelMessageContext,
): Promise<boolean> {
  const sessionMap = getSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, context.channelType, context.userId, context.isGroup)
  const entry = sessionMap.get(sessionKey)

  if (!entry) {
    await channel.sendMessage(conversationId, '当前没有活跃会话', context.isGroup)
    return true
  }

  const lines: string[] = ['**当前会话**']
  lines.push(`  会话ID: \`${entry.sessionId.slice(0, 20)}…\``)
  if (entry.name) lines.push(`  名称: ${entry.name}`)
  lines.push(`  活跃时间: ${formatTime(entry.lastActiveAt)}`)
  lines.push(`  工具调用: ${entry.toolCallCount ?? 0}次`)
  lines.push(`  累计 Token: ${Math.round((entry.cumulatedInputTokens ?? 0) / 1000)}k`)
  lines.push(`  子代理: ${entry.subagentEnabled ? '✅ 启用' : '❌ 未启用'}`)

  await channel.sendMessage(conversationId, lines.join('\n'), context.isGroup)
  return true
}
