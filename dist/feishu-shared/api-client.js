/**
 * Shared Feishu API Client
 *
 * Token management, message sending, reaction, card update.
 * Used by feishu-bridge, mcp-server, and FeishuClient.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
// ========== Multipart helpers ==========
function buildMultipartBody(parts) {
    const boundary = '----FormBoundary' + randomUUID().replace(/-/g, '');
    const enc = new TextEncoder();
    const chunks = [];
    for (const p of parts) {
        let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
        if (p.isFile) {
            header += `; filename="${p.name}"\r\nContent-Type: ${p.mime || 'application/octet-stream'}`;
        }
        header += '\r\n\r\n';
        chunks.push(enc.encode(header));
        if (p.data)
            chunks.push(p.data);
        chunks.push(enc.encode('\r\n'));
    }
    chunks.push(enc.encode(`--${boundary}--\r\n`));
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const body = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
        body.set(c, off);
        off += c.length;
    }
    return { body: body.buffer, boundary };
}
export const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
export class FeishuApiClient {
    appId;
    appSecret;
    tokenCache = null;
    constructor(appId, appSecret) {
        this.appId = appId;
        this.appSecret = appSecret;
    }
    async getAccessToken() {
        const now = Date.now();
        if (this.tokenCache && now < this.tokenCache.expiresAt - 60000) {
            return this.tokenCache.token;
        }
        const resp = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        });
        const data = await resp.json();
        if (data.code !== 0)
            throw new Error(`Token error: ${data.msg}`);
        this.tokenCache = {
            token: data.tenant_access_token,
            expiresAt: now + (data.expire - 60) * 1000,
        };
        return data.tenant_access_token;
    }
    async sendText(receiveId, content, receiveIdType) {
        return this._sendMessage(receiveId, 'text', JSON.stringify({ text: content }), receiveIdType);
    }
    async sendCard(receiveId, cardBody, receiveIdType) {
        return this._sendMessage(receiveId, 'interactive', cardBody, receiveIdType);
    }
    async sendMarkdown(receiveId, content, title, receiveIdType) {
        const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: title } },
            elements: [{ tag: 'markdown', content }],
        };
        return this._sendMessage(receiveId, 'interactive', JSON.stringify(card), receiveIdType);
    }
    async sendImage(receiveId, imageKey, receiveIdType) {
        return this._sendMessage(receiveId, 'image', JSON.stringify({ image_key: imageKey }), receiveIdType);
    }
    async sendFile(receiveId, fileKey, receiveIdType) {
        return this._sendMessage(receiveId, 'file', JSON.stringify({ file_key: fileKey }), receiveIdType);
    }
    async uploadImage(imagePath) {
        const token = await this.getAccessToken();
        const imageBuffer = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimeTable = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        };
        const mime = mimeTable[ext] || 'application/octet-stream';
        const fileName = path.basename(imagePath);
        const { body, boundary } = buildMultipartBody([
            { name: 'image_type', value: 'message' },
            { name: 'image', value: fileName, isFile: true, data: imageBuffer, mime },
        ]);
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/images`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        const data = await resp.json();
        if (data.code !== 0)
            throw new Error(`Image upload failed: ${data.msg}`);
        return data.data.image_key;
    }
    async uploadFile(filePath, fileType) {
        const token = await this.getAccessToken();
        const ext = path.extname(filePath).toLowerCase();
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const feishuTypeMap = {
            '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls',
            '.ppt': 'ppt', '.pptx': 'ppt', '.mp4': 'mp4', '.mp3': 'opus',
        };
        const feishuType = feishuTypeMap[ext] || 'stream';
        const { body, boundary } = buildMultipartBody([
            { name: 'file_type', value: feishuType },
            { name: 'file_name', value: fileName },
            { name: 'file', value: fileName, isFile: true, data: fileBuffer },
        ]);
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/files`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
        });
        const data = await resp.json();
        if (data.code !== 0)
            throw new Error(`File upload failed: ${data.msg}`);
        return data.data.file_key;
    }
    async getBotInfo() {
        const token = await this.getAccessToken();
        const resp = await fetch(`${FEISHU_API_BASE}/bot/v3/info`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return resp.json();
    }
    async addReaction(messageId, emojiType) {
        const token = await this.getAccessToken();
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${messageId}/reactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        });
        const data = await resp.json();
        if (data.code !== 0) {
            // Reaction errors are non-fatal (e.g. emoji already added)
            console.error(`[FeishuApiClient] addReaction failed (${emojiType} on ${messageId}): code=${data.code}`);
        }
    }
    async updateCard(messageId, card) {
        const token = await this.getAccessToken();
        const body = { msg_type: 'interactive', content: JSON.stringify(card) };
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.code !== 0) {
            console.error(`[FeishuApiClient] updateCard failed: code=${data.code}`);
        }
    }
    async _sendMessage(receiveId, msgType, content, receiveIdType) {
        const token = await this.getAccessToken();
        const resp = await fetch(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
        });
        return resp.json();
    }
}
//# sourceMappingURL=api-client.js.map