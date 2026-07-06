/**
 * Return the PID listening on a TCP port, or null.
 * Uses ss -tlnp (Linux only).
 */
export declare function findPidByPort(port: number): number | null;
/**
 * Kill any process LISTENING on the given TCP port.
 * Sends SIGTERM first, waits 1.5s, then SIGKILL if still alive.
 */
export declare function killProcessOnPort(port: number): Promise<void>;
/**
 * Check if cloudflared process is running via pgrep.
 */
export declare function isCloudflaredAlive(): Promise<boolean>;
/**
 * Return the cloudflared binary name (expected in PATH).
 */
export declare function getCloudflaredPath(): string;
//# sourceMappingURL=proc.d.ts.map