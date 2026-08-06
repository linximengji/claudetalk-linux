/**
 * IdentityResolver — 用户身份识别
 *
 * 全局用户注册表 identities.json 以自增 uid 为主键，openIds 为别名索引
 * （各平台 ID → uid）。纯本地表驱动，不调任何平台 API：
 * open_id 命中 → 返回注册等级；未命中 → 自动创建 stranger 条目。
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { IdentityEntry, IdentityLevel, IdentityResult } from '../types.js'

class IdentityResolver {
  private identitiesPath: string
  /** 内存级 openId → uid 索引，避免重复遍历 */
  private openIdIndex: Map<string, string> | null = null

  constructor(workDir: string) {
    this.identitiesPath = join(workDir, '.claudetalk', 'identities.json')
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
    for (const [uid, entry] of Object.entries(data)) {
      if (uid.startsWith('_')) continue // 跳过 _default_ / _meta 条目
      if (entry.openIds) {
        for (const openId of Object.values(entry.openIds) as string[]) {
          idx.set(openId, uid)
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
  }

  /**
   * 主入口：由 senderOpenId + appId 解析用户身份。
   *
   * 纯本地表驱动：open_id 在注册表命中 → 返回其 level；未命中 → 自动创建
   * stranger 条目（分配自增 uid）并返回 stranger。不调任何平台 API。
   */
  async resolve(senderOpenId: string, appId: string): Promise<IdentityResult> {
    const DEFAULT_STRANGER: IdentityResult = { level: 'stranger', name: '陌生人', description: '陌生人级别' }
    if (!senderOpenId) {
      return DEFAULT_STRANGER
    }

    const data = this.load()

    // 重建索引（懒加载）
    if (!this.openIdIndex) {
      this.openIdIndex = this.buildOpenIdIndex(data)
    }

    // 1. 快速索引：open_id 直查 uid
    const indexedUid = this.openIdIndex.get(senderOpenId)
    if (indexedUid) {
      const entry = data[indexedUid]
      if (entry) {
        return { level: entry.level, name: entry.name, description: entry.description || '' }
      }
    }

    // 2. 未命中 → 自动创建 stranger 条目（自增 uid）
    const uid = this.allocateUid(data)
    data[uid] = {
      name: '陌生人',
      level: 'stranger',
      description: '首次联系，自动创建的陌生人条目',
      openIds: { [appId]: senderOpenId },
    }
    this.persist(data)
    this.openIdIndex.set(senderOpenId, uid)
    return DEFAULT_STRANGER
  }

  /**
   * 分配下一个自增 uid。从 _meta.next_uid 读取，写入后递增并持久化。
   */
  private allocateUid(data: Record<string, IdentityEntry>): string {
    const meta = (data._meta as { next_uid?: number } | undefined) || {}
    const next = meta.next_uid ?? 1
    ;(data as Record<string, unknown>)._meta = { next_uid: next + 1 }
    return String(next)
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
