/**
 * MCP SSE Server — exposes feishu tools via HTTP SSE transport
 * Replaces the standalone Python feishu-mcp, runs inside claudetalk.
 */
import * as http from 'http';
import { killProcessOnPort } from './core/proc.js';
export declare function startMcpServer(workDir: string): Promise<http.Server | null>;
/** Kill any process LISTENING on the given TCP port (cross-platform). */
export { killProcessOnPort };
export declare function stopMcpServer(): void;
//# sourceMappingURL=mcp-server.d.ts.map