export declare const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
export declare class FeishuApiClient {
    private appId;
    private appSecret;
    private tokenCache;
    constructor(appId: string, appSecret: string);
    getAccessToken(): Promise<string>;
    sendText(receiveId: string, content: string, receiveIdType: string): Promise<any>;
    sendCard(receiveId: string, cardBody: string, receiveIdType: string): Promise<any>;
    sendMarkdown(receiveId: string, content: string, title: string, receiveIdType: string): Promise<any>;
    sendImage(receiveId: string, imageKey: string, receiveIdType: string): Promise<any>;
    sendFile(receiveId: string, fileKey: string, receiveIdType: string): Promise<any>;
    uploadImage(imagePath: string): Promise<string>;
    uploadFile(filePath: string, fileType: string): Promise<string>;
    getBotInfo(): Promise<any>;
    addReaction(messageId: string, emojiType: string): Promise<void>;
    updateCard(messageId: string, card: object): Promise<void>;
    private _sendMessage;
}
//# sourceMappingURL=api-client.d.ts.map