// Loop tests (§ WP-C7): FakeDriver plus a scripted fake ask, one test per
// required title. The round decision rule's § 8 known-bad lives here: every
// branch test uses an input that would pass under a wrong rule order.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDo, runCheck, type LoopDeps } from '../src/core/loop.js';
import { FakeDriver } from './helpers/fake-driver.js';
import { ConfirmTokenStore } from '../src/core/tokens.js';
import { createMutex } from '../src/core/mutex.js';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type { GateMode } from '../src/contract/constants.js';
import type {
  ElementRecord,
  JevAnswer,
  JevAsk,
  JevRequest,
  LockCheckResult,
  Mode,
  Observation,
  PageInfo,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../src/contract/types.js';

// ---- fixtures ----

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

type NoulAnswers = {
  done?: number;
  blocked?: number;
  login?: number;
  error?: number;
  irreversible?: number;
  answer?: number;
};
type ChoiceAnswers = {
  action?: [string, Record<string, number>];
  target?: [string, Record<string, number>];
  value?: [string, Record<string, number>];
  group?: [string, Record<string, number>];
  option?: [string, Record<string, number>];
};
type SeqEntry = (NoulAnswers & ChoiceAnswers) | { fail: string };

function choice(c: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: c, probabilities, confidence: 0.9 };
}

/** Standard first-round answers: click e1, nothing terminal. */
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
    for (const key of ['done', 'blocked', 'login', 'error', 'irreversible', 'answer'] as const) {
      if (step[key] !== undefined) answers[key] = { type: 'noul', noul: step[key] as number };
    }
    for (const key of ['action', 'target', 'value', 'group', 'option'] as const) {
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
  callCheck: (input: unknown) => Promise<WingmanResult>;
}

function harness(opts: {
  pages?: PageInfo[];
  observations: Record<string, Observation[]>;
  script: SeqEntry[];
  config?: Partial<WingmanConfig> & { gate?: { mode: GateMode } };
  ask?: JevAsk | null;
  now?: () => number;
  forceMode?: Mode;
  lockCheck?: () => Promise<LockCheckResult>;
}): Harness {
  const driver = new FakeDriver({ pages: opts.pages ?? [page()], observations: opts.observations });
  const { ask, requests } = scriptedAsk(opts.script);
  const records: WingmanLogRecord[] = [];
  const tokens = new ConfirmTokenStore();
  const deps: LoopDeps = {
    config: makeConfig(opts.config),
    driverFactory: () => driver,
    resolveEndpoint: async () => 'http://127.0.0.1:9222',
    ask: opts.ask !== undefined ? opts.ask : ask,
    ...(opts.lockCheck ? { lockCheck: opts.lockCheck } : {}),
    mutex: createMutex(),
    tokens,
    writeLog: async (r) => {
      records.push(r);
    },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.forceMode ? { forceMode: opts.forceMode } : {}),
  };
  return {
    driver,
    records,
    requests,
    tokens,
    deps,
    call: (input: unknown) => runDo(input, deps),
    callCheck: (input: unknown) => runCheck(input, deps),
  };
}

// ---- required tests ----

test('log record carries the phases breakdown (fail-first shape test)', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const r = await h.call({ goal: 'Open the details' });
  assert.equal(r.status, 'done');
  const rec = h.records[0];
  // A record without phases must fail this shape test.
  assert.ok(rec.phases, 'log record has no phases object');
  assert.equal(typeof rec.phases.attachMs, 'number');
  assert.equal(typeof rec.phases.firstObserveMs, 'number');
  assert.ok(Array.isArray(rec.phases.rounds));
  assert.equal(rec.phases.rounds.length, 2); // act round, then the done round
  for (const round of rec.phases.rounds) {
    for (const key of ['observeMs', 'jevMs', 'actMs', 'settleMs'] as const) {
      assert.equal(typeof round[key], 'number');
      assert.ok(Number.isFinite(round[key]));
    }
  }
  // JSON-serializable and free of page text: numbers and arrays only.
  const json = JSON.parse(JSON.stringify(rec.phases)) as unknown;
  assert.deepEqual(json, rec.phases);
});

