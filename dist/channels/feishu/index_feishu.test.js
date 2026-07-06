import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FeishuClient } from './index_feishu.js';
function createMinimalClient() {
    return new FeishuClient({
        appId: 'test_app_id',
        appSecret: 'test_app_secret',
        profileName: 'test',
    });
}
describe('FeishuClient.stop()', () => {
    it('clears peerPollTimer if set', () => {
        const client = createMinimalClient();
        const timer = setTimeout(() => { }, 100000);
        client.peerPollTimer = timer;
        client.stop();
        assert.strictEqual(client.peerPollTimer, null);
    });
    it('clears _dedupCleanupTimer if set', () => {
        const client = createMinimalClient();
        const timer = setTimeout(() => { }, 100000);
        client._dedupCleanupTimer = timer;
        client.stop();
        assert.strictEqual(client._dedupCleanupTimer, null);
    });
    it('clears _botInfoRetryTimer if set', () => {
        const client = createMinimalClient();
        const timer = setTimeout(() => { }, 100000);
        client._botInfoRetryTimer = timer;
        client.stop();
        assert.strictEqual(client._botInfoRetryTimer, null);
    });
    it('is no-op when no resources exist', () => {
        const client = createMinimalClient();
        // should not throw
        client.stop();
    });
    it('is idempotent — calling twice is safe', () => {
        const client = createMinimalClient();
        client.peerPollTimer = setTimeout(() => { }, 100000);
        client._dedupCleanupTimer = setTimeout(() => { }, 100000);
        client._botInfoRetryTimer = setTimeout(() => { }, 100000);
        client.stop();
        client.stop();
        assert.strictEqual(client.peerPollTimer, null);
        assert.strictEqual(client._dedupCleanupTimer, null);
        assert.strictEqual(client._botInfoRetryTimer, null);
    });
    it('clears all three timers in one call', () => {
        const client = createMinimalClient();
        const timer1 = setTimeout(() => { }, 100000);
        const timer2 = setTimeout(() => { }, 100000);
        const timer3 = setTimeout(() => { }, 100000);
        client.peerPollTimer = timer1;
        client._dedupCleanupTimer = timer2;
        client._botInfoRetryTimer = timer3;
        client.stop();
        assert.strictEqual(client.peerPollTimer, null);
        assert.strictEqual(client._dedupCleanupTimer, null);
        assert.strictEqual(client._botInfoRetryTimer, null);
    });
});
// ========== Dedup cleanup timer tests ==========
/** Creates a client, mocks internal methods so start() reaches the setInterval line, and
 *  captures all (callback, interval) pairs from setInterval calls during start(). */
