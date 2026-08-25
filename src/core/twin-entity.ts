/**
 * 数字分身实体（twin-entity）HTTP 客户端。
 *
 * bot 是纯翻译层：只传 {channel, user_id}，身份/模式/上下文/feed 全由实体判定。
 * 实体做大脑（persona + 记忆 + LLM + 持续状态），claudetalk 保持飞书收发。
 */
const TWIN_ENTITY_URL = process.env.TWIN_ENTITY_URL || 'http://127.0.0.1:8790'
const ENTITY_TIMEOUT_MS = 60_000

export interface TwinChatInput {
  conversationId: string
  message: string
  // 身份由实体判定：bot 只传 channel+user_id（不再传 caller）
  channel?: string
  userId?: string
  isGroup: boolean
}

export interface TwinChatResult {
  answer: string
  thought: string
  caller?: string
  name?: string
}

/**
 * 调用实体 /chat。成功返回 {answer, thought}；实体不可达/出错/超时抛错（调用方 fallback）。
 */
export async function chatWithEntity(input: TwinChatInput): Promise<TwinChatResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ENTITY_TIMEOUT_MS)
  try {
    const resp = await fetch(`${TWIN_ENTITY_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        message: input.message,
        channel: input.channel,
        user_id: input.userId,
        is_group: input.isGroup,
      }),
      signal: controller.signal,
    })
    const data = await resp.json()
    if (!resp.ok || !data?.ok) {
      throw new Error(`entity /chat failed: ${resp.status} ${data?.error || resp.statusText}`)
    }
    return { answer: data.answer ?? '', thought: data.thought ?? '', caller: data.caller, name: data.name }
  } finally {
    clearTimeout(timer)
  }
}
