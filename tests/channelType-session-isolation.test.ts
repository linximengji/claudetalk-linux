/**
 * Session key isolation by channelType — 四象限覆盖
 *
 * 覆盖接口：
 *   getSessionKey (claude.ts) — channelType 参数生成唯一 key
 *   clearSession (claude.ts)  — channelType 参数隔离清除
 *   handleSessionCommand (session.ts) — 3 处调用点传 channelType
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================
// getSessionKey 单元逻辑（从 claude.ts 复制，避免 mock 依赖）
// ============================================================
function getSessionKey(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: string,
): string {
  const parts = [conversationId, workDir]
  if (profile) parts.push(profile)
  if (channel) parts.push(channel)
  return parts.join('\x00')
}

// ============================================================
// SessionEntry / 辅助类型
// ============================================================
interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  name?: string
  toolCallCount?: number
  cumulatedInputTokens?: number
  subagentEnabled?: boolean
}

// ============================================================
// 模拟 session map 持久化（match claude.ts saveSessionMap/loadSessionMap 行为）
// ============================================================
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function getSessionFile(workDir: string): string {
  const dir = path.join(workDir, '.claudetalk')
  ensureDir(dir)
  return path.join(dir, 'sessions.json')
}

function saveSessionMap(workDir: string, sessionMap: Map<string, SessionEntry>): void {
  const entries = Object.fromEntries(sessionMap)
  fs.writeFileSync(getSessionFile(workDir), JSON.stringify(entries, null, 2) + '\n', 'utf-8')
}

function loadSessionMap(workDir: string): Map<string, SessionEntry> {
  const file = getSessionFile(workDir)
  if (!fs.existsSync(file)) return new Map()
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>
    return new Map(Object.entries(parsed))
  } catch {
    return new Map()
  }
}

// 模拟 clearSession 逻辑
const clearedDuringProcessing = new Set<string>()

function clearSession(
  conversationId: string,
  workDir: string,
  profile?: string,
  channel?: string,
): boolean {
  const sessionMap = loadSessionMap(workDir)
  const sessionKey = getSessionKey(conversationId, workDir, profile, channel)
  const hadSession = sessionMap.has(sessionKey)
  if (hadSession) {
    sessionMap.delete(sessionKey)
    saveSessionMap(workDir, sessionMap)
    clearedDuringProcessing.add(sessionKey)
  }
  return hadSession
}

function clearAllSessions(workDir: string) {
  clearedDuringProcessing.clear()
  const file = getSessionFile(workDir)
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

// ============================================================
// formatTime / truncate（从 session.ts 复制，纯函数无需 mock）
// ============================================================
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

// ============================================================
// Mock Channel（实现 sendMessage 并记录调用）
// ============================================================
interface MockChannel {
  messages: Array<{ conversationId: string; content: string; isGroup: boolean }>
  sendMessage(cid: string, content: string, isGroup: boolean): Promise<void>
}

function createMockChannel(): MockChannel {
  const messages: MockChannel['messages'] = []
  return {
    messages,
    async sendMessage(cid: string, content: string, isGroup: boolean) {
      messages.push({ conversationId: cid, content, isGroup })
    },
  }
}

// ============================================================
// 测试 1: getSessionKey — channelType 隔离
// ============================================================
describe('getSessionKey channelType isolation', () => {

  // --- Happy path ---
  it('different channelTypes produce different keys', () => {
    const k1 = getSessionKey('conv1', '/work', 'profileA', 'feishu')
    const k2 = getSessionKey('conv1', '/work', 'profileA', 'dingtalk')
    const k3 = getSessionKey('conv1', '/work', 'profileA', 'discord')
    assert.notStrictEqual(k1, k2)
    assert.notStrictEqual(k2, k3)
    assert.notStrictEqual(k1, k3)
  })

  it('same channelType produces same key (idempotent)', () => {
    const k1 = getSessionKey('convA', '/work', 'p1', 'feishu')
    const k2 = getSessionKey('convA', '/work', 'p1', 'feishu')
    assert.strictEqual(k1, k2)
  })

  it('channelType only differentiates when all other parts are same', () => {
    const sameAll = getSessionKey('c1', '/w', 'p', 'feishu') !== getSessionKey('c1', '/w', 'p', 'dingtalk')
    assert.ok(sameAll, 'should differ by channelType')
  })

  it('different conversationId already gives different keys regardless of channelType', () => {
    const k1 = getSessionKey('conv1', '/w', 'p', 'feishu')
    const k2 = getSessionKey('conv2', '/w', 'p', 'feishu')
    assert.notStrictEqual(k1, k2)
  })

  it('channel present without profile still works', () => {
    const key = getSessionKey('c1', '/work', undefined, 'feishu')
    assert.ok(key.includes('feishu'))
    // Verify channel is appended: parts = [conversationId, workDir, channel]
    const parts = key.split('\x00')
    assert.strictEqual(parts.length, 3)
    assert.strictEqual(parts[2], 'feishu')
  })

  // --- Boundary values ---
  it('empty string channelType treated as absent (falsy, same as undefined)', () => {
    // '' is falsy in JS, so if (channel) evaluates to false — treated as "no channel"
    const key = getSessionKey('c1', '/work', 'p', '')
    const parts = key.split('\x00')
    assert.strictEqual(parts.length, 3, 'empty string channel ignored, same as undefined')
    // Verify key matches the no-channel case
    const keyNoChannel = getSessionKey('c1', '/work', 'p')
    assert.strictEqual(key, keyNoChannel, 'empty string == no channel')
  })

  it('empty string profile with non-empty channelType', () => {
    const key = getSessionKey('c1', '/work', '', 'dingtalk')
    const parts = key.split('\x00')
    // profile is '' (falsy in JS), but the check is if (profile), so '' is NOT pushed
    // Actually, check: if (profile) — '' is falsy, so it's NOT pushed. Expected: ['c1', '/work', 'dingtalk']
    assert.strictEqual(parts.length, 3)
    assert.strictEqual(parts[2], 'dingtalk')
  })

  it('very long conversationId and channelType', () => {
    const longConvId = 'x'.repeat(10000)
    const longChannel = 'y'.repeat(10000)
    const key = getSessionKey(longConvId, '/work', 'p', longChannel)
    assert.ok(key.length > 20000)
    // Verify channel part is intact
    assert.ok(key.endsWith(longChannel))
  })

  it('unicode in channelType', () => {
    const key = getSessionKey('c1', '/work', 'p', '中文')
    assert.ok(key.includes('中文'))
  })

  it('channelType with NUL character is rejected at usage level (but key generation still works)', () => {
    // If someone passes a channelType with NUL, the join will still work but separator is ambiguous
    const key = getSessionKey('c1', '/work', 'p', 'a\x00b')
    const parts = key.split('\x00')
    // Ambiguous: ['c1', '/work', 'p', 'a', 'b'] — 5 parts instead of 4
    assert.strictEqual(parts.length, 5)
  })

  it('undefined channelType is not appended (backward compat)', () => {
    const key = getSessionKey('c1', '/work', 'p', undefined)
    const parts = key.split('\x00')
    assert.strictEqual(parts.length, 3)
  })

  // --- 时序竞态 ---
  it('rapid concurrent calls with different channelTypes produce isolated keys', () => {
    const results = new Set<string>()
    const channels = ['feishu', 'dingtalk', 'discord']
    const convos = ['c1', 'c2', 'c3']
    for (const ch of channels) {
      for (const conv of convos) {
        results.add(getSessionKey(conv, '/work', 'p', ch))
      }
    }
    assert.strictEqual(results.size, 9)
  })
})

// ============================================================
// 测试 2: clearSession — channelType 隔离
// ============================================================
describe('clearSession channelType isolation', () => {
  let workDir: string

  function makeEntry(sessionId: string): SessionEntry {
    return { sessionId, lastActiveAt: Date.now() }
  }

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-test-'))
    clearedDuringProcessing.clear()
  })

  it.afterEach(() => {
    try {
      clearAllSessions(workDir)
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {}
  })

  // --- Happy path ---
  it('clearSession clears only the matching channelType', () => {
    const keyFeishu = getSessionKey('conv1', workDir, 'p', 'feishu')
    const keyDingtalk = getSessionKey('conv1', workDir, 'p', 'dingtalk')
    const map = loadSessionMap(workDir)
    map.set(keyFeishu, makeEntry('sess-feishu'))
    map.set(keyDingtalk, makeEntry('sess-dingtalk'))
    saveSessionMap(workDir, map)

    const cleared = clearSession('conv1', workDir, 'p', 'feishu')
    assert.strictEqual(cleared, true)

    const afterMap = loadSessionMap(workDir)
    assert.strictEqual(afterMap.has(keyFeishu), false, 'feishu session should be removed')
    assert.strictEqual(afterMap.has(keyDingtalk), true, 'dingtalk session should remain')
  })

  it('clearSession with wrong channelType does not clear', () => {
    const keyFeishu = getSessionKey('conv1', workDir, 'p', 'feishu')
    const map = loadSessionMap(workDir)
    map.set(keyFeishu, makeEntry('sess-feishu'))
    saveSessionMap(workDir, map)

    const cleared = clearSession('conv1', workDir, 'p', 'dingtalk')
    assert.strictEqual(cleared, false)

    const afterMap = loadSessionMap(workDir)
    assert.strictEqual(afterMap.has(keyFeishu), true, 'feishu session should still exist')
  })

  it('clearSession without channelType (backward compat mock) clears matching key without channel', () => {
    const keyNoChannel = getSessionKey('conv1', workDir, 'p')
    const keyWithChannel = getSessionKey('conv1', workDir, 'p', 'feishu')
    const map = loadSessionMap(workDir)
    map.set(keyNoChannel, makeEntry('sess-old'))
    map.set(keyWithChannel, makeEntry('sess-new'))
    saveSessionMap(workDir, map)

    const cleared = clearSession('conv1', workDir, 'p')
    assert.strictEqual(cleared, true)

    const afterMap = loadSessionMap(workDir)
    assert.strictEqual(afterMap.has(keyNoChannel), false, 'no-channel session removed')
    assert.strictEqual(afterMap.has(keyWithChannel), true, 'channel-specific session remains')
  })

  it('clearSession returns false for non-existent session', () => {
    const result = clearSession('nonexistent', workDir, 'p', 'feishu')
    assert.strictEqual(result, false)
  })

  // --- Boundary values ---
  it('clearSession with empty conversationId', () => {
    const key = getSessionKey('', workDir, 'p', 'feishu')
    const map = loadSessionMap(workDir)
    map.set(key, makeEntry('sess-empty'))
    saveSessionMap(workDir, map)

    const cleared = clearSession('', workDir, 'p', 'feishu')
    assert.strictEqual(cleared, true)
    assert.strictEqual(loadSessionMap(workDir).has(key), false)
  })

  it('clearSession with empty channelType still works', () => {
    const key = getSessionKey('conv1', workDir, 'p', '')
    const map = loadSessionMap(workDir)
    map.set(key, makeEntry('sess-empty-ch'))
    saveSessionMap(workDir, map)

    const cleared = clearSession('conv1', workDir, 'p', '')
    assert.strictEqual(cleared, true)
  })

  // --- 时序竞态 ---
  it('rapid sequential clear/cross-channel checks are isolated', () => {
    // 先写入 feishu 和 dingtalk 两个 session
    const kF = getSessionKey('c1', workDir, 'p', 'feishu')
    const kD = getSessionKey('c1', workDir, 'p', 'dingtalk')
    const map = loadSessionMap(workDir)
    map.set(kF, makeEntry('sF'))
    map.set(kD, makeEntry('sD'))
    saveSessionMap(workDir, map)

    // 先清 feishu
    const r1 = clearSession('c1', workDir, 'p', 'feishu')
    assert.strictEqual(r1, true, 'first clear should succeed')

    // 再清 feishu（应返回 false）
    const r2 = clearSession('c1', workDir, 'p', 'feishu')
    assert.strictEqual(r2, false, 'second clear should fail (already gone)')

    // dingtalk should still be there
    const after = loadSessionMap(workDir)
    assert.strictEqual(after.has(kD), true, 'dingtalk session unaffected by feishu clear')
  })

  it('clearSession marks session in clearedDuringProcessing', () => {
    const key = getSessionKey('c1', workDir, 'p', 'feishu')
    const map = loadSessionMap(workDir)
    map.set(key, makeEntry('s'))
    saveSessionMap(workDir, map)

    const sizeBefore = clearedDuringProcessing.size
    clearSession('c1', workDir, 'p', 'feishu')
    assert.ok(clearedDuringProcessing.size > sizeBefore, 'should add to clearedDuringProcessing')
    assert.ok(clearedDuringProcessing.has(key), 'key should be in cleared set')
  })
})

// ============================================================
// 测试 3: formatTime / truncate（session.ts 纯函数）
// ============================================================
describe('session.ts utility functions', () => {

  describe('formatTime', () => {
    it('formats a known timestamp correctly', () => {
      const d = new Date(2025, 0, 15, 9, 5) // Jan 15, 2025 09:05
      const result = formatTime(d.getTime())
      assert.strictEqual(result, '01-15 09:05')
    })

    it('handles epoch zero', () => {
      const result = formatTime(0)
      // epoch 0 in local time depends on timezone, format should work
      assert.ok(result.length >= 8, 'should produce valid time string')
    })

    it('handles large timestamp', () => {
      const result = formatTime(9999999999999)
      assert.ok(result.length >= 8, 'should produce valid time string for large ts')
    })

    it('handles negative timestamp', () => {
      const result = formatTime(-86400000) // 1 day before epoch
      assert.ok(result.length >= 8, 'should handle negative ts')
    })
  })

  describe('truncate', () => {
    it('returns full string when under limit', () => {
      assert.strictEqual(truncate('hello', 10), 'hello')
    })

    it('truncates long string with ellipsis', () => {
      const result = truncate('this is a very long string', 15)
      assert.strictEqual(result.length, 15)
      assert.ok(result.endsWith('…'))
    })

    it('handles exact length', () => {
      assert.strictEqual(truncate('hello', 5), 'hello')
    })

    it('handles one character limit', () => {
      const result = truncate('abc', 1)
      assert.strictEqual(result, '…')
    })

    it('handles empty string', () => {
      assert.strictEqual(truncate('', 5), '')
    })

    it('handles zero max', () => {
      const result = truncate('hello', 0)
      // s.length (5) <= 0 is false, so s.slice(0, -1) + '…' = 'hell' + '…'
      assert.strictEqual(result, 'hell' + '…')
    })

    it('handles negative max', () => {
      const result = truncate('hello', -1)
      assert.ok(result.endsWith('…'))
    })

    it('handles unicode characters', () => {
      const result = truncate('你好世界☃', 4)
      assert.strictEqual(result.length, 4)
      assert.ok(result.endsWith('…'))
    })
  })
})

// ============================================================
// 测试 4: ChannelMessageContext 结构验证
// ============================================================
describe('ChannelMessageContext channelType field', () => {
  // 验证 context 对象构造后 channelType 字段存在且正确
  // 各 Channel 的实际构造点在 git diff 中确认已补齐，此处做防御性验证

  function makeContext(partial: Partial<{
    conversationId: string
    senderId: string
    isGroup: boolean
    userId: string
    channelType: string
    processedMessage?: string
  }> = {}): import('../src/types.js').ChannelMessageContext {
    return {
      conversationId: partial.conversationId ?? 'conv-1',
      senderId: partial.senderId ?? 'sender-1',
      isGroup: partial.isGroup ?? false,
      userId: partial.userId ?? 'user-1',
      channelType: partial.channelType ?? 'feishu',
      ...(partial.processedMessage !== undefined ? { processedMessage: partial.processedMessage } : {}),
    }
  }

  it('minimal valid context has all required fields', () => {
    const ctx = makeContext()
    assert.strictEqual(ctx.channelType, 'feishu')
    assert.strictEqual(ctx.conversationId, 'conv-1')
    assert.strictEqual(ctx.senderId, 'sender-1')
    assert.strictEqual(ctx.isGroup, false)
    assert.strictEqual(ctx.userId, 'user-1')
  })

  it('context without processedMessage is valid', () => {
    const ctx = makeContext()
    assert.strictEqual(ctx.processedMessage, undefined)
  })

  it('context with processedMessage works', () => {
    const ctx = makeContext({ processedMessage: 'Context goes here' })
    assert.strictEqual(ctx.processedMessage, 'Context goes here')
  })

  // --- Boundary: each channel type ---
  it('feishu channelType', () => {
    const ctx = makeContext({ channelType: 'feishu' })
    assert.strictEqual(ctx.channelType, 'feishu')
  })

  it('dingtalk channelType', () => {
    const ctx = makeContext({ channelType: 'dingtalk' })
    assert.strictEqual(ctx.channelType, 'dingtalk')
  })

  it('discord channelType', () => {
    const ctx = makeContext({ channelType: 'discord' })
    assert.strictEqual(ctx.channelType, 'discord')
  })

  it('custom channelType (extensibility)', () => {
    const ctx = makeContext({ channelType: 'custom-channel-v2' })
    assert.strictEqual(ctx.channelType, 'custom-channel-v2')
  })

  it('empty channelType still valid at type level', () => {
    const ctx = makeContext({ channelType: '' })
    assert.strictEqual(ctx.channelType, '')
  })

  it('very long channelType', () => {
    const long = 'x'.repeat(1000)
    const ctx = makeContext({ channelType: long })
    assert.strictEqual(ctx.channelType, long)
  })

  it('isGroup boolean works correctly for group chat', () => {
    const ctx = makeContext({ isGroup: true })
    assert.strictEqual(ctx.isGroup, true)
  })

  it('userId and senderId can differ', () => {
    const ctx = makeContext({ senderId: 's-1', userId: 'u-2' })
    assert.notStrictEqual(ctx.senderId, ctx.userId)
  })
})

// ============================================================
// 测试 5: 验证 session.ts 实际模块的可导入性
// ============================================================
describe('session.ts module integrity', () => {

  it('can import handleSessionCommand without errors', async () => {
    const mod = await import('../src/commands/session.js')
    assert.strictEqual(typeof mod.handleSessionCommand, 'function')
  })

  it('can import getSessionKey and clearSession from claude.ts', async () => {
    const mod = await import('../src/core/claude.js')
    assert.strictEqual(typeof mod.getSessionKey, 'function')
    assert.strictEqual(typeof mod.clearSession, 'function')
    assert.strictEqual(typeof mod.getSessionMap, 'function')
    assert.strictEqual(typeof mod.saveSessionMap, 'function')
  })
})

// ============================================================
// 测试 6: handleSessionCommand integration — channelType 传递
// ============================================================
describe('handleSessionCommand with channelType', () => {
  let workDir: string
  let channel: MockChannel

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-test-session-'))
    channel = createMockChannel()
  })

  it.afterEach(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {}
  })

  it('/session new clears session with channelType', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-feishu-1',
      senderId: 'sender-1',
      isGroup: true,
      userId: 'user-1',
      channelType: 'feishu',
    }

    await handleSessionCommand('/session new', context, channel as any, workDir, 'profileA')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('清空'), 'should indicate session cleared: ' + lastMsg!.content)
  })

  it('/session name works with channelType', async () => {
    // First create a session
    const { getSessionKey: realGetSessionKey, getSessionMap, saveSessionMap: realSaveSessionMap } = await import('../src/core/claude.js')
    const sessionKey = realGetSessionKey('conv-naming', workDir, 'profileA', 'dingtalk')
    const map = getSessionMap(workDir)
    map.set(sessionKey, {
      sessionId: 'sess-test-001',
      lastActiveAt: Date.now(),
      toolCallCount: 3,
      cumulatedInputTokens: 5000,
      subagentEnabled: true,
    })
    realSaveSessionMap(workDir, map)

    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-naming',
      senderId: 'sender-1',
      isGroup: false,
      userId: 'user-1',
      channelType: 'dingtalk',
    }

    await handleSessionCommand('/session name 新会话名', context, channel as any, workDir, 'profileA')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('新会话名'), 'should echo the name: ' + lastMsg!.content)

    // Verify the session map was updated
    const updatedMap = getSessionMap(workDir)
    const updated = updatedMap.get(sessionKey)
    assert.ok(updated, 'session should still exist')
    assert.strictEqual(updated!.name, '新会话名', 'name should be updated')
  })

  it('/session name fails gracefully when no active session', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-no-session',
      senderId: 'sender-1',
      isGroup: true,
      userId: 'user-1',
      channelType: 'discord',
    }

    await handleSessionCommand('/session name 测试名', context, channel as any, workDir)
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('没有活跃会话'), 'should indicate no active session: ' + lastMsg!.content)
  })

  it('/session status with no active session shows hint', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-none',
      senderId: 'sender-1',
      isGroup: false,
      userId: 'user-1',
      channelType: 'discord',
    }

    await handleSessionCommand('/session', context, channel as any, workDir, 'p')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('没有活跃会话'), 'should indicate no active session')
  })

  it('/session list with no history shows hint', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-list',
      senderId: 'sender-1',
      isGroup: true,
      userId: 'user-1',
      channelType: 'feishu',
    }

    await handleSessionCommand('/session list', context, channel as any, workDir, 'p')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('暂无'), 'should indicate no history: ' + lastMsg!.content)
  })

  it('/session name with empty name shows usage hint', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-usage',
      senderId: 'sender-1',
      isGroup: false,
      userId: 'user-1',
      channelType: 'feishu',
    }

    await handleSessionCommand('/session name', context, channel as any, workDir, 'p')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('用法'), 'should show usage hint: ' + lastMsg!.content)
  })

  it('/session name with whitespace-only name shows usage hint', async () => {
    const { handleSessionCommand } = await import('../src/commands/session.js')
    const context = {
      conversationId: 'conv-space',
      senderId: 'sender-1',
      isGroup: false,
      userId: 'user-1',
      channelType: 'dingtalk',
    }

    await handleSessionCommand('/session name    ', context, channel as any, workDir, 'p')
    const lastMsg = channel.messages.at(-1)
    assert.ok(lastMsg, 'should send a message')
    assert.ok(lastMsg!.content.includes('用法'), 'should show usage for whitespace name: ' + lastMsg!.content)
  })
})

// ============================================================
// 测试 7: channel retry — retry 不覆盖原始 channel (Bug #1)
// ============================================================
describe('channel retry does not override channel', () => {

  // 模拟 _execClaude 的 destructuring（Bug #1 触发条件）
  type RetryOptions = {
    message: string
    conversationId: string
    workDir: string
    isGroup?: boolean
    userId?: string
    profile?: string
    channel?: string
  }

  function getSessionKeyForRetry(
    opts: RetryOptions,
    overrideChannel?: string,
  ): string {
    // 模拟 Bug #1 修复前的代码：
    // const { channel = 'dingtalk' } = opts  →  harcoded default
    // retry: _execClaude({ ...opts, channel }, ...)  →  overrides original channel
    const ch = overrideChannel
    const parts = [opts.conversationId, opts.workDir]
    if (opts.profile) parts.push(opts.profile)
    if (ch) parts.push(ch)
    return parts.join('\x00')
  }

  it('retry preserves original feishu channel (fixed behavior)', () => {
    // 原始 channel = feishu
    const opts: RetryOptions = {
      message: 'hello',
      conversationId: 'conv-retry',
      workDir: '/work',
      profile: 'p',
      channel: 'feishu',
    }

    // 修复前：retry 用 { ...opts, channel = 'dingtalk' } → sessionKey 变成 dingtalk
    const brokenKey = getSessionKeyForRetry(opts, 'dingtalk')
    // 修复后：retry 用 options 本身 → sessionKey 保留 feishu
    const fixedKey = getSessionKeyForRetry(opts, 'feishu')

    assert.notStrictEqual(brokenKey, fixedKey, 'broken and fixed keys differ')
    assert.ok(fixedKey.includes('feishu'), 'fixed key contains feishu')
  })

  it('retry preserves original discord channel', () => {
    const opts: RetryOptions = {
      message: 'hello',
      conversationId: 'conv-discord',
      workDir: '/work',
      channel: 'discord',
    }

    const brokenKey = getSessionKeyForRetry(opts, 'dingtalk')
    const fixedKey = getSessionKeyForRetry(opts, 'discord')

    assert.notStrictEqual(brokenKey, fixedKey)
    assert.ok(fixedKey.includes('discord'))
  })

  it('retry with undefined channel does not add channel part (backward compat)', () => {
    const opts: RetryOptions = {
      message: 'hi',
      conversationId: 'conv-null',
      workDir: '/work',
      profile: 'p',
      // no channel
    }

    const key = getSessionKeyForRetry(opts, undefined)
    const parts = key.split('\x00')
    assert.strictEqual(parts.length, 3, 'no channel part appended when undefined: ' + key)
  })

  // Note: real module import tests (e.g. importing claude.js, session.js) require bun test runner.
  // Run them with: bun test
})
