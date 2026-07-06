/**
 * Shared Feishu message parser
 *
 * Parses text/image/post/file/audio messages from raw Feishu event content.
 * Used by feishu-bridge and FeishuClient. Image/file downloads use resources.ts.
 */
import { downloadImage, downloadFile, recognizeSpeech } from '../channels/feishu/resources.js';
export const SUPPORTED_MSG_TYPES = new Set(['text', 'image', 'post', 'file', 'audio']);
export async function parseFeishuMessage(messageType, rawContent, messageId, apiBase, workDir, accessToken) {
    const imagePaths = [];
    if (messageType === 'text') {
        try {
            const content = JSON.parse(rawContent);
            return { messageText: content.text || '', imagePaths };
        }
        catch {
            return { messageText: rawContent, imagePaths };
        }
    }
    if (messageType === 'image') {
        try {
            const content = JSON.parse(rawContent);
            if (content.image_key) {
                const localPath = await downloadImage(content.image_key, messageId, apiBase, workDir, accessToken);
                if (localPath)
                    imagePaths.push(localPath);
            }
        }
        catch { /* ignore */ }
        return { messageText: '', imagePaths };
    }
    if (messageType === 'post') {
        try {
            const content = JSON.parse(rawContent);
            const textParts = [];
            if (content.title)
                textParts.push(content.title);
            for (const line of content.content || []) {
                for (const element of line) {
                    if (element.tag === 'text' && element.text)
                        textParts.push(element.text);
                    else if (element.tag === 'img' && element.image_key) {
                        const localPath = await downloadImage(element.image_key, messageId, apiBase, workDir, accessToken);
                        if (localPath)
                            imagePaths.push(localPath);
                    }
                }
            }
            return { messageText: textParts.join(''), imagePaths };
        }
        catch { /* ignore */ }
        return { messageText: rawContent, imagePaths };
    }
    if (messageType === 'file') {
        try {
            const content = JSON.parse(rawContent);
            if (content.file_key) {
                const originalFileName = content.file_name || content.file_key;
                const localPath = await downloadFile(content.file_key, originalFileName, messageId, apiBase, workDir, accessToken);
                if (localPath)
                    imagePaths.push(`${localPath}|${originalFileName}`);
            }
        }
        catch { /* ignore */ }
        return { messageText: '', imagePaths };
    }
    if (messageType === 'audio') {
        try {
            const content = JSON.parse(rawContent);
            if (content.file_key) {
                const recognizedText = await recognizeSpeech(content.file_key, apiBase, accessToken);
                if (recognizedText)
                    return { messageText: recognizedText, imagePaths };
            }
        }
        catch { /* ignore */ }
        return { messageText: '[语音识别失败]', imagePaths };
    }
    return { messageText: rawContent, imagePaths };
}
//# sourceMappingURL=message-parser.js.map