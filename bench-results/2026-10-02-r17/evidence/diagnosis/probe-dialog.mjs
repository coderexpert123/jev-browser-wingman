import { startFixtureServer } from '/home/user/jev-browser-wingman/dist/src/fixture-server.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const LOG = '/tmp/claude-0/r17/probe-dialog.log';
fs.writeFileSync(LOG, '');
const log = (...a) => fs.appendFileSync(LOG, a.join(' ') + '\n');
const server = await startFixtureServer();
const dir = '/tmp/claude-0/r17/prof-dlg';
fs.mkdirSync(dir, { recursive: true });
const ch = spawn('/usr/bin/chromium', ['--headless=new', '--remote-debugging-port=9557', '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 5000));
const mk = async () => {
  const v = await (await fetch('http://127.0.0.1:9557/json/version')).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0;
  const p = new Map();
  const ev = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } else if (d.method) ev.push(d.method);
  };
  await new Promise((r) => (ws.onopen = r));
  return {
    ev,
    close: () => ws.close(),
    send: (method, params = {}, sessionId, ms = 6000) =>
      new Promise((res) => {
        const i = ++id;
        p.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => {
          if (p.has(i)) { p.delete(i); res({ error: { message: 'TIMEOUT ' + method + ' after ' + ms + 'ms' } }); }
        }, ms);
      }),
  };
};
try {
  const A = await mk();
  const { result: { targetInfos } } = await A.send('Target.getTargets');
  const pg = targetInfos.find((t) => t.type === 'page');
  const { result: { sessionId: sa } } = await A.send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  await A.send('Page.enable', {}, sa);
  await A.send('Page.navigate', { url: server.url + '/dialog.html' }, sa);
  await new Promise((r) => setTimeout(r, 2500));
  await A.send('Runtime.evaluate', { expression: "setTimeout(()=>document.getElementById('prompt').click(),0); 1" }, sa);
  await new Promise((r) => setTimeout(r, 1500));
  log('A events:', JSON.stringify(A.ev.filter((e) => e.startsWith('Page.javascriptDialog'))));
  const B = await mk();
  const ab = await B.send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  log('B attach ->', JSON.stringify(ab.error || 'ok'));
  if (ab.result) {
    const rb = await B.send('Page.handleJavaScriptDialog', { accept: false }, ab.result.sessionId);
    log('B (A still attached) handleJavaScriptDialog ->', JSON.stringify(rb.error || rb.result));
  }
  B.close();
  log('--- round 2: dialog open, A detaches, then C');
  const ra = await A.send('Runtime.evaluate', { expression: "setTimeout(()=>document.getElementById('prompt').click(),0); 1" }, sa);
  log('A re-open ->', JSON.stringify(ra.error || 'ok'));
  await new Promise((r) => setTimeout(r, 1000));
  await A.send('Target.detachFromTarget', { sessionId: sa });
  A.close();
  await new Promise((r) => setTimeout(r, 1500));
  const C = await mk();
  const ac = await C.send('Target.attachToTarget', { targetId: pg.targetId, flatten: true });
  log('C attach ->', JSON.stringify(ac.error || 'ok'));
  if (ac.result) {
    const rc = await C.send('Page.handleJavaScriptDialog', { accept: false }, ac.result.sessionId);
    log('C (A detached) handleJavaScriptDialog ->', JSON.stringify(rc.error || rc.result));
  }
  C.close();
} catch (e) {
  log('ERR', String(e));
}
ch.kill('SIGKILL');
await server.close();
process.exit(0);
