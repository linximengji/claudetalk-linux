import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMemberStore } from './chat-members.js';
const TEST_DIR = path.join(process.cwd(), '.claudetalk', 'feishu');
const TEST_PATH = path.join(TEST_DIR, 'chat-members-test.json');
function cleanTestFile() {
    if (fs.existsSync(TEST_PATH))
        fs.unlinkSync(TEST_PATH);
    // also clean up the directory if it was created just for the test
    const dir = path.dirname(TEST_PATH);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
    }
}
describe('ChatMemberStore', () => {
    beforeEach(cleanTestFile);
    afterEach(cleanTestFile);
    it('returns empty array for unknown chatId', () => {
        const store = new ChatMemberStore(TEST_PATH);
        assert.deepStrictEqual(store.getMembers('oc_nonexistent'), []);
    });
    it('adds and retrieves members', () => {
        const store = new ChatMemberStore(TEST_PATH);
        store.updateMembers('oc_chat1', () => [
            { name: 'Alice', type: 'user', openId: 'ou_alice', unionId: 'on_alice' },
        ]);
        store.updateMembers('oc_chat1', (members) => [
            ...members,
            { name: 'Bob', type: 'user', openId: 'ou_bob' },
        ]);
        const members = store.getMembers('oc_chat1');
        assert.strictEqual(members.length, 2);
        assert.strictEqual(members[0].name, 'Alice');
        assert.strictEqual(members[1].name, 'Bob');
    });
    it('persists to disk and can be reloaded', () => {
        const store1 = new ChatMemberStore(TEST_PATH);
        store1.updateMembers('oc_chat1', () => [
            { name: 'Alice', type: 'user', openId: 'ou_alice' },
        ]);
        const store2 = new ChatMemberStore(TEST_PATH);
        const reloaded = store2.getMembers('oc_chat1');
        assert.strictEqual(reloaded.length, 1);
        assert.strictEqual(reloaded[0].name, 'Alice');
    });
    it('updateMembers can remove members', () => {
        const store = new ChatMemberStore(TEST_PATH);
        store.updateMembers('oc_chat1', () => [
            { name: 'Alice', type: 'user' },
            { name: 'Bob', type: 'user' },
        ]);
        store.updateMembers('oc_chat1', () => [
            { name: 'Alice', type: 'user' },
        ]);
        const members = store.getMembers('oc_chat1');
        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].name, 'Alice');
    });
    it('handles corrupt JSON gracefully', () => {
        const dir = path.dirname(TEST_PATH);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(TEST_PATH, 'not json', 'utf-8');
        const store = new ChatMemberStore(TEST_PATH);
        assert.deepStrictEqual(store.getMembers('oc_any'), []);
    });
    it('getAll returns a shallow clone of the full config', () => {
        const store = new ChatMemberStore(TEST_PATH);
        store.updateMembers('oc_chat1', () => [
            { name: 'Alice', type: 'user' },
        ]);
        store.updateMembers('oc_chat2', () => [
            { name: 'BotX', type: 'bot', appId: 'cli_xxx' },
        ]);
        const all = store.getAll();
        assert.strictEqual(Object.keys(all).length, 2);
        assert.ok(all['oc_chat1']);
        assert.ok(all['oc_chat2']);
        // mutating the returned object shouldn't affect store
        all['oc_chat3'] = [];
        assert.deepStrictEqual(store.getMembers('oc_chat3'), []);
    });
});
//# sourceMappingURL=chat-members.test.js.map