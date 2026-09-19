// WP-F2: with-chrome tests (§ WP-F2 item 8 + § 3.14). Each session test
// drives an SDK Client over StdioClientTransport against a test-local
// wrapper script that calls runWithChrome with recording ensure/probe stubs
// and a stub MCP child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { runWithChrome } from '../src/cli/with-chrome.js';

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

test('the child sees PLAYWRIGHT_MCP_CDP_ENDPOINT', async () => {
  // The echo child cannot print env in both modes; reuse the argv printer is
  // unnecessary — run with JEVW_CHILD_MODE=env and a fresh child copy.
  const envChild = join(scratch, 'env-child.mjs');
  await writeFile(
    envChild,
    "process.stdout.write(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? 'unset');\n",
    'utf8',
  );
  const log = join(scratch, 'env.log');
  const run = await runWrapper([process.execPath, envChild], childEnv(log, { WINGMAN_CDP_ENDPOINT: PRESET_ENDPOINT }));
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

// The scratch dir (wrapper and child scripts) goes away with the process;
// a synchronous best-effort removal keeps the gate at 10 tests.
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
