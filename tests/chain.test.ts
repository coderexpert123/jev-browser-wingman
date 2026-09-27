// Chain-mode loop tests (spec 2026-09-26-wingman-forced-handoff § 6 WP-B2;
// § 5.5 loop semantics, § 5.5.1 validators, § 5.5.3 new verbs, § 5.5.5 notes,
// § 5.5.6 negotiation, § 5.6 pick, Q4/Q5). FakeDriver plus a scripted ask that
// also answers step_done, ready, right_page, recover, key, url and file.
//
// Goal texts are unique per test: the chain memory (§ 5.5.2) and the bounce
// counter are module-level and live per process. The E1–E8 browser halves of
// T2/T9/T19/T24/T25/T27 live in tests/chain-e2e.test.ts (Chrome file, gated
// separately).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDo, runStep, type LoopDeps } from '../src/core/loop.js';
import { FakeDriver } from './helpers/fake-driver.js';
import { ConfirmTokenStore } from '../src/core/tokens.js';
import { createMutex } from '../src/core/mutex.js';
import { assertNoValues } from '../src/core/withhold.js';
import { DEFAULT_BUDGETS, POLICY_SELF_TEST_HOST, WAIT_MAX_PER_CALL } from '../src/contract/constants.js';
import type { GateMode, PolicyMode, TakeoverMode } from '../src/contract/constants.js';
import type {
  ElementRecord,
  JevAnswer,
  JevAsk,
  JevRequest,
  LockCheckResult,
  Mode,
  Observation,
  Op,
  PageInfo,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../src/contract/types.js';
import { LEGACY_OPS, OPS } from '../src/contract/types.js';

const OPS_WITHOUT_SCROLL_TO: readonly Op[] = (OPS as readonly Op[]).filter((o) => o !== 'scroll_to');

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

const fileInput = (): ElementRecord =>
  el({
    tag: 'input',
    role: 'button',
    name: 'Document',
    type: 'file',
    path: '#doc',
    editable: false,
    fingerprint: { tag: 'input', role: 'button', name: 'Document', x: 0, y: 0 },
  });

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

type ConfigOver = Partial<WingmanConfig> & {
  gate?: { mode: GateMode };
  policy?: { mode: PolicyMode };
  takeover?: { threshold?: number; mode?: TakeoverMode; retry?: boolean };
  handoff?: { mode: 'forced' | 'optional'; tools?: 'browse-only' | 'all'; retain?: string[] };
};

function makeConfig(overrides: ConfigOver = {}): WingmanConfig {
  const { gate, policy, takeover, handoff, ...rest } = overrides;
  return {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    profile_dir: path.join(os.tmpdir(), 'jevw-chain-profile'),
    port: 9222,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
    ...rest,
    ...(gate ? { gate } : {}),
    ...(policy ? { policy } : {}),
    ...(takeover
      ? {
          takeover: {
            ...(takeover.threshold !== undefined ? { threshold: takeover.threshold } : {}),
            ...(takeover.mode !== undefined ? { mode: takeover.mode } : {}),
            ...(takeover.retry !== undefined ? { retry: takeover.retry } : {}),
          },
        }
      : {}),
    ...(handoff ? { handoff } : {}),
  } as WingmanConfig;
}

type NoulAnswers = {
  done?: number;
  blocked?: number;
  login?: number;
  error?: number;
  irreversible?: number;
  step_done?: number;
  right_page?: number;
  ready?: number;
};
type ChoiceAnswers = {
  action?: [string, Record<string, number>];
  target?: [string, Record<string, number>];
  value?: [string, Record<string, number>];
  group?: [string, Record<string, number>];
  option?: [string, Record<string, number>];
  key?: [string, Record<string, number>];
  url?: [string, Record<string, number>];
  file?: [string, Record<string, number>];
  recover?: [string, Record<string, number>];
};
type SeqEntry = NoulAnswers & ChoiceAnswers;

function choice(c: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: c, probabilities, confidence: 0.9 };
}

const NOUL_KEYS = ['done', 'blocked', 'login', 'error', 'irreversible', 'step_done', 'right_page', 'ready'] as const;
const CHOICE_KEYS = ['action', 'target', 'value', 'group', 'option', 'key', 'url', 'file', 'recover'] as const;

