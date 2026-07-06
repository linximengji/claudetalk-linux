/**
 * Channel 注册表
 * 每个 Channel 实现文件末尾调用 registerChannel 完成自注册
 * 新增 Channel 只需在 src/channels/index.ts 中 export 对应文件即可
 */
const channelRegistry = new Map();
/** 注册一个 Channel 实现 */
export function registerChannel(descriptor) {
    channelRegistry.set(descriptor.type, descriptor);
}
/** 根据类型获取 Channel 描述符 */
export function getChannelDescriptor(type) {
    return channelRegistry.get(type);
}
/** 获取所有已注册的 Channel 列表（按注册顺序） */
export function getAllChannelDescriptors() {
    return [...channelRegistry.values()];
}
//# sourceMappingURL=registry.js.map