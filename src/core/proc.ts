/**
 * Linux process/port utilities.
 */
import { exec, execSync } from 'child_process'

/**
 * Return the PID listening on a TCP port, or null.
 * Uses ss -tlnp (Linux only).
 */
export function findPidByPort(port: number): number | null {
  try {
    const out = execSync(
      `ss -tlnp 'sport = :${port}'`,
      { encoding: 'utf-8', timeout: 3000 },
    )
    const m = out.match(/users:\(\(.*,pid=(\d+),.*\)\)/)
    if (!m) return null
    const pid = parseInt(m[1], 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

/**
 * Kill any process LISTENING on the given TCP port.
 * Sends SIGTERM first, waits 1.5s, then SIGKILL if still alive.
 */
export function killProcessOnPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const pid = findPidByPort(port)
    if (pid === null) { resolve(); return }

    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }

    setTimeout(() => {
      try { process.kill(pid, 0) } catch { resolve(); return }
      try { process.kill(pid, 'SIGKILL'); resolve() } catch { resolve() }
    }, 1500)
  })
}

/**
 * Check if cloudflared process is running via pgrep.
 */
export function isCloudflaredAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('pgrep cloudflared', { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(false); return }
      resolve(stdout.trim().length > 0)
    })
  })
}

/**
 * Return the cloudflared binary name (expected in PATH).
 */
export function getCloudflaredPath(): string {
  return 'cloudflared'
}
