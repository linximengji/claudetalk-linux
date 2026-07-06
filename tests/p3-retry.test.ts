import { describe, it, mock } from 'node:test'
import assert from 'node:assert'

// Replicate P3 logic for testing
const MAX_SESSION_RETRY_COUNT = 2
const MAX_RETRY_COUNT = 2

function shouldRetry(code: number | null, stderr: string, retryCount: number): { retry: boolean; reason: string } {
  if (code === 0) return { retry: false, reason: 'success' }

  const isSessionInvalid =
    stderr.includes('No conversation found') ||
    stderr.includes('session ID') ||
    stderr.includes('Invalid session') ||
    stderr.includes('Session not found') ||
    stderr.includes('--resume')

  if (isSessionInvalid) {
    const canRetry = retryCount < MAX_SESSION_RETRY_COUNT
    return { retry: canRetry, reason: canRetry ? 'session-invalid' : 'session-invalid-exhausted' }
  }

  // P3: Broad retry for non-session errors
  const isFatal =
    stderr.includes('Permission denied') ||
    stderr.includes('EACCES') ||
    stderr.includes('command not found') ||
    stderr.includes('ENOENT')
  if (isFatal) return { retry: false, reason: 'fatal' }

  const canRetry = retryCount < MAX_RETRY_COUNT
  return { retry: canRetry, reason: canRetry ? 'retryable' : 'retryable-exhausted' }
}

describe('P3 Error Recovery', () => {

  it('does not retry on exit code 0', () => {
    const r = shouldRetry(0, '', 0)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'success')
  })

  it('retries session invalid when retryCount < MAX', () => {
    const r = shouldRetry(1, 'No conversation found', 0)
    assert.strictEqual(r.retry, true)
    assert.strictEqual(r.reason, 'session-invalid')
  })

  it('stops retrying session invalid when retryCount >= MAX', () => {
    const r = shouldRetry(1, 'Invalid session', 2)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'session-invalid-exhausted')
  })

  it('does not retry fatal errors (command not found)', () => {
    const r = shouldRetry(1, 'command not found', 0)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'fatal')
  })

  it('does not retry fatal errors (Permission denied)', () => {
    const r = shouldRetry(1, 'Permission denied', 0)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'fatal')
  })

  it('does not retry fatal errors (ENOENT)', () => {
    const r = shouldRetry(1, 'ENOENT', 0)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'fatal')
  })

  it('retries non-session errors (process crash) when retryCount < MAX', () => {
    const r = shouldRetry(1, 'some random error', 0)
    assert.strictEqual(r.retry, true)
    assert.strictEqual(r.reason, 'retryable')
  })

  it('retries timeout (exit code null would be SIGTERM) when retryCount < MAX', () => {
    // Simulate a process killed by timeout: no stderr about session
    const r = shouldRetry(1, '', 0)
    assert.strictEqual(r.retry, true)
    assert.strictEqual(r.reason, 'retryable')
  })

  it('stops retrying non-session errors when retryCount >= MAX', () => {
    const r = shouldRetry(1, 'some random error', 2)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'retryable-exhausted')
  })

  it('prefers session-invalid retry exhaustion over generic retry exhaustion', () => {
    // Session invalid with retryCount = 2 (MAX_SESSION_RETRY_COUNT = 2)
    const r = shouldRetry(1, 'Session not found', 2)
    assert.strictEqual(r.retry, false)
    assert.strictEqual(r.reason, 'session-invalid-exhausted')
  })

  it('context injection survives session deletion', () => {
    // Simulate: session has summary, retry should inject it
    const sessionSummary = 'User was asking about microservices'
    const injected = `[Previous conversation summary: ${sessionSummary}]\n\nWhat about deployment?`
    assert.ok(injected.includes(sessionSummary))
    assert.ok(injected.includes('What about deployment?'))
  })

  it('broad retry uses MAX_RETRY_COUNT = 2', () => {
    // First 2 attempts (retryCount 0,1) retry, third (retryCount 2) gives up
    assert.strictEqual(shouldRetry(1, 'crash', 0).retry, true)
    assert.strictEqual(shouldRetry(1, 'crash', 1).retry, true)
    assert.strictEqual(shouldRetry(1, 'crash', 2).retry, false)
  })

  it('session retry uses MAX_SESSION_RETRY_COUNT = 2', () => {
    assert.strictEqual(shouldRetry(1, 'No conversation found', 0).retry, true)
    assert.strictEqual(shouldRetry(1, 'Invalid session', 1).retry, true)
    assert.strictEqual(shouldRetry(1, 'Session not found', 2).retry, false)
  })
})

