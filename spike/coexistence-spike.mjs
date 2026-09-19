#!/usr/bin/env node
// Coexistence spike (WP-A1): proves a second CDP client acting on Playwright
// MCP's page does not break Playwright MCP. Standalone script, own minimal
// act code; the production adapters (D1/D2) come later.
//
// node spike/coexistence-spike.mjs --adapter playwright|cdp [--known-bad <id>] [--port 9333] [--out <file>]
// node spike/coexistence-spike.mjs --window-probe [--port 9333]

import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function hasFlag(name) {
  return argv.includes(name);
}

// ---------------------------------------------------------------------------
// quoteCmdLine (§3.15; written inline because D0 does not exist yet)
// ---------------------------------------------------------------------------

function quoteCmdLine(argvList) {
  return argvList
    .map((t) => {
      if (/^[A-Za-z0-9_\-.\/:=@+,{}]+$/.test(t)) return t;
      return '"' + t.replace(/"/g, '""') + '"';
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// findChrome (inline; win32 candidates only, per item 2)
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'];
    const pfx86 = process.env['PROGRAMFILES(X86)'];
    const lad = process.env['LOCALAPPDATA'];
    if (pf) candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (pfx86) candidates.push(path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (lad) candidates.push(path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome launch / teardown helpers
// ---------------------------------------------------------------------------

const HEADED_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];
const OFFSCREEN_ARGS = ['--window-position=-32000,-32000'];

function launchChrome({ port, profileDir, mode }) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('no-chrome: Chrome not found on this machine');
  let modeArgs;
  if (mode === 'offscreen') modeArgs = [...HEADED_ARGS, ...OFFSCREEN_ARGS];
  else if (mode === 'normal') modeArgs = [...HEADED_ARGS];
  else if (mode === 'minimized') modeArgs = [...HEADED_ARGS];
  else if (mode === 'headless') modeArgs = ['--headless=new'];
  else modeArgs = [];

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...modeArgs,
    'about:blank',
  ];

  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const inner = 'start "" /min ' + quoteCmdLine([chromePath, ...args]);
    const child = spawn(comspec, ['/d', '/s', '/c', `"${inner}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return child;
  }
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForVersion(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return r.json();
    } catch {
      // keep polling
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

async function waitForPortDown(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!r.ok) return true;
    } catch {
      return true;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

function findSocketOwnerPid(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
    const re = new RegExp(`[:.]${port}\\s`);
    for (const line of out.split('\n')) {
      if (line.includes('LISTENING') && re.test(line)) {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid)) return pid;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid);
      } catch {
        // ignore
      }
      try {
        process.kill(pid);
      } catch {
        // ignore
      }
    }
  } catch {
    // already gone
  }
}

// Windows can hold a brief file-handle lock on a Chrome profile dir right
// after the owning process tree is killed; retry rather than crash the
// whole spike (and lose the JSON verdict) over a removal race.
async function removeDirWithRetry(dir, notes) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === 4) {
        if (notes) notes.push(`profile cleanup: ${e.message || e}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ---------------------------------------------------------------------------
// Raw CDP helper (browser-level connection; used by the observer and the CDP actor)
// ---------------------------------------------------------------------------

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('cdp websocket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(ev));
  }
  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      const cbs = this.listeners.get(msg.method) || [];
      for (const cb of cbs) cb(msg.params, msg.sessionId);
    }
  }
  send(method, params = {}, sessionId, timeoutMs = 8000) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, cb) {
    const arr = this.listeners.get(method) || [];
    arr.push(cb);
    this.listeners.set(method, arr);
  }
  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function connectObserver(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function getContexts(cdp) {
  const r = await cdp.send('Target.getBrowserContexts');
  return [...(r.browserContextIds ?? [])].sort();
}
async function getPageTargets(cdp) {
  const r = await cdp.send('Target.getTargets');
  return (r.targetInfos ?? []).filter((t) => t.type === 'page');
}

// Reads document.visibilityState for one page target through a short-lived
// CDP attach, independent of either actor's own bookkeeping (used by P8,
// which needs per-page visibility that the Driver-shaped actor abstraction
// does not expose).
async function pageVisibility(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    const worldName = 'wingman-spike-vis-' + Math.random().toString(16).slice(2);
    const { executionContextId } = await cdp.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName },
      sessionId,
    );
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression: 'document.visibilityState', contextId: executionContextId, returnByValue: true },
      sessionId,
    );
    return result.value;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// Playwright MCP client helpers
// ---------------------------------------------------------------------------

async function startMcp(port) {
  const isWin = process.platform === 'win32';
  const transport = new StdioClientTransport({
    command: isWin ? process.env.ComSpec || 'cmd.exe' : 'npx',
    args: isWin
      ? ['/d', '/s', '/c', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']
      : ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
    env: { ...process.env, PLAYWRIGHT_MCP_CDP_ENDPOINT: `http://127.0.0.1:${port}` },
    cwd: P,
  });
  const client = new Client({ name: 'coexistence-spike', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

async function mcpCall(client, name, args) {
  // A known-bad injection (e.g. closing the acted-upon page) can leave an MCP
  // tool call stuck against a stale page target. Bound every call so that
  // shows up as a failed check instead of hanging the whole spike.
  try {
    return await client.callTool({ name, arguments: args }, undefined, { timeout: 8000 });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `mcpCall timeout/error: ${e.message || e}` }] };
  }
}
function mcpText(result) {
  return result?.content?.[0]?.text ?? '';
}
async function mcpNavigate(client, url) {
  return mcpCall(client, 'browser_navigate', { url });
}
async function mcpSnapshot(client) {
  return mcpCall(client, 'browser_snapshot', {});
}
function findRef(snapshotText, name) {
  const lines = snapshotText.split('\n');
  const line = lines.find((l) => l.includes(`"${name}"`));
  if (!line) return null;
  // browser_click takes {element, target}; refs match (?:f\d+)?e\d+ (spec §4 WP-A1 item 3, amended).
  const m = line.match(/\[ref=((?:f\d+)?e\d+)\]/);
  return m ? m[1] : null;
}
async function mcpClickByName(client, name) {
  const snap = await mcpSnapshot(client);
  const text = mcpText(snap);
  const ref = findRef(text, name);
  if (!ref) throw new Error(`ref not found for "${name}"`);
  return mcpCall(client, 'browser_click', { element: name, target: ref });
}
async function mcpEvaluate(client, fn) {
  const result = await mcpCall(client, 'browser_evaluate', { function: fn });
  const text = mcpText(result);
  const m = text.match(/### Result\n([\s\S]*?)(?:\n### |$)/);
  const jsonText = m ? m[1] : text.replace(/^### Result\n/, '').trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
}
async function mcpRunCodeUnsafe(client, code) {
  const result = await mcpCall(client, 'browser_run_code_unsafe', { code });
  const text = mcpText(result);
  const m = text.match(/### Result\n([\s\S]*?)(?:\n### |$)/);
  const jsonText = m ? m[1] : text.trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return jsonText;
  }
}
async function mcpTabsList(client) {
  const result = await mcpCall(client, 'browser_tabs', { action: 'list' });
  const text = mcpText(result);
  const lines = text.split('\n').filter((l) => /^- \d+:/.test(l));
  return lines.map((l) => {
    const m = l.match(/^- (\d+): (\(current\) )?\[(.*?)\]\((.*)\)$/);
    return m ? { index: Number(m[1]), title: m[3], url: m[4] } : { raw: l };
  });
}
function tabsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.url === b[i].url);
}
async function globalsHash(client) {
  const list = await mcpEvaluate(client, '() => Object.getOwnPropertyNames(globalThis).sort()');
  return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
}
async function viewportRecord(client) {
  return mcpEvaluate(
    client,
    "() => ({innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, hasFocus: document.hasFocus(), visibility: document.visibilityState})",
  );
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A known-bad injection (closing the acted-upon page) can leave a Playwright
// or raw-CDP call waiting on a target that will never answer. Every actor
// operation below is bounded so the spike always reaches its final verdict
// instead of hanging past the process timeout with no JSON printed.
function withTimeout(promise, ms) {
  const guarded = Promise.resolve(promise).catch(() => {});
  return Promise.race([guarded, new Promise((resolve) => setTimeout(resolve, ms))]);
}

// ---------------------------------------------------------------------------
// "Our" client — playwright adapter (item 3)
// ---------------------------------------------------------------------------

async function makePlaywrightActor(port, knownBadId) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const ctx = browser.contexts()[0];
  // Passive dialog listener: registering one stops Playwright's own auto-dismiss.
  ctx.on('dialog', () => {});
  if (knownBadId === 'auto-dismiss-dialog') {
    ctx.on('dialog', (d) => {
      d.accept().catch(() => {});
    });
  }
  if (knownBadId === 'new-context') {
    // Playwright's own browser.close() disposes contexts IT created via
    // newContext(), which would make this known-bad clean up after itself
    // and never discriminate P6. Create the context through a raw CDP
    // command instead, on a session outside Playwright's own bookkeeping,
    // so it genuinely survives detach (the residue this check targets).
    const rawSession = await browser.newBrowserCDPSession();
    await rawSession.send('Target.createBrowserContext');
    await rawSession.detach().catch(() => {});
  }
  let page = ctx.pages()[0];
  if (!page) page = await ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  if (!page) throw new Error('no page to attach to (closed by a prior known-bad detach?)');
  if (knownBadId === 'set-viewport') {
    const cdpSession = await ctx.newCDPSession(page);
    await cdpSession.send('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  if (knownBadId === 'inject-global') {
    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      globalThis.__wingman_probe = 1;
    });
  }
  return {
    name: 'playwright',
    async pages() {
      return ctx.pages().map((p) => ({ url: p.url() }));
    },
    async count(selector) {
      return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
    },
    async click(selector) {
      const p = page.locator(selector).click({ timeout: 5000 });
      p.catch(() => {});
      await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
    },
    async fill(selector, value) {
      const p = page.locator(selector).fill(value, { timeout: 5000 });
      p.catch(() => {});
      await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
    },
    async cookieVisible(name) {
      const cookies = await ctx.cookies();
      return cookies.some((c) => c.name === name);
    },
    async detach() {
      if (knownBadId === 'close-page-on-detach') {
        await withTimeout(page.close(), 3000);
      }
      await withTimeout(browser.close(), 5000);
    },
  };
}

// ---------------------------------------------------------------------------
// "Our" client — raw CDP adapter (item 3)
// ---------------------------------------------------------------------------

async function makeCdpActor(port, knownBadId) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserCdp = new CDP(ver.webSocketDebuggerUrl);
  await browserCdp.connect();
  const targets = await getPageTargets(browserCdp);
  const targetId = targets[0].targetId;
  const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: true });
  await browserCdp.send('Page.enable', {}, sessionId);
  await browserCdp.send('Runtime.enable', {}, sessionId);

  if (knownBadId === 'new-context') {
    await browserCdp.send('Target.createBrowserContext');
  }
  if (knownBadId === 'set-viewport') {
    await browserCdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  }
  if (knownBadId === 'inject-global') {
    await browserCdp.send('Runtime.evaluate', { expression: 'globalThis.__wingman_probe = 1;' }, sessionId);
  }
  if (knownBadId === 'auto-dismiss-dialog') {
    browserCdp.on('Page.javascriptDialogOpening', () => {
      browserCdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
    });
  }

  async function isolatedContextId() {
    const { frameTree } = await browserCdp.send('Page.getFrameTree', {}, sessionId);
    const worldName = 'wingman-spike-world-' + Math.random().toString(16).slice(2);
    const { executionContextId } = await browserCdp.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName },
      sessionId,
    );
    return executionContextId;
  }

  async function elementCenter(selector) {
    const ctxId = await isolatedContextId();
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;
    const { result } = await browserCdp.send(
      'Runtime.evaluate',
      { expression: expr, contextId: ctxId, returnByValue: true },
      sessionId,
    );
    return result.value;
  }

  async function clickAt(x, y) {
    const clickPromise = (async () => {
      await browserCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await browserCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    })();
    clickPromise.catch(() => {});
    const dialogPromise = new Promise((resolve) => {
      browserCdp.on('Page.javascriptDialogOpening', () => resolve('dialog'));
    });
    await Promise.race([clickPromise, dialogPromise, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  }

  return {
    name: 'cdp',
    async pages() {
      return getPageTargets(browserCdp).then((ts) => ts.map((t) => ({ url: t.url })));
    },
    async count(selector) {
      const ctxId = await isolatedContextId();
      const expr = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
      const { result } = await browserCdp.send(
        'Runtime.evaluate',
        { expression: expr, contextId: ctxId, returnByValue: true },
        sessionId,
      );
      return result.value;
    },
    async click(selector) {
      const c = await elementCenter(selector);
      if (!c) return;
      await clickAt(c.x, c.y);
    },
    async fill(selector, value) {
      const c = await elementCenter(selector);
      if (!c) return;
      await clickAt(c.x, c.y);
      await browserCdp.send('Input.insertText', { text: value }, sessionId).catch(() => {});
    },
    async cookieVisible(name) {
      const { cookies } = await browserCdp.send('Network.getCookies', {}, sessionId).catch(() => ({ cookies: [] }));
      return (cookies ?? []).some((c) => c.name === name);
    },
    async detach() {
      if (knownBadId === 'close-page-on-detach') {
        await withTimeout(browserCdp.send('Target.closeTarget', { targetId }), 3000);
      }
      await withTimeout(browserCdp.send('Target.detachFromTarget', { sessionId }), 3000);
      browserCdp.close();
    },
  };
}

async function makeActor(adapter, port, knownBadId) {
  return adapter === 'playwright' ? makePlaywrightActor(port, knownBadId) : makeCdpActor(port, knownBadId);
}

// ---------------------------------------------------------------------------
// Main coexistence run (items 1-9)
// ---------------------------------------------------------------------------

async function runSpike({ adapter, knownBad, port }) {
  const profileDir = path.join(P, 'spike', '.tmp', `profile-${adapter}`);
  const notes = [];
  // Same Windows post-kill file-handle race removeDirWithRetry exists for
  // (end-of-run cleanup, below): a prior run's Chrome process tree can still
  // hold a brief lock on this profile dir when the next run starts, since the
  // required run order reuses one profile dir across a plain run and five
  // known-bad runs for the same adapter. A bare fs.rmSync here throws EBUSY
  // and crashes before the try block starts, skipping cleanup entirely.
  await removeDirWithRetry(profileDir, notes);
  fs.mkdirSync(profileDir, { recursive: true });

  const { startFixtureServer } = await import('../dist/src/fixture-server.js');

  let fixture = null;
  let mcpClient = null;
  let observer = null;
  let actor = null;
  let chromeSpawnPid = null;
  let phaseR = 'FAIL';
  let verdict = null;
  const checks = { P1: false, P2: false, P3: false, P4: false, P5: false, P6: false, P7: false, P8: false };

  async function cleanupChrome() {
    const ownerPid = findSocketOwnerPid(port);
    if (ownerPid) killTree(ownerPid);
    if (chromeSpawnPid) killTree(chromeSpawnPid);
    await waitForPortDown(port, 10000);
  }

  async function cleanupAll() {
    try {
      if (actor) await actor.detach();
    } catch {
      // ignore
    }
    try {
      if (mcpClient) await mcpClient.close();
    } catch {
      // ignore
    }
    try {
      if (observer) observer.close();
    } catch {
      // ignore
    }
    try {
      if (fixture) await fixture.close();
    } catch {
      // ignore
    }
    await cleanupChrome();
    await removeDirWithRetry(profileDir, notes);
  }

  try {
    const spawned = launchChrome({ port, profileDir, mode: 'offscreen' });
    chromeSpawnPid = spawned.pid;
    const ver = await waitForVersion(port, 10000);
    if (!ver) throw new Error('chrome did not answer /json/version in time');

    fixture = await startFixtureServer();
    mcpClient = await startMcp(port);

    // ---- Phase R (read-only) ----
    let R0 = null;
    let R0attrs = null;
    try {
      await mcpNavigate(mcpClient, `${fixture.url}/residue.html`);
      R0 = await globalsHash(mcpClient);
      R0attrs = await mcpEvaluate(mcpClient, '() => document.documentElement.attributes.length');

      await mcpNavigate(mcpClient, `${fixture.url}/form.html`);
      actor = await makeActor(adapter, port, null);
      await actor.pages();
      await actor.count('button');
      await actor.detach();
      actor = null;

      const snap = await mcpSnapshot(mcpClient);
      if (snap.isError) throw new Error('MCP browser_snapshot failed in phase R');
      const contRef = findRef(mcpText(snap), 'Continue');
      if (!contRef) throw new Error('Continue ref not found in phase R snapshot');
      const clickResult = await mcpCall(mcpClient, 'browser_click', { element: 'Continue', target: contRef });
      if (clickResult.isError) throw new Error('MCP click on Continue failed in phase R');

      phaseR = 'PASS';
    } catch (e) {
      phaseR = 'FAIL';
      verdict = 'FAIL-ATTACH';
      notes.push(`phase R: ${e.message || e}`);
    }

    if (verdict !== 'FAIL-ATTACH') {
      // ---- Phase A ----
      // (a)
      await mcpNavigate(mcpClient, `${fixture.url}/form.html`);
      const G0 = await globalsHash(mcpClient);
      const V0 = await viewportRecord(mcpClient);
      observer = await connectObserver(port);
      const C0 = await getContexts(observer);
      const T0raw = await getPageTargets(observer);
      const T0 = T0raw.map((t) => t.targetId).sort();
      const formTargetInfo = T0raw.find((t) => t.url.includes('/form.html')) ?? T0raw[0];
      const L0 = await mcpTabsList(mcpClient);

      // (b)
      actor = await makeActor(adapter, port, knownBad);
      checks.P1 = true;

      // (c)
      await actor.click('#continue');
      await actor.fill('#fullname', 'Ada Lovelace');

      // (d)
      const V1 = await viewportRecord(mcpClient);
      let p2 = true;
      try {
        const snapAfter = await mcpSnapshot(mcpClient);
        if (snapAfter.isError || !mcpText(snapAfter).includes('Ada Lovelace')) p2 = false;
        const placeClick = await mcpClickByName(mcpClient, 'Place order');
        if (placeClick.isError) p2 = false;
      } catch {
        p2 = false;
      }
      checks.P2 = p2;

      // (e)
      await actor.detach();
      actor = null;

      // (f)
      let p4 = true;
      let G1 = null;
      let V2 = null;
      try {
        G1 = await globalsHash(mcpClient);
        V2 = await viewportRecord(mcpClient);
      } catch {
        p4 = false;
      }
      let C1 = [];
      let T1 = [];
      try {
        C1 = await getContexts(observer);
        const T1raw = await getPageTargets(observer);
        T1 = T1raw.map((t) => t.targetId).sort();
      } catch {
        p4 = false;
      }
      const L1 = await mcpTabsList(mcpClient);

      // (g)
      await mcpNavigate(mcpClient, `${fixture.url}/residue.html`);
      const R1 = await globalsHash(mcpClient);
      const R1attrs = await mcpEvaluate(mcpClient, '() => document.documentElement.attributes.length');

      if (G1 === null || G1 !== G0) p4 = false;
      if (!arraysEqual(L0.map((t) => t.url), L1.map((t) => t.url)) || !tabsEqual(L0, L1)) p4 = false;
      if (!arraysEqual(T0, T1)) p4 = false;
      if (R1 !== R0 || R1attrs !== R0attrs) p4 = false;
      checks.P4 = p4;

      // hasFocus is recorded but excluded from the identity comparison: a real
      // click legitimately gives the renderer focus (MCP's own clicks do the
      // same), so it is not a coexistence break (spec §4 WP-A1 item 6, amended).
      function withoutFocus(v) {
        if (!v) return v;
        const { hasFocus, ...rest } = v;
        return rest;
      }
      checks.P5 = V0 !== null && deepEqual(withoutFocus(V0), withoutFocus(V1)) && deepEqual(withoutFocus(V1), withoutFocus(V2));
      if (!checks.P5) {
        notes.push(`P5: V0=${JSON.stringify(V0)} V1=${JSON.stringify(V1)} V2=${JSON.stringify(V2)}`);
      }
      checks.P6 = arraysEqual(C0, C1) && !C0.includes(formTargetInfo.browserContextId ?? '__none__');
      if (!checks.P6) notes.push(`P6: C0=${JSON.stringify(C0)} C1=${JSON.stringify(C1)} pageCtx=${formTargetInfo.browserContextId}`);

      // (h) dialog check P3 — fresh attach/detach
      await mcpNavigate(mcpClient, `${fixture.url}/dialog.html`);
      let p3 = false;
      try {
        actor = await makeActor(adapter, port, knownBad);
        const clickAlert = actor.click('#alert');
        await new Promise((r) => setTimeout(r, 800));
        const handled = await mcpCall(mcpClient, 'browser_handle_dialog', { accept: true });
        await Promise.race([clickAlert, new Promise((r) => setTimeout(r, 3000))]);
        if (!handled.isError) {
          const logText = await mcpEvaluate(mcpClient, "() => document.getElementById('log').textContent");
          p3 = logText === 'alert closed';
        }
        await actor.detach();
        actor = null;
      } catch (e) {
        notes.push(`P3: ${e.message || e}`);
        p3 = false;
      }
      checks.P3 = p3;

      // (i) cookie check P7
      let p7 = false;
      try {
        await mcpNavigate(mcpClient, `${fixture.url}/cookie.html`);
        const cookieSeenByMcp = await mcpRunCodeUnsafe(
          mcpClient,
          "async (page) => (await page.context().cookies()).some(c => c.name === 'wingman_fixture')",
        );
        actor = await makeActor(adapter, port, knownBad);
        const cookieSeenByUs = await actor.cookieVisible('wingman_fixture');
        await actor.detach();
        actor = null;

        if (cookieSeenByMcp === true && cookieSeenByUs === true) {
          // Relaunch on the same scratch profile and port; cookies must survive.
          await mcpClient.close();
          mcpClient = null;
          observer.close();
          observer = null;
          await cleanupChrome();

          const spawned2 = launchChrome({ port, profileDir, mode: 'offscreen' });
          chromeSpawnPid = spawned2.pid;
          const ver2 = await waitForVersion(port, 10000);
          if (ver2) {
            mcpClient = await startMcp(port);
            await mcpNavigate(mcpClient, `${fixture.url}/cookie.html`);
            const stillThere = await mcpRunCodeUnsafe(
              mcpClient,
              "async (page) => (await page.context().cookies()).some(c => c.name === 'wingman_fixture')",
            );
            p7 = stillThere === true;
          }
        }
      } catch (e) {
        notes.push(`P7: ${e.message || e}`);
        p7 = false;
      }
      checks.P7 = p7;

      // (j) tab check P8: exactly one page reports document.visibilityState
      // === 'visible', and it is the first tab's target (spec §4 WP-A1 item 6).
      // "First tab" means whichever single tab exists right before this step
      // opens a second one (by step (i) that is no longer the (a) form page:
      // P7 fully relaunches Chrome and MCP re-navigates to /cookie.html).
      let p8 = false;
      try {
        const obs = observer ?? (await connectObserver(port));
        const beforeTargets = await getPageTargets(obs);
        const firstTabTargetId = beforeTargets[0]?.targetId ?? null;

        await mcpCall(mcpClient, 'browser_tabs', { action: 'new' });
        await mcpCall(mcpClient, 'browser_tabs', { action: 'select', index: 0 });
        actor = await makeActor(adapter, port, knownBad);
        const pages = await actor.pages();
        // Our high-level actor abstraction does not expose per-page
        // visibilityState, so read it directly through the observer.
        const targets = await getPageTargets(obs);
        const visibilities = [];
        for (const t of targets) {
          const v = await pageVisibility(obs, t.targetId).catch(() => null);
          visibilities.push({ targetId: t.targetId, visible: v === 'visible' });
        }
        const visibleOnes = visibilities.filter((v) => v.visible);
        p8 =
          pages.length >= 1 &&
          firstTabTargetId !== null &&
          visibleOnes.length === 1 &&
          visibleOnes[0].targetId === firstTabTargetId;
        if (!p8) {
          notes.push(`P8: visibilities=${JSON.stringify(visibilities)} expected=${firstTabTargetId}`);
        }
        await actor.detach();
        actor = null;
      } catch (e) {
        notes.push(`P8: ${e.message || e}`);
        p8 = false;
      }
      checks.P8 = p8;

      const allPass = Object.values(checks).every(Boolean);
      verdict = allPass ? 'PASS' : 'FAIL-ACT';
    }
  } catch (e) {
    verdict = verdict || 'harness-error';
    notes.push(String(e.message || e));
  } finally {
    await cleanupAll();
  }

  const exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL-ACT' ? 1 : verdict === 'FAIL-ATTACH' ? 2 : 3;
  const record = { adapter, knownBad: knownBad ?? null, phaseR, checks, verdict, notes };
  return { record, exitCode };
}

// ---------------------------------------------------------------------------
// Window probe (item 10)
// ---------------------------------------------------------------------------

async function runWindowProbe(port) {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ windowProbe: 'skipped' }));
    process.exit(0);
  }

  const modes = ['offscreen', 'normal', 'minimized'];
  const rows = [];

  for (const mode of modes) {
    const profileDir = path.join(P, 'spike', '.tmp', `profile-window-${mode}`);
    await removeDirWithRetry(profileDir);
    fs.mkdirSync(profileDir, { recursive: true });

    let chromeSpawnPid = null;
    let mcpClient = null;
    let foregroundBefore = null;
    let focus = 'unchanged';
    let click = false;
    let screenshot = false;

    try {
      foregroundBefore = getForegroundWindowPid();
      const spawned = launchChrome({ port, profileDir, mode });
      chromeSpawnPid = spawned.pid;
      const ver = await waitForVersion(port, 10000);
      if (!ver) throw new Error('chrome did not answer in time');

      if (mode === 'minimized') {
        await minimizeAllPages(port);
      }

      await new Promise((r) => setTimeout(r, 2000));
      const foregroundAfter = getForegroundWindowPid();
      const ownerPid = findSocketOwnerPid(port);
      if (foregroundAfter === foregroundBefore) focus = 'unchanged';
      else if (isDescendantOf(foregroundAfter, ownerPid)) focus = 'taken-by-chrome';
      else focus = 'changed';

      mcpClient = await startMcp(port);
      const { startFixtureServer } = await import('../dist/src/fixture-server.js');
      const fixture = await startFixtureServer();
      try {
        await Promise.race([
          (async () => {
            const nav = await mcpNavigate(mcpClient, `${fixture.url}/form.html`);
            if (nav.isError) return;
            const snap = await mcpSnapshot(mcpClient);
            const ref = findRef(mcpText(snap), 'Continue');
            if (!ref) return;
            const c = await mcpCall(mcpClient, 'browser_click', { element: 'Continue', target: ref });
            click = !c.isError;
            const s = await mcpCall(mcpClient, 'browser_take_screenshot', {});
            screenshot = !s.isError;
          })(),
          new Promise((r) => setTimeout(r, 30000)),
        ]);
      } finally {
        await fixture.close();
      }
    } catch (e) {
      // click/screenshot stay false; record continues.
    } finally {
      try {
        if (mcpClient) await mcpClient.close();
      } catch {
        // ignore
      }
      const ownerPid = findSocketOwnerPid(port);
      if (ownerPid) killTree(ownerPid);
      if (chromeSpawnPid) killTree(chromeSpawnPid);
      await waitForPortDown(port, 10000);
      await removeDirWithRetry(profileDir);
    }

    rows.push({ window: mode, click, screenshot, focus });
  }

  const offscreenRow = rows.find((r) => r.window === 'offscreen');
  const minimizedRow = rows.find((r) => r.window === 'minimized');
  const verdict =
    offscreenRow?.click === true && offscreenRow?.screenshot === true && minimizedRow?.click === false
      ? 'PASS'
      : 'FAIL';

  const record = { windowProbe: rows, verdict };
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(P, 'spike', 'results', `${today}-window.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(record));
  console.log(JSON.stringify(record));
  process.exit(verdict === 'PASS' ? 0 : 1);
}

function getForegroundWindowPid() {
  // Inline -Command quoting for a multi-line Add-Type here-string is fragile
  // through cmd.exe's own quoting; write the script to a temp .ps1 instead.
  const scriptPath = path.join(P, 'spike', '.tmp', `fg-${process.pid}.ps1`);
  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    const script = [
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class Fg {',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
      '}',
      '"@',
      '$h = [Fg]::GetForegroundWindow()',
      '$p = 0',
      '[Fg]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null',
      'Write-Output $p',
    ].join('\n');
    fs.writeFileSync(scriptPath, script);
    const out = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      encoding: 'utf8',
      windowsHide: true,
    });
    return Number(out.trim());
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch {
      // ignore
    }
  }
}

function isDescendantOf(pid, ancestorPid) {
  if (!pid || !ancestorPid) return false;
  if (pid === ancestorPid) return true;
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").ParentProcessId"`,
      { encoding: 'utf8', windowsHide: true },
    );
    const parent = Number(out.trim());
    if (!parent) return false;
    if (parent === ancestorPid) return true;
    return isDescendantOf(parent, ancestorPid);
  } catch {
    return false;
  }
}