/** A standard committing chain round: click e1 0.9, page ready and right. */
function CS(over: SeqEntry = {}): SeqEntry {
  return {
    done: 0.05,
    blocked: 0.05,
    login: 0.05,
    error: 0.05,
    irreversible: 0.05,
    step_done: 0.05,
    ready: 0.95,
    right_page: 0.95,
    action: ['click', { click: 0.9, none: 0.05 }],
    target: ['e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }],
    ...over,
  };
}

/** A standard advance round: the clause is done. */
function ADV(over: SeqEntry = {}): SeqEntry {
  return {
    done: 0.05,
    blocked: 0.05,
    login: 0.05,
    error: 0.05,
    irreversible: 0.05,
    step_done: 0.95,
    ready: 0.95,
    right_page: 0.95,
    ...over,
  };
}

interface Harness {
  driver: FakeDriver;
  records: WingmanLogRecord[];
  requests: JevRequest[];
  askActs: number[];
  tokens: ConfirmTokenStore;
  deps: LoopDeps;
  call: (input: unknown) => Promise<WingmanResult>;
  callDo: (input: unknown) => Promise<WingmanResult>;
}

function harness(opts: {
  pages?: PageInfo[];
  observations: Record<string, Observation[]>;
  script: SeqEntry[];
  config?: ConfigOver;
  ask?: JevAsk | null;
  now?: () => number;
  forceMode?: Mode;
  lockCheck?: () => Promise<LockCheckResult>;
}): Harness {
  const driver = new FakeDriver({ pages: opts.pages ?? [page()], observations: opts.observations });
  const requests: JevRequest[] = [];
  const askActs: number[] = [];
  let call = 0;
  const script = opts.script;
  const scripted: JevAsk = async (request) => {
    requests.push(request);
    askActs.push(driver.actCalls().length);
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    const answers: Record<string, JevAnswer> = {};
    for (const key of NOUL_KEYS) {
      if (step[key] !== undefined) answers[key] = { type: 'noul', noul: step[key] as number };
    }
    for (const key of CHOICE_KEYS) {
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
  // ask: undefined → the script; ask: null → genuinely no key.
  const ask: JevAsk | null = opts.ask === undefined ? scripted : opts.ask;
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
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.forceMode ? { forceMode: opts.forceMode } : {}),
  };
  return {
    driver,
    records,
    requests,
    askActs,
    tokens,
    deps,
    call: (input: unknown) => runStep(input, deps),
    callDo: (input: unknown) => runDo(input, deps),
  };
}

// ---- § 5.5.5 forced-table lines, inlined (drift on either side fails) ----

const FORCED_BOUNCE_LINE =
  'Step returned to you. Call browse_step again with the same goal, steps and values plus pick: { role, name, action } naming the element to use (from step_review.candidates, or from your own snapshot or screenshot), or with a more specific step.';
const FORCED_ALREADY_DONE_LINE =
  'wingman judged this step already done and acted on nothing. Check the page with your own snapshot: if the step is not done, call browse_step again with pick naming the element; otherwise continue with the remaining steps.';
const FORCED_RESUME_LINE =
  'Not finished. Call browse_step again with the same goal, steps and values to resume from progress.';
const FORCED_OFFER_LINE =
  'Takeover available. Call browse_step again with the same arguments and takeover: true to accept.';
const FORCED_LOGIN_LINE =
  'The page asks for sign-in. Ask the user to sign in (including any two-factor step), then call browse_step again with the same arguments.';
const FORCED_DIALOG_LINE =
  'A dialog is open. Answer it with your own browser tools, then call browse_step again with the same arguments.';
const FORCED_UNAVAILABLE_LINE =
  'The wingman cannot act in this setup right now. Tell the user and ask them to run jev-browser-wingman doctor, which names the fix.';
const FORCED_TAB_LINE =
  'Several tabs could be the page. Call browse_step again with the same arguments plus url_match naming the page, or switch or close tabs with your own browser tools.';
const FORCED_VALUE_LINE =
  'A value was missing or unclear. Call browse_step again with the needed value in values and named in the step, or with pick naming the element and the value.';
const FORCED_BLOCKED_LINE =
  "The page is blocked by a captcha, an access notice or a covering overlay. Clear it with the user, or pick the overlay's dismiss control, then call browse_step again with the same arguments.";
const FORCED_SENSITIVE_LINE =
  'This page is sensitive under the active policy, so wingman sends nothing from it for a decision. Drive it with browse_step and pick naming each element (a pick makes no decision-service call), or ask the user to do this step.';
const FORCED_WRONG_PAGE_LINE =
  'This page does not fit the current step. Check where you are with your own snapshot, then call browse_step again with pick on the link that leads there, or with the page address in values and a step that opens it.';
const FORCED_NOT_READY_LINE =
  'The page did not finish loading what the step needs. Check it with your own snapshot; call browse_step again with the same arguments once it is ready, or with pick naming the element.';
const FORCED_PAGE_ERROR_LINE =
  'The page shows an error wingman could not recover from. Look at it with your own snapshot, then call browse_step again with pick or a changed step, or ask the user.';
const PICK_UNMATCHED_LINE =
  'The pick matched no single element. Call again with pick using a role and name from candidates, and add nth when several elements share them.';
const UNSUPPORTED_OP_LINE =
  'The active wingman adapter cannot perform this action. Do this step with your own browser tools, then call browse_step again with the remaining steps.';
const STATE_TOO_LARGE_LINE =
  'The page is too large for one decision. Take your own snapshot, then call browse_step again with pick naming the element to use.';
const CALLER_LINE =
  'Step returned to you — do this step with your browser tools, then call browse_step again with the same goal and your next proposed step.';
const TIER1 =
  'Retry with a more specific description of the target, or perform this step yourself with your raw browser tools.';
const RESUME_LINE =
  'Takeover paused — call browse_step again with the same goal (and the same values) to continue from here.';
const SENSITIVE_LINE =
  'This page is sensitive under the active policy. Do this step with your own browser tools, then call again once you reach a non-sensitive page.';

const FORCED: ConfigOver = { handoff: { mode: 'forced' } };

// ---- T1: three clauses, one act each ----

test('T1: three clauses act once each and end done with progress {3,3,3}', async () => {
  const three = [
    el(),
    el({ id: 'e2', path: '#e2', name: 'Second' }),
    el({ id: 'e3', path: '#e3', name: 'Third' }),
  ];
  const h = harness({
    observations: { p1: [observation({ elements: three })] },
    script: [
      CS({ target: ['e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }] }),
      ADV(),
      CS({ target: ['e2', { e2: 0.9, none: 0.05, ambiguous: 0.05 }] }),
      ADV(),
      CS({ target: ['e3', { e3: 0.9, none: 0.05, ambiguous: 0.05 }] }),
      ADV(),
    ],
  });
  const r = await h.call({
    goal: 'chain-t1 unique goal',
    steps: ['clause one', 'clause two', 'clause three'],
  });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.equal(r.steps, 3);
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 3);
  assert.deepEqual(acts.map((a) => a.elementId), ['e1', 'e2', 'e3']);
  assert.deepEqual(r.progress, { step_index: 3, steps_done: 3, steps_total: 3 });
});

// ---- T2: budget-steps mid-chain, then resume from memory ----

const T2_GOAL = 'chain-t2 unique resume goal';
const T2_STEPS = ['clause one target', 'clause two target', 'clause three target'];

/** A clause-aware ask: clause 1 acts on e1, clauses 2 and 3 on e2; each
 * clause's second round advances. With the memory cursor the re-call starts
 * on clause 3, so its first act lands on e2, not e1. */
function t2Ask(): JevAsk {
  let lastStep = '';
  let seen = 0;
  return async (request) => {
    const step = (request.state as { step?: string }).step ?? '';
    if (step !== lastStep) {
      lastStep = step;
      seen = 0;
    }
    seen += 1;
    const targetId = /one/.test(step) ? 'e1' : 'e2';
    const answers: Record<string, JevAnswer> = {
      done: { type: 'noul', noul: 0.05 },
      blocked: { type: 'noul', noul: 0.05 },
      login: { type: 'noul', noul: 0.05 },
      error: { type: 'noul', noul: 0.05 },
      irreversible: { type: 'noul', noul: 0.05 },
      right_page: { type: 'noul', noul: 0.95 },
      ready: { type: 'noul', noul: 0.95 },
    };
    if (seen === 1) {
      answers.step_done = { type: 'noul', noul: 0.05 };
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice(targetId, { [targetId]: 0.9, none: 0.05, ambiguous: 0.05 });
    } else {
      answers.step_done = { type: 'noul', noul: 0.95 };
    }
    return { ok: true, answers, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, status: 200, retries: 0 };
  };
}

test('T2: max_steps stops mid-chain with steps_done 2; the re-call resumes on clause 3', async () => {
  const els2 = [el(), el({ id: 'e2', path: '#e2', name: 'Second' })];
  const h1 = harness({ observations: { p1: [observation({ elements: els2 })] }, script: [], ask: t2Ask() });
  const r1 = await h1.call({ goal: T2_GOAL, steps: T2_STEPS, max_steps: 2 });
  assert.equal(r1.status, 'fallback');
  assert.equal(r1.reason, 'budget-steps');
  assert.deepEqual(r1.progress, { step_index: 3, steps_done: 2, steps_total: 3 });

  const h2 = harness({ observations: { p1: [observation({ elements: els2 })] }, script: [], ask: t2Ask() });
  const r2 = await h2.call({ goal: T2_GOAL, steps: T2_STEPS });
  assert.equal(r2.status, 'done');
  const acts = h2.driver.actCalls();
  assert.ok(acts.length >= 1);
  assert.equal(acts[0].elementId, 'e2', 'call 2 resumes on clause 3, whose element is e2 (clause 1 acts on e1)');
});

// ---- T3: changed steps start at 0 ----

test('T3: the same goal with changed steps starts at clause 1', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  await h1.call({ goal: 'chain-t3 shared goal', steps: ['alpha clause', 'beta clause'] });

  const h2 = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  const r2 = await h2.call({ goal: 'chain-t3 shared goal', steps: ['gamma clause'] });
  assert.equal(r2.status, 'done');
  const state0 = h2.requests[0].state as { step?: string };
  assert.equal(state0.step, 'gamma clause', 'the changed key restarts at the new clause 1');
});

// ---- T4: every clause already done, zero acts ----

test('T4: a fresh chain where every clause is already done ends already-done with zero acts', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [ADV()] });
  const r = await h.call({ goal: 'chain-t4 fresh zero-act goal', steps: ['done one', 'done two', 'done three'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'already-done');
  assert.equal(r.step_review?.step, 'done three');
  assert.deepEqual(r.step_review?.candidates, []);
  assert.deepEqual(r.progress, { step_index: 3, steps_done: 3, steps_total: 3 });
  assert.equal(r.steps, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

// ---- T5: legacy step, round-1 done twice → the zero-step guard ----

test('T5: a legacy entry whose round-1 done fires twice with zero acts bounces already-done', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [{ done: 0.9 }] });
  const r = await h.call({ goal: 'chain-t5 zero-step legacy goal', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'already-done');
  assert.equal(r.steps, 0);
  assert.equal(h.driver.actCalls().length, 0);
  // Optional mode: an already-done bounce escalates like any bounce; first
  // bounce on this goal is the caller line plus tier 1.
  assert.equal(r.note, `${CALLER_LINE} ${TIER1}`);
});

// ---- T6: a chain continuation non-commit retries, then bounces with evidence ----

test('T6: a chain non-commit retries once, then bounces with the redacted clause and progress', async () => {
  const values = { secret: 'SUPERSECRETVALUE' };
  const h = harness({
    observations: {
      p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })],
    },
    script: [CS({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
  });
  const r = await h.call({
    goal: 'chain-t6 unique non-commit goal',
    steps: ['split the SUPERSECRETVALUE target'],
    values,
  });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'low-confidence');
  assert.equal(r.step_review?.step, 'split the <value:secret> target');
  assert.deepEqual(r.progress, { step_index: 1, steps_done: 0, steps_total: 1 });
  assert.equal(h.driver.actCalls().length, 0);
  assert.ok(h.requests.length >= 2, 'the non-commit retried once before the bounce');
  assertNoValues(JSON.stringify(r), values);
  for (const q of h.requests) assertNoValues(JSON.stringify(q), values);
});

// ---- T6b: an ordinarily-committed (non-pick) obscured target bounces
// target-covered with evidence, never acts (§ 5.5.2 step 8 bullet 4;
// verifier fix — this path previously fell through to decideTarget/act
// unchecked, relying only on the adapter's live act-time check) ----

test('T6b: a non-pick chain commit onto an obscured element bounces target-covered with evidence', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ obscured: true, coveredBy: 'div#veil' })] })] },
    script: [CS()],
  });
  const r = await h.call({ goal: 'chain-t6b obscured non-pick goal', steps: ['click Details'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'target-covered');
  assert.equal(r.step_review?.why, 'target-covered');
  assert.equal(r.step_review?.candidates?.[0]?.label, 'button "Details"');
  assert.equal(r.step_review?.candidates?.[1]?.label, 'div#veil');
  assert.equal(h.driver.actCalls().length, 0);
});

