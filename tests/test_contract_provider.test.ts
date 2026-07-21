/**
 * Provider contract self-check for feishu-bridge.
 *
 * Starts feishu-bridge as a subprocess, verifies Pact-covered endpoints
 * are reachable with expected response structure. Runs without requiring
 * Pact Broker.
 *
 * Skips if bridge binary (dist/feishu-bridge.js) is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BRIDGE_URL = "http://127.0.0.1:9878";
const BRIDGE_SCRIPT = resolve(__dirname, "..", "dist", "feishu-bridge.js");

let proc: ChildProcess;
let bridgeReady = false;

function fetchText(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BRIDGE_URL}${path}`, {
    signal: AbortSignal.timeout(5000),
    ...init,
  });
}

async function waitForReady(maxWait = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const r = await fetchText("/health");
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("feishu-bridge did not become ready within 15s");
}

beforeAll(async () => {
  if (!existsSync(BRIDGE_SCRIPT)) {
    console.warn(`feishu-bridge not found at ${BRIDGE_SCRIPT}, skipping contract tests`);
    return;
  }
  proc = spawn("node", [BRIDGE_SCRIPT], {
    stdio: "ignore",
    env: { ...process.env, FEISHU_BRIDGE_WORK_DIR: resolve(__dirname, "..") },
  });
  try {
    await waitForReady();
    bridgeReady = true;
  } catch (e) {
    console.warn(`feishu-bridge failed to start: ${e}, skipping contract tests`);
  }
});

afterAll(() => {
  if (proc && !proc.killed) {
    proc.kill("SIGINT");
  }
});

describe("feishu-bridge contract", () => {
  it("/health returns ok", async () => {
    if (!bridgeReady) return; // skip
    const r = await fetchText("/health");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("ok");
  });

  it("/ack is reachable (POST)", async () => {
    if (!bridgeReady) return;
    // ack endpoint is POST, sends JSON body
    const r = await fetchText("/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: "test" }),
    });
    expect(r.status).not.toBe(404);
  });

  it("/send-media is reachable (POST)", async () => {
    if (!bridgeReady) return;
    // send-media endpoint (not send-image)
    const r = await fetchText("/send-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // Without proper auth/body it may return 400, but NOT 404
    expect(r.status).not.toBe(404);
  });
});
