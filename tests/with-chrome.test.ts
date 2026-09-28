// WP-F2: with-chrome tests (§ WP-F2 item 8 + § 3.14). Each session test
// drives an SDK Client over StdioClientTransport against a test-local
// wrapper script that calls runWithChrome with recording ensure/probe stubs
// and a stub MCP child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// The scoped build compiles only what the test files import; the wrapper
// script loads runWithChrome from the build at runtime, so import it here
// too to keep with-chrome.js in the build output.
import { runWithChrome, runWithBrowser } from '../src/cli/with-chrome.js';
import { packageRoot } from '../src/package-root.js';
import { HANDOFF_REFUSAL_TEXT } from '../src/contract/constants.js';
import { OPS } from '../src/contract/types.js';

assert.equal(typeof runWithBrowser, 'function');
assert.equal(runWithChrome, runWithBrowser);

assert.equal(typeof runWithChrome, 'function');

const buildRoot = join(fileURLToPath(import.meta.url), '..', '..');
const scratch = await mkdtemp(join(tmpdir(), 'wingman-withchrome-'));

const WRAPPER_CONFIG_PORT = 9333;

function wrapperSource(): string {
  return `
import fs from 'node:fs';
import { runWithChrome } from ${JSON.stringify(pathToFileURL(join(buildRoot, 'src', 'cli', 'with-chrome.js')).href)};

const LOG = process.env.JEVW_LOG;
const append = (s) => fs.appendFileSync(LOG, s + '\\n');
const config = ${JSON.stringify({
    mode: 'on',
    adapter: 'cdp',
    window: 'offscreen',
    profile_dir: join(scratch, 'profile'),
    port: WRAPPER_CONFIG_PORT,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { max_steps: 8, max_ms: 45000, jev_timeout_ms: 10000, max_elements: 240, max_text_chars: 3000, max_state_chars: 24000 },
  })};
const deps = {
  env: process.env,
  loadConfigFn: async () => ({ ok: true, config, source: 'file' }),
  ensureChromeFn: async (opts) => {
    append('ensure ' + opts.port);
    if (process.env.JEVW_ENSURE_MODE === 'fail') {
      return { ok: false, code: 'no-chrome', message: 'stub ensure failure' };
    }
    return { ok: true, endpoint: 'http://127.0.0.1:' + opts.port, port: opts.port, pid: null, startedByUs: false };
  },
  probeVersionFn: async (port) => {
    append('probe ' + port);
    return process.env.JEVW_PROBE_ANSWERS === '1' ? { Browser: 'Chrome' } : null;
  },
};
if (process.env.JEVW_EAGER === '1') {
  // The pre-decision-2 behaviour: ensure at wrapper start, before any call.
  await deps.ensureChromeFn({ port: config.port, profileDir: config.profile_dir, chromePath: null, home: ${JSON.stringify(scratch)}, window: 'offscreen' });
}
if (process.env.JEVW_NOISY === '1') {
  process.stdout.write('ensuring\\n');
}
const code = await runWithChrome(process.argv.slice(2), deps);
process.exitCode = code;
`;
}

const STUB_MCP = `
import fs from 'node:fs';
const append = (s) => fs.appendFileSync(process.env.JEVW_LOG, s + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  append('stub:' + (msg.method ?? 'response'));
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0.0.0' } });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'stub_tool', description: 'stub', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: 'stub-ok' }] });
  } else if (msg.id !== undefined) {
    reply(msg.id, {});
  }
}
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
`;

const ECHO_CHILD = `
const mode = process.env.JEVW_CHILD_MODE ?? 'x';
if (mode === 'exit7') {
  process.exit(7);
} else if (mode === 'env') {
  process.stdout.write(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? 'unset');
} else {
  process.stdout.write('X');
}
`;

const wrapperPath = join(scratch, 'wrapper.mjs');
const stubMcpPath = join(scratch, 'stub-mcp.mjs');
const echoChildPath = join(scratch, 'echo-child.mjs');
await writeFile(wrapperPath, wrapperSource(), 'utf8');
await writeFile(stubMcpPath, STUB_MCP, 'utf8');
await writeFile(echoChildPath, ECHO_CHILD, 'utf8');