// ---- T7: forced vs optional notes (all thirteen forced rows) ----

test('T7: every § 5.5.5 forced-table row is exact under forced; optional keeps today’s strings; forced bounces never escalate', async () => {
    const cases: Array<{ name: string; run: () => Promise<WingmanResult>; forced: string; optional?: string }> = [];

    cases.push({
      name: 'already-done',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [ADV()], config: FORCED });
        return h.call({ goal: 'chain-t7 done goal', steps: ['d1', 'd2'] });
      },
      forced: FORCED_ALREADY_DONE_LINE,
    });
    cases.push({
      name: 'wrong-page',
      run: async () => {
        const h = harness({
          observations: { p1: [observation()] },
          script: [CS({ right_page: 0.2 }), CS({ right_page: 0.2 })],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 wrong page goal', steps: ['w1'] });
      },
      forced: FORCED_WRONG_PAGE_LINE,
    });
    cases.push({
      name: 'not-ready',
      run: async () => {
        const h = harness({
          observations: { p1: [observation()] },
          script: [CS({ ready: 0.2 }), CS({ ready: 0.2 }), CS({ ready: 0.2 })],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 not ready goal', steps: ['n1'] });
      },
      forced: FORCED_NOT_READY_LINE,
    });
    cases.push({
      name: 'page-error',
      run: async () => {
        const h = harness({
          observations: { p1: [observation()] },
          script: [CS(), CS({ error: 0.9, recover: ['give-up', { 'give-up': 0.8, back: 0.05 }] })],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 page error goal', steps: ['e1'] });
      },
      forced: FORCED_PAGE_ERROR_LINE,
    });
    cases.push({
      name: 'step-uncertain (low-confidence)',
      run: async () => {
        const h = harness({
          observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
          script: [CS({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
          config: { ...FORCED, takeover: { retry: false } },
        });
        return h.call({ goal: 'chain-t7 bounce goal', steps: ['b1'] });
      },
      forced: FORCED_BOUNCE_LINE,
    });
    cases.push({
      name: 'target-covered',
      run: async () => {
        const h = harness({
          observations: { p1: [observation({ elements: [el({ obscured: true, coveredBy: 'div#veil' })] })] },
          script: [CS()],
          config: FORCED,
        });
        return h.call({
          goal: 'chain-t7 covered goal',
          steps: ['c1'],
          pick: { role: 'button', name: 'Details', action: 'click' },
        });
      },
      forced: FORCED_BOUNCE_LINE,
    });
    cases.push({
      name: 'takeover-offered',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [CS()], config: FORCED });
        return h.call({ goal: 'chain-t7 offer goal', steps: ['o1'], takeover: false });
      },
      forced: FORCED_OFFER_LINE,
    });
    cases.push({
      name: 'login',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [CS({ login: 0.9 })], config: FORCED });
        return h.call({ goal: 'chain-t7 login goal', steps: ['l1'] });
      },
      forced: FORCED_LOGIN_LINE,
    });
    cases.push({
      name: 'dialog-open',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [CS()], config: FORCED });
        h.driver.dialogOnNextObserve = { pageId: 'p1', type: 'alert', message: 'Hello' };
        return h.call({ goal: 'chain-t7 dialog goal', steps: ['dg1'] });
      },
      forced: FORCED_DIALOG_LINE,
    });
    cases.push({
      name: 'no-key',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [CS()], ask: null, config: FORCED });
        return h.call({ goal: 'chain-t7 nokey goal', steps: ['nk1'] });
      },
      forced: FORCED_UNAVAILABLE_LINE,
    });
    cases.push({
      name: 'tab-ambiguous',
      run: async () => {
        const h = harness({
          pages: [page(), page({ id: 'p2', url: 'https://example.com/b', title: 'Beta' })],
          observations: { p1: [observation()], p2: [observation({ url: 'https://example.com/b' })] },
          script: [CS()],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 tabs goal', steps: ['t1'] });
      },
      forced: FORCED_TAB_LINE,
    });
    cases.push({
      name: 'no-value (ambiguous, legacy continuation)',
      run: async () => {
        const h = harness({
          observations: {
            p1: [
              observation(),
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
          script: [CS(), CS({ action: ['fill', { fill: 0.9, click: 0.05 }], target: ['e1', { e1: 0.9 }] })],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 value goal', step: 'fill the email field' });
      },
      forced: FORCED_VALUE_LINE,
    });
    cases.push({
      name: 'blocked (captcha)',
      run: async () => {
        const h = harness({
          observations: { p1: [observation({ signals: { ...cleanSignals, captcha: true } })] },
          script: [CS()],
          config: FORCED,
        });
        return h.call({ goal: 'chain-t7 captcha goal', steps: ['cap1'] });
      },
      forced: FORCED_BLOCKED_LINE,
    });
    cases.push({
      name: 'resume (budget-steps)',
      run: async () => {
        const h = harness({ observations: { p1: [observation()] }, script: [CS()], config: FORCED });
        return h.call({ goal: 'chain-t7 resume goal', steps: ['r1'], max_steps: 1 });
      },
      forced: FORCED_RESUME_LINE,
    });

    for (const c of cases) {
      const r = await c.run();
      assert.equal(r.note, c.forced, `forced row ${c.name}: note drift`);
    }

    // Optional keeps today's strings.
    const optBounce = harness({
      observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
      script: [CS({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
      config: { takeover: { retry: false } },
    });
    const ob = await optBounce.call({ goal: 'chain-t7 optional bounce goal', steps: ['ob1'] });
    assert.equal(ob.note, `${CALLER_LINE} ${TIER1}`);

    const optWrongPage = harness({
      observations: { p1: [observation()] },
      script: [CS({ right_page: 0.2 }), CS({ right_page: 0.2 })],
    });
    const ow = await optWrongPage.call({ goal: 'chain-t7 optional wrong page goal', steps: ['ow1'] });
    assert.equal(ow.step_review?.why, 'wrong-page');
    assert.ok(ow.note?.startsWith(CALLER_LINE), 'optional wrong-page bounce keeps the caller line');

    const optPageError = harness({
      observations: { p1: [observation()] },
      script: [CS(), CS({ error: 0.9, recover: ['give-up', { 'give-up': 0.8, back: 0.05 }] })],
    });
    const oe = await optPageError.call({ goal: 'chain-t7 optional page error goal', steps: ['oe1'] });
    assert.equal(oe.reason, 'page-error');
    assert.equal(oe.note, RESUME_LINE, 'page-error keeps the resume line, as today');

    // Forced bounces never move the escalation counter: two forced bounces on
    // one goal both carry the flat forced line.
    const f1 = harness({
      observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
      script: [CS({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
      config: { ...FORCED, takeover: { retry: false } },
    });
    const r1 = await f1.call({ goal: 'chain-t7 escalate goal', steps: ['f1'] });
    const f2 = harness({
      observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
      script: [CS({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }] })],
      config: { ...FORCED, takeover: { retry: false } },
    });
    const r2 = await f2.call({ goal: 'chain-t7 escalate goal', steps: ['f1'] });
    assert.equal(r1.note, FORCED_BOUNCE_LINE);
    assert.equal(r2.note, FORCED_BOUNCE_LINE, 'the second forced bounce did not escalate');
});

// ---- T8: pick integration ----

test('T8: a pick acts with zero asks, and the chain continues after it', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [ADV()] });
  const r = await h.call({
    goal: 'chain-t8 pick continue goal',
    steps: ['click the Details button'],
    pick: { role: 'button', name: 'Details', action: 'click' },
  });
  assert.equal(r.status, 'done');
  assert.equal(r.steps, 1);
  assert.equal(h.driver.actCalls().length, 1);
  // Zero asks before the act: when the first ask fired, the pick act had run.
  assert.equal(h.askActs.length, 1);
  assert.equal(h.askActs[0], 1, 'the pick act preceded every ask');
});

test('T8: a multi-match pick returns the unmatched line with both candidates and zero acts', async () => {
  const h = harness({
    observations: {
      p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Details' })] })],
    },
    script: [CS()],
  });
  const r = await h.call({
    goal: 'chain-t8 multi goal',
    steps: ['c1'],
    pick: { role: 'button', name: 'Details', action: 'click' },
  });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.equal(r.note, PICK_UNMATCHED_LINE);
  assert.ok((r.candidates ?? []).length === 2, 'both matches carried as candidates');
  for (const c of r.candidates ?? []) {
    assert.equal(c.role, 'button');
    assert.equal(c.name, 'Details');
  }
  assert.equal(h.driver.actCalls().length, 0);
});

test('T8: a pick onto an obscured element returns target-covered', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ obscured: true, coveredBy: 'div#veil' })] })] },
    script: [CS()],
  });
  const r = await h.call({
    goal: 'chain-t8 obscured goal',
    steps: ['c1'],
    pick: { role: 'button', name: 'Details', action: 'click' },
  });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'target-covered');
  assert.equal(r.step_review?.why, 'target-covered');
  const labels = (r.step_review?.candidates ?? []).map((c) => c.label);
  assert.ok(labels.length >= 1);
  assert.ok(labels.some((l) => l.includes('div#veil')), 'the cover named in evidence');
  assert.equal(h.driver.actCalls().length, 0);
});

