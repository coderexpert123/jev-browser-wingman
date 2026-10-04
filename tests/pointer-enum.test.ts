// pointer-enum E2E (r21 P-5, spec .build-r21-spec.md D11; Chrome file).
// The server under test is the real built CLI (`node <this build>/src/cli/main.js
// mcp`) spawned in the chain-e2e style: a temp WINGMAN_HOME, the shared
// headless Chrome via WINGMAN_CDP_ENDPOINT, and the decision service from
// startTypeSafeStub. The config has mode 'on' and NO handoff key, so it runs
// forced (§ 5.3).
//
// Two pins over fixtures/pages/pointer-interactive.html (the D11 fixture: two
// real menu items interactive through a root-delegated listener on #app
// alone — no onclick, no role — plus two pure pointer-styled decoy divs
// outside #app):
// - VALUE pin: with the heuristic ACTIVE (`var KB_CURSOR_POINTER = false`,
//   shipped polarity), browse_step `steps: ['click Save']` ends done and the
//   page's #log reads 'saved'. Flip tooth: with `KB_CURSOR_POINTER = true`
//   (the mutant flip = restore pre-P-5 enumerate) Save never enumerates, the
//   stub's target question carries no Save candidate, the call bounces
//   no-match and this pin reads red — proven by the WP-2 flip run, recorded
//   in the WP report.
// - DECOY DOCUMENTATION pin: the raw enumerate expression on the fixture
//   includes BOTH decoy divs when ACTIVE (asserted by count, exactly one
//   record each, div/button) — page-side they are indistinguishable from the
//   real items. This pin RECORDS the known over-enumeration instead of
//   hiding it; it is the number the D12 live-inflation bar reasons about.
//   It also doubles as the T-pointer-role pin (the Save/Cancel divs carry
//   role 'button' and non-empty names with the heuristic active).

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
import { buildEnumerateExpression } from '../src/core/page-scripts.js';
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

// ---- harness (chain-e2e pattern) ----

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-pointer-enum-'));
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

async function startServer(stubUrl: string): Promise<{ client: Client; close(): Promise<void> }> {
  const env: Record<string, string> = {
    ...scrubEnv(),
    WINGMAN_HOME: mkHome(),
    WINGMAN_CDP_ENDPOINT: chrome.endpoint,
    TYPESAFE_API_KEY: 'dummy-key',
    TYPESAFE_BASE_URL: stubUrl,
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
  const client = new Client({ name: 'wingman-pointer-enum', version: '0.0.0' });
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
  // The /json/new target exists before the navigation commits (the chain-e2e
  // E1 flake shape): wait until the target shows the fixture URL AND a parsed
  // <title> before any loop attach enumerates it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const list = (await (await fetch(`${chrome.endpoint}/json/list`)).json()) as Array<{
      id: string;
      url: string;
      title: string;
    }>;
    const t = list.find((p) => p.id === info.id);
    if ((t && t.url.startsWith(`${fixture.url}/${name}.html`) && t.title !== '') || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return info.id;
}

async function closeFixturePage(id: string): Promise<void> {
  await fetch(`${chrome.endpoint}/json/close/${id}`).catch(() => {});
}

/** Raw enumerate on the fixture page, through a fresh CDP attach (main world). */
async function rawEnumerate(
  urlPart: string,
  opts: { maxElements: number; maxTextChars: number },
): Promise<{ elements: Array<Record<string, unknown>> }> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(chrome.endpoint, { noDefaults: true });
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages().find((p) => p.url().includes(urlPart));
    assert.ok(page, `a ${urlPart} page is open`);
    const expr = buildEnumerateExpression(opts);
    return (await page.evaluate(`(() => { return (${expr}); })()`)) as {
      elements: Array<Record<string, unknown>>;
    };
  } finally {
    await browser.close();
  }
}