async function readLog(logPath: string): Promise<string> {
  if (!existsSync(logPath)) return '';
  return readFile(logPath, 'utf8');
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Raw-spawn the wrapper (no SDK client), collect stdout, wait for exit. */
function runWrapper(argv: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = nodeSpawn(process.execPath, [wrapperPath, ...argv], {
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', COMSPEC: process.env.ComSpec ?? '', ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => (stdout += c));
    child.stderr!.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function childEnv(logPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return { JEVW_LOG: logPath, ...extra };
}

/** The assertion the stdout-purity tests share. */
function assertStdoutOnlyChildBytes(stdout: string): void {
  assert.equal(stdout, 'X');
}

const PRESET_ENDPOINT = 'http://127.0.0.1:65535';

test('stdout carries only the child bytes, in each branch', async () => {
  // Proxy branch (no preset endpoint).
  const proxyLog = join(scratch, 'purity-proxy.log');
  const proxyRun = await runWrapper([process.execPath, echoChildPath], childEnv(proxyLog, { JEVW_CHILD_MODE: 'x' }));
  assert.equal(proxyRun.code, 0, proxyRun.stderr);
  assertStdoutOnlyChildBytes(proxyRun.stdout);

  // Preset-endpoint branch.
  const presetLog = join(scratch, 'purity-preset.log');
  const presetRun = await runWrapper([process.execPath, echoChildPath], childEnv(presetLog, { JEVW_CHILD_MODE: 'x', WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT }));
  assert.equal(presetRun.code, 0, presetRun.stderr);
  assertStdoutOnlyChildBytes(presetRun.stdout);
});

test('the stdout purity assertion fails on a wrapper that prints first', async () => {
  const log = join(scratch, 'purity-noisy.log');
  const run = await runWrapper([process.execPath, echoChildPath], childEnv(log, { JEVW_CHILD_MODE: 'x', JEVW_NOISY: '1' }));
  assert.equal(run.code, 0);
  assert.throws(() => assertStdoutOnlyChildBytes(run.stdout));
});

test('a matched profile sets its own endpoint_env on the child (§ 5.9; product env is data-driven, not hardcoded)', async () => {
  // The echo child cannot print env in both modes; reuse the argv printer is
  // unnecessary — run with JEVW_CHILD_MODE=env and a fresh child copy. The
  // wrapped argv carries a dummy arg matching the shipped playwright-mcp
  // profile's detect.args_contain, so argvProfile resolves and its
  // launch.endpoint_env ("PLAYWRIGHT_MCP_CDP_ENDPOINT") is what gets set —
  // never a name this file writes itself (grep gate: no "playwright" here).
  const envChild = join(scratch, 'env-child.mjs');
  await writeFile(
    envChild,
    "process.stdout.write(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? 'unset');\n",
    'utf8',
  );
  const log = join(scratch, 'env.log');
  const run = await runWrapper(
    [process.execPath, envChild, '--dummy=@playwright/mcp'],
    childEnv(log, { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, WINGMAN_HOME: scratch }),
  );
  assert.equal(run.stdout, PRESET_ENDPOINT);
});

test('a preset endpoint env skips ensure', async () => {
  const log = join(scratch, 'preset-skip.log');
  const run = await runWrapper([process.execPath, echoChildPath], childEnv(log, { JEVW_CHILD_MODE: 'x', WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT }));
  assert.equal(run.code, 0, run.stderr);
  const logText = await readLog(log);
  assert.ok(!logText.includes('ensure '), 'ensure ran in the preset branch');
  assert.ok(!logText.includes('probe '), 'probe ran in the preset branch');
});

test('{cdp} placeholders are replaced', async () => {
  const argChild = join(scratch, 'arg-child.mjs');
  await writeFile(argChild, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  const log = join(scratch, 'cdp-replace.log');
  const run = await runWrapper([process.execPath, argChild, 'http://x/{cdp}/y'], childEnv(log));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [`http://x/http://127.0.0.1:${WRAPPER_CONFIG_PORT}/y`]);
});

test('the child exit code propagates', async () => {
  const log = join(scratch, 'exit-code.log');
  const run = await runWrapper([process.execPath, echoChildPath], childEnv(log, { JEVW_CHILD_MODE: 'exit7' }));
  assert.equal(run.code, 7);
});

// ---- SDK session tests over the proxy branch (§ 3.14) ----

function safeEnv(logPath: string, extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, JEVW_LOG: logPath, ...extra };
}

async function withSession(
  logPath: string,
  extraEnv: Record<string, string>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [wrapperPath, process.execPath, stubMcpPath],
    env: safeEnv(logPath, extraEnv),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'jevw-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

test('a session with no tool call never ensures Chrome', async () => {
  const log = join(scratch, 'session-idle.log');
  await withSession(log, {}, async (client) => {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
  });
  const logText = await readLog(log);
  assert.ok(logText.includes('stub:initialize'), `stub saw: ${logText}`);
  assert.ok(logText.includes('stub:tools/list'), `stub saw: ${logText}`);
  assert.ok(!logText.includes('ensure '), 'ensure ran without any tool call');
  assert.ok(!logText.includes('probe '), 'probe ran without any tool call');
});

test('the no-ensure assertion fails on an eager wrapper', async () => {
  const log = join(scratch, 'session-eager.log');
  await withSession(log, { JEVW_EAGER: '1' }, async (client) => {
    await client.listTools();
  });
  const assertNoEnsure = (logText: string): void => {
    assert.ok(!logText.includes('ensure '), 'ensure ran without any tool call');
  };
  const logText = await readLog(log);
  assert.throws(() => assertNoEnsure(logText));
});

test('the first tool call ensures Chrome once before the child receives it', async () => {
  const log = join(scratch, 'session-toolcall.log');
  await withSession(log, { JEVW_PROBE_ANSWERS: '1' }, async (client) => {
    const first = (await client.callTool({ name: 'stub_tool', arguments: {} })) as { isError?: boolean };
    assert.ok(!first.isError);
    const second = (await client.callTool({ name: 'stub_tool', arguments: {} })) as { isError?: boolean };
    assert.ok(!second.isError);
  });
  const logText = await readLog(log);
  const lines = logText.split('\n').filter((l) => l !== '');
  const ensureCount = lines.filter((l) => l.startsWith('ensure ')).length;
  const probeCount = lines.filter((l) => l.startsWith('probe ')).length;
  const firstEnsure = lines.findIndex((l) => l.startsWith('ensure '));
  const firstStubCall = lines.findIndex((l) => l === 'stub:tools/call');
  assert.equal(ensureCount, 1, `expected one ensure, log: ${logText}`);
  assert.equal(probeCount, 1, `expected one probe (the second call), log: ${logText}`);
  assert.ok(firstEnsure !== -1 && firstStubCall !== -1 && firstEnsure < firstStubCall, `order wrong: ${logText}`);
  assert.equal(lines.filter((l) => l === 'stub:tools/call').length, 2, `log: ${logText}`);
});

test('an ensure failure answers the tool call with isError and never forwards it', async () => {
  const log = join(scratch, 'session-ensurefail.log');
  await withSession(log, { JEVW_ENSURE_MODE: 'fail' }, async (client) => {
    const result = (await client.callTool({ name: 'stub_tool', arguments: {} })) as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    assert.ok(result.isError, 'expected an isError result');
    assert.ok(result.content?.[0]?.text.startsWith('jev-browser-wingman with-chrome: '), `content: ${JSON.stringify(result.content)}`);
    try {
      await client.callTool({ name: 'stub_tool', arguments: {} });
    } catch {
      // A later failing gated line may surface as a client-side error; the
      // important assertion is the log below.
    }
  });
  const logText = await readLog(log);
  assert.ok(logText.includes('ensure '), 'expected the ensure attempt');
  assert.ok(!logText.includes('stub:tools/call'), 'the gated tool call was forwarded despite the failed ensure');
});

// ---- WP-C C4: generic withholding proxy (§ 5.9, § 6 WP-C), all through the
// stub child (C3, tests/fixtures/stub-browsing-mcp.mjs). WINGMAN_HOME is a
// temp dir per test; the real home is never read. Each config carries an
// explicit `handoff` (§ test-setup note): a hand-built config without one
// runs optional, so "absent means forced" holds only through loadConfig.

const stubBrowsingMcpPath = join(packageRoot(), 'tests', 'fixtures', 'stub-browsing-mcp.mjs');

const WH_WRAPPER = `
import fs from 'node:fs';
import { runWithBrowser } from ${JSON.stringify(pathToFileURL(join(buildRoot, 'src', 'cli', 'with-chrome.js')).href)};

const LOG = process.env.JEVW_WH_LOG;
const append = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch { /* best effort */ } };

const deps = {
  env: process.env,
  ensureChromeFn: async (opts) => {
    append('ensure ' + opts.port);
    if (process.env.JEVW_ENSURE_MODE === 'fail') {
      return { ok: false, code: 'no-chrome', message: 'stub ensure failure' };
    }
    return { ok: true, endpoint: 'http://127.0.0.1:' + opts.port, port: opts.port, pid: null, startedByUs: false };
  },
  probeVersionFn: async (port) => {
    append('probe ' + port);
    return process.env.JEVW_PROBE_ANSWERS === '1' ? { Browser: 'Chrome' } : null;
  },
};
if (process.env.JEVW_ADAPTER_OPS) {
  deps.adapterOps = JSON.parse(process.env.JEVW_ADAPTER_OPS);
}
if (process.env.JEVW_CLASSIFY_RESULT) {
  const result = JSON.parse(process.env.JEVW_CLASSIFY_RESULT);
  deps.classifyToolsFn = async () => result;
}
const code = await runWithBrowser(process.argv.slice(2), deps);
process.exitCode = code;
`;

const whWrapperPath = join(scratch, 'wh-wrapper.mjs');
await writeFile(whWrapperPath, WH_WRAPPER, 'utf8');

interface WHProc {
  send(msg: unknown): void;
  next(): Promise<string>;
  waitClose(): Promise<number | null>;
  endStdin(): void;
  stderrText(): string;
}

function startWithhold(opts: { home: string; extraArgv?: string[]; env?: Record<string, string> }): WHProc {
  const env = safeEnv(join(opts.home, 'wh.log'), { JEVW_WH_LOG: join(opts.home, 'wh.log'), WINGMAN_HOME: opts.home, ...opts.env });
  const argv = [whWrapperPath, process.execPath, stubBrowsingMcpPath, ...(opts.extraArgv ?? [])];
  const child: ChildProcess = nodeSpawn(process.execPath, argv, { env, windowsHide: true });
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  let stderrText = '';
  child.stderr!.on('data', (c: string) => {
    stderrText += c;
  });
  let buf = '';
  const queue: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (waiters.length > 0) waiters.shift()!(line);
      else queue.push(line);
    }
  });
  const closeP = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  return {
    send: (msg) => child.stdin!.write(JSON.stringify(msg) + '\n'),
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))),
    waitClose: () => closeP,
    endStdin: () => child.stdin!.end(),
    stderrText: () => stderrText,
  };
}

