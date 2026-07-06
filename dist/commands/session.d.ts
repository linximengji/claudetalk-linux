/**
 * /session 命令处理器
 * 子命令: list, name <标题>, 无参数(显示当前会话摘要)
 */
import type { Channel, ChannelMessageContext } from '../types.js';
export declare function handleSessionCommand(text: string, context: ChannelMessageContext, channel: Channel, workDir: string, profile?: string): Promise<boolean>;
//# sourceMappingURL=session.d.ts.map