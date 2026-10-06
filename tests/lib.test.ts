// r24b (O1 b): the WINGMAN_LOG_LABELS env flag reaches the loop through the real
// createWingman wiring (src/lib.ts), so the page title lands in log.jsonl only
// when the flag is exactly '1'.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWingman } from '../src/lib.js';
import { FakeDriver } from './helpers/fake-driver.js';
import type { JevAsk, JevRequest, Observation, PageInfo } from '../src/contract/types.js';

const cleanSignals = {
  password: false,
  currentPassword: false,
  newPassword: false,
  otpAutocomplete: false,
  ccAutocomplete: false,
  otpText: false,
  captcha: false,
};

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: 'https://example.com/list',
    title: 'List',
    elements: [],
    forms: [],
    signals: { ...cleanSignals },
    text: 'plain page text',
    truncated: false,
    ...overrides,
  };
}

function page(): PageInfo {
  return { id: 'p1', url: 'https://example.com/list', title: 'List', visible: true };
}

const failingAsk: JevAsk = async () => ({ ok: false, error: 'network', latencyMs: 1, retries: 0 });

/** Runs one wingman_do through createWingman and returns the title of the logged round 0 (or the absence of it). */
async function runOnce(extraEnv: Record<string, string>, goal: string): Promise<{ hasTitle: boolean; title?: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-lib-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mode: 'on' }));
    const driver = new FakeDriver({ pages: [page()], observations: { p1: [observation({ title: 'Home' })] } });
    const env = { WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: 'http://127.0.0.1:9222', TYPESAFE_API_KEY: 'k', ...extraEnv };
    const w = await createWingman({ env, driver, ask: failingAsk });
    await w.do({ goal });
    const lines = fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    const round = rec.phases.rounds[0];
    return { hasTitle: 'title' in round, title: round.title };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('lib: WINGMAN_LOG_LABELS=1 puts the page title in the log; absent or 0 keeps it out', async () => {
  const on = await runOnce({ WINGMAN_LOG_LABELS: '1' }, 'r24b lib wiring goal on');
  assert.equal(on.hasTitle, true);
  assert.equal(on.title, 'Home');
  const off = await runOnce({}, 'r24b lib wiring goal off');
  assert.equal(off.hasTitle, false);
  const zero = await runOnce({ WINGMAN_LOG_LABELS: '0' }, 'r24b lib wiring goal zero');
  assert.equal(zero.hasTitle, false);
});

test('lib: a value bound through one createWingman instance is redacted in a later instance (one memory per process)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-lib-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mode: 'on' }));
    const env = { WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: 'http://127.0.0.1:9222', TYPESAFE_API_KEY: 'k' };
    const requests: JevRequest[] = [];
    const recordingAsk: JevAsk = async (request) => {
      requests.push(request);
      return { ok: false, error: 'network', latencyMs: 1, retries: 0 };
    };
    const d1 = new FakeDriver({ pages: [page()], observations: { p1: [observation({ title: 'Home' })] } });
    const w1 = await createWingman({ env, driver: d1, ask: recordingAsk });
    await w1.do({ goal: 'r24c lib bind goal', values: { item: 'zqlib-oat-41' } });
    const n = requests.length;
    const d2 = new FakeDriver({
      pages: [page()],
      observations: { p1: [observation({ title: 'List zqlib-oat-41', text: 'item zqlib-oat-41' })] },
    });
    const w2 = await createWingman({ env, driver: d2, ask: recordingAsk });
    await w2.do({ goal: 'r24c lib later goal zqlib-oat-41' });
    assert.ok(requests.length > n, 'the later instance reached the wire');
    for (const req of requests.slice(n)) {
      assert.equal(JSON.stringify(req).toLowerCase().includes('zqlib-oat-41'), false);
    }
    assert.ok(JSON.stringify(requests[n]).includes('<value:item>'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
