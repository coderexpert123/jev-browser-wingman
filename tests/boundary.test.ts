// Security-boundary tests (§ WP-C7): values, URLs and page content never leak
// past the ask or the log record; irreversible actions gate; tokens are
// single-use; shadow mode never acts.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDo, type LoopDeps } from '../src/core/loop.js';
import { FakeDriver } from './helpers/fake-driver.js';
import { ConfirmTokenStore } from '../src/core/tokens.js';
import { createMutex } from '../src/core/mutex.js';
import { assertNoValues } from '../src/core/withhold.js';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type {
  ElementRecord,
  JevAnswer,
  JevAsk,
  JevRequest,
  Observation,
  PageInfo,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../src/contract/types.js';

// ---- fixtures (same shapes as loop.test.ts) ----

function el(overrides: Partial<ElementRecord> = {}): ElementRecord {
  return {
    id: 'e1',
    path: '#e1',
    tag: 'button',
    role: 'button',
    name: 'Details',
    type: 'button',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false },
    editable: false,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'button', role: 'button', name: 'Details', x: 0, y: 0 },
    ...overrides,
  };
}

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
    elements: [el()],
    forms: [],
    signals: { ...cleanSignals },
    text: 'plain page text',
    truncated: false,
    ...overrides,
  };
}

function page(overrides: Partial<PageInfo> = {}): PageInfo {
  return { id: 'p1', url: 'https://example.com/list', title: 'List', visible: true, ...overrides };
}

function makeConfig(overrides: Partial<WingmanConfig> = {}): WingmanConfig {
  return {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    profile_dir: path.join(os.tmpdir(), 'jevw-c7-profile'),
    port: 9222,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
    ...overrides,
  };
}

type NoulAnswers = { done?: number; blocked?: number; login?: number; error?: number; irreversible?: number };
type ChoiceAnswers = {
  action?: [string, Record<string, number>];
  target?: [string, Record<string, number>];
  value?: [string, Record<string, number>];
};
type SeqEntry = (NoulAnswers & ChoiceAnswers) | { fail: string };

function choice(c: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: c, probabilities, confidence: 0.9 };
}

