/**
 * Claude CLI 调用层 + Session 管理
 * 两个 Channel（钉钉、Discord）共享此模块，各自独立处理消息后调用 callClaude
 */
import { spawn } from 'child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger, log } from './logger.js';
// Direct path to claude.exe — avoids shell:true which corrupts args on Windows
// (spawn('claude.cmd', args, {shell:true}) concatenates args via cmd.exe, breaking
// long flags like --resume <uuid> and causing STATUS_HEAP_CORRUPTION 0xC0000372)
const CLAUDE_EXE = '/usr/local/bin/claude';
// Re-export for index.ts compatibility
export { createLogger, log } from './logger.js';
// ========== Session 持久化 ==========
// session 文件存放在工作目录下的 .claudetalk-sessions.json
// 注意：SESSION_FILE 在模块加载时还不知道 workDir，所以用函数动态获取路径
function getSessionFile(workDir) {
    return join(workDir, '.claudetalk-sessions.json');
}
function parseSessionEntry(value) {
    if (value && typeof value === 'object' && 'sessionId' in value) {
        const entry = value;
        if (!entry.userId)
            entry.userId = '';
        if (entry.subagentEnabled === undefined)
            entry.subagentEnabled = false;
        if (!entry.channel)
            entry.channel = 'dingtalk';
        return entry;
    }
    return null;
}
function loadSessionMap(workDir) {
    const sessionFile = getSessionFile(workDir);
    if (!existsSync(sessionFile)) {
        return new Map();
    }
    try {
        const content = readFileSync(sessionFile, 'utf-8');
        const raw = JSON.parse(content);
        const entries = new Map();
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        for (const [key, value] of Object.entries(raw)) {
            const entry = parseSessionEntry(value);
            if (!entry)
                continue;
            if (entry.lastActiveAt && now - entry.lastActiveAt > THIRTY_DAYS_MS)
                continue;
            entries.set(key, entry);
        }
        return entries;
    }
    catch (error) {
        log(`[session] Failed to load sessions: ${error}`);
        return new Map();
    }
}
export function saveSessionMap(workDir, sessionMap) {
    const sessionFile = getSessionFile(workDir);
    try {
        const entries = Object.fromEntries(sessionMap);
        // Atomic write: tmp file then rename, preventing corruption on crash
        const tmpFile = sessionFile + '.tmp';
        writeFileSync(tmpFile, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
        renameSync(tmpFile, sessionFile);
    }
    catch (error) {
        log(`[session] Failed to save sessions: ${error}`);
    }
}
// 按 workDir 缓存 session map，避免每次都读文件
const sessionMapCache = new Map();
export function getSessionMap(workDir) {
    if (!sessionMapCache.has(workDir)) {
        sessionMapCache.set(workDir, loadSessionMap(workDir));
    }
    return sessionMapCache.get(workDir);
}
/**
 * 生成 session key
 * 格式：conversationId\x00workDir\x00profile\x00channel
 * 使用 \x00（NUL 字符）作为分隔符，避免路径或 ID 中含有 | 导致解析错误
 * 不同 profile、不同 channel 的 session 完全隔离
 */
export function getSessionKey(conversationId, workDir, profile, channel) {
    const parts = [conversationId, workDir];
    if (profile)
        parts.push(profile);
    if (channel)
        parts.push(channel);
    return parts.join('\x00');
}
// 记录哪些 session 在 claude 进程运行期间被用户显式清除了
// 用于防止 completion handler 把旧 sessionId 写回去（竞态条件修复）
const clearedDuringProcessing = new Set();
/**
 * 清除指定会话的 session
 */
export function clearSession(conversationId, workDir, profile, channel) {
    const sessionMap = getSessionMap(workDir);
    const sessionKey = getSessionKey(conversationId, workDir, profile, channel);
    const hadSession = sessionMap.has(sessionKey);
    if (hadSession) {
        sessionMap.delete(sessionKey);
        saveSessionMap(workDir, sessionMap);
        clearedDuringProcessing.add(sessionKey);
    }
    return hadSession;
}
function wasClearedDuringProcessing(sessionKey, existingSessionId) {
    if (!existingSessionId)
        return false;
    return clearedDuringProcessing.has(sessionKey);
}
/** Consume the cleared flag — only one caller should do this per message */
function consumeClearedFlag(sessionKey, existingSessionId) {
    if (!existingSessionId)
        return false;
    return clearedDuringProcessing.delete(sessionKey);
}
/**
 * 找当前 workDir、channel、profile 下最近活跃的私聊会话，用于发上线通知
 * @param workDir - 工作目录
 * @param channel - 消息通道类型，避免跨 channel 通知
 * @param profile - profile 名称，避免同一 channel 下不同飞书应用（AppId 不同）互相通知
 */
export function findLastActivePrivateSession(workDir, channel, profile) {
    const sessionMap = getSessionMap(workDir);
    let latestEntry = null;
    for (const [key, entry] of sessionMap) {
        const parts = key.split('\x00');
        if (parts[1] !== workDir)
            continue;
        if (entry.isGroup)
            continue;
        if (entry.channel !== channel)
            continue;
        // 过滤 profile：同一 channel 下不同飞书应用的 open_id 不能互用
        if (profile && parts[2] !== profile)
            continue;
        if (!latestEntry || entry.lastActiveAt > latestEntry.lastActiveAt) {
            latestEntry = entry;
        }
    }
    return latestEntry;
}
// ========== 配置加载 ==========
function loadConfigFromFile(filePath, profile) {
    if (!existsSync(filePath)) {
        return null;
    }
    try {
        const content = readFileSync(filePath, 'utf-8');
        const raw = JSON.parse(content);
        if (profile && !raw.profiles?.[profile]) {
            return null;
        }
        const profileOverride = profile ? (raw.profiles?.[profile] ?? {}) : {};
        const config = {
            ...raw,
            ...profileOverride,
            profiles: undefined,
        };
        // Override feishu credentials from global .env (takes precedence over file)
        const envPath = join(process.env.HOME || '~', '.claude', '.env');
        if (existsSync(envPath)) {
            const envContent = readFileSync(envPath, 'utf-8');
            const feishuAppId = envContent.match(/^FEISHU_APP_ID=(.+)$/m)?.[1]?.trim();
            const feishuAppSecret = envContent.match(/^FEISHU_APP_SECRET=(.+)$/m)?.[1]?.trim();
            if (feishuAppId && feishuAppSecret) {
                config.feishu = {
                    FEISHU_APP_ID: feishuAppId.replace(/^['"]|['"]$/g, ''),
                    FEISHU_APP_SECRET: feishuAppSecret.replace(/^['"]|['"]$/g, ''),
                };
            }
        }
        return config;
    }
    catch {
        return null;
    }
}
export function loadConfig(workDir, profile) {
    const localConfigFile = join(workDir, '.claudetalk.json');
    return loadConfigFromFile(localConfigFile, profile);
}
// ========== SubAgent 构建 ==========
/**
 * 解析 .claude/agents/{profileName}.md 文件
 * 格式：YAML frontmatter（---包裹）+ 正文（即 prompt 内容）
 * 返回从文件中提取的 agent 定义字段，优先级高于 .claudetalk.json 中的配置
 */
function parseAgentMdFile(workDir, profileName) {
    const agentFilePath = join(workDir, '.claude', 'agents', `${profileName}.md`);
    if (!existsSync(agentFilePath)) {
        return null;
    }
    try {
        const content = readFileSync(agentFilePath, 'utf-8');
        const result = {};
        // 解析 YAML frontmatter（--- 包裹的部分）
        const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (frontmatterMatch) {
            const yamlSection = frontmatterMatch[1];
            const bodySection = frontmatterMatch[2].trim();
            // 简单解析 YAML 字段（不引入外部依赖）
            for (const line of yamlSection.split('\n')) {
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1)
                    continue;
                const key = line.slice(0, colonIndex).trim();
                const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
                if (key === 'description')
                    result.description = value;
                if (key === 'model')
                    result.model = value;
                if (key === 'tools') {
                    // 支持 tools: [Read, Write] 或 tools: Read, Write 格式
                    result.tools = value.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean);
                }
                if (key === 'disallowedTools') {
                    result.disallowedTools = value.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean);
                }
            }
            // 正文作为 prompt
            if (bodySection) {
                result.prompt = bodySection;
            }
        }
        else {
            // 没有 frontmatter，整个文件内容作为 prompt
            result.prompt = content.trim();
        }
        log(`[agent-md] Loaded agent definition from ${agentFilePath}`);
        return result;
    }
    catch (error) {
        log(`[agent-md] Failed to parse ${agentFilePath}: ${error}`);
        return null;
    }
}
/**
 * 构建 --agents 参数的 JSON 字符串
 * 优先级：.claude/agents/{profileName}.md > .claudetalk.json 中的 systemPrompt 配置
 */
function buildAgentJson(profileName, config, workDir) {
    // 优先读取 .claude/agents/{profileName}.md
    const agentMd = parseAgentMdFile(workDir, profileName);
    const agentDef = agentMd
        ? {
            // 使用 agent.md 中的字段
            description: agentMd.description || `${profileName} 角色助手`,
            prompt: agentMd.prompt || `你是 ${profileName} 角色，负责相关工作。`,
            ...(agentMd.model ? { model: agentMd.model } : {}),
            ...(agentMd.tools?.length ? { tools: agentMd.tools } : {}),
            ...(agentMd.disallowedTools?.length ? { disallowedTools: agentMd.disallowedTools } : {}),
        }
        : {
            // 降级：使用 .claudetalk.json 中的 systemPrompt 配置
            description: config.systemPrompt
                ? `${profileName} 角色助手。${config.systemPrompt}`
                : `${profileName} 角色助手，负责相关工作。`,
            prompt: config.systemPrompt || `你是 ${profileName} 角色，负责相关工作。`,
            ...(config.subagentModel ? { model: config.subagentModel } : {}),
            ...(config.subagentPermissions?.allow?.length ? { tools: config.subagentPermissions.allow } : {}),
            ...(config.subagentPermissions?.deny?.length ? { disallowedTools: config.subagentPermissions.deny } : {}),
        };
    try {
        return JSON.stringify({ [profileName]: agentDef });
    }
    catch {
        return null;
    }
}
function appendTokenLog(workDir, data) {
    try {
        appendFileSync(join(workDir, '.claudetalk', 'token_usage.jsonl'), JSON.stringify(data) + '\n', 'utf-8');
    }
    catch { /* token 日志写入失败不影响主功能 */ }
}
const MAX_SESSION_RETRY_COUNT = 2;
// 所有失败类型的总重试次数（包括 session 失效、process crash、超时等）
const MAX_RETRY_COUNT = 2;
// claude 进程最大等待时间（ms），超过此时间未响应视为挂起
const CLAUDE_TIMEOUT_MS = 240_000;
// 自动压缩的 input token 阈值，超过此值时在响应后异步触发 /compact
const ASYNC_COMPACT_THRESHOLD = 200_000;
// 同步压缩阈值：超过此值时在请求前同步等待 /compact 完成
const SYNC_COMPACT_THRESHOLD = 400_000;
// 自动 summarize+reset 阈值：超过此值时清空 session 并保留摘要
const RESET_THRESHOLD = 600_000;
// 按 sessionKey 存储正在进行的压缩 Promise，用于防止并发操作同一 session
const compactingPromises = new Map();
// 按 sessionKey 串行化消息处理队列，防止并发请求 fork 同一 session
const sessionQueues = new Map();
/** 活跃中的 claude CLI 子进程，用于 graceful drain */
export const activeSubprocesses = new Set();
async function enqueueSession(sessionKey, fn) {
    const prev = (sessionQueues.get(sessionKey) || Promise.resolve()).catch(() => { }); // swallow rejection
    const next = prev.then(() => fn());
    sessionQueues.set(sessionKey, next.then(() => { }));
    return next;
}
/**
 * 对指定 session 执行 /compact 压缩
 * 压缩完成后更新 sessionMap 中的 session_id（Claude CLI 压缩后会返回新的 session_id）
 */
async function compactSession(sessionKey, sessionId, workDir, profile, baseArgs) {
    const logger = createLogger(profile);
    logger(`[compact] Starting auto compact for session: ${sessionId}`);
    return new Promise((resolve) => {
        // 复用相同的 args（含 --resume），发送 /compact 命令
        const compactArgs = [...baseArgs];
        const child = spawn(CLAUDE_EXE, compactArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            shell: false,
        });
        activeSubprocesses.add(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.stdin.write('/compact');
        child.stdin.end();
        child.on('close', (code) => {
            activeSubprocesses.delete(child);
            if (code !== 0) {
                logger(`[compact] Compact failed with code ${code}, stderr: ${stderr}`);
                resolve();
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const lastJsonLine = lines.filter(line => line.startsWith('{')).pop();
                if (lastJsonLine) {
                    const response = JSON.parse(lastJsonLine);
                    if (response.session_id) {
                        const sessionMap = getSessionMap(workDir);
                        const existingEntry = sessionMap.get(sessionKey);
                        if (existingEntry && !wasClearedDuringProcessing(sessionKey, sessionId)) {
                            existingEntry.sessionId = response.session_id;
                            existingEntry.needsCompact = false;
                            saveSessionMap(workDir, sessionMap);
                            logger(`[compact] Compact done, resume session_id: ${response.session_id}`);
                        }
                        else if (existingEntry) {
                            logger(`[compact] Session was cleared during compaction, not saving new session_id`);
                        }
                    }
                }
            }
            catch (parseError) {
                logger(`[compact] Failed to parse compact response: ${parseError}`);
            }
            resolve();
        });
        child.on('error', (error) => {
            logger(`[compact] Spawn error: ${error.message}`);
            resolve();
        });
    });
}
/**
 * 同步 /compact，返回新的 sessionId。失败时返回 undefined，不抛异常。
 */
async function syncCompactSession(sessionKey, sessionId, workDir, profile) {
    const logger = createLogger(profile);
    logger(`[sync-compact] Running sync compact for session: ${sessionId}`);
    const baseArgs = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', sessionId];
    return new Promise((resolve) => {
        const child = spawn(CLAUDE_EXE, baseArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            shell: false,
        });
        activeSubprocesses.add(child);
        let stdout = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stdin.write('/compact');
        child.stdin.end();
        child.on('close', (code) => {
            activeSubprocesses.delete(child);
            if (code !== 0) {
                logger(`[sync-compact] Compact failed code=${code}`);
                resolve(undefined);
                return;
            }
            const lastJson = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
            if (lastJson) {
                try {
                    const r = JSON.parse(lastJson);
                    if (r.session_id) {
                        resolve(r.session_id);
                        return;
                    }
                }
                catch { /* ignore */ }
            }
            resolve(undefined);
        });
        child.on('error', () => resolve(undefined));
    });
}
/**
 * Summarize+reset for very long sessions:
 * 1. Generate summary via claude --resume
 * 2. Clear sessionId (fresh session next request)
 * 3. Keep sessionSummary + reset cumulatedInputTokens
 */
async function summarizeAndReset(sessionKey, sessionId, workDir, profile) {
    const logger = createLogger(profile);
    logger(`[summarize] Starting summarize+reset for session: ${sessionId}`);
    const summaryArgs = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', sessionId];
    const summary = await new Promise((resolve) => {
        const child = spawn(CLAUDE_EXE, summaryArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            shell: false,
        });
        activeSubprocesses.add(child);
        let stdout = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stdin.write('Summarize this entire conversation in 2-3 sentences. Be specific: what was discussed, decided, and what files/code were involved. Keep it concise.');
        child.stdin.end();
        child.on('close', () => {
            activeSubprocesses.delete(child);
            const lastJson = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
            if (lastJson) {
                try {
                    const r = JSON.parse(lastJson);
                    if (r.result) {
                        resolve(r.result);
                        return;
                    }
                }
                catch { /* ignore */ }
            }
            resolve(stdout.trim().slice(0, 500) || 'No summary available');
        });
        child.on('error', () => resolve(''));
    });
    logger(`[summarize] Summary (${summary.length} chars): ${summary.slice(0, 200)}`);
    const sessionMap = getSessionMap(workDir);
    const existingEntry = sessionMap.get(sessionKey);
    if (existingEntry) {
        existingEntry.sessionSummary = summary;
        existingEntry.cumulatedInputTokens = 0;
        existingEntry.sessionId = ''; // fresh session next request
        existingEntry.needsCompact = false;
        saveSessionMap(workDir, sessionMap);
        logger(`[summarize] Reset complete, fresh session will be created next request`);
    }
}
/**
 * Pre-flight session size check before processing a message:
 * - > RESET_THRESHOLD -> summarize+reset
 * - > SYNC_COMPACT_THRESHOLD -> sync compact
 * Mutates sessionMap in place.
 */
