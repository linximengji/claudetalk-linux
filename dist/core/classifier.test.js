import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { classifyConversation } from './classifier.js';
function mockFetch(response) {
    globalThis.fetch = (() => response);
}
function mockFetchAlwaysFails() {
    globalThis.fetch = () => Promise.reject(new Error('network error'));
}
function restoreFetch() {
    delete globalThis.fetch;
}
/** Helper: makes an LLM-type fetch response. The classifier POSTs and reads choices[0].message.content. */
function llmResponse(content) {
    return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ message: { content } }],
        }),
    });
}
function httpErrorResponse(status) {
    return Promise.resolve({
        ok: false,
        status,
    });
}
describe('classifier', () => {
    afterEach(restoreFetch);
    describe('local rules — pending keywords', () => {
        it('classifies "加待办" as task-pending', async () => {
            const result = await classifyConversation('把这个加到待办里去', '好的', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "加入手机" as task-pending', async () => {
            const result = await classifyConversation('加入手机待办', '好的', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "终端修改" as task-pending', async () => {
            const result = await classifyConversation('需要终端修改配置', '好的', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "留到终端" as task-pending', async () => {
            const result = await classifyConversation('这个留到终端处理', '好的', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "终端部署" as task-pending', async () => {
            const result = await classifyConversation('需要终端部署一下', '好的', []);
            assert.strictEqual(result, 'task-pending');
        });
    });
    describe('local rules — completed keywords', () => {
        it('classifies reply starting "已完成" as completed', async () => {
            const result = await classifyConversation('修一下这个bug', '已完成修复，修改了 config.ts', ['Edit']);
            assert.strictEqual(result, 'completed');
        });
        it('classifies reply starting "已修复" as completed', async () => {
            const result = await classifyConversation('报错了', '已修复该问题', ['Edit']);
            assert.strictEqual(result, 'completed');
        });
        it('classifies reply starting "已修改" as completed', async () => {
            const result = await classifyConversation('改一下配置', '已修改配置', ['Edit']);
            assert.strictEqual(result, 'completed');
        });
        it('classifies reply "修好了" as completed', async () => {
            const result = await classifyConversation('修一下', '修好了', []);
            assert.strictEqual(result, 'completed');
        });
    });
    describe('local rules — high risk commands', () => {
        it('classifies "rm -rf /" as task-pending', async () => {
            const result = await classifyConversation('运行 rm -rf /some/dir', '', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "drop table" as task-pending', async () => {
            const result = await classifyConversation('执行 drop table users', '', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('classifies "清空所有日志" as task-pending', async () => {
            const result = await classifyConversation('清空所有日志文件', '', []);
            assert.strictEqual(result, 'task-pending');
        });
    });
    describe('LLM classification', () => {
        it('returns completed when LLM says completed', async () => {
            mockFetch(llmResponse('completed'));
            const result = await classifyConversation('帮我写个脚本', '脚本已经写好了', ['Write']);
            assert.strictEqual(result, 'completed');
        });
        it('returns task-pending when LLM says task-pending', async () => {
            mockFetch(llmResponse('task-pending'));
            const result = await classifyConversation('分析一下这个', '需要后续处理', ['Grep']);
            assert.strictEqual(result, 'task-pending');
        });
        it('returns reference when LLM says reference', async () => {
            mockFetch(llmResponse('reference'));
            const result = await classifyConversation('随便聊聊', '今天天气不错', []);
            assert.strictEqual(result, 'reference');
        });
        it('returns reference when LLM returns unknown text', async () => {
            mockFetch(llmResponse('unknown_category'));
            const result = await classifyConversation('测试一下', '好的', []);
            assert.strictEqual(result, 'reference');
        });
        it('returns reference when LLM returns empty', async () => {
            mockFetch(llmResponse(''));
            const result = await classifyConversation('测试一下', '好的', []);
            assert.strictEqual(result, 'reference');
        });
    });
    describe('fallback when LLM fails', () => {
        it('falls back to completed when tool count > 2', async () => {
            mockFetchAlwaysFails();
            const result = await classifyConversation('做个复杂任务', '好的', ['Write', 'Edit', 'Bash']);
            assert.strictEqual(result, 'completed');
        });
        it('falls back to task-pending when reply hints at pending work', async () => {
            mockFetchAlwaysFails();
            const result = await classifyConversation('做个任务', '需要本地环境来配置', []);
            assert.strictEqual(result, 'task-pending');
        });
        it('falls back to reference otherwise', async () => {
            mockFetchAlwaysFails();
            const result = await classifyConversation('随便问问', '答案是42', []);
            assert.strictEqual(result, 'reference');
        });
    });
    describe('LLM retry on HTTP error', () => {
        it('retries once on 404 then falls back', async () => {
            let callCount = 0;
            globalThis.fetch = () => {
                callCount++;
                if (callCount <= 2)
                    return httpErrorResponse(404);
                return llmResponse('reference');
            };
            const result = await classifyConversation('测试重试', '好的', []);
            assert.strictEqual(callCount, 2);
            assert.strictEqual(result, 'reference');
        });
    });
});
//# sourceMappingURL=classifier.test.js.map