function S(over: SeqEntry = {}): SeqEntry {
  return {
    done: 0.05,
    blocked: 0.05,
    login: 0.05,
    irreversible: 0.05,
    action: ['click', { click: 0.9, none: 0.05 }],
    target: ['e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }],
    ...over,
  };
}

function scriptedAsk(seq: SeqEntry[]): { ask: JevAsk; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  let call = 0;
  const ask: JevAsk = async (request) => {
    requests.push(request);
    const step = seq[Math.min(call, seq.length - 1)];
    call += 1;
    if ('fail' in step) {
      return { ok: false, error: step.fail as never, latencyMs: 1, retries: 0 };
    }
    const answers: Record<string, JevAnswer> = {};
    for (const key of ['done', 'blocked', 'login', 'error', 'irreversible'] as const) {
      if (step[key] !== undefined) answers[key] = { type: 'noul', noul: step[key] as number };
    }
    for (const key of ['action', 'target', 'value'] as const) {
      const spec = step[key];
      if (spec) answers[key] = choice(spec[0], spec[1]);
    }
    return {
      ok: true,
      answers,
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
      status: 200,
      retries: 0,
    };
  };
  return { ask, requests };
}

interface Harness {
  driver: FakeDriver;
  records: WingmanLogRecord[];
  requests: JevRequest[];
  tokens: ConfirmTokenStore;
  deps: LoopDeps;
  call: (input: unknown) => Promise<WingmanResult>;
}

function harness(opts: {
  pages?: PageInfo[];
  observations: Record<string, Observation[]>;
  script: SeqEntry[];
  config?: Partial<WingmanConfig>;
  forceMode?: 'shadow';
  lockCheck?: () => Promise<{ ok: true } | { ok: false; reason: 'lock-held' }>;
}): Harness {
  const driver = new FakeDriver({ pages: opts.pages ?? [page()], observations: opts.observations });
  const { ask, requests } = scriptedAsk(opts.script);
  const records: WingmanLogRecord[] = [];
  const tokens = new ConfirmTokenStore();
  const deps: LoopDeps = {
    config: makeConfig(opts.config),
    driverFactory: () => driver,
    resolveEndpoint: async () => 'http://127.0.0.1:9222',
    ask,
    ...(opts.lockCheck ? { lockCheck: opts.lockCheck } : {}),
    mutex: createMutex(),
    tokens,
    writeLog: async (r) => {
      records.push(r);
    },
    ...(opts.forceMode ? { forceMode: opts.forceMode } : {}),
  };
  return {
    driver,
    records,
    requests,
    tokens,
    deps,
    call: (input: unknown) => runDo(input, deps),
  };
}

// ---- required tests ----

test('binding values never reach ask, even when the page echoes them', async () => {
  const values = { email: 'SECRETVALUE@mail.com' };
  const h = harness({
    observations: {
      p1: [
        observation({
          title: `Mail SECRETVALUE@mail.com`,
          text: `Contact SECRETVALUE@mail.com today`,
          elements: [el({ tag: 'input', role: 'textbox', name: 'Email SECRETVALUE@mail.com', editable: true })],
        }),
      ],
    },
    script: [S({ action: ['fill', { fill: 0.9, click: 0.05 }], value: ['email', { email: 0.9, none: 0.05 }] }), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'Fill the email', values });
  assert.equal(r.status, 'done');
  assert.ok(h.requests.length >= 2);
  for (const request of h.requests) {
    // A planted leak throws; this is the § 8 value-withholding instrument.
    assertNoValues(JSON.stringify(request), values);
  }
});

test('query strings and fragments never reach ask', async () => {
  const h = harness({
    observations: { p1: [observation({ url: 'https://example.com/list?token=SECRET123#section' })] },
    script: [S(), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'done');
  assert.ok(h.requests.length >= 2);
  for (const request of h.requests) {
    const serialized = JSON.stringify(request);
    assert.equal(serialized.includes('SECRET123'), false);
    assert.equal(serialized.includes('?token'), false);
    assert.equal(serialized.includes('#section'), false);
  }
  const state = h.requests[0].state as { url: string };
  assert.equal(state.url, 'https://example.com/list');
});

test('a sensitive host falls back before any ask', async () => {
  const h = harness({
    observations: { p1: [observation({ url: 'https://badsite.example/page' })] },
    script: [S()],
    config: { sensitive_hosts: { banking: ['badsite.example'] } },
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-banking');
  assert.equal(h.requests.length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

test('a password field falls back before any ask', async () => {
  const h = harness({
    observations: { p1: [observation({ signals: { ...cleanSignals, password: true } })] },
    script: [S()],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-password');
  assert.equal(h.requests.length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

test('an irreversible heuristic returns needs_confirmation and never acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [S()],
  });
  const r = await h.call({ goal: 'Order' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-heuristic');
  assert.deepEqual(r.pending, { verb: 'click', label: 'Place order' });
  assert.match(r.confirm_token ?? '', /^wct_/);
  assert.equal(h.driver.actCalls().length, 0);
});

test('an irreversible noul returns needs_confirmation and never acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Proceed' })] })] },
    script: [S({ irreversible: 0.9 })],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-jev');
  assert.equal(h.driver.actCalls().length, 0);
});

test('a confirm token executes exactly the pending action once', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S({ irreversible: 0.9 }), { done: 0.9 }] });
  const r1 = await h.call({ goal: 'g', values: {} });
  assert.equal(r1.status, 'needs_confirmation');
  const token = r1.confirm_token as string;
  const actsBefore = h.driver.actCalls().length;

  const r2 = await h.call({ goal: 'g', confirm_token: token });
  assert.equal(r2.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, actsBefore + 1);
  assert.equal(acts[acts.length - 1].elementId, 'e1');
  assert.equal(acts[acts.length - 1].op, 'click');
  // The token act ran before any ask: one ask in run 1, only the round-2 ask in run 2.
  assert.equal(h.requests.length, 2);
});

test('a reused confirm token is confirm-token-invalid', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S({ irreversible: 0.9 }), { done: 0.9 }] });
  const r1 = await h.call({ goal: 'g' });
  const token = r1.confirm_token as string;
  await h.call({ goal: 'g', confirm_token: token });

  const acts = h.driver.actCalls().length;
  const requests = h.requests.length;
  const r3 = await h.call({ goal: 'g', confirm_token: token });
  assert.equal(r3.status, 'error');
  assert.equal(r3.reason, 'confirm-token-invalid');
  assert.equal(h.driver.actCalls().length, acts);
  assert.equal(h.requests.length, requests);
});

