/** 默认场景指令（主通讯界面） */
const HELP_DEFAULT = [
    'ClaudeTalk 指令',
    '',
    '会话  /new   /session   /restart',
    '任务  /tasks   /task run/status/cancel',
    '状态  /status   /log',
    '远程  开启/关闭远程',
    '服务  打开/关闭 Jaeger / Pact / Dashboard',
    '帮助  /help',
].join('\n');
/** 数字分身场景指令 */
const HELP_TWIN = [
    '数字分身 指令',
    '',
    '会话  /new   /restart',
    '记忆  /status   /log',
    '帮助  /help',
    '',
    '我是你的数字分身，基于记忆库回答。',
].join('\n');
/** 旅游助理场景指令 */
const HELP_TRIP = [
    '旅游助理 指令',
    '',
    '会话  /new   /restart',
    '景点  搜索附近景点 / 景点详情',
    '路线  路线规划 / 交通建议',
    '天气  目的地天气',
    '行程  查看/修改今日行程',
    '状态  /status   /log',
    '帮助  /help',
    '',
    '输入目的地或需求，帮你规划行程。',
].join('\n');
const HELP_MAP = {
    twin: HELP_TWIN,
    trip: HELP_TRIP,
};
export function HELP_TEXT(profile) {
    return HELP_MAP[profile || ''] || HELP_DEFAULT;
}
/** 场景入口别名，匹配 .claudetalk.json 中 profile.systemPrompt 的映射 */
const NOTIFY_ALIAS = {
    twin: '数字分身',
    trip: '旅游助理',
};
function profileLabel(profile) {
    return NOTIFY_ALIAS[profile || ''] || 'ClaudeTalk';
}
/** 场景专属上线通知 — 精简指令 + 场景说明 */
export function buildOnlineNotification(workDir, profile) {
    const label = profileLabel(profile);
    const lines = [
        `${label} 上线`,
        `工作目录: ${workDir}`,
        '',
    ];
    if (profile === 'twin') {
        lines.push('/new   /restart   /status   /help');
        lines.push('');
        lines.push('基于记忆库回答，仅主人可写入新记忆。');
    }
    else if (profile === 'trip') {
        lines.push('/new   /restart   /status   /help');
        lines.push('');
        lines.push('景点 · 路线 · 天气 · 行程 · 出发！');
    }
    else {
        lines.push('/new   /restart   /status   /help');
        lines.push('');
        lines.push('远程  term.linximengji.com');
    }
    return lines.join('\n');
}
//# sourceMappingURL=help-text.js.map