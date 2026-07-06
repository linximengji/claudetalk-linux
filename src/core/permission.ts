/**
 * 权限引擎核心
 * 本地确定性规则，不依赖 LLM 分类
 *
 * L0: 只读操作 → 直接放行
 * L1: 低风险写操作 → 放行 + 记日志
 * L2: 中等风险 → 需手机审批
 * L3: 高风险 → 需手机审批 + 摘要展示
 */

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3'

// 关键路径正则表——命中这些文件路径的操作自动升级风险等级
const CRITICAL_PATH_PATTERNS = [
  /\.env$/i,
  /settings\.json$/i,
  /\.claudetalk/i,
  /credentials?/i,
  /secrets?/i,
  /token/i,
  /\.ssh\//i,
  /id_rsa/i,
  /\.git\/config/i,
]

// 高风险命令关键词——消息中包含时直接 L3
const HIGH_RISK_KEYWORDS = [
  /\brm\s+-rf\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /\bdrop\s+table\b/i,
  /\bformat\s+/i,
  /\bdel\s+\/f\b/i,
  /\brmdir\s+\/s\b/i,
  /remove\s+--force/i,
  /\bkill\s+-9\b/i,
  /\bmkfs\b/i,
  /\bwget\b.+\|\s*(bash|sh)\b/i,
  /\bcurl\b.+\|\s*(bash|sh)\b/i,
]

// 写操作关键词——消息中包含时至少 L1
const WRITE_KEYWORDS = [
  /\b(写入|修改|编辑|删除|移动|重命名|创建)/,
  /\b(write|edit|delete|remove|mv|rename|cp|mkdir)\b/i,
]

// 高危工具名——CC 调用这些工具时走审批
export const HIGH_RISK_TOOLS = new Set(['Bash', 'Agent', 'Delete'])

// 中危工具名
export const MEDIUM_RISK_TOOLS = new Set(['Write', 'Edit'])

/** 检查消息路径是否命中关键路径 */
function matchesCriticalPath(message: string): boolean {
  return CRITICAL_PATH_PATTERNS.some(p => p.test(message))
}

/** 评估消息风险等级 */
export function assessRisk(message: string): {
  level: RiskLevel
  reason: string
} {
  // 先检查高风险命令关键词
  for (const pattern of HIGH_RISK_KEYWORDS) {
    if (pattern.test(message)) {
      return { level: 'L3', reason: `高风险命令关键词匹配: ${pattern.source.slice(0, 40)}` }
    }
  }

  // 检查关键路径
  if (matchesCriticalPath(message)) {
    return { level: 'L2', reason: '操作涉及敏感配置文件路径' }
  }

  // 检查写操作关键词
  for (const pattern of WRITE_KEYWORDS) {
    if (pattern.test(message)) {
      return { level: 'L1', reason: '包含写操作关键词' }
    }
  }

  return { level: 'L0', reason: '只读操作或非风险消息' }
}

/** 判定工具调用是否需要审批 */
export function requiresApproval(level: RiskLevel): boolean {
  return level === 'L2' || level === 'L3'
}

/** 风险等级标签 */
export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'L0': return '安全'
    case 'L1': return '低风险'
    case 'L2': return '中等风险'
    case 'L3': return '高风险'
  }
}
