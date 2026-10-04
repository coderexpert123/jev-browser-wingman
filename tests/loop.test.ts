// Loop tests (§ WP-C7): FakeDriver plus a scripted fake ask, one test per
// required title. The round decision rule's § 8 known-bad lives here: every
// branch test uses an input that would pass under a wrong rule order.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDo, runCheck, runStep, kindForResult, type LoopDeps } from '../src/core/loop.js';
import { FakeDriver } from './helpers/fake-driver.js';
import { ConfirmTokenStore } from '../src/core/tokens.js';
import { createMutex } from '../src/core/mutex.js';
import { DEFAULT_BUDGETS, OBS_RETRY_SETTLE_MS, POLICY_SELF_TEST_HOST, PRE_CLICK_SETTLE_MS } from '../src/contract/constants.js';
import type { GateMode, PolicyMode, TakeoverMode } from '../src/contract/constants.js';
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
  key?: [string, Record<string, number>];
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
    for (const key of ['action', 'target', 'value', 'group', 'option', 'key'] as const) {
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
  callStep: (input: unknown) => Promise<WingmanResult>;
}

function harness(opts: {
  pages?: PageInfo[];
  observations: Record<string, Observation[]>;
  script: SeqEntry[];
  config?: Partial<WingmanConfig> & {
    gate?: { mode: GateMode };
    policy?: { mode: PolicyMode };
    takeover?: { threshold?: number; mode?: TakeoverMode; retry?: boolean };
  };
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
    callStep: (input: unknown) => runStep(input, deps),
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

test("a chain round's log carries step_done/ready/right_page probabilities; a non-chain round omits them", async () => {
  // Noul-question probabilities (tuning data, 2026-09-28): step_done/ready/
  // right_page are only ever asked in chain mode (buildRoundRequest only adds
  // them when `chain` is true); `done` is asked every round, chain or not.
  // Round 1 commits a click with step_done still low (zero steps taken can
  // never end a chain call done, § 5.5.4 zero-step defence — endOfChain falls
  // to step-uncertain/already-done otherwise); round 2 advances once a real
  // act has landed.
  let call = 0;
  const chainAsk: JevAsk = async () => {
    call += 1;
    const answers: Record<string, JevAnswer> = {
      done: { type: 'noul', noul: 0.05 },
      blocked: { type: 'noul', noul: 0.05 },
      login: { type: 'noul', noul: 0.05 },
      irreversible: { type: 'noul', noul: 0.05 },
      right_page: { type: 'noul', noul: 0.92 },
      ready: { type: 'noul', noul: 0.88 },
    };
    if (call === 1) {
      answers.step_done = { type: 'noul', noul: 0.05 };
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 });
    } else {
      answers.step_done = { type: 'noul', noul: 0.95 };
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
  const chainHarness = harness({ observations: { p1: [observation()] }, script: [], ask: chainAsk });
  const chainResult = await chainHarness.callStep({ goal: 'noul-telemetry chain goal', steps: ['s1'] });
  assert.equal(chainResult.status, 'done', `expected done, got ${chainResult.status}/${chainResult.reason}`);
  const chainRound = chainHarness.records[0].phases!.rounds[0];
  assert.equal(chainRound.doneP, 0.05);
  assert.equal(chainRound.stepDoneP, 0.05);
  assert.equal(chainRound.rightPageP, 0.92);
  assert.equal(chainRound.readyP, 0.88);

  const doAsk: JevAsk = async () => ({
    ok: true,
    answers: {
      done: { type: 'noul', noul: 0.95 },
      blocked: { type: 'noul', noul: 0.05 },
      login: { type: 'noul', noul: 0.05 },
      irreversible: { type: 'noul', noul: 0.05 },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 1,
    status: 200,
    retries: 0,
  });
  const doHarness = harness({ observations: { p1: [observation()] }, script: [], ask: doAsk });
  const doResult = await doHarness.call({ goal: 'noul-telemetry wingman_do goal' });
  assert.equal(doResult.status, 'done', `expected done, got ${doResult.status}/${doResult.reason}`);
  const doRound = doHarness.records[0].phases!.rounds[0];
  assert.equal(doRound.doneP, 0.95);
  // r18 (D3): a round's kind is a string, never an undefined-assigned key —
  // the done noul end derives it from the end status.
  assert.equal(doRound.kind, 'done');
  assert.equal('stepDoneP' in doRound, false, 'wingman_do is never asked step_done');
  assert.equal('readyP' in doRound, false, 'wingman_do is never asked ready');
  assert.equal('rightPageP' in doRound, false, 'wingman_do is never asked right_page');
});

test('a multi-round non-chain wingman_do call still carries errorP on round >= 2 (error is gated on round alone, not on chain)', async () => {
  // verifier finding (2026-09-28): the phases.rounds telemetry comment
  // originally lumped `error` in with the chain-only step_done/ready/
  // right_page trio, claiming wingman_do "never" gets it — but
  // buildRoundRequest/buildGroupRequest gate `error` on `round >= 2` alone,
  // independent of `chain` (§ decideEarly rule 4 reads it for legacy/
  // wingman_do calls too). Round 1 here commits a click with done still
  // low; round 2 carries a low (non-triggering) error noul alongside a high
  // done, so the call ends 'done' via rule 3 while still recording errorP
  // from round 2's answers (recordDecisionTelemetry runs before decideEarly
  // branches on them).
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    const answers: Record<string, JevAnswer> = {
      done: { type: 'noul', noul: call === 1 ? 0.05 : 0.95 },
      blocked: { type: 'noul', noul: 0.05 },
      login: { type: 'noul', noul: 0.05 },
      irreversible: { type: 'noul', noul: 0.05 },
    };
    if (call === 1) {
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 });
    } else {
      answers.error = { type: 'noul', noul: 0.1 };
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
  const h = harness({ observations: { p1: [observation()] }, script: [], ask });
  const r = await h.call({ goal: 'noul-telemetry wingman_do multi-round goal' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const rounds = h.records[0].phases!.rounds;
  assert.equal(rounds.length, 2, 'two rounds: the click, then the done round');
  assert.equal('errorP' in rounds[0], false, 'round 1 never asks error (round < 2)');
  assert.equal(rounds[1].errorP, 0.1, 'round 2 (>= 2) carries errorP even in non-chain mode');
  assert.equal(rounds[1].doneP, 0.95);
});

// ---- r18 (D3): per-round outcome class (PhaseRound.kind) ----
// Fail-first: every kind assertion below fails against fieldless rounds.

/** A chain-mode ask like chain.test.ts's CS()/ADV(), built inline because
 * loop.test.ts's scriptedAsk cannot express step_done/ready/right_page. */
function chainKindAsk(seq: Array<Record<string, JevAnswer>>): JevAsk {
  let call = 0;
  return async () => {
    const step = seq[Math.min(call, seq.length - 1)];
    call += 1;
    return {
      ok: true,
      answers: {
        done: { type: 'noul', noul: 0.05 },
        blocked: { type: 'noul', noul: 0.05 },
        login: { type: 'noul', noul: 0.05 },
        error: { type: 'noul', noul: 0.05 },
        irreversible: { type: 'noul', noul: 0.05 },
        ready: { type: 'noul', noul: 0.95 },
        right_page: { type: 'noul', noul: 0.95 },
        step_done: { type: 'noul', noul: 0.05 },
        ...step,
      },
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
      status: 200,
      retries: 0,
    };
  };
}

test('round kinds: a chain act round reads act, its advance round reads advance', async () => {
  // The [CS(), ADV()] shape: round 1 commits a click (explicit kind at the
  // shared act tail, so it stays 'act' whatever the call's end status says),
  // round 2 advances (explicit kind at the advance branch) and — being the
  // final clause — ends the call done. Precedence rule: the advance round
  // reads 'advance', not 'done', even though mk() ran for it.
  const ask = chainKindAsk([
    {
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    },
    { step_done: { type: 'noul', noul: 0.95 } },
  ]);
  const h = harness({ observations: { p1: [observation()] }, script: [], ask });
  const r = await h.callStep({ goal: 'round-kind chain act/advance goal', steps: ['s1'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const rounds = h.records[0].phases!.rounds;
  assert.equal(rounds.length, 2, 'act round then advance round');
  assert.equal(typeof rounds[0].kind, 'string', 'kind is a string, never undefined-assigned');
  assert.equal(rounds[0].kind, 'act');
  assert.equal(rounds[1].kind, 'advance');
});

test('round kinds: a not-ready chain round acts a mechanical wait', async () => {
  // ready < THRESHOLDS.ready (0.3) on a fresh clause with no effective click
  // is the mechanical wait: runChainEarly rule 5 -> the shared act tail with
  // verb 'wait' -> kind 'wait'. The call then acts and advances normally.
  const ask = chainKindAsk([
    { ready: { type: 'noul', noul: 0.1 } },
    {
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    },
    { step_done: { type: 'noul', noul: 0.95 } },
  ]);
  const h = harness({ observations: { p1: [observation()] }, script: [], ask });
  const r = await h.callStep({ goal: 'round-kind not-ready wait goal', steps: ['s1'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const rounds = h.records[0].phases!.rounds;
  assert.equal(rounds.length, 3, 'wait round, act round, advance round');
  assert.equal(rounds[0].kind, 'wait');
  assert.equal(rounds[1].kind, 'act');
  assert.equal(rounds[2].kind, 'advance');
});

test('round kinds: a wingman_do round-1 done via the done noul reads done', async () => {
  // No explicit site fired (no act, no advance): the round's kind comes from
  // mk()'s kindForResult(status) — 'done' here, never an undefined-assigned key.
  const h = harness({
    observations: { p1: [observation()] },
    script: [{ done: 0.95, blocked: 0.05, login: 0.05, irreversible: 0.05 }],
  });
  const r = await h.call({ goal: 'round-kind wingman_do done goal' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const rounds = h.records[0].phases!.rounds;
  assert.equal(rounds.length, 1);
  assert.equal(typeof rounds[0].kind, 'string', 'kind is a string, never undefined-assigned');
  assert.equal(rounds[0].kind, 'done');
});

test('round kinds: a jev-error ask failure bounces its round', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [{ fail: 'jev-error' }] });
  const r = await h.call({ goal: 'round-kind jev-error goal' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'jev-error');
  const rounds = h.records[0].phases!.rounds;
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].kind, 'bounce');
});

test('kindForResult maps every end status exactly (r18 D3)', () => {
  assert.equal(kindForResult('done'), 'done');
  assert.equal(kindForResult('error'), 'error');
  assert.equal(kindForResult('login'), 'error');
  assert.equal(kindForResult('fallback'), 'bounce');
  assert.equal(kindForResult('ambiguous'), 'bounce');
  assert.equal(kindForResult('blocked'), 'bounce');
  assert.equal(kindForResult('needs_confirmation'), 'bounce');
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
    config: { gate: { mode: 'confirm' } },
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

test('default (absent) gate config acts without needs_confirmation (Q6)', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Proceed' })] })] },
    script: [S({ irreversible: 0.9 })],
  });
  const r = await h.call({ goal: 'g', max_steps: 1 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-steps');
  assert.equal(r.confirm_token, undefined);
  assert.equal(r.pending, undefined);
  assert.equal(h.driver.actCalls().length, 1);
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

// Sensitive-page handoff note (2026-09-25 amendment, E2): a fallback result
// whose reason starts with 'sensitive-' or equals 'unsupported-page' carries
// this static line for all three tools instead of the tool's own continuation
// text, and bypasses the bounce counter. The literal is inlined here (not
// imported from loop.ts) so a drift on either side fails this pin — G2 is the
// proof this check can fail: run against the unmodified loop.ts first.
const SPEC_SENSITIVE_LINE =
  'This page is sensitive under the active policy. Do this step with your own browser tools, then call again once you reach a non-sensitive page.';

const SENSITIVE_URL = `https://${POLICY_SELF_TEST_HOST}/o/oauth2/auth`;

test('wingman_do on a sensitive host under policy.mode enforce carries the sensitive-page note', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [S()],
    config: { policy: { mode: 'enforce' } },
  });
  const r = await h.call({ goal: 'g' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-identity');
  assert.equal(r.note, SPEC_SENSITIVE_LINE);
});

test('wingman_check on a sensitive host under policy.mode enforce carries the sensitive-page note', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [S()],
    config: { policy: { mode: 'enforce' } },
  });
  const r = await h.callCheck({ question: 'Is this a sign-in page?' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-identity');
  assert.equal(r.note, SPEC_SENSITIVE_LINE);
});

test('browse_step on a sensitive host under policy.mode enforce carries the sensitive-page note', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [S()],
    config: { policy: { mode: 'enforce' } },
  });
  const r = await h.callStep({ goal: 'g', step: 'Click sign in' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-identity');
  assert.equal(r.note, SPEC_SENSITIVE_LINE);
});

test('the same sensitive host under policy.mode off never yields the sensitive-page note', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [S(), { done: 0.9 }],
    config: { policy: { mode: 'off' } },
  });
  const r = await h.call({ goal: 'g' });
  assert.notEqual(r.reason, 'sensitive-identity');
  assert.notEqual(r.note, SPEC_SENSITIVE_LINE);
});

// Regression guard: a step-uncertain browse_step bounce (the untouched path —
// its reason never starts with 'sensitive-' and is never 'unsupported-page')
// still carries the HEAD § 3.17 caller line plus the tier-1 escalation
// sentence, unaffected by the sensitive-note branch in finish().
test('a step-uncertain browse_step bounce still carries the HEAD caller line and bounce tier 1', async () => {
  const CALLER_LINE =
    'Step returned to you — do this step with your browser tools, then call browse_step again with the same goal and your next proposed step.';
  const TIER1 =
    'Retry with a more specific description of the target, or perform this step yourself with your raw browser tools.';
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [el({ id: 'e1', name: 'Alpha', path: '#e1' }), el({ id: 'e2', name: 'Beta', path: '#e2' })],
        }),
      ],
    },
    script: [S({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.callStep({ goal: 'regression-tier1-goal', step: 'Click the right one' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.note, `${CALLER_LINE} ${TIER1}`);
});

// ---- r17 (spec .build-r17-spec.md, WP-B): wingman_do legs ----

test('wingman_do press-none commits a targetless press (focused element)', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      S({
        action: ['press', { press: 0.9, none: 0.05 }],
        target: ['none', { none: 0.9, ambiguous: 0.05 }],
        key: ['Enter', { Enter: 0.9, none: 0.05 }],
      }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'r17-do-press-none goal' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].elementId, null, 'wingman_do commits press-none at the plain 0.5 target bar');
  assert.equal(acts[0].op, 'press');
  assert.equal(acts[0].value, 'Enter');
});

test('wingman_do press-none with irreversible refuses ambiguous no-action with zero acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      S({
        action: ['press', { press: 0.9, none: 0.05 }],
        target: ['none', { none: 0.9, ambiguous: 0.05 }],
        key: ['Enter', { Enter: 0.9, none: 0.05 }],
        irreversible: 0.9,
      }),
    ],
  });
  const r = await h.call({ goal: 'r17-do-press-none-irrev goal' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'no-action');
  assert.equal(h.driver.actCalls().length, 0, 'an element-free irreversible press never acts');
  assert.equal(r.confirm_token, undefined, 'no element identity, no confirm token');
});

