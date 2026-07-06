/**
 * 统一日志模块
 *
 * 所有日志格式：[yyyy-MM-dd HH:mm:ss.SSS] [channel profile] message
 * 使用 createLogger(channel?, profile?) 创建带上下文前缀的局部 logger
 */
/**
 * 初始化日志文件
 * @param workDir - 工作目录
 */
export declare function initLogFile(workDir: string): void;
/**
 * 关闭日志文件
 */
export declare function closeLogFile(): void;
/**
 * 基础日志函数，同时输出到 stderr 和日志文件
 */
export declare function log(msg: string): void;
/**
 * 创建带上下文前缀的局部 logger
 *
 * @param channel - 消息通道类型，如 feishu、dingtalk、discord
 * @param profile - profile 名称，如 pm、fdev
 *
 * 输出格式示例：
 * - createLogger('feishu', 'pm')    → [2026-04-01 18:00:00.123] [feishu pm] message
 * - createLogger('dingtalk')        → [2026-04-01 18:00:00.123] [dingtalk] message
 * - createLogger(undefined, 'pm')   → [2026-04-01 18:00:00.123] [profile=pm] message
 * - createLogger()                  → [2026-04-01 18:00:00.123] message
 */
export declare function createLogger(channel?: string, profile?: string): (msg: string) => void;
//# sourceMappingURL=logger.d.ts.map