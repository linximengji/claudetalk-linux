/**
 * MCP SSE Server — exposes feishu tools via HTTP SSE transport
 * Replaces the standalone Python feishu-mcp, runs inside claudetalk.
 */
import * as http from 'http';
import * as fs from 'fs';
import { Socket } from 'net';
import { randomUUID } from 'crypto';
import { killProcessOnPort } from './core/proc.js';
import { createLogger } from './core/logger.js';
import { FeishuApiClient, loadFeishuConfig } from './feishu-shared/index.js';
const MCP_PORT = parseInt(process.env.MCP_PORT || '9877', 10);
process.title = 'claudetalk-mcp';
const logger = createLogger('mcp-server');
function loadFeishuConfigLocal(workDir) {
    const cfg = loadFeishuConfig(workDir);
    if (!cfg)
        return null;
    return {
        ...cfg,
        defaultReceiveId: process.env.FEISHU_RECEIVE_ID || cfg.defaultReceiveId,
        defaultReceiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE || cfg.defaultReceiveIdType,
    };
}
// ========== Card Builder ==========
function buildCardPayload(args) {
    try {
        const elements = [];
        if (args.content)
            elements.push({ tag: 'markdown', content: args.content });
        if (args.buttons?.length) {
            const actions = args.buttons.map((b) => {
                const btn = {
                    tag: 'button',
                    text: { tag: 'plain_text', content: b.text },
                    value: b.value,
                };
                if (b.type)
                    btn.type = b.type;
                if (b.confirm_title || b.confirm_text) {
                    btn.confirm = {
                        title: { tag: 'plain_text', content: b.confirm_title || '确认' },
                        text: { tag: 'lark_md', content: b.confirm_text || '确定执行？' },
                    };
                }
                return btn;
            });
            elements.push({ tag: 'action', actions });
        }
        if (args.note) {
            elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: args.note }] });
        }
        return {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: args.title || 'Notification' },
                ...(args.header_color ? { template: args.header_color } : {}),
            },
            elements,
        };
    }
    catch {
        return null;
    }
}
// ========== MCP Tools ==========
const TOOLS = [
    {
        name: 'feishu_send_text',
        description: 'Send a plain text message to a Feishu (Lark) chat or user. Target defaults to FEISHU_RECEIVE_ID env var, or pass receive_id in arguments.',
        inputSchema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'The text content to send' },
                receive_id: { type: 'string', description: 'Optional: target chat_id (oc_) or user open_id (ou_). Overrides env var.' },
                receive_id_type: { type: 'string', description: "Optional: 'chat_id' or 'open_id'" },
            },
            required: ['content'],
        },
    },
    {
        name: 'feishu_send_markdown',
        description: 'Send a markdown-formatted message to Feishu via interactive card. Supports bold, italic, code, links.',
        inputSchema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Markdown content' },
                title: { type: 'string', description: "Optional card title. Defaults to 'Notification'." },
                receive_id: { type: 'string', description: 'Optional: target chat_id or open_id.' },
                receive_id_type: { type: 'string', description: "Optional: 'chat_id' or 'open_id'." },
            },
            required: ['content'],
        },
    },
    {
        name: 'feishu_send_image',
        description: 'Upload a local image file and send it as an image message to a Feishu chat or user.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Local path to the image file (.png/.jpg/.jpeg/.gif/.webp). CC should use the Read tool first to verify the image exists, then pass the path here.' },
                image_key: { type: 'string', description: "Optional: skip upload and send an already-uploaded image_key directly." },
                receive_id: { type: 'string', description: 'Optional: target chat_id (oc_) or user open_id (ou_). Overrides env var.' },
                receive_id_type: { type: 'string', description: "Optional: 'chat_id' or 'open_id'" },
            },
            oneOf: [
                { required: ['file_path'] },
                { required: ['image_key'] },
            ],
        },
    },
    {
        name: 'feishu_send_file',
        description: 'Upload a local file and send it as a file message to a Feishu chat or user. Supports PDF, DOC, XLS, PPT, CSV, TXT, ZIP, MP4, MP3.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Local path to the file. CC should verify the file exists first.' },
                file_key: { type: 'string', description: "Optional: skip upload and send an already-uploaded file_key." },
                receive_id: { type: 'string', description: 'Optional: target chat_id or user open_id.' },
                receive_id_type: { type: 'string', description: "Optional: 'chat_id' or 'open_id'" },
            },
            oneOf: [
                { required: ['file_path'] },
                { required: ['file_key'] },
            ],
        },
    },
    {
        name: 'feishu_send_card',
        description: 'Send an interactive card with buttons to Feishu. Supports header with color, markdown body, action buttons with callback values, and optional footer note.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Card header title' },
                content: { type: 'string', description: 'Markdown body content' },
                header_color: { type: 'string', enum: ['blue', 'green', 'red', 'yellow', 'purple'], description: 'Header color template' },
                buttons: {
                    type: 'array', description: 'Action buttons. Each button sends a card.action.trigger event on click.',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: 'Button label' },
                            value: { type: 'object', description: 'Custom key-value pairs sent back on click. MUST include action_type key. Use action_type="mark-task-done" with task_id and task_summary for marking pending phone tasks as completed.' },
                            type: { type: 'string', enum: ['default', 'primary', 'danger'], description: 'Button style' },
                            confirm_title: { type: 'string', description: 'Confirmation dialog title' },
                            confirm_text: { type: 'string', description: 'Confirmation dialog body (supports markdown)' },
                        },
                        required: ['text', 'value'],
                    },
                },
                note: { type: 'string', description: 'Optional footer note text' },
                receive_id: { type: 'string', description: 'Optional: target chat_id or open_id.' },
                receive_id_type: { type: 'string', description: "Optional: 'chat_id' or 'open_id'" },
            },
            required: ['title', 'content'],
        },
    },
    {
        name: 'feishu_status',
        description: 'Check Feishu bot connectivity: verify credentials, get bot info, confirm API works.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
];
function handleToolCall(name, args, api, cfg) {
    switch (name) {
        case 'feishu_send_text': {
            const receiveId = args.receive_id || cfg.defaultReceiveId;
            const receiveIdType = args.receive_id_type || cfg.defaultReceiveIdType;
            if (!receiveId)
                return Promise.resolve({ error: 'No receive_id. Set FEISHU_RECEIVE_ID env var or pass receive_id argument.' });
            return api.sendText(receiveId, args.content, receiveIdType);
        }
        case 'feishu_send_markdown': {
            const receiveId = args.receive_id || cfg.defaultReceiveId;
            const receiveIdType = args.receive_id_type || cfg.defaultReceiveIdType;
            const title = args.title || 'Notification';
            if (!receiveId)
                return Promise.resolve({ error: 'No receive_id. Set FEISHU_RECEIVE_ID env var or pass receive_id argument.' });
            return api.sendMarkdown(receiveId, args.content, title, receiveIdType);
        }
        case 'feishu_send_card': {
            const receiveId = args.receive_id || cfg.defaultReceiveId;
            const receiveIdType = args.receive_id_type || cfg.defaultReceiveIdType;
            if (!receiveId)
                return Promise.resolve({ error: 'No receive_id. Set FEISHU_RECEIVE_ID env var or pass receive_id argument.' });
            const card = buildCardPayload(args);
            if (!card)
                return Promise.resolve({ error: 'Failed to build card payload' });
            return (async () => {
                const raw = await api.sendCard(receiveId, JSON.stringify(card), receiveIdType);
                if (raw.code !== 0)
                    return { error: `Failed to send card: ${raw.msg}` };
                return { success: true, message_id: raw.data?.message_id };
            })();
        }
        case 'feishu_send_image': {
            const receiveId = args.receive_id || cfg.defaultReceiveId;
            const receiveIdType = args.receive_id_type || cfg.defaultReceiveIdType;
            if (!receiveId)
                return Promise.resolve({ error: 'No receive_id. Set FEISHU_RECEIVE_ID env var or pass receive_id argument.' });
            if (!args.file_path && !args.image_key)
                return Promise.resolve({ error: 'Either file_path or image_key is required.' });
            return (async () => {
                let imageKey = args.image_key;
                if (args.file_path) {
                    if (!fs.existsSync(args.file_path))
                        return { error: `File not found: ${args.file_path}` };
                    imageKey = await api.uploadImage(args.file_path);
                }
                return api.sendImage(receiveId, imageKey, receiveIdType);
            })();
        }
        case 'feishu_send_file': {
            const receiveId = args.receive_id || cfg.defaultReceiveId;
            const receiveIdType = args.receive_id_type || cfg.defaultReceiveIdType;
            if (!receiveId)
                return Promise.resolve({ error: 'No receive_id.' });
            if (!args.file_path && !args.file_key)
                return Promise.resolve({ error: 'Either file_path or file_key is required.' });
            return (async () => {
                let fileKey = args.file_key;
                if (args.file_path) {
                    if (!fs.existsSync(args.file_path))
                        return { error: `File not found: ${args.file_path}` };
                    fileKey = await api.uploadFile(args.file_path, args.file_type || 'stream');
                }
                return api.sendFile(receiveId, fileKey, receiveIdType);
            })();
        }
        case 'feishu_status':
            return api.getBotInfo();
        default:
            return Promise.resolve({ error: `Unknown tool: ${name}` });
    }
}
// ========== HTTP SSE Server ==========
let serverInstance = null;
export async function startMcpServer(workDir) {
    if (serverInstance)
        return serverInstance;
    const feishuConfig = loadFeishuConfigLocal(workDir);
    if (!feishuConfig) {
        logger('No feishu config found in .claudetalk.json, MCP server not started');
        return null;
    }
    const api = new FeishuApiClient(feishuConfig.appId, feishuConfig.appSecret);
    const sseSessions = new Map();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        // SSE endpoint — long-lived connection
        if (url.pathname === '/sse' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            const sessionId = randomUUID();
            sseSessions.set(sessionId, res);
            // Send session endpoint
            res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
            // Keep-alive every 30s
            const keepAlive = setInterval(() => {
                res.write(':keepalive\n\n');
            }, 30000);
            req.on('close', () => {
                clearInterval(keepAlive);
                sseSessions.delete(sessionId);
            });
            return;
        }
        // JSON-RPC message endpoint
        if (url.pathname === '/message' && req.method === 'POST') {
            const sessionId = url.searchParams.get('sessionId');
            const sseRes = sessionId ? sseSessions.get(sessionId) : undefined;
            if (!sseRes) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Session not found' }));
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', async () => {
                let msg;
                try {
                    msg = JSON.parse(body);
                }
                catch {
                    const errResp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
                    sseRes.write(`event: message\ndata: ${JSON.stringify(errResp)}\n\n`);
                    res.writeHead(202);
                    res.end();
                    return;
                }
                const msgId = msg.id;
                const method = msg.method;
                try {
                    if (method === 'initialize') {
                        // Also accept notifications/initialized which has no id, or methods that don't need id
                        const result = {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'claudetalk-mcp', version: '0.1.0' },
                        };
                        if (msgId != null) {
                            sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msgId, result })}\n\n`);
                        }
                    }
                    else if (method === 'tools/list') {
                        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msgId, result: { tools: TOOLS } })}\n\n`);
                    }
                    else if (method === 'tools/call') {
                        const toolName = msg.params?.name || '';
                        const arguments_ = msg.params?.arguments || {};
                        const raw = await handleToolCall(toolName, arguments_, api, feishuConfig);
                        const text = JSON.stringify(raw, null, 2);
                        const content = [{ type: 'text', text }];
                        const isError = raw?.error != null ? true : undefined;
                        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msgId, result: { content, ...(isError ? { isError } : {}) } })}\n\n`);
                    }
                    else if (method === 'notifications/initialized') {
                        // No response needed
                    }
                    else {
                        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32601, message: `Method not found: ${method}` } })}\n\n`);
                    }
                }
                catch (e) {
                    logger(`Error handling method ${method}: ${e}`);
                    if (msgId != null) {
                        sseRes.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msgId, error: { code: -32603, message: e.message || 'Internal error' } })}\n\n`);
                    }
                }
                res.writeHead(202);
                res.end();
            });
            return;
        }
        // Health check
        if (url.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        res.writeHead(404);
        res.end('Not found');
    });
    // Handle port-in-use gracefully with retry
    server.on('error', (e) => {
        logger(`MCP server error: ${e.message}`);
    });
    // Cleanup: kill any process still holding the MCP port (自愈端口冲突)
    await killProcessOnPort(MCP_PORT);
    const started = await listenWithRetry(server, MCP_PORT);
    if (!started) {
        logger(`MCP server failed to bind port ${MCP_PORT} after retries, continuing without MCP server`);
        return null;
    }
    logger(`MCP server listening on http://localhost:${MCP_PORT}/sse`);
    serverInstance = server;
    return server;
}
/** Kill any process LISTENING on the given TCP port (cross-platform). */
export { killProcessOnPort };
async function listenWithRetry(server, port, maxRetries = 8, delayMs = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await new Promise((resolve, reject) => {
                const onError = (e) => {
                    server.removeListener('listening', onListening);
                    reject(e);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port);
            });
            return true;
        }
        catch (e) {
            if (e.code !== 'EADDRINUSE')
                throw e;
            logger(`Port ${port} in use (attempt ${i + 1}/${maxRetries}), waiting for release...`);
            // Check if port is free by attempting TCP connect; if connection refused, port is free
            const free = await new Promise((resolve) => {
                const s = new Socket();
                s.setTimeout(1500);
                s.on('connect', () => { s.destroy(); resolve(false); });
                s.on('error', () => { s.destroy(); resolve(true); });
                s.on('timeout', () => { s.destroy(); resolve(false); });
                s.connect(port, '127.0.0.1');
            });
            if (free)
                continue;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    return false;
}
export function stopMcpServer() {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
        logger('MCP server stopped');
    }
}
//# sourceMappingURL=mcp-server.js.map