test('T8: a pick onto a submit button under gate confirm returns needs_confirmation', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [ADV()],
    config: { gate: { mode: 'confirm' } },
  });
  const r = await h.call({
    goal: 'chain-t8 gate goal',
    steps: ['place the order'],
    pick: { role: 'button', name: 'Place order', action: 'click' },
  });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-heuristic');
  assert.match(r.confirm_token ?? '', /^wct_/);
  assert.equal(h.driver.actCalls().length, 0);
});

// ---- T9: navigate ----

test('T9: navigate acts only from a url-typed binding; other answers bounce no-value with zero navigate acts', async () => {
  const good = harness({
    observations: { p1: [observation()] },
    script: [
      CS({
        action: ['navigate', { navigate: 0.9, click: 0.05 }],
        url: ['dest', { dest: 0.9, none: 0.05 }],
      }),
      ADV(),
    ],
  });
  const rg = await good.call({
    goal: 'chain-t9 good nav goal',
    steps: ['open the page'],
    values: { dest: 'https://example.com/next' },
  });
  assert.equal(rg.status, 'done');
  const navActs = good.driver.actCalls().filter((a) => a.op === 'navigate');
  assert.equal(navActs.length, 1);
  assert.equal(navActs[0].elementId, null);
  assert.equal(navActs[0].value, 'https://example.com/next');

  // Three distinct failure modes, each actually answered (not merely absent):
  // 'none' (Jev names no binding), 'note' (a real binding that is not
  // url-typed), and a raw string that names no binding at all.
  for (const urlAnswer of ['none', 'note', 'https://evil.example/']) {
    const h = harness({
      observations: { p1: [observation()] },
      script: [
        CS({
          action: ['navigate', { navigate: 0.9, click: 0.05 }],
          url: [urlAnswer, { [urlAnswer]: 0.9, dest: 0.05 }],
        }),
      ],
    });
    const r = await h.call({
      goal: `chain-t9 nav bad ${urlAnswer} goal`,
      steps: ['open the page'],
      values: { dest: 'https://example.com/next', note: 'plain text' },
    });
    assert.equal(r.status, 'fallback', `url answer ${urlAnswer}`);
    assert.equal(r.reason, 'step-uncertain', `url answer ${urlAnswer}`);
    assert.equal(r.step_review?.why, 'no-value', `url answer ${urlAnswer}`);
    assert.equal(
      h.driver.actCalls().filter((a) => a.op === 'navigate').length,
      0,
      `url answer ${urlAnswer}`,
    );
  }
});

test('T9: wingman_do action criteria never contain navigate or back', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), { done: 0.9 }],
    config: { handoff: { mode: 'optional', tools: 'all' } },
  });
  const r = await h.callDo({ goal: 'chain-t9 do criteria goal', values: { dest: 'https://example.com/x' } });
  assert.equal(r.status, 'done');
  const criteria = h.requests[0].questions.action.criteria as Record<string, unknown>;
  assert.ok(!('navigate' in criteria));
  assert.ok(!('back' in criteria));
});

// ---- T10: upload ----

test('T10: a click on a file input with a path binding converts to upload and acts with the path', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [fileInput()] })] },
    script: [CS({ file: ['doc', { doc: 0.9, none: 0.05 }] }), ADV()],
  });
  const r = await h.call({
    goal: 'chain-t10 upload good goal',
    steps: ['attach the document'],
    values: { doc: 'C:/tmp/report.pdf' },
  });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].op, 'upload');
  assert.equal(acts[0].value, 'C:/tmp/report.pdf');
  assert.equal(acts[0].elementId, 'e1');
});

