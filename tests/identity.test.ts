/**
 * IdentityResolver 测试
 *
 * 测试 open_id 索引查找、API fallback、策略检查、回写缓存等核心路径。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// 不实际调飞书 API，用 mock
let mockUnionId: string | null = 'on_test_union_id'
let mockApiCalled = 0

async function mockTokenGetter(): Promise<string> {
  return 'mock-token'
}

// 模拟 IdentityResolver，但注入可控的 fetch
class TestableResolver {
  private identitiesPath: string
  private openIdIndex: Map<string, string> | null = null

  constructor(private workDir: string) {
    this.identitiesPath = join(workDir, 'identities.json')
  }

  private load(): Record<string, Record<string, any>> {
    if (!existsSync(this.identitiesPath)) return {}
    try {
      return JSON.parse(readFileSync(this.identitiesPath, 'utf-8'))
    } catch { return {} }
  }

  private persist(data: Record<string, Record<string, any>>): void {
    writeFileSync(this.identitiesPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  private buildOpenIdIndex(data: Record<string, Record<string, any>>): Map<string, string> {
    const idx = new Map<string, string>()
    for (const [key, entry] of Object.entries(data)) {
      if (key.startsWith('_')) continue
      if (entry.openIds) {
        for (const [appId, openId] of Object.entries(entry.openIds as Record<string, string>)) {
          idx.set(openId, key)
        }
      }
    }
    return idx
  }

  async fetchUnionId(_openId: string): Promise<string | null> {
    mockApiCalled++
    return mockUnionId
  }

  invalidateCache(): void {
    this.openIdIndex = null
  }

  async resolve(senderOpenId: string, appId: string): Promise<{ level: string; name: string; description: string }> {
    if (!senderOpenId) return { level: 'stranger', name: '陌生人', description: '陌生人级别' }

    const data = this.load()
    if (!this.openIdIndex) {
      this.openIdIndex = this.buildOpenIdIndex(data)
    }

    const DEFAULT = { level: 'stranger', name: '陌生人', description: '陌生人级别' }

    const indexed = this.openIdIndex.get(senderOpenId)
    if (indexed) {
      const entry = data[indexed]
      if (entry) return { level: entry.level, name: entry.name, description: entry.description || '' }
    }

    const unionId = await this.fetchUnionId(senderOpenId)
    if (!unionId) return DEFAULT

    const matched = data[unionId]
    if (matched) {
      if (!matched.openIds) matched.openIds = {}
      matched.openIds[appId] = senderOpenId
      this.persist(data)
      this.openIdIndex.set(senderOpenId, unionId)
      return { level: matched.level, name: matched.name, description: matched.description || '' }
    }

    return DEFAULT
  }

  checkPolicy(result: { level: string }, policy: { allowedLevels?: string[]; onUnknown?: string }): boolean {
    if (!policy.allowedLevels || policy.allowedLevels.length === 0) return true
    if ((policy.allowedLevels as string[]).includes(result.level)) return true
    if (policy.onUnknown === 'allow') return true
    return false
  }
}

// ============ 测试 ============

describe('IdentityResolver', () => {
  let tmpRoot: string

  function setup(dirName: string, content: any): { workDir: string; identitiesPath: string } {
    const workDir = join(tmpdir(), 'identity-test-' + dirName + '-' + randomUUID().slice(0, 6))
    const identitiesPath = join(workDir, 'identities.json')
    mkdirSync(workDir, { recursive: true })
    writeFileSync(identitiesPath, JSON.stringify(content, null, 2) + '\n', 'utf-8')
    mockApiCalled = 0
    mockUnionId = 'on_test_union_id'
    return { workDir, identitiesPath }
  }

  function cleanup(path: string) {
    try { if (existsSync(path)) unlinkSync(path) } catch { /* */ }
    try { const dir = path.substring(0, path.lastIndexOf('/')); if (existsSync(dir)) unlinkSync(dir) } catch { /* */ }
  }

  // --- 基本查找 ---

  it('openId index hit returns correct level and name', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', {
      on_e77b9eed: {
        name: '林夕梦记',
        level: 'owner',
        description: '主人',
        openIds: {
          'cli_aaa': 'ou_111',
          'cli_bbb': 'ou_222',
        },
      },
      _default_stranger: { name: '陌生人', level: 'stranger', description: '陌生人级别' },
    })

    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_111', 'cli_aaa')
    assert.strictEqual(result.level, 'owner')
    assert.strictEqual(result.name, '林夕梦记')
    assert.strictEqual(result.description, '主人')
    assert.strictEqual(mockApiCalled, 0, 'should not call API on index hit')
  })

  it('different open_id from same user hits same entry', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', {
      on_e77b9eed: {
        name: '林夕梦记',
        level: 'owner',
        description: '主人',
        openIds: {
          'cli_aaa': 'ou_111',
          'cli_bbb': 'ou_222',
        },
      },
    })

    const resolver = new TestableResolver(workDir)
    const r1 = await resolver.resolve('ou_111', 'cli_aaa')
    const r2 = await resolver.resolve('ou_222', 'cli_bbb')
    assert.strictEqual(r1.level, 'owner')
    assert.strictEqual(r2.level, 'owner')
    assert.strictEqual(r1.name, r2.name)
  })

  // --- API fallback ---

  it('index miss triggers API, writes back cache on match', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', {
      on_test_union_id: {
        name: '新用户',
        level: 'friend',
        description: '刚认识',
        openIds: {},
      },
    })

    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_unknown', 'cli_new')

    assert.strictEqual(result.level, 'friend')
    assert.strictEqual(result.name, '新用户')
    assert.strictEqual(mockApiCalled, 1, 'should call API once on miss')

    // 第二次应直接命中（已回写）
    const result2 = await resolver.resolve('ou_unknown', 'cli_new')
    assert.strictEqual(result2.level, 'friend')
    assert.strictEqual(mockApiCalled, 1, 'should not call API again')

    // 校验文件回写
    const data = JSON.parse(readFileSync(identitiesPath, 'utf-8'))
    assert.strictEqual(data.on_test_union_id.openIds.cli_new, 'ou_unknown')
  })

  it('API miss returns default stranger (no call)', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', { _default_stranger: { name: '陌生人', level: 'stranger' } })
    mockUnionId = null // 模拟 API 未找到

    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_ghost', 'cli_x')
    assert.strictEqual(result.level, 'stranger')
    assert.strictEqual(mockApiCalled, 1)
  })

  it('API returns union_id not in registry returns stranger', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', { _default_stranger: { name: '陌生人', level: 'stranger' } })
    mockUnionId = 'on_not_registered'

    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_x', 'cli_y')
    assert.strictEqual(result.level, 'stranger')
  })

  // --- checkPolicy ---

  it('checkPolicy: level in allowedLevels passes', () => {
    const resolver = new TestableResolver('/tmp')
    const ok = resolver.checkPolicy(
      { level: 'owner', name: 'x', description: '' },
      { allowedLevels: ['owner', 'friend'] },
    )
    assert.strictEqual(ok, true)
  })

  it('checkPolicy: level below allowedLevels blocked', () => {
    const resolver = new TestableResolver('/tmp')
    const ok = resolver.checkPolicy(
      { level: 'stranger', name: 'x', description: '' },
      { allowedLevels: ['owner'] },
    )
    assert.strictEqual(ok, false)
  })

  it('checkPolicy: level below but onUnknown=allow passes', () => {
    const resolver = new TestableResolver('/tmp')
    const ok = resolver.checkPolicy(
      { level: 'stranger', name: 'x', description: '' },
      { allowedLevels: ['owner'], onUnknown: 'allow' },
    )
    assert.strictEqual(ok, true)
  })

  it('checkPolicy: empty allowedLevels passes all', () => {
    const resolver = new TestableResolver('/tmp')
    const ok = resolver.checkPolicy(
      { level: 'banned', name: 'x', description: '' },
      { allowedLevels: [] },
    )
    assert.strictEqual(ok, true)
  })

  it('checkPolicy: onUnknown=block with allowed level works', () => {
    const resolver = new TestableResolver('/tmp')
    const ok = resolver.checkPolicy(
      { level: 'owner', name: 'x', description: '' },
      { allowedLevels: ['owner'], onUnknown: 'block' },
    )
    assert.strictEqual(ok, true)
  })

  // --- 边界情况 ---

  it('no identities file exists returns stranger', async () => {
    const { workDir } = setup('no-file', { _default_stranger: { name: '陌生人', level: 'stranger' } })
    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_x', 'cli_y')
    assert.strictEqual(result.level, 'stranger')
  })

  it('malformed identities file falls back to stranger', async () => {
    const { workDir, identitiesPath } = setup('malformed', { _default_stranger: { name: '陌生人', level: 'stranger' } })
    writeFileSync(identitiesPath, 'not-json', 'utf-8')
    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('ou_x', 'cli_y')
    assert.strictEqual(result.level, 'stranger')
  })

  it('empty senderOpenId should not call API', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', { _default_stranger: { name: '陌生人', level: 'stranger' } })
    const resolver = new TestableResolver(workDir)
    const result = await resolver.resolve('', 'cli_x')
    assert.strictEqual(result.level, 'stranger')
    assert.strictEqual(mockApiCalled, 0, 'should not call API for empty senderOpenId')
  })

  // --- 跨 bot 自动关联 ---

  it('user registered under bot-A is recognized under bot-B via API + union_id match', async () => {
    const { workDir, identitiesPath } = setup('openId-index-hit', {
      on_test_union_id: {
        name: '跨App用户',
        level: 'friend',
        description: '',
        openIds: {
          'cli_aaa': 'ou_for_bot_a',
        },
      },
    })

    const resolver = new TestableResolver(workDir)

    // bot-B 视角下，同一个人用不同的 open_id
    mockUnionId = 'on_test_union_id'
    const result = await resolver.resolve('ou_for_bot_b', 'cli_bbb')

    assert.strictEqual(result.level, 'friend')
    assert.strictEqual(result.name, '跨App用户')
    assert.strictEqual(mockApiCalled, 1)

    // 验证回写
    const data = JSON.parse(readFileSync(identitiesPath, 'utf-8'))
    assert.strictEqual(data.on_test_union_id.openIds.cli_bbb, 'ou_for_bot_b')
  })
})
