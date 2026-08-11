/**
 * 数字分身实体（twin-entity）HTTP 客户端。
 *
 * 把 twin 对话从"claudetalk 直接 spawn python"切换到"实体常驻服务"。
 * 实体做大脑（persona + 记忆 + LLM + 持续状态），claudetalk 保持飞书收发。
 * 实体不可达时由调用方 fallback 回直接 spawn（不中断飞书回复）。
 */
const TWIN_ENTITY_URL = process.env.TWIN_ENTITY_URL || 'http://127.0.0.1:8790'
const ENTITY_TIMEOUT_MS = 30_000

export interface TwinChatInput {
  conversationId: string
  message: string
  caller: 'owner' | 'external'
  isGroup: boolean
  context?: string
}

export interface TwinChatResult {
  answer: string
  thought: string
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
        caller: input.caller,
        is_group: input.isGroup,
        context: input.context,
      }),
      signal: controller.signal,
    })
    const data = await resp.json()
    if (!resp.ok || !data?.ok) {
      throw new Error(`entity /chat failed: ${resp.status} ${data?.error || resp.statusText}`)
    }
    return { answer: data.answer ?? '', thought: data.thought ?? '' }
  } finally {
    clearTimeout(timer)
  }
}