test('wingman_do press with no key answer falls back to Enter', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      S({
        action: ['press', { press: 0.9, none: 0.05 }],
        target: ['none', { none: 0.9, ambiguous: 0.05 }],
      }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'r17-do-press-nokey goal' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].value, 'Enter', 'the unchanged line: a missing key answer defaults to Enter off takeover');
});

test('wingman_do token act answers the page dialog per the goal text', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ name: 'Remove item' })] })] },
    script: [S({ irreversible: 0.9 }), { done: 0.9 }],
    config: { gate: { mode: 'confirm' } },
  });
  const minted = await h.call({ goal: 'r17-do-token-dialog setup goal' });
  assert.equal(minted.status, 'needs_confirmation');
  assert.ok(minted.confirm_token);
  h.driver.dialogOnNextAct = { pageId: 'p1', type: 'confirm', message: 'Really remove?' };
  const r = await h.call({
    goal: 'Remove the item and confirm it',
    confirm_token: minted.confirm_token ?? '',
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const answers = h.driver.events.filter((e) => e.kind === 'answerDialog');
  assert.equal(answers.length, 1);
  assert.equal((answers[0] as { accept?: boolean }).accept, true, 'the goal text (the call step text) said confirm');
  assert.equal(h.driver.actCalls().length, 1, 'the token click executed');
});

