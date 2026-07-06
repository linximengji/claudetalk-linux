/**
 * Shared Feishu config loader for .claude/.env and .claudetalk.json
 */
import * as fs from 'fs'
import * as path from 'path'

export interface FeishuConfig {
  appId: string
  appSecret: string
  defaultReceiveId: string
  defaultReceiveIdType: string
}

export function loadFeishuConfig(workDir: string): FeishuConfig | null {
  const envPath = path.join(process.env.HOME || '~', '.claude', '.env')
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      const appId = content.match(/^FEISHU_APP_ID=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
      const appSecret = content.match(/^FEISHU_APP_SECRET=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
      if (appId && appSecret) {
        return {
          appId,
          appSecret,
          defaultReceiveId: content.match(/^FEISHU_RECEIVE_ID=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '',
          defaultReceiveIdType: content.match(/^FEISHU_RECEIVE_ID_TYPE=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || 'chat_id',
        }
      }
    } catch { /* fall through */ }
  }

  const configPath = path.join(workDir, '.claudetalk.json')
  if (!fs.existsSync(configPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    for (const p of Object.values(raw.profiles || {}) as any[]) {
      if (p.feishu?.FEISHU_APP_ID && p.feishu?.FEISHU_APP_SECRET) {
        return {
          appId: p.feishu.FEISHU_APP_ID,
          appSecret: p.feishu.FEISHU_APP_SECRET,
          defaultReceiveId: p.feishu.FEISHU_RECEIVE_ID || '',
          defaultReceiveIdType: p.feishu.FEISHU_RECEIVE_ID_TYPE || 'chat_id',
        }
      }
    }
  } catch { /* fall through */ }
  return null
}
