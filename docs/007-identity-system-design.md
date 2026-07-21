# 用户身份系统设计

## 1. 问题定位

当前 claudetalk 的身份管理散落在三个地方：

| 位置 | 内容 | 问题 |
|---|---|---|
| `twin/users.json` | open_id → level 映射 | key 是 App 级，跨 bot 不可用 |
| `chat-members.json` | 群成员 open_id/unionId/appId 缓存 | 仅用于 @ 和显示名称，不做身份认定 |
| `.env` + config | FEISHU_RECEIVE_ID 固定的通知目标 | 跟身份体系无关 |
| `dmPolicy/groupPolicy` | 钉钉白名单 | 飞书没用这套体系 |

核心矛盾：使用 open_id（App 级）作为用户身份的持久标识。

## 2. 用户模型

### 2.1 全局用户注册表

**不绑定到任何一个 bot，供所有 bot 共享查找。** 只存"有服务价值的用户"——owner、friend 等。陌生人不占条目，走默认级。

```typescript
// 用户注册表条目
interface IdentityEntry {
  name: string
  level: IdentityLevel
  relation: string
  description: string
  
  // 跨 App 锚定：union_id 是租户级唯一
  unionId: string
  
  // App 级别名，用于免 API 快速查找
  openIds: {
    [appId: string]: string  // appId → open_id 映射
  }
}

type IdentityLevel = 'owner' | 'friend' | 'stranger' | 'banned'
```

物理文件：`.claudetalk/identities.json`（全局，所有 profile 共用）

```json
{
  "on_e73cb43c05cbd5aad62bd410bda606b2": {
    "name": "林夕梦记",
    "level": "owner",
    "relation": "自己",
    "description": "数字分身的主人",
    "openIds": {
      "cli_aa838f41f9f8dbe7": "ou_6a6b52dc63d4051834ae522a3a6e7775",
      "cli_aad0ac29fdf91bd5": "ou_f19c3f5115838fd3dbf9f4bf577d1efb",
      "cli_aad19954aa385d11": "ou_2d49fc00a33a40c3b5755d58c469e09e"
    }
  },
  "_default_owner": {
    "name": "主人",
    "level": "owner",
    "description": "未注册但拥有全部权限"
  },
  "_default_friend": {
    "name": "亲友",
    "level": "friend",
    "description": "可对话，不记录私人行为"
  },
  "_default_stranger": {
    "name": "陌生人",
    "level": "stranger",
    "description": "只能问基础问题"
  },
  "_default_banned": {
    "name": "已封禁",
    "level": "banned",
    "description": "不响应"
  }
}
```

### 2.2 查找算法

```
收到消息(senderOpenId=ou_xxx, appId=cli_aaa)
  ↓
快速查找索引: 遍历所有条目，匹配 openIds[appId] === ou_xxx
  ├─ 命中 → 返回该条目的 level/name
  └─ 未命中 → 
      调用 Feishu API contact/v3/users/{ou_xxx}?user_id_type=open_id
      取 response.user.union_id
      ├─ 用 union_id 查 identities.json
      │   ├─ 命中 → 回写 openIds[appId]=ou_xxx
      │   │         返回该条目的 level/name
      │   └─ 未命中 → 返回 _default_stranger
      └─ API 失败 → 返回 _default_stranger（降级，不阻塞消息）
```

关键行为：
- 首次遭遇新用户时最多一次 API 调用（获取 union_id）
- 获取到 union_id 后自动回写缓存到 openIds 映射
- 后续同一用户通过任何 bot 发消息，直接走快速查找命中
- API 失败不影响消息流转，只是给陌生人级别

### 2.3 跨 bot 自动关联

假设用户 A 有 union_id=on_xxx，他通过 bot-B 发了第一条消息：
1. bot-B 第一次看到 ou_bbbb，未命中
2. 查 API 得到 union_id=on_xxx
3. 在 identities.json 中：
   - 如果 on_xxx 已存在（在其他 bot 登记过）→ 追加 openIds: {cli_bbbb: ou_bbbb}
   - 如果 on_xxx 不存在 → 返回 _default_stranger（不自动创建条目，条目需管理）

## 3. Bot 级身份策略

### 3.1 配置声明

