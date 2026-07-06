/**
 * 权限引擎核心
 * 本地确定性规则，不依赖 LLM 分类
 *
 * L0: 只读操作 → 直接放行
 * L1: 低风险写操作 → 放行 + 记日志
 * L2: 中等风险 → 需手机审批
 * L3: 高风险 → 需手机审批 + 摘要展示
 */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export declare const HIGH_RISK_TOOLS: Set<string>;
export declare const MEDIUM_RISK_TOOLS: Set<string>;
/** 评估消息风险等级 */
export declare function assessRisk(message: string): {
    level: RiskLevel;
    reason: string;
};
/** 判定工具调用是否需要审批 */
export declare function requiresApproval(level: RiskLevel): boolean;
/** 风险等级标签 */
export declare function riskLabel(level: RiskLevel): string;
//# sourceMappingURL=permission.d.ts.map