// MCP server tests (§ WP-F1 item 7 required list). The server under test is
// the real built CLI (`node <this build>/src/cli/main.js mcp`) spawned through
// the SDK's StdioClientTransport with a temp WINGMAN_HOME; the shared browser
// comes from launchTestChrome via WINGMAN_CDP_ENDPOINT and the decision
// service from startTypeSafeStub via TYPESAFE_BASE_URL plus a dummy key.
// Every tool call passes url_match naming its fixture page (a headless Chrome
// may report its about:blank page as visible too).

import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { launchTestChrome } from './helpers/chrome.js';
import { startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';
import {
  WINGMAN_CHECK_DESCRIPTION,
  WINGMAN_CHECK_SCHEMA,
  WINGMAN_DO_DESCRIPTION,
  WINGMAN_DO_SCHEMA,
} from '../src/surfaces/tool-text.js';
import type { WingmanResult } from '../src/contract/types.js';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

// ---- shared browser and fixture server ----

let chrome: Awaited<ReturnType<typeof launchTestChrome>>;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.before(async () => {
  chrome = await launchTestChrome({ headless: true });
  fixture = await startFixtureServer();
});

test.after(async () => {
  await fixture.close();
  await chrome.close();
});

// ---- harness ----

function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      k === 'WINGMAN_HOME' ||
      k === 'WINGMAN_CDP_ENDPOINT' ||
      k === 'PLAYWRIGHT_MCP_CDP_ENDPOINT' ||
      k === 'TYPESAFE_API_KEY' ||
      k === 'TYPESAFE_BASE_URL'
    ) {
      continue;
    }
    env[k] = v;
  }
  return env;
}

function mkHome(mode: string, extraConfig: Record<string, unknown> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-mcp-test-'));
  // `off` is the key-absent default; the config rejects an explicit "off".
  const config = {
    ...(mode === 'off' ? {} : { mode }),
    adapter: 'playwright',
    window: 'headless',
    profile_dir: path.join(home, 'profile'),
    port: chrome.port,
    ...extraConfig,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function serverEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...scrubEnv(),
    WINGMAN_HOME: home,
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
    ...extra,
  };
}

let stubUrl = ''; // set per test before the server starts

interface Script {
  done?: number;
  irreversible?: number;
  answer?: number;
  targetName?: string;
  verb?: string;
  delayMs?: number;
}

async function startScriptedStub(script: Script[] = []) {
  let call = 0;
  return startTypeSafeStub((body) => {
    const step = script[Math.min(call, script.length - 1)] ?? {};
    call += 1;
    const q = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>;
    const answers: Record<string, unknown> = {};
    const noulDefaults: Record<string, number> = {
      done: 0.05,
      blocked: 0.05,
      login: 0.05,
      error: 0.05,
      irreversible: 0.05,
    };
    for (const [key, dflt] of Object.entries(noulDefaults)) {
      if (key in q) {
        answers[key] = { type: 'noul', noul: (step[key as 'done'] ?? dflt) };
      }
    }
    if ('answer' in q) {
      answers.answer = { type: 'noul', noul: step.answer ?? 0.87 };
    }
    if ('action' in q) {
      const verb = step.verb ?? 'click';
      answers.action = { type: 'choice', choice: verb, probabilities: { [verb]: 0.9 }, confidence: 0.9 };
    }
    if ('target' in q) {
      const criteria = q.target?.criteria ?? {};
      const name = step.targetName ?? '';
      let pick = Object.keys(criteria).find((k) => criteria[k].includes(name));
      if (!pick) pick = Object.keys(criteria).find((k) => /^e\d+$/.test(k)) ?? 'none';
      answers.target = { type: 'choice', choice: pick, probabilities: { [pick]: 0.9 }, confidence: 0.9 };
    }
    if ('option' in q) {
      answers.option = { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 };
    }
    if ('value' in q) {
      const keys = Object.keys(q.value?.criteria ?? {});
      const pick = keys[0] ?? 'none';
      answers.value = { type: 'choice', choice: pick, probabilities: { [pick]: 0.9 }, confidence: 0.9 };
    }
    return { status: 200, body: { answers, usage: {} }, delayMs: step.delayMs };
  });
}

