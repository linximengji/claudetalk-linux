/**
 * 飞书资源下载模块 —— 图片下载、文件下载、语音识别
 *
 * 三个纯函数：只收原始值（string），不收 callback。
 * 调用方先自己取 accessToken，再传进来。
 */
import * as fs from 'fs';
import * as path from 'path';
export async function downloadImage(imageKey, messageId, apiBase, workDir, accessToken) {
    try {
        const imageDir = path.join(workDir, '.claudetalk', 'feishu', 'images');
        if (!fs.existsSync(imageDir))
            fs.mkdirSync(imageDir, { recursive: true });
        const safeImageKey = imageKey.replace(/[^a-zA-Z0-9_-]/g, '_');
        const localPath = path.join(imageDir, `${safeImageKey}.jpg`);
        if (fs.existsSync(localPath))
            return localPath;
        const response = await fetch(`${apiBase}/im/v1/messages/${messageId}/resources/${imageKey}?type=image`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok)
            return null;
        const contentLength = Number(response.headers.get('content-length') || '0');
        if (contentLength > 20 * 1024 * 1024)
            return null;
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 20 * 1024 * 1024)
            return null;
        fs.writeFileSync(localPath, Buffer.from(arrayBuffer));
        return localPath;
    }
    catch {
        return null;
    }
}
export async function downloadFile(fileKey, fileName, messageId, apiBase, workDir, accessToken) {
    try {
        const fileDir = path.join(workDir, '.claudetalk', 'feishu', 'files');
        if (!fs.existsSync(fileDir))
            fs.mkdirSync(fileDir, { recursive: true });
        const safeFileKey = fileKey.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ext = path.extname(fileName);
        const localFileName = ext ? `${safeFileKey}${ext}` : safeFileKey;
        const localPath = path.join(fileDir, localFileName);
        if (fs.existsSync(localPath))
            return localPath;
        const response = await fetch(`${apiBase}/im/v1/messages/${messageId}/resources/${fileKey}?type=file`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok)
            return null;
        const contentLength = Number(response.headers.get('content-length') || '0');
        if (contentLength > 50 * 1024 * 1024)
            return null;
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 50 * 1024 * 1024)
            return null;
        fs.writeFileSync(localPath, Buffer.from(arrayBuffer));
        return localPath;
    }
    catch {
        return null;
    }
}
export async function recognizeSpeech(fileKey, apiBase, accessToken) {
    try {
        const response = await fetch(`${apiBase}/speech_to_text/v1/speech/recognize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                speech: { file_key: fileKey },
                config: { file_type: 'opus', language: 'zh' },
            }),
        });
        if (!response.ok)
            return null;
        const data = (await response.json());
        if (data.code === 0 && data.data?.recognition_text) {
            return data.data.recognition_text;
        }
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=resources.js.map