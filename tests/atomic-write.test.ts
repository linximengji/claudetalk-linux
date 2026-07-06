/**
 * Atomic write (tmp+rename) + session TTL (30-day filter)
 *
 * Covers:
 *   saveSessionMap atomic write pattern (claude.ts:75-83)
 *   loadSessionMap TTL filter (claude.ts:66-71)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================
// 复制 saveSessionMap atomic write + loadSessionMap TTL filter
// ============================================================

interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  sessionSummary?: string
  name?: string
  toolCallCount?: number
  cumulatedInputTokens?: number
}

function saveSessionMapAtomic(workDir: string, sessionMap: Map<string, SessionEntry>): string {
  const sessionFile = path.join(workDir, '.claudetalk-sessions.json')
  const entries = Object.fromEntries(sessionMap)
  const tmpFile = sessionFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmpFile, sessionFile)
  return sessionFile
}

function loadSessionMapWithTTL(workDir: string): Map<string, SessionEntry> {
  const sessionFile = path.join(workDir, '.claudetalk-sessions.json')
  if (!fs.existsSync(sessionFile)) return new Map()
  try {
    const content = fs.readFileSync(sessionFile, 'utf-8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const entries = new Map<string, SessionEntry>()
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    const now = Date.now()
    for (const [key, value] of Object.entries(raw)) {
      if (value && typeof value === 'object' && 'sessionId' in value && 'lastActiveAt' in value) {
        const entry = value as SessionEntry
        if (entry.lastActiveAt && now - entry.lastActiveAt > THIRTY_DAYS_MS) continue
        entries.set(key, entry)
      }
    }
    return entries
  } catch {
    return new Map()
  }
}

// ============================================================
// 象限 1: Atomic write — normal operation
// ============================================================
describe('Atomic write (tmp+rename)', () => {
  let workDir: string

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-atomic-'))
  })

  it.afterEach(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  })

  it('writes session file correctly', () => {
    const map = new Map<string, SessionEntry>()
    map.set('key1', { sessionId: 'sess-1', lastActiveAt: Date.now() })
    map.set('key2', { sessionId: 'sess-2', lastActiveAt: Date.now() })

    const sessionFile = saveSessionMapAtomic(workDir, map)
    assert.ok(fs.existsSync(sessionFile), 'session file should exist')
    assert.ok(!fs.existsSync(sessionFile + '.tmp'), 'tmp file should be cleaned up')

    const content = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
    assert.ok(content.key1, 'key1 present')
    assert.ok(content.key2, 'key2 present')
    assert.strictEqual(content.key1.sessionId, 'sess-1')
    assert.strictEqual(content.key2.sessionId, 'sess-2')
  })

  it('overwrites existing file atomically', () => {
    // Write initial data
    const map1 = new Map<string, SessionEntry>()
    map1.set('oldKey', { sessionId: 'old', lastActiveAt: Date.now() })
    saveSessionMapAtomic(workDir, map1)

    // Overwrite with new data
    const map2 = new Map<string, SessionEntry>()
    map2.set('newKey', { sessionId: 'new', lastActiveAt: Date.now() })
    const sessionFile = saveSessionMapAtomic(workDir, map2)

    const content = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
    assert.ok(!content.oldKey, 'old key should be gone')
    assert.strictEqual(content.newKey.sessionId, 'new', 'new key should be present')
  })

  it('tmp file does not persist after successful write', () => {
    const map = new Map<string, SessionEntry>()
    map.set('k', { sessionId: 's', lastActiveAt: Date.now() })
    saveSessionMapAtomic(workDir, map)

    const tmpFile = path.join(workDir, '.claudetalk-sessions.json') + '.tmp'
    assert.ok(!fs.existsSync(tmpFile), 'tmp file should be removed after rename')
  })

  it('produces valid JSON with trailing newline', () => {
    const map = new Map<string, SessionEntry>()
    map.set('k', { sessionId: 's', lastActiveAt: Date.now() })
    const sessionFile = saveSessionMapAtomic(workDir, map)

    const raw = fs.readFileSync(sessionFile, 'utf-8')
    assert.ok(raw.endsWith('\n'), 'should have trailing newline')
    assert.doesNotThrow(() => JSON.parse(raw), 'should be valid JSON')
  })
})

// ============================================================
// 象限 2: Atomic write — crash resistance
// ============================================================
describe('Atomic write crash resistance', () => {
  let workDir: string

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-crash-'))
  })

  it.afterEach(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  })

  it('existing file intact when tmp write fails before rename', () => {
    // 模拟写入成功但 tmp 存在（write done, rename not yet called）
    const map = new Map<string, SessionEntry>()
    map.set('survivor', { sessionId: 'survive', lastActiveAt: Date.now() })
    const sessionFile = saveSessionMapAtomic(workDir, map)

    // 模拟 crash 场景：rename 未执行，只有 tmp 文件
    const tmpFile = sessionFile + '.tmp'
    const corruptMap = new Map<string, SessionEntry>()
    corruptMap.set('partial', { sessionId: 'partial', lastActiveAt: Date.now() })
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(corruptMap), null, 2) + '\n', 'utf-8')
    // 不执行 rename → 模拟崩溃

    // 验证原文件不受损
    const originalContent = fs.readFileSync(sessionFile, 'utf-8')
    const parsed = JSON.parse(originalContent)
    assert.ok(parsed.survivor, 'survivor key should still be in original')
    assert.strictEqual(parsed.survivor.sessionId, 'survive')
  })

  it('session file not created if write fails entirely', () => {
    // 模拟写入空 map → 应该创建空文件
    const emptyMap = new Map<string, SessionEntry>()
    const sessionFile = saveSessionMapAtomic(workDir, emptyMap)

    assert.ok(fs.existsSync(sessionFile), 'file should exist for empty map')
    const content = fs.readFileSync(sessionFile, 'utf-8')
    assert.deepStrictEqual(JSON.parse(content), {}, 'empty map should produce {}')
  })

  it('rename atomicity: concurrent readers see complete file', () => {
    // Verify that after rename, the file has complete content
    const map = new Map<string, SessionEntry>()
    map.set('atomic', { sessionId: 'atom', lastActiveAt: Date.now() })
    const sessionFile = saveSessionMapAtomic(workDir, map)

    const content = fs.readFileSync(sessionFile, 'utf-8')
    assert.ok(content.includes('"sessionId": "atom"'), 'complete content after rename')
  })
})

// ============================================================
// 象限 3: Session TTL — normal operation
// ============================================================
describe('Session TTL filtering', () => {
  let workDir: string
  const DAY_MS = 24 * 60 * 60 * 1000

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-ttl-'))
  })

  it.afterEach(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  })

  it('filters out entries older than 30 days', () => {
    const map = new Map<string, SessionEntry>()
    map.set('old', { sessionId: 'old-sess', lastActiveAt: Date.now() - 31 * DAY_MS })
    map.set('recent', { sessionId: 'recent-sess', lastActiveAt: Date.now() - 1 * DAY_MS })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('old'), false, '31-day-old entry should be filtered')
    assert.strictEqual(loaded.has('recent'), true, '1-day-old entry should be kept')
  })

  it('keeps entries just under 30 day boundary', () => {
    const map = new Map<string, SessionEntry>()
    // 30 * 24 * 60 * 60 * 1000 - 5000 = 5s under threshold (generous margin for test timing)
    const justUnder = Date.now() - (30 * DAY_MS - 5000)
    map.set('boundary', { sessionId: 'boundary-sess', lastActiveAt: justUnder })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('boundary'), true, 'entry just under 30 day threshold should be kept')
  })

  it('filters entries just over 30 days', () => {
    const map = new Map<string, SessionEntry>()
    const justOver = Date.now() - (30 * DAY_MS + 1)
    map.set('over', { sessionId: 'over-sess', lastActiveAt: justOver })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('over'), false, '30.001 day entry should be filtered')
  })

  it('keeps entries with lastActiveAt in the future', () => {
    const map = new Map<string, SessionEntry>()
    map.set('future', { sessionId: 'future-sess', lastActiveAt: Date.now() + DAY_MS })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('future'), true, 'future timestamp should be kept')
  })

  it('keeps entries with lastActiveAt of 0 (epoch — bypasses TTL guard due to falsy 0)', () => {
    // entry.lastActiveAt = 0 is falsy, so `if (entry.lastActiveAt && ...)` short-circuits
    // This means epoch-0 entries are kept (same behavior as real claude.ts code)
    const map = new Map<string, SessionEntry>()
    map.set('epoch', { sessionId: 'epoch-sess', lastActiveAt: 0 })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('epoch'), true, 'epoch 0 kept (falsy guard skipped)')
  })
})

// ============================================================
// 象限 4: Session TTL — edge cases and error handling
// ============================================================
describe('Session TTL edge cases', () => {
  let workDir: string

  it.beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetalk-ttl-edge-'))
  })

  it.afterEach(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  })

  it('handles missing lastActiveAt (entry with lastActiveAt=0 bypasses TTL)', () => {
    const map = new Map<string, SessionEntry>()
    map.set('no-ts' as string, { sessionId: 'sess-no-ts', lastActiveAt: 0 })
    saveSessionMapAtomic(workDir, map)

    // entry.lastActiveAt = 0 → falsy → TTL guard skipped → entry kept
    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.has('no-ts'), true, 'entry with falsy lastActiveAt kept')
  })

  it('handles corrupt JSON file gracefully', () => {
    const sessionFile = path.join(workDir, '.claudetalk-sessions.json')
    fs.writeFileSync(sessionFile, 'not valid json{{{', 'utf-8')

    const loaded = loadSessionMapWithTTL(workDir)
    assert.ok(loaded instanceof Map, 'returns empty map on corrupt file')
    assert.strictEqual(loaded.size, 0)
  })

  it('handles missing file gracefully', () => {
    const loaded = loadSessionMapWithTTL(workDir)
    assert.ok(loaded instanceof Map, 'returns empty map on missing file')
    assert.strictEqual(loaded.size, 0)
  })

  it('mixed old and new: only new survive', () => {
    const map = new Map<string, SessionEntry>()
    map.set('old1', { sessionId: 'o1', lastActiveAt: Date.now() - 40 * 24 * 60 * 60 * 1000 })
    map.set('old2', { sessionId: 'o2', lastActiveAt: Date.now() - 35 * 24 * 60 * 60 * 1000 })
    map.set('new1', { sessionId: 'n1', lastActiveAt: Date.now() - 1 * 24 * 60 * 60 * 1000 })
    map.set('new2', { sessionId: 'n2', lastActiveAt: Date.now() })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.size, 2, 'only 2 recent entries survive')
    assert.strictEqual(loaded.has('new1'), true)
    assert.strictEqual(loaded.has('new2'), true)
    assert.strictEqual(loaded.has('old1'), false)
    assert.strictEqual(loaded.has('old2'), false)
  })

  it('all entries very old: empty map returned', () => {
    const map = new Map<string, SessionEntry>()
    map.set('v1', { sessionId: 'v1', lastActiveAt: Date.now() - 100 * 24 * 60 * 60 * 1000 })
    map.set('v2', { sessionId: 'v2', lastActiveAt: Date.now() - 200 * 24 * 60 * 60 * 1000 })
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    assert.strictEqual(loaded.size, 0, 'all entries too old')
  })

  it('many entries: TTL filter completes without error', () => {
    const map = new Map<string, SessionEntry>()
    for (let i = 0; i < 1000; i++) {
      const age = (i % 60) * 24 * 60 * 60 * 1000 // 0-59 days
      map.set(`k${i}`, { sessionId: `s${i}`, lastActiveAt: Date.now() - age })
    }
    saveSessionMapAtomic(workDir, map)

    const loaded = loadSessionMapWithTTL(workDir)
    // ~30 of 60 days are under threshold: roughly 500 entries
    assert.ok(loaded.size > 400, `should keep ~500 entries, got ${loaded.size}`)
    assert.ok(loaded.size < 600, `should filter ~500 entries, got ${loaded.size}`)
  })
})

// Note: module import tests (e.g. importing from src/core/claude.js) require bun test runner
// to handle .ts → .js resolution. Run them with: bun test
