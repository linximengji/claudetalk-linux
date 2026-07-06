/** 将工具调用转化为一句话步骤总结 */
function extractArg(inputJson, key) {
    try {
        const obj = JSON.parse(inputJson);
        const val = obj[key];
        return typeof val === 'string' ? val : JSON.stringify(val);
    }
    catch {
        const m = inputJson.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
        return m ? m[1] : '';
    }
}
function truncate(s, maxLen) {
    return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}
/**
 * 生成单步总结，合并 tool_use + tool_result 为一句
 * 输出例如 "📖 1. 读取 src/index.ts ✓"
 */
export function summarizeStep(stepNumber, toolName, toolInput) {
    const n = stepNumber;
    switch (toolName) {
        case 'Read': {
            const path = extractArg(toolInput, 'file_path');
            return `📖 ${n}. 读取 ${truncate(path || '文件', 50)} ✓`;
        }
        case 'Write': {
            const path = extractArg(toolInput, 'file_path');
            return `✏️ ${n}. 写入 ${truncate(path || '文件', 50)} ✓`;
        }
        case 'Edit': {
            const path = extractArg(toolInput, 'file_path');
            return `📝 ${n}. 修改 ${truncate(path || '文件', 50)} ✓`;
        }
        case 'Bash': {
            const cmd = extractArg(toolInput, 'command');
            return `💻 ${n}. ${truncate(cmd || '执行命令', 40)} ✓`;
        }
        case 'Glob': {
            const pattern = extractArg(toolInput, 'pattern');
            return `🔍 ${n}. 搜索 ${truncate(pattern || '', 40)} ✓`;
        }
        case 'Grep': {
            const pattern = extractArg(toolInput, 'pattern');
            return `🔎 ${n}. 搜索 ${truncate(pattern || '', 30)} ✓`;
        }
        case 'Agent': {
            const desc = extractArg(toolInput, 'description') || extractArg(toolInput, 'prompt') || '';
            return `🤖 ${n}. ${truncate(desc, 30)} ✓`;
        }
        case 'WebSearch':
        case 'WebFetch': {
            const query = extractArg(toolInput, 'query');
            return `🌐 ${n}. 搜索: ${truncate(query || '...', 30)} ✓`;
        }
        default:
            return `🔧 ${n}. ${toolName || '工具'} ✓`;
    }
}
//# sourceMappingURL=step-summarizer.js.map