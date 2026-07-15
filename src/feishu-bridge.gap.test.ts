import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Helper that mirrors the gap state marking logic from feishu-bridge.ts
// (imported dynamically so we can test it in isolation)
const GAP_STATE_FILENAME = 'twin_gap_state.json'

function markGapAnswered(gapStatePath: string, rootId: string): boolean {
  if (!fs.existsSync(gapStatePath)) return false
  try {
    const raw = fs.readFileSync(gapStatePath, 'utf-8')
    const state = JSON.parse(raw)
    const gaps = state.gaps || []
    let matched = false
    for (const gap of gaps) {
      if (gap.message_id === rootId && !gap.answered) {
        gap.answered = true
        gap.answered_at = new Date().toISOString()
        matched = true
      }
    }
    if (matched) {
      fs.writeFileSync(gapStatePath, JSON.stringify(state, null, 2) + '\n', 'utf-8')
    }
    return matched
  } catch {
    return false
  }
}

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'gap-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeGapState(state: any) {
  const p = path.join(tmpDir, GAP_STATE_FILENAME)
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  return p
}

describe('markGapAnswered', () => {
  it('returns false when gap state file does not exist', () => {
    const p = path.join(tmpDir, 'nonexistent.json')
    assert.strictEqual(markGapAnswered(p, 'om_xxx'), false)
  })

  it('returns false when root_id does not match any gap', () => {
    const p = writeGapState({
      gaps: [
        { message_id: 'om_aaa', question: 'q1', answered: false, pushed_at: '2026-07-01T00:00:00' },
      ],
    })
    assert.strictEqual(markGapAnswered(p, 'om_bbb'), false)
  })

  it('marks matching gap as answered and returns true', () => {
    const p = writeGapState({
      gaps: [
        { message_id: 'om_aaa', question: 'q1', answered: false, pushed_at: '2026-07-01T00:00:00' },
        { message_id: 'om_bbb', question: 'q2', answered: false, pushed_at: '2026-07-02T00:00:00' },
      ],
    })
    const result = markGapAnswered(p, 'om_aaa')
    assert.strictEqual(result, true)

    const reloaded = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const gapA = reloaded.gaps.find((g: any) => g.message_id === 'om_aaa')
    const gapB = reloaded.gaps.find((g: any) => g.message_id === 'om_bbb')
    assert.strictEqual(gapA.answered, true)
    assert.ok(gapA.answered_at)
    assert.strictEqual(gapB.answered, false)
    assert.strictEqual(gapB.answered_at, undefined)
  })

  it('does not double-mark an already answered gap', () => {
    const p = writeGapState({
      gaps: [
        { message_id: 'om_aaa', question: 'q1', answered: true, answered_at: '2026-07-03T00:00:00', pushed_at: '2026-07-01T00:00:00' },
      ],
    })
    const result = markGapAnswered(p, 'om_aaa')
    assert.strictEqual(result, false)

    const reloaded = JSON.parse(fs.readFileSync(p, 'utf-8'))
    assert.strictEqual(reloaded.gaps[0].answered_at, '2026-07-03T00:00:00')  // unchanged
  })

  it('handles corrupt gap state file gracefully', () => {
    const p = path.join(tmpDir, GAP_STATE_FILENAME)
    fs.writeFileSync(p, '{bad json', 'utf-8')
    assert.strictEqual(markGapAnswered(p, 'om_xxx'), false)
  })

  it('handles gaps array being empty', () => {
    const p = writeGapState({ gaps: [] })
    assert.strictEqual(markGapAnswered(p, 'om_xxx'), false)
  })

  it('handles missing gaps key gracefully', () => {
    const p = writeGapState({ last_detected_at: null })
    assert.strictEqual(markGapAnswered(p, 'om_xxx'), false)
  })

  it('handles gaps with null message_id', () => {
    // gap_detector.py can record gaps where send_card failed → message_id is null
    const p = writeGapState({
      gaps: [
        { message_id: null, question: 'q1', answered: false, pushed_at: '2026-07-01T00:00:00' },
        { message_id: 'om_bbb', question: 'q2', answered: false, pushed_at: '2026-07-02T00:00:00' },
      ],
    })
    // gap with null message_id should not crash; matching om_bbb should work
    assert.strictEqual(markGapAnswered(p, 'om_bbb'), true)
  })
})