async function preProcessSessionCheck(sessionMap, sessionKey, existingEntry, workDir, profile) {
    if (!existingEntry?.sessionId)
        return;
    const cumulated = existingEntry.cumulatedInputTokens ?? 0;
    if (cumulated >= RESET_THRESHOLD) {
        await summarizeAndReset(sessionKey, existingEntry.sessionId, workDir, profile);
        return;
    }
    if (cumulated >= SYNC_COMPACT_THRESHOLD) {
        const newId = await syncCompactSession(sessionKey, existingEntry.sessionId, workDir, profile);
        if (newId) {
            existingEntry.sessionId = newId;
            existingEntry.needsCompact = false;
            saveSessionMap(workDir, sessionMap);
        }
    }
}
function buildClaudeArgs(options) {
    const { message, conversationId, workDir, profile, channel, processedMessage, } = options;
    const logger = createLogger(profile);
    const sessionMap = getSessionMap(workDir);
    const sessionKey = getSessionKey(conversationId, workDir, profile, channel);
    const existingEntry = sessionMap.get(sessionKey);
    const existingSessionId = existingEntry?.sessionId;
    const currentConfig = loadConfig(workDir, profile);
    const currentSubagentEnabled = currentConfig?.subagentEnabled ?? false;
    const currentSystemPrompt = currentConfig?.systemPrompt;
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (existingSessionId && existingEntry) {
        if (profile && currentSubagentEnabled && currentConfig) {
            const agentJson = buildAgentJson(profile, currentConfig, workDir);
            if (agentJson)
                args.push('--agents', agentJson);
        }
        args.push('--resume', existingSessionId);
    }
    else {
        if (profile && currentSubagentEnabled && currentConfig) {
            const agentJson = buildAgentJson(profile, currentConfig, workDir);
            if (agentJson)
                args.push('--agents', agentJson);
        }
        else if (profile && !currentSubagentEnabled && currentSystemPrompt) {
            args.push('--append-system-prompt', currentSystemPrompt);
        }
    }
    const baseMessage = processedMessage ?? message;
    // Inject sessionSummary only on the first request after a reset (no sessionId yet)
    const summaryPrefix = existingEntry?.sessionSummary && !existingEntry?.sessionId
        ? `[Previous conversation summary: ${existingEntry.sessionSummary}]\n\n`
        : '';
    const actualMessage = profile && currentSubagentEnabled
        ? `Use the ${profile} agent to handle this: ${summaryPrefix}${baseMessage}`
        : `${summaryPrefix}${baseMessage}`;
    if (existingSessionId) {
        logger(`[claude] Resuming session: conversationId=${conversationId}`);
    }
    else {
        logger(`[claude] New session: conversationId=${conversationId}, subagentEnabled=${currentSubagentEnabled}`);
    }
    return { args, actualMessage, sessionKey, sessionMap, existingSessionId, currentSubagentEnabled, currentConfig };
}
export async function callClaude(options, retryCount = 0) {
    const sessionKey = getSessionKey(options.conversationId, options.workDir, options.profile, options.channel ?? 'dingtalk');
    return enqueueSession(sessionKey, () => _execClaude(options, retryCount));
}
/**
 * 调用 claude -p CLI 处理消息，支持多轮会话（内部实现，无队列保护）
 *
 * 新建 session 策略：
 * - 有 profile 且启用 SubAgent → 通过 --agents 传入 SubAgent 定义
 * - 有 profile 但未启用 SubAgent → 通过 --append-system-prompt 传入角色信息
 * - 无 profile → 不传额外参数，Claude 自动委托
 */