test('check-path record carries phases with one round', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [{ answer: 0.9 }] });
  const r = await h.callCheck({ question: 'Is the list visible?' });
  assert.equal(r.status, 'done');
  const rec = h.records[0];
  assert.ok(rec.phases, 'check log record has no phases object');
  assert.equal(rec.phases.rounds.length, 1);
  assert.equal(rec.phases.rounds[0].actMs, 0);
  assert.equal(rec.phases.rounds[0].settleMs, 0);
});

test('done after one click then goal-met', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const r = await h.call({ goal: 'Open the details' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.equal(r.steps, 1);
  assert.deepEqual(r.last_action, { verb: 'click', label: 'Details' });
  assert.equal(r.cost.jev_calls, 2);
  assert.equal(h.driver.actCalls().length, 1);
});

test('action none with done 0.6 is done', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [{ done: 0.6, blocked: 0.05, login: 0.05, irreversible: 0.05, action: ['none', { none: 0.9 }] }],
  });
  const r = await h.call({ goal: 'g' });
  // done 0.6 < THRESHOLDS.done (0.85): only rule 5's doneNoAction makes this done.
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.equal(h.driver.actCalls().length, 0);
});

test('action none with done 0.3 is ambiguous no-action with top-3 candidates', async () => {
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [
            el({ id: 'e1', name: 'Alpha', path: '#e1' }),
            el({ id: 'e2', name: 'Beta', path: '#e2' }),
            el({ id: 'e3', name: 'Gamma', path: '#e3' }),
            el({ id: 'e4', name: 'Delta', path: '#e4' }),
          ],
        }),
      ],
    },
    script: [
      {
        done: 0.3,
        blocked: 0.05,
        login: 0.05,
        irreversible: 0.05,
        action: ['none', { none: 0.9 }],
        target: ['e4', { e4: 0.5, e2: 0.3, e1: 0.15, e3: 0.05, none: 0, ambiguous: 0 }],
      },
    ],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'no-action');
  assert.equal(r.candidates?.length, 3);
  const labels = r.candidates?.map((c) => c.label) ?? [];
  assert.match(labels[0], /Delta/);
  assert.match(labels[1], /Beta/);
  assert.match(labels[2], /Alpha/);
});

test('target below 0.5 is ambiguous target-uncertain', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S({ target: ['e1', { e1: 0.4, none: 0.3, ambiguous: 0.1 }] })],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.equal(h.driver.actCalls().length, 0);
});

test('fill without bindings is ambiguous no-value', async () => {
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [
            el({
              tag: 'input',
              role: 'textbox',
              name: 'Email',
              type: 'email',
              editable: true,
              path: '#email',
              fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 0, y: 0 },
            }),
          ],
        }),
      ],
    },
    script: [S({ action: ['fill', { fill: 0.9, click: 0.05 }], target: ['e1', { e1: 0.9 }] })],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'no-value');
  assert.equal(h.driver.actCalls().length, 0);
});

test('two visible tabs are ambiguous tab-ambiguous and url_match picks one', async () => {
  const h = harness({
    pages: [page({ url: 'https://example.com/a', title: 'Alpha' }), page({ id: 'p2', url: 'https://example.com/b', title: 'Beta' })],
    observations: { p1: [observation()], p2: [observation({ url: 'https://example.com/b' })] },
    script: [{ done: 0.9 }],
  });
  const r1 = await h.call({ goal: 'g' });
  assert.equal(r1.status, 'ambiguous');
  assert.equal(r1.reason, 'tab-ambiguous');
  assert.deepEqual(r1.candidates?.map((c) => c.label), ['Alpha', 'Beta']);
  assert.equal(h.requests.length, 0);

  const r2 = await h.call({ goal: 'g', url_match: '/b' });
  assert.equal(r2.status, 'done');
  assert.equal(h.requests.length, 1);
});