/** Read a main-world value from the fixture page, through a fresh CDP attach. */
async function pageEval(urlPart: string, fn: () => unknown): Promise<unknown> {
  const { chromium } = await import('playwright-core');
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

// ---- the deterministic stub policy ----

interface StubQuestion {
  type: string;
  criteria?: Record<string, string>;
}

function findId(target: StubQuestion | undefined, regex: RegExp): string | null {
  for (const [id, text] of Object.entries(target?.criteria ?? {})) {
    if (regex.test(text)) return id;
  }
  return null;
}

async function startPointerStub(): Promise<Awaited<ReturnType<typeof startTypeSafeStub>>> {
  return startTypeSafeStub((body) => {
    const state = (body.state ?? {}) as {
      step?: string;
      history?: Array<{ verb: string; label: string }>;
      url?: string;
      title?: string;
      elements?: Array<unknown>;
    };
    const q = (body.questions ?? {}) as Record<string, StubQuestion>;
    const step = state.step ?? '';
    const history = state.history ?? [];
    const answers: Record<string, unknown> = {};

    const noul = (key: string, v: number): void => {
      if (key in q) answers[key] = { type: 'noul', noul: v };
    };
    const cho = (key: string, c: string, probs: Record<string, number>): void => {
      if (key in q) answers[key] = { type: 'choice', choice: c, probabilities: probs, confidence: 0.9 };
    };
    const clickOn = (regex: RegExp): boolean => {
      const id = findId(q.target, regex);
      if (id === null) return false;
      cho('action', 'click', { click: 0.9, none: 0.05 });
      cho('target', id, { [id]: 0.9, none: 0.05, ambiguous: 0.05 });
      return true;
    };

    // Defaults: quiet Nouls, ready and right_page high on every round (the
    // fillDefaultAnswers low-default trap for right_page/ready — see the
    // forced-handoff gotchas).
    for (const [key, v] of Object.entries({
      done: 0.05, blocked: 0.05, login: 0.05, error: 0.05, irreversible: 0.05,
      step_done: 0.05, right_page: 0.95, ready: 0.95,
    })) {
      noul(key, v);
    }

    if (step.includes('click Save')) {
      // FLIP TOOTH: when Save never enumerates (KB_CURSOR_POINTER = true),
      // clickOn finds no matching criterion, answers nothing for
      // action/target, and fillDefaultAnswers' 0.05 defaults leave the round
      // non-committing — the call bounces no-match and the value pin is red.
      const clicked = history.some((h) => h.verb === 'click' && /Save/.test(h.label));
      if (clicked) {
        noul('step_done', 0.95);
      } else {
        clickOn(/button "Save"/);
      }
    }
    return { status: 200, body: { answers: fillDefaultAnswers(q, answers), usage: {} } };
  });
}

// VALUE pin (D11): with the heuristic ACTIVE the delegated-listener div is a
// real target — the call commits the click, the page's own listener runs, and
// the chain advances on the observed change.
test('click Save on pointer-interactive.html ends done and the page logs saved', async () => {
  const stub = await startPointerStub();
  const s = await startServer(stub.url);
  const pageId = await openFixturePage('pointer-interactive');
  try {
    const res = await callTool(s.client, {
      goal: 'pointer value pin: save the menu choice',
      steps: ['click Save'],
      url_match: 'pointer-interactive.html',
    });
    assert.equal(res.status, 'done', `expected done, got ${res.status}/${String(res.reason)}`);
    const log = await pageEval('pointer-interactive.html', () =>
      document.getElementById('log')?.textContent ?? null,
    );
    assert.equal(log, 'saved', 'the delegated listener fired: #log reads saved');
  } finally {
    await s.close();
    await stub.close();
    await closeFixturePage(pageId);
  }
});

// DECOY DOCUMENTATION pin + T-pointer-role (D11/D10): the raw enumerate
// includes BOTH decoys (over-enumeration recorded, by count) and the real
// items carry role button with non-empty names.
test('enumerate lists the decoy divs and roles the real items button (heuristic ACTIVE)', async () => {
  const pageId = await openFixturePage('pointer-interactive');
  try {
    const obs = await rawEnumerate('pointer-interactive.html', { maxElements: 240, maxTextChars: 3000 });
    const byName = (name: string): Array<Record<string, unknown>> =>
      obs.elements.filter((e) => e.name === name);
    for (const name of ['Save', 'Cancel', 'Decoy one', 'Decoy two']) {
      const recs = byName(name);
      assert.strictEqual(recs.length, 1, `exactly one record named ${name}`);
      assert.strictEqual(recs[0]!.tag, 'div', `${name} is a div record`);
      assert.strictEqual(recs[0]!.role, 'button', `${name} carries role button (heuristic ACTIVE)`);
      assert.ok(String(recs[0]!.name).length > 0, `${name} has a non-empty name`);
    }
    // The decoys enumerate — recorded over-enumeration, asserted by count.
    assert.strictEqual(byName('Decoy one').length + byName('Decoy two').length, 2, 'both decoys enumerate');
  } finally {
    await closeFixturePage(pageId);
  }
});
