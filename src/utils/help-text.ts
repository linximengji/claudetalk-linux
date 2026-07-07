export const HELP_TEXT = [
  'ClaudeTalk 指令',
  '',
  '会话  /new   /session   /restart',
  '任务  /tasks   /task run/status/cancel',
  '状态  /status   /log',
  '远程  开启/关闭远程',
  '服务  打开/关闭 Jaeger / Pact / Dashboard',
  '帮助  /help',
].join('\n')

/** 上线通知精简版 — 只显示核心指令，引导用户发 /help 看全部 */
export function buildOnlineNotification(workDir: string): string {
  return [
    'ClaudeTalk 上线',
    `工作目录: ${workDir}`,
    '',
    '/new   /restart   /status   /help',
    '',
    '远程  term.linximengji.com',
  ].join('\n')
}
