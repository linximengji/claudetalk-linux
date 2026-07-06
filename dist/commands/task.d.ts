/**
 * /task 命令处理器
 * 子命令: run, status, cancel
 */
import type { Channel, ChannelMessageContext } from '../types.js';
export declare function handleTaskCommand(text: string, context: ChannelMessageContext, channel: Channel, workDir: string, profile?: string): Promise<boolean>;
//# sourceMappingURL=task.d.ts.map