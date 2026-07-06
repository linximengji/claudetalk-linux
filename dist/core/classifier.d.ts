export type TaskCategory = 'reference' | 'task-pending' | 'completed';
export declare function classifyConversation(message: string, reply: string, toolNames: string[]): Promise<TaskCategory>;
//# sourceMappingURL=classifier.d.ts.map