async function writeWHConfig(
  home: string,
  opts: { topMode?: 'on' | 'off'; handoff?: { mode: 'forced' | 'optional'; retain?: string[] } } = {},
): Promise<void> {
  await mkdir(home, { recursive: true });
  const cfg: Record<string, unknown> = { mode: opts.topMode ?? 'on', adapter: 'cdp' };
  if (opts.handoff) cfg.handoff = opts.handoff;
  await writeFile(join(home, 'config.json'), JSON.stringify(cfg), 'utf8');
}

async function waitForLog(path: string, predicate: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const text = await readLog(path);
    if (predicate(text)) return text;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for log at ${path}: ${text}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface ToolCallResult {
  result: { isError?: boolean; content?: Array<{ type: string; text: string }> };
}

async function listTools(proc: WHProc, id = 1): Promise<{ names: string[]; raw: unknown }> {
  proc.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
  const line = await proc.next();
  const parsed = JSON.parse(line) as { result: { tools: Array<{ name: string }> } };
  return { names: parsed.result.tools.map((t) => t.name), raw: parsed };
}

async function callTool(proc: WHProc, name: string, args: unknown, id: number): Promise<ToolCallResult> {
  proc.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const line = await proc.next();
  return JSON.parse(line) as ToolCallResult;
}

const PLAYWRIGHT_TOOLS = [
  'browser_click', 'browser_check', 'browser_uncheck', 'browser_type', 'browser_select_option',
  'browser_press_key', 'browser_hover', 'browser_file_upload', 'browser_navigate', 'browser_navigate_back',
  'browser_tabs', 'browser_snapshot', 'browser_wait_for', 'browser_evaluate', 'browser_run_code_unsafe',
].map((name) => ({ name, description: name }));

const DEVTOOLS_TOOLS = ['take_snapshot', 'click', 'navigate_page', 'new_page'].map((name) => ({ name, description: name }));

const FOREIGN_TOOL_NAMES = ['pagetool_press_button', 'pagetool_goto', 'pagetool_look', 'pagetool_coords_click'];
const FOREIGN_TOOLS = FOREIGN_TOOL_NAMES.map((name) => ({ name, description: name }));
const FOREIGN_CLASSES: Record<string, string> = {
  pagetool_press_button: 'element-act',
  pagetool_goto: 'navigate',
  pagetool_look: 'read',
  pagetool_coords_click: 'pointer-xy',
};

const WHOLE_OPS = [...OPS];
const OPS_WITHOUT_UPLOAD = OPS.filter((o) => o !== 'upload');

test('W1: forced + preset + a playwright-named tool set — withheld names absent, retained present', async () => {
  const home = join(scratch, 'w1');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(!names.includes('browser_click'), `browser_click should be withheld: ${names}`);
    assert.ok(names.includes('browser_snapshot'), `browser_snapshot should be retained: ${names}`);
    assert.ok(names.includes('browser_tabs'), `browser_tabs should be retained: ${names}`);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W2: forced — browser_click is refused inline and never reaches the stub; browser_snapshot forwards', async () => {
  const home = join(scratch, 'w2');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    await listTools(proc);
    const refused = await callTool(proc, 'browser_click', {}, 2);
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.content?.[0]?.text, HANDOFF_REFUSAL_TEXT);
    const forwarded = await callTool(proc, 'browser_snapshot', {}, 3);
    assert.notEqual(forwarded.result.isError, true);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(!stubText.includes('method:tools/call:browser_click'), `the stub must never see browser_click: ${stubText}`);
  assert.ok(stubText.includes('method:tools/call:browser_snapshot'), `the stub should see browser_snapshot: ${stubText}`);
});

