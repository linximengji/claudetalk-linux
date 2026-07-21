/**
 * IdentityResolver — 用户身份识别
 *
 * 全局用户注册表 identities.json 以 union_id 为主键，openIds 为别名索引。
 * 查找流程：open_id 直查索引 → API fallback 取 union_id → 匹配 → 回写缓存。
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { IdentityEntry, IdentityLevel, IdentityResult } from '../types.js'

const API_BASE = 'https://open.feishu.cn/open-apis'

class IdentityResolver {
  private identitiesPath: string
  private tokenGetter: () => Promise<string>
  /** 内存级 openId → unionId 索引，避免重复遍历 */
  private openIdIndex: Map<string, string> | null = null
  /** 每个 appId 的 openId 查询缓存 */
  private appOpenIdCache: Map<string, string> | null = null

  constructor(workDir: string, tokenGetter: () => Promise<string>) {
    this.identitiesPath = join(workDir, '.claudetalk', 'identities.json')
    this.tokenGetter = tokenGetter
  }

  private load(): Record<string, IdentityEntry> {
    if (!existsSync(this.identitiesPath)) return {}
    try {
      return JSON.parse(readFileSync(this.identitiesPath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private persist(data: Record<string, IdentityEntry>): void {
    try {
      writeFileSync(this.identitiesPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    } catch { /* best-effort */ }
  }

  /**
   * 重建 openId 索引（遍历所有条目的 openIds 映射）
   */
  private buildOpenIdIndex(data: Record<string, IdentityEntry>): Map<string, string> {
    const idx = new Map<string, string>()
    for (const [unionId, entry] of Object.entries(data)) {
      if (unionId.startsWith('_')) continue // 跳过 _default_ 条目
      if (entry.openIds) {
        for (const openId of Object.values(entry.openIds) as string[]) {
          idx.set(openId, unionId)
        }
      }
    }
    return idx
  }

  /**
   * 重置内存缓存（外部调用，例如 identities.json 外部修改后）
   */
  invalidateCache(): void {
    this.openIdIndex = null
    this.appOpenIdCache = null
  }

  /**
   * 通过 open_id 获取 union_id（调飞书 API）
   */
  private async fetchUnionId(openId: string): Promise<string | null> {
    try {
      const token = await this.tokenGetter()
      const resp = await fetch(`${API_BASE}/contact/v3/users/${openId}?user_id_type=open_id`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      })
      const data = await resp.json() as { code: number; data?: { user?: { union_id?: string } } }
      if (data.code === 0 && data.data?.user?.union_id) {
        return data.data.user.union_id
      }
    } catch { /* network error, fall through */ }
    return null
  }

  /**
   * 主入口：由 senderOpenId + appId 解析用户身份
   *
   * @returns IdentityResult — 始终有值（未注册用户返回 _default_stranger）
   */
  async resolve(senderOpenId: string, appId: string): Promise<IdentityResult> {
    if (!senderOpenId) {
      return { level: 'stranger', name: '陌生人', description: '陌生人级别' }
    }

    const data = this.load()

    // 重建索引（懒加载）
    if (!this.openIdIndex) {
      this.openIdIndex = this.buildOpenIdIndex(data)
    }

    const DEFAULT_STRANGER: IdentityResult = { level: 'stranger', name: '陌生人', description: '陌生人级别' }

    // 1. 快速索引：open_id 直查
    const indexed = this.openIdIndex.get(senderOpenId)
    if (indexed) {
      const entry = data[indexed]
      if (entry) {
        return { level: entry.level, name: entry.name, description: entry.description || '' }
      }
    }

    // 2. API fallback：查 union_id
    const unionId = await this.fetchUnionId(senderOpenId)
    if (!unionId) return DEFAULT_STRANGER

    // 3. 用 union_id 查注册表
    const matched = data[unionId]
    if (matched) {
      // 回写 openIds 映射（下次免 API）
      if (!matched.openIds) matched.openIds = {}
      matched.openIds[appId] = senderOpenId
      this.persist(data)
      // 更新内存索引
      this.openIdIndex.set(senderOpenId, unionId)
      return { level: matched.level, name: matched.name, description: matched.description || '' }
    }

    return DEFAULT_STRANGER
  }

  /**
   * 检查身份是否被策略允许
   *
   * @returns true=允许, false=拒绝
   */
  checkPolicy(
    result: IdentityResult,
    policy: { allowedLevels?: IdentityLevel[]; onUnknown?: 'allow' | 'block' },
  ): boolean {
    // 未指定 allowedLevels → 默认放行
    if (!policy.allowedLevels || policy.allowedLevels.length === 0) return true

    const allowed = policy.allowedLevels
    if (allowed.includes(result.level)) return true

    // 级别不足：看 onUnknown 策略
    if (policy.onUnknown === 'allow') return true
    return false
  }

  /**
   * 获取默认身份结果（用于 skipCheck 场景）
   */
  getDefaultResult(): IdentityResult {
    return { level: 'friend', name: '用户', description: '' }
  }
}

export { IdentityResolver }
export default IdentityResolver
