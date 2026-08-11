/**
 * ClaudeTalk 启动入口
 * 根据 profile 配置的 channel 类型，创建对应的 Channel 实例并启动
 */

import { getChannelDescriptor } from './channels/index.js'
import { callClaude, callClaudeStreaming, clearSession, createLogger, findLastActivePrivateSession, loadConfig, activeSubprocesses, setDraining } from './core/claude.js'
import type { StreamEvent } from './core/claude.js'
import { HELP_TEXT } from './utils/index.js'
import { isCloudflaredAlive, getCloudflaredPath } from './core/proc.js'
import { summarizeStep } from './core/step-summarizer.js'
import { archiveConversation, writeTaskToIndex } from './core/phone-archive.js'
import { logInteraction, logConversation } from './core/twin-interactions.js'
import { chatWithEntity } from './core/twin-entity.js'
import { getPhoneTasksDir, OPS_DAEMON_DIR } from './core/paths.js'
import { closeLogFile, initLogFile } from './core/logger.js'
import { stopMcpServer } from './mcp-server.js'
import { handleSessionCommand } from './commands/session.js'
import { handleTaskCommand } from './commands/task.js'
import { assessRisk, requiresApproval, riskLabel } from './core/permission.js'
import { buildApprovalCard, registerApproval, nextRequestId, buildTaskConfirmCard, inferTaskType, inferTaskPriority } from './channels/feishu/approval-handler.js'
import { exec, spawn, execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'fs'
import { IdentityResolver } from './core/identity.js'
import { request as httpRequest } from 'http'
import { join, resolve } from 'path'
import type { Channel, ChannelMessageContext, ClaudeTalkConfig, IdentityResult } from './types.js'

// OpenTelemetry init — before any channel or HTTP activity
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

const otelSdk = new NodeSDK({
  serviceName: "claudetalk",
  traceExporter: new OTLPTraceExporter({ url: "http://localhost:4317/v1/traces" }),
  instrumentations: [new HttpInstrumentation()],
});

import { trace } from "@opentelemetry/api";
const _tracer = trace.getTracer("claudetalk");
otelSdk.start();

export interface StartBotOptions {
  workDir: string
  profile?: string
}

// 内置指令列表
const RESET_COMMANDS = new Set(['新会话', '清空记忆', '/new'])
const HELP_COMMANDS = new Set(['/help', '帮助'])
// TERMINAL_OPEN/CLOSE moved to feishu-bridge.ts — claudetalk skips remote commands
const STATUS_COMMANDS = new Set(['/status', '状态'])
const TASKS_COMMANDS = new Set(['/tasks', '手机待办'])
const LOG_COMMANDS = new Set(['/log', '日志'])
const QUICK_ARCHIVE_COMMANDS = new Set(['加入手机待办', '加入手机待办事项'])


function isTaskCommand(text: string): boolean {
  return text === '/task' || text.startsWith('/task ') || text === '后台任务' || text.startsWith('后台任务 ')
}

function isSessionCommand(text: string): boolean {
  return text === '/session' || text.startsWith('/session ') || text === '会话' || text.startsWith('会话 ')
}

function httpHealthCheck(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function httpRequestCheck(path: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

function waitForHttpHealth(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      httpHealthCheck(port).then(ok => {
        if (ok) resolve(true)
        else setTimeout(poll, 1000)
      })
    }
    poll()
  })
}

function httpPortGone(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      httpHealthCheck(port).then(ok => {
        if (ok) setTimeout(poll, 500)
        else resolve(true)
      })
    }
    poll()
  })
}

const CLOUDFLARED = getCloudflaredPath()

function tunnelHealthCheck(): Promise<boolean> {
  return new Promise(resolve => {
    exec(`"${CLOUDFLARED}" tunnel info remote-terminal`, { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(false); return }
      resolve(stdout.includes('CONNECTOR ID'))
    })
  })
}

function waitForTunnelHealth(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      tunnelHealthCheck().then(ok => {
        if (ok) resolve(true)
        else setTimeout(poll, 1000)
      })
    }
    poll()
  })
}

function cloudflaredProcAlive(): Promise<boolean> {
  return isCloudflaredAlive()
}

function waitForTunnelGone(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise(resolve => {
    const poll = () => {
      if (Date.now() >= end) { resolve(false); return }
      cloudflaredProcAlive().then(ok => {
        if (ok) setTimeout(poll, 500)
        else resolve(true)
      })
    }
    poll()
  })
}

