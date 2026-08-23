import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FeishuClient } from './index_feishu.js'
import { getPeerMessageFilePath } from './peer-message.js'

interface Ctx {
  workDir: string
  client: FeishuClient
  claudetalkDir: string
}

/** 创建隔离的临时工作目录 + 关联的 FeishuClient */
function setup(): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctalk-reentry-'))
  const ctx: Ctx = {
    workDir,
    client: new (FeishuClient as any)({
      appId: 'test_app_id',
      appSecret: 'test_app_secret',
      profileName: 'test',
      workDir,
    }) as FeishuClient,
    claudetalkDir: path.join(workDir, '.claudetalk'),
  }
  ;(globalThis as any).__CTX__ = ctx
}

/** 写入一条 peer message 到 bot_{botName}.json */
function writePeerMessage(botName: string, mid: string, msg = 'hello'): void {
  const c = (globalThis as any).__CTX__ as Ctx
  const filePath = getPeerMessageFilePath(c.claudetalkDir, botName)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const existing: any[] = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : []
  existing.push({
    id: `id_${existing.length}`,
    from: 'user1',
    chatId: 'oc_test',
    messageId: mid,
    message: msg,
    createdAt: Date.now(),
    isGroup: true,
  })
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8')
}

describe('_peerProcessing reentry guard', () => {
  let ctx: Ctx

  beforeEach(() => {
    setup()
    ctx = (globalThis as any).__CTX__
    // stub 外部副作用
    ;(ctx.client as any).addMessageReaction = async () => {}
    ;(ctx.client as any).sendTextMessage = async () => ({ code: 0 })
    ;(ctx.client as any).sendAck = async () => {}
  })

  afterEach(() => {
    try { fs.rmSync(ctx.workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    delete (globalThis as any).__CTX__
  })

  it('正在处理一批消息时，第二次/第三次调用直接跳过（不并发起第二个处理）', async () => {
    writePeerMessage('test', 'om_1')
    let handlerEntry = 0
    let releaseHandler: () => void = () => {}
    let handlerResolved = 0

    // 阻塞式 handler：记录进入次数，只有收到 release 才返回
    ctx.client.onMessage(async () => {
      handlerEntry++
      await new Promise<void>((resolve) => { releaseHandler = resolve })
      handlerResolved++
    })

    // 第一次调用：进入 handler 后挂起
    const first = ctx.client['processPeerMessages']('test')
    // 等待 handler 真正进入（_peerProcessing 已置 true）
    await new Promise<void>((r) => setTimeout(r, 20))

    assert.strictEqual((ctx.client as any)._peerProcessing, true, '第一次处理中，锁应为 true')

    // 在锁持有期间再调用两次，都应立即返回（不进入 handler）
    await ctx.client['processPeerMessages']('test')
    await ctx.client['processPeerMessages']('test')
    assert.strictEqual(handlerEntry, 1, '重入调用不应再进入 handler')

    // 释放后第一次处理完成
    releaseHandler()
    await first

    assert.strictEqual(handlerResolved, 1)
    assert.strictEqual((ctx.client as any)._peerProcessing, false, '处理完成后锁应释放')
  })

  it('锁在 finally 中一定释放——即使 handler 抛错也不卡死', async () => {
    writePeerMessage('test', 'om_2')

    ctx.client.onMessage(async () => {
      throw new Error('handler boom')
    })

    await ctx.client['processPeerMessages']('test')

    assert.strictEqual((ctx.client as any)._peerProcessing, false, '异常抛出后锁必须释放')
  })

  it('处理失败的消息保留、成功的删除，锁释放后可再次处理失败那条', async () => {
    writePeerMessage('test', 'm_a', 'om_3a')
    writePeerMessage('test', 'm_b', 'om_3b')
    let calls = 0

    // 两条消息，只对第一条（内容 om_3a）抛错；第二条成功
    ctx.client.onMessage(async (_c, message: string) => {
      calls++
      if (message === 'om_3a') throw new Error('om_3a fails')
    })

    await ctx.client['processPeerMessages']('test')
    const filePath = getPeerMessageFilePath(ctx.claudetalkDir, 'test')
    const remaining: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    // 只有成功那条（m_b）被删除，失败那条（m_a）保留供重试
    assert.strictEqual(remaining.length, 1, '失败的消息应保留')
    assert.strictEqual(remaining[0].messageId, 'm_a', '保留的应是失败的那条')

    // 锁已释放，可再次处理剩余那条
    await ctx.client['processPeerMessages']('test')
    const afterRetry: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    assert.strictEqual(afterRetry.length, 0, '重试后失败消息也被处理删除')
    assert.strictEqual((ctx.client as any)._peerProcessing, false, '锁已释放')
  })
})
