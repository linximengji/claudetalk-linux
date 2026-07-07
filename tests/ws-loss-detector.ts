/**
 * ws-loss-detector.ts — 飞书 WS 消息丢失检测
 *
 * 独立进程，每 10s 调 listMessage API 拉最新消息，
 * 记录所有消息 ID 和时间戳，对比 bridge 的日志输出。
 * 纯观测，不干预任何系统。
 *
 * 输出: data/test/ws-loss.jsonl
 */
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { FeishuApiClient, FEISHU_API_BASE, loadFeishuConfig } from '../dist/feishu-shared/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DATA_DIR = join(__dirname, '..', 'data', 'test')
const LOG_FILE = join(DATA_DIR, 'ws-loss.jsonl')
const CHAT_ID = 'oc_44ba0d81afa9189a67ef99d0bce1124d'

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const cfg = loadFeishuConfig('/home/ubuntu/projects')
if (!cfg) { console.error('no config'); process.exit(1) }

const api = new FeishuApiClient(cfg.appId, cfg.appSecret)

interface MsgItem {
  message_id: string
  msg_type: string
  sender_id: string
  create_time: string  // from feishu API
  body_preview: string
}

// last seen message_id per sender
const seenPerSender = new Map<string, string[]>()

async function poll() {
  const token = await api.getAccessToken()
  const url = `${FEISHU_API_BASE}/im/v1/messages?container_id_type=chat&container_id=${CHAT_ID}&page_size=20&sort_type=ByCreateTimeDesc`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await resp.json() as any
  if (!data.data?.items) return

  const userMsgs: MsgItem[] = []
  for (const item of data.data.items) {
    if (item.sender?.id === 'cli_aa838f41f9f8dbe7') continue // skip bot messages
    userMsgs.push({
      message_id: item.message_id,
      msg_type: item.msg_type,
      sender_id: item.sender?.id || '',
      create_time: item.create_time,
      body_preview: (item.body?.content || '').replace(/\\n/g, ' ').slice(0, 60),
    })
  }

  const now = Date.now()
  for (const msg of userMsgs) {
    const prev = seenPerSender.get(msg.sender_id) || []
    if (!prev.includes(msg.message_id)) {
      seenPerSender.set(msg.sender_id, [...prev, msg.message_id])
      appendFileSync(LOG_FILE, JSON.stringify({
        ts: now,
        action: 'detected',
        message_id: msg.message_id,
        sender: msg.sender_id,
        create_time: msg.create_time,
        preview: msg.body_preview,
      }) + '\n', 'utf-8')
      console.log(`[${new Date().toISOString()}] NEW message from ${msg.sender_id.slice(0, 12)}: ${msg.body_preview}`)
    } else {
      // already seen — normal
    }
  }
}

async function main() {
  console.log(`WS loss detector started. Log: ${LOG_FILE}`)
  appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), action: 'start' }) + '\n', 'utf-8')

  // poll every 10s
  setInterval(() => {
    poll().catch(err => {
      const errMsg = `poll error: ${err.message}`
      console.error(errMsg)
      appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), action: 'error', detail: errMsg }) + '\n', 'utf-8')
    })
  }, 10000)

  // immediate first poll
  await poll()
}

main().catch(console.error)
