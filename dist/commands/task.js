/**
 * /task 命令处理器
 * 子命令: run, status, cancel
 */
import { startBackgroundTask, getAllTasks, cancelTask, MAX_BG_TASKS } from '../core/background-task.js';
function formatTime(ts) {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function truncate(s, max) {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
export async function handleTaskCommand(text, context, channel, workDir, profile) {
    const { conversationId, isGroup } = context;
    const parts = text.trim().split(/\s+/);
    const sub = parts[1]?.toLowerCase() || '';
    if (sub === 'run') {
        const description = parts.slice(2).join(' ').trim();
        if (!description) {
            await channel.sendMessage(conversationId, '用法: /task run <任务描述>', isGroup);
            return true;
        }
        const taskId = startBackgroundTask(description, workDir, profile, (entry) => {
            // 任务完成回调：推送结果
            const statusIcon = entry.status === 'completed' ? '✅' : '❌';
            const lines = [
                `${statusIcon} **后台任务 ${entry.status === 'completed' ? '完成' : '失败'}**`,
                `  任务ID: \`${entry.id}\``,
                `  描述: ${entry.summary}`,
                `  耗时: ${Math.round((entry.completedAt - entry.createdAt) / 1000)}s`,
            ];
            if (entry.result) {
                lines.push(`  结果: ${truncate(entry.result, 200)}`);
            }
            if (entry.error) {
                lines.push(`  错误: ${entry.error}`);
            }
            channel.sendMessage(conversationId, lines.join('\n'), isGroup).catch(() => { });
        });
        if (taskId === null) {
            await channel.sendMessage(conversationId, `后台任务已满（上限 ${MAX_BG_TASKS}），请等待当前任务完成`, isGroup);
            return true;
        }
        await channel.sendMessage(conversationId, `⏳ 后台任务已启动 (\`${taskId}\`)\n完成后将自动推送结果`, isGroup);
        return true;
    }
    if (sub === 'status') {
        const all = getAllTasks();
        if (all.length === 0) {
            await channel.sendMessage(conversationId, '暂无后台任务记录', isGroup);
            return true;
        }
        const lines = ['**后台任务列表**'];
        for (const t of all.slice(0, 10)) {
            const icon = t.status === 'running' ? '⏳' : t.status === 'completed' ? '✅' : '❌';
            const time = formatTime(t.createdAt);
            lines.push(`  ${icon} \`${t.id.slice(0, 16)}…\` ${truncate(t.summary, 30)}`);
            lines.push(`    ${time} | ${t.status}`);
        }
        const running = all.filter(t => t.status === 'running').length;
        lines.push(`\n共计 ${all.length} 条，运行中 ${running}/${MAX_BG_TASKS}`);
        await channel.sendMessage(conversationId, lines.join('\n'), isGroup);
        return true;
    }
    if (sub === 'cancel') {
        const taskId = parts[2]?.trim();
        if (!taskId) {
            await channel.sendMessage(conversationId, '用法: /task cancel <任务ID>', isGroup);
            return true;
        }
        const ok = cancelTask(taskId);
        await channel.sendMessage(conversationId, ok ? `⏹️ 已取消任务 \`${taskId}\`` : `未找到运行中的任务 \`${taskId}\``, isGroup);
        return true;
    }
    // 无子命令 → 同 status
    const all = getAllTasks();
    const lines = ['**后台任务**'];
    lines.push(`  运行中: ${all.filter(t => t.status === 'running').length}/${MAX_BG_TASKS}`);
    lines.push(`  最近完成: ${all.filter(t => t.status === 'completed').length}`);
    lines.push(`  失败: ${all.filter(t => t.status === 'failed').length}`);
    if (all.length > 0) {
        lines.push(`  最新: ${truncate(all[0].summary, 40)}`);
    }
    lines.push('\n子命令: run, status, cancel');
    await channel.sendMessage(conversationId, lines.join('\n'), isGroup);
    return true;
}
//# sourceMappingURL=task.js.map