export declare const SUPPORTED_MSG_TYPES: Set<string>;
export interface ParsedMessage {
    messageText: string;
    imagePaths: string[];
}
export declare function parseFeishuMessage(messageType: string, rawContent: string, messageId: string, apiBase: string, workDir: string, accessToken: string): Promise<ParsedMessage>;
//# sourceMappingURL=message-parser.d.ts.map