test('T10: a click on a file input with no path binding is no-value with zero acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [fileInput()] })] },
    script: [CS()],
  });
  const r = await h.call({ goal: 'chain-t10 upload bad goal', steps: ['attach the document'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-value');
  assert.equal(h.driver.actCalls().length, 0);
});

// ---- T11: press keys ----

test('T11: chain press acts with the key answer; none or low key bounces low-confidence', async () => {
  for (const key of ['ShiftTab', 'SelectAll']) {
    const h = harness({
      observations: { p1: [observation()] },
      script: [CS({ action: ['press', { press: 0.9, click: 0.05 }], key: [key, { [key]: 0.9, none: 0.05 }] }), ADV()],
    });
    const r = await h.call({ goal: `chain-t11 press ${key} goal`, steps: ['press the key'] });
    assert.equal(r.status, 'done', `key ${key}`);
    const acts = h.driver.actCalls();
    assert.equal(acts.length, 1, `key ${key}`);
    assert.equal(acts[0].op, 'press', `key ${key}`);
    assert.equal(acts[0].value, key, `key ${key}`);
  }

  for (const keySpec of [['none', { none: 0.9 }], ['Tab', { Tab: 0.3, none: 0.05 }]] as const) {
    const h = harness({
      observations: { p1: [observation()] },
      script: [CS({ action: ['press', { press: 0.9, click: 0.05 }], key: [...keySpec] as [string, Record<string, number>] })],
    });
    const r = await h.call({ goal: `chain-t11 press bad ${keySpec[0]} goal`, steps: ['press the key'] });
    assert.equal(r.status, 'fallback', `key ${keySpec[0]}`);
    assert.equal(r.step_review?.why, 'low-confidence', `key ${keySpec[0]}`);
    assert.equal(h.driver.actCalls().length, 0, `key ${keySpec[0]}`);
  }
});

test('T11: wingman_do press falls back to Enter on a low key answer', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ action: ['press', { press: 0.9, click: 0.05 }], key: ['Tab', { Tab: 0.3, none: 0.05 }] }), { done: 0.9 }],
    config: { handoff: { mode: 'optional', tools: 'all' } },
  });
  const r = await h.callDo({ goal: 'chain-t11 do press goal' });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].op, 'press');
  assert.equal(acts[0].value, 'Enter');
});

// ---- T12: scroll with target none ----

test('T12: a chain scroll round with target none acts (null, scroll)', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ action: ['scroll', { scroll: 0.9, click: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] }), ADV()],
  });
  const r = await h.call({ goal: 'chain-t12 scroll goal', steps: ['scroll down'] });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].elementId, null);
  assert.equal(acts[0].op, 'scroll');
});

// ---- T13: wait ----

test('T13: wait acts leave steps unchanged; the wait after the cap bounces no-match', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ action: ['wait', { wait: 0.9, click: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] })],
  });
  const r = await h.call({ goal: 'chain-t13 wait goal', steps: ['wait for it'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(r.steps, 0, 'wait acts never count as steps');
  assert.equal(h.driver.actCalls().length, WAIT_MAX_PER_CALL, 'exactly the capped number of waits ran');
  for (const a of h.driver.actCalls()) {
    assert.equal(a.op, 'wait');
    assert.equal(a.elementId, null);
  }
});

// ---- T14: budget-time mid-chain ----

test('T14: a mid-chain time budget ends budget-time with the correct progress', async () => {
  let t = 0;
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), ADV()],
    now: () => t,
  });
  h.driver.onObserve = () => {
    t += 2000;
  };
  const r = await h.call({ goal: 'chain-t14 budget goal', steps: ['b1', 'b2', 'b3'], max_ms: 6000 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-time');
  assert.deepEqual(r.progress, { step_index: 2, steps_done: 1, steps_total: 3 });
  assert.equal(h.driver.actCalls().length, 1, 'one act landed before the budget end');
});

// ---- T15: dense page + targetless action → request 1 only ----

test('T15: a two-stage round with a targetless action choice skips request 2', async () => {
  const many = Array.from({ length: 6 }, (_, i) => el({ id: `e${i + 1}`, name: `Row ${i + 1}`, path: `#r${i + 1}` }));
  const h = harness({
    observations: { p1: [observation({ elements: many })] },
    script: [
      CS({
        action: ['scroll', { scroll: 0.9, click: 0.05 }],
        target: ['none', { none: 0.9 }],
        group: ['g1', { g1: 0.9, g2: 0.05 }],
      }),
      ADV({ group: ['g1', { g1: 0.9, g2: 0.05 }] }),
    ],
    config: { budgets: { ...DEFAULT_BUDGETS, max_elements: 4 } },
  });
  const r = await h.call({ goal: 'chain-t15 dense goal', steps: ['scroll the page'] });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 1);
  for (const q of h.requests) {
    assert.ok('group' in q.questions, 'two-stage requests are group requests');
    assert.ok(!('target' in q.questions), 'request 2 was never needed: no target question anywhere');
  }
});

// ---- T16: assertNoValues over T1/T6/T9-shaped traffic ----

test('T16: no binding value appears in the requests or results of chain traffic', async () => {
  const values = { secret: 'SUPERSECRETVALUE', dest: 'https://example.com/token?SECRETVALUE' };
  const h = harness({
    observations: {
      p1: [observation({ elements: [el({ name: 'SUPERSECRETVALUE field' })] })],
    },
    script: [
      CS({ target: ['e1', { e1: 0.6, e2: 0.05, none: 0.3, ambiguous: 0.05 }] }),
      CS(),
      ADV(),
    ],
  });
  const r = await h.call({
    goal: 'chain-t16 leak goal about SUPERSECRETVALUE',
    steps: ['type the value named secret into the field', 'open dest'],
    values,
  });
  assertNoValues(JSON.stringify(r), values);
  for (const q of h.requests) assertNoValues(JSON.stringify(q), values);
  const rec = JSON.stringify(h.records[0] ?? {});
  assertNoValues(rec, values);
});

// ---- T17: log record key set ----

test('T17: the chain log record carries only § 5.1 fields plus progress and acts_by_op', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  const r = await h.call({ goal: 'chain-t17 log goal', steps: ['l1'] });
  assert.equal(r.status, 'done');
  assert.equal(h.records.length, 1);
  const allowed = new Set([
    'ts', 'tool', 'mode', 'adapter', 'status', 'reason', 'steps', 'host', 'gate_hits',
    'jev_calls', 'input_tokens', 'output_tokens', 'ms', 'would', 'phases',
    'progress', 'pick', 'acts_by_op',
  ]);
  for (const key of Object.keys(h.records[0])) {
    assert.ok(allowed.has(key), `unexpected log key ${key}`);
  }
  assert.deepEqual(h.records[0].progress, { step_index: 1, steps_done: 1, steps_total: 1 });
  assert.deepEqual(h.records[0].acts_by_op, { click: 1 });
});

// ---- T18: capability negotiation ----

test('T18: a legacy driver never sees a new verb offered; a pick hover is unsupported-op', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  h.driver.ops = LEGACY_OPS;
  const r = await h.call({ goal: 'chain-t18 legacy ops goal', steps: ['l1'] });
  assert.equal(r.status, 'done');
  const criteria = h.requests[0].questions.action.criteria as Record<string, unknown>;
  for (const key of Object.keys(criteria)) {
    if (key === 'none') continue;
    assert.ok(
      (LEGACY_OPS as readonly string[]).includes(key),
      `op ${key} offered to a LEGACY_OPS driver`,
    );
  }

  const h2 = harness({ observations: { p1: [observation()] }, script: [CS()] });
  h2.driver.ops = LEGACY_OPS;
  const r2 = await h2.call({
    goal: 'chain-t18 pick hover goal',
    steps: ['h1'],
    pick: { role: 'button', name: 'Details', action: 'hover' },
  });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.reason, 'unsupported-op');
  assert.equal(r2.note, UNSUPPORTED_OP_LINE);
  assert.equal(r2.steps, 0);
  assert.equal(h2.driver.actCalls().length, 0);
  assert.equal(h2.requests.length, 0, 'the unsupported pick never asked');
});