test('budget-steps after max_steps acts', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  const r = await h.call({ goal: 'g', max_steps: 1 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-steps');
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(r.steps, 1);
});

// Result-text steering (2026-09-21): every wingman_do result that is not done
// carries the static continuation line so the calling model re-calls the tool
// instead of finishing the goal with raw browser tools. The expected text is
// inlined here (not imported) so a drift on either side fails this pin.
const SPEC_CONTINUE_LINE =
  'Goal not finished — call wingman_do again with the same goal (and the same values) to continue from here. Do not switch to raw browser tools.';

test('a non-done wingman_do result carries the continuation line (fail-first shape test)', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  const r = await h.call({ goal: 'g', max_steps: 1 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.note, SPEC_CONTINUE_LINE);
});

test('done carries no continuation line; needs_confirmation keeps the token and adds it', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const r1 = await h1.call({ goal: 'g' });
  assert.equal(r1.status, 'done');
  assert.equal(r1.note, undefined);

  const h2 = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Proceed' })] })] },
    script: [S({ irreversible: 0.9 })],
  });
  const r2 = await h2.call({ goal: 'g' });
  assert.equal(r2.status, 'needs_confirmation');
  assert.match(r2.confirm_token ?? '', /^wct_/);
  assert.equal(r2.note, SPEC_CONTINUE_LINE);
  // Confirmation fields stay primary: they serialize ahead of the note.
  const keys = Object.keys(JSON.parse(JSON.stringify(r2)) as Record<string, unknown>);
  assert.ok(keys.indexOf('confirm_token') < keys.indexOf('note'));
});

test('wingman_check results never carry the goal continuation line', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()], forceMode: 'off' });
  const r = await h.callCheck({ question: 'q' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.note, undefined);
});

test('budget-time stops before the floor (fake clock)', async () => {
  let t = 0;
  const h = harness({
    observations: { p1: [observation()] },
    script: [S()],
    now: () => t,
  });
  h.driver.onObserve = () => {
    t += 4000;
  };
  const r = await h.call({ goal: 'g', max_ms: 5000 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-time');
  assert.equal(h.requests.length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

test('a concurrent call is blocked busy', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const [r1, r2] = await Promise.all([h.call({ goal: 'g' }), h.call({ goal: 'g' })]);
  assert.equal(r1.status, 'done');
  assert.equal(r2.status, 'blocked');
  assert.equal(r2.reason, 'busy');
});

test('mode off returns fallback mode-off without attaching', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()], forceMode: 'off' });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'mode-off');
  assert.equal(h.driver.events.some((e) => e.kind === 'attach'), false);
});

test('no key returns fallback no-key without attaching', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()], ask: null });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'no-key');
  assert.equal(h.driver.events.some((e) => e.kind === 'attach'), false);
});

test('no endpoint returns fallback no-browser', async () => {
  const driver = new FakeDriver({ pages: [page()], observations: { p1: [observation()] } });
  const { ask } = scriptedAsk([S()]);
  const records: WingmanLogRecord[] = [];
  const deps: LoopDeps = {
    config: makeConfig(),
    driverFactory: () => driver,
    resolveEndpoint: async () => null,
    ask,
    mutex: createMutex(),
    tokens: new ConfirmTokenStore(),
    writeLog: async (r) => {
      records.push(r);
    },
  };
  const r = await runDo({ goal: 'g' }, deps);
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'no-browser');
  assert.equal(driver.events.some((e) => e.kind === 'attach'), false);
});

test('jev http error is fallback jev-error and circuit-open is breaker-open', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [{ fail: 'http' }] });
  const r1 = await h1.call({ goal: 'g' });
  assert.equal(r1.status, 'fallback');
  assert.equal(r1.reason, 'jev-error');

  const h2 = harness({ observations: { p1: [observation()] }, script: [{ fail: 'circuit-open' }] });
  const r2 = await h2.call({ goal: 'g' });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.reason, 'breaker-open');
});

test('stale element is error stale-element', async () => {
  const { StaleElementError } = await import('../src/contract/errors.js');
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  h.driver.failNextAct = new StaleElementError('gone');
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'stale-element');
});

test('covered target is blocked covered-target', async () => {
  const { CoveredTargetError } = await import('../src/contract/errors.js');
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  h.driver.failNextAct = new CoveredTargetError('covered');
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'covered-target');
});

test('native select picks the option locally when the value matches a label', async () => {
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [
            el({
              tag: 'select',
              role: 'combobox',
              name: 'Country',
              path: '#country',
              options: [
                { value: 'in', label: 'India' },
                { value: 'us', label: 'United States' },
              ],
              state: { disabled: false, selected: 'Choose' },
              fingerprint: { tag: 'select', role: 'combobox', name: 'Country', x: 0, y: 0 },
            }),
          ],
        }),
      ],
    },
    script: [
      S({ action: ['select', { select: 0.9, click: 0.05 }], target: ['e1', { e1: 0.9 }], value: ['country', { country: 0.9, none: 0.05 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'Pick India', values: { country: 'india' } });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].op, 'select');
  assert.equal(acts[0].value, 'in');
  // Local match: no option request was needed.
  assert.equal(h.requests.length, 2);
});

