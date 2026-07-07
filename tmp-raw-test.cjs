const WebSocket = require('ws');
const http = require('http');

async function main() {
  const { loadFeishuConfig } = require('./dist/feishu-shared/config.js');
  const cfg = loadFeishuConfig();
  const { appId, appSecret } = cfg;

  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenData = await tokenRes.json();
  console.error('Token obtained:', tokenData.tenant_access_token?.substring(0, 15));

  const wsCfgRes = await fetch('https://open.feishu.cn/open-apis/callback/ws/endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'locale': 'zh', 'User-Agent': 'node-sdk/v3.3.2' },
    body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
  });
  const wsCfg = await wsCfgRes.json();
  console.error('WS config response:', JSON.stringify(wsCfg).substring(0, 200));

  if (wsCfg.code !== 0) {
    console.error('Failed:', wsCfg.msg);
    return;
  }

  const wsUrl = wsCfg.data.URL;
  console.error('Connecting to:', wsUrl);

  let frameCount = 0, controlFrames = 0, dataFrames = 0;

  const socket = new WebSocket(wsUrl);
  socket.on('open', () => console.error('=== WS OPEN ==='));
  socket.on('message', (buffer) => {
    frameCount++;
    const method = buffer[0] & 0x7f;
    if (method === 0) controlFrames++;
    else dataFrames++;
    console.error(`[FRAME] #${frameCount} len=${buffer.length} method=${method}`);
  });
  socket.on('close', (code, reason) => console.error(`=== WS CLOSED: ${code} ${reason} ===`));
  socket.on('error', (e) => console.error(`=== WS ERROR: ${e.message} ===`));

  setInterval(() => {
    console.error(`[10s] frames=${frameCount} control=${controlFrames} data=${dataFrames} state=${socket.readyState}`);
  }, 10000);

  await new Promise(r => setTimeout(r, 60000));
  socket.close();
  console.error(`=== FINAL: ${frameCount} frames (${controlFrames} control, ${dataFrames} data) ===`);
}

main().catch(e => console.error('Fatal:', e));
