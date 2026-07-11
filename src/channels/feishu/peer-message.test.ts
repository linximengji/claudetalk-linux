import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Helper: create temp dir for each test, clean up after
let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'peer-msg-test-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Dynamic import after tmpDir setup
let mod: typeof import('./peer-message.js')
let PeerMessageType: new () => any

beforeEach(async () => {
  mod = await import('./peer-message.js')
})

function makeMsg(overrides: Partial<any> = {}): any {
  return {
    id: randomUUID(),
    from: 'test-bot',
    chatId: 'oc_test',
    messageId: randomUUID(),
    message: 'hello',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('peer-message', () => {
  describe('getPeerMessageFilePath', () => {
    it('returns correct path for bot name', () => {
      const p = mod.getPeerMessageFilePath(tmpDir, 'mybot')
      assert.ok(p.endsWith('/feishu/bot_mybot.json'))
    })
  })

  describe('loadPeerMessages', () => {
    it('returns empty array when file does not exist', () => {
      const msgs = mod.loadPeerMessages(tmpDir, 'nonexistent')
      assert.deepStrictEqual(msgs, [])
    })

    it('returns empty array on corrupt JSON', () => {
      const dir = path.join(tmpDir, 'feishu')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'bot_corrupt.json'), '{bad json', 'utf-8')
      const msgs = mod.loadPeerMessages(tmpDir, 'corrupt')
      assert.deepStrictEqual(msgs, [])
    })
  })

  describe('appendPeerMessage', () => {
    it('creates file and appends message', () => {
      const msg = makeMsg()
      mod.appendPeerMessage(tmpDir, 'testbot', msg)
      const loaded = mod.loadPeerMessages(tmpDir, 'testbot')
      assert.strictEqual(loaded.length, 1)
      assert.strictEqual(loaded[0].id, msg.id)
      assert.strictEqual(loaded[0].message, 'hello')
    })

    it('appends to existing file', () => {
      mod.appendPeerMessage(tmpDir, 'multi', makeMsg({ id: 'm1' }))
      mod.appendPeerMessage(tmpDir, 'multi', makeMsg({ id: 'm2' }))
      const loaded = mod.loadPeerMessages(tmpDir, 'multi')
      assert.strictEqual(loaded.length, 2)
      assert.strictEqual(loaded[0].id, 'm1')
      assert.strictEqual(loaded[1].id, 'm2')
    })

    it('handles many messages without data loss', () => {
      const N = 50
      for (let i = 0; i < N; i++) {
        mod.appendPeerMessage(tmpDir, 'bulk', makeMsg({ id: `bulk_${i}` }))
      }
      const loaded = mod.loadPeerMessages(tmpDir, 'bulk')
      assert.strictEqual(loaded.length, N)
    })
  })

  describe('removePeerMessages', () => {
    it('removes specified messages by id', () => {
      mod.appendPeerMessage(tmpDir, 'rmtest', makeMsg({ id: 'keep' }))
      mod.appendPeerMessage(tmpDir, 'rmtest', makeMsg({ id: 'remove' }))
      mod.removePeerMessages(tmpDir, 'rmtest', new Set(['remove']))
      const loaded = mod.loadPeerMessages(tmpDir, 'rmtest')
      assert.strictEqual(loaded.length, 1)
      assert.strictEqual(loaded[0].id, 'keep')
    })

    it('removing nothing keeps all messages', () => {
      mod.appendPeerMessage(tmpDir, 'none', makeMsg({ id: 'a' }))
      mod.appendPeerMessage(tmpDir, 'none', makeMsg({ id: 'b' }))
      mod.removePeerMessages(tmpDir, 'none', new Set())
      assert.strictEqual(mod.loadPeerMessages(tmpDir, 'none').length, 2)
    })

    it('removing non-existent id is no-op', () => {
      mod.appendPeerMessage(tmpDir, 'ghost', makeMsg({ id: 'real' }))
      mod.removePeerMessages(tmpDir, 'ghost', new Set(['phantom']))
      assert.strictEqual(mod.loadPeerMessages(tmpDir, 'ghost').length, 1)
    })
  })

  describe('parseAtMentions', () => {
    it('extracts single @mention from text', () => {
      const result = mod.parseAtMentions('hello <at user_id="ou_abc">Bot A</at> world')
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].userId, 'ou_abc')
      assert.strictEqual(result[0].name, 'Bot A')
    })

    it('extracts multiple @mentions', () => {
      const result = mod.parseAtMentions(
        '<at user_id="ou_1">Bot1</at> and <at user_id="ou_2">Bot2</at>'
      )
      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].userId, 'ou_1')
      assert.strictEqual(result[1].userId, 'ou_2')
    })

    it('returns empty array when no @mention', () => {
      const result = mod.parseAtMentions('just plain text')
      assert.deepStrictEqual(result, [])
    })

    it('handles malformed @tag gracefully', () => {
      const result = mod.parseAtMentions('<at user_id=no-quote>name</at>')
      assert.deepStrictEqual(result, [])
    })
  })
})
