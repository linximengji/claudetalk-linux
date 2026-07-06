/**
 * 飞书消息去重逻辑自动化测试
 *
 * 模拟 feishu-bridge 的消息事件处理逻辑，验证：
 * 1. bot 自己的消息被跳过（不写 peer-message）
 * 2. 用户消息正常转发
 * 3. 连续 N 条消息不会产生额外 peer-message
 *
 * 不依赖真实 WebSocket 或 Feishu API，纯单元测试。
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { PeerMessage } from './types.js'

// ========== 模拟 feishu-bridge 的去重逻辑 ==========

// 复刻 feishu-bridge.ts 的核心过滤逻辑
// 不 mock 外部依赖（parseFeishuMessage, api）—— 只测试 early-return 路径

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CLAUDETALK_DIR = path.join(__dirname, '..', '.claudetalk')

interface Sender {
  sender_type: string
  sender_id?: { open_id?: string }
}

interface Message {
  message_id: string
  chat_type: string
  chat_id: string
  message_type: string
  content: string
  mentions?: Array<{ id?: { open_id?: string }; name?: string }>
}

interface Event {
  sender: Sender
  message: Message
}

// 测试用的去重决策函数（复刻 feishu-bridge.ts:577-580 的逻辑）
function shouldSkipBotSelf(
  sender: Sender,
  botOpenId: string
): boolean {
  // 用 open_id 精确匹配跳过 bot 自己的消息
  return !!(botOpenId && sender.sender_id?.open_id === botOpenId)
}

// 复刻 feishu-bridge.ts:566-571 的 message_id 去重逻辑
function shouldDeduplicateByMessageId(
  messageId: string | undefined,
  processedEventIds: Map<string, number>,
  dedupTtl: number
): boolean {
  const now = Date.now()
  if (messageId && processedEventIds.has(messageId) && now - processedEventIds.get(messageId)! < dedupTtl) return true
  if (messageId) processedEventIds.set(messageId, now)
  return false
}

// 复刻 feishu-bridge.ts:592-596 的群聊 @mention 检查
function shouldProcessGroupMessage(message: Message): boolean {
  if (message.chat_type !== 'group') return true // p2p 不做检查
  const mentioned = message.mentions?.some((m) => m.id?.open_id)
  return !!mentioned
}

// ========== 测试框架 ==========

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

// ========== 测试套件 ==========

const BOT_OPEN_ID = 'ou_bot123456'
const USER_OPEN_ID = 'ou_user789012'

// 清理测试文件
function cleanup() {
  const testFile = path.join(CLAUDETALK_DIR, 'feishu', 'bot_claudetalk.json')
  try { fs.unlinkSync(testFile) } catch { /* ok */ }
}

