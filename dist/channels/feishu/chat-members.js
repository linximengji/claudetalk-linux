/**
 * 飞书群成员管理模块
 *
 * ChatMemberStore  — 纯 JSON 文件读写，不碰飞书 API
 * ChatMemberResolver — API 查询 + 缓存写入，依赖 Store
 */
import * as fs from 'fs';
import * as path from 'path';
// ========== ChatMemberStore ==========
export class ChatMemberStore {
    configPath;
    _dirty = false;
    _data = null;
    constructor(configPath) {
        this.configPath = configPath;
    }
    load() {
        if (this._data === null || this._dirty) {
            try {
                if (fs.existsSync(this.configPath)) {
                    const content = fs.readFileSync(this.configPath, 'utf-8');
                    this._data = JSON.parse(content);
                }
                else {
                    this._data = {};
                }
            }
            catch {
                this._data = {};
            }
            this._dirty = false;
        }
        return this._data;
    }
    persist() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.configPath, JSON.stringify(this._data, null, 2), 'utf-8');
            this._dirty = false;
        }
        catch {
            // disk write failure — caller logs if needed
        }
    }
    /** 读取指定群的成员列表（浅拷贝，保证外部修改不影响内部状态） */
    getMembers(chatId) {
        return [...(this.load()[chatId] ?? [])];
    }
    /**
     * 原子更新指定群的成员列表，自动写回磁盘。
     * updater 接收当前成员数组的浅拷贝，返回新的成员数组。
     */
    updateMembers(chatId, updater) {
        const current = this.getMembers(chatId);
        const updated = updater(current);
        const config = this.load();
        config[chatId] = updated;
        this._dirty = true;
        this.persist();
    }
    /** 返回全部配置的浅拷贝 */
    getAll() {
        return { ...this.load() };
    }
}
// ========== API 查询纯函数 ==========
export async function fetchUserInfo(openId, accessToken, apiBase) {
    try {
        const response = await fetch(`${apiBase}/contact/v3/users/${openId}?user_id_type=open_id`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = (await response.json());
        if (data.code === 0 && data.data?.user?.name) {
            const { name, union_id: unionId } = data.data.user;
            return { name, unionId };
        }
        return null;
    }
    catch {
        return null;
    }
}
export async function fetchMemberInfoFromApi(openId, accessToken, apiBase) {
    const userInfo = await fetchUserInfo(openId, accessToken, apiBase);
    if (userInfo !== null) {
        return { name: userInfo.name, type: 'user', unionId: userInfo.unionId };
    }
    return { name: null, type: 'unknown' };
}
// ========== ChatMemberResolver ==========
export class ChatMemberResolver {
    store;
    apiBase;
    getAccessToken;
    logger;
    constructor(store, apiBase, getAccessToken, logger) {
        this.store = store;
        this.apiBase = apiBase;
        this.getAccessToken = getAccessToken;
        this.logger = logger;
    }
    /**
     * 解析成员名称：先查配置缓存 → 不在则调 API → 写回缓存
     * @returns 成员名称，查不到返回 openId
     */
    async resolve(openId, chatId, knownName, unionId) {
        if (!openId || openId === '(unknown)')
            return openId;
        // 1. 先从配置文件查找
        const members = this.store.getMembers(chatId);
        let existing;
        if (knownName) {
            existing = members.find((m) => m.name === knownName);
        }
        if (!existing) {
            existing = members.find((m) => m.openId === openId);
        }
        if (existing) {
            // 补充缺失的字段
            const needOpenId = openId && existing.openId !== openId;
            const needUnionId = unionId && !existing.unionId;
            if (needOpenId || needUnionId) {
                const delta = {};
                if (needOpenId)
                    delta.openId = openId;
                if (needUnionId)
                    delta.unionId = unionId;
                this.applyDelta(chatId, existing.name, existing.type, delta);
            }
            return existing.name;
        }
        // 2. API 查询
        const accessToken = await this.getAccessToken();
        const { name, type, unionId: apiUnionId } = await fetchMemberInfoFromApi(openId, accessToken, this.apiBase);
        const resolvedUnionId = apiUnionId || unionId;
        if (name) {
            this.applyDelta(chatId, name, type, { openId, unionId: resolvedUnionId });
            return name;
        }
        if (knownName) {
            this.logger(`Using known name from mentions for ${openId}: ${knownName}`);
            this.applyDelta(chatId, knownName, type, { openId, unionId: resolvedUnionId });
            return knownName;
        }
        this.logger(`User ${openId} is invalid and no known name, skipping config update`);
        return openId;
    }
    /** 按 name 更新或追加成员 */
    applyDelta(chatId, memberName, memberType, ids) {
        if (!memberName || memberName === '(unknown)')
            return;
        this.store.updateMembers(chatId, (members) => {
            const idx = members.findIndex((m) => m.name === memberName);
            if (idx >= 0) {
                const m = members[idx];
                const newOpenId = ids?.openId ?? m.openId;
                const newUnionId = ids?.unionId ?? m.unionId;
                const newAppId = ids?.appId ?? m.appId;
                if (m.type === memberType && m.openId === newOpenId && m.unionId === newUnionId && m.appId === newAppId) {
                    return members; // no change
                }
                m.type = memberType;
                if (newOpenId)
                    m.openId = newOpenId;
                if (newUnionId)
                    m.unionId = newUnionId;
                if (newAppId)
                    m.appId = newAppId;
                this.logger(`Updated chat member: chatId=${chatId}, name=${memberName}, type=${memberType}, openId=${newOpenId}, unionId=${newUnionId}, appId=${newAppId}`);
                return [...members];
            }
            const newMember = { name: memberName, type: memberType };
            if (ids?.openId)
                newMember.openId = ids.openId;
            if (ids?.unionId)
                newMember.unionId = ids.unionId;
            if (ids?.appId)
                newMember.appId = ids.appId;
            this.logger(`Added chat member: chatId=${chatId}, name=${memberName}, type=${memberType}, openId=${ids?.openId}, unionId=${ids?.unionId}, appId=${ids?.appId}`);
            return [...members, newMember];
        });
    }
    /** 提供对 Store 的直接访问（initializeBotInfo / getChatHistory 等需要） */
    getStore() {
        return this.store;
    }
}
/**
 * 根据成员类型解析 @ 飞书的 at_id 和 at_id_type
 * user → union_id（优先）或 open_id
 * bot  → app_id（优先）或 open_id
 * 未知 → open_id
 */
export function resolveAtId(member) {
    if (member.type === 'user') {
        return member.unionId
            ? { atId: member.unionId, atIdType: 'union_id' }
            : { atId: member.openId || '(unknown)', atIdType: 'open_id' };
    }
    if (member.type === 'bot') {
        return member.appId
            ? { atId: member.appId, atIdType: 'app_id' }
            : { atId: member.openId || '(unknown)', atIdType: 'open_id' };
    }
    return { atId: member.openId || '(unknown)', atIdType: 'open_id' };
}
//# sourceMappingURL=chat-members.js.map