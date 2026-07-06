/**
 * 飞书资源下载模块 —— 图片下载、文件下载、语音识别
 *
 * 三个纯函数：只收原始值（string），不收 callback。
 * 调用方先自己取 accessToken，再传进来。
 */
export declare function downloadImage(imageKey: string, messageId: string, apiBase: string, workDir: string, accessToken: string): Promise<string | null>;
export declare function downloadFile(fileKey: string, fileName: string, messageId: string, apiBase: string, workDir: string, accessToken: string): Promise<string | null>;
export declare function recognizeSpeech(fileKey: string, apiBase: string, accessToken: string): Promise<string | null>;
//# sourceMappingURL=resources.d.ts.map