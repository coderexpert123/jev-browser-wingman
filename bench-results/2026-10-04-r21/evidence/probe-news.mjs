import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
const home = '/home/user/jev-browser-wingman/bench/.home';
const env = { ...process.env, WINGMAN_HOME: home, BENCH_GATE_OFF: '1', BENCH_POLICY_OFF: '1' };
const cli = '/home/user/jev-browser-wingman/dist/src/cli/main.js';
const ens = JSON.parse(execFileSync('node', [cli, 'chrome', 'ensure'], { env }).toString().trim().split('\n').pop());
const endpoint = ens.endpoint;
async function navigate(url) {
  const targets = await (await fetch(endpoint + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  await new Promise((resolve) => { ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(); }); ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } })); });
  ws.close();
  await new Promise((r) => setTimeout(r, 6000));
}
const transport = new StdioClientTransport({ command: 'node', args: [cli, 'mcp'], env });
const client = new Client({ name: 'probe', version: '1' });
await client.connect(transport);
for (const [name, url] of [['bbc', 'https://www.bbc.com/news'], ['npr', 'https://www.npr.org']]) {
  await navigate(url);
  const r = await client.callTool({ name: 'browse_step', arguments: { goal: 'Report the page headline.', steps: ['report the page headline'] } });
  const txt = (r.content?.[0]?.text) || '';
  let j = {}; try { j = JSON.parse(txt); } catch {}
  console.log(name, JSON.stringify({ status: j.status, reason: j.reason, steps: j.steps, jev_calls: j.cost?.jev_calls, note: (j.note || '').slice(0, 120) }));
}
await client.close();
execFileSync('node', [cli, 'chrome', 'stop'], { env });
