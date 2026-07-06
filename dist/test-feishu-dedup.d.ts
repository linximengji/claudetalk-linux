/**
 * 飞书消息去重逻辑自动化测试
 *
 * 模拟 feishu-bridge 的消息事件处理逻辑，验证：
 * 1. bot 自己的消息被跳过（不写 peer-message）
 * 2. 用户消息正常转发
 * 3. 连续 N 条消息不会产生额外 peer-message
 *
 * 不依赖真实 WebSocket 或 Feishu API，纯单元测试。
 */
export {};
//# sourceMappingURL=test-feishu-dedup.d.ts.map