async function minimizeAllPages(port) {
  try {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await Promise.race([cdp.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    const targets = await getPageTargets(cdp);
    const seenWindows = new Set();
    for (const t of targets) {
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId });
        if (seenWindows.has(windowId)) continue;
        seenWindows.add(windowId);
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      } catch {
        // ignore
      }
    }
    cdp.close();
  } catch (e) {
    process.stderr.write(`jev-browser-wingman: could not minimise the Chrome window: ${e.message || e}\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const port = Number(getFlag('--port') ?? 9333);

  if (hasFlag('--window-probe')) {
    await runWindowProbe(port);
    return;
  }

  const adapter = getFlag('--adapter');
  const knownBad = getFlag('--known-bad') ?? null;
  const outArg = getFlag('--out');

  if (!adapter) {
    console.error('Usage: node spike/coexistence-spike.mjs --adapter playwright|cdp [--known-bad <id>] [--port 9333] [--out <file>]');
    process.exit(3);
  }

  if (adapter === 'dist-playwright' || adapter === 'dist-cdp') {
    // Later-use mode (item 8), written now against §3.1's Driver interface.
    // At wave 0, `dist/src/adapters/index.js` does not exist yet: this path
    // cannot run and is reported as untested.
    let distAdaptersExist = false;
    try {
      await import('../dist/src/adapters/index.js');
      distAdaptersExist = true;
    } catch {
      distAdaptersExist = false;
    }
    if (!distAdaptersExist) {
      const record = {
        adapter,
        knownBad,
        phaseR: 'untested',
        checks: {},
        verdict: 'untested-at-wave-0',
        notes: ['dist/src/adapters/index.js does not exist yet; this mode is exercised at integration (gate I-11)'],
      };
      console.log(JSON.stringify(record));
      process.exit(0);
    }
    console.error('dist-playwright/dist-cdp adapter execution against a real Driver is not implemented at wave 0');
    process.exit(3);
  }

  if (adapter !== 'playwright' && adapter !== 'cdp') {
    console.error(`Unknown --adapter: ${adapter}`);
    process.exit(3);
  }

  const { record, exitCode } = await runSpike({ adapter, knownBad, port });

  const today = new Date().toISOString().slice(0, 10);
  const defaultName = knownBad ? `${today}-${adapter}-${knownBad}.json` : `${today}-${adapter}.json`;
  const outPath = outArg ? path.resolve(outArg) : path.join(P, 'spike', 'results', defaultName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(record));
  console.log(JSON.stringify(record));
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(3);
});