async function twinFeedResponse(workDir: string, content: string, sourceRef: string): Promise<void> {
  // 优先通过实体 /tool 写入（所有写入收敛实体）；实体不可达则 spawn 本地（fallback）
  try {
    const url = process.env.TWIN_ENTITY_URL || 'http://127.0.0.1:8790'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(`${url}/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'twin_ingest_user', params: { content, source_ref: sourceRef, source: 'twin_user' } }),
        signal: controller.signal,
      })
      const data = await res.json()
      if (res.ok && data?.ok) {
        const r = data.result || {}
        if (r.skipped === 'no_stance') console.log('[twinFeedResponse] gap skipped: ' + (r.gap_dimension || '?'))
        else if (r.gap_matched) console.log('[twinFeedResponse] gap answered: ' + (r.gap_dimension || '?'))
        return
      }
      throw new Error(data?.error || `entity /tool twin_ingest_user failed: ${res.status}`)
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    void workDir
    // fallback：本地 spawn
    await new Promise<void>((resolve, reject) => {
      const child = spawn('python3', [
        '-c',
        'import sys, json\n'
        + "sys.path.insert(0, '/home/ubuntu/projects/digital-clone')\n"
        + 'from twin.gap_detector import ingest_twin_message\n'
        + 'result = ingest_twin_message(content=sys.argv[1], source_ref=sys.argv[2], source=sys.argv[3])\n'
        + 'print(json.dumps(result, ensure_ascii=False))',
        content, sourceRef, 'twin_user',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('exit', code => {
        if (code === 0) {
          if (stdout) {
            try {
              const r = JSON.parse(stdout.trim().split('\n').pop() || '{}')
              if (r.skipped === 'no_stance') console.log('[twinFeedResponse] gap skipped: ' + (r.gap_dimension || '?'))
              else if (r.gap_matched) console.log('[twinFeedResponse] gap answered: ' + (r.gap_dimension || '?'))
            } catch { /* ignore parse error */ }
          }
          resolve()
        } else reject(new Error('twinFeedResponse exit ' + code + ': ' + stderr.slice(0, 200)))
      })
      child.on('error', reject)
    })
  }
}

/** Call twin_chat via direct Python spawn, bypassing Claude API. */
function callTwinChat(query: string, caller: 'owner' | 'external', context?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mode = detectProfileMode(query, caller)
    const child = spawn('python3', [
      '-c',
      `import sys, json
sys.path.insert(0, '/home/ubuntu/projects/digital-clone')
from twin.tools import handle_twin_chat
result = handle_twin_chat(query=sys.argv[1], caller=sys.argv[2], mode=sys.argv[4], context=sys.argv[3] if sys.argv[3] else None)
print(result)`,
      query, caller, context || '', mode,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('exit', code => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout.trim())
          resolve(parsed.answer ?? parsed.response ?? stdout.trim())
        } catch {
          resolve(stdout.trim())
        }
      } else {
        console.error(`[callTwinChat] exit ${code}: ${stderr.slice(0, 200)}`)
        reject(new Error(`callTwinChat exit ${code}`))
      }
    })
    child.on('error', reject)
  })
}

/**
 * 流式调用 twin_chat：spawn Python 逐行读 NDJSON 事件（thought_delta/answer_delta/done）。
 * 返回最终 answer 文本；onEvent 回调每收到一个事件就触发（供飞书流式推送）。
 */
/**
 * 检测 twin 对话的定制模式：
 * - "审视/核对" 意图 → review（分身挑待核对记忆，主人确认/纠正）
 * - 其余画像总结意图 → profile（跨类型高置信召回总结）
 * 仅 owner 触发。
 */
function detectProfileMode(query: string, caller: 'owner' | 'external'): 'profile' | 'review' | 'normal' {
  if (caller !== 'owner') return 'normal'
  const q = query.toLowerCase()
  const reviewPhrases = ['自我审视', '审视一下', '审视', '核对一下', '核对记忆', '你确认一下', '查看我的记忆']
  const profilePhrases = [
    '总结我的', '我的决策', '决策逻辑', '我的习惯', '行为模式', '我的价值观',
    '我是怎么', '我的思维方式', '我的性格', '我是什么样的人', '分析我',
  ]
  if (reviewPhrases.some(p => q.includes(p))) return 'review'
  if (profilePhrases.some(p => q.includes(p))) return 'profile'
  return 'normal'
}

function callTwinChatStream(
  query: string,
  caller: 'owner' | 'external',
  context: string | undefined,
  onEvent: (evt: { type: string; text?: string; answer?: string; thought?: string }) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const mode = detectProfileMode(query, caller)
    const child = spawn('python3', [
      '-c',
      `import sys
sys.path.insert(0, '/home/ubuntu/projects/digital-clone')
from twin.tools import handle_twin_chat_stream
def main():
    for line in handle_twin_chat_stream(query=sys.argv[1], caller=sys.argv[2], context=sys.argv[3] if sys.argv[3] else None, mode=sys.argv[4]):
        print(line, end='', flush=True)
main()`,
      query, caller, context || '', mode,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let finalAnswer = ''
    let stderr = ''
    let buffer = ''
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        try {
          const evt = JSON.parse(line)
          if (evt.type === 'done') {
            finalAnswer = evt.answer || ''
          }
          onEvent(evt)
        } catch { /* skip corrupt line */ }
      }
    })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('exit', code => {
      if (code === 0) {
        resolve(finalAnswer)
      } else {
        console.error(`[callTwinChatStream] exit ${code}: ${stderr.slice(0, 300)}`)
        reject(new Error(`callTwinChatStream exit ${code}: ${stderr.slice(0, 200)}`))
      }
    })
    child.on('error', reject)
  })
}

/**
 * 检查 conversations.jsonl 是否积攒了足够新轮数（相比上次反思），
 * 如果满 10 轮则异步触发反思进程（fire-and-forget）。
 */
async function triggerReflectionIfNeeded(workDir: string): Promise<void> {
  const convFile = join(workDir, '.claudetalk', 'twin', 'conversations.jsonl')
  if (!existsSync(convFile)) return

  const lines = readFileSync(convFile, 'utf-8').trim().split('\n').filter(Boolean)
  if (lines.length === 0) return

  // 上一次反思时记录的总轮数 → 写在与 conversations.jsonl 同目录的 checkpoint 文件
  const checkpointFile = join(workDir, '.claudetalk', 'twin', '.reflection_checkpoint')
  let lastCount = 0
  if (existsSync(checkpointFile)) {
    try {
      lastCount = parseInt(readFileSync(checkpointFile, 'utf-8').trim(), 10) || 0
    } catch { /* ignore */ }
  }

  const newRounds = lines.length - lastCount
  if (newRounds < 10) return

  // 触发反思（异步子进程），成功后写入 checkpoint，失败时回滚
  const MAX_RETRIES = 2
  let attempt = 0
  while (attempt <= MAX_RETRIES) {
    attempt++
    console.log(`[reflection] ${newRounds} new rounds detected, triggering... (attempt ${attempt})`)

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('python3', [
        '-c',
        `import sys, json
sys.path.insert(0, '/home/ubuntu/projects/digital-clone')
from twin.reflection import run_reflection
result = run_reflection(force=True)
print(json.dumps(result, ensure_ascii=False))
`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })

      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { console.error(`[reflection] stderr: ${d.toString().slice(0, 200)}`) })
      child.on('exit', (code) => {
        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout.trim())
            if (parsed.error) {
              console.error(`[reflection] error: ${parsed.error}`)
              resolve(false)
            } else {
              console.log(`[reflection] done: ${JSON.stringify(parsed.stored || 'ok')}`)
              resolve(true)
            }
          } catch {
            console.log(`[reflection] done: ${stdout.slice(0, 200)}`)
            resolve(true)
          }
        } else {
          console.error(`[reflection] exit ${code}`)
          resolve(false)
        }
      })
      child.on('error', (err) => {
        console.error(`[reflection] spawn error: ${err.message}`)
        resolve(false)
      })
    })

    if (ok) {
      // 子进程成功后写入 checkpoint
      writeFileSync(checkpointFile, String(lines.length), 'utf-8')
      return
    }
    // 失败：不写 checkpoint，重试
    if (attempt > MAX_RETRIES) {
      console.error(`[reflection] failed after ${MAX_RETRIES} attempts, checkpoint NOT advanced`)
    }
  }
}

// HELP_TEXT imported from utils/help-text.ts

/**
 * 根据配置创建对应的 Channel 实例
 * 通过注册表查找对应的 ChannelDescriptor，调用其 create 工厂方法
 */
function createChannel(channelType: string, config: ClaudeTalkConfig, workDir: string, profileName?: string): Channel {
  const descriptor = getChannelDescriptor(channelType)
  if (!descriptor) {
    throw new Error(`不支持的 channel 类型: ${channelType}，请检查配置文件中的 channel 字段`)
  }

  // 取出该 Channel 的嵌套配置（如 config.dingtalk、config.discord）
  const channelConfig = (config[channelType] ?? {}) as Record<string, string>

  // 校验必填字段
  for (const field of descriptor.configFields) {
    if (field.required && !channelConfig[field.key]) {
      throw new Error(
        `${channelType} 配置缺失字段 "${field.key}"，请在 profile.${channelType}.${field.key} 中填写`
      )
    }
  }

  // 将 profile 级别的通用字段注入到 channelConfig，供 Channel 实现使用
  const enrichedChannelConfig: Record<string, string> = {
    ...channelConfig,
    ...(profileName ? { profileName } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    workDir, // 注入工作目录，用于存储项目级别的配置文件（如 chat-members.json）
    // 独立 bot profile 使用直连 WS 模式（不依赖 feishu-bridge）
    ...(profileName === 'trip' || profileName === 'twin' ? { directWS: 'true' } : {}),
  }

  return descriptor.create(enrichedChannelConfig)
}

/**
 * 启动 Bot
 */
export async function startBot(options: StartBotOptions): Promise<void> {
  const { workDir, profile } = options

  // ── Earliest possible marker: write PID + argv before any init ──
  try {
    const markerDir = join(workDir, '.claudetalk')
    const markerFile = join(markerDir, 'startup-marker.json')
    if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true })
    writeFileSync(markerFile, JSON.stringify({
      phase: 'entry',
      ts: new Date().toISOString(),
      pid: process.pid,
      argv: process.argv.slice(1).join(' '),
      workDir,
    }, null, 2) + '\n', 'utf-8')
    // Also write to daemon's combined log
    appendFileSync(
      join(markerDir, 'claudetalk.log'),
      `[${new Date().toISOString()}] [BOOT] argv="${process.argv.slice(1).join(' ')}" workDir=${workDir}\n`,
      'utf-8',
    )
  } catch { /* best-effort */ }

  // 初始化日志文件
  initLogFile(workDir)

  // PID file path — used by singleton check and cleanup
  const claudetalkDir = join(workDir, '.claudetalk')
  const pidFile = join(claudetalkDir, profile ? `claudetalk-${profile}.pid` : 'claudetalk.pid')

  // ── Crash marker & exit interceptor ──
  const crashMarkerDir = join(workDir, '.claudetalk')
  const daemonCrashMarker = join(crashMarkerDir, 'crash.marker')
  const exitMarkerFile = join(crashMarkerDir, 'exit-marker.json')
  const startupMarker = join(crashMarkerDir, 'startup-marker.json')

  /** Write simple timestamp to crash.marker for daemon check_claudetalk */
  function _writeDaemonCrashMarker() {
    try { writeFileSync(daemonCrashMarker, String(Date.now() / 1000), 'utf-8') } catch {}
  }

  /** Track startup progress at key phases */
  const _startupPhases: string[] = []
  function _markPhase(name: string) {
    _startupPhases.push(name)
    try {
      writeFileSync(startupMarker, JSON.stringify({
        phases: _startupPhases,
        ts: new Date().toISOString(),
        pid: process.pid,
      }, null, 2) + '\n', 'utf-8')
    } catch {}
  }
  _markPhase('initLogFile')

  /** Write exit-marker.json with full context on any exit/crash.
   *  crash.marker is only written for actual crashes (uncaughtException/unhandledRejection),
   *  NOT for clean exits (SIGTERM/SIGINT/drain/process.exit(0)).
   *  This prevents the daemon from treating graceful shutdowns as crashes. */
  function _writeExitMarker(type: string, extra?: Record<string, unknown>) {
    const isCrash = type === 'uncaughtException' || type === 'unhandledRejection'
    const marker = {
      type,
      ts: new Date().toISOString(),
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      startup_phases: [..._startupPhases],
      ...extra,
    }
    try {
      writeFileSync(exitMarkerFile, JSON.stringify(marker, null, 2) + '\n', 'utf-8')
      if (isCrash) _writeDaemonCrashMarker()
      appendFileSync(
        join(crashMarkerDir, `claudetalk-${new Date().toISOString().slice(0, 10)}.log`),
        `[EXIT] ${JSON.stringify(marker)}\n`,
        'utf-8',
      )
    } catch {
      try { writeFileSync(join(crashMarkerDir, 'exit-marker.txt'), `${type} ${marker.ts} pid=${marker.pid}\n`, 'utf-8') } catch {}
    }
  }

  /** Intercept process.exit to capture caller stack before actual exit */
  const _origExit = process.exit.bind(process)
  process.exit = ((code?: number) => {
    _writeExitMarker('process.exit', {
      code: code ?? 0,
      stack: new Error().stack?.split('\n').slice(2).join('\n') || '',
    })
    _origExit(code)
  }) as typeof process.exit

  // MCP SSE server runs as standalone process managed by ops-daemon
  // claudetalk does NOT own the MCP port — zombie_reaper handles conflicts

  _markPhase('loadConfig')
  const config = loadConfig(workDir, profile)
  if (!config) {
    throw new Error(`找不到配置，请先运行 claudetalk --setup${profile ? ` --profile ${profile}` : ''}`)
  }

  _markPhase('createChannel')
  const channelType = config.channel ?? 'dingtalk'
  const channel = createChannel(channelType, config, workDir, profile)
  const logger = createLogger(channelType, profile)

  logger(`[startBot] Starting channel=${channelType}, workDir=${workDir}`)

  // ── IdentityResolver：纯本地用户表驱动，不再调飞书 API ──
  const identityResolver = new IdentityResolver(workDir)

  // ── Singleton check: refuse if another instance is running ──
  try {
    if (existsSync(pidFile)) {
      const oldPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      if (!isNaN(oldPid)) {
        if (oldPid === process.pid) {
          // PID file contains our own PID — daemon's process_manager.py wrote it before
          // our startup code ran. This is not a separate instance, proceed normally.
        } else {
          try {
            process.kill(oldPid, 0)
            logger(`[startBot] ERROR: Another instance (PID ${oldPid}) is already running for profile="${profile ?? 'default'}"`)
            console.error(`[startBot] ERROR: Another instance (PID ${oldPid}) is already running for profile="${profile ?? 'default'}"`)
            console.error(`[startBot] Run --restart to restart, or kill PID ${oldPid} first.`)
            process.exit(1)
          } catch {
            unlinkSync(pidFile)
            logger(`[startBot] Removed stale PID file (PID ${oldPid} no longer exists)`)
          }
        }
      }
    }
  } catch (error) {
    logger(`[startBot] PID file check failed (non-fatal): ${error}`)
  }

  // ── Startup heartbeat: periodic marker so daemon can tell process is alive ──
  const _hbInterval = setInterval(() => {
    _markPhase('heartbeat')
  }, 10000)
  setTimeout(() => clearInterval(_hbInterval), 120000)

  // 确保 PID 目录存在并写入当前 PID
  if (!existsSync(claudetalkDir)) {
    mkdirSync(claudetalkDir, { recursive: true })
  }
  writeFileSync(pidFile, process.pid.toString(), 'utf-8')
  logger(`[startBot] PID file created: ${pidFile}`)

  // 清理 PID 文件的函数
  const cleanupPidFile = () => {
    try {
      if (existsSync(pidFile)) {
        unlinkSync(pidFile)
        logger(`[startBot] PID file removed: ${pidFile}`)
      }
    } catch (error) {
      logger(`[startBot] Failed to remove PID file: ${error}`)
    }
  }

  // ── Graceful drain: wait for in-flight LLM calls, then exit ──
  let _draining = false
  let _notifyTarget = '' // last active user open_id for crash notification
  function _trySendCrashNotification(reason: string) {
    if (!_notifyTarget) return
    const lines = [`[Crash] claudetalk 异常退出`, `原因: ${reason}`, `时间: ${new Date().toLocaleString()}`, `运行: ${Math.round(process.uptime())}s`]
    channel.sendMessage(_notifyTarget, lines.join('\n'), false).catch(() => {})
  }
  async function drainThenExit(signal: string) {
    if (_draining) return
    _draining = true
    setDraining(true)
    logger(`[startBot] Received ${signal}, entering drain mode...`)
    _trySendCrashNotification(`signal=${signal}`)

    // channel.stop() with 30s timeout — don't let it block drain
    await Promise.race([
      new Promise<void>((resolve) => {
        try { channel.stop() } catch { /* ignore */ }
        resolve()
      }),
      new Promise<void>((resolve) => setTimeout(() => {
        logger('[startBot] channel.stop() timed out, forcing drain')
        resolve()
      }, 30000)),
    ])
    stopMcpServer()

    // Drain: collect all in-flight retries until none remain or 60s total
    const drainDeadline = Date.now() + 60000
    while (Date.now() < drainDeadline) {
      const pending = Array.from(activeSubprocesses)
      if (pending.length === 0) break

      logger(`[startBot] Waiting for ${pending.length} in-flight LLM call(s)...`)
      const batchTimer = setTimeout(() => {
        logger('[startBot] Drain batch timeout, force killing batch')
        for (const proc of activeSubprocesses) {
          try { proc.kill('SIGKILL') } catch { }
        }
      }, Math.max(1, drainDeadline - Date.now()))

      await Promise.all(
        pending.map(p => new Promise<void>((resolve) => {
          p.on('close', () => resolve())
          p.on('error', () => resolve())
        }))
      )
      clearTimeout(batchTimer)
      // Loop back: new processes may have been spawned by retry logic in close handlers
    }

    // 超时回退：强制杀所有还存活的子进程（_execClaude 的 3s SIGKILL setTimeout 可能因主进程退出而未触发）
    for (const proc of activeSubprocesses) {
      try {
        const pid = proc.pid
        if (pid != null) {
          try { process.kill(pid, 0); proc.kill('SIGKILL') } catch { /* 进程已死或不可杀 */ }
        } else {
          proc.kill('SIGKILL')
        }
      } catch { /* ignore */ }
    }
    activeSubprocesses.clear()
    cleanupPidFile()
    closeLogFile()
    otelSdk.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    _markPhase('sigint')
    drainThenExit('SIGINT').catch(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    _markPhase('sigterm')
    try {
      const ppid = process.ppid
      const pcomm = readFileSync(`/proc/${ppid}/comm`, 'utf-8').trim()
      logger(`[startBot] SIGTERM received, parentPID=${ppid} parentComm=${pcomm}`)
    } catch { /* non-critical */ }
    drainThenExit('SIGTERM').catch(() => process.exit(0))
  })

  // 捕获自然退出（event loop empty），同步写 exit-marker.json
  process.on('beforeExit', () => {
    _writeExitMarker('beforeExit', {
      detail: `startup_phases=[${_startupPhases.join(',')}] uptime=${Math.round(process.uptime())}s`,
    })
    logger(`[beforeExit] event loop empty, startup=${_startupPhases[_startupPhases.length-1]}`)
  })

  process.on('exit', () => {
    // exit-marker is already written by the process.exit interceptor (if process.exit was called).
    // This handler covers cases where the process terminates without going through the interceptor
    // (e.g. process.kill, runtime fatal), so we only do PID/log cleanup here.
    cleanupPidFile()
    closeLogFile()
  })

  // 捕获 unhandled rejection 并记录日志（--unhandled-rejections=warn 不杀进程）
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : String(reason)
    logger(`[unhandledRejection] ${stack}`)
    _writeExitMarker('unhandledRejection', { detail, stack })
  })

  // 捕获未处理的同步异常
  process.on('uncaughtException', (error) => {
    logger(`[uncaughtException] ${error.stack}`)
    _writeExitMarker('uncaughtException', {
      detail: error.message,
      stack: error.stack,
    })
  })

  // Track last user message + bot reply per conversation for quick "加入手机待办" command
  const _lastConvPair = new Map<string, { message: string; reply: string }>()

  // 注册统一消息处理器
  channel.onMessage(async (context: ChannelMessageContext, message: string) => {
    await _tracer.startActiveSpan("process-message", async (span) => {
      span.setAttribute("conversation_id", context.conversationId);
      span.setAttribute("channel_type", channelType);
      span.setAttribute("is_group", String(context.isGroup));
      try {
        await handleMessage(context, message);
      } finally {
        span.end();
      }
    });
  });

  async function handleMessage(context: ChannelMessageContext, message: string) {
    // 去掉飞书群聊中的 @机器人 前缀（如 "@_user_1 /new" → "/new"）
    const strippedMessage = message.replace(/^@\S+\s*/, '').trim()
    const command = strippedMessage.toLowerCase()

    // ═══ 第0优先：系统内置指令（优先级最高，不受 trip 状态影响） ═══
    // 内置指令：清空会话
    if (RESET_COMMANDS.has(command)) {
      const hadSession = clearSession(context.conversationId, workDir, profile, channelType, context.userId, context.isGroup)
      const replyText = hadSession
        ? '🔄 已清空当前会话记忆，下次发消息将开启全新对话。'
        : '💡 当前没有活跃的会话记忆，发消息即可开始新对话。'
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }

    // 内置指令：帮助
    if (HELP_COMMANDS.has(command)) {
      const helpText = HELP_TEXT(profile)
      const debugPrefix = `[profile=${profile}]\n\n`
      if (typeof (channel as any).sendMarkdownCard === 'function') {
        await (channel as any).sendMarkdownCard(context.conversationId, debugPrefix + helpText, context.isGroup)
      } else {
        await channel.sendMessage(context.conversationId, debugPrefix + helpText, context.isGroup)
      }
      return
    }

    // ── /twin 指令（仅 twin profile） ──
    if (profile === 'twin' && (command === '/twin' || command.startsWith('/twin '))) {
      const twinContent = strippedMessage.slice(5).trim()
      if (!twinContent || twinContent === 'help') {
        const helpText = HELP_TEXT('twin')
        if (typeof (channel as any).sendMarkdownCard === 'function') {
          await (channel as any).sendMarkdownCard(context.conversationId, helpText, context.isGroup)
        } else {
          await channel.sendMessage(context.conversationId, helpText, context.isGroup)
        }
        return
      }
      // /twin <content>：通过 processedMessage 注入明确指令，让 LLM 用 twin_feed 工具摄入内容
      const callerInfo = process.env.__TWIN_CALLER ? JSON.parse(process.env.__TWIN_CALLER) : {}
      context.processedMessage =
        `[用户提交了以下内容用于摄入数字分身记忆库。请调twin_feed MCP工具将内容摄入记忆库，并给出简短确认回复。]\n${twinContent}`
    }

    // ── /session 会话管理 ──
    if (isSessionCommand(command)) {
      const handled = await handleSessionCommand(strippedMessage, context, channel, workDir, profile)
      if (handled) return
    }

    // ── /task 后台任务 ──
    if (isTaskCommand(command)) {
      const handled = await handleTaskCommand(strippedMessage, context, channel, workDir, profile)
      if (handled) return
    }


    // ── /status 服务状态 ──
    if (STATUS_COMMANDS.has(command)) {
      function fmtUptime(s: number): string {
        if (s < 60) return Math.round(s) + 's'
        if (s < 3600) return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's'
        if (s < 86400) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'
        return Math.floor(s / 86400) + 'd' + Math.floor((s % 86400) / 3600) + 'h'
      }

      const OPS_PORT = 8765
      const DAEMON_STATE = join(OPS_DAEMON_DIR, 'data', 'working', 'latest.json')
      const [dashOk, tunOk] = await Promise.all([
        httpHealthCheck(OPS_PORT),
        tunnelHealthCheck(),
      ])

      function pidByPort(port: number): { pid: string; uptimeS: number } | null {
        try {
          const out = execSync(`ss -tlnp 'sport = :${port}'`, { encoding: 'utf-8', timeout: 3000 })
          const m = out.match(/users:\(\(.*,pid=(\d+),.*\)\)/)
          if (!m) return null
          const pid = m[1]
          const start = execSync(`ps -o lstart= -p ${pid}`, { encoding: 'utf-8', timeout: 3000 }).trim()
          if (start) return { pid, uptimeS: (Date.now() - new Date(start).getTime()) / 1000 }
        } catch {}
        return null
      }

      function _svc(state: any, name: string): any {
        return (state.services ?? []).find((s: any) => s.name === name) ?? {}
      }

      interface SvcEntry { name: string; status: string; detail: string }
      const services: SvcEntry[] = []
      let sysInfo = '', activeProxy = ''

      try {
        const raw = readFileSync(DAEMON_STATE, 'utf-8')
        const state = JSON.parse(raw)
        const daemonAge = (Date.now() - new Date(state.ts).getTime()) / 1000
        sysInfo = `CPU ${state.system.cpu.pct}% | 内存 ${state.system.memory.pct}% | /:${state.system.disk['/']?.pct ?? '?'}%`

        // ClaudeTalk (self process)
        services.push({ name: 'ClaudeTalk', status: '✅', detail: `PID:${process.pid} ${fmtUptime(process.uptime())}` })

        // Proxy — from legacy proxy field (still has port-level detail)
        const proxySvc = _svc(state, 'model-proxy')
        if (proxySvc.status === 'up') {
          activeProxy = `Proxy :${proxySvc.port ?? '?'}`
          services.push({ name: 'Proxy', status: '✅', detail: `:${proxySvc.port}` })
        }

        // FeishuBot
        const ctSvc = _svc(state, 'claudetalk')
        if (ctSvc.status === 'up') {
          services.push({ name: 'FeishuBot', status: '✅', detail: `PID:${ctSvc.pid ?? '?'}` })
        }

        // Tunnel
        const tunnelSvc = _svc(state, 'cloudflared')
        if (tunnelSvc.status === 'up') {
          const conn = tunnelSvc.connections ?? '?'
          services.push({ name: 'Tunnel', status: '✅', detail: `${conn} 连接` })
        }

        // FeishuBridge
        const bridgeSvc = _svc(state, 'feishu-bridge')
        if (bridgeSvc.status === 'up') {
          services.push({ name: 'FeishuBridge', status: '✅', detail: `PID:${bridgeSvc.pid ?? '?'}` })
        }

        // Daemon
        const daemonStale = daemonAge > 120
        services.push({ name: 'Daemon', status: daemonStale ? '⚠️' : '✅', detail: `${fmtUptime(daemonAge)}前更新` })
      } catch {
        services.push({ name: 'Daemon', status: '❌', detail: '状态不可读' })
      }

      // Dashboard health
      services.push({ name: 'Dashboard', status: dashOk ? '✅' : '❌', detail: dashOk ? ':8765' : '不可达' })

      // Build card body
      const bodyParts: string[] = [
        ...services.map(s => `${s.status}  **${s.name}**  ${s.detail}`),
        '',
        `🔄 ${activeProxy || 'Proxy❌'}`,
        `💻 ${sysInfo || 'N/A'}`,
      ]

      if (typeof (channel as any).sendMarkdownCard === 'function') {
        await (channel as any).sendMarkdownCard(context.conversationId, bodyParts.join('\n'), context.isGroup)
      } else {
        await channel.sendMessage(context.conversationId, bodyParts.join('\n'), context.isGroup)
      }
      return
    }

    // ── /tasks 手机待办 ──
    if (TASKS_COMMANDS.has(command)) {
      const tasksFile = join(getPhoneTasksDir(), 'index.json')
      const lines: string[] = ['**📋 手机待办**']
      try {
        const raw = readFileSync(tasksFile, 'utf-8')
        const index = JSON.parse(raw)
        const entries = Object.entries(index as Record<string, { status: string; summary: string; progress?: string }>)

        if (entries.length === 0) {
          lines.push('  暂无待办任务')
          lines.push('')
          lines.push('💡 发送"加入手机待办"将当前对话保存为待办')
          lines.push('💡 直接在对话中说"把这个留到终端处理"也会自动加入')
          lines.push('💡 在主界面点击 ✅ 确认创建待办')
          await channel.sendMessage(context.conversationId, lines.join('\n'), context.isGroup)
          return
        }

        const pending: Array<{ id: string; summary: string }> = []
        const inProgress: Array<{ id: string; summary: string; progress?: string }> = []
        const recent: Array<{ id: string; summary: string; status: string }> = []

        for (const [id, val] of entries) {
          if (val.status === 'pending') pending.push({ id, summary: val.summary })
          else if (val.status === 'in_progress') inProgress.push({ id, summary: val.summary, progress: val.progress })
        }
        // 最近10条（按 entries 顺序倒序）
        for (let i = entries.length - 1; i >= 0 && recent.length < 10; i--) {
          const [id, val] = entries[i]
          recent.push({ id, summary: val.summary, status: val.status })
        }

        if (inProgress.length > 0) {
          lines.push(`\n**进行中 (${inProgress.length})**`)
          for (const t of inProgress) {
            lines.push(`  ▶ ${t.summary.slice(0, 40)}`)
            if (t.progress) lines.push(`    └ ${t.progress.slice(0, 50)}`)
          }
        }
        if (pending.length > 0) {
          lines.push(`\n**待处理 (${pending.length})**`)
          for (const t of pending) {
            lines.push(`  ◌ ${t.summary.slice(0, 40)}`)
          }
        }
        if (pending.length === 0 && inProgress.length === 0) {
          lines.push('  暂无待办任务')
        }
        lines.push(`\n**最近 (${recent.length})**`)
        for (const r of recent) {
          const icon = r.status === 'completed' ? '✅' : r.status === 'in_progress' ? '▶' : r.status === 'pending' ? '◌' : '📁'
          lines.push(`  ${icon} ${r.summary.slice(0, 40)}`)
        }
        lines.push(`\n总计: ${entries.length} 条`)
      } catch {
        lines.push('  无法读取任务列表')
      }
      await channel.sendMessage(context.conversationId, lines.join('\n'), context.isGroup)
      return
    }

    // ── /status 已涵盖服务和路由信息 ──

    // ── /log 日志摘要 ──
    if (LOG_COMMANDS.has(command)) {
      const today = new Date().toISOString().slice(0, 10)
      const logFile = join(workDir, '.claudetalk', `claudetalk-${today}.log`)
      try {
        const content = readFileSync(logFile, 'utf-8')
        const lines = content.split('\n').filter(Boolean)

        // Parse log lines, skip separator lines
        let firstTs = '', lastTs = ''
        let sessions = 0, rotates = 0
        let msgRecv = 0, msgReply = 0, msgEdit = 0, reactions = 0
        let errors: string[] = []
        let mcpEvents = 0, mcpErr = 0, mcpSample = ''
        let claudeCalls = 0, classifierCalls = 0
        let cardSends = 0
        let latestEvents: string[] = []

        for (const line of lines) {
          // Session markers (between separators, not on them)
          if (line.includes('Session Started')) { sessions++; continue }
          if (line.includes('Session Rotated')) { rotates++; continue }

          // Extract timestamp
          const tm = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d{3}\]/)
          if (!tm) continue
          if (!firstTs) firstTs = tm[1]
          lastTs = tm[1]
          const timeTag = tm[1].slice(11, 16) // HH:MM

          // Categorize
          if (line.includes('Received message from')) {
            msgRecv++
            // Track latest received message content (truncated)
            const contentMatch = line.match(/: (.{0,60})/)
            if (contentMatch) {
              latestEvents.push(`[${timeTag}] recv: ${contentMatch[1].replace(/\n/g, ' ')}`)
            }
          } else if (line.includes('===== Bot Reply Message')) {
            msgReply++
          } else if (line.includes('===== Edit Message')) {
            msgEdit++
          } else if (line.includes('Added reaction')) {
            reactions++
          } else if (line.includes('Error') || line.includes('failed') || line.includes('failed after') || line.includes('EADDRINUSE')) {
            // Collect unique error samples (max 3)
            if (errors.length < 4) {
              const errKey = line.replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*/, '').slice(0, 80)
              if (!errors.some(e => e.includes(errKey.slice(0, 30)))) {
                errors.push(`[${timeTag}] ${errKey}`)
              }
            }
            if (line.includes('EADDRINUSE')) mcpErr++
          } else if (line.includes('[mcp-server]')) {
            mcpEvents++
            if (line.includes('listening')) mcpSample = `port ${line.match(/:(\d+)\/sse/)?.[1] || line.match(/localhost:(\d+)/)?.[1] || '?'}`
          } else if (line.includes('[claude]') || line.includes('[claude-stream]')) {
            claudeCalls++
          } else if (line.includes('[classifier]')) {
            classifierCalls++
          } else if (line.includes('sendMarkdownCard')) {
            cardSends++
          }
        }

        // Time range string
        const timeRange = firstTs && lastTs
          ? `${firstTs.slice(11, 16)} ~ ${lastTs.slice(11, 16)}`
          : '-'

        // Build summary
        const parts: string[] = []
        parts.push(`[Log] ${today} (${lines.length} lines)`)
        parts.push(`Period: ${timeRange}`)
        parts.push(`---`)
        parts.push(`Sessions: ${sessions}${rotates > 0 ? ` (+${rotates} rotate)` : ''}`)
        parts.push(`Messages: recv ${msgRecv} | reply ${msgReply} | edit ${msgEdit} | react ${reactions}`)

        if (claudeCalls > 0) parts.push(`Claude: ${claudeCalls} calls`)
        if (classifierCalls > 0) parts.push(`Classifier: ${classifierCalls}`)
        if (mcpEvents > 0) {
          let mcpStr = `MCP: ${mcpEvents} events${mcpSample ? ` (${mcpSample})` : ''}`
          if (mcpErr > 0) mcpStr += ` | EADDRINUSE x${mcpErr}`
          parts.push(mcpStr)
        }
        if (cardSends > 0) parts.push(`Cards: ${cardSends}`)

        if (errors.length > 0) {
          parts.push(`---`, `Errors (${errors.length}):`)
          parts.push(...errors)
        }

        // Latest events (last 4)
        const tail = latestEvents.slice(-4)
        if (tail.length > 0) {
          parts.push(`---`, `Latest:`)
          parts.push(...tail)
        }

        const reply = parts.join('\n').slice(0, 1500)
        await channel.sendMessage(context.conversationId, reply, context.isGroup)
      } catch {
        await channel.sendMessage(context.conversationId, '无法读取日志文件', context.isGroup)
      }
      return
    }


    // ── 快速存档指令（"加入手机待办"，卡片确认）──
    if (QUICK_ARCHIVE_COMMANDS.has(command)) {
      const pair = _lastConvPair.get(context.conversationId)
      if (pair) {
        logger(`[archive] quick archive triggered for conv=${context.conversationId}, msg="${pair.message.slice(0, 60)}"`)
        // 飞书通道发送确认卡片；其他通道直接存档
        if (typeof (channel as any).sendCard === 'function') {
          const { buildArchiveConfirmCard } = await import('./channels/feishu/approval-handler.js')
          const cardBody = buildArchiveConfirmCard(pair.message.slice(0, 200))
          await (channel as any).sendCard(context.conversationId, cardBody, context.isGroup)
        } else {
          await archiveConversation({
            message: pair.message,
            reply: pair.reply,
            toolUseCount: 0,
            toolNames: [],
            workDir,
            isGroup: context.isGroup,
            userId: context.userId,
            channel: channelType,
          })
          await channel.sendMessage(context.conversationId, '✅ 已加入手机待办', context.isGroup)
        }
      } else {
        logger(`[archive] quick archive: no previous conversation pair found`)
        await channel.sendMessage(context.conversationId, '💡 没有找到最近的消息，请先发一条消息让 Claude 回复', context.isGroup)
      }
      return
    }

    // ── 远程终端指令（cloudflared tunnel + ops-dashboard）──
    // 由 feishu-bridge 独立进程全权处理（含飞书消息反馈），claudetalk 跳过。
    // bridge 和 claudetalk 用同一组飞书凭证建立 WS 连接，事件会投递到两个连接。
    // bridge 先拦截并处理远程命令后返回 true 阻止转发，但 claudetalk 仍可能收到同样事件。
    // 这里跳过远程命令避免双重处理。
    const isTerminalOpen = command.includes('开启远程') || command.includes('打开远程')
    const isTerminalClose = command.includes('关闭远程')
    if (isTerminalOpen || isTerminalClose) {
      return
    }

    // ── 权限引擎：L2/L3 需要审批 ──
    const risk = assessRisk(strippedMessage)
    if (requiresApproval(risk.level)) {
      const requestId = nextRequestId()
      const approved = await new Promise<boolean>((resolve) => {
        registerApproval(
          requestId,
          risk.level,
          strippedMessage,
          context.userId || context.senderId,
          context.conversationId,
          resolve,
        )
        const cardBody = buildApprovalCard({
          riskLevel: risk.level,
          riskLabel: riskLabel(risk.level),
          messageSummary: strippedMessage,
          requestId,
          requesterId: context.userId || context.senderId,
          reason: risk.reason,
        })
        // 尝试发卡片，失败则拒绝操作
        if (typeof (channel as any).sendCard === 'function') {
          ;(channel as any).sendCard(context.conversationId, cardBody, context.isGroup).catch((err: Error) => {
            logger(`[approval] sendCard failed: ${err.message}`)
            resolve(false)
          })
        } else {
          channel.sendMessage(context.conversationId,
            `⚠️ **操作需要审批**但当前通道不支持交互卡片。\n请使用 /task run 手动提交此任务。`,
            context.isGroup)
          resolve(false)
        }
      })

      if (!approved) {
        logger(`[approval] REJECTED: requestId=${requestId}`)
        await channel.sendMessage(context.conversationId, '⛔ 操作已取消（审批被拒绝或超时）', context.isGroup)
        return
      }
    }

    // 调用 Claude Code CLI 处理消息
    try {
      const useStreaming = !!(channel.editMessage && channel.sendMessageWithId)

      if (useStreaming) {
        // 流式模式：发状态消息 → 按步骤推送一句话总结
        let statusMsgId = await channel.sendMessageWithId!(context.conversationId, '⏳ 处理中...', context.isGroup)
        let lastEditText = '⏳ 处理中...'
        let lastText = ''
        let lastEditTime = 0
        let hasPushedInitialThink = false
        let currentStepNumber = 0
        const collectedToolNames: string[] = []
        let pendingStep: { number: number; toolName: string; toolInput: string } | null = null
        const MIN_EDIT_INTERVAL_MS = 800

        const editStatus = async (text: string) => {
          const now = Date.now()
          if (text === lastEditText) return
          if (now - lastEditTime < MIN_EDIT_INTERVAL_MS) return
          lastEditText = text
          lastEditTime = now
          try {
            await channel.editMessage!(context.conversationId, statusMsgId, text)
          } catch (e) {
            if (e instanceof Error && e.message === 'EDIT_LIMIT_REACHED') {
              try {
                statusMsgId = await channel.sendMessageWithId!(context.conversationId, text, context.isGroup)
                lastEditText = text
              } catch { /* ignore */ }
            }
          }
        }

        // Twin profile: direct call to twin_chat MCP tool (bypasses Claude API)
        if (profile === 'twin') {
          let identity: IdentityResult
          try {
            identity = await identityResolver.resolve(context.userId, config!.feishu?.FEISHU_APP_ID || '')
          } catch (resolveErr) {
            logger(`[onMessage] identityResolver.resolve failed for twin: ${resolveErr}`)
            identity = { level: 'stranger', name: '陌生人', description: '回退到陌生人级别' }
          }
          const callerLevel = identity.level
          const callerName = identity.name
          const callerDesc = identity.description
          const isOwner = callerLevel === 'owner'
          const callerInfo = JSON.stringify({ userId: context.userId, name: callerName, level: callerLevel, description: callerDesc })
          process.env.__TWIN_CALLER = callerInfo
          const caller = isOwner ? 'owner' : 'external'
          // 思考过程开关：true=总是展示，false=总不展示，null/未配置=按身份默认（主人展示、外部不展示）
          const _cfgShow = (config as any)?.twin?.showThinking
          const showThinking = (_cfgShow === undefined || _cfgShow === null) ? isOwner : !!_cfgShow

          let finalResult = ''
          let finalThought = ''
          // Build conversation context from recent history (last 3 rounds)
          let chatContext: string | undefined
          try {
            const convFile = join(workDir, '.claudetalk', 'twin', 'conversations.jsonl')
            if (existsSync(convFile)) {
              const lines = readFileSync(convFile, 'utf-8').trim().split('\n').filter(Boolean)
              const tail = lines.slice(-6)
              const parts: string[] = []
              for (const line of tail) {
                try {
                  const e = JSON.parse(line)
                  if (e.conversationId === context.conversationId) {
                    parts.push(`用户: ${e.message}`)
                    parts.push(`你: ${e.reply}`)
                  }
                } catch { /* skip */ }
              }
              if (parts.length > 0) {
                chatContext = parts.slice(-6).join('\n')
              }
            }
          } catch { /* ignore context read error */ }
          const pendingMsg = context.processedMessage ?? message
          const useEntity = !!process.env.TWIN_ENTITY_ENABLED
          let entityReached = false
          try {
            // 优先：实体常驻服务（带持续状态）。实体不可达/出错才回落。
            if (useEntity) {
              const entityRes = await chatWithEntity({
                conversationId: context.conversationId,
                message: pendingMsg,
                caller,
                isGroup: context.isGroup,
                context: chatContext,
              })
              entityReached = true
              finalResult = entityRes.answer
              finalThought = entityRes.thought
            }
          } catch (entityErr) {
            logger(`[onMessage] twin-entity chat failed, fallback to direct spawn: ${entityErr}`)
          }
          if (!entityReached) {
            try {
              // 流式：思考过程先露出，随后正式回答逐字推送
              let thoughtBuf = ''
              finalResult = await callTwinChatStream(pendingMsg, caller, chatContext, evt => {
                if (evt.type === 'thought_delta') {
                  thoughtBuf += evt.text || ''
                  if (showThinking) {
                    editStatus('🧠 思考中… ' + (evt.text || '').replace(/\s+/g, ' ').slice(-90)).catch(() => {})
                  }
                } else if (evt.type === 'answer_delta') {
                  // 只滚动展示增量预览，避免与最终正式回复重复定格
                  editStatus('✍️ ' + (evt.text || '').replace(/\s+/g, ' ').slice(-90)).catch(() => {})
                } else if (evt.type === 'done') {
                  thoughtBuf = evt.thought || thoughtBuf
                }
              })
              finalThought = thoughtBuf
            } catch (chatErr) {
              logger(`[onMessage] callTwinChatStream failed: ${chatErr}`)
              // 降级：非流式 callTwinChat（干净 JSON → answer），绝不 fallback 到失控的 Claude API
              try {
                finalResult = await callTwinChat(pendingMsg, caller, chatContext)
              } catch (err2) {
                logger(`[onMessage] callTwinChat failed: ${err2}`)
                finalResult = `分身暂时无法回复，请稍后再试。错误: ${err2 instanceof Error ? err2.message : String(err2)}`
              }
            }
          }
          delete process.env.__TWIN_CALLER
          // LLM 流式可能返回空回答（代理/LLM 偶发），空内容发飞书会被拒绝，这里兜底
          if (!finalResult || !finalResult.trim()) {
            logger('[onMessage] twin returned empty reply, fallback to placeholder')
            finalResult = '分身暂时没有生成有效回复，请再问一次。'
          }
          // 思考过程开关：仅对分身主人展示，对外（external）只发正式回答
          if (showThinking && finalThought && !finalResult.includes(finalThought.slice(0, 20))) {
            const thoughtLines = finalThought.split('\n').filter((l: string) => l.trim()).map((l: string) => `▸ ${l}`).join('\n')
            finalResult = `${finalResult}\n\n———————— 以下是分身的思考过程（内部推理，感兴趣再看）————————\n${thoughtLines}`
          }
          logger(`[onMessage] Claude reply (first 200 chars): "${finalResult.substring(0, 200)}"`)
          // 只将用户消息摄入记忆（分身自己的回答不作为主人画像依据）
          if (isOwner && !context.isGroup) {
            twinFeedResponse(workDir, message, `twin_user_${context.conversationId}`).catch(e =>
              logger(`[onMessage] twinFeedResponse(user_msg) error: ${e}`))
          }
          _lastConvPair.set(context.conversationId, { message, reply: finalResult })
          const nrResult = await archiveConversation({
            message, reply: finalResult,
            toolUseCount: 0, toolNames: [], workDir, isGroup: context.isGroup,
            userId: context.userId, channel: channelType, profile,
          })
          // 记录 twin 交互日志
          logInteraction({
            workDir, userId: context.userId,
            name: callerName, level: callerLevel,
            channel: channelType, profile,
          })
          // 记录对话内容到 conversations.jsonl（用于问题追溯）
          logConversation({
            workDir, userId: context.userId,
            name: callerName, level: callerLevel,
            conversationId: context.conversationId,
            message, reply: finalResult,
            caller,
          })
          // 每积攒足够轮数触发反思（异步，不阻塞回复）
          triggerReflectionIfNeeded(workDir).catch(e =>
            console.error(`[reflection] trigger error: ${e}`)
          )
          if (nrResult.category === 'task-pending' && typeof (channel as any).sendCard === 'function') {
            const cardBody = buildTaskConfirmCard({
              summary: nrResult.summary || message.slice(0, 50),
              taskId: nrResult.taskId!,
              type: inferTaskType(message),
              priority: inferTaskPriority(message),
              progressNotes: finalResult.slice(0, 200),
            })
            await (channel as any).sendCard(context.conversationId, cardBody, context.isGroup)
          } else if (nrResult.category === 'task-pending' || nrResult.category === 'completed') {
            writeTaskToIndex({
              taskId: nrResult.taskId!,
              status: nrResult.category === 'task-pending' ? 'pending' : 'completed',
              summary: nrResult.summary!,
            })
          }
          await channel.sendMessage(context.conversationId, finalResult, context.isGroup)
          return
        }

        const { result: finalResult } = await callClaudeStreaming(
          {
            message,
            conversationId: context.conversationId,
            workDir,
            isGroup: context.isGroup,
            userId: context.userId,
            profile,
            channel: channelType,
            processedMessage: context.processedMessage,
          },
          async (event: StreamEvent) => {
            switch (event.type) {
              case 'thinking':
                if (!hasPushedInitialThink) {
                  await editStatus('🧠 思考中...')
                  hasPushedInitialThink = true
                }
                break
              case 'tool_use':
                currentStepNumber++
                if (event.toolName) collectedToolNames.push(event.toolName)
                pendingStep = {
                  number: currentStepNumber,
                  toolName: event.toolName || '工具',
                  toolInput: event.toolInput || '',
                }
                break
              case 'tool_result':
                if (pendingStep) {
                  const summary = summarizeStep(
                    pendingStep.number,
                    pendingStep.toolName,
                    pendingStep.toolInput,
                  )
                  await editStatus(summary)
                  pendingStep = null
                }
                break
              case 'text':
                lastText = event.text || ''
                await editStatus(lastText)
                break
              case 'result':
                if (event.finalResult) {
                  lastText = event.finalResult
                }
                await editStatus(lastText || '任务完成')
                break
            }
          }
        )

        logger(`[onMessage] Claude stream reply (first 200 chars): "${finalResult.substring(0, 200)}"`)
        _lastConvPair.set(context.conversationId, { message, reply: finalResult })
        const archiveResult = await archiveConversation({ message, reply: finalResult, toolUseCount: currentStepNumber, toolNames: collectedToolNames, workDir, isGroup: context.isGroup, userId: context.userId, channel: channelType })
        // task-pending + 飞书→发确认卡片；否则直接写 index.json
        if (archiveResult.category === 'task-pending' && typeof (channel as any).sendCard === 'function') {
          const cardBody = buildTaskConfirmCard({
            summary: archiveResult.summary || message.slice(0, 50),
            taskId: archiveResult.taskId!,
            type: inferTaskType(message),
            priority: inferTaskPriority(message),
            progressNotes: finalResult.slice(0, 200),
          })
          await (channel as any).sendCard(context.conversationId, cardBody, context.isGroup)
        } else if (archiveResult.category === 'task-pending' || archiveResult.category === 'completed') {
          writeTaskToIndex({
            taskId: archiveResult.taskId!,
            status: archiveResult.category === 'task-pending' ? 'pending' : 'completed',
            summary: archiveResult.summary!,
          })
        }
        // 最终回复优先用 result event 的 finalResult，流式 lastText 可能含 subagent 转发前缀
        const textToShow = finalResult || lastText
        if (lastEditText !== textToShow && textToShow) {
          try {
            await channel.editMessage!(context.conversationId, statusMsgId, textToShow)
          } catch { /* ignore */ }
        }
      } else {
        // 非流式降级
        const replyText = await callClaude({
          message,
          conversationId: context.conversationId,
          workDir,
          isGroup: context.isGroup,
          userId: context.userId,
          profile,
          channel: channelType,
          processedMessage: context.processedMessage,
        })
        logger(`[onMessage] Claude reply (first 200 chars): "${replyText.substring(0, 200)}"`)
        _lastConvPair.set(context.conversationId, { message, reply: replyText })
        const nrResult = await archiveConversation({ message, reply: replyText, toolUseCount: 0, toolNames: [], workDir, isGroup: context.isGroup, userId: context.userId, channel: channelType })
        if (nrResult.category === 'task-pending' && typeof (channel as any).sendCard === 'function') {
          const cardBody = buildTaskConfirmCard({
            summary: nrResult.summary || message.slice(0, 50),
            taskId: nrResult.taskId!,
            type: inferTaskType(message),
            priority: inferTaskPriority(message),
            progressNotes: replyText.slice(0, 200),
          })
          await (channel as any).sendCard(context.conversationId, cardBody, context.isGroup)
        } else if (nrResult.category === 'task-pending' || nrResult.category === 'completed') {
          writeTaskToIndex({
            taskId: nrResult.taskId!,
            status: nrResult.category === 'task-pending' ? 'pending' : 'completed',
            summary: nrResult.summary!,
          })
        }
        await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      }
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error)
      logger(`[ERROR] ${stack}`)
      const errorText = `处理消息时出错: ${error instanceof Error ? error.message : String(error)}`
      if (error instanceof Error && error.stack) {
        logger(`[ERROR STACK] ${error.stack}`)
      }
      await channel.sendMessage(context.conversationId, errorText, context.isGroup).catch(() => {})
    }
  }

  // 注册"最近对话"回调，供飞书卡片确认存档使用
  channel.setLastConvGetter?.((convId) => _lastConvPair.get(convId) || null)

  // Clear old crash.marker from previous runs — daemon checks this to detect crashes
  try { if (existsSync(daemonCrashMarker)) unlinkSync(daemonCrashMarker) } catch { /* best-effort */ }

  _markPhase('beforeChannelStart')
  try {
    await channel.start()
    logger(`[startBot] ${channelType} Bot 已启动`)
  _markPhase('channelStarted')
  } catch (error) {
    logger(`[startBot] ${channelType} Bot 启动失败: ${error}`)
    _markPhase(`channelStartFailed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 连接成功后发上线通知
  if (channel.sendOnlineNotification) {
    const lastSession = findLastActivePrivateSession(workDir, channelType, profile)
    if (lastSession?.userId) {
      logger(`[notify] Found last private session userId=${lastSession.userId} convId=${lastSession.conversationId}`)
      _notifyTarget = lastSession.conversationId
      await channel.sendOnlineNotification(lastSession.conversationId, workDir, profile).catch((error) => {
        logger(`[notify] 上线通知发送失败: ${error}`)
      })
    } else {
      logger(`[notify] No private session found (workDir=${workDir} channel=${channelType} profile=${profile}) — sessions file may contain group-only entries`)
      // Fallback: if we have a known chat_id from peer-message file, notify the group
      try {
        const peerFile = join(workDir, '.claudetalk', 'feishu', `bot_${profile || 'claudetalk'}.json`)
        if (existsSync(peerFile)) {
          const peerData = JSON.parse(readFileSync(peerFile, 'utf-8')) as Array<{ chatId: string }>
          if (peerData.length > 0) {
            const chatId = peerData[0].chatId
            logger(`[notify] Fallback to group notification: chatId=${chatId}`)
            await (channel.sendOnlineNotification as (userId: string, workDir: string, profile?: string) => Promise<void>)(chatId, workDir, profile).catch((error) => {
              logger(`[notify] 群聊上线通知发送失败: ${error}`)
            })
          }
        }
      } catch (e) {
        logger(`[notify] 群聊通知回退失败: ${e}`)
      }
    }
  }

}