function runAllTests() {
  console.log('\n=== feishu-bridge 去重逻辑测试 ===\n')

  // ---- 测试 1: bot 自身消息过滤 ----
  console.log('[Test 1] bot 自身消息 skip 逻辑')

  // 1a: bot 自己的消息应被跳过
  const botOwnMsg: Event = {
    sender: { sender_type: 'app', sender_id: { open_id: BOT_OPEN_ID } },
    message: { message_id: 'M1', chat_type: 'p2p', chat_id: 'c1', message_type: 'text', content: '{"text":"hello"}', mentions: [] },
  }
  assert(shouldSkipBotSelf(botOwnMsg.sender, BOT_OPEN_ID) === true, 'bot 自身 open_id 匹配 → skip')

  // 1b: 用户消息不应被跳过
  const userMsg: Event = {
    sender: { sender_type: 'user', sender_id: { open_id: USER_OPEN_ID } },
    message: { message_id: 'M2', chat_type: 'p2p', chat_id: 'c1', message_type: 'text', content: '{"text":"hi"}', mentions: [] },
  }
  assert(shouldSkipBotSelf(userMsg.sender, BOT_OPEN_ID) === false, '用户消息 → 不 skip')

  // 1c: botOpenId 为空时不过滤（启动初期回退行为）
  assert(shouldSkipBotSelf(botOwnMsg.sender, '') === false, 'botOpenId 为空时 → 不过滤')

  // 1d: sender_type='bot' 但不同 open_id → 不过滤（模拟多 bot 场景）
  const anotherBot: Event = {
    sender: { sender_type: 'bot', sender_id: { open_id: 'ou_another_bot' } },
    message: { message_id: 'M3', chat_type: 'p2p', chat_id: 'c1', message_type: 'text', content: '{"text":"msg"}', mentions: [] },
  }
  assert(shouldSkipBotSelf(anotherBot.sender, BOT_OPEN_ID) === false, '其他 bot 不同 open_id → 不过滤')

  // 1e: 无 sender_id 时不跳过（防御性）
  const noSenderId: Event = {
    sender: { sender_type: 'user', sender_id: undefined },
    message: { message_id: 'M4', chat_type: 'p2p', chat_id: 'c1', message_type: 'text', content: '{"text":"msg"}', mentions: [] },
  }
  assert(shouldSkipBotSelf(noSenderId.sender, BOT_OPEN_ID) === false, '无 sender_id → 不过滤')

  // ---- 测试 2: message_id 去重 ----
  console.log('\n[Test 2] message_id 去重逻辑')

  const processedEventIds = new Map<string, number>()
  const DEDUP_TTL = 24 * 60 * 60 * 1000

  // 2a: 首次遇到 message_id 不重复
  assert(shouldDeduplicateByMessageId('M1', processedEventIds, DEDUP_TTL) === false, '首次遇到不重复')
  assert(processedEventIds.has('M1'), '首次遇到应记录')

  // 2b: 同一 message_id 再次出现 → 重复
  assert(shouldDeduplicateByMessageId('M1', processedEventIds, DEDUP_TTL) === true, '同一 message_id 再出现 → 重复')

  // 2c: 不同 message_id 不重复
  assert(shouldDeduplicateByMessageId('M2', processedEventIds, DEDUP_TTL) === false, '不同 message_id 不重复')

  // 2d: 无 message_id 不报错
  assert(shouldDeduplicateByMessageId(undefined, processedEventIds, DEDUP_TTL) === false, '无 message_id 不报错')

  // ---- 测试 3: 群聊 @mention 检查 ----
  console.log('\n[Test 3] 群聊 @mention 检查')

  // 3a: p2p 消息不需要 @mention
  const p2pMsg: Message = { message_id: 'M5', chat_type: 'p2p', chat_id: 'c1', message_type: 'text', content: '{}', mentions: [] }
  assert(shouldProcessGroupMessage(p2pMsg) === true, 'p2p 消息不需要 @mention')

  // 3b: 群聊有 @mention → 通过
  const groupWithMention: Message = { message_id: 'M6', chat_type: 'group', chat_id: 'c2', message_type: 'text', content: '{}', mentions: [{ id: { open_id: USER_OPEN_ID }, name: 'user' }] }
  assert(shouldProcessGroupMessage(groupWithMention) === true, '群聊有 @mention → 通过')

  // 3c: 群聊无 @mention → 跳过
  const groupNoMention: Message = { message_id: 'M7', chat_type: 'group', chat_id: 'c2', message_type: 'text', content: '{}' }
  assert(shouldProcessGroupMessage(groupNoMention) === false, '群聊无 @mention → 跳过')

  // ---- 测试 4: 全链路模拟（无真实 WS/API） ----
  console.log('\n[Test 4] 全链路模拟：N 条用户消息不产生额外 peer-message')

  // 清理环境
  cleanup()
  const testProcessed = new Map<string, number>()
  const testBotOpenId = BOT_OPEN_ID
  const testAppName = 'claudetalk'
  const N = 10
  let appendCount = 0

  // 用内存数组 mock appendPeerMessage
  const mockMessages: PeerMessage[] = []

  for (let i = 0; i < N; i++) {
    // 模拟用户消息
    const userMessageId = `user_msg_${i}`
    const userEvent: Event = {
      sender: { sender_type: 'user', sender_id: { open_id: USER_OPEN_ID } },
      message: { message_id: userMessageId, chat_type: 'p2p', chat_id: 'c_test', message_type: 'text', content: JSON.stringify({ text: `hello ${i}` }) },
    }

    // 去重检查
    const isDuplicate = shouldDeduplicateByMessageId(userEvent.message.message_id, testProcessed, DEDUP_TTL)
    if (isDuplicate) {
      appendCount++ // 不应发生
      continue
    }

    // bot 自身过滤
    if (shouldSkipBotSelf(userEvent.sender, testBotOpenId)) {
      continue
    }

    // 模拟转发
    const peerMsg: PeerMessage = {
      id: randomUUID(),
      from: testAppName,
      chatId: userEvent.message.chat_id,
      messageId: userEvent.message.message_id,
      message: `hello ${i}`,
      createdAt: Date.now(),
    }
    mockMessages.push(peerMsg)
    appendCount++

    // 模拟 bot 回复后 Feishu 推送回 bot 的事件
    const botReplyMessageId = `bot_reply_${i}`
    const botReplyEvent: Event = {
      sender: { sender_type: 'app', sender_id: { open_id: testBotOpenId } },
      message: { message_id: botReplyMessageId, chat_type: 'p2p', chat_id: 'c_test', message_type: 'text', content: JSON.stringify({ text: `reply ${i}` }) },
    }

    // 应被 botOpenId 过滤
    if (shouldSkipBotSelf(botReplyEvent.sender, testBotOpenId)) {
      // 正确跳过，不做任何事
    } else {
      // 错误：bot 自己的消息未被过滤
      appendCount++
      const errMsg: PeerMessage = {
        id: randomUUID(),
        from: testAppName,
        chatId: botReplyEvent.message.chat_id,
        messageId: botReplyEvent.message.message_id,
        message: `reply ${i}`,
        createdAt: Date.now(),
      }
      mockMessages.push(errMsg)
    }
  }

  assert(appendCount === N, `N=10 条用户消息 → 仅 ${appendCount} 条 peer-message（应为 10）`)
  assert(mockMessages.length === appendCount, `peer-message 数组长度 = appendCount`)
  for (let i = 0; i < mockMessages.length; i++) {
    assert(mockMessages[i].messageId === `user_msg_${i}`, `第 ${i + 1} 条 peer-message 的 messageId 应为 user_msg_${i}`)
  }

  // 清理
  cleanup()

  // ---- 总结果 ----
  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

runAllTests()
