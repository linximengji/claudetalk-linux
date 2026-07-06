/**
 * ClaudeTalk 启动入口
 * 根据 profile 配置的 channel 类型，创建对应的 Channel 实例并启动
 */
export interface StartBotOptions {
    workDir: string;
    profile?: string;
}
/**
 * 启动 Bot
 */
export declare function startBot(options: StartBotOptions): Promise<void>;
//# sourceMappingURL=index.d.ts.map