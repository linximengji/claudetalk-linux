---
name: architecture
description: claudetalk 功能切面映射 — 对话归档与交互日志
metadata:
  type: project
---

## 成长缺口（Gap Detection & Ingestion）

Gap 推送（检测+发卡片）：`digital-clone/twin/gap_detector.py`，不改
Gap 摄入（回答处理）：从 `feishu-bridge.ts` 移到 `src/channels/feishu/index_feishu.ts` 的 `tryHandleGapOrTwin` 方法
- twin bot 的 directWS `channel.on('message')` 回调中优先拦截
- /twin 指令和 gap 回复都在这里处理，不进入 peer-message 流程
- 读取/写入 `~/.claude/twin_gap_state.json`

## 对话归档与交互日志

### 数据流
每条消息回复完成后调用 `archiveConversation()` → 写入 `tasks/YYYY-MM-DD/XXX-slug/{消息.md,回复.md,meta.json}`。

新增 `meta.json` 记录 `{ userId, channel, profile, ts }`，用于将归档对话与发送者关联。

### 交互日志
`/home/ubuntu/projects/claudetalk/src/core/twin-interactions.ts` — 提供给 twin profile 使用。

- **写**：`logInteraction()` 追加一行到 `.claudetalk/twin/interactions.jsonl`
- **查**：`listUsers()` / `searchUser()` / `profile()` 三种查询
- 身份来源：`twin/users.json`（运行时查），日志只存快照 name/level
- 未注册用户自动标 stranger

### 涉及文件
| 文件 | 切面 |
|------|------|
| `src/core/phone-archive.ts` | 完整对话存档 + meta.json |
| `src/core/twin-interactions.ts` | 交互日志写+查 |
| `src/index.ts` | 3处 archive 调用 + twin logInteraction |
| `src/channels/feishu/index_feishu.ts` | 确认待办归档 + gap 摄入（twin directWS） |
| `.claudetalk/twin/users.json` | 用户身份注册表 |
| `.claudetalk/twin/interactions.jsonl` | append-only 交互日志 |
| `.claude/agents/twin.md` | 数字分身 agent 定义 |
| `~/.claude/twin_gap_state.json` | gap 推送+回答状态（gaps 数组） |

### 不包含
- ops-daemon episodic 格式不改
- 群聊对话不归档（phone-archive 直接跳过）
- 交互日志不做自动过期（先用着，需要时再加）
- `feishu-bridge.ts` 不再包含任何 twin/gap 业务逻辑
