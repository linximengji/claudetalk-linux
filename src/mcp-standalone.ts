/**
 * Standalone MCP Server entry point.
 * Runs independently from claudetalk bot process, managed by ops-daemon.
 * Port conflicts are handled by zombie_reaper.ps1, not by this process.
 */
import { startMcpServer, stopMcpServer } from './mcp-server.js'
import { initLogFile } from './core/logger.js'
import { join } from 'path'

function parseArg(key: string): string | null {
  const idx = process.argv.findIndex(a => a === key)
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  const prefix = `${key}=`
  const match = process.argv.find(a => a.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

async function main() {
  const workDir = parseArg('--work-dir') || '/home/ubuntu/projects'

  initLogFile(workDir)

  const server = await startMcpServer(workDir)
  if (!server) {
    console.error('MCP server failed to start (no feishu config found)')
    process.exit(1)
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error(`[mcp-standalone] Received ${signal}, shutting down...`)
    stopMcpServer()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Keep alive
  console.error(`[mcp-standalone] MCP server running on port ${parseInt(process.env.MCP_PORT || '9877', 10)}`)
}

main().catch(err => {
  console.error(`[mcp-standalone] Fatal: ${err}`)
  process.exit(1)
})
