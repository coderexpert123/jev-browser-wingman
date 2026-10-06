// r24c cross-call redaction, end to end (spec .build-r24c-redaction-spec.md § 4).
// The server under test is the real built CLI (`node <this build>/src/cli/main.js mcp`)
// spawned through the SDK's StdioClientTransport with a temp WINGMAN_HOME, one
// server for all three calls (the process-lifetime value memory is what is
// under test); the shared browser comes from launchTestChrome via
// WINGMAN_CDP_ENDPOINT and the decision service from startTypeSafeStub, whose
// recorded request bodies are the only wire evidence the Jev boundary has.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchTestChrome } from './helpers/chrome.js';
import { fillDefaultAnswers, startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';
import type { WingmanResult } from '../src/contract/types.js';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

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

// ---- harness (copied from browse-step-surface.test.ts) ----

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-redaction-e2e-'));
  const config = {
    mode,
    adapter: 'playwright',
    window: 'headless',
    profile_dir: path.join(home, 'profile'),
    port: chrome.port,
    ...extraConfig,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function serverEnv(home: string, stubUrl: string): Record<string, string> {
  return {
    ...scrubEnv(),
    WINGMAN_HOME: home,
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
  };
}

interface ServerHandle {
  client: Client;
  close(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<ServerHandle> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
  const client = new Client({ name: 'wingman-redaction-e2e', version: '0.0.0' });
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

// ---- the test ----

test('r24c e2e: a value bound in call 1 is redacted in later calls on the same server (log and wire)', async () => {
  const home = mkHome('shadow', { handoff: { mode: 'optional' } });
  // right_page and ready are inverted nouls (low = "not yet"): chain rounds need them high.
  // Every other question gets fillDefaultAnswers' neutral default.
  const stub = await startTypeSafeStub((body) => {
    const q = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>;
    const answers: Record<string, unknown> = {};
    if ('right_page' in q) answers.right_page = { type: 'noul', noul: 0.95 };
    if ('ready' in q) answers.ready = { type: 'noul', noul: 0.95 };
    if ('answer' in q) answers.answer = { type: 'noul', noul: 0.5 };
    return { status: 200, body: { answers: fillDefaultAnswers(q, answers), usage: {} } };
  });
  const SECRET = 'zqx-oat-milk-77';
  const s = await startServer(serverEnv(home, stub.url));
  try {
    const pageId = await openFixturePage('inputs');
    try {
      const call1 = await callTool(s.client, 'browse_step', {
        goal: 'r24c e2e bind',
        steps: ['type the value named secret into the number field'],
        values: { secret: SECRET },
        url_match: 'inputs.html',
      });
      assert.notEqual(call1.status, 'ambiguous', 'precondition: call 1 status !== ambiguous (one visible page)');
      const n1 = stub.requests.length;
      const call2 = await callTool(s.client, 'browse_step', {
        goal: 'r24c e2e later',
        steps: ['find ' + SECRET + ' on the page'],
        url_match: 'inputs.html',
      });
      assert.notEqual(call2.status, 'ambiguous', 'precondition: call 2 status !== ambiguous');
      const n2 = stub.requests.length;
      const call3 = await callTool(s.client, 'wingman_check', {
        question: 'Is ' + SECRET + ' shown?',
        url_match: 'inputs.html',
      });
      assert.notEqual(call3.status, 'ambiguous', 'precondition: call 3 status !== ambiguous');
      assert.ok(n2 > n1, 'call 2 reached the wire');
      assert.ok(stub.requests.length > n2, 'call 3 reached the wire');

      const bodies = (stub.requests as Array<{ body: { state?: { step?: string }; questions?: Record<string, { instructions?: string }> } }>).map(
        (r) => r.body,
      );
      for (const b of bodies.slice(n1)) {
        assert.equal(JSON.stringify(b).toLowerCase().includes(SECRET), false, 'a later request body carries the value');
      }
      assert.ok(
        bodies.slice(n1, n2).some((b) => b.state?.step === 'find <value:secret> on the page'),
        'call 2 carries the redacted step text',
      );
      assert.ok(
        bodies.slice(n2).some((b) => (b.questions?.answer?.instructions ?? '').includes('<value:secret>')),
        'call 3 carries the redacted check question',
      );

      const lines = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      assert.equal(lines[1].toLowerCase().includes(SECRET), false, 'log line 2 carries the value');
      assert.equal(lines[2].toLowerCase().includes(SECRET), false, 'log line 3 carries the value');
      assert.deepEqual(JSON.parse(lines[1]).step_texts, ['find <value:secret> on the page']);
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});
