import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { archiveConversation, writeTaskToIndex } from './phone-archive.js'

const TEMP_ROOT = join(process.cwd(), '.claudetalk', 'test-phone-tasks')
const INDEX_FILE = join(TEMP_ROOT, 'index.json')

function setupTempDir() {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
  mkdirSync(TEMP_ROOT, { recursive: true })
  process.env.TEST_PHONE_TASKS_DIR = TEMP_ROOT
}

/** Helper: call archive then write to index (old behavior for test compatibility). */
async function archiveAndWrite(opts: Parameters<typeof archiveConversation>[0]) {
  const result = await archiveConversation(opts)
  if (result.taskId && result.summary) {
    const status = result.category === 'task-pending' ? 'pending' : result.category
    writeTaskToIndex({ taskId: result.taskId, summary: result.summary, status })
  }
  return result
}

function teardownTempDir() {
  delete process.env.TEST_PHONE_TASKS_DIR
  rmSync(TEMP_ROOT, { recursive: true, force: true })
}

async function countDirs(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).length
}

describe('phone-archive', () => {
  beforeEach(setupTempDir)
  afterEach(teardownTempDir)

  describe('archiveConversation — group messages', () => {
    it('skips group messages without creating anything', async () => {
      await archiveConversation({
        message: '加待办',
        reply: '好的',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: true,
      })
      const dirs = await countDirs(TEMP_ROOT)
      assert.strictEqual(dirs, 0)
    })
  })

  describe('archiveConversation — task-pending', () => {
    it('creates archive dir and index.json entry with pending status', async () => {
      const result = await archiveAndWrite({
        message: '把这个加到待办里去',
        reply: '好的，已经加到待办了',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })
      assert.ok(result.taskId, 'should return taskId for pending')

      // archive dir created
      const dateDirs = readdirSync(TEMP_ROOT, { withFileTypes: true }).filter(e => e.isDirectory())
      assert.ok(dateDirs.length > 0, 'should create date directory')

      // index.json exists with pending entry
      assert.ok(existsSync(INDEX_FILE), 'should create index.json')
      const index = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
      const entries = Object.entries(index) as Array<[string, { status: string }]>
      assert.ok(entries.length > 0, 'should have at least one entry')
      const [id, entry] = entries[0]
      assert.strictEqual(entry.status, 'pending')
      assert.ok(id.includes('加'), `task id should reference message content: ${id}`)
    })
  })

  describe('archiveConversation — completed', () => {
    it('creates archive dir and index.json entry with completed status', async () => {
      const result = await archiveAndWrite({
        message: '修一下这个bug',
        reply: '已完成修复，修改了配置文件',
        toolUseCount: 2,
        toolNames: ['Read', 'Edit'],
        workDir: process.cwd(),
        isGroup: false,
      })
      assert.ok(result.taskId, 'should return taskId for completed')

      const dirs = readdirSync(TEMP_ROOT, { withFileTypes: true }).filter(e => e.isDirectory())
      assert.ok(dirs.length > 0, 'should create date directory')

      assert.ok(existsSync(INDEX_FILE), 'should create index.json')
      const index = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
      const entries = Object.entries(index) as Array<[string, { status: string; summary: string }]>
      assert.ok(entries.length > 0, 'should have at least one entry')
      const [id, entry] = entries[0]
      assert.strictEqual(entry.status, 'completed')
      assert.ok(entry.summary)
    })
  })

  describe('archiveConversation — archive dir contents', () => {
    it('writes 消息.md and 回复.md files', async () => {
      await archiveConversation({
        message: '把这个加到手机待办',
        reply: '好的，已添加',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })

      // Find the archive dir
      const dateDirs = readdirSync(TEMP_ROOT, { withFileTypes: true }).filter(e => e.isDirectory())
      const dateDir = join(TEMP_ROOT, dateDirs[0].name)
      const archiveDirs = readdirSync(dateDir, { withFileTypes: true }).filter(e => e.isDirectory())
      const archiveDir = join(dateDir, archiveDirs[0].name)

      assert.ok(existsSync(join(archiveDir, '消息.md')), 'should write 消息.md')
      assert.ok(existsSync(join(archiveDir, '回复.md')), 'should write 回复.md')

      const msgContent = readFileSync(join(archiveDir, '消息.md'), 'utf-8')
      const replyContent = readFileSync(join(archiveDir, '回复.md'), 'utf-8')
      assert.ok(msgContent.includes('加到手机待办'))
      assert.ok(replyContent.includes('好的'))
    })
  })

  describe('archiveConversation — image attachments', () => {
    it('copies image references when message contains [图片]', async () => {
      // Create a dummy image for linking
      const imgDir = join(TEMP_ROOT, '..', 'test-images')
      rmSync(imgDir, { recursive: true, force: true })
      mkdirSync(imgDir, { recursive: true })
      writeFileSync(join(imgDir, 'screenshot.png'), 'fake-png-data')

      await archiveConversation({
        message: `分析这个图片 加待办 [图片: ${join(imgDir, 'screenshot.png')}]`,
        reply: '好的',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })

      // Find the archive dir and check attachments
      const dateDirs = readdirSync(TEMP_ROOT, { withFileTypes: true }).filter(e => e.isDirectory())
      const dateDir = join(TEMP_ROOT, dateDirs[0].name)
      const archiveDirs = readdirSync(dateDir, { withFileTypes: true }).filter(e => e.isDirectory())
      const archiveDir = join(dateDir, archiveDirs[0].name)

      // 消息.md should reference the image with markdown
      const msgContent = readFileSync(join(archiveDir, '消息.md'), 'utf-8')
      assert.ok(msgContent.includes('![screenshot.png]'), 'message should have markdown image reference')

      // Cleanup test images
      rmSync(imgDir, { recursive: true, force: true })
    })
  })

  describe('archiveConversation — INDEX.md', () => {
    it('appends a row to INDEX.md for every archive', async () => {
      await archiveConversation({
        message: '加待办 任务1',
        reply: '好的',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })

      const indexPath = join(TEMP_ROOT, 'INDEX.md')
      assert.ok(existsSync(indexPath), 'should create INDEX.md')
      const content = readFileSync(indexPath, 'utf-8')
      assert.ok(content.includes('待办'), 'INDEX.md should contain category label')
    })
  })

  describe('archiveConversation — multiple archives', () => {
    it('handles sequential archives with incremented sequence numbers', async () => {
      await archiveAndWrite({
        message: '加待办 第一个',
        reply: '好的1',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })
      await archiveAndWrite({
        message: '加待办 第二个',
        reply: '好的2',
        toolUseCount: 0,
        toolNames: [],
        workDir: process.cwd(),
        isGroup: false,
      })

      const dateDirs = readdirSync(TEMP_ROOT, { withFileTypes: true }).filter(e => e.isDirectory())
      const dateDir = join(TEMP_ROOT, dateDirs[0].name)
      const archiveDirs = readdirSync(dateDir, { withFileTypes: true }).filter(e => e.isDirectory())
      assert.strictEqual(archiveDirs.length, 2, 'should have two archive directories')
      assert.ok(archiveDirs.some(d => d.name.startsWith('001-')), 'first should be 001-')
      assert.ok(archiveDirs.some(d => d.name.startsWith('002-')), 'second should be 002-')

      // Index should have 2 entries
      const index = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
      assert.strictEqual(Object.keys(index).length, 2)
    })
  })
})