async function _execClaude(options, retryCount = 0) {
    const { message, conversationId, workDir, isGroup = false, userId = '', profile, channel = 'dingtalk', } = options;
    const logger = createLogger(profile);
    let { args, actualMessage, sessionKey, sessionMap, existingSessionId, currentSubagentEnabled, currentConfig } = buildClaudeArgs(options);
    // 如果当前 session 正在压缩，等待压缩完成后再处理新消息
    const pendingCompact = compactingPromises.get(sessionKey);
    if (pendingCompact) {
        logger(`[claude] Waiting for ongoing compact to finish before processing new message`);
        await pendingCompact;
    }
    // Session 尺寸层级管理：检查 cumulatedInputTokens，按阈值触发 compact/reset
    const sessionEntry = sessionMap.get(sessionKey);
    await preProcessSessionCheck(sessionMap, sessionKey, sessionEntry, workDir, profile);
    // 如果 preProcessSessionCheck 修改了 session（compact/reset），重新构建 args
    if (sessionEntry) {
        const updatedEntry = sessionMap.get(sessionKey);
        if (updatedEntry?.sessionId !== existingSessionId || (!existingSessionId && updatedEntry?.sessionSummary)) {
            const rebuilt = buildClaudeArgs(options);
            args = rebuilt.args;
            actualMessage = rebuilt.actualMessage;
            existingSessionId = rebuilt.existingSessionId;
        }
    }
    const existingEntry = sessionMap.get(sessionKey);
    // 配置变化时清除旧 session
    if (existingSessionId && existingEntry && existingEntry.subagentEnabled !== currentSubagentEnabled) {
        if (retryCount >= MAX_SESSION_RETRY_COUNT) {
            throw new Error(`[session] 配置变更后重建 session 失败，已超过最大重试次数 (${MAX_SESSION_RETRY_COUNT})`);
        }
        logger(`[session] Config changed: subagentEnabled ${existingEntry.subagentEnabled} -> ${currentSubagentEnabled}, clearing old session`);
        sessionMap.delete(sessionKey);
        saveSessionMap(workDir, sessionMap);
        return _execClaude(options, retryCount + 1);
    }
    logger(`[claude] ===== Full Prompt =====`);
    logger(`[claude] args: ${JSON.stringify(args)}`);
    logger(`[claude] prompt (${actualMessage.length} chars):\n${actualMessage}`);
    logger(`[claude] ========================`);
    logger(`[DEBUG-spawn-claude] shell=false platform=${process.platform}`);
    return new Promise((resolve, reject) => {
        const child = spawn(CLAUDE_EXE, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            shell: false,
        });
        activeSubprocesses.add(child);
        // Timeout protection: if claude CLI hangs, kill and retry
        const timer = setTimeout(() => {
            logger(`[claude] TIMEOUT after ${CLAUDE_TIMEOUT_MS}ms, killing process`);
            try {
                child.kill('SIGTERM');
            }
            catch { /* ignore */ }
            // Give 3s for graceful shutdown, then force kill
            setTimeout(() => { try {
                child.kill('SIGKILL');
            }
            catch { /* ignore */ } }, 3000);
        }, CLAUDE_TIMEOUT_MS);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.stdin.write(actualMessage);
        child.stdin.end();
        child.on('close', (code) => {
            clearTimeout(timer);
            activeSubprocesses.delete(child);
            if (code !== 0) {
                const isSessionInvalid = stderr.includes('No conversation found') ||
                    stderr.includes('session ID') ||
                    stderr.includes('Invalid session') ||
                    stderr.includes('Session not found') ||
                    stderr.includes('--resume');
                if (isSessionInvalid) {
                    if (retryCount >= MAX_SESSION_RETRY_COUNT) {
                        reject(new Error(`[session] Session 无效且重试次数已达上限 (${MAX_SESSION_RETRY_COUNT})，请发送"新会话"重置后重试`));
                        return;
                    }
                    logger(`[claude] Session invalid, clearing and retrying (attempt ${retryCount + 1}/${MAX_SESSION_RETRY_COUNT})`);
                    // P3: Capture context before deletion for injection on retry
                    const deadEntry = sessionMap.get(sessionKey);
                    const deadSummary = deadEntry?.sessionSummary;
                    const deadLastMsg = deadEntry?.lastMessage;
                    sessionMap.delete(sessionKey);
                    saveSessionMap(workDir, sessionMap);
                    // Inject context so fresh session carries forward conversation state
                    const injectedContext = deadSummary
                        || (deadLastMsg ? `[Previous interaction]\nUser: ${deadLastMsg}\nAssistant: ${deadEntry?.lastReply || '(no reply)'}` : undefined);
                    if (injectedContext) {
                        options = { ...options, processedMessage: `[Context from previous session: ${injectedContext}]\n\n${options.processedMessage ?? options.message}` };
                    }
                    _execClaude(options, retryCount + 1).then(resolve).catch(reject);
                    return;
                }
                if (stderr.includes('Permission denied') || stderr.includes('EACCES')) {
                    reject(new Error(`Claude CLI 权限错误: ${stderr}`));
                    return;
                }
                if (stderr.includes('command not found') || stderr.includes('ENOENT')) {
                    reject(new Error(`Claude CLI 未找到，请确认已安装: ${stderr}`));
                    return;
                }
                // P3: Broad retry for non-session errors (process crash, timeout, etc.)
                if (retryCount < MAX_RETRY_COUNT) {
                    const logSig = stderr ? stderr.slice(0, 80) : (stdout ? stdout.slice(0, 80) : 'no output');
                    logger(`[claude] Exit code ${code}, retrying (attempt ${retryCount + 1}/${MAX_RETRY_COUNT}) signal=${logSig}`);
                    _execClaude(options, retryCount + 1).then(resolve).catch(reject);
                    return;
                }
                const exitCodeHex = code != null ? `0x${code.toString(16).toUpperCase()}` : '';
                logger(`[claude] Exit code ${code} (${exitCodeHex}), stderr=${stderr ? stderr.slice(0, 200) : '(empty)'}`);
                reject(new Error(`claude exited with code ${code}. stderr: ${stderr || '(empty)'}, stdout: ${stdout || '(empty)'}`));
                return;
            }
            try {
                const lines = stdout.trim().split('\n');
                const lastJsonLine = lines.filter(line => line.startsWith('{')).pop();
                if (!lastJsonLine) {
                    resolve(stdout.trim());
                    return;
                }
                const response = JSON.parse(lastJsonLine);
                // 真实 token 消耗在 modelUsage 中（usage.input_tokens 通常为 0）
                const modelUsageValues = response.modelUsage ? Object.values(response.modelUsage) : [];
                const inputTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0);
                const outputTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0);
                const cacheReadTokens = modelUsageValues.reduce((sum, usage) => sum + (usage.cacheReadInputTokens ?? 0), 0);
                const totalCost = modelUsageValues.reduce((sum, usage) => sum + (usage.costUSD ?? 0), 0);
                logger(`[claude] Done: duration=${response.duration_ms}ms, session_id=${response.session_id}, input_tokens=${inputTokens}, cache_read_tokens=${cacheReadTokens}`);
                appendTokenLog(workDir, {
                    ts: new Date().toISOString(),
                    workDir,
                    model: Object.keys(response.modelUsage || {}).join(','),
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    costUSD: totalCost,
                    duration_ms: response.duration_ms,
                    session_id: response.session_id,
                });
                if (!consumeClearedFlag(sessionKey, existingSessionId)) {
                    const entry = sessionMap.get(sessionKey) ?? {};
                    const prevCumulated = entry.cumulatedInputTokens ?? 0;
                    const prevToolCalls = entry.toolCallCount ?? 0;
                    const newSessionId = response.session_id || existingSessionId || '';
                    sessionMap.set(sessionKey, {
                        sessionId: newSessionId,
                        lastActiveAt: Date.now(),
                        isGroup,
                        conversationId,
                        userId,
                        subagentEnabled: currentSubagentEnabled,
                        channel,
                        cumulatedInputTokens: prevCumulated + inputTokens,
                        sessionSummary: entry.sessionSummary,
                        name: entry.name,
                        toolCallCount: prevToolCalls + 1,
                        lastMessage: options.message.slice(0, 200),
                        lastReply: (response.result || '').slice(0, 500),
                    });
                    saveSessionMap(workDir, sessionMap);
                }
                else {
                    logger(`[claude] Session was cleared by user during processing, not saving old session_id`);
                }
                if (response.is_error) {
                    reject(new Error(`Claude error: ${response.result}`));
                    return;
                }
                // 先返回结果给用户，再异步触发压缩（用户无感知）
                // 注意：response.result 可能是空字符串（agent 只做了工具调用没有文字回复）
                // 不能 fallback 到 stdout.trim()，否则会把整个原始 JSON 返回给 IM
                resolve(response.result || '任务执行完成，无需特殊提醒');
                // 响应后异步触发压缩（仅当小于 sync compact 阈值，避免重复压缩）
                const newEntry = sessionMap.get(sessionKey);
                const cumulatedAfter = (newEntry?.cumulatedInputTokens ?? 0);
                if (response.session_id
                    && inputTokens > ASYNC_COMPACT_THRESHOLD
                    && cumulatedAfter < SYNC_COMPACT_THRESHOLD) {
                    logger(`[compact] input_tokens (${inputTokens}) exceeded ${ASYNC_COMPACT_THRESHOLD}, cumulated=${cumulatedAfter}, triggering async compact`);
                    // 构建压缩用的 args（复用当前 args，但确保含 --resume）
                    const compactArgs = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', response.session_id];
                    if (profile && currentSubagentEnabled && currentConfig) {
                        const agentJson = buildAgentJson(profile, currentConfig, workDir);
                        if (agentJson)
                            compactArgs.splice(1, 0, '--agents', agentJson);
                    }
                    const compactPromise = compactSession(sessionKey, response.session_id, workDir, profile, compactArgs)
                        .finally(() => {
                        compactingPromises.delete(sessionKey);
                    });
                    compactingPromises.set(sessionKey, compactPromise);
                }
            }
            catch (parseError) {
                logger(`[claude] Failed to parse JSON, returning raw output: ${parseError}`);
                resolve(stdout.trim());
            }
        });
        child.on('error', (error) => {
            logger(`[claude] Spawn error: ${error.message}`);
            reject(error);
        });
    });
}
export async function callClaudeStreaming(options, onEvent, retryCount = 0) {
    const sessionKey = getSessionKey(options.conversationId, options.workDir, options.profile, options.channel ?? 'dingtalk');
    return enqueueSession(sessionKey, () => _execClaudeStreaming(options, onEvent, retryCount));
}
/**
 * 流式调用 claude -p CLI，使用 stream-json 格式实时推送中间状态
 * 通过 onEvent 回调逐事件通知：thinking / tool_use / tool_result / text / result
 * 与 callClaude 共享 args 构建和 session 管理逻辑（内部实现，无队列保护）
 */
