// pick E2E (spec 2026-09-26-wingman-forced-handoff § 6 WP-D D3; Chrome file).
// The server under test is the real built CLI (`node <this build>/src/cli/main.js
// mcp`) spawned in the mcp-server.test.ts style: a temp WINGMAN_HOME, the shared
// headless Chrome via WINGMAN_CDP_ENDPOINT, and the decision service from
// startTypeSafeStub. The config has mode 'on' and NO handoff key, so it runs
// forced (§ 5.3: key absent loads {mode:'forced', tools:'browse-only'}).
//
// P1: an ambiguous target bounces step-uncertain with candidateOf evidence and
// the forced bounce note; the follow-up call with `pick` fills the field and
// finishes done with the stub contacted exactly once more (a pick round makes
// no decision-service call).
// P2: a pick onto an obscured element returns fallback/target-covered with the
// log unchanged and zero stub requests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { launchTestChrome } from './helpers/chrome.js';
import { fillDefaultAnswers, startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';
import type { WingmanResult } from '../src/contract/types.js';

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

// § 5.5.5 FORCED_BOUNCE_LINE, inlined from the spec (the spec is the dispatch
// authority; this exact-string comparison fails if either side drifts).
const FORCED_BOUNCE_LINE =
  'Step returned to you. Call browse_step again with the same goal, steps and values plus pick: { role, name, action } naming the element to use (from step_review.candidates, or from your own snapshot or screenshot), or with a more specific step.';

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

function mkHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-pick-e2e-'));
  // No handoff key: with mode 'on' this loads forced (§ 5.3).
  const config = {
    mode: 'on',
    adapter: 'cdp',
    window: 'headless',
    profile_dir: path.join(home, 'profile'),
    port: chrome.port,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}

interface ServerHandle {
  client: Client;
  close(): Promise<void>;
}

async function startServer(home: string, stubUrl: string): Promise<ServerHandle> {
  const env: Record<string, string> = {
    ...scrubEnv(),
    WINGMAN_HOME: home,
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
  const client = new Client({ name: 'wingman-pick-e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function callTool(client: Client, args: Record<string, unknown>): Promise<WingmanResult> {
  const res = (await client.callTool({ name: 'browse_step', arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.notEqual(res.isError, true, 'browse_step returned isError for a status result');
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

/** Read a main-world value from a fixture page, through a fresh CDP attach. */
async function pageEval(urlPart: string, fn: () => unknown): Promise<unknown> {
  const browser = await chromium.connectOverCDP(chrome.endpoint, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(urlPart));
    if (!page) return null;
    return await page.evaluate(fn);
  } finally {
    await browser.close();
  }
}

// P1 stub. Request phasing: call 1 is chain rounds 1 and 2 (the non-commit
// retries once, § 5.5.2 rule 9); each round asks action (+chain Nouls) in
// request 1 and target in request 2, so call 1 owns requests 0..3. Call 2 is
// the pick round (no request) plus ONE round-2 request whose action is
// targetless `none` — request 2 is skipped (§ 5.5.2 rule 6) and the advance on
// step_done fires from request-1 answers — so phase B starts at request 4.
async function startPickStub(): Promise<Awaited<ReturnType<typeof startTypeSafeStub>>> {
  let reqNo = 0;
  return startTypeSafeStub((body) => {
    const phaseB = reqNo >= 4;
    reqNo += 1;
    const q = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>;
    const answers: Record<string, unknown> = {};
    const noulDefaults: Record<string, number> = {
      done: 0.05, blocked: 0.05, login: 0.05, error: 0.05, irreversible: 0.05,
      step_done: 0.05, right_page: 0.95, ready: 0.95, recover: 0.05,
    };
    for (const [key, dflt] of Object.entries(noulDefaults)) {
      if (key in q) {
        answers[key] = { type: 'noul', noul: key === 'step_done' && phaseB ? 0.95 : dflt };
      }
    }
    if ('action' in q) {
      const verb = phaseB ? 'none' : 'fill';
      answers.action = { type: 'choice', choice: verb, probabilities: { [verb]: 0.9 }, confidence: 0.9 };
    }
    if ('target' in q) {
      // Call 1, both rounds: ambiguous 0.4 tops the map, the Full name and
      // Email ids sit at 0.3 — below threshold and below the margin rule, so
      // the target never commits and the round non-commits.
      const criteria = q.target?.criteria ?? {};
      const probabilities: Record<string, number> = {};
      for (const [id, text] of Object.entries(criteria)) {
        if (/full name/i.test(text)) probabilities[id] = 0.3;
        if (/^Email/.test(text)) probabilities[id] = 0.3;
      }
      probabilities.ambiguous = 0.4;
      answers.target = {
        type: 'choice',
        choice: 'ambiguous',
        probabilities,
        confidence: 0.4,
      };
    }
    // Every other question the request asks (key and value are always
    // possible in this flow — the fill never actually reaches the stub, but
    // the request still carries the questions) gets a neutral default so
    // parseJevAnswers never rejects the response as invalid.
    return { status: 200, body: { answers: fillDefaultAnswers(q, answers), usage: {} } };
  });
}

test('P1: ambiguous target bounces with candidates, then pick fills and finishes done', async () => {
  const stub = await startPickStub();
  const home = mkHome();
  const s = await startServer(home, stub.url);
  const pageId = await openFixturePage('form');
  try {
    // Call 1: no pick. The target is ambiguous, so the call bounces.
    const res1 = await callTool(s.client, {
      goal: 'Enter the full name',
      steps: ['type the value named full_name into Full name'],
      values: { full_name: 'Jane Doe' },
      url_match: 'form.html',
    });
    assert.equal(res1.status, 'fallback');
    assert.equal(res1.reason, 'step-uncertain');
    const candidates = res1.step_review?.candidates ?? res1.candidates ?? [];
    assert.ok(candidates.length > 0, 'bounce carries candidates');
    for (const c of candidates) {
      assert.equal(typeof c.role, 'string');
      assert.ok(c.role && c.role.length > 0, `candidate role present: ${JSON.stringify(c)}`);
      assert.equal(typeof c.name, 'string');
      assert.ok(c.name && c.name.length > 0, `candidate name present: ${JSON.stringify(c)}`);
    }
    assert.ok(
      candidates.some((c) => c.role === 'textbox' && c.name === 'Full name'),
      `candidates include the Full name textbox: ${JSON.stringify(candidates)}`,
    );
    assert.equal(res1.note, FORCED_BOUNCE_LINE);
    const requestsAfterCall1 = stub.requests.length;
    assert.ok(requestsAfterCall1 > 0, 'call 1 reached the decision service');

    // Call 2: same arguments plus pick. The pick round sends nothing to the
    // stub; the chain then advances on step_done 0.95 and finishes done.
    const res2 = await callTool(s.client, {
      goal: 'Enter the full name',
      steps: ['type the value named full_name into Full name'],
      values: { full_name: 'Jane Doe' },
      url_match: 'form.html',
      pick: { role: 'textbox', name: 'Full name', action: 'fill', value: 'full_name' },
    });
    assert.equal(res2.status, 'done');
    assert.equal(res2.steps, 1);
    assert.equal(stub.requests.length - requestsAfterCall1, 1, 'call 2 contacted the stub exactly once');
    const filled = await pageEval('form.html', () =>
      (document.getElementById('fullname') as HTMLInputElement | null)?.value,
    );
    assert.equal(filled, 'Jane Doe');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

test('P2: a pick onto an obscured element returns target-covered with no act and no ask', async () => {
  const stub = await startTypeSafeStub(() => {
    throw new Error('P2 must send nothing to the decision service');
  });
  const home = mkHome();
  const s = await startServer(home, stub.url);
  const pageId = await openFixturePage('overlay');
  try {
    const res = await callTool(s.client, {
      goal: 'Open the details',
      pick: { role: 'button', name: 'Show details', action: 'click' },
      url_match: 'overlay.html',
    });
    assert.equal(res.status, 'fallback');
    assert.equal(res.reason, 'target-covered');
    assert.equal(res.step_review?.why, 'target-covered');
    const log = await pageEval('overlay.html', () => document.getElementById('log')?.textContent ?? null);
    // The fixture's <output id="log"></output> starts as '' (element present,
    // no text), not null — null would mean the element itself is missing.
    assert.equal(log, '', 'the covered button was not clicked; the log is unchanged');
    assert.equal(stub.requests.length, 0, 'a pick round sends nothing to the stub');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});