test('W3: devtools-named stub — click withheld, navigate_page argument-ruled by type', async () => {
  const home = join(scratch, 'w3');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(DEVTOOLS_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(!names.includes('click'), `click should be withheld from the list: ${names}`);
    assert.ok(names.includes('navigate_page'), `navigate_page should stay listed (argument-ruled): ${names}`);

    const urlCall = await callTool(proc, 'navigate_page', { type: 'url', url: 'https://example.com' }, 2);
    assert.equal(urlCall.result.isError, true, 'navigate_page url form should be refused');
    const backCall = await callTool(proc, 'navigate_page', { type: 'back' }, 3);
    assert.equal(backCall.result.isError, true, 'navigate_page back form should be refused');
    const reloadCall = await callTool(proc, 'navigate_page', { type: 'reload' }, 4);
    assert.notEqual(reloadCall.result.isError, true, 'navigate_page reload form should forward (session, retained)');
    const newPageCall = await callTool(proc, 'new_page', { url: 'https://example.com' }, 5);
    assert.notEqual(newPageCall.result.isError, true, 'new_page should forward (tabs, retained)');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W4: optional + preset — unfiltered, byte path inherited', async () => {
  const home = join(scratch, 'w4');
  await writeWHConfig(home, { handoff: { mode: 'optional' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_click'), 'optional handoff must not filter the list');
    const call = await callTool(proc, 'browser_click', {}, 2);
    assert.notEqual(call.result.isError, true);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(stubText.includes('method:tools/call:browser_click'));
});

test('W5: forced, no preset — a refused call does not ensure; a forwarded call ensures once', async () => {
  const home = join(scratch, 'w5');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const whLog = join(home, 'wh.log');
  const proc = startWithhold({
    home,
    env: { STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log'), JEVW_PROBE_ANSWERS: '1' },
  });
  try {
    await listTools(proc);
    const refused = await callTool(proc, 'browser_click', {}, 2);
    assert.equal(refused.result.isError, true);
    let logText = await readLog(whLog);
    assert.ok(!logText.includes('ensure '), `a refused call must not ensure: ${logText}`);
    const forwarded = await callTool(proc, 'browser_snapshot', {}, 3);
    assert.notEqual(forwarded.result.isError, true);
    logText = await readLog(whLog);
    assert.ok(logText.includes('ensure '), 'a forwarded call must ensure');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W6: forced — a raw notification line from the child arrives byte-identical', async () => {
  const home = join(scratch, 'w6');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const raw = '{"jsonrpc":  "2.0" , "method":"notifications/x","params":{}}';
  const proc = startWithhold({
    home,
    env: {
      WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT,
      STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS),
      STUB_NOTIFY_RAW: raw,
      STUB_LOG: join(home, 'stub.log'),
    },
  });
  try {
    const line = await proc.next();
    assert.equal(line, raw);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W7: forced — a batch array with a withheld call gets an array of refusals; nothing forwarded', async () => {
  const home = join(scratch, 'w7');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    await listTools(proc);
    proc.send([
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'browser_click', arguments: {} } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
    ]);
    const line = await proc.next();
    const parsed = JSON.parse(line) as ToolCallResult['result'][];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    for (const r of parsed as unknown as Array<{ result: { isError?: boolean } }>) {
      assert.equal(r.result.isError, true);
    }
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(!stubText.includes('tools/call'), `the child must never see the batch: ${stubText}`);
});

test('W7a: forced — a batch of script-class calls (browser_evaluate/browser_run_code_unsafe) is refused, nothing forwarded', async () => {
  const home = join(scratch, 'w7a');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    await listTools(proc);
    proc.send([
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } },
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: {} } },
    ]);
    const line = await proc.next();
    const parsed = JSON.parse(line) as ToolCallResult['result'][];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    for (const r of parsed as unknown as Array<{ result: { isError?: boolean } }>) {
      assert.equal(r.result.isError, true);
    }
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(!stubText.includes('tools/call'), `the child must never see the batch: ${stubText}`);
});

test('W7b: forced — a batched tools/list response is filtered (withheld tools absent)', async () => {
  const home = join(scratch, 'w7b');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS) },
  });
  try {
    proc.send([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const line = await proc.next();
    const parsed = JSON.parse(line) as Array<{ id: number; result: { tools: Array<{ name: string }> } }>;
    assert.ok(Array.isArray(parsed), `expected an array response: ${line}`);
    assert.equal(parsed.length, 1);
    const names = parsed[0].result.tools.map((t) => t.name);
    assert.ok(!names.includes('browser_click'), `browser_click should be withheld in a batched tools/list: ${names}`);
    assert.ok(names.includes('browser_snapshot'), `browser_snapshot should be retained: ${names}`);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W7c: forced — activeProfile populated from a batched tools/list lets a later plain tools/call classify correctly', async () => {
  const home = join(scratch, 'w7c');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    proc.send([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    await proc.next();
    const refused = await callTool(proc, 'browser_click', {}, 2);
    assert.equal(refused.result.isError, true, 'browser_click should be refused once activeProfile is populated from a batched tools/list');
    const forwarded = await callTool(proc, 'browser_snapshot', {}, 3);
    assert.notEqual(forwarded.result.isError, true, 'browser_snapshot should still forward');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(!stubText.includes('method:tools/call:browser_click'), `the stub must never see browser_click: ${stubText}`);
  assert.ok(stubText.includes('method:tools/call:browser_snapshot'), `the stub should see browser_snapshot: ${stubText}`);
});

test('W8: preset + config failure — stderr line, unfiltered', async () => {
  const home = join(scratch, 'w8');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.json'), '{ this is not json', 'utf8');
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  let code: number | null = null;
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_click'), 'a config failure must fall back to optional, unfiltered');
  } finally {
    proc.endStdin();
    code = await proc.waitClose();
  }
  assert.equal(code, 0);
  assert.ok(proc.stderrText().includes('config:'), `expected a config error line: ${proc.stderrText()}`);
  assert.ok(proc.stderrText().includes('handoff optional'), proc.stderrText());
});

test('W9 (agnosticism gate): a user profile classifies foreign-named tools', async () => {
  const home = join(scratch, 'w9');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  await mkdir(join(home, 'profiles'), { recursive: true });
  await writeFile(
    join(home, 'profiles', 'pagetool.json'),
    JSON.stringify({
      id: 'pagetool',
      description: 'foreign test tool',
      detect: { args_contain: [], extension_flags: [], endpoint_flags: [] },
      launch: { endpoint_env: null, endpoint_arg: null, strip_args: [] },
      match_tools: FOREIGN_TOOL_NAMES,
      tools: FOREIGN_CLASSES,
      arg_rules: [],
    }),
    'utf8',
  );
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(FOREIGN_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(!names.includes('pagetool_press_button'), `${names}`);
    assert.ok(!names.includes('pagetool_goto'), `${names}`);
    assert.ok(names.includes('pagetool_look'), `${names}`);
    assert.ok(names.includes('pagetool_coords_click'), `${names}`);
    const refusedA = await callTool(proc, 'pagetool_press_button', {}, 2);
    assert.equal(refusedA.result.isError, true);
    const refusedB = await callTool(proc, 'pagetool_goto', {}, 3);
    assert.equal(refusedB.result.isError, true);
    const okA = await callTool(proc, 'pagetool_look', {}, 4);
    assert.notEqual(okA.result.isError, true);
    const okB = await callTool(proc, 'pagetool_coords_click', {}, 5);
    assert.notEqual(okB.result.isError, true);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W10: same foreign stub, no profile — injected classifyToolsFn yields the same result as W9', async () => {
  const home = join(scratch, 'w10');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const classifyResult = {
    profile: {
      id: 'auto-w10',
      auto: true,
      description: 'auto-classified',
      detect: { args_contain: [], extension_flags: [], endpoint_flags: [] },
      launch: { endpoint_env: null, endpoint_arg: null, strip_args: [] },
      match_tools: FOREIGN_TOOL_NAMES,
      tools: FOREIGN_CLASSES,
      arg_rules: [],
    },
  };
  const proc = startWithhold({
    home,
    env: {
      WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT,
      STUB_TOOLS: JSON.stringify(FOREIGN_TOOLS),
      STUB_LOG: join(home, 'stub.log'),
      JEVW_CLASSIFY_RESULT: JSON.stringify(classifyResult),
    },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(!names.includes('pagetool_press_button'), `${names}`);
    assert.ok(!names.includes('pagetool_goto'), `${names}`);
    assert.ok(names.includes('pagetool_look'), `${names}`);
    assert.ok(names.includes('pagetool_coords_click'), `${names}`);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W11: classifyToolsFn returns no-key — every tool stays listed and forwarded, plus the stderr line', async () => {
  const home = join(scratch, 'w11');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    env: {
      WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT,
      STUB_TOOLS: JSON.stringify(FOREIGN_TOOLS),
      STUB_LOG: join(home, 'stub.log'),
      JEVW_CLASSIFY_RESULT: JSON.stringify({ profile: null, reason: 'no-key' }),
    },
  });
  try {
    const { names } = await listTools(proc);
    for (const name of FOREIGN_TOOL_NAMES) assert.ok(names.includes(name), `${name} should stay listed: ${names}`);
    const call = await callTool(proc, 'pagetool_press_button', {}, 2);
    assert.notEqual(call.result.isError, true);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  assert.ok(proc.stderrText().includes('no capability profile matches'), proc.stderrText());
  assert.ok(proc.stderrText().includes('no-key'), proc.stderrText());
});

test('W12 (§ 10.4 derived-set gate): a class withholds only when the adapter declares every one of its ops', async () => {
  const homeA = join(scratch, 'w12a');
  await writeWHConfig(homeA, { handoff: { mode: 'forced' } });
  const procA = startWithhold({
    home: homeA,
    env: {
      WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT,
      STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS),
      STUB_LOG: join(homeA, 'stub.log'),
      JEVW_ADAPTER_OPS: JSON.stringify(OPS_WITHOUT_UPLOAD),
    },
  });
  try {
    const { names: namesA } = await listTools(procA);
    assert.ok(namesA.includes('browser_file_upload'), `without the upload op declared, upload must not be withheld: ${namesA}`);
    const callA = await callTool(procA, 'browser_file_upload', { paths: ['/tmp/x'] }, 2);
    assert.notEqual(callA.result.isError, true);
  } finally {
    procA.endStdin();
    await procA.waitClose();
  }

  const homeB = join(scratch, 'w12b');
  await writeWHConfig(homeB, { handoff: { mode: 'forced' } });
  const procB = startWithhold({
    home: homeB,
    env: {
      WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT,
      STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS),
      STUB_LOG: join(homeB, 'stub.log'),
      JEVW_ADAPTER_OPS: JSON.stringify(WHOLE_OPS),
    },
  });
  try {
    const { names: namesB } = await listTools(procB);
    assert.ok(!namesB.includes('browser_file_upload'), `with the upload op declared, upload must be withheld: ${namesB}`);
  } finally {
    procB.endStdin();
    await procB.waitClose();
  }
});

test('W13: retain — a retained class stays listed even though the adapter declares its ops', async () => {
  const home = join(scratch, 'w13');
  await writeWHConfig(home, { handoff: { mode: 'forced', retain: ['navigate'] } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_navigate'), `retain should keep browser_navigate listed: ${names}`);
    assert.ok(!names.includes('browser_click'), 'unrelated classes stay withheld');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W17: forced — script-class tools (browser_evaluate, browser_run_code_unsafe) are withheld by default, though no adapter op covers them', async () => {
  const home = join(scratch, 'w17');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(!names.includes('browser_evaluate'), `browser_evaluate should be withheld: ${names}`);
    assert.ok(!names.includes('browser_run_code_unsafe'), `browser_run_code_unsafe should be withheld: ${names}`);
    const refusedEval = await callTool(proc, 'browser_evaluate', {}, 2);
    assert.equal(refusedEval.result.isError, true, 'browser_evaluate must be refused under forced handoff');
    const refusedRun = await callTool(proc, 'browser_run_code_unsafe', {}, 3);
    assert.equal(refusedRun.result.isError, true, 'browser_run_code_unsafe must be refused under forced handoff');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(!stubText.includes('method:tools/call:browser_evaluate'), `the stub must never see browser_evaluate: ${stubText}`);
  assert.ok(!stubText.includes('method:tools/call:browser_run_code_unsafe'), `the stub must never see browser_run_code_unsafe: ${stubText}`);
});

test('W18: forced + handoff.retain: ["script"] — browser_evaluate stays listed and forwards', async () => {
  const home = join(scratch, 'w18');
  await writeWHConfig(home, { handoff: { mode: 'forced', retain: ['script'] } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: stubLog },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_evaluate'), `retain: ["script"] should keep browser_evaluate listed: ${names}`);
    assert.ok(!names.includes('browser_click'), 'unrelated classes stay withheld');
    const forwarded = await callTool(proc, 'browser_evaluate', {}, 2);
    assert.notEqual(forwarded.result.isError, true, 'browser_evaluate must forward to the stub when retained');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const stubText = await readLog(stubLog);
  assert.ok(stubText.includes('method:tools/call:browser_evaluate'), `the stub should see browser_evaluate when retained: ${stubText}`);
});

test('W19: optional — browser_evaluate is listed (script withholding does not apply outside forced mode)', async () => {
  const home = join(scratch, 'w19');
  await writeWHConfig(home, { handoff: { mode: 'optional' } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_evaluate'), `optional handoff must not filter browser_evaluate: ${names}`);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W14: an argvProfile with endpoint_arg — the arg is appended to the child argv', async () => {
  const home = join(scratch, 'w14');
  await writeWHConfig(home, { handoff: { mode: 'optional' } });
  const stubLog = join(home, 'stub.log');
  const proc = startWithhold({
    home,
    extraArgv: ['--dummy=chrome-devtools-mcp'],
    env: { STUB_TOOLS: JSON.stringify(DEVTOOLS_TOOLS), STUB_LOG: stubLog },
  });
  let stubText: string;
  try {
    stubText = await waitForLog(stubLog, (t) => t.includes('argv:'));
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
  const argvLine = stubText.split('\n').find((l) => l.startsWith('argv:'));
  assert.ok(argvLine, `stub never logged argv: ${stubText}`);
  const argv = JSON.parse(argvLine!.slice('argv:'.length)) as string[];
  assert.ok(argv.some((a) => a.startsWith('--browserUrl=')), `endpoint_arg not appended: ${JSON.stringify(argv)}`);
});

test('W15: forced — argvProfile classifies a call sent before any tools/list', async () => {
  const home = join(scratch, 'w15');
  await writeWHConfig(home, { handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    extraArgv: ['--dummy=@playwright/mcp'],
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const refusal = await callTool(proc, 'browser_click', {}, 1);
    assert.equal(refusal.result.isError, true, 'the argvProfile fallback should classify and refuse this call');
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

test('W16: top-level mode off with handoff forced — effective handoff is optional (§ 5.3), unfiltered', async () => {
  const home = join(scratch, 'w16');
  await writeWHConfig(home, { topMode: 'off', handoff: { mode: 'forced' } });
  const proc = startWithhold({
    home,
    env: { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT, STUB_TOOLS: JSON.stringify(PLAYWRIGHT_TOOLS), STUB_LOG: join(home, 'stub.log') },
  });
  try {
    const { names } = await listTools(proc);
    assert.ok(names.includes('browser_click'), 'mode off must make the effective handoff optional, so no filtering');
    const call = await callTool(proc, 'browser_click', {}, 2);
    assert.notEqual(call.result.isError, true);
  } finally {
    proc.endStdin();
    await proc.waitClose();
  }
});

// The scratch dir (wrapper and child scripts) goes away with the process;
// a synchronous best-effort removal keeps the gate at 10 tests.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
