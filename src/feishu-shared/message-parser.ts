/**
 * Shared Feishu message parser
 *
 * Parses text/image/post/file/audio messages from raw Feishu event content.
 * Used by feishu-bridge and FeishuClient. Image/file downloads use resources.ts.
 */
import { downloadImage, downloadFile, recognizeSpeech } from '../channels/feishu/resources.js'

export const SUPPORTED_MSG_TYPES = new Set(['text', 'image', 'post', 'file', 'audio'])

export interface ParsedMessage {
  messageText: string
  imagePaths: string[]
}

export async function parseFeishuMessage(
  messageType: string,
  rawContent: string,
  messageId: string,
  apiBase: string,
  workDir: string,
  accessToken: string,
): Promise<ParsedMessage> {
  const imagePaths: string[] = []

  if (messageType === 'text') {
    try {
      const content = JSON.parse(rawContent) as { text?: string }
      return { messageText: content.text || '', imagePaths }
    } catch {
      return { messageText: rawContent, imagePaths }
    }
  }

  if (messageType === 'image') {
    try {
      const content = JSON.parse(rawContent) as { image_key: string }
      if (content.image_key) {
        const localPath = await downloadImage(content.image_key, messageId, apiBase, workDir, accessToken)
        if (localPath) imagePaths.push(localPath)
      }
    } catch { /* ignore */ }
    return { messageText: '', imagePaths }
  }

  if (messageType === 'post') {
    try {
      const content = JSON.parse(rawContent) as {
        title?: string
        content?: Array<Array<{ tag: string; text?: string; image_key?: string }>>
      }
      const textParts: string[] = []
      if (content.title) textParts.push(content.title)
      for (const line of content.content || []) {
        for (const element of line) {
          if (element.tag === 'text' && element.text) textParts.push(element.text)
          else if (element.tag === 'img' && element.image_key) {
            const localPath = await downloadImage(element.image_key, messageId, apiBase, workDir, accessToken)
            if (localPath) imagePaths.push(localPath)
          }
        }
      }
      return { messageText: textParts.join(''), imagePaths }
    } catch { /* ignore */ }
    return { messageText: rawContent, imagePaths }
  }

  if (messageType === 'file') {
    try {
      const content = JSON.parse(rawContent) as { file_key: string; file_name: string }
      if (content.file_key) {
        const originalFileName = content.file_name || content.file_key
        const localPath = await downloadFile(content.file_key, originalFileName, messageId, apiBase, workDir, accessToken)
        if (localPath) imagePaths.push(`${localPath}|${originalFileName}`)
      }
    } catch { /* ignore */ }
    return { messageText: '', imagePaths }
  }

  if (messageType === 'audio') {
    try {
      const content = JSON.parse(rawContent) as { file_key: string }
      if (content.file_key) {
        const recognizedText = await recognizeSpeech(content.file_key, apiBase, accessToken)
        if (recognizedText) return { messageText: recognizedText, imagePaths }
      }
    } catch { /* ignore */ }
    return { messageText: '[语音识别失败]', imagePaths }
  }

  return { messageText: rawContent, imagePaths }
}