// ---- r21 (P-1c): the bounded observe retry in observeTimed ----
//
// A FAST observe failure (< 2 s) is a mid-navigation context loss (the r20
// scheduled-nav click's navigation in flight); it is retried up to twice
// behind a bounded settle. A SLOW first failure is a wedged renderer, never
// a navigation, and must not be retried (the fast-fail gate) — UNLESS it is
// NAV-SHAPED (the r21b mid-nav amendment: the evaluate-timeout /
// context-destroyed signature) right after a click-family act, in which case
// it is retried once behind the larger PRE_CLICK_SETTLE_MS settle (the t9
// rep-1 failure's fix).

test('a fast mid-navigation observe failure retries behind a bounded settle and the call completes normally', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const origObserve = h.driver.observe.bind(h.driver);
  let failed = false;
  const observeCalls: number[] = [];
  h.driver.observe = async (pageId: string) => {
    observeCalls.push(Date.now());
    if (!failed) {
      failed = true;
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    return origObserve(pageId);
  };
  const settleBudgets: number[] = [];
  const origSettle = h.driver.settle.bind(h.driver);
  h.driver.settle = async (pageId: string, budgetMs: number) => {
    settleBudgets.push(budgetMs);
    return origSettle(pageId, budgetMs);
  };
  const r = await h.call({ goal: 'r21 obs retry once goal' });
  assert.equal(r.status, 'done', `expected a normal completion, got ${r.status}/${r.reason}`);
  // one failed observe + one recovered observe (round 1) + one observe (round 2)
  assert.equal(observeCalls.length, 3, `expected 3 observe calls, got ${observeCalls.length}`);
  assert.ok(
    settleBudgets.includes(OBS_RETRY_SETTLE_MS),
    `the retry settle budget ${OBS_RETRY_SETTLE_MS} was never used (settle budgets: ${settleBudgets.join(',')})`,
  );
  // The recovered round's observeMs absorbs the retry time (spec WP-3 item 5).
  const rec = h.records[0];
  const observeMs = rec.phases?.rounds.map((round) => round.observeMs) ?? [];
  assert.ok(observeMs.length >= 2, `expected at least 2 timed rounds, got ${observeMs.length}`);
});