// ---- T19: the verbatim t9 first call passes validation (C1) ----

test('T19: the verbatim 549-char t9 goal with seven steps and numeric values validates', async () => {
  const t9Goal =
    'Multi-page chain, in order: open Checkboxes and tick the first checkbox; open Dropdown and choose Option 1; open Add/Remove Elements and click the Add Element button twice; open Inputs and type the value named amount into the unlabeled number input, the only input field on the page; open Forgot Password, enter the value named email into the E-mail field and click the Retrieve password button; open Dynamic Loading, open the link named Example 2: Element rendered after the fact and click the Start button; open Status Codes and open the 404 link.';
  assert.equal(t9Goal.length, 549);
  const h = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  const r = await h.call({
    goal: t9Goal,
    steps: [
      'open Checkboxes and tick the first checkbox',
      'open Dropdown and choose Option 1',
      'open Add/Remove Elements and click the Add Element button twice',
      'open Inputs and type the value named amount into the unlabeled number input, the only input field on the page',
      'open Forgot Password, enter the value named email into the E-mail field and click the Retrieve password button',
      'open Dynamic Loading, open the link named Example 2: Element rendered after the fact and click the Start button',
      'open Status Codes and open the 404 link.',
    ],
    values: { amount: 77, email: 'wingman@example.com' },
    max_steps: 1,
  });
  assert.notEqual(r.reason, 'invalid-input');
  assert.notEqual(r.status, 'error');
});

// ---- T20: validation messages, exact ----

const INVALID = 'Invalid input: ';

test('T20: every § 5.5.1 validation row reports its exact message', async () => {
  const cases: Array<{ input: unknown; message: string }> = [
    { input: 'nope', message: 'arguments must be an object with at least a goal.' },
    { input: { goal: 'g', bogus: 1 }, message: 'unknown argument bogus; allowed: goal, steps, step, values, pick, url_match, confirm_token, takeover, max_steps, max_ms.' },
    { input: { goal: '' }, message: 'goal must be a non-empty string of at most 2000 characters; move detail into steps.' },
    { input: { goal: 'x'.repeat(2001) }, message: 'goal must be a non-empty string of at most 2000 characters; move detail into steps.' },
    { input: { goal: 'g', steps: [] }, message: 'steps must be an array of 1 to 12 non-empty strings of at most 300 characters; merge or shorten steps, or send the rest on the next call.' },
    { input: { goal: 'g', steps: 'nope' }, message: 'steps must be an array of 1 to 12 non-empty strings of at most 300 characters; merge or shorten steps, or send the rest on the next call.' },
    { input: { goal: 'g', steps: Array.from({ length: 13 }, (_, i) => `s${i}`) }, message: 'steps must be an array of 1 to 12 non-empty strings of at most 300 characters; merge or shorten steps, or send the rest on the next call.' },
    { input: { goal: 'g', step: '' }, message: 'step must be a non-empty string of at most 300 characters.' },
    { input: { goal: 'g', step: 'x'.repeat(301) }, message: 'step must be a non-empty string of at most 300 characters.' },
    { input: { goal: 'g', values: { 'Bad Name': 'x' } }, message: 'value name Bad Name is invalid; use lowercase letters, digits and underscores, starting with a letter.' },
    { input: { goal: 'g', values: { ok: null } }, message: 'value ok must be text of at most 2000 characters.' },
    { input: { goal: 'g', values: { ok: 'x'.repeat(2001) } }, message: 'value ok must be text of at most 2000 characters.' },
    { input: { goal: 'g', steps: ['type the value named zip into ZIP'] }, message: 'the steps name the value zip, which is missing from values; add values.zip.' },
    { input: { goal: 'g', steps: ['s1'], pick: {} }, message: 'pick needs action, plus role and name for element actions, and value (the name of a binding in values) for fill, select, navigate and upload.' },
    { input: { goal: 'g', steps: ['s1'], pick: { action: 'click' }, confirm_token: 'wct_x' }, message: 'pick and confirm_token cannot be combined; send confirm_token alone to confirm, or pick alone.' },
    { input: { goal: 'g', steps: ['s1'], takeover: 'yes' }, message: 'takeover must be true or false.' },
    { input: { goal: 'g', steps: ['s1'], max_steps: 25 }, message: 'max_steps must be an integer from 1 to 24.' },
    { input: { goal: 'g', steps: ['s1'], max_ms: 121 }, message: 'max_ms must be an integer from 1000 to 120000.' },
    { input: { goal: 'g', steps: ['s1'], max_ms: 999 }, message: 'max_ms must be an integer from 1000 to 120000.' },
    { input: { goal: 'g', steps: ['s1'], url_match: 'x'.repeat(201) }, message: 'url_match must be a string of at most 200 characters.' },
    { input: { goal: 'g', steps: ['s1'], confirm_token: 42 }, message: 'confirm_token must be the string returned by needs_confirmation.' },
  ];
  for (const c of cases) {
    const h = harness({ observations: { p1: [observation()] }, script: [] });
    const r = await h.call(c.input);
    assert.equal(r.status, 'error', JSON.stringify(c.input));
    assert.equal(r.reason, 'invalid-input', JSON.stringify(c.input));
    assert.equal(r.note, INVALID + c.message, JSON.stringify(c.input));
  }

  // The 21-entry values case needs a real object; built here for clarity.
  const many: Record<string, string> = {};
  for (let i = 0; i < 21; i++) many[`v${i}`] = 'x';
  const h = harness({ observations: { p1: [observation()] }, script: [] });
  const r = await h.call({ goal: 'g', values: many });
  assert.equal(r.reason, 'invalid-input');
  assert.equal(r.note, INVALID + 'values must be an object of at most 20 entries.');
});

// ---- T21: done-before-error (C2) ----

test('T21: a reached target page ends done, not page-error (legacy and chain)', async () => {
  const legacy = harness({
    observations: { p1: [observation()] },
    script: [CS(), { done: 0.9, error: 0.9 }],
  });
  const rl = await legacy.call({ goal: 'chain-t21 legacy 404 goal', step: 'open the page' });
  assert.equal(rl.status, 'done');
  assert.equal(rl.reason, 'goal-met');

  const chain = harness({
    observations: { p1: [observation()] },
    script: [CS(), ADV({ error: 0.9 })],
  });
  const rc = await chain.call({ goal: 'chain-t21 chain 404 goal', steps: ['open the page'] });
  assert.equal(rc.status, 'done');
  assert.notEqual(rc.reason, 'page-error');
});

// ---- T22: state size (C10) ----

