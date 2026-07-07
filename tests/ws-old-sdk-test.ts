import * as Lark from '@larksuiteoapi/node-sdk'

async function main() {
  const { loadFeishuConfig } = await import('../src/feishu-shared/index.js')
  const cfg = loadFeishuConfig()
  if (!cfg) { console.error('No config'); process.exit(1) }

  const eventDispatcher = new Lark.EventDispatcher({})
  eventDispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      const event = data as any
      const messageId = event.message?.message_id || event.open_message_id || '?'
      const chatId = event.message?.chat_id || event.open_chat_id || '?'
      const text = event.message?.content || ''
      console.error(`[EVENT] messageId=${messageId} chatId=${chatId} text=${text.substring(0, 100)}`)
    },
  })

  const wsClient = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: Lark.LoggerLevel.debug,
  })

  wsClient.start({ eventDispatcher }).then(() => {
    console.error('=== WSClient started successfully ===')
  }).catch((err) => {
    console.error(`=== WSClient start failed: ${err} ===`)
  })

  // Monitor
  setInterval(() => {
    const status = wsClient.getConnectionStatus()
    console.error(`[30s] status=${JSON.stringify(status)}`)
  }, 30000)

  // Run for 3 minutes
  await new Promise(r => setTimeout(r, 180000))
  console.error('=== Test complete ===')
  process.exit(0)
}

main().catch(err => { console.error(`Fatal: ${err}`); process.exit(1) })