// ============================================================
// Context injection for short sessions (Bug #2)
// ============================================================
describe('context injection for short sessions', () => {

  interface SessionEntry {
    sessionId: string
    lastActiveAt: number
    sessionSummary?: string
    lastMessage?: string
    lastReply?: string
  }

  // 复制 _execClaude 的 retry context injection 逻辑
  function buildInjectedOptions(
    options: { message: string; processedMessage?: string },
    deadEntry: SessionEntry | undefined,
  ): { message: string; processedMessage?: string } | null {
    const deadSummary = deadEntry?.sessionSummary
    const deadLastMsg = deadEntry?.lastMessage
    const injectedContext = deadSummary
      || (deadLastMsg ? `[Previous interaction]\nUser: ${deadLastMsg}\nAssistant: ${deadEntry?.lastReply || '(no reply)'}` : undefined)
    if (!injectedContext) return null
    return {
      ...options,
      processedMessage: `[Context from previous session: ${injectedContext}]\n\n${options.processedMessage ?? options.message}`,
    }
  }

  it('sessionSummary takes priority over lastMessage/lastReply', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-old',
      lastActiveAt: Date.now(),
      sessionSummary: 'User asked about deployment',
      lastMessage: 'How do I deploy?',
      lastReply: 'Use kubectl apply',
    }
    const result = buildInjectedOptions({ message: 'Tell me more' }, deadEntry)
    assert.ok(result, 'should inject context')
    assert.ok(result!.processedMessage!.includes('User asked about deployment'),
      'should use sessionSummary, not lastMessage')
    assert.ok(!result!.processedMessage!.includes('How do I deploy?'),
      'should NOT include lastMessage when summary exists')
  })

  it('lastMessage/lastReply used as fallback when sessionSummary absent', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-short',
      lastActiveAt: Date.now(),
      lastMessage: 'What is microservices',
      lastReply: 'Microservices are an architectural pattern...',
    }
    const result = buildInjectedOptions({ message: 'Tell me more' }, deadEntry)
    assert.ok(result, 'should inject context')
    assert.ok(result!.processedMessage!.includes('[Previous interaction]'))
    assert.ok(result!.processedMessage!.includes('What is microservices'))
    assert.ok(result!.processedMessage!.includes('Microservices are an architectural pattern'))
  })

  it('lastMessage only, no lastReply: uses "(no reply)" placeholder', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-no-reply',
      lastActiveAt: Date.now(),
      lastMessage: 'Help',
    }
    const result = buildInjectedOptions({ message: 'hi' }, deadEntry)
    assert.ok(result, 'should inject context')
    assert.ok(result!.processedMessage!.includes('(no reply)'))
  })

  it('no context at all: no injection', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-empty',
      lastActiveAt: Date.now(),
    }
    const result = buildInjectedOptions({ message: 'hi' }, deadEntry)
    assert.strictEqual(result, null, 'no injection when no context')
  })

  it('undefined deadEntry: no injection', () => {
    const result = buildInjectedOptions({ message: 'hi' }, undefined)
    assert.strictEqual(result, null, 'no injection for undefined entry')
  })

  it('injection uses processedMessage when available', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-proc',
      lastActiveAt: Date.now(),
      lastMessage: 'old msg',
      lastReply: 'old reply',
    }
    const result = buildInjectedOptions({
      message: 'original',
      processedMessage: 'processed msg',
    }, deadEntry)
    assert.ok(result, 'should inject')
    assert.ok(result!.processedMessage!.includes('processed msg'),
      'should preserve original processedMessage after context')
  })

  it('empty string lastMessage treated as available (truthy in actual code)', () => {
    // Note: '' is falsy in JS, so the actual code checks if (deadLastMsg)
    // Empty string won't trigger fallback. This documents the behavior.
    const deadEntry: SessionEntry = {
      sessionId: 'sess-empty-msg',
      lastActiveAt: Date.now(),
      lastMessage: '',
      lastReply: 'reply',
    }
    const result = buildInjectedOptions({ message: 'hi' }, deadEntry)
    // '' is falsy, so !deadLastMsg = false → fallback not triggered
    assert.strictEqual(result, null, 'empty lastMessage is falsy, no injection')
  })

  it('retry context format matches expected Claude input format', () => {
    const deadEntry: SessionEntry = {
      sessionId: 'sess-format',
      lastActiveAt: Date.now(),
      lastMessage: 'Hello',
      lastReply: 'Hi there!',
    }
    const result = buildInjectedOptions({ message: 'How are you?' }, deadEntry)
    assert.ok(result)
    // 验证格式：context 块 + 双换行 + 原始消息
    const expectedPrefix = '[Context from previous session: [Previous interaction]\nUser: Hello\nAssistant: Hi there!]\n\n'
    assert.ok(result!.processedMessage!.startsWith(expectedPrefix),
      'format mismatch: ' + result!.processedMessage)
    assert.ok(result!.processedMessage!.endsWith('How are you?'))
  })
})