test('T22: oversized text is cut; a payload that cannot fit ends state-too-large', async () => {
  // The § 5.5.7 sizing measured here is JSON.stringify(state).length PLUS the
  // serialized length of the single longest question (orchestrator decision,
  // 2026-09-27 — not the whole request, whose ~4900 chars of fixed per-round
  // question overhead would make the spec's 2000 floor dead for chain mode).
  // At the spec's 2000 floor: with text '' the non-text baseline here is
  // stateLen(162) + the longest question ('action', 1107) = 1269. With text
  // 'x'.repeat(5000) the metric is 1269 + 5000 = 6269, excess over 2000 is
  // 4269, so the cut leaves text.length = 5000 - 4269 = 731 and the metric
  // lands exactly at 1269 + 731 = 2000 (<= 2000, fits).
  const cut = harness({
    observations: { p1: [observation({ text: 'x'.repeat(5000) })] },
    script: [CS(), ADV()],
    config: { budgets: { ...DEFAULT_BUDGETS, max_state_chars: 2000 } },
  });
  const rc = await cut.call({ goal: 'chain-t22 cut goal', steps: ['c1'] });
  assert.equal(rc.status, 'done');
  const req0 = cut.requests[0];
  const state0 = req0.state as { text: string };
  assert.ok(state0.text.length < 5000, 'text was cut to fit');
  const stateLen = JSON.stringify(req0.state).length;
  const maxQuestionLen = Math.max(...Object.values(req0.questions).map((q) => JSON.stringify(q).length));
  assert.ok(stateLen + maxQuestionLen <= 2000, 'state + longest question fits after the cut');

  const many = Array.from({ length: 60 }, (_, i) =>
    el({ id: `e${i + 1}`, path: `#e${i + 1}`, name: `Element number ${i + 1} with a long descriptive name` }),
  );
  const over = harness({
    observations: { p1: [observation({ elements: many, text: 'y'.repeat(3000) })] },
    script: [CS()],
    config: { budgets: { ...DEFAULT_BUDGETS, max_state_chars: 2000 } },
  });
  const ro = await over.call({ goal: 'chain-t22 over goal', steps: ['c1'] });
  assert.equal(ro.status, 'fallback');
  assert.equal(ro.reason, 'state-too-large');
  assert.equal(ro.note, STATE_TOO_LARGE_LINE);
  assert.equal(ro.steps, 0);
  assert.equal(over.driver.actCalls().length, 0);
});

test('T22b: the fixed per-round question overhead alone never triggers state-too-large; state + longest question over the limit still does', async () => {
  // Regression pin for the § 5.5.7 measure (2026-09-27): a round's full
  // question set (done/blocked/login/irreversible/action/target/step_done/
  // right_page/ready, ~3900+ chars serialized together, per the T22 comment
  // above) is already bigger than max_state_chars: 2000 on its own. Sizing
  // against the whole request would flag every chain round as
  // state-too-large regardless of how small the page actually is. Sizing
  // against state + the single longest question must NOT flag this: the
  // default fixture's state and elements are tiny, so state + longest
  // question stays well under 2000.
  const small = harness({
    observations: { p1: [observation()] },
    script: [CS(), ADV()],
    config: { budgets: { ...DEFAULT_BUDGETS, max_state_chars: 2000 } },
  });
  const rs = await small.call({ goal: 'chain-t22b small goal', steps: ['b1'] });
  assert.equal(rs.status, 'done');
  assert.notEqual(rs.reason, 'state-too-large');

  // The other side of the same rule: when state + the longest question DOES
  // exceed the limit (a big element list swells the target criteria, per the
  // T22 over-leg above), it must still end state-too-large.
  const many = Array.from({ length: 60 }, (_, i) =>
    el({ id: `e${i + 1}`, path: `#e${i + 1}`, name: `Element number ${i + 1} with a long descriptive name` }),
  );
  const large = harness({
    observations: { p1: [observation({ elements: many, text: 'y'.repeat(3000) })] },
    script: [CS()],
    config: { budgets: { ...DEFAULT_BUDGETS, max_state_chars: 2000 } },
  });
  const rl = await large.call({ goal: 'chain-t22b large goal', steps: ['b1'] });
  assert.equal(rl.status, 'fallback');
  assert.equal(rl.reason, 'state-too-large');
});

// ---- T23: right_page (Q5) ----

test('T23: two consecutive low right_page rounds on one clause bounce wrong-page', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ right_page: 0.2 }), CS({ right_page: 0.2 })],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-t23 wrong page goal', steps: ['w1'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'wrong-page');
  assert.deepEqual(r.step_review?.candidates, []);
  assert.equal(r.note, FORCED_WRONG_PAGE_LINE);
  assert.equal(h.driver.actCalls().length, 1, 'the first low round still acted');
});

test('T23: right_page low then high does not bounce, and an advance resets the counter', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ right_page: 0.2 }), CS({ right_page: 0.9 }), ADV()],
  });
  const r = await h.call({ goal: 'chain-t23 recover goal', steps: ['r1', 'r2'] });
  assert.equal(r.status, 'done');

  const h2 = harness({
    observations: { p1: [observation()] },
    script: [CS({ right_page: 0.2 }), ADV(), CS({ right_page: 0.2 }), ADV()],
  });
  const r2 = await h2.call({ goal: 'chain-t23 reset goal', steps: ['p1', 'p2'] });
  assert.equal(r2.status, 'done', 'the advance reset the wrong-page counter');
});

// ---- T24: ready (Q5) ----

test('T24: a not-ready round waits without counting a step; three low rounds bounce not-ready', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ ready: 0.2 }), CS({ ready: 0.2 }), CS({ ready: 0.2 })],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-t24 not ready goal', steps: ['n1'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'not-ready');
  assert.deepEqual(r.step_review?.candidates, []);
  assert.equal(r.note, FORCED_NOT_READY_LINE);
  const waits = h.driver.actCalls();
  assert.equal(waits.length, 2, 'two mechanical waits, then the bounce');
  for (const w of waits) {
    assert.equal(w.op, 'wait');
    assert.equal(w.elementId, null);
  }
  assert.equal(r.steps, 0, 'wait acts never count as steps');
});

test('T24: ready low then high decides normally', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ ready: 0.2 }), CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-t24 ready later goal', steps: ['r1', 'r2'] });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls()[0].op, 'wait');
  assert.equal(h.driver.actCalls()[1].op, 'click');
});

test('T24: a driver without wait settles instead of acting on a not-ready round', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS({ ready: 0.2 }), CS({ ready: 0.2 }), CS({ ready: 0.2 })],
  });
  h.driver.ops = LEGACY_OPS;
  const r = await h.call({ goal: 'chain-t24 no wait op goal', steps: ['n1'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'not-ready');
  assert.equal(h.driver.actCalls().length, 0, 'no wait act without the op');
  assert.ok(h.driver.events.some((e) => e.kind === 'settle'), 'settle ran instead');
});

// ---- T25: recover (Q5) ----

type ActEvent = ReturnType<FakeDriver['actCalls']>[number];

async function recoverCase(
  recoverAnswer: [string, Record<string, number>],
  goal: string,
): Promise<{ r: WingmanResult; acts: ActEvent[] }> {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), CS({ error: 0.9, recover: recoverAnswer })],
  });
  const r = await h.call({ goal, steps: ['c1'] });
  return { r, acts: h.driver.actCalls() };
}

test('T25: recover back, reload, wait and continue act; give-up and a low answer end page-error', async () => {
  const back = await recoverCase(['back', { back: 0.8, reload: 0.05 }], 'chain-t25 back goal');
  const backAct = back.acts.find((a) => a.op === 'back');
  assert.ok(backAct, 'the recover back act ran');
  assert.equal(backAct.elementId, null);

  const reload = await recoverCase(['reload', { reload: 0.8, back: 0.05 }], 'chain-t25 reload goal');
  const reloadAct = reload.acts.find((a) => a.op === 'reload');
  assert.ok(reloadAct);
  assert.equal(reloadAct.elementId, null);

  const wait = await recoverCase(['wait', { wait: 0.8, back: 0.05 }], 'chain-t25 wait goal');
  const waitAct = wait.acts.find((a) => a.op === 'wait');
  assert.ok(waitAct);
  assert.equal(waitAct.elementId, null);

  const giveUp = await recoverCase(['give-up', { 'give-up': 0.8, back: 0.05 }], 'chain-t25 give-up goal');
  assert.equal(giveUp.r.status, 'error');
  assert.equal(giveUp.r.reason, 'page-error');
  assert.equal(giveUp.r.note, RESUME_LINE, 'optional page-error keeps the resume line');
  assert.equal(giveUp.acts.length, 1, 'no recover act fired on give-up');

  const low = await recoverCase(['back', { back: 0.5, reload: 0.05 }], 'chain-t25 low recover goal');
  assert.equal(low.r.status, 'error');
  assert.equal(low.r.reason, 'page-error');
});

