/**
 * feishu-bridge + claudetalk 稳定性测试
 *
 * 通过直接写 peer-message 文件模拟手机用户发私聊消息，
 * 验证端到端消息处理链路在持续压力下的稳定性。
 *
 * 原理：
 * - 直接写 bot_claudetalk.json（feishu-bridge 正常转发消息的路径）
 * - claudetalk 每 2s 轮询该文件 → 处理消息 → 完成后 ACK bridge
 * - 监控 ACLK 到 bridge 的 ACK + bridge 日志 + Content 日志三重确认回复
 *
 * 用法：
 *   node tests/stability-test.mjs              # 默认：6 条消息，间隔 30s
 *   node tests/stability-test.mjs --count 20   # 20 条
 *   node tests/stability-test.mjs --interval 10 --count 12
 *   node tests/stability-test.mjs --watch 30   # 发送后继续观察 30 分钟
 *
 * 返回码：
 *   0 = 全部通过
 *   1 = 部分消息未收到回复
 *   2 = 链路中断（bridge 或 claudetalk 进程异常）
 *   3 = 脚本内部错误
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { execSync } from 'node:child_process'

// ========== Config ==========
const WORK_DIR = '/home/ubuntu/projects'
const CLAUDETALK_DIR = join(WORK_DIR, '.claudetalk')
const PEER_FILE_DIR = join(CLAUDETALK_DIR, 'feishu')
const PEER_FILE = join(PEER_FILE_DIR, 'bot_claudetalk.json')
const BRIDGE_PORT = 9878
const PHONE_CHAT_ID = 'p2p_chat_' + randomUUID().slice(0, 8)
const BOT_NAME = 'claudetalk'
const CACHE_TTL = 5 * 60 * 1000  // processedPeerIds cache TTL in claudetalk
const MAX_REPLY_WAIT = 300_000   // 5 min per message

// CLI
const args = process.argv.slice(2)
const parseArg = (flag, def) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? parseInt(args[i + 1], 10) : def
}
const MSG_COUNT = parseArg('--count', 6)
const SEND_INTERVAL_S = parseArg('--interval', 30)
const POST_WATCH_M = parseArg('--watch', 10)

// ========== Utilities ==========

function log(...args) {
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

function httpGet(host, port, path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
    req.end()
  })
}

function processExists(name) {
  try {
    execSync(`pgrep -f '${name}'`, { stdio: 'ignore', timeout: 3000 })
    return true
  } catch { return false }
}

// ========== Peer-message I/O ==========

function loadMessages() {
  try {
    if (existsSync(PEER_FILE)) return JSON.parse(readFileSync(PEER_FILE, 'utf-8'))
  } catch {}
  return []
}

function removeMessages(ids) {
  const remaining = loadMessages().filter(m => !ids.has(m.id))
  const tmpFp = PEER_FILE + '.tmp'
  if (!existsSync(PEER_FILE_DIR)) mkdirSync(PEER_FILE_DIR, { recursive: true })
  writeFileSync(tmpFp, JSON.stringify(remaining), 'utf-8')
  renameSync(tmpFp, PEER_FILE)
}

function appendMessage(msg) {
  const existing = loadMessages()
  existing.push(msg)
  const tmpFp = PEER_FILE + '.tmp'
  if (!existsSync(PEER_FILE_DIR)) mkdirSync(PEER_FILE_DIR, { recursive: true })
  writeFileSync(tmpFp, JSON.stringify(existing), 'utf-8')
  renameSync(tmpFp, PEER_FILE)
}

// ========== Log Scanner ==========

const sentMessages = []

function scanLogs() {
  try {
    const logs = execSync(
      `journalctl -u feishu-bridge --since "5 minutes ago" --no-pager 2>/dev/null; `
      + `echo '===CLAUDE==='; `
      + `journalctl -u claudetalk-bot --since "5 minutes ago" --no-pager 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    )

    const parts = logs.split('===CLAUDE===')
    const bridgeLogs = parts[0] || ''
    const claudeLogs = parts[1] || ''

    // Extract Content lines in order — each corresponds to a reply
    const contentLines = []
    // Match "Content: actual_reply_text" from bot reply or edit message
    for (const line of claudeLogs.split('\n')) {
      const m = line.match(/Content:\s*(.+)/)
      if (m) contentLines.push(m[1].trim())
    }

    const pending = sentMessages.filter(m => !m.reply)

    for (const sm of pending) {
      // Bridge ACK log: "ACK: peerId=xxx trace=yyy status=ok"
      if (!sm.acked) {
        if (new RegExp(`ACK:.*trace=${sm.traceId}.*status=ok`).test(bridgeLogs)) {
          sm.acked = true
          log(`[ACK] trace=${sm.traceId}`)
        }
      }

      // claudetalk "[trace=xxx] Peer message processed" — indicates completion
      const processed = new RegExp(`\\[trace=${sm.traceId}\\] Peer message processed`).test(claudeLogs)
      if (!processed) continue

      // Match Content lines in FIFO order to our pending messages
      // Since processing is sequential, the Nth processed msg maps to the Nth new Content line
      const processedCount = sentMessages.filter(m => m !== sm && new RegExp(`\\[trace=${m.traceId}\\] Peer message processed`).test(claudeLogs)).length + 1
      if (contentLines.length >= processedCount) {
        const replyText = contentLines[processedCount - 1]
        sm.reply = true
        sm.repliedAt = Date.now()
        sm.replyContent = replyText
        log(`[REPLY] trace=${sm.traceId} → ${replyText.substring(0, 60)}`)
        continue
      }

      // Fallback: ACK received + enough time passed = replied
      if (sm.acked && Date.now() - sm.sentAt > 180_000) {
        sm.reply = true
        sm.repliedAt = Date.now()
        log(`[REPLY via ACK] trace=${sm.traceId}`)
      }
    }
  } catch (err) {
    log(`[WARN] Log scan error: ${err instanceof Error ? err.message : err}`)
  }
}

// ========== Phases ==========

async function healthCheck() {
  log('=== Phase 1: Health Check ===')
  const bridgeAlive = processExists('feishu-bridge')
  const claudetalkAlive = processExists('claudetalk-default')
  log(`feishu-bridge: ${bridgeAlive ? 'UP' : 'DOWN'}`)
  log(`claudetalk:     ${claudetalkAlive ? 'UP' : 'DOWN'}`)
  if (!bridgeAlive || !claudetalkAlive) return false

  const { status, body } = await httpGet('127.0.0.1', BRIDGE_PORT, '/health')
  if (status !== 200) {
    log(`Bridge /health returned ${status}`)
    return false
  }
  log(`Bridge /health: ${body.substring(0, 100)}`)
  return true
}

async function sendMessages() {
  log(`\n=== Phase 2: Send ${MSG_COUNT} messages (${SEND_INTERVAL_S}s interval) ===`)
  log(`Chat ID: ${PHONE_CHAT_ID}`)

  for (let i = 0; i < MSG_COUNT; i++) {
    const traceId = randomUUID().slice(0, 8)
    const message = `[稳定性测试 #${i + 1}/${MSG_COUNT}] trace=${traceId} 时间=${new Date().toISOString().slice(11, 19)}`

    // Different messageId for each to avoid claudetalk's dedup
    const msg = {
      id: randomUUID(),
      from: 'feishu-bridge',
      chatId: PHONE_CHAT_ID,
      messageId: `om_stab_${Date.now()}_${randomUUID().slice(0, 4)}`,
      message,
      createdAt: Date.now(),
      traceId,
      isGroup: false,
    }

    sentMessages.push({
      traceId, message: msg.message, sentAt: Date.now(),
      messageId: msg.messageId, id: msg.id,
      reply: false, repliedAt: null, replyContent: null, acked: false,
    })

    appendMessage(msg)
    log(`[SEND] #${i + 1} trace=${traceId}`)

    if (i < MSG_COUNT - 1) {
      await new Promise(r => setTimeout(r, SEND_INTERVAL_S * 1000))
    }
  }
}

async function waitForReplies() {
  log(`\n=== Phase 3: Wait for replies ===`)
  const deadline = Date.now() + Math.max(
    MSG_COUNT * SEND_INTERVAL_S * 1000 + 300_000,
    900_000,  // at least 15 min
  )
  let lastLog = 0

  while (Date.now() < deadline) {
    if (sentMessages.every(m => m.reply)) {
      log(`All ${sentMessages.length} messages replied!`)
      return
    }

    scanLogs()

    if (Date.now() - lastLog > 30_000) {
      const replied = sentMessages.filter(m => m.reply).length
      const pending = sentMessages.filter(m => !m.reply).length
      log(`Progress: ${replied}/${sentMessages.length} replied (${pending} pending, ${Math.round((deadline - Date.now()) / 1000)}s left)`)
      lastLog = Date.now()
    }

    await new Promise(r => setTimeout(r, 5000))
  }
}

async function verifyStability() {
  log(`\n=== Phase 4: Verification ===`)
  let failures = 0
  const latencies = []

  for (const sm of sentMessages) {
    if (!sm.reply) {
      log(`[FAIL] trace=${sm.traceId}: no reply (${Math.round((Date.now() - sm.sentAt) / 1000)}s ago)`)
      failures++
    } else if (sm.repliedAt) {
      const latency = (sm.repliedAt - sm.sentAt) / 1000
      latencies.push(latency)
    }
  }

  if (failures === 0 && latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const max = Math.max(...latencies)
    const min = Math.min(...latencies)
    log(`[PASS] All ${sentMessages.length} messages replied`)
    log(`Latency: avg=${avg.toFixed(0)}s min=${min.toFixed(0)}s max=${max.toFixed(0)}s`)
  } else {
    log(`[FAIL] ${failures}/${sentMessages.length} messages missing replies`)
  }
  return failures === 0
}

async function extendedWatch() {
  if (POST_WATCH_M <= 0) return true
  log(`\n=== Phase 5: Watch ${POST_WATCH_M} min ===`)
  log(`Sending 1 msg/5min, checking bridge health every 5s`)

  const deadline = Date.now() + POST_WATCH_M * 60_000
  let healthy = 0, unhealthy = 0, tickCount = 0
  const watchSent = []

  while (Date.now() < deadline) {
    tickCount++

    // Every 5 minutes: send message
    if (tickCount % 60 === 1) {
      const traceId = randomUUID().slice(0, 8)
      const msg = {
        id: randomUUID(), from: 'feishu-bridge',
        chatId: PHONE_CHAT_ID,
        messageId: `om_watch_${Date.now()}`,
        message: `[保持测试] trace=${traceId} time=${Date.now()}`,
        createdAt: Date.now(), traceId, isGroup: false,
      }
      appendMessage(msg)
      const wm = {
        traceId, message: msg.message, sentAt: Date.now(),
        messageId: msg.messageId, id: msg.id,
        reply: false, repliedAt: null, replyContent: null, acked: false,
      }
      watchSent.push(wm);
      sentMessages.push(wm)  // also track in main list for cleanup
      log(`[WATCH SEND] trace=${traceId}`)

      // Wait up to 5 min for reply
      const replyDeadline = Date.now() + 300_000
      while (Date.now() < replyDeadline) {
        scanLogs()
        if (wm.reply) break
        await new Promise(r => setTimeout(r, 5000))
      }
      log(`[WATCH] trace=${traceId} → ${wm.reply ? 'REPLIED' : 'NO REPLY'}`)
    }

    // Health check every 5s
    const { status } = await httpGet('127.0.0.1', BRIDGE_PORT, '/health', 2000)
    if (status === 200) { healthy++ } else { unhealthy++; log(`[ALERT] Bridge health fail`) }
    if (unhealthy > 0) log(`[WATCH] ${healthy} healthy / ${unhealthy} unhealthy`)

    await new Promise(r => setTimeout(r, 5000))
  }
  return unhealthy === 0 && watchSent.every(m => m.reply)
}

// ========== Cleanup ==========

function cleanup() {
  log('\n=== Cleanup ===')
  const ids = new Set(sentMessages.map(m => m.id))
  if (ids.size > 0) {
    removeMessages(ids)
    log(`Removed ${ids.size} test messages from peer file`)
  }
}

function printSummary() {
  log('\n' + '='.repeat(55))
  log('SUMMARY')
  log('='.repeat(55))
  for (const sm of sentMessages) {
    const latency = sm.repliedAt
      ? ((sm.repliedAt - sm.sentAt) / 1000).toFixed(1) + 's'
      : 'NO REPLY'
    const preview = sm.replyContent
      ? sm.replyContent.substring(0, 50)
      : (sm.acked ? 'ACK ok' : 'no ACK')
    log(`  ${sm.traceId}: ${latency} [${preview}]`)
  }
  const ok = sentMessages.every(m => m.reply)
  const bridged = sentMessages.every(m => m.acked)
  log(`\nReplied: ${sentMessages.filter(m => m.reply).length}/${sentMessages.length}`)
  log(`ACKed:   ${sentMessages.filter(m => m.acked).length}/${sentMessages.length}`)
  log(`Result:  ${ok ? 'ALL PASS' : 'FAILURES DETECTED'}`)
}

// ========== Main ==========

async function main() {
  log('='.repeat(55))
  log('feishu-bridge + claudetalk 稳定性测试')
  log('='.repeat(55))
  log(`Msg count: ${MSG_COUNT}, interval: ${SEND_INTERVAL_S}s, watch: ${POST_WATCH_M}min`)
  log(`Peer file: ${PEER_FILE}`)
  log(`Chat ID:   ${PHONE_CHAT_ID}`)
  log(`Started:   ${new Date().toISOString()}`)

  let exitCode = 0

  try {
    if (!(await healthCheck())) {
      log('[ABORT] Health check failed')
      process.exit(2)
    }
    await sendMessages()
    await waitForReplies()
    if (!(await verifyStability())) exitCode = 1
    if (exitCode === 0 && POST_WATCH_M > 0) {
      if (!(await extendedWatch())) exitCode = 1
    }
  } catch (err) {
    log(`[ERROR] ${err instanceof Error ? err.message : err}`)
    exitCode = 3
  } finally {
    cleanup()
    printSummary()
  }

  process.exit(exitCode)
}

main()
