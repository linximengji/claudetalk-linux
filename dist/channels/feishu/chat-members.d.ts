/**
 * 飞书群成员管理模块
 *
 * ChatMemberStore  — 纯 JSON 文件读写，不碰飞书 API
 * ChatMemberResolver — API 查询 + 缓存写入，依赖 Store
 */
type ChatMemberType = 'user' | 'bot' | 'unknown';
export interface ChatMember {
    name: string;
    type: ChatMemberType;
    openId?: string;
    unionId?: string;
    appId?: string;
}
export type ChatMembersConfig = Record<string, Array<ChatMember>>;
export declare class ChatMemberStore {
    private configPath;
    private _dirty;
    private _data;
    constructor(configPath: string);
    private load;
    private persist;
    /** 读取指定群的成员列表（浅拷贝，保证外部修改不影响内部状态） */
    getMembers(chatId: string): ChatMember[];
    /**
     * 原子更新指定群的成员列表，自动写回磁盘。
     * updater 接收当前成员数组的浅拷贝，返回新的成员数组。
     */
    updateMembers(chatId: string, updater: (members: ChatMember[]) => ChatMember[]): void;
    /** 返回全部配置的浅拷贝 */
    getAll(): ChatMembersConfig;
}
export declare function fetchUserInfo(openId: string, accessToken: string, apiBase: string): Promise<{
    name: string;
    unionId: string;
} | null>;
export declare function fetchMemberInfoFromApi(openId: string, accessToken: string, apiBase: string): Promise<{
    name: string | null;
    type: ChatMemberType;
    unionId?: string;
}>;
export declare class ChatMemberResolver {
    private store;
    private apiBase;
    private getAccessToken;
    private logger;
    constructor(store: ChatMemberStore, apiBase: string, getAccessToken: () => Promise<string>, logger: (msg: string) => void);
    /**
     * 解析成员名称：先查配置缓存 → 不在则调 API → 写回缓存
     * @returns 成员名称，查不到返回 openId
     */
    resolve(openId: string, chatId: string, knownName?: string, unionId?: string): Promise<string>;
    /** 按 name 更新或追加成员 */
    private applyDelta;
    /** 提供对 Store 的直接访问（initializeBotInfo / getChatHistory 等需要） */
    getStore(): ChatMemberStore;
}
/**
 * 根据成员类型解析 @ 飞书的 at_id 和 at_id_type
 * user → union_id（优先）或 open_id
 * bot  → app_id（优先）或 open_id
 * 未知 → open_id
 */
export declare function resolveAtId(member: ChatMember): {
    atId: string;
    atIdType: string;
};
export {};
//# sourceMappingURL=chat-members.d.ts.map