import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { downloadImage, downloadFile, recognizeSpeech } from './resources.js'

const WORK_DIR = process.cwd()
const IMAGE_DIR = path.join(WORK_DIR, '.claudetalk', 'feishu', 'images')
const FILE_DIR = path.join(WORK_DIR, '.claudetalk', 'feishu', 'files')
const API_BASE = 'https://open.feishu.cn/open-apis'

function cleanDirs() {
  for (const dir of [IMAGE_DIR, FILE_DIR]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, f))
      }
    }
  }
}

function withFetch<T>(response: object, fn: () => Promise<T>): Promise<T> {
  const origFetch = globalThis.fetch
  globalThis.fetch = (() => response) as typeof globalThis.fetch
  return fn().finally(() => { globalThis.fetch = origFetch })
}

const OK_10B = {
  ok: true as const, status: 200,
  headers: new Headers({ 'content-length': '10' }),
  arrayBuffer: async () => new ArrayBuffer(10),
}
const FORBIDDEN = { ok: false as const, status: 403, headers: new Headers() }
const TOO_BIG_IMG = {
  ok: true as const, status: 200,
  headers: new Headers({ 'content-length': String(21 * 1024 * 1024) }),
  arrayBuffer: async () => new ArrayBuffer(100),
}
const OVERSIZED_BUF = {
  ok: true as const, status: 200,
  headers: new Headers({ 'content-length': '100' }),
  arrayBuffer: async () => new ArrayBuffer(21 * 1024 * 1024 + 1),
}
const TOO_BIG_FILE = {
  ok: true as const, status: 200,
  headers: new Headers({ 'content-length': String(51 * 1024 * 1024) }),
  arrayBuffer: async () => new ArrayBuffer(100),
}
const SPEECH_OK = {
  ok: true as const, status: 200,
  json: async () => ({ code: 0, msg: 'ok', data: { recognition_text: '你好世界' } }),
}
const SPEECH_FAIL = { ok: false as const, status: 500 }

describe('resources', () => {
  beforeEach(cleanDirs)
  afterEach(cleanDirs)

  describe('downloadImage', () => {
    it('returns cached path for existing image', async () => {
      const safeKey = 'img_test123'
      const localPath = path.join(IMAGE_DIR, `${safeKey}.jpg`)
      if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true })
      fs.writeFileSync(localPath, 'fake-image-data')

      const result = await downloadImage('img_test123', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, localPath)
    })

    it('returns null on non-ok response', () => withFetch(FORBIDDEN, async () => {
      const result = await downloadImage('img_new', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, null)
    }))

    it('returns null when content-length exceeds 20MB', () => withFetch(TOO_BIG_IMG, async () => {
      const result = await downloadImage('img_big', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, null)
    }))

    it('returns null when arrayBuffer exceeds 20MB', () => withFetch(OVERSIZED_BUF, async () => {
      const result = await downloadImage('img_oversized', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, null)
    }))
  })

  describe('downloadFile', () => {
    it('returns cached path for existing file', async () => {
      const safeKey = 'file_test123'
      const localPath = path.join(FILE_DIR, `${safeKey}.pdf`)
      if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true })
      fs.writeFileSync(localPath, 'fake-file-data')

      const result = await downloadFile('file_test123', 'doc.pdf', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, localPath)
    })

    it('appends original file extension', () => withFetch(OK_10B, async () => {
      const result = await downloadFile('file_ext', 'report.xlsx', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.ok(result, 'should return a path')
      assert.ok(result!.endsWith('.xlsx'), 'should append .xlsx extension')
    }))

    it('returns null when content-length exceeds 50MB', () => withFetch(TOO_BIG_FILE, async () => {
      const result = await downloadFile('file_big', 'big.bin', 'msg_001', API_BASE, WORK_DIR, 'fake-token')
      assert.strictEqual(result, null)
    }))
  })

  describe('recognizeSpeech', () => {
    it('returns recognition_text on success', () => withFetch(SPEECH_OK, async () => {
      const result = await recognizeSpeech('file_key_123', API_BASE, 'fake-token')
      assert.strictEqual(result, '你好世界')
    }))

    it('returns null on non-ok response', () => withFetch(SPEECH_FAIL, async () => {
      const result = await recognizeSpeech('file_key_123', API_BASE, 'fake-token')
      assert.strictEqual(result, null)
    }))
  })
})