test('T25: continue falls through to the normal decision; the cap ends page-error', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), CS({ error: 0.9, recover: ['continue', { continue: 0.8, back: 0.05 }] }), ADV()],
  });
  const r = await h.call({ goal: 'chain-t25 continue goal', steps: ['c1'] });
  assert.equal(r.status, 'done');
  const clickAct = h.driver.actCalls().find((a) => a.op === 'click');
  assert.ok(clickAct, 'the normal decision acted after continue');

  // Two recover acts on one clause, then a third error → page-error.
  const h2 = harness({
    observations: { p1: [observation()] },
    script: [
      CS(),
      CS({ error: 0.9, recover: ['wait', { wait: 0.9, back: 0.05 }] }),
      CS({ error: 0.9, recover: ['wait', { wait: 0.9, back: 0.05 }] }),
      CS({ error: 0.9, recover: ['wait', { wait: 0.9, back: 0.05 }] }),
    ],
    config: FORCED,
  });
  const r2 = await h2.call({ goal: 'chain-t25 cap goal', steps: ['c1'] });
  assert.equal(r2.status, 'error');
  assert.equal(r2.reason, 'page-error');
  assert.equal(r2.note, FORCED_PAGE_ERROR_LINE);
});

test('T25: legacy browse_step recovers the same way; wingman_do never asks recover', async () => {
  const legacy = harness({
    observations: { p1: [observation()] },
    script: [CS(), CS({ error: 0.9, recover: ['back', { back: 0.8 }] }), ADV()],
  });
  const rl = await legacy.call({ goal: 'chain-t25 legacy recover goal', step: 's' });
  assert.notEqual(rl.reason, 'page-error');
  assert.ok(legacy.driver.actCalls().some((a) => a.op === 'back'));

  const doHarness = harness({
    observations: { p1: [observation()] },
    script: [CS(), { error: 0.9 }, { done: 0.9 }],
    config: { handoff: { mode: 'optional', tools: 'all' } },
  });
  const rd = await doHarness.callDo({ goal: 'chain-t25 do error goal' });
  assert.equal(rd.status, 'error');
  assert.equal(rd.reason, 'page-error');
  for (const q of doHarness.requests) {
    assert.ok(!('recover' in q.questions), 'wingman_do is never asked recover');
  }
});

// ---- T26: scroll_to (Q5) ----

test('T26: scroll_to acts on its committed target; a non-committing target scrolls down instead', async () => {
  const five = [
    el(),
    el({ id: 'e2', path: '#e2', name: 'Second' }),
    el({ id: 'e3', path: '#e3', name: 'Third' }),
    el({ id: 'e4', path: '#e4', name: 'Fourth' }),
    el({ id: 'e5', path: '#e5', name: 'Fifth' }),
  ];
  const h = harness({
    observations: { p1: [observation({ elements: five })] },
    script: [CS({ action: ['scroll_to', { scroll_to: 0.9, click: 0.05 }], target: ['e5', { e5: 0.9, e1: 0.05 }] }), ADV()],
  });
  const r = await h.call({ goal: 'chain-t26 scroll to goal', steps: ['scroll to Fifth'] });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].op, 'scroll_to');
  assert.equal(acts[0].elementId, 'e5');

  const h2 = harness({
    observations: { p1: [observation({ elements: five })] },
    script: [CS({ action: ['scroll_to', { scroll_to: 0.9, click: 0.05 }], target: ['e5', { e5: 0.3, e1: 0.3, none: 0.3 }] }), ADV()],
  });
  const r2 = await h2.call({ goal: 'chain-t26 scroll fallback goal', steps: ['scroll to Fifth'] });
  assert.equal(r2.status, 'done', 'the fallback scroll is not a non-commit');
  const acts2 = h2.driver.actCalls();
  assert.equal(acts2.length, 1);
  assert.equal(acts2[0].op, 'scroll');
  assert.equal(acts2[0].elementId, null);
});

// ---- T27: offered set (Q5) ----

test('T27: a chain request offers scroll_to, never reload; the offered set intersects driver ops', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  const r = await h.call({ goal: 'chain-t27 offered goal', steps: ['o1'] });
  assert.equal(r.status, 'done');
  const criteria = h.requests[0].questions.action.criteria as Record<string, unknown>;
  assert.ok('scroll_to' in criteria);
  assert.ok(!('reload' in criteria));

  const h2 = harness({ observations: { p1: [observation()] }, script: [CS(), ADV()] });
  h2.driver.ops = OPS_WITHOUT_SCROLL_TO as never;
  const r2 = await h2.call({ goal: 'chain-t27 no scroll to goal', steps: ['o1'] });
  assert.equal(r2.status, 'done');
  const criteria2 = h2.requests[0].questions.action.criteria as Record<string, unknown>;
  assert.ok(!('scroll_to' in criteria2), 'scroll_to not offered without the driver op');
});

// ---- T28: forced + enforce (Q4) ----

const SENSITIVE_URL = `https://${POLICY_SELF_TEST_HOST}/o/oauth2/auth`;

test('T28: a browse_step ask on a sensitive page under forced+enforce returns the forced sensitive line with zero asks', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [CS()],
    config: { ...FORCED, policy: { mode: 'enforce' } },
  });
  const r = await h.call({ goal: 'chain-t28 sensitive goal', steps: ['s1'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-identity');
  assert.equal(r.note, FORCED_SENSITIVE_LINE);
  assert.equal(h.requests.length, 0);
});

test('T28: a pick acts on the sensitive page with zero asks; the next ask round is sensitive again', async () => {
  const h = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [CS()],
    config: { ...FORCED, policy: { mode: 'enforce' } },
  });
  const r = await h.call({
    goal: 'chain-t28 pick sensitive goal',
    steps: ['s1'],
    pick: { role: 'button', name: 'Details', action: 'click' },
  });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-identity');
  assert.equal(r.note, FORCED_SENSITIVE_LINE);
  assert.equal(h.driver.actCalls().length, 1, 'the pick acted');
  assert.equal(h.requests.length, 0, 'the pick round and the following policy hit never asked');
});

test('T28: optional mode keeps SENSITIVE_LINE; forced wingman_do gets the forced line, optional the old one', async () => {
  const optStep = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [CS()],
    config: { handoff: { mode: 'optional' }, policy: { mode: 'enforce' } },
  });
  const r1 = await optStep.call({ goal: 'chain-t28 optional step goal', steps: ['s1'] });
  assert.equal(r1.note, SENSITIVE_LINE);

  const forcedDo = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [CS()],
    config: { handoff: { mode: 'forced', tools: 'all' }, policy: { mode: 'enforce' } },
  });
  const r2 = await forcedDo.callDo({ goal: 'chain-t28 forced do goal' });
  assert.equal(r2.note, FORCED_SENSITIVE_LINE);

  const optDo = harness({
    pages: [page({ url: SENSITIVE_URL })],
    observations: { p1: [observation({ url: SENSITIVE_URL })] },
    script: [CS()],
    config: { handoff: { mode: 'optional', tools: 'all' }, policy: { mode: 'enforce' } },
  });
  const r3 = await optDo.callDo({ goal: 'chain-t28 optional do goal' });
  assert.equal(r3.note, SENSITIVE_LINE);
});
