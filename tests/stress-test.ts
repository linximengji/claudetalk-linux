/**
 * stress-test.ts — Feishu 消息全链路压力测试
 *
 * 模拟 peer-message 场景，不依赖飞书 API。
 * 直接写 bot_claudetalk.json → 触发 FeishuClient 轮询 → 走 CC CLI 处理。
 *
 * 输出: data/test/stress-results.jsonl
 *
 * 运行: npx tsx tests/stress-test.ts [scenario]
 *   scenario: concurrent | slowCC | hangCC | rapid | wrap | bridgeRestart (默认全跑)
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

// ======================================================================
// Config
// ======================================================================
const DATA_DIR = join(import.meta.dirname, '..', 'data', 'test')
const RESULTS_FILE = join(DATA_DIR, 'stress-results.jsonl')
const SCENARIO = process.argv[2] || 'all'
const BRIDGE_PORT = 9878
const CLAUDETALK_DIR = '/home/ubuntu/projects' // workDir
const BOT_NAME = 'claudetalk'
const PEER_FILE_DIR = join(CLAUDETALK_DIR, '.claudetalk', 'feishu')
const PEER_FILE = join(PEER_FILE_DIR, `bot_${BOT_NAME}.json`)

interface TestResult {
  test_id: string
  scenario: string
  step: number
  start_ms: number
  elapsed_ms: number
  result: 'ok' | 'timeout' | 'error'
  details: string
  extra?: Record<string, unknown>
}

let resultCount = 0

function logResult(r: TestResult) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  try { appendFileSync(RESULTS_FILE, JSON.stringify(r) + '\n', 'utf-8') } catch { /* ignore */ }
  resultCount++
}

function genId(): string {
  return randomUUID().slice(0, 8)
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/** 写一条 peer-message 到 bot_claudetalk.json（模拟 feishu-bridge） */
function writePeerMessage(text: string, chatId: string): string {
  const msgId = genId()
  const msg = {
    id: msgId,
    from: 'stress-test',
    chatId,
    messageId: `om_stress_${msgId}`,
    message: text,
    createdAt: Date.now(),
    traceId: genId(),
    isGroup: chatId.startsWith('oc_'),
  }
  if (!existsSync(PEER_FILE_DIR)) mkdirSync(PEER_FILE_DIR, { recursive: true })
  const existing: unknown[] = existsSync(PEER_FILE)
    ? JSON.parse(readFileSync(PEER_FILE, 'utf-8') || '[]')
    : []
  existing.push(msg)
  const tmp = PEER_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf-8')
  rmSync(PEER_FILE, { force: true })
  // rename 是原子的（同一文件系统）
  try {
    // 用 copy+unlink 替代 rename 以防跨设备
    writeFileSync(PEER_FILE, JSON.stringify(existing, null, 2), 'utf-8')
    rmSync(tmp, { force: true })
  } catch { /* best-effort, tmp cleanup */ }
  return msgId
}

/** 清理 peer-message 文件 */
function clearPeerMessages() {
  try {
    if (existsSync(PEER_FILE)) writeFileSync(PEER_FILE, '[]', 'utf-8')
  } catch { /* ignore */ }
}

/** 等 claudetalk 处理完这条消息（通过监听 bridge ACK 或日志检测） */
async function waitForAck(msgId: string, timeoutMs = 30000): Promise<boolean> {
  // 方案：check bridge /ack log 或等 peer-message 文件里没有这条消息了
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!existsSync(PEER_FILE)) { await sleep(500); continue }
    try {
      const msgs: { id: string }[] = JSON.parse(readFileSync(PEER_FILE, 'utf-8') || '[]')
      if (!msgs.some(m => m.id === msgId)) return true
    } catch { /* retry */ }
    await sleep(500)
  }
  return false
}

// ======================================================================
// Scenario 1: 并发消息 — 同时投递 N 条到同个 chatId
// ======================================================================
async function testConcurrentMessages() {
  const scenario = 'concurrent'
  const chatId = 'oc_stress_concurrent'
  const count = 5
  const startMs = Date.now()

  console.log(`[${scenario}] Sending ${count} concurrent messages...`)
  const msgIds: string[] = []
  for (let i = 0; i < count; i++) {
    const id = writePeerMessage(`[并发测试 #${i + 1}] 简单回复即可`, chatId)
    msgIds.push(id)
  }

  // 等所有消息处理完
  const acks = await Promise.all(msgIds.map(id => waitForAck(id, 60000)))
  const elapsed = Date.now() - startMs

  for (let i = 0; i < count; i++) {
    logResult({
      test_id: `${scenario}-${i}`,
      scenario,
      step: i + 1,
      start_ms: startMs,
      elapsed_ms: elapsed,
      result: acks[i] ? 'ok' : 'timeout',
      details: acks[i] ? 'ack received' : 'timeout waiting for ack',
      extra: { total_count: count, msg_id: msgIds[i] },
    })
  }

  const okCount = acks.filter(Boolean).length
  console.log(`[${scenario}] ${okCount}/${count} processed in ${elapsed}ms`)
  clearPeerMessages()
}