async function _execClaudeStreaming(options, onEvent, retryCount = 0) {
    const { workDir, isGroup = false, userId = '', profile, channel = 'dingtalk', } = options;
    const logger = createLogger(profile);
    let { args, actualMessage, sessionKey, sessionMap, existingSessionId, currentSubagentEnabled, currentConfig } = buildClaudeArgs(options);
    // 替换 output-format 为 stream-json
    const fmtIndex = args.indexOf('--output-format');
    if (fmtIndex !== -1) {
        args[fmtIndex + 1] = 'stream-json';
        // stream-json + -p always needs --verbose
        if (!args.includes('--verbose')) {
            args.push('--verbose');
        }
    }
    // 等待 compaction 完成
    const pendingCompact = compactingPromises.get(sessionKey);
    if (pendingCompact) {
        logger(`[claude] Waiting for ongoing compact to finish before processing new message`);
        await pendingCompact;
    }
    // Session 尺寸层级管理
    const sessionEntry2 = sessionMap.get(sessionKey);
    await preProcessSessionCheck(sessionMap, sessionKey, sessionEntry2, workDir, profile);
    if (sessionEntry2) {
        const updatedEntry2 = sessionMap.get(sessionKey);
        if (updatedEntry2?.sessionId !== existingSessionId || (!existingSessionId && updatedEntry2?.sessionSummary)) {
            const rebuilt = buildClaudeArgs(options);
            args = rebuilt.args;
            actualMessage = rebuilt.actualMessage;
            existingSessionId = rebuilt.existingSessionId;
            // Re-apply stream-json after rebuild
            const fi = args.indexOf('--output-format');
            if (fi !== -1)
                args[fi + 1] = 'stream-json';
            if (!args.includes('--verbose'))
                args.push('--verbose');
        }
    }
    // 配置变化时清除旧 session，降级到非流式重试
    const existingEntry = sessionMap.get(sessionKey);
    if (existingSessionId && existingEntry && existingEntry.subagentEnabled !== currentSubagentEnabled) {
        logger(`[session] Config changed during streaming, falling back to non-streaming callClaude`);
        sessionMap.delete(sessionKey);
        saveSessionMap(workDir, sessionMap);
        const result = await _execClaude(options, 0);
        return { sessionId: '', result };
    }
    logger(`[claude-stream] ===== Full Prompt =====`);
    logger(`[claude-stream] args: ${JSON.stringify(args)}`);
    logger(`[claude-stream] prompt (${actualMessage.length} chars):\n${actualMessage}`);
    logger(`[claude-stream] ========================`);
    logger(`[DEBUG-spawn-stream] shell=false platform=${process.platform}`);
    return new Promise((resolve, reject) => {
        // Timeout protection: if claude CLI hangs during streaming, kill and retry
        const child = spawn(CLAUDE_EXE, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: workDir,
            shell: false,
        });
        activeSubprocesses.add(child);
        // Timeout protection: if claude CLI hangs during streaming, kill and retry
        const timer = setTimeout(() => {
            logger(`[claude-stream] TIMEOUT after ${CLAUDE_TIMEOUT_MS}ms, killing process`);
            try {
                child.kill('SIGTERM');
            }
            catch { /* ignore */ }
            setTimeout(() => { try {
                child.kill('SIGKILL');
            }
            catch { /* ignore */ } }, 3000);
        }, CLAUDE_TIMEOUT_MS);
        let stderr = '';
        let finalResult = '';
        let finalSessionId = existingSessionId || '';
        let buffer = '';
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留不完整的最后一行
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{'))
                    continue;
                try {
                    const event = JSON.parse(trimmed);
                    const sessionId = event.session_id || '';
                    if (sessionId)
                        finalSessionId = sessionId;
                    if (event.type === 'system')
                        continue; // 跳过 system 事件
                    if (event.type === 'assistant' && event.message?.content) {
                        for (const block of event.message.content) {
                            if (block.type === 'thinking' && block.thinking) {
                                onEvent({ type: 'thinking', thinking: block.thinking, sessionId, isFinal: false });
                            }
                            else if (block.type === 'text' && block.text) {
                                onEvent({ type: 'text', text: block.text, sessionId, isFinal: false });
                            }
                            else if (block.type === 'tool_use') {
                                const inputStr = block.input ? JSON.stringify(block.input) : '';
                                const inputPreview = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
                                onEvent({
                                    type: 'tool_use',
                                    toolName: block.name,
                                    toolInput: inputPreview,
                                    sessionId,
                                    isFinal: false,
                                });
                            }
                        }
                    }
                    else if (event.type === 'user' && event.message?.content) {
                        for (const block of event.message.content) {
                            if (block.type === 'tool_result') {
                                const resultStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                                const resultPreview = resultStr.length > 300 ? resultStr.slice(0, 300) + '...' : resultStr;
                                onEvent({
                                    type: 'tool_result',
                                    toolResult: resultPreview,
                                    sessionId,
                                    isFinal: false,
                                });
                            }
                        }
                    }
                    else if (event.type === 'result') {
                        finalResult = event.result || '';
                        finalSessionId = event.session_id || finalSessionId;
                        onEvent({
                            type: 'result',
                            text: finalResult,
                            sessionId,
                            isFinal: true,
                            finalResult,
                        });
                        // token 日志
                        const muValues = event.modelUsage ? Object.values(event.modelUsage) : [];
                        appendTokenLog(workDir, {
                            ts: new Date().toISOString(),
                            workDir,
                            model: Object.keys(event.modelUsage || {}).join(','),
                            inputTokens: muValues.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
                            outputTokens: muValues.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
                            cacheReadTokens: muValues.reduce((s, u) => s + (u.cacheReadInputTokens ?? 0), 0),
                            costUSD: muValues.reduce((s, u) => s + (u.costUSD ?? 0), 0),
                            session_id: finalSessionId,
                        });
                        // 持久化 session（包含累积 token 跟踪）
                        if (!consumeClearedFlag(sessionKey, existingSessionId)) {
                            const streamMuValues = event.modelUsage ? Object.values(event.modelUsage) : [];
                            const streamInputTokens = streamMuValues.reduce((s, u) => s + (u.inputTokens ?? 0), 0);
                            const prevEntry = sessionMap.get(sessionKey);
                            const prevCumulated = (prevEntry?.cumulatedInputTokens ?? 0);
                            const prevToolCalls = (prevEntry?.toolCallCount ?? 0);
                            const newStreamSessionId = finalSessionId || existingSessionId || '';
                            sessionMap.set(sessionKey, {
                                sessionId: newStreamSessionId,
                                lastActiveAt: Date.now(),
                                isGroup,
                                conversationId: options.conversationId,
                                userId,
                                subagentEnabled: currentSubagentEnabled,
                                channel,
                                cumulatedInputTokens: prevCumulated + streamInputTokens,
                                sessionSummary: prevEntry?.sessionSummary,
                                name: prevEntry?.name,
                                toolCallCount: prevToolCalls + 1,
                                lastMessage: options.message.slice(0, 200),
                                lastReply: finalResult.slice(0, 500),
                            });
                            saveSessionMap(workDir, sessionMap);
                        }
                        else {
                            logger(`[claude-stream] Session was cleared by user during processing, not saving old session_id`);
                        }
                    }
                }
                catch {
                    // 跳过无法解析的行
                }
            }
        });
        child.stdin.write(actualMessage);
        child.stdin.end();
        child.on('close', (code) => {
            clearTimeout(timer);
            activeSubprocesses.delete(child);
            if (code !== 0) {
                const isSessionInvalid = stderr.includes('No conversation found') ||
                    stderr.includes('session ID') ||
                    stderr.includes('Invalid session') ||
                    stderr.includes('Session not found');
                if (isSessionInvalid) {
                    if (retryCount >= MAX_SESSION_RETRY_COUNT) {
                        logger(`[claude-stream] Session invalid, max retries reached`);
                        reject(new Error(`会话已过期且重试次数已达上限，请发送"新会话"重置后重试`));
                        return;
                    }
                    logger(`[claude-stream] Session invalid, clearing and retrying as new session (attempt ${retryCount + 1}/${MAX_SESSION_RETRY_COUNT})`);
                    // P3: Capture context before deletion for injection on retry
                    const deadEntry = sessionMap.get(sessionKey);
                    const deadSummary = deadEntry?.sessionSummary;
                    const deadLastMsg = deadEntry?.lastMessage;
                    sessionMap.delete(sessionKey);
                    saveSessionMap(workDir, sessionMap);
                    // Inject context so fresh session carries forward conversation state
                    const injectedContext = deadSummary
                        || (deadLastMsg ? `[Previous interaction]\nUser: ${deadLastMsg}\nAssistant: ${deadEntry?.lastReply || '(no reply)'}` : undefined);
                    if (injectedContext) {
                        options = { ...options, processedMessage: `[Context from previous session: ${injectedContext}]\n\n${options.processedMessage ?? options.message}` };
                    }
                    _execClaudeStreaming(options, onEvent, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                // P3: Broad retry for non-session errors in streaming path
                if (retryCount < MAX_RETRY_COUNT) {
                    const logSig = stderr ? stderr.slice(0, 80) : 'no output (streaming)';
                    logger(`[claude-stream] Exit code ${code}, retrying (attempt ${retryCount + 1}/${MAX_RETRY_COUNT}) signal=${logSig}`);
                    _execClaudeStreaming(options, onEvent, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
                const exitCodeHex = code != null ? `0x${code.toString(16).toUpperCase()}` : '';
                logger(`[claude-stream] Exit code ${code} (${exitCodeHex}), stderr=${stderr ? stderr.slice(0, 200) : '(empty)'}`);
                reject(new Error(`claude exited with code ${code}. stderr: ${stderr || '(empty)'}`));
                return;
            }
            // 处理 buffer 中可能残留的完整行
            if (buffer.trim().startsWith('{')) {
                try {
                    const event = JSON.parse(buffer.trim());
                    if (event.type === 'result') {
                        finalResult = event.result || '';
                        if (event.session_id)
                            finalSessionId = event.session_id;
                        const muValues = event.modelUsage ? Object.values(event.modelUsage) : [];
                        appendTokenLog(workDir, {
                            ts: new Date().toISOString(),
                            workDir,
                            model: Object.keys(event.modelUsage || {}).join(','),
                            inputTokens: muValues.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
                            outputTokens: muValues.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
                            cacheReadTokens: muValues.reduce((s, u) => s + (u.cacheReadInputTokens ?? 0), 0),
                            costUSD: muValues.reduce((s, u) => s + (u.costUSD ?? 0), 0),
                            session_id: finalSessionId,
                        });
                    }
                }
                catch { /* ignore */ }
            }
            resolve({ sessionId: finalSessionId, result: finalResult });
        });
        child.on('error', (error) => {
            logger(`[claude-stream] Spawn error: ${error.message}`);
            reject(error);
        });
    });
}
//# sourceMappingURL=claude.js.map