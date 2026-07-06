/** 将工具调用转化为一句话步骤总结 */
/**
 * 生成单步总结，合并 tool_use + tool_result 为一句
 * 输出例如 "📖 1. 读取 src/index.ts ✓"
 */
export declare function summarizeStep(stepNumber: number, toolName: string, toolInput: string): string;
//# sourceMappingURL=step-summarizer.d.ts.map