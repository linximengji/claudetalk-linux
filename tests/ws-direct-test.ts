import * as WebSocket from 'ws'
import * as fs from 'fs'
import * as path from 'path'

// Load Feishu config
import { loadFeishuConfig } from '../src/feishu-shared/index.js'

async function main() {
  const cfg = loadFeishuConfig()
  if (!cfg) {
    console.error('Failed to load feishu config')
    process.exit(1)
  }

  // Step 1: Get WS ticket
  const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  })
  const tokenData = await tokenResp.json() as any
  const token = tokenData.tenant_access_token
  console.error(`Token: ${token?.slice(0, 10)}...`)

  const wsTicketResp = await fetch('https://open.feishu.cn/open-apis/ws/v1/apps/552564/config', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const wsData = await wsTicketResp.json() as any
  console.error(`WS config: ${JSON.stringify(wsData, null, 2)}`)

  if (wsData.code !== 0) {
    console.error(`Failed: ${JSON.stringify(wsData)}`)
    process.exit(1)
  }

  const wsUrl = wsData.data.ws_url
  console.error(`Connecting to: ${wsUrl}`)

  // Step 2: Connect raw WS
  const ws = new WebSocket.default(wsUrl)

  let lastDataFrame = 0
  let lastControlFrame = 0
  let frameCount = 0
  let eventCount = 0

  ws.on('open', () => {
    console.error('=== WS CONNECTED ===')
    lastDataFrame = lastControlFrame = Date.now()
  })

  ws.on('message', (buffer: Buffer) => {
    const now = Date.now()
    frameCount++

    // Decode protobuf frame (simplified — read first few bytes for type)
    const method = buffer[1]  // rough estimate: method byte
    const type = buffer[6]    // rough estimate: type byte

    const isControl = method === 1  // FrameType.control
    const isPing = buffer[6] === 1  // MessageType.ping
    const isPong = type === 2       // MessageType.pong

    if (isControl) {
      lastControlFrame = now
    } else {
      // data frame = event
      lastDataFrame = now
      eventCount++
      console.error(`[EVENT] frame#${frameCount} len=${buffer.length} method=${method} type=${type}`)
    }

    if (frameCount % 10 === 0) {
      const sinceLastData = ((now - lastDataFrame) / 1000).toFixed(0)
      const sinceLastCtrl = ((now - lastControlFrame) / 1000).toFixed(0)
      console.error(`[STATS] frames=${frameCount} events=${eventCount} lastData=${sinceLastData}s ago lastCtrl=${sinceLastCtrl}s ago`)
    }
  })

  ws.on('close', (code: number, reason: Buffer) => {
    console.error(`=== WS CLOSED: code=${code} reason=${reason?.toString()} ===`)
  })

  ws.on('error', (err: Error) => {
    console.error(`=== WS ERROR: ${err.message} ===`)
  })

  // Monitor and print every 10s
  setInterval(() => {
    const sinceLastData = ((Date.now() - lastDataFrame) / 1000).toFixed(0)
    const sinceLastCtrl = ((Date.now() - lastControlFrame) / 1000).toFixed(0)
    console.error(`[10s] frames=${frameCount} events=${eventCount} lastData=${sinceLastData}s lastCtrl=${sinceLastCtrl}s alive=${ws.readyState === 1}`)
  }, 10000)

  // Exit after 5 minutes
  setTimeout(() => {
    console.error(`=== FINAL: frames=${frameCount} events=${eventCount} ===`)
    ws.close()
    process.exit(0)
  }, 300_000)
}

main().catch(err => {
  console.error(`Fatal: ${err}`)
  process.exit(1)
})