```typescript
interface IdentityPolicy {
  // 是否执行业务检查（true=不检查直接放行）
  skipCheck?: boolean
  
  // 用户发现策略：收到陌生人消息时的行为
  onUnknown: 'allow' | 'block'
  
  // 允许的服务级别（顺序降权：列表中的最高级生效）
  allowedLevels?: IdentityLevel[]
  
  // 是否将身份信息注入到 Claude prompt（用于 twin 等需要身份感知的 bot）
  injectIdentity?: boolean
}
```

### 3.2 三种策略

**主 bot（default）** — 只服务 owner，拒绝陌生人
```json
{
  "identityPolicy": {
    "onUnknown": "block",
    "allowedLevels": ["owner"]
  }
}
```

**数字分身（twin）** — 识别身份，分级服务，注入 prompt
```json
{
  "identityPolicy": {
    "onUnknown": "allow",
    "allowedLevels": ["owner", "friend", "stranger"],
    "injectIdentity": true
  }
}
```

**旅游助理（trip）** — 不查身份，所有人可参与
```json
{
  "identityPolicy": {
    "skipCheck": true
  }
}
```

### 3.3 决策矩阵

| 策略项 | 主 bot | 数字分身 | 旅游助理 |
|---|---|---|---|
| `skipCheck` | false | false | **true** |
| `onUnknown` | block | allow | — |
| `allowedLevels` | [owner] | [owner, friend, stranger] | — |
| `injectIdentity` | false | true | false |

当 `skipCheck=true` 时，直接跳过身份查找，不判断级别，不注入。

### 3.4 FEISHU_RECEIVE_ID 的意义变更

当前 FEISHU_RECEIVE_ID 用于主 bot 的"上线通知发送到哪里"。重构后保留此用途，但不作为身份系统的输入。

## 4. 实现

### 4.1 IdentityResolver 类

```typescript
class IdentityResolver {
  constructor(
    private identitiesPath: string,    // .claudetalk/identities.json
    private feishuApiBase: string,
    private tokenGetter: () => Promise<string>,
  )
  
  // 主入口：open_id → 身份级别
  async resolve(
    senderOpenId: string,
    appId: string,
  ): Promise<{ level: string; name: string; description: string }>
}
```

### 4.2 变更波及面

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 新增 `IdentityEntry`、`IdentityLevel`、`IdentityPolicy` 类型 |
| `src/core/identity.ts` | 新增 `IdentityResolver` 类 |
| `src/index.ts` | L920-944 改用 `IdentityResolver.resolve()` |
| `src/channels/feishu/index_feishu.ts` | 消息入口处调用身份检查 |
| `.claudetalk.json` profiles | 每个 profile 加 `identityPolicy` 字段 |
| `.claudetalk/identities.json` | 新增全局用户注册表 |
| `.claudetalk/twin/users.json` | 废弃，迁移到 identities.json |

### 4.3 迁移

1. 创建 `identities.json`，将现有 `twin/users.json` 的内容以 union_id 为 key 迁移过去
2. 现有唯一 owner（`ou_2d49fc00...`）需要补充 union_id 和 openIds 映射
3. `_default_owner` / `_default_friend` / `_default_stranger` 原样保留

## 5. 边界情况处理

| 场景 | 行为 |
|---|---|
| `identities.json` 不存在 | 所有用户视为 stranger，`onUnknown: block` 的策略拒绝所有人 |
| API 获取 union_id 失败 | 降级为 stranger，不影响消息流转 |
| 群消息中 senderOpenId 为空 | traveler（bot 自己的消息）→ 直接跳过身份检查 |
| 用户在不同 bot 下首次出现 | 走 API 回写，后续不用再查 |
| `allowedLevels` 为空 | 等价于 block，所有身份级别都被拒绝 |
| 身份级别低于 allowedLevels | 按 `onUnknown` 策略处理（block/allow） |

## 6. 未来扩展空间

- **操作日志**：`identities.json` 可扩展 `interactions` 字段记录活跃度
- **第三方平台**：加入 `platformIds: { dingtalk: {...}, discord: {...} }` 支持跨平台
- **粗粒度权限**：level 系统可扩展为 `permissions: string[]` 支持更细的控制
- **远程身份源**：`identities.json` 可被远程服务替换，底层查找接口不变