test('a token on a different URL is confirm-token-invalid', async () => {
  const h = harness({
    observations: { p1: [observation({ url: 'https://example.com/list?keep=1' })] },
    script: [S({ irreversible: 0.9 })],
  });
  const r1 = await h.call({ goal: 'g' });
  const token = r1.confirm_token as string;

  h.driver.observationScripts.set('p1', [observation({ url: 'https://example.com/list?other=2' })]);
  const requestsBefore = h.requests.length;
  const r2 = await h.call({ goal: 'g', confirm_token: token });
  assert.equal(r2.status, 'error');
  assert.equal(r2.reason, 'confirm-token-invalid');
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, requestsBefore);
});

test('an open dialog returns blocked dialog-open and never acts', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  h.driver.dialogOnNextObserve = { pageId: 'p1', type: 'alert', message: 'Hello' };
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'dialog-open');
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 0);
});

test('shadow never acts and logs the would-be verb and role', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S()],
    forceMode: 'shadow',
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'shadow');
  assert.equal(r.shadow, true);
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.records.length, 1);
  assert.deepEqual(h.records[0].would, { verb: 'click', role: 'button' });
  assert.equal(h.records[0].gate_hits, 0);
});

test('a confirm token in shadow mode is never executed', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()], forceMode: 'shadow' });
  const token = h.tokens.mint({
    url: 'https://example.com/list',
    elementPath: '#e1',
    fingerprint: el().fingerprint,
    verb: 'click',
    label: 'Details',
  });
  const r = await h.call({ goal: 'g', confirm_token: token });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'shadow');
  assert.equal(h.driver.actCalls().length, 0);
  // The token was left unconsumed: a later non-shadow call could still use it.
  assert.ok(h.tokens.consume(token) !== null);
});

test('lock-held refuses before attaching', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S()],
    lockCheck: async () => ({ ok: false, reason: 'lock-held' }),
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'lock-held');
  assert.equal(h.driver.events.some((e) => e.kind === 'attach'), false);
});

test('one log record per call with no path, title, label, value or page text', async () => {
  const markers = ['secret-path-XYZ', 'SecretTitle', 'SecretLabel', 'SecretValue', 'SecretText'];
  const h = harness({
    observations: {
      p1: [
        observation({
          url: 'https://example.com/secret-path-XYZ',
          title: 'SecretTitle',
          text: 'SecretText body',
          elements: [el({ name: 'SecretLabel' })],
        }),
      ],
    },
    script: [S(), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'g', values: { q: 'SecretValue' } });
  assert.equal(r.status, 'done');
  assert.equal(h.records.length, 1);
  const serialized = JSON.stringify(h.records[0]);
  for (const marker of markers) {
    assert.equal(serialized.includes(marker), false, `log record leaked ${marker}`);
  }
});

test('result labels are redacted and at most 80 chars', async () => {
  const h = harness({
    observations: {
      p1: [observation({ elements: [el({ name: `SecretValue ${'y'.repeat(100)}` })] })],
    },
    script: [S({ irreversible: 0.9 })],
  });
  const r = await h.call({ goal: 'g', values: { q: 'SecretValue' } });
  assert.equal(r.status, 'needs_confirmation');
  const label = r.pending?.label ?? '';
  assert.equal(label.includes('SecretValue'), false);
  assert.ok(label.length <= 80);

  const h2 = harness({
    pages: [
      page({ title: `SecretValue ${'z'.repeat(100)}` }),
      page({ id: 'p2', url: 'https://example.com/other', title: 'Other' }),
    ],
    observations: { p1: [observation()] },
    script: [S()],
  });
  const r2 = await h2.call({ goal: 'g', values: { q: 'SecretValue' } });
  assert.equal(r2.status, 'ambiguous');
  assert.equal(r2.reason, 'tab-ambiguous');
  const candidate = r2.candidates?.[0]?.label ?? '';
  assert.equal(candidate.includes('SecretValue'), false);
  assert.ok(candidate.length <= 80);
});

test('detach runs even when the loop throws', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  h.driver.failNextAct = new Error('boom');
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'tool-fault');
  const kinds = h.driver.events.map((e) => e.kind);
  assert.ok(kinds.includes('act'));
  assert.equal(kinds[kinds.length - 1], 'detach');
});