test('two-stage selection above max_elements', async () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    el({ id: `e${i + 1}`, name: `Row ${i + 1}`, path: `#r${i + 1}` }),
  );
  const h = harness({
    observations: { p1: [observation({ elements: many })] },
    script: [
      S({ action: ['click', { click: 0.9, none: 0.05 }], group: ['g1', { g1: 0.9, none: 0.05, ambiguous: 0.05 }] }),
      { target: ['e2', { e2: 0.9, none: 0.05, ambiguous: 0.05 }], irreversible: 0.05 },
      { done: 0.9 },
    ],
    config: { budgets: { ...DEFAULT_BUDGETS, max_elements: 4 } },
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].elementId, 'e2');
  const first = h.requests[0].questions as Record<string, unknown>;
  const second = h.requests[1].questions as Record<string, unknown>;
  assert.ok('group' in first);
  assert.ok('target' in second);
  assert.ok(!('action' in second));
});

test('wingman_check returns done answered with the rounded answer', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [{ answer: 0.456 }] });
  const r = await h.callCheck({ question: 'Is the item in the cart?' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'answered');
  assert.equal(r.answer, 0.46);
  assert.ok(r.cost.jev_calls >= 1);
  assert.equal(h.driver.actCalls().length, 0);
});

// Answers are untrusted (§ 3.7 consumes a Jev response): an id that is not in
// the observation or an out-of-set action choice resolves to ambiguous, never
// to an act on some other element.
test('an unresolvable target id is target-uncertain, never an act on another element', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S({ target: ['e99', { e99: 0.9, none: 0.05 }] })] });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.equal(h.driver.actCalls().length, 0);
});

test('an out-of-set action choice is target-uncertain', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S({ action: ['delete', { delete: 0.9, click: 0.05 }] })] });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.equal(h.driver.actCalls().length, 0);
});

// § 3.8: with gate.mode 'off' the gate heuristic and the Jev irreversible
// probability never produce needs_confirmation — the act proceeds like any
// other, and no confirm token is minted.

test('gate off submits a gated button without a token', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [S(), { done: 0.9 }],
    config: { gate: { mode: 'off' } },
  });
  const r = await h.call({ goal: 'Order' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.equal(r.confirm_token, undefined);
  assert.equal(r.pending, undefined);
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(h.driver.actCalls()[0].elementId, 'e1');
});

test('gate off with Jev p(irreversible) 0.9 still acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Proceed' })] })] },
    script: [S({ irreversible: 0.9 }), { done: 0.9 }],
    config: { gate: { mode: 'off' } },
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.equal(r.confirm_token, undefined);
  assert.equal(h.driver.actCalls().length, 1);
});

test('default (absent) gate config keeps needs_confirmation', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Proceed' })] })] },
    script: [S({ irreversible: 0.9 })],
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-jev');
  assert.match(r.confirm_token ?? '', /^wct_/);
  assert.equal(h.driver.actCalls().length, 0);
});

// § 3.7 rule 8, amendment 2026-09-21e: the value-question anchor is
// browse_step-only. A wingman_do fill round keeps the threshold — the same
// 0.46 value grade that a browse-supplied binding would absorb still bounces
// no-value here, and the request carries no anchor sentence.
test('a wingman_do fill round below the value threshold is unchanged: ambiguous no-value', async () => {
  const values = { email: '77' };
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [
            el({
              tag: 'input',
              role: 'textbox',
              name: 'Email',
              type: 'email',
              editable: true,
              path: '#email',
              fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 0, y: 0 },
            }),
          ],
        }),
      ],
    },
    script: [
      S({
        action: ['fill', { fill: 0.9, click: 0.05 }],
        target: ['e1', { e1: 0.9 }],
        value: ['email', { email: 0.46, none: 0.5 }],
      }),
    ],
  });
  const r = await h.call({ goal: 'g', values });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'no-value');
  assert.equal(h.driver.actCalls().length, 0);
  const valueQ = (h.requests[0].questions as Record<string, { instructions?: string }>).value;
  assert.ok(valueQ, 'value question present');
  assert.ok(!valueQ.instructions?.includes('treat a value as present'), 'wingman_do request carries no anchor');
});
