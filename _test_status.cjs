const { readFileSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

const OPS_DAEMON_DIR = 'D:/ClaudeProjects/ops-daemon';
const DAEMON_STATE = join(OPS_DAEMON_DIR, 'data', 'working', 'latest.json');
const OPS_PORT = 8765;

function pidByPort(port) {
    try {
        const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, { encoding: 'utf-8', timeout: 3000 });
        const parts = out.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (!pid || pid === '0') return null;
        const ps = execSync(`powershell -c "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')"`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (ps) return { pid, uptimeS: (Date.now() - new Date(ps).getTime()) / 1000 };
    } catch {}
    return null;
}

function fmtUptime(s) {
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd' + Math.floor((s % 86400) / 3600) + 'h';
}

const services = [];
let sysInfo = '', activeProxy = '';

try {
    const raw = readFileSync(DAEMON_STATE, 'utf-8');
    const state = JSON.parse(raw);
    const diskC = state.system.disk['C:\\']?.pct ?? '?';
    const diskD = state.system.disk['D:\\']?.pct ?? '?';
    sysInfo = `CPU ${state.system.cpu.pct}% | 内存 ${state.system.memory.pct}% | C:${diskC}% | D:${diskD}%`;

    // Daemon - from protected_pids.json
    try {
        const pidsRaw = readFileSync(join(OPS_DAEMON_DIR, 'data', 'protected_pids.json'), 'utf-8');
        const pids = JSON.parse(pidsRaw);
        const dPid = pids.services?.['ops-daemon']?.pid;
        if (dPid) {
            const ps = execSync(`powershell -c "(Get-Process -Id ${dPid} -ErrorAction SilentlyContinue).StartTime.ToString('o')"`, { encoding: 'utf-8', timeout: 3000 }).trim();
            if (ps) {
                const secs = (Date.now() - new Date(ps).getTime()) / 1000;
                services.push({ name: 'Daemon', status: '✅', detail: `PID:${dPid} ${fmtUptime(secs)}` });
            }
        }
    } catch {}
    if (!services.find(s => s.name === 'Daemon')) services.push({ name: 'Daemon', status: '❌', detail: '' });

    // Proxy
    if (state.proxy?.ports) {
        const active = String(state.proxy.active_port);
        activeProxy = `Proxy(${active === '4000' ? '主' : '备'}) :${active}`;
        for (const [port, info] of Object.entries(state.proxy.ports)) {
            const p = info;
            const label = port === active ? 'Proxy(主)' : 'Proxy(备)';
            const pi = pidByPort(Number(port));
            const detail = pi ? `:${port} PID:${pi.pid} ${fmtUptime(pi.uptimeS)}` : `:${port}?`;
            services.push({ name: label, status: p.status === 'up' ? '✅' : '❌', detail });
        }
    }

    // FeishuRemote MCP
    if (state.mcp_server?.status === 'up') {
        const pi = pidByPort(state.mcp_server.port ?? 9877);
        const detail = pi ? `PID:${pi.pid} :${state.mcp_server.port ?? 9877} ${fmtUptime(pi.uptimeS)}` : `:${state.mcp_server.port ?? 9877}?`;
        services.push({ name: 'FeishuRemote', status: '✅', detail });
    }
} catch {
    services.push({ name: 'Daemon', status: '❌', detail: '状态不可读' });
}

// Dashboard
const dashInfo = pidByPort(OPS_PORT);
services.push({ name: 'Dashboard', status: '✅', detail: dashInfo ? `:${OPS_PORT} PID:${dashInfo.pid} ${fmtUptime(dashInfo.uptimeS)}` : `:${OPS_PORT}?` });

// Tunnel
services.push({ name: 'Tunnel', status: '✅', detail: 'cloudflared' });

const ctStatus = `✅  **ClaudeTalk**  PID:${process.pid} ${fmtUptime(process.uptime())}`;
const bodyParts = [
    ctStatus,
    '',
    ...services.map(s => `${s.status}  **${s.name}**  ${s.detail}`),
    '',
    `🔄 ${activeProxy || 'Proxy❌'}`,
    `💻 ${sysInfo || 'N/A'}`,
];

console.log(bodyParts.join('\n'));
