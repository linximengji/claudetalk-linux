import { describe, it } from 'node:test'
import assert from 'node:assert'

const mod = await import('./approval-handler.js')

describe('approval-handler', () => {
  describe('buildArchiveConfirmCard', () => {
    it('returns valid JSON card with confirm-archive action', () => {
      const card = JSON.parse(mod.buildArchiveConfirmCard('test message'))
      assert.strictEqual(card.header.title.content, '📌 加入手机待办')
      const actions = card.elements.find((e: any) => e.tag === 'action').actions
      assert.ok(actions.find((a: any) => a.value.action_type === 'confirm-archive'))
      assert.ok(actions.find((a: any) => a.value.action_type === 'dismiss'))
    })

    it('truncates long message to 200 chars', () => {
      const longMsg = 'x'.repeat(500)
      const card = JSON.parse(mod.buildArchiveConfirmCard(longMsg))
      const md = card.elements.find((e: any) => e.tag === 'markdown').content
      assert.ok(md.length < 350)
    })

    it('handles empty message', () => {
      const card = JSON.parse(mod.buildArchiveConfirmCard(''))
      assert.ok(card.elements.length > 0)
    })
  })

  describe('buildTaskConfirmCard', () => {
    it('returns card with confirm-task-create action', () => {
      const card = JSON.parse(mod.buildTaskConfirmCard({
        summary: 'test task',
        taskId: 'task_001',
      }))
      const actions = card.elements.find((e: any) => e.tag === 'action').actions
      assert.ok(actions.find((a: any) => a.value.action_type === 'confirm-task-create'))
    })

    it('includes type and priority labels when provided', () => {
      const card = JSON.parse(mod.buildTaskConfirmCard({
        summary: 'bug fix',
        taskId: 'task_002',
        type: 'bug',
        priority: 'high',
      }))
      const md = card.elements.find((e: any) => e.tag === 'markdown').content
      assert.ok(md.includes('漏洞'))
      assert.ok(md.includes('高'))
    })

    it('handles missing optional fields', () => {
      const card = JSON.parse(mod.buildTaskConfirmCard({
        summary: 'simple',
        taskId: 'task_003',
      }))
      assert.ok(card.elements.length > 0)
    })
  })

  describe('buildApprovalCard', () => {
    it('returns card with approval-action buttons', () => {
      const card = JSON.parse(mod.buildApprovalCard({
        riskLevel: 'L2',
        riskLabel: '中风险',
        messageSummary: 'delete file',
        requestId: 'apr_001',
        requesterId: 'ou_user',
        reason: 'requested',
      }))
      const actions = card.elements.find((e: any) => e.tag === 'action').actions
      assert.ok(actions.find((a: any) => a.value.action_type === 'approval-action'))
      assert.ok(actions.find((a: any) => a.value.decision === 'approve'))
      assert.ok(actions.find((a: any) => a.value.decision === 'reject'))
    })

    it('uses red header for L3 risk', () => {
      const card = JSON.parse(mod.buildApprovalCard({
        riskLevel: 'L3',
        riskLabel: '高风险',
        messageSummary: 'rm -rf',
        requestId: 'apr_002',
        requesterId: 'ou_admin',
        reason: 'dangerous',
      }))
      assert.strictEqual(card.header.template, 'red')
    })

    it('uses blue header for L1 risk', () => {
      const card = JSON.parse(mod.buildApprovalCard({
        riskLevel: 'L1',
        riskLabel: '低风险',
        messageSummary: 'read file',
        requestId: 'apr_003',
        requesterId: 'ou_user',
        reason: 'read-only',
      }))
      assert.strictEqual(card.header.template, 'blue')
    })
  })

  describe('inferTaskType', () => {
    it('identifies bug type', () => {
      assert.strictEqual(mod.inferTaskType('修复crash'), 'bug')
      assert.strictEqual(mod.inferTaskType('出现错误'), 'bug')
      assert.strictEqual(mod.inferTaskType('系统故障'), 'bug')
    })

    it('identifies feature type', () => {
      assert.strictEqual(mod.inferTaskType('新增用户管理'), 'feature')
      assert.strictEqual(mod.inferTaskType('添加导出功能'), 'feature')
    })

    it('identifies research type', () => {
      assert.strictEqual(mod.inferTaskType('调研数据库方案'), 'research')
      assert.strictEqual(mod.inferTaskType('分析性能瓶颈'), 'research')
    })

    it('returns task for unrecognized input', () => {
      assert.strictEqual(mod.inferTaskType('hello world'), 'task')
      assert.strictEqual(mod.inferTaskType(''), 'task')
    })
  })

  describe('inferTaskPriority', () => {
    it('identifies critical priority', () => {
      assert.strictEqual(mod.inferTaskPriority('紧急bug'), 'critical')
      assert.strictEqual(mod.inferTaskPriority('暂停服务'), 'critical')
    })

    it('identifies high priority', () => {
      assert.strictEqual(mod.inferTaskPriority('重要功能'), 'high')
      assert.strictEqual(mod.inferTaskPriority('严重crash'), 'high')
    })

    it('returns medium as default', () => {
      assert.strictEqual(mod.inferTaskPriority('普通任务'), 'medium')
      assert.strictEqual(mod.inferTaskPriority(''), 'medium')
    })
  })
})
