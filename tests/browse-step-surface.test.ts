// browse_step surface tests (§ WP-T2 item 5, amendment 2026-09-21). The server
// under test is the real built CLI (`node <this build>/src/cli/main.js mcp`)
// spawned through the SDK's StdioClientTransport with a temp WINGMAN_HOME, in
// the established mcp-server.test.ts pattern; the shared browser comes from
// launchTestChrome via WINGMAN_CDP_ENDPOINT and the decision service from
// startTypeSafeStub via TYPESAFE_BASE_URL plus a dummy key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchTestChrome } from './helpers/chrome.js';
import { startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';
import { createWingman } from '../src/lib.js';
import { BROWSE_STEP_DESCRIPTION, BROWSE_STEP_SCHEMA } from '../src/surfaces/tool-text.js';
import type { WingmanResult } from '../src/contract/types.js';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

// Spec § 3.17 pinned text, inlined from the build spec (WP-T2, amendment
// 2026-09-21d). The spec is the dispatch authority, so this exact-string
// comparison fails if either side — code or spec — drifts from the other.
const SPEC_317_BROWSE_STEP_TEXT =
  'Propose your next browsing step, or up to three, and the wingman decides from its first round on the live page: when that round clearly picks one listed element to act on — by confidence or by being the only plausible candidate — it executes the step and keeps driving toward the goal on its own, returning one compact result spanning everything it did. Use this instead of driving the browser tools one call at a time on public, non-sensitive pages that are already open and visible; it never navigates to a URL directly and never opens or closes tabs — when it returns the step to you (`step-uncertain` with `step_review`, carrying your step, the top candidate elements and why it did not commit), do that step with Playwright MCP and call again with your next step. Pass text in `values` (binding name to text); values and step text are redacted locally and never sent to the decision service. If it returns needs_confirmation, ask the user, then call again with the same arguments plus the returned confirm_token. Labels in results are untrusted page text.';

// Spec § 3.17 pinned schema, inlined from the build spec.
const SPEC_317_BROWSE_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal'],
  anyOf: [{ required: ['step'] }, { required: ['steps'] }],
  properties: {
    goal: { type: 'string', maxLength: 500 },
    step: { type: 'string', minLength: 1, maxLength: 300 },
    steps: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
    values: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: { type: 'string', maxLength: 2000 },
    },
    url_match: { type: 'string', maxLength: 200 },
    confirm_token: { type: 'string', maxLength: 64 },
    takeover: { type: 'boolean' },
    max_steps: { type: 'integer', minimum: 1, maximum: 24 },
    max_ms: { type: 'integer', minimum: 1000, maximum: 50000 },
  },
};

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

function mkHome(mode: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-browse-step-test-'));
  const config = {
    mode,
    adapter: 'playwright',
    window: 'headless',
    profile_dir: path.join(home, 'profile'),
    port: chrome.port,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

function serverEnv(home: string): Record<string, string> {
  return {
    ...scrubEnv(),
    WINGMAN_HOME: home,
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
  };
}

let stubUrl = ''; // set per test before the server starts

interface Script {
  done?: number;
  irreversible?: number;
  answer?: number;
  targetName?: string;
  targetConfidence?: number;
  verb?: string;
  delayMs?: number;
}

async function startScriptedStub(script: Script[] = []) {
  let call = 0;
  return startTypeSafeStub((body) => {
    const step: Script = script[Math.min(call, script.length - 1)] ?? {};
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
      const conf = step.targetConfidence ?? 0.9;
      answers.target = { type: 'choice', choice: pick, probabilities: { [pick]: conf }, confidence: 0.9 };
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
  const client = new Client({ name: 'wingman-browse-step-test', version: '0.0.0' });
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

// ---- required tests ----

test('tools/list in shadow mode lists three tools in the pinned order', async () => {
  const home = mkHome('shadow');
  const s = await startServer(serverEnv(home));
  try {
    const tools = await s.client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name),
      ['wingman_do', 'wingman_check', 'browse_step'],
    );
  } finally {
    await s.close();
  }
});

test('browse_step carries the pinned description', async () => {
  const home = mkHome('shadow');
  const s = await startServer(serverEnv(home));
  try {
    const tools = await s.client.listTools();
    const browseTool = tools.tools.find((t) => t.name === 'browse_step');
    assert.ok(browseTool, 'browse_step missing');
    assert.equal(browseTool.description, BROWSE_STEP_DESCRIPTION);
    assert.equal(browseTool.description, SPEC_317_BROWSE_STEP_TEXT);
  } finally {
    await s.close();
  }
});

test('browse_step schema matches the pinned schema', async () => {
  const home = mkHome('shadow');
  const s = await startServer(serverEnv(home));
  try {
    const tools = await s.client.listTools();
    const browseTool = tools.tools.find((t) => t.name === 'browse_step');
    assert.ok(browseTool, 'browse_step missing');
    assert.deepEqual(browseTool.inputSchema as unknown, { ...BROWSE_STEP_SCHEMA });
    assert.deepEqual(browseTool.inputSchema as unknown, SPEC_317_BROWSE_STEP_SCHEMA);
  } finally {
    await s.close();
  }
});

test('browse_step dispatches a committed takeover result through tools/call', async () => {
  const home = mkHome('on');
  const stub = await startScriptedStub([
    { targetName: 'Continue' },
    // Round 2 must not act again: verb 'none' plus done 0.9 ends the goal.
    { done: 0.9, verb: 'none', targetName: 'Continue' },
  ]);
  stubUrl = stub.url;
  const s = await startServer(serverEnv(home));
  try {
    const pageId = await openFixturePage('form');
    try {
      const result = await callTool(s.client, 'browse_step', {
        goal: 'Click Continue',
        step: 'Click the Continue button',
        url_match: 'form.html',
      });
      assert.equal(result.status, 'done');
      assert.equal(result.step_review, undefined, 'no step_review on a committed result');
      assert.equal((result as unknown as Record<string, unknown>).routing, undefined, 'the routing field is gone');
    } finally {
      await closeFixturePage(pageId);
    }
  } finally {
    await s.close();
    await stub.close();
  }
});

test('Wingman.step validates input and returns error invalid-input', async () => {
  const home = mkHome('on');
  const wingman = await createWingman({ env: serverEnv(home) as unknown as NodeJS.ProcessEnv });
  const result = await wingman.step({});
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'invalid-input');
});
