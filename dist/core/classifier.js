import { createLogger } from './logger.js';
const PROXY_URL = process.env.CLASSIFIER_PROXY_URL || 'http://localhost:4000/v1/chat/completions';
const CLASSIFY_MODEL = process.env.CLASSIFIER_MODEL || 'deepseek-v4-flash';
const TIMEOUT_MS = 10000;
// 关键词规则：在调 LLM 前快速判定，避免超时/模型抖动影响
const PENDING_RE = /留到终端|加.*待办|终端[做处理]|终端修改|终端部署|加入手机/;
const COMPLETED_RE = /^已(完成|修复|修改|处理|创建|生成)|修好了|搞定|搞定了/;
const PENDING_FALLBACK_RE = /需要本地|要在终端|留到下次/;
// 高风险命令黑名单——命中直接分类为 task-pending，触发权限引擎
const HIGH_RISK_COMMANDS = [
    /\brm\s+-rf\b/i,
    /\bdd\s+if=\/dev\/zero/i,
    /\bchmod\s+777\b/i,
    /\bdrop\s+table\b/i,
    /\bformat\s+\w:\s*\/fs:/i,
    /\bdel\s+\/f\s+\/s\b/i,
    /\brmdir\s+\/s\b/i,
    /\bmkfs\b/i,
    /\bwget\b.+\|\s*(bash|sh)\b/i,
    /\bcurl\b.+\|\s*(bash|sh)\b/i,
    /rm\s+-rf\s+\$/i,
    /remove-item\s+-recurse/i,
    /清空.*(目录|磁盘|日志|数据)/,
    /删除.*(所有|全部|系统)/,
];
const SYSTEM_PROMPT = `你是一个对话分类器。分析用户消息和 Claude 回复，输出三类之一。

输出 completed 如果：
- Claude 回复明确说"已完成"/"已修复"/"已修改"/"修好了"/"搞定"/"已处理"/"已创建"/"已生成"
- 并且 Claude 调用了实质工具（Write/Edit/Bash/Exec 等）
- 等同于：问题已经在本地处理完了

输出 task-pending 如果：
- 用户要求"加到待办""留到终端处理"
- Claude 说需要本地终端操作（"在终端修改""需要本地环境"）
- 问题已定位但需要后续修复/配置/部署/创建
- 工具已调用但未明确说完成（还在处理中）

输出 reference 如果：
- Claude 已完整回答问题（调研、分析、解释、讨论）
- 一般讨论、闲聊、无实质产出的对话
- Claude 回复中未提"已完成"/"已修复"等完成词

示例：
用户消息: 调研一下 MCP server 的用途
回复: MCP server 是...（长篇分析）
工具调用: 无
→ reference

用户消息: 修一下这个 bug
回复: bug 已修复，修改了 config.ts
工具调用: Write, Bash
→ completed

用户消息: 也加到终端待办事项里去
回复: 已经加上了
工具调用: 无
→ task-pending

用户消息: 分析一下这个业务模式
回复: 该业务模式...（详细分析）
工具调用: Read, Grep
→ reference

用户消息: 把这个配置改了
回复: 已修改了配置
工具调用: Edit
→ completed

只输出一个词：completed 或 task-pending 或 reference`;
export async function classifyConversation(message, reply, toolNames) {
    const logger = createLogger();
    // 本地规则预检（先于 LLM 调用）
    const localResult = classifyLocal(message, reply, toolNames);
    if (localResult !== null) {
        logger(`[classifier] local -> ${localResult}`);
        return localResult;
    }
    // LLM 分类（带一次 404/网络错误重试）
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const prompt = `## 用户消息\n${message.slice(0, 2000)}\n\n## Claude回复\n${reply.slice(0, 3000)}\n\n## 调用工具\n${toolNames.join(', ') || '无'}\n\n分类：`;
            const res = await fetch(PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
                body: JSON.stringify({
                    model: CLASSIFY_MODEL,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: prompt },
                    ],
                    max_tokens: 10,
                    temperature: 0,
                    stream: false,
                }),
            });
            if (!res.ok) {
                logger(`[classifier] HTTP ${res.status} (attempt ${attempt + 1}/2)`);
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                return fallback(message, reply, toolNames);
            }
            const data = await res.json();
            const text = data?.choices?.[0]?.message?.content?.trim().toLowerCase() || '';
            if (text === 'completed' || text === 'task-pending') {
                const result = text;
                logger(`[classifier] llm -> ${result}`);
                return result;
            }
            logger(`[classifier] llm -> reference (${text || 'empty'})`);
            return 'reference';
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger(`[classifier] error: ${msg} (attempt ${attempt + 1}/2)`);
            if (attempt === 0) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            return fallback(message, reply, toolNames);
        }
    }
    return fallback(message, reply, toolNames);
}
/** 关键词预检：不依赖 LLM，快速判定 */
function classifyLocal(message, reply, _toolNames) {
    // 高风险命令检查（优先于其他规则）
    for (const pattern of HIGH_RISK_COMMANDS) {
        if (pattern.test(message))
            return 'task-pending';
    }
    if (PENDING_RE.test(message))
        return 'task-pending';
    if (COMPLETED_RE.test(reply))
        return 'completed';
    return null;
}
/** LLM 调用失败时的降级规则 */
function fallback(message, reply, toolNames) {
    // 工具调用多 → 大概率已完成
    if (toolNames.length > 2)
        return 'completed';
    // 回复暗示后续操作
    if (PENDING_FALLBACK_RE.test(reply))
        return 'task-pending';
    return 'reference';
}
//# sourceMappingURL=classifier.js.map