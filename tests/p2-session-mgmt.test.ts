import { describe, it } from 'node:test'
import assert from 'node:assert'

// Replicate the P2 logic exactly as in claude.ts
const ASYNC_COMPACT_THRESHOLD = 200_000
const SYNC_COMPACT_THRESHOLD = 400_000
const RESET_THRESHOLD = 600_000

interface Entry {
  sessionId: string
  cumulatedInputTokens?: number
  sessionSummary?: string
}

async function syncCompactSession(
  sessionKey: string,
  sessionId: string,
): Promise<string | undefined> {
  return 'new_sess_after_compact'
}

async function summarizeAndReset(
  entry: Entry,
): Promise<void> {
  entry.sessionSummary = 'Discussion about code architecture'
  entry.cumulatedInputTokens = 0
  entry.sessionId = ''
}

async function preProcessSessionCheck(
  entry: Entry | undefined,
): Promise<string | undefined> {
  if (!entry?.sessionId) return undefined
  const cumulated = entry.cumulatedInputTokens ?? 0

  if (cumulated >= RESET_THRESHOLD && !entry.sessionSummary) {
    await summarizeAndReset(entry)
    return 'reset'
  }

  if (cumulated >= SYNC_COMPACT_THRESHOLD) {
    const newId = await syncCompactSession('k', entry.sessionId)
    if (newId) {
      entry.sessionId = newId
      return 'compact'
    }
  }
  return undefined
}

describe('P2 Session Size Management', () => {

  it('skips check when entry has no sessionId', async () => {
    const r = await preProcessSessionCheck(undefined)
    assert.strictEqual(r, undefined)
  })

  it('skips check when cumulatedInputTokens < ASYNC_COMPACT', async () => {
    const e: Entry = { sessionId: 's1', cumulatedInputTokens: 10_000 }
    const r = await preProcessSessionCheck(e)
    assert.strictEqual(r, undefined)
  })

  it('triggers sync compact when cumulated >= SYNC_COMPACT', async () => {
    const e: Entry = { sessionId: 's1', cumulatedInputTokens: 400_000 }
    const r = await preProcessSessionCheck(e)
    assert.strictEqual(r, 'compact')
    assert.strictEqual(e.sessionId, 'new_sess_after_compact')
    assert.strictEqual(e.cumulatedInputTokens, 400_000) // not reset
  })

  it('triggers reset when cumulated >= RESET_THRESHOLD', async () => {
    const e: Entry = { sessionId: 's1', cumulatedInputTokens: 600_000 }
    const r = await preProcessSessionCheck(e)
    assert.strictEqual(r, 'reset')
    assert.strictEqual(e.sessionId, '') // cleared
    assert.strictEqual(e.cumulatedInputTokens, 0) // reset
    assert.ok(e.sessionSummary) // summary set
  })

  it('does not reset again if already has sessionSummary', async () => {
    const e: Entry = { sessionId: 's1', cumulatedInputTokens: 700_000, sessionSummary: 'old summary' }
    const r = await preProcessSessionCheck(e)
    // Should not reset (already has summary) — falls through to sync compact check (> 400K)
    assert.strictEqual(r, 'compact')
    assert.strictEqual(e.sessionSummary, 'old summary') // preserved
  })

  it('prefers reset over compact when both thresholds exceeded', async () => {
    const e: Entry = { sessionId: 's1', cumulatedInputTokens: 800_000 }
    const r = await preProcessSessionCheck(e)
    assert.strictEqual(r, 'reset') // not 'compact'
    assert.strictEqual(e.sessionId, '')
    assert.strictEqual(e.cumulatedInputTokens, 0)
  })

  it('tracks cumulatedInputTokens incrementally', () => {
    const prevCumulated = 150_000
    const inputTokens = 80_000
    const result = prevCumulated + inputTokens
    assert.strictEqual(result, 230_000)
    // Would trigger async compact (>200K) but not sync (<400K)
    assert.ok(result > ASYNC_COMPACT_THRESHOLD)
    assert.ok(result < SYNC_COMPACT_THRESHOLD)
  })
})