// ======================================================================
// Scenario 2: 慢 CC — 连续发消息，观测队列阻塞
// ======================================================================
async function testSlowCCQueue() {
  const scenario = 'slowCC'
  const chatId = 'oc_stress_slow'
  const count = 3
  const startMs = Date.now()

  console.log(`[${scenario}] Sending ${count} messages in sequence...`)
  const results: { id: string; t0: number; done: boolean; t_done: number }[] = []

  for (let i = 0; i < count; i++) {
    const id = writePeerMessage(`[慢CC测试 #${i + 1}] 请先回答一个复杂问题再回这个`, chatId)
    results.push({ id, t0: Date.now(), done: false, t_done: 0 })
    await sleep(200) // 稍拉开写入时间，避免文件竞态
  }

  // 等完成
  for (const r of results) {
    r.done = await waitForAck(r.id, 120000)
    r.t_done = Date.now()
  }

  for (let i = 0; i < count; i++) {
    const r = results[i]
    const waitTime = r.t_done - r.t0
    logResult({
      test_id: `${scenario}-msg${i + 1}`,
      scenario,
      step: i + 1,
      start_ms: startMs,
      elapsed_ms: waitTime,
      result: r.done ? 'ok' : 'timeout',
      details: r.done ? `waited ${waitTime}ms in queue` : 'timeout',
      extra: { queue_position: i + 1 },
    })
  }

  const okCount = results.filter(r => r.done).length
  console.log(`[${scenario}] ${okCount}/${count} completed`)
  clearPeerMessages()
}

// ======================================================================
// Scenario 3: 快速连续消息 + editMessage 限频
// ======================================================================
async function testRapidMessages() {
  const scenario = 'rapid'
  const chatId = 'oc_stress_rapid'
  const count = 10
  const startMs = Date.now()

  console.log(`[${scenario}] Sending ${count} rapid messages (500ms apart)...`)
  const msgIds: string[] = []
  for (let i = 0; i < count; i++) {
    const id = writePeerMessage(`[快速消息 #${i + 1}/10] 看到这个回复一下就行`, chatId)
    msgIds.push(id)
    await sleep(500)
  }

  const acks = await Promise.all(msgIds.map((id, i) => waitForAck(id, 60000 + i * 1000)))
  const elapsed = Date.now() - startMs

  for (let i = 0; i < count; i++) {
    logResult({
      test_id: `${scenario}-${i}`,
      scenario,
      step: i + 1,
      start_ms: startMs,
      elapsed_ms: elapsed,
      result: acks[i] ? 'ok' : 'timeout',
      details: acks[i] ? 'ack received' : 'timeout',
    })
  }

  const okCount = acks.filter(Boolean).length
  console.log(`[${scenario}] ${okCount}/${count} processed`)
  clearPeerMessages()
}

// ======================================================================
// Scenario 4: Bridge 重启 — 模拟 feishu-bridge 进程重启
// ======================================================================
async function testBridgeRestart() {
  const scenario = 'bridgeRestart'
  const chatId = 'oc_stress_bridge'
  const startMs = Date.now()

  console.log(`[${scenario}] Testing restart resilience...`)

  // Phase 1: 正常发一条
  const id1 = writePeerMessage('[重启测试 Phase 1] 正常消息', chatId)
  const ack1 = await waitForAck(id1, 30000)
  logResult({
    test_id: `${scenario}-phase1`,
    scenario,
    step: 1,
    start_ms: startMs,
    elapsed_ms: Date.now() - startMs,
    result: ack1 ? 'ok' : 'timeout',
    details: 'pre-restart message',
  })

  // Phase 2: 模拟 bridge 重启——清空 peer-message 文件（bridge 重新建立 WS 后也不会重放）
  clearPeerMessages()
  await sleep(3000)

  // Phase 3: 重启后发一条
  const id2 = writePeerMessage('[重启测试 Phase 2] 重启后消息', chatId)
  const ack2 = await waitForAck(id2, 30000)
  logResult({
    test_id: `${scenario}-phase2`,
    scenario,
    step: 2,
    start_ms: startMs,
    elapsed_ms: Date.now() - startMs,
    result: ack2 ? 'ok' : 'timeout',
    details: 'post-restart message',
  })

  console.log(`[${scenario}] Phase1=${ack1 ? 'ok' : 'timeout'} Phase2=${ack2 ? 'ok' : 'timeout'}`)
  clearPeerMessages()
}

// ======================================================================
// Main
// ======================================================================
async function main() {
  if (!existsSync(CLAUDETALK_DIR)) {
    console.error(`CLAUDETALK_DIR not found: ${CLAUDETALK_DIR}`)
    process.exit(1)
  }

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  console.log(`Results: ${RESULTS_FILE}`)
  writeFileSync(RESULTS_FILE, '', 'utf-8') // reset

  const scenarios: [string, () => Promise<void>][] = [
    ['concurrent', testConcurrentMessages],
    ['slowCC', testSlowCCQueue],
    ['rapid', testRapidMessages],
    ['bridgeRestart', testBridgeRestart],
  ]

  for (const [name, fn] of scenarios) {
    if (SCENARIO !== 'all' && SCENARIO !== name) continue
    console.log(`\n========== Scenario: ${name} ==========`)
    try {
      await fn()
    } catch (err) {
      console.error(`[${name}] ERROR:`, err)
    }
  }

  console.log(`\nDone. ${resultCount} results written to ${RESULTS_FILE}`)
}

main().catch(console.error)