test('a wedged observe (slow first failure, >= 2 s) is never retried and still ends error', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S()] });
  let observeCalls = 0;
  h.driver.observe = async (): Promise<Observation> => {
    observeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    throw new Error('evaluation timed out');
  };
  const r = await h.call({ goal: 'r21 obs wedge no retry goal' });
  assert.equal(r.status, 'error', `expected the unchanged error end, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'tool-fault');
  assert.equal(observeCalls, 1, `a wedge must not be retried, got ${observeCalls} observe calls`);
});

// r21b mid-nav amendment (the t9 rep-1 failure): a SLOW nav-shaped failure
// (the adapters' evaluate-timeout signature) right after a click-family act
// is a navigation in flight, not a wedge — retried behind the larger
// PRE_CLICK_SETTLE_MS first settle. Pre-fix this ended error/tool-fault with
// one observe call.
test('a slow nav-shaped observe failure right after a click act is retried behind the larger settle', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [S(), { done: 0.9 }] });
  const origObserve = h.driver.observe.bind(h.driver);
  let calls = 0;
  const observeCalls: number[] = [];
  h.driver.observe = async (pageId: string) => {
    observeCalls.push(Date.now());
    if (observeCalls.length === 2) {
      // Round 2's observe (round 1 already clicked): SLOW (>= 2 s) and
      // NAV-SHAPED — the adapters' evaluate-timeout text.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      throw new Error('evaluation timed out');
    }
    return origObserve(pageId);
  };
  const settleBudgets: number[] = [];
  const origSettle = h.driver.settle.bind(h.driver);
  h.driver.settle = async (pageId: string, budgetMs: number) => {
    settleBudgets.push(budgetMs);
    return origSettle(pageId, budgetMs);
  };
  const r = await h.call({ goal: 'r21b slow nav-shaped observe retry goal' });
  assert.equal(r.status, 'done', `expected the recovered completion, got ${r.status}/${r.reason}`);
  // round 1's observe (ok) + round 2's failed observe + round 2's recovered observe
  assert.equal(observeCalls.length, 3, `expected 3 observe calls, got ${observeCalls.length}`);
  assert.ok(
    settleBudgets.includes(PRE_CLICK_SETTLE_MS),
    `the nav-shaped slow path never used the PRE_CLICK_SETTLE_MS settle (budgets: ${settleBudgets.join(',')})`,
  );
});