function setupDedupTimerCapture() {
    const client = createMinimalClient();
    client.syncTemplateFile = () => { };
    client.initializeBotInfo = () => Promise.resolve();
    client.startPeerMessagePolling = () => { };
    const captured = [];
    let fakeHandleCounter = 5000;
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((cb, ms) => {
        const handle = fakeHandleCounter++;
        captured.push({ cb, interval: ms ?? 0, handle });
        return handle;
    });
    const originalClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = (() => { });
    return {
        client,
        captured,
        cleanup: () => {
            globalThis.setInterval = origSetInterval;
            globalThis.clearInterval = originalClearInterval;
        },
    };
}
describe('FeishuClient dedup cleanup timer', () => {
    // ---- Happy path ----
    it('creates _dedupCleanupTimer in start() with 1-hour interval', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined, 'dedup timer should be created');
            assert.strictEqual(client._dedupCleanupTimer, dedup.handle);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback removes entries older than DEDUP_TTL_MS', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('old1', now - TTL - 1000);
            client.processedEventIds.set('old2', now - TTL - 10000);
            client.processedEventIds.set('old3', now - TTL * 2);
            client.processedEventIds.set('fresh1', now - 1000);
            client.processedEventIds.set('fresh2', now);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 2);
            assert.strictEqual(client.processedEventIds.has('old1'), false);
            assert.strictEqual(client.processedEventIds.has('old2'), false);
            assert.strictEqual(client.processedEventIds.has('old3'), false);
            assert.strictEqual(client.processedEventIds.has('fresh1'), true);
            assert.strictEqual(client.processedEventIds.has('fresh2'), true);
        }
        finally {
            cleanup();
        }
    });
    // ---- Boundary values ----
    it('cleanup callback handles empty Map without throwing', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            assert.strictEqual(client.processedEventIds.size, 0);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 0);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback preserves entries exactly at TTL boundary (uses > not >=)', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('exact', now - TTL);
            dedup.cb();
            // exactly TTL → NOT removed (condition is now - ts > TTL, strict >)
            assert.strictEqual(client.processedEventIds.size, 1);
            assert.strictEqual(client.processedEventIds.has('exact'), true);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback preserves entries exactly 1ms before TTL', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('nearly', now - TTL + 1);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 1);
            assert.strictEqual(client.processedEventIds.has('nearly'), true);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback removes entries exactly 1ms past TTL', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('justOver', now - TTL - 1);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 0);
            assert.strictEqual(client.processedEventIds.has('justOver'), false);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback removes all entries when all expired', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('a', now - TTL - 1);
            client.processedEventIds.set('b', now - TTL - 100000);
            client.processedEventIds.set('c', now - TTL * 3);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 0);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback preserves all entries when none expired', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const now = Date.now();
            client.processedEventIds.set('recent1', now);
            client.processedEventIds.set('recent2', now - 1000);
            client.processedEventIds.set('recent3', now - 60_000);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 3);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback preserves large Map without performance degradation', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            const map = client.processedEventIds;
            // 500 entries: 400 expired, 100 fresh
            for (let i = 0; i < 400; i++) {
                map.set(`expired_${i}`, now - TTL - 1000 - i);
            }
            for (let i = 0; i < 100; i++) {
                map.set(`fresh_${i}`, now - i);
            }
            const startTime = performance.now();
            dedup.cb();
            const elapsed = performance.now() - startTime;
            assert.strictEqual(map.size, 100);
            // 500 entries, Map iteration is sub-millisecond even in Node test
            assert.ok(elapsed < 50, `cleanup took ${elapsed}ms, expected < 50ms`);
        }
        finally {
            cleanup();
        }
    });
    // ---- Async / re-entrancy ----
    it('start() creates dedup timer in peer-message mode', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedupTimers = captured.filter(c => c.interval === 3600_000);
            assert.strictEqual(dedupTimers.length, 1, 'dedup timer should be created');
            assert.notStrictEqual(dedupTimers[0], undefined);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback is idempotent — calling twice on stale Map is safe', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const TTL = client.DEDUP_TTL_MS;
            const now = Date.now();
            client.processedEventIds.set('old', now - TTL - 1);
            client.processedEventIds.set('fresh', now);
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 1);
            // second call on already-cleaned Map is a no-op
            dedup.cb();
            assert.strictEqual(client.processedEventIds.size, 1);
            assert.strictEqual(client.processedEventIds.has('fresh'), true);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback handles timestamp as 0 (epoch) correctly', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            client.processedEventIds.set('epoch', 0);
            dedup.cb();
            // epoch is way past TTL, should be removed
            assert.strictEqual(client.processedEventIds.size, 0);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback handles timestamp in the far future', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
            client.processedEventIds.set('future', farFuture);
            dedup.cb();
            // future timestamp → NOT removed (now - future < 0, not > TTL)
            assert.strictEqual(client.processedEventIds.size, 1);
            assert.strictEqual(client.processedEventIds.has('future'), true);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback handles negative timestamp gracefully', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const dedup = captured.find(c => c.interval === 3600_000);
            assert.notStrictEqual(dedup, undefined);
            client.processedEventIds.set('negative', -1);
            dedup.cb();
            // negative timestamp is way past TTL (now - (-1) = now + 1 > TTL), should be removed
            assert.strictEqual(client.processedEventIds.size, 0);
        }
        finally {
            cleanup();
        }
    });
    it('cleanup callback preserves DEDUP_TTL_MS constant at 24 hours', async () => {
        const { client, captured, cleanup } = setupDedupTimerCapture();
        try {
            await client.start();
            const TTL = client.DEDUP_TTL_MS;
            assert.strictEqual(TTL, 24 * 60 * 60 * 1000);
        }
        finally {
            cleanup();
        }
    });
});
//# sourceMappingURL=index_feishu.test.js.map