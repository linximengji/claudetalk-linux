/**
 * Channel 清单 - 唯一需要修改的文件
 * 新增 Channel 时，只需在此处添加一行 export，其余文件无需改动
 */
export * from './dingtalk/index_dingtalk.js';
export * from './feishu/index_feishu.js';
export { getChannelDescriptor, getAllChannelDescriptors } from './registry.js';
export type { ChannelDescriptor, ChannelConfigField } from './registry.js';
//# sourceMappingURL=index.d.ts.map