interface ServerHandle {
  client: Client;
  close(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<ServerHandle> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
  const client = new Client({ name: 'wingman-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<WingmanResult> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.notEqual(res.isError, true, 'tool call returned isError for a status result');
  return JSON.parse(res.content[0].text) as WingmanResult;
}

async function openFixturePage(name: string): Promise<string> {
  const res = await fetch(`${chrome.endpoint}/json/new?${fixture.url}/${name}.html`, { method: 'PUT' });
  const info = (await res.json()) as { id: string };
  return info.id;
}

async function closeFixturePage(id: string): Promise<void> {
  await fetch(`${chrome.endpoint}/json/close/${id}`).catch(() => {});
}

/** Read the #log output element of a fixture page, through a fresh CDP attach. */
async function pageLogText(urlPart: string): Promise<string | null> {
  const browser = await chromium.connectOverCDP(chrome.endpoint, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(urlPart));
    if (!page) return null;
    return await page.evaluate(() => document.getElementById('log')?.textContent ?? null);
  } finally {
    await browser.close();
  }
}

// ---- required tests ----

test('mode off lists no tools', async () => {
  const home = mkHome('off');
  const s = await startServer(serverEnv(home));
  try {
    const tools = await s.client.listTools();
    assert.equal(tools.tools.length, 0);
  } finally {
    await s.close();
  }
});

test('mode shadow lists both tools with the pinned descriptions', async () => {
  const home = mkHome('shadow');
  const s = await startServer(serverEnv(home));
  try {
    const tools = await s.client.listTools();
    assert.equal(tools.tools.length, 2);
    const doTool = tools.tools.find((t) => t.name === 'wingman_do');
    const checkTool = tools.tools.find((t) => t.name === 'wingman_check');
    assert.ok(doTool, 'wingman_do missing');
    assert.ok(checkTool, 'wingman_check missing');
    assert.equal(doTool.description, WINGMAN_DO_DESCRIPTION);
    assert.equal(checkTool.description, WINGMAN_CHECK_DESCRIPTION);
    assert.deepEqual(doTool.inputSchema as unknown, { ...WINGMAN_DO_SCHEMA });
    assert.deepEqual(checkTool.inputSchema as unknown, { ...WINGMAN_CHECK_SCHEMA });
  } finally {
    await s.close();
  }
});

test('shadow wingman_check returns fallback shadow with one jev call', async () => {
  const home = mkHome('shadow');
  const stub = await startScriptedStub([{ answer: 0.87 }]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('doctor');
    try {
      const result = await callTool(s.client, 'wingman_check', {
        question: 'Is the Continue button present?',
        url_match: 'doctor.html',
      });
      assert.equal(result.status, 'fallback');
      assert.equal(result.reason, 'shadow');
      assert.equal(result.shadow, true);
      assert.equal(stub.requests.length, 1);
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('wingman_do clicks Continue and returns done', async () => {
  const home = mkHome('on');
  // Round 2 must not act again: verb 'none' plus done 0.9 ends the goal.
  const stub = await startScriptedStub([
    { targetName: 'Continue' },
    { done: 0.9, verb: 'none', targetName: 'Continue' },
  ]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('form');
    try {
      const result = await callTool(s.client, 'wingman_do', {
        goal: 'Click Continue',
        url_match: 'form.html',
      });
      assert.equal(result.status, 'done');
      assert.equal(result.reason, 'goal-met');
      assert.deepEqual(result.last_action, { verb: 'click', label: 'Continue' });
      assert.equal(await pageLogText('form.html'), 'continued');
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('wingman_do on Remove item returns needs_confirmation and nothing happens', async () => {
  const home = mkHome('on');
  const stub = await startScriptedStub([{ targetName: 'Remove item' }]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('dialog');
    try {
      const result = await callTool(s.client, 'wingman_do', {
        goal: 'Remove the item',
        url_match: 'dialog.html',
      });
      assert.equal(result.status, 'needs_confirmation');
      assert.ok(result.confirm_token, 'expected a confirm token');
      assert.ok(result.pending);
      assert.equal(result.pending?.label, 'Remove item');
      assert.equal(await pageLogText('dialog.html'), '');
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('the confirm token executes the action and the dialog leaves it blocked dialog-open', async () => {
  const home = mkHome('on');
  const stub = await startScriptedStub([{ targetName: 'Remove item' }]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('dialog');
    try {
      const first = await callTool(s.client, 'wingman_do', {
        goal: 'Remove the item',
        url_match: 'dialog.html',
      });
      assert.equal(first.status, 'needs_confirmation');
      const second = await callTool(s.client, 'wingman_do', {
        goal: 'Remove the item',
        url_match: 'dialog.html',
        confirm_token: first.confirm_token,
      });
      // The click executed: the page's confirm() dialog is now open, and the
      // loop reports it blocked dialog-open.
      assert.equal(second.status, 'blocked');
      assert.equal(second.reason, 'dialog-open');
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('a second concurrent call returns blocked busy', async () => {
  const home = mkHome('on');
  // The stub delays its answers so the first call holds the mutex.
  const stub = await startScriptedStub([
    { targetName: 'Continue', delayMs: 1500 },
    { done: 0.9, verb: 'none', targetName: 'Continue' },
  ]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('form');
    try {
      const args = { goal: 'Click Continue', url_match: 'form.html' };
      const [r1, r2] = await Promise.all([
        s.client.callTool({ name: 'wingman_do', arguments: args }),
        s.client.callTool({ name: 'wingman_do', arguments: args }),
      ]);
      const parse = (res: unknown): WingmanResult =>
        JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as WingmanResult;
      const results = [parse(r1), parse(r2)];
      const busy = results.filter((r) => r.status === 'blocked' && r.reason === 'busy');
      assert.equal(busy.length, 1, `expected exactly one blocked busy, got ${JSON.stringify(results.map((r) => [r.status, r.reason]))}`);
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('startup and tools/list never contact the browser endpoint; the first tool call does', async () => {
  // An HTTP recorder stands in for Chrome: a connect or probe would be
  // recorded, and nothing else can answer.
  const requests: string[] = [];
  const recorder = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  const recorderUrl = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`;
  // A key and stub are required: without one the loop returns fallback
  // no-key before it ever attaches, which would mask the contact assertion.
  const stub = await startScriptedStub([{ answer: 0.5 }]);
  stubUrl = stub.url;
  try {
    const home = mkHome('shadow');
    const s = await startServer(serverEnv(home, { WINGMAN_CDP_ENDPOINT: recorderUrl }));
    try {
      await s.client.listTools();
      assert.equal(requests.length, 0, 'browser endpoint was contacted before the first tool call');
      await callTool(s.client, 'wingman_check', { question: 'Anything here?', url_match: 'doctor.html' });
      assert.ok(requests.length >= 1, 'first tool call did not contact the browser endpoint');
    } finally {
      await s.close();
    }
  } finally {
    recorder.close();
    await stub.close();
  }
});

test('stdout carries only protocol frames', async () => {
  const home = mkHome('shadow');
  // A temp ESM plugin whose log writes to stdout through console.log. Without
  // main.js's console.log→stderr reroute this corrupts the protocol stream.
  const pluginFile = path.join(home, 'noisy-plugin.mjs');
  fs.writeFileSync(
    pluginFile,
    "export const wingmanPlugin = { name: 'noisy', log: (r) => console.log('noisy', r) };\n",
  );
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      mode: 'shadow',
      adapter: 'playwright',
      window: 'headless',
      profile_dir: path.join(home, 'profile'),
      port: chrome.port,
      plugin: pluginFile,
    }),
  );

  const stub = await startScriptedStub([{ answer: 0.87 }]);
  stubUrl = stub.url;

  // Raw stdio, not the SDK client: the assertion is about every byte of stdout.
  const proc = cp.spawn(process.execPath, [mainJs, 'mcp'], {
    env: serverEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutBuf: Array<string> = [];
  const stderrBuf: Array<string> = [];
  let stdoutRest = '';
  const pending = new Map<number, () => void>();
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdoutRest += chunk;
    let idx: number;
    while ((idx = stdoutRest.indexOf('\n')) !== -1) {
      const line = stdoutRest.slice(0, idx);
      stdoutRest = stdoutRest.slice(idx + 1);
      stdoutBuf.push(line);
      try {
        const parsed = JSON.parse(line) as { id?: number };
        if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
          const resolve = pending.get(parsed.id) as () => void;
          pending.delete(parsed.id);
          resolve();
        }
      } catch {
        // the assertion below reports it
      }
    }
  });
  proc.stderr.on('data', (chunk: string) => stderrBuf.push(chunk));

  const send = (obj: unknown) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitResponse = (id: number) =>
    new Promise<void>((resolve) => {
      pending.set(id, resolve);
    });

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'purity-test', version: '0.0.0' } },
    });
    await waitResponse(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wingman_check', arguments: { question: 'Is this page open?', url_match: 'doctor.html' } } });
    await waitResponse(2);
  } finally {
    proc.kill();
  }

  const stderrText = stderrBuf.join('');
  assert.ok(stderrText.includes('noisy'), 'plugin console.log output did not reach stderr');
  // Every complete stdout line must parse as JSON-RPC — nothing else may
  // touch the stream.
  assert.ok(stdoutBuf.length >= 2, `expected protocol frames on stdout, got ${JSON.stringify(stdoutBuf)} rest=${JSON.stringify(stdoutRest)}`);
  assert.equal(stdoutRest, '', 'unterminated stdout remainder after the last frame');
  for (const line of stdoutBuf) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(parsed.jsonrpc, '2.0', `non-protocol stdout line: ${line}`);
  }
  await stub.close();
});
