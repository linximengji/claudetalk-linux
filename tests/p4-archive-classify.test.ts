/**
 * P4: 归档三分类测试（reference / task-pending / completed）
 *
 * 测试分类器决策 + 归档动作的一致性，不依赖真实文件系统/网络。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

// ========== 复刻分类器决策逻辑 ==========

type TaskCategory = 'reference' | 'task-pending' | 'completed'

// 分类器最终输出的三分类判断（复刻 classifier.ts 的决策规则）
function classifyMessage(
  message: string,
  reply: string,
  toolNames: string[],
): TaskCategory {
  const msg = message.toLowerCase()
  const rep = reply.toLowerCase()

  // completed: Claude 明确说干完了 + 用了工具
  const completionHints = [
    '已完成', '已修复', '已修改', '已创建', '修好了', '搞定',
    '已处理', '已经完成', '已经修复', '已生成', '已添加',
    '已更新', '已删除', '已配置', '已部署',
  ]
  const hasCompletionHint = completionHints.some(h => rep.includes(h))
  const hasSubstantiveTool = toolNames.some(t =>
    ['write', 'edit', 'create', 'bash', 'exec', 'replace'].some(k => t.toLowerCase().includes(k))
  )

  if (hasCompletionHint && (hasSubstantiveTool || toolNames.length > 0)) {
    return 'completed'
  }

  // task-pending: 需要终端处理/已加到待办
  if (rep.includes('待办') || rep.includes('加到待办') || rep.includes('添加到待办')) {
    return 'task-pending'
  }
  if (msg.includes('待办') || msg.includes('留到终端') || msg.includes('终端做')) {
    return 'task-pending'
  }
  if (rep.includes('需要本地环境') || rep.includes('需要在终端') || rep.includes('需要后续')) {
    return 'task-pending'
  }

  // 有实质性工具调用但未明确说"已完成"——视为 task-pending
  // （说明 Claude 在干了但还没收工）
  if (hasSubstantiveTool && !hasCompletionHint) {
    return 'task-pending'
  }

  return 'reference'
}

// 复刻 phone-archive.ts 的 index.json 写入决策
function decideArchiveAction(
  category: TaskCategory,
  isGroup: boolean,
  hasTools: boolean,
  hasCodeBlock: boolean,
  hasSubstance: boolean,
  hasImages: boolean,
): { archive: boolean; writeIndex: boolean; status: string | null } {
  if (isGroup) return { archive: false, writeIndex: false, status: null }
  if (!hasTools && !hasCodeBlock && !hasSubstance && !hasImages) {
    // 无实质内容，不归档
    // 但如果是 task，即使内容少也归档
    if (category === 'reference') return { archive: false, writeIndex: false, status: null }
  }
  // 分类器决定了写 index.json 的方式
  let status: string | null = null
  if (category === 'task-pending') status = 'task-pending'
  else if (category === 'completed') status = 'completed'
  // reference 不写 index.json

  return { archive: true, writeIndex: status !== null, status }
}

// ========== Tests ==========

describe('P4 Archive Classify (3-class)', () => {

  describe('classifier logic', () => {

    it('classifies completed: 已修复 + Write tool', () => {
      const r = classifyMessage(
        '修一下这个路径配置',
        '已完成，已修复路径配置，修改了 config.ts',
        ['Write', 'Bash'],
      )
      assert.strictEqual(r, 'completed')
    })

    it('classifies completed: 搞定 + 已创建文件', () => {
      const r = classifyMessage(
        '帮我创建这个脚本',
        '搞定，已创建 run.sh',
        ['Write', 'Edit'],
      )
      assert.strictEqual(r, 'completed')
    })

    it('classifies completed: 已修改 + Edit tool', () => {
      const r = classifyMessage(
        '配置修改一下',
        '已修改配置文件',
        ['Edit'],
      )
      assert.strictEqual(r, 'completed')
    })

    it('classifies task-pending: 需要终端处理', () => {
      const r = classifyMessage(
        '分析一下这个日志',
        '问题已定位，需要在终端修改配置',
        ['Bash'],
      )
      assert.strictEqual(r, 'task-pending')
    })

    it('classifies task-pending: 用户要求加到待办', () => {
      const r = classifyMessage(
        '也加到终端待办事项里去',
        '已经加上了',
        [],
      )
      assert.strictEqual(r, 'task-pending')
    })

    it('classifies task-pending: 需要后续处理', () => {
      const r = classifyMessage(
        '看看这个 bug',
        '找到了问题原因，需要后续修复',
        ['Read', 'Grep'],
      )
      assert.strictEqual(r, 'task-pending')
    })

    it('classifies reference: 纯调研回答', () => {
      const r = classifyMessage(
        'MCP server 是什么',
        'MCP server 是一种...（长篇分析）',
        [],
      )
      assert.strictEqual(r, 'reference')
    })

    it('classifies reference: 闲聊', () => {
      const r = classifyMessage(
        '今天天气不错',
        '是啊，适合写代码',
        [],
      )
      assert.strictEqual(r, 'reference')
    })

    it('classifies reference: 工具已用但内容不涉及完成', () => {
      // 用了工具但没说"已完成"——实际 fallback 到 task-pending（有实质工具调用）
      // 这里验证：有工具但没完成暗示 → task-pending
      const r = classifyMessage(
        '看看这个文件',
        '这就是你要的配置内容',
        ['Read', 'Grep'],
      )
      // Read/Grep 不是实质性工具，所以 fallback 到 reference
      assert.strictEqual(r, 'reference')
    })

    it('classifies task-pending when tools used without completion hint', () => {
      const r = classifyMessage(
        '帮我改一下配置',
        '这是改好的配置内容',
        ['Edit', 'Write'],
      )
      // 有实质性工具（Edit/Write）但没说"已完成/搞定" → task-pending
      assert.strictEqual(r, 'task-pending')
    })
  })

  describe('archive action decision', () => {

    it('skips archive for group chat', () => {
      const act = decideArchiveAction('task-pending', true, true, false, true, false)
      assert.strictEqual(act.archive, false)
    })

    it('skips archive for reference with no substance', () => {
      const act = decideArchiveAction('reference', false, false, false, false, false)
      assert.strictEqual(act.archive, false)
    })

    it('archives task-pending and writes index.json', () => {
      const act = decideArchiveAction('task-pending', false, true, false, true, false)
      assert.strictEqual(act.archive, true)
      assert.strictEqual(act.writeIndex, true)
      assert.strictEqual(act.status, 'task-pending')
    })

    it('archives completed and writes index.json as completed', () => {
      const act = decideArchiveAction('completed', false, true, false, true, false)
      assert.strictEqual(act.archive, true)
      assert.strictEqual(act.writeIndex, true)
      assert.strictEqual(act.status, 'completed')
    })

    it('archives reference but does NOT write index.json', () => {
      // reference 且内容够长，归档但不写 index.json
      const act = decideArchiveAction('reference', false, false, false, true, false)
      assert.strictEqual(act.archive, true)
      assert.strictEqual(act.writeIndex, false)
      assert.strictEqual(act.status, null)
    })
  })
})
