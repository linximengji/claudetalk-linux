import { describe, it } from 'node:test'
import assert from 'node:assert'
import { dedupeRepetitiveSentences } from './index.js'
import { getSessionKey } from './core/claude.js'

describe('dedupeRepetitiveSentences', () => {
  it('collapses >=3 identical lines into one line + " ..."', () => {
    assert.strictEqual(dedupeRepetitiveSentences('a\na\na\nb'), 'a\n ...\nb')
  })

  it('collapses a fully-repeated run', () => {
    assert.strictEqual(dedupeRepetitiveSentences('x\nx\nx'), 'x\n ...')
  })

  it('leaves a 2-line run unchanged', () => {
    assert.strictEqual(dedupeRepetitiveSentences('y\ny'), 'y\ny')
  })
})

describe('getSessionKey profile normalization', () => {
  it('normalizes junk-suffixed and padded profiles, and equals the clean profile key', () => {
    const base = ['cid', '/work']
    const clean = getSessionKey(base[0], base[1], 'claude code')
    const junk = getSessionKey(base[0], base[1], 'claude code\x00junk')
    const padded = getSessionKey(base[0], base[1], ' claude code ')

    assert.strictEqual(junk, clean)
    assert.strictEqual(padded, clean)

    const junkSeg = junk.split('\x00')[2]
    const paddedSeg = padded.split('\x00')[2]
    assert.ok(!junk.includes('\x00' + 'junk'))
    assert.strictEqual(junkSeg, 'claude code')
    assert.strictEqual(paddedSeg, 'claude code')
    assert.ok(!junkSeg.startsWith(' '))
    assert.ok(!junkSeg.endsWith(' '))
  })

  it('keeps NUL only as the delimiter between parts', () => {
    const key = getSessionKey('cid', '/work', 'claude code')
    const parts = key.split('\x00')
    assert.strictEqual(parts.length, 3)
    assert.deepStrictEqual(parts, ['cid', '/work', 'claude code'])
  })
})
