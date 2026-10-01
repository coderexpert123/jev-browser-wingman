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
import { runDo, runStep, expandClauses, parseRepeatCount, splitCompoundClause, describeActError, type LoopDeps } from '../src/core/loop.js';
import { ActFailedError, NoHistoryError } from '../src/contract/errors.js';
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
    'progress', 'pick', 'acts_by_op', 'step_texts_start',
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
  // Round 2's obs carries different text (as if the page finished settling
  // after round 1's click) so the repeated click on e1 is not a literal
  // zero-change repeat — this is a right_page-counter test, not a no-progress
  // one (§ outcome evidence WP-B); a truly static fixture would make round
  // 2's identical click a correct no-progress match instead of exercising
  // the counter.
  // Round 2 clicks a DIFFERENT element (e2): a same-target re-click after a
  // page-changing click on a count-less step is a WP-click repeat handback,
  // which is not what this test exercises.
  const two = [el(), el({ id: 'e2', path: '#e2', name: 'Other', fingerprint: { tag: 'button', role: 'button', name: 'Other', x: 0, y: 0 } })];
  const h = harness({
    observations: { p1: [observation({ elements: two }), observation({ elements: two, text: 'plain page text, now settled' })] },
    script: [
      CS({ right_page: 0.2 }),
      CS({ right_page: 0.9, target: ['e2', { e2: 0.9, e1: 0.05, none: 0.02, ambiguous: 0.02 }] }),
      ADV(),
    ],
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

// § outcome evidence fix (diagnosis 2026-09-28, r6 Part 3): "ready" asks
// whether the CURRENT page is ready for the step, but a navigate step is by
// definition the one that leaves the current page — gating it on the
// current page's readiness bounced not-ready on effectively every
// fresh-install first-navigate step (r6 telemetry: every not-ready round's
// decided action was navigate, actionP 0.94-0.98). A navigate/back/reload
// decision now skips the ready/right_page gate outright and commits on the
// SAME round instead of burning a wait first.
test('T24: navigate is exempt from the ready gate — a low-ready round still commits the navigate, not a wait', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      CS({
        ready: 0.2,
        right_page: 0.2,
        action: ['navigate', { navigate: 0.9, click: 0.05 }],
        url: ['dest', { dest: 0.9, none: 0.05 }],
      }),
      ADV(),
    ],
    config: FORCED,
  });
  const r = await h.call({
    goal: 'chain-t24 navigate not-ready goal',
    steps: ['open the destination page'],
    values: { dest: 'https://example.com/next' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1, 'no mechanical wait — the navigate commits on the first round despite low ready');
  assert.equal(acts[0].op, 'navigate');
  assert.equal(acts[0].value, 'https://example.com/next');
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

// ---- r11 WP-B: compound-clause decomposition (§ r11 Q1) ----

/** The text between two returned sub-clauses of the same original clause may
 * only ever be boundary separators: whitespace/commas/semicolons plus up to
 * two boundary words (`and`/`then` — "A and then B" drops two). Asserts
 * checklist item 8 — the split never invents, reorders, or drops
 * non-separator text. */
function assertVerbatimSplit(original: string, subs: string[]): void {
  let pos = 0;
  for (const sub of subs) {
    const at = original.indexOf(sub, pos);
    assert.ok(at >= pos, `sub-clause ${JSON.stringify(sub)} does not appear verbatim and in order in ${JSON.stringify(original)}`);
    const gap = original.slice(pos, at);
    assert.match(
      gap,
      /^[\s,;]*(?:\b(?:and|then)\b[\s,;]*){0,2}$/i,
      `gap ${JSON.stringify(gap)} between sub-clauses of ${JSON.stringify(original)} is more than a separator`,
    );
    pos = at + sub.length;
  }
  const tail = original.slice(pos);
  assert.match(tail, /^[\s,;.!?]*$/, `tail ${JSON.stringify(tail)} after the last sub-clause is more than punctuation`);
}

test('splitCompoundClause: the r11 boundary table, verbatim', () => {
  const cases: Array<{ clause: string; subs: string[] }> = [
    { clause: 'open Checkboxes and tick the first checkbox', subs: ['open Checkboxes', 'tick the first checkbox'] },
    {
      clause: 'navigate back to the site home page and open Dropdown, then choose Option 1 in the dropdown',
      subs: ['navigate back to the site home page', 'open Dropdown', 'choose Option 1 in the dropdown'],
    },
    {
      clause: 'Return to the home page, open Add/Remove Elements, and click the Add Element button twice',
      subs: ['Return to the home page', 'open Add/Remove Elements', 'click the Add Element button twice'],
    },
    { clause: 'fill name and email', subs: ['fill name and email'] }, // 'email' is not a verb word
    { clause: 'click the box and then it', subs: ['click the box and then it'] }, // no verb in the tail — never a boundary
    // 'check' IS a verb: only the anaphora gate keeps this whole (kills M5).
    { clause: 'click the box and check it again', subs: ['click the box and check it again'] },
    // 'And'/'AND' are conditional too (the separator match is case-insensitive):
    // followed by a non-verb they are never a boundary even when a verb shows
    // up later in the same tail — a case-sensitive conditional check would
    // treat this 'And' as unconditional and split here.
    { clause: 'open A And B click twice', subs: ['open A And B click twice'] },
    { clause: 'click the Add Element button twice', subs: ['click the Add Element button twice'] }, // no boundary inside a count phrase
    { clause: 'open Checkboxes; tick the first checkbox', subs: ['open Checkboxes', 'tick the first checkbox'] }, // ';' unconditional
    { clause: 'go to the next page', subs: ['go to the next page'] }, // 'then' inside 'next' never matches: word-bounded
    // ---- r11b F1/F2/F3 rows ----
    // F1 name-tail guard: a conditional separator followed by a lone verb
    // word closes a compound name, it does not open a sub-goal.
    { clause: 'click Save and Close', subs: ['click Save and Close'] },
    { clause: 'click Add and Remove', subs: ['click Add and Remove'] },
    { clause: 'fill email and submit', subs: ['fill email and submit'] },
    // F1 quote guard: a boundary inside single quotes is part of the name.
    { clause: "click the 'Add and Close' button", subs: ["click the 'Add and Close' button"] },
    // No `and`/`then`/`;`/`,` at all — baseline unchanged.
    { clause: 'click the Save & Exit button', subs: ['click the Save & Exit button'] },
    // F1 positive: `then` still splits after a name-tail-rejected `and`.
    {
      clause: 'click Accept and Close then fill email',
      subs: ['click Accept and Close', 'fill email'],
    },
    // F1 positive: the bench Pattern-A shape still splits into 3.
    {
      clause: 'navigate back and open Dropdown, then choose Option 1',
      subs: ['navigate back', 'open Dropdown', 'choose Option 1'],
    },
    // F2: a skipped `and`/`;` before an accepted `then` leaves no dangling
    // separator word in the previous fragment.
    { clause: 'click A and then click B', subs: ['click A', 'click B'] },
    { clause: 'click Save; then click OK', subs: ['click Save', 'click OK'] },
    // F3: `check`/`verify` + that/if/whether is an assertion tail, not an
    // action — the conditional boundary is rejected.
    {
      clause: 'go to settings and check that the toggle is enabled',
      subs: ['go to settings and check that the toggle is enabled'],
    },
    {
      clause: 'open settings and check whether the toggle saved',
      subs: ['open settings and check whether the toggle saved'],
    },
    // F3 contrast: `check <control>` without that/if/whether stays a verb.
    { clause: 'open A and check the box', subs: ['open A', 'check the box'] },
  ];
  for (const c of cases) {
    const subs = splitCompoundClause(c.clause);
    assert.deepEqual(subs, c.subs, c.clause);
    assertVerbatimSplit(c.clause, subs);
  }

  // The count word stays with its verb inside the split fragment (r10).
  const addRow = splitCompoundClause('open Add/Remove Elements and click the Add Element button twice');
  assert.deepEqual(addRow, ['open Add/Remove Elements', 'click the Add Element button twice']);
  assertVerbatimSplit('open Add/Remove Elements and click the Add Element button twice', addRow);
  assert.equal(parseRepeatCount(addRow[1]), 2);

  // A formerly-ambiguous clause resolves both counts once split.
  const twiceRow = splitCompoundClause('click it twice, then submit 2 times');
  assert.deepEqual(twiceRow, ['click it twice', 'submit 2 times']);
  assertVerbatimSplit('click it twice, then submit 2 times', twiceRow);
  assert.equal(parseRepeatCount(twiceRow[0]), 2);
  assert.equal(parseRepeatCount(twiceRow[1]), 2);
});

test('expandClauses: parents map back to the caller clause; over the cap returns null', () => {
  const exp = expandClauses(['open A and click B', 'fill C']);
  assert.deepEqual(exp, { clauses: ['open A', 'click B', 'fill C'], parents: [0, 0, 1] });

  // r12: the cap is EXPANDED_CHAIN_MAX (36), not the caller-list 12: 7 clauses
  // that each expand to 2 (14) now expand fully.
  const ok = expandClauses(Array.from({ length: 7 }, (_, i) => `open x${i} and click y${i}`));
  assert.ok(ok !== null, '14 sub-clauses are within the expansion cap');
  assert.equal(ok!.clauses.length, 14);
  assert.deepEqual(ok!.parents, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  assert.equal(ok!.clauses[0], 'open x0');

  // All-or-nothing beyond 36: 19 clauses x 2 = 38 return null.
  const over = expandClauses(Array.from({ length: 19 }, (_, i) => `open x${i} and click y${i}`));
  assert.equal(over, null);

  // Exact boundary (verifier, r12): 36 sub-clauses expand, 37 return null —
  // pins the cap value itself, not just "somewhere between 14 and 38".
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => `open x${i} and click y${i}`);
  const at36 = expandClauses([...pairs(17), 'fill a', 'fill b']);
  assert.ok(at36 !== null, '36 sub-clauses are within the cap');
  assert.equal(at36!.clauses.length, 36);
  assert.equal(expandClauses([...pairs(18), 'fill a']), null, '37 sub-clauses exceed the cap');
});

test('T-decompose-cap: 7 compound caller clauses (14 sub-clauses) decompose instead of running unsplit', async () => {
  const steps = Array.from({ length: 7 }, (_, i) => `open X${i + 1} and click Y${i + 1}`);
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-decompose cap goal', steps, max_steps: 1 });
  assert.equal(h.requests.length >= 1, true);
  const st = h.requests[0].state as { step?: string; steps_total?: number };
  assert.equal(st.step, 'open X1', 'request 0 carries the first SUB-clause, proving the 14-way expansion ran');
  assert.equal(st.steps_total, 7);
  assert.equal(r.progress?.steps_total, 7);
});

test('T-decompose-order: a compound clause executes sub-goals in order with parent-mapped progress', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [CS(), ADV(), CS(), ADV()],
  });
  const r = await h.call({
    goal: 'chain-decompose order goal',
    steps: ['open the Dropdown link and choose Option 1 in the dropdown'],
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'goal-met');
  // Exact-string assertions: round 1's step is byte-identical to the first
  // sub-clause, and the second sub-clause's text appears only after it
  // advanced. Read from state.step on the recorded requests.
  const stepOf = (i: number) => (h.requests[i].state as { step?: string }).step;
  assert.equal(stepOf(0), 'open the Dropdown link');
  assert.equal(stepOf(1), 'open the Dropdown link');
  assert.equal(stepOf(2), 'choose Option 1 in the dropdown');
  assert.equal(stepOf(3), 'choose Option 1 in the dropdown');
  assert.equal(h.requests.length, 4);
  // Parent-mapped: one caller clause, so Jev-visible and result progress stay
  // in the caller's numbering throughout.
  assert.deepEqual(r.progress, { step_index: 1, steps_done: 1, steps_total: 1 });
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 2);
  assert.equal(acts[0].elementId, 'e1');
  assert.equal(acts[1].elementId, 'e1');
});

test('T-decompose-progress: a mid-call result inside caller clause 2 carries parent-mapped progress', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    // Five rounds: alpha open (ask+advance), beta click (ask+advance), then an
    // ask on the SECOND sub-clause 'scroll gamma' — the budget-steps result
    // must then carry progress from expanded cursor 2, where the parent-mapped
    // formula (steps_done = parents[2] = 1) DIVERGES from the expanded-index
    // one (cursor = 2). A probe on 'beta click' alone cannot see the M4
    // mutant: parents[1] === 1 === cursor there.
    script: [CS(), ADV(), CS(), ADV(), CS()],
  });
  const r = await h.call({
    goal: 'chain-decompose progress goal',
    // Caller clause 2 must actually SPLIT ('and scroll' is a verb boundary)
    // or the expanded-vs-parent mapping can never differ here and the M4
    // mutant would be invisible to this test.
    steps: ['alpha open', 'beta click and scroll gamma'],
    max_steps: 2,
  });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'budget-steps');
  // The call ended on the act-check while the cursor sat on caller clause 2's
  // SECOND sub-clause (expanded cursor 2 of 3): parent-mapped step_index 2 /
  // steps_done 1 / steps_total 2, per the finish() formulas — NOT the
  // expanded-index 3 / 2.
  assert.deepEqual(r.progress, { step_index: 2, steps_done: 1, steps_total: 2 });
  const stepOf = (i: number) => (h.requests[i].state as { step?: string }).step;
  assert.equal(stepOf(0), 'alpha open');
  assert.equal(stepOf(2), 'beta click');
  assert.equal(stepOf(4), 'scroll gamma');
  // Jev-visible numbering is the caller's own (OPEN-1): clause 2 of 2 on both
  // sub-clauses of caller clause 2.
  assert.equal((h.requests[2].state as { step_number?: number }).step_number, 2);
  assert.equal((h.requests[2].state as { steps_total?: number }).steps_total, 2);
  assert.equal((h.requests[4].state as { step_number?: number }).step_number, 2);
  assert.equal((h.requests[4].state as { steps_total?: number }).steps_total, 2);
});

test('T-decompose-resume: chain memory resumes mid-clause on the exact sub-clause', async () => {
  const steps = ['open Checkboxes and tick the first checkbox', 'click e1'];
  const goal = 'chain-decompose resume goal';
  const h1 = harness({ observations: { p1: [observation()] }, script: [CS(), ADV(), CS()] });
  const r1 = await h1.call({ goal, steps, max_steps: 1 });
  assert.equal(r1.status, 'fallback', `expected fallback, got ${r1.status}/${r1.reason}`);
  assert.equal(r1.reason, 'budget-steps');
  assert.equal(r1.progress?.steps_done, 0, 'still inside caller clause 1: zero caller clauses fully done');
  assert.equal(r1.progress?.steps_total, 2);

  const h2 = harness({ observations: { p1: [observation()] }, script: [CS(), ADV(), CS(), ADV()] });
  const r2 = await h2.call({ goal, steps });
  assert.equal(r2.status, 'done', `expected done, got ${r2.status}/${r2.reason}`);
  const stepOf = (i: number) => (h2.requests[i].state as { step?: string }).step;
  assert.equal(stepOf(0), 'tick the first checkbox', 'the re-call resumes on the SECOND sub-clause, not the parent clause start');
  assert.equal(stepOf(1), 'tick the first checkbox');
  assert.equal(stepOf(2), 'click e1');
  assert.deepEqual(r2.progress, { step_index: 2, steps_done: 2, steps_total: 2 });
});

// Add/Remove-style fixtures for T-decompose-twice (mirrors
// outcome-evidence.test.ts's addElementsObs): an Add button plus N Delete
// buttons; text varies so every click observes a page change.
function addButton(): ElementRecord {
  return el({
    id: 'e1',
    path: '#add',
    tag: 'button',
    role: 'button',
    name: 'Add Element',
    type: 'button',
    editable: false,
    state: { disabled: false },
    fingerprint: { tag: 'button', role: 'button', name: 'Add Element', x: 0, y: 0 },
  });
}

function deleteButton(n: number): ElementRecord {
  return el({
    id: `d${n}`,
    path: `#del${n}`,
    tag: 'button',
    role: 'button',
    name: 'Delete',
    type: 'button',
    editable: false,
    state: { disabled: false },
    fingerprint: { tag: 'button', role: 'button', name: 'Delete', x: 0, y: 0 },
  });
}

function addElementsObs(n: number): Observation {
  const elements = [addButton()];
  for (let i = 0; i < n; i++) elements.push(deleteButton(i));
  return observation({ elements, text: `${n} delete button(s) present` });
}

test('T-decompose-twice: a "...twice" tail inside a compound clause lands exactly 2 clicks on its own sub-clause', async () => {
  const h = harness({
    observations: {
      p1: [addElementsObs(0), addElementsObs(0), addElementsObs(1), addElementsObs(2), addElementsObs(3)],
    },
    script: [CS(), ADV(), CS(), CS(), CS()],
  });
  const r = await h.call({
    goal: 'chain-decompose twice goal',
    steps: ['open Add/Remove Elements and click the Add Element button twice'],
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  const clickActs = acts.filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 3, '1 click on sub-clause 1 (open) + exactly 2 on sub-clause 2 (the count), never a third');
  assert.deepEqual(clickActs.map((a) => a.elementId), ['e1', 'e1', 'e1']);
  // The two count-clause clicks happened on the second sub-clause: the
  // requests between the first advance and the count advance all carried
  // 'click the Add Element button twice' as state.step.
  const stepOf = (i: number) => (h.requests[i].state as { step?: string }).step;
  assert.equal(stepOf(2), 'click the Add Element button twice');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(
    rounds.some((rd) => rd.countEvidence === 2),
    'countEvidence telemetry fired on the sub-clause advance',
  );
});

test('T-decompose-premature: a none answer on the operative sub-clause consumes the retry, then bounces no-match', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      CS(),
      ADV(),
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] }),
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] }),
    ],
  });
  const r = await h.call({
    goal: 'chain-decompose premature goal',
    steps: ['open Checkboxes and tick the first checkbox'],
  });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(r.step_review?.step, 'tick the first checkbox', 'the bounce reviews the operative SUB-clause, not the caller text');
  // The first none round consumed the one clause retry (§ 5.5.2 rule 9):
  // requests 3 and 4 are the two identical non-committing rounds on
  // 'tick the first checkbox', and the call only bounces after the second.
  assert.equal(h.requests.length, 4);
  const stepOf = (i: number) => (h.requests[i].state as { step?: string }).step;
  assert.equal(stepOf(2), 'tick the first checkbox');
  assert.equal(stepOf(3), 'tick the first checkbox');
  assert.equal(h.driver.actCalls().length, 1, 'only the sub-clause-1 click landed; the check never acted');
});

test('T-decompose-genuine-nomatch: a genuine none on an atomic clause still bounces step-uncertain/no-match', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] }),
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.9, e1: 0.05 }] }),
    ],
  });
  const r = await h.call({
    goal: 'chain-decompose genuine nomatch goal',
    steps: ['tick the first checkbox'],
  });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(r.step_review?.step, 'tick the first checkbox');
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 2, 'retry consumed, then bounce — unchanged pre-r11 semantics for atomic clauses');
});

// ---- r13 (spec .build-r13-spec.md D1-D9): stuck-clause recovery + act-error logging ----

const NONE = (over: SeqEntry = {}): SeqEntry =>
  CS({
    action: ['click', { click: 0.9, none: 0.05 }],
    target: ['none', { none: 0.95, ambiguous: 0.03 }],
    ...over,
  });
const STUCK = (id: string, p = 0.9): SeqEntry => ({ recover: [id, { [id]: p }] });
const NAVLOW = (): SeqEntry =>
  CS({
    action: ['navigate', { navigate: 0.4, click: 0.3, none: 0.1 }],
    target: ['none', { none: 0.95 }],
  });

const spoke = observation({ url: 'https://example.com/check', title: 'Check' });
const hubEl = el({
  id: 'e1',
  path: '#form',
  tag: 'a',
  role: 'link',
  name: 'Form',
  fingerprint: { tag: 'a', role: 'link', name: 'Form', x: 0, y: 0 },
});
const hub = observation({ url: 'https://example.com/', title: 'Home', elements: [hubEl] });
const formPage = observation({ url: 'https://example.com/form', title: 'Form', text: 'form page' });
const HOME = { home: 'https://example.com/' };

const actsOf = (h: Harness): Array<[Op, string | null, string | undefined]> =>
  h.driver.actCalls().map((a) => [a.op as Op, a.elementId as string | null, a.value as string | undefined]);
const qKeys = (r: JevRequest): string[] => Object.keys(r.questions);
const stuckReqs = (h: Harness): JevRequest[] =>
  h.requests.filter((r) => {
    const k = qKeys(r);
    return k.length === 1 && k[0] === 'recover';
  });
const recoverCriteria = (r: JevRequest): Record<string, string> =>
  (r.questions.recover as unknown as { criteria: Record<string, string> }).criteria;

test('T-stuck-url: a confident none on a hub-miss clause asks the stuck recover and navigates to the url binding, then the clause lands', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [NONE(), NONE(), STUCK('open_home'), CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-url goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(actsOf(h), [['navigate', null, 'https://example.com/'], ['click', 'e1', undefined]]);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(qKeys(h.requests[2]), ['recover']);
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['back', 'open_home', 'give-up']);
  assert.equal(
    recoverCriteria(h.requests[2]).open_home,
    'Open the supplied web address home, because the step can be done there or from a page it links to',
  );
  assertNoValues(JSON.stringify(h.requests[2]), HOME);
  assert.equal(h.records[0].phases?.rounds[2].stuck, 'open_home');
  assert.equal(r.steps, 2);
});

test('T-stuck-back: with no url binding the stuck recover goes back, then the clause lands', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [NONE(), NONE(), STUCK('back'), CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-back goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['back', 'give-up']);
  assert.deepEqual(actsOf(h), [['back', null, undefined], ['click', 'e1', undefined]]);
});

test('T-stuck-giveup: give-up and a sub-threshold answer both end in the deferred no-match bounce with zero acts', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('give-up')],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-stuck-giveup goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 3);
  assert.equal(r.note, FORCED_BOUNCE_LINE);

  const h2 = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('open_home', 0.5)],
    config: FORCED,
  });
  const r2 = await h2.call({ goal: 'chain-stuck-giveup low goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.step_review?.why, 'no-match');
  assert.equal(h2.driver.actCalls().length, 0, 'a 0.5 answer is below THRESHOLDS.recover (0.6): no navigate');
  assert.equal(r2.note, FORCED_BOUNCE_LINE);
});

test('T-stuck-d7: only caller url bindings are offered; an unoffered id never acts', async () => {
  const values = { ...HOME, email: 'person@example.org' };
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('open_email', 0.95)],
  });
  const r = await h.call({ goal: 'chain-stuck-d7 email goal', steps: ['open the Form page'], values });
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['back', 'open_home', 'give-up']);
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.driver.actCalls().length, 0);

  const h2 = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('open_nowhere', 0.95)],
  });
  const r2 = await h2.call({ goal: 'chain-stuck-d7 nowhere goal', steps: ['open the Form page'], values });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.step_review?.why, 'no-match');
  assert.equal(h2.driver.actCalls().length, 0);
});

test('T-stuck-once: a second would-be bounce on the same clause bounces without another stuck ask', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub] },
    script: [NONE(), NONE(), STUCK('open_home'), NONE()],
  });
  const r = await h.call({ goal: 'chain-stuck-once goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(actsOf(h).filter((a) => a[0] === 'navigate').length, 1);
  assert.equal(h.requests.length, 4);
  assert.equal(stuckReqs(h).length, 1);
});

test('T-stuck-verb: a none under a non-navigation verb (check) never triggers the stuck recover', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.95 }] }),
      CS({ action: ['check', { check: 0.9, none: 0.05 }], target: ['none', { none: 0.95 }] }),
      STUCK('back'),
    ],
  });
  const r = await h.call({ goal: 'chain-stuck-verb goal', steps: ['tick the first checkbox'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.requests.length, 2);
  assert.equal(h.driver.actCalls().length, 0);
});

test('T-stuck-none-bar: none at 0.8 triggers the stuck ask, 0.79 does not', async () => {
  const at = (p: number): SeqEntry => NONE({ target: ['none', { none: p }] });
  const h = harness({
    observations: { p1: [spoke] },
    script: [at(0.8), at(0.8), STUCK('give-up')],
  });
  await h.call({ goal: 'chain-stuck-bar 080 goal', steps: ['open the Form page'] });
  assert.equal(h.requests.length, 3);
  assert.deepEqual(qKeys(h.requests[2]), ['recover']);

  const h2 = harness({
    observations: { p1: [spoke] },
    script: [at(0.79), at(0.79), STUCK('back')],
  });
  const r2 = await h2.call({ goal: 'chain-stuck-bar 079 goal', steps: ['open the Form page'] });
  assert.equal(r2.status, 'fallback');
  assert.equal(h2.requests.length, 2);
  assert.equal(h2.driver.actCalls().length, 0);
});

test('T-stuck-not-fresh: a clause that already acted never takes the stuck recover', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [CS(), NONE(), NONE(), STUCK('back')],
  });
  const r = await h.call({ goal: 'chain-stuck-notfresh goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.requests.length, 3);
  assert.equal(stuckReqs(h).length, 0);
  assert.deepEqual(actsOf(h), [['click', 'e1', undefined]]);
});

test('T-stuck-not-fresh-resume: a resumed clause that already acted stays ineligible (cursorActed rides chain memory)', async () => {
  const goal = 'chain-stuck-resume goal';
  const steps = ['open the Form page'];
  const h1 = harness({ observations: { p1: [spoke] }, script: [CS(), CS()] });
  const r1 = await h1.call({ goal, steps, max_steps: 1 });
  assert.equal(r1.status, 'fallback');
  assert.equal(r1.reason, 'budget-steps');

  const h2 = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('back')],
  });
  const r2 = await h2.call({ goal, steps });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.step_review?.why, 'no-match');
  assert.equal(h2.requests.length, 2);
  assert.equal(h2.driver.actCalls().length, 0);
});

test('T-stuck-wrong-page: a wrong-page would-be bounce takes the stuck recover and the clause lands after it', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [
      NONE({ right_page: 0.2 }),
      NONE({ right_page: 0.2 }),
      STUCK('open_home'),
      CS({ right_page: 0.2 }),
      ADV(),
    ],
  });
  const r = await h.call({ goal: 'chain-stuck-wrongpage goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.equal(h.records[0].phases?.rounds[2].stuck, 'open_home');
});

test('T-stuck-wrong-page-giveup: give-up on a wrong-page trigger returns the wrong-page bounce with its own note', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE({ right_page: 0.2 }), NONE({ right_page: 0.2 }), STUCK('give-up')],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-stuck-wrongpage giveup goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'fallback');
  assert.deepEqual(r.step_review, { step: 'open the Form page', why: 'wrong-page', candidates: [] });
  assert.equal(r.note, FORCED_WRONG_PAGE_LINE);
});

test('T-stuck-evidence: a stuck navigate that the clause did not name is not step evidence', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [NONE(), NONE(), STUCK('open_home'), CS({ step_done: 0.6 }), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-evidence goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.equal(h.driver.actCalls().length, 2, 'navigate then click: the stuck navigate did not advance the clause');
});

test('T-stuck-named-evidence: a stuck navigate to the binding the clause names IS its own act and counts as evidence', async () => {
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub] },
    script: [NAVLOW(), NAVLOW(), STUCK('open_home'), NONE({ step_done: 0.6 })],
  });
  const r = await h.call({
    goal: 'chain-stuck-named goal',
    steps: ['open the web address named home'],
    values: HOME,
  });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(actsOf(h), [['navigate', null, 'https://example.com/']]);
  assert.equal(h.requests.length, 4);
});

test('T-stuck-same-url: the page we are already on is never offered as a destination', async () => {
  const onHome = observation({ url: 'https://example.com/', title: 'Home' });
  const h = harness({
    observations: { p1: [onHome] },
    script: [NONE(), NONE(), STUCK('give-up')],
  });
  await h.call({ goal: 'chain-stuck-sameurl goal', steps: ['open the Form page'], values: HOME });
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['back', 'give-up']);
});

test('T-stuck-budget: the recover budget shared with error recovery is spent first, so no stuck ask follows', async () => {
  const ERR = (): SeqEntry => CS({ error: 0.9, recover: ['wait', { wait: 0.9 }] });
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), ERR(), ERR(), NONE(), STUCK('back')],
  });
  const r = await h.call({ goal: 'chain-stuck-budget goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.deepEqual(actsOf(h), [['wait', null, undefined], ['wait', null, undefined]]);
  assert.equal(h.requests.length, 4);
  assert.equal(stuckReqs(h).length, 0);
});

test('T-stuck-offer: an offer-mode call (takeover:false) never takes the stuck recover', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('back')],
  });
  const r = await h.call({ goal: 'chain-stuck-offer goal', steps: ['open the Form page'], takeover: false });
  assert.equal(r.status, 'fallback');
  assert.equal(h.requests.length, 2);
  assert.equal(h.driver.actCalls().length, 0);
});

test('T-stuck-no-history: a stuck back with no history is the deferred no-match bounce, not error/act-failed', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), NONE(), STUCK('back')],
  });
  h.driver.failNextAct = new NoHistoryError('no previous page');
  const r = await h.call({ goal: 'chain-stuck-nohistory goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.deepEqual(actsOf(h), [['back', null, undefined]]);
  assert.equal(h.records[0].act_error, undefined);
});

test('T-stuck-steps-budget: a stuck recovery needs a step left; at max_steps the clause bounces no-match, not budget-steps', async () => {
  const h = harness({
    observations: { p1: [spoke] },
    script: [CS(), ADV(), NONE(), NONE(), STUCK('back')],
  });
  const r = await h.call({
    goal: 'chain-stuck-stepsbudget goal',
    steps: ['tick the box', 'open the Form page'],
    max_steps: 1,
  });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.requests.length, 4);
});

test('T-stuck-two-stage: eligibility reads the merged two-stage answer map (action from request 1, none target from request 2)', async () => {
  const two = observation({
    url: 'https://example.com/check',
    title: 'Check',
    elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })],
  });
  const ASK1 = (): SeqEntry => CS({ group: ['g1', { g1: 0.9 }], target: undefined });
  const ASK2: SeqEntry = { target: ['none', { none: 0.95, ambiguous: 0.03 }] };
  const h = harness({
    observations: { p1: [two, two, two, hub, formPage] },
    script: [ASK1(), ASK2, ASK1(), ASK2, STUCK('open_home'), CS(), ADV()],
    config: { budgets: { ...DEFAULT_BUDGETS, max_elements: 1 } },
  });
  const r = await h.call({ goal: 'chain-stuck-twostage goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.equal(stuckReqs(h).length, 1);
});

test('T-stuck-lowconf-bounce: a declined stuck recovery after a low-confidence trigger bounces low-confidence WITH the trigger-time candidates', async () => {
  const LOWC = (): SeqEntry =>
    CS({
      action: ['navigate', { navigate: 0.4, click: 0.3, none: 0.1 }],
      target: ['none', { none: 0.95, e1: 0.03 }],
    });
  const h = harness({
    observations: { p1: [spoke] },
    script: [LOWC(), LOWC(), STUCK('give-up')],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-stuck-lowconf goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'low-confidence', 'the deferred bounce keeps the trigger why, never a hardcoded no-match');
  assert.equal(r.step_review?.candidates.length, 1, 'the trigger-time candidates ride the deferred bounce');
  assert.equal(r.step_review?.candidates[0].name, 'Details');
  assert.equal(r.note, FORCED_BOUNCE_LINE);
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(stuckReqs(h).length, 1);
});

test('T-stuck-two-nones: a multi-match first look followed by a none is NOT two consecutive none looks, so it bounces without the stuck ask', async () => {
  const AMBIG = (): SeqEntry => CS({ target: ['ambiguous', { ambiguous: 0.9, e1: 0.05, none: 0.05 }] });
  const h = harness({
    observations: { p1: [spoke] },
    script: [AMBIG(), NONE(), STUCK('back')],
  });
  const r = await h.call({ goal: 'chain-stuck-twonones goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.requests.length, 2);
  assert.equal(stuckReqs(h).length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

test('T-stuck-two-bindings: with two url bindings the navigate goes to the one Jev chose, not the first offered', async () => {
  const values = { home: 'https://example.com/', docs: 'https://docs.example.com/start' };
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [NONE(), NONE(), STUCK('open_docs'), CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-twobind goal', steps: ['open the Form page'], values });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['back', 'open_home', 'open_docs', 'give-up']);
  assert.deepEqual(actsOf(h)[0], ['navigate', null, 'https://docs.example.com/start']);
  assert.equal(h.records[0].phases?.rounds[2].stuck, 'open_docs');
});

test('T-stuck-token-act: a confirmed token act is an element act on the clause, so the clause is no longer fresh', async () => {
  const placePage = observation({ elements: [el({ type: 'submit', name: 'Place order' })] });
  const h = harness({
    observations: { p1: [placePage] },
    script: [NONE(), NONE(), STUCK('back')],
    config: { gate: { mode: 'confirm' } },
  });
  const goal = 'chain-stuck-token goal';
  const steps = ['place the order'];
  const r1 = await h.call({ goal, steps, pick: { role: 'button', name: 'Place order', action: 'click' } });
  assert.equal(r1.status, 'needs_confirmation');
  const r2 = await h.call({ goal, steps, confirm_token: r1.confirm_token });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.step_review?.why, 'no-match');
  assert.deepEqual(actsOf(h), [['click', 'e1', undefined]], 'the token click only: no stuck back');
  assert.equal(stuckReqs(h).length, 0);
  assert.equal(h.requests.length, 2);
});

test('T-stuck-noprogress-exempt: a stuck back right after an error-recover back that changed nothing is exempt from the no-progress guard', async () => {
  const ERRB = (): SeqEntry => CS({ error: 0.9, recover: ['back', { back: 0.9 }] });
  const h = harness({
    observations: { p1: [spoke] },
    script: [NONE(), ERRB(), NONE(), STUCK('back'), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-noprogress goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(actsOf(h).map((a) => a[0]), ['back', 'back'], 'error back, then the stuck back (not a no-progress bounce)');
  assert.equal(stuckReqs(h).length, 1);
});

test('T-stuck-no-back-op: a driver without back still offers the url binding, and with neither there is no stuck ask', async () => {
  const NO_BACK = (OPS as readonly Op[]).filter((o) => o !== 'back');
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage] },
    script: [NONE(), NONE(), STUCK('open_home'), CS(), ADV()],
  });
  h.driver.ops = NO_BACK;
  const r = await h.call({ goal: 'chain-stuck-noback goal', steps: ['open the Form page'], values: HOME });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), ['open_home', 'give-up']);

  const h2 = harness({ observations: { p1: [spoke] }, script: [NONE(), NONE(), STUCK('back')] });
  h2.driver.ops = NO_BACK;
  const r2 = await h2.call({ goal: 'chain-stuck-noback none goal', steps: ['open the Form page'] });
  assert.equal(r2.status, 'fallback');
  assert.equal(stuckReqs(h2).length, 0);
  assert.equal(h2.driver.actCalls().length, 0);
});

test('T-stuck-telemetry-giveup: a declined stuck round records stuck give-up, an unanswered one records nothing', async () => {
  const h = harness({ observations: { p1: [spoke] }, script: [NONE(), NONE(), STUCK('give-up')] });
  await h.call({ goal: 'chain-stuck-telgiveup goal', steps: ['open the Form page'] });
  assert.deepEqual(
    h.records[0].phases?.rounds.map((r) => r.stuck),
    [undefined, undefined, 'give-up'],
  );
});

test('T-stuck-memory-used: an identical re-call after a declined stuck recovery does not recover again (stuckTried rides chain memory)', async () => {
  const goal = 'chain-stuck-memused goal';
  const steps = ['open the Form page'];
  const h1 = harness({ observations: { p1: [spoke] }, script: [NONE(), NONE(), STUCK('give-up')] });
  const r1 = await h1.call({ goal, steps });
  assert.equal(r1.status, 'fallback');
  assert.equal(stuckReqs(h1).length, 1);

  const h2 = harness({ observations: { p1: [spoke] }, script: [NONE(), NONE(), STUCK('back')] });
  const r2 = await h2.call({ goal, steps });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.step_review?.why, 'no-match');
  assert.equal(h2.requests.length, 2, 'retry then bounce: no second stuck ask for the same stored clause');
  assert.equal(stuckReqs(h2).length, 0);
  assert.equal(h2.driver.actCalls().length, 0);
});

test('T-stuck-reset-on-advance: the once-per-clause budget resets when the clause advances, so the next hub-miss clause recovers too', async () => {
  const docsPage = observation({ url: 'https://example.com/docs', title: 'Docs', text: 'docs page' });
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub, formPage, formPage, formPage, formPage, hub, docsPage] },
    script: [NONE(), NONE(), STUCK('back'), CS(), ADV(), NONE(), NONE(), STUCK('back'), CS(), ADV()],
  });
  const r = await h.call({ goal: 'chain-stuck-reset goal', steps: ['open the Form page', 'open the Docs page'] });
  assert.equal(r.status, 'done', `${r.status}/${r.reason}`);
  assert.equal(stuckReqs(h).length, 2, 'one stuck ask per clause');
  assert.deepEqual(actsOf(h).map((a) => a[0]), ['back', 'click', 'back', 'click']);
});

test('T-stuck-shares-recover-budget: a stuck act spends one of the clause recover acts, so error recovery gets only the other', async () => {
  const ERR = (): SeqEntry => CS({ error: 0.9, recover: ['wait', { wait: 0.9 }] });
  const h = harness({
    observations: { p1: [spoke, spoke, spoke, hub] },
    script: [NONE(), NONE(), STUCK('back'), ERR(), ERR(), ERR()],
  });
  const r = await h.call({ goal: 'chain-stuck-sharedbudget goal', steps: ['open the Form page'] });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'page-error');
  assert.deepEqual(actsOf(h).map((a) => a[0]), ['back', 'wait'], 'stuck back + one error wait = RECOVER_MAX_PER_CLAUSE');
});

test('T-stuck-query-hub: a url binding differing from the page by query is offered; a hash-only difference (href="#") is still the same page', async () => {
  const cases: Array<[string, string[]]> = [
    ['https://example.com/?view=item', ['back', 'open_home', 'give-up']],
    ['https://example.com/#', ['back', 'give-up']],
  ];
  for (const [i, [pageUrl, keys]] of cases.entries()) {
    const onSpoke = observation({ url: pageUrl, title: 'Item' });
    const h = harness({
      observations: { p1: [onSpoke] },
      script: [NONE(), NONE(), STUCK('give-up')],
    });
    await h.call({ goal: `chain-stuck-queryhub goal ${i}`, steps: ['open the Form page'], values: HOME });
    assert.deepEqual(Object.keys(recoverCriteria(h.requests[2])), keys, pageUrl);
  }
});

// ---- r13 D8: act-error logging ----

const V1_MESSAGE =
  "locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for locator('html > body > ul > li:nth-of-type(2) > a')\n    - locator resolved to <a href=\"chain-form.html\">Form</a>\n  - attempting click action\n    - waiting for element to be visible, enabled and stable";
const V2_MESSAGE =
  'locator.click: Timeout 3000ms exceeded.\nCall log:\n  - locator resolved to <a href="chain-form.html">Form</a>';

test('T-act-error-sanitize: describeActError cuts HTML, redacts values, and never leaks a non-Wingman message', () => {
  assert.deepEqual(describeActError(new ActFailedError(V1_MESSAGE), 'click', {}), {
    op: 'click',
    head: 'locator.click: Timeout 3000ms exceeded.',
    tail: 'waiting for element to be visible, enabled and stable',
  });
  const v2 = describeActError(new ActFailedError(V2_MESSAGE), 'click', {});
  assert.equal(v2.tail, 'locator resolved to …');
  const j2 = JSON.stringify(v2);
  for (const bad of ['href', 'chain-form', 'Form<']) assert.ok(!j2.includes(bad), `leaked ${bad}`);
  assert.deepEqual(
    describeActError(
      new ActFailedError('net::ERR_NAME_NOT_RESOLVED at https://secret.example.org/path'),
      null,
      { target: 'https://secret.example.org/path' },
    ),
    { head: 'net::ERR_NAME_NOT_RESOLVED at <value:target>' },
  );
  assert.deepEqual(describeActError(new TypeError('boom secret'), null, {}), { head: 'fault: TypeError' });
  assert.deepEqual(describeActError(new NoHistoryError('no previous page'), 'back', {}), {
    op: 'back',
    head: 'no previous page',
  });
});

test('T-act-error-log: a thrown act error lands sanitized in the log record as act_error', async () => {
  const h = harness({ observations: { p1: [observation()] }, script: [CS()] });
  h.driver.failNextAct = new ActFailedError(V2_MESSAGE);
  const r = await h.call({ goal: 'chain-acterror-log goal', steps: ['click Details'] });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'act-failed');
  assert.deepEqual(h.records[0].act_error, {
    op: 'click',
    head: 'locator.click: Timeout 3000ms exceeded.',
    tail: 'locator resolved to …',
  });
  const j = JSON.stringify(h.records[0]);
  assert.ok(!j.includes('href'));
  assert.ok(!j.includes('chain-form'));
});

// ---- r14 (spec .build-r14-spec.md WP-B): landed-navigation evidence ----

const navValues = { email: 'person@example.org' };
const emailEl = el({
  id: 'e2',
  path: '#email',
  tag: 'input',
  role: 'textbox',
  name: 'Email',
  type: 'email',
  editable: true,
  state: { disabled: false, filled: false },
  fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 0, y: 0 },
});
const emailFilledEl = el({
  id: 'e2',
  path: '#email',
  tag: 'input',
  role: 'textbox',
  name: 'Email',
  type: 'email',
  editable: true,
  state: { disabled: false, filled: true },
  fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 0, y: 0 },
});
const formEmpty = observation({ url: 'https://example.com/form', title: 'Form', elements: [emailEl], text: 'form page' });
const formFilled = observation({ url: 'https://example.com/form', title: 'Form', elements: [emailFilledEl], text: 'form page' });
/** Jev acting ahead on the landed page: fill the next sub-goal's field. */
const AHEAD = (sd: number, over: SeqEntry = {}): SeqEntry =>
  CS({
    step_done: sd,
    action: ['fill', { fill: 0.9, none: 0.05 }],
    target: ['e2', { e2: 0.9, none: 0.05, ambiguous: 0.05 }],
    value: ['email', { email: 0.9, none: 0.05 }],
    ...over,
  });
const NAV_STEPS = ['open the Form link', 'type the value named email into Email'];
const navRounds = (h: Harness) => h.records[h.records.length - 1].phases!.rounds;
const navEvidenceRounds = (h: Harness) => navRounds(h).filter((r) => r.navEvidence !== undefined);
const FILL_AFTER_CLICK: Array<[Op, string | null, string | undefined]> = [
  ['click', 'e1', undefined],
  ['fill', 'e2', 'person@example.org'],
];

test('T-nav-advance: an open clause whose own click landed on another document advances at stepDone 0.35, so the next sub-goal is not acted under it', async () => {
  const h = harness({
    observations: { p1: [hub, formEmpty, formEmpty, formFilled] },
    script: [CS(), AHEAD(0.35), AHEAD(0.05), ADV()],
  });
  const r = await h.call({ goal: 'chain-nav-advance goal', steps: NAV_STEPS, values: navValues });
  assert.equal(r.status, 'done');
  assert.deepEqual(actsOf(h), FILL_AFTER_CLICK);
  assert.equal(h.askActs[2], 1, 'the advance round acted on nothing');
  assert.equal(h.requests.length, 4);
  assert.equal((h.requests[2].state as { step?: string }).step, 'type the value named email into Email');
  const rs = navRounds(h);
  assert.equal(rs[1].navEvidence, true);
  assert.equal(rs[1].clickEvidence, true);
  assert.equal(rs[1].leftPage, true);
  assert.equal(navEvidenceRounds(h).length, 1);

  // Leg B: the link persists on the landed page (result 'page changed', not
  // 'element gone') — a landed click with a left document still advances.
  const landed = observation({ url: 'https://example.com/form', title: 'Form', elements: [hubEl, emailEl], text: 'form page' });
  const landedFilled = observation({ url: 'https://example.com/form', title: 'Form', elements: [hubEl, emailFilledEl], text: 'form page' });
  const h2 = harness({
    observations: { p1: [hub, landed, landed, landedFilled] },
    script: [CS(), AHEAD(0.35), AHEAD(0.05), ADV()],
  });
  const r2 = await h2.call({ goal: 'chain-nav-advance goal persistent link', steps: NAV_STEPS, values: navValues });
  assert.equal(r2.status, 'done');
  assert.deepEqual(actsOf(h2), FILL_AFTER_CLICK);
  assert.equal(h2.askActs[2], 1);
  assert.equal(navRounds(h2)[1].navEvidence, true);
  assert.equal(navRounds(h2)[1].leftPage, true);
});

test('T-nav-floor: the 0.25 floor is inclusive, below it the clause acts ahead as before, and at 0.6 the old evidence bar owns the advance', async () => {
  // Leg A: 0.24 is below the floor.
  const a = harness({
    observations: { p1: [hub, formEmpty, formFilled, formFilled] },
    script: [CS(), AHEAD(0.24), ADV(), ADV()],
  });
  const ra = await a.call({ goal: 'chain-nav-floor goal A', steps: NAV_STEPS, values: navValues });
  assert.equal(ra.status, 'done');
  assert.equal(a.askActs[2], 2, 'acted ahead under the open clause');
  assert.equal(navEvidenceRounds(a).length, 0);
  // Leg B: 0.25 advances on navigation evidence.
  const b = harness({
    observations: { p1: [hub, formEmpty, formEmpty, formFilled] },
    script: [CS(), AHEAD(0.25), AHEAD(0.05), ADV()],
  });
  const rb = await b.call({ goal: 'chain-nav-floor goal B', steps: NAV_STEPS, values: navValues });
  assert.equal(rb.status, 'done');
  assert.equal(b.askActs[2], 1);
  assert.equal(navRounds(b)[1].navEvidence, true);
  // Leg C: 0.6 is the existing click-evidence bar, not navigation evidence.
  const c = harness({
    observations: { p1: [hub, formEmpty, formEmpty, formFilled] },
    script: [CS(), AHEAD(0.6), AHEAD(0.05), ADV()],
  });
  const rc = await c.call({ goal: 'chain-nav-floor goal C', steps: NAV_STEPS, values: navValues });
  assert.equal(rc.status, 'done');
  assert.equal(navRounds(c)[1].clickEvidence, true);
  assert.equal(navRounds(c)[1].navEvidence, undefined);
  assert.equal(c.askActs[2], 1);
});

test('T-nav-same-url: a click that stays on the same document (or only changes the hash) keeps the 0.5 bar and acts ahead', async () => {
  for (const [i, url] of ['https://example.com/', 'https://example.com/#panel'].entries()) {
    const panel = observation({ url, title: 'Home', elements: [hubEl, emailEl], text: 'panel open' });
    const panelFilled = observation({ url, title: 'Home', elements: [hubEl, emailFilledEl], text: 'panel open' });
    const h = harness({
      observations: { p1: [hub, panel, panelFilled, panelFilled] },
      script: [CS(), AHEAD(0.35), ADV(), ADV()],
    });
    const r = await h.call({ goal: `chain-nav-sameurl goal ${i}`, steps: NAV_STEPS, values: navValues });
    assert.equal(r.status, 'done', url);
    assert.equal(h.askActs[2], 2, `${url}: acted ahead`);
    assert.equal(navEvidenceRounds(h).length, 0, url);
    assert.equal(navRounds(h)[1].leftPage, false, url);
  }
});

test('T-nav-error: a landed click whose page reads as an error never advances on navigation evidence', async () => {
  const h = harness({
    observations: { p1: [hub, formEmpty] },
    script: [CS(), AHEAD(0.35, { error: 0.6, recover: ['give-up', { 'give-up': 0.9 }] })],
  });
  const r = await h.call({ goal: 'chain-nav-error goal', steps: NAV_STEPS, values: navValues });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'page-error');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(actsOf(h), [['click', 'e1', undefined]]);
  assert.equal(navEvidenceRounds(h).length, 0);
});

test("T-nav-not-own: another clause's landed click is not evidence for the current clause", async () => {
  const clicked = observation({ url: 'https://example.com/form', title: 'Form', text: 'form page clicked' });
  const h = harness({
    observations: { p1: [hub, formPage, formPage, clicked] },
    script: [CS(), ADV(), CS({ step_done: 0.35 }), ADV()],
  });
  const r = await h.call({
    goal: 'chain-nav-notown goal',
    steps: ['open the Form link', 'press the Details button', 'press the Details button again'],
  });
  assert.equal(r.status, 'done');
  assert.equal(actsOf(h).length, 2);
  assert.equal(h.askActs[3], 2, 'clause 2 acted on its own first round');
  assert.equal(navEvidenceRounds(h).length, 0);
});

test('T-nav-count: a clause with a count word advances only on its count, never on navigation evidence', async () => {
  const next = (n: number) =>
    observation({
      url: `https://example.com/p${n}`,
      title: `P${n}`,
      elements: [
        el({ id: 'e1', path: '#next', tag: 'a', role: 'link', name: 'Next', fingerprint: { tag: 'a', role: 'link', name: 'Next', x: 0, y: 0 } }),
      ],
      text: `page ${n}`,
    });
  const h = harness({
    observations: { p1: [next(0), next(1), next(2)] },
    script: [CS(), CS({ step_done: 0.35 }), CS({ step_done: 0.35 }), ADV()],
  });
  const r = await h.call({ goal: 'chain-nav-count goal', steps: ['click the Next link twice', 'press the Next link'] });
  assert.equal(r.status, 'done');
  assert.equal(actsOf(h).filter((a) => a[0] === 'click').length, 2);
  assert.equal(navEvidenceRounds(h).length, 0);
});

test('T-nav-two-bindings: a clause with two value bindings never advances on navigation evidence', async () => {
  const login = observation({ url: 'https://example.com/login', title: 'Login', elements: [el({ path: '#signin', name: 'Sign in' })] });
  const home = observation({ url: 'https://example.com/home', title: 'Home', text: 'welcome' });
  const h = harness({
    observations: { p1: [login, home] },
    script: [CS(), CS({ step_done: 0.35, target: ['none', { none: 0.95, ambiguous: 0.03 }] })],
  });
  const r = await h.call({
    goal: 'chain-nav-twobind goal',
    steps: ['sign in with the value named user and the value named pass', 'press the Details button'],
    values: { user: 'person-user', pass: 'secret-pass-1' },
  });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(navEvidenceRounds(h).length, 0);
});

test('T-nav-token: a confirmed token click records beforeUrl, so the next round advances on navigation evidence', async () => {
  const placePage = observation({
    url: 'https://example.com/cart',
    title: 'Cart',
    elements: [el({ type: 'submit', name: 'Place order' })],
  });
  const h = harness({
    observations: { p1: [placePage, placePage, formEmpty, formEmpty, formFilled] },
    script: [AHEAD(0.35), AHEAD(0.05), ADV()],
    config: { gate: { mode: 'confirm' } },
  });
  const goal = 'chain-nav-token goal';
  const steps = ['place the order', 'type the value named email into Email'];
  const r1 = await h.call({ goal, steps, values: navValues, pick: { role: 'button', name: 'Place order', action: 'click' } });
  assert.equal(r1.status, 'needs_confirmation');
  const r2 = await h.call({ goal, steps, values: navValues, confirm_token: r1.confirm_token });
  assert.equal(r2.status, 'done');
  assert.deepEqual(actsOf(h), FILL_AFTER_CLICK);
  assert.equal(h.records[1].phases!.rounds[1].navEvidence, true);
});

test('T-nav-final-clause: navigation evidence never advances the FINAL clause (it would end done/goal-met on a weak landing)', async () => {
  const h = harness({
    observations: { p1: [hub, formEmpty, formFilled] },
    script: [CS(), AHEAD(0.35), ADV()],
  });
  const r = await h.call({ goal: 'chain-nav-final goal', steps: ['open the Form link'], values: navValues });
  assert.equal(navEvidenceRounds(h).length, 0);
  assert.equal(h.askActs[2], 2, 'acted ahead under the final clause: the old bars apply');
  assert.deepEqual(actsOf(h), FILL_AFTER_CLICK);
  assert.equal(r.status, 'done');
});

test('T-nav-expanded: the final-clause bar counts EXPANDED sub-clauses, so the open sub-clause of one caller clause still advances on its landing', async () => {
  // ONE caller clause that expands into two sub-clauses (callerN 1, N 2): a
  // mutant bounding by the caller count would treat sub-clause 0 as final.
  const h = harness({
    observations: { p1: [hub, formEmpty, formEmpty, formFilled] },
    script: [CS(), AHEAD(0.35), AHEAD(0.05), ADV()],
  });
  const r = await h.call({
    goal: 'chain-nav-expanded goal',
    steps: ['open the Form link, then type the value named email into Email'],
    values: navValues,
  });
  assert.equal(r.status, 'done');
  assert.deepEqual(actsOf(h), FILL_AFTER_CLICK);
  assert.equal(h.askActs[2], 1, 'the advance round acted on nothing');
  assert.equal((h.requests[2].state as { step?: string }).step, 'type the value named email into Email');
  assert.equal(navRounds(h)[1].navEvidence, true);
  assert.equal(navEvidenceRounds(h).length, 1);
});

test('T-nav-query: a landing that differs from the click page only by its query string is a left document', async () => {
  const landing = (filled: boolean) =>
    observation({ url: 'https://example.com/?view=form', title: 'Form', elements: [filled ? emailFilledEl : emailEl], text: 'form page' });
  const h = harness({
    observations: { p1: [hub, landing(false), landing(false), landing(true)] },
    script: [CS(), AHEAD(0.35), AHEAD(0.05), ADV()],
  });
  const r = await h.call({ goal: 'chain-nav-query goal', steps: NAV_STEPS, values: navValues });
  assert.equal(r.status, 'done');
  assert.deepEqual(actsOf(h), FILL_AFTER_CLICK);
  assert.equal(h.askActs[2], 1, 'the advance round acted on nothing');
  assert.equal(navRounds(h)[1].navEvidence, true);
  assert.equal(navRounds(h)[1].leftPage, true);
});

test('T-nav-leftpage-chain-only: legacy browse_step and wingman_do rounds never carry leftPage or navEvidence', async () => {
  const mk = () =>
    harness({ observations: { p1: [hub, formEmpty, formEmpty] }, script: [CS(), { done: 0.9 }] });
  const legacy = mk();
  const rl = await legacy.call({ goal: 'chain-nav-leftpage legacy goal', step: 'open the Form link' });
  assert.equal(rl.status, 'done');
  assert.equal(navRounds(legacy).length, 2);
  for (const r of navRounds(legacy)) {
    assert.equal(r.leftPage, undefined);
    assert.equal(r.navEvidence, undefined);
  }
  const doH = mk();
  const rd = await doH.callDo({ goal: 'chain-nav-leftpage do goal' });
  assert.equal(rd.status, 'done');
  assert.equal(navRounds(doH).length, 2);
  for (const r of navRounds(doH)) {
    assert.equal(r.leftPage, undefined);
    assert.equal(r.navEvidence, undefined);
  }
});

// ---- r15 (spec .build-r15-spec.md WP-B): post-action ends, the error gate on weak advances, no repeated submit ----

// Owned by .build-r15-spec.md D1; inlined so drift on either side fails.
const FORCED_POST_ACTION_LINE =
  "This step's action already ran, then the page did not become usable for the step and may show an error. Look at it with your own snapshot and do not repeat that action or reload the page. To go on, call browse_step again with only the steps after this one; if the page shows a failure the user needs to know about, tell the user.";
const retrieveEl = el({
  id: 'e1',
  path: '#retrieve',
  name: 'Retrieve',
  fingerprint: { tag: 'button', role: 'button', name: 'Retrieve', x: 0, y: 0 },
});
const resetForm = observation({ url: 'https://example.com/reset', title: 'Reset', elements: [retrieveEl], text: 'reset form' });
/** The same address after the submit, the button gone: a server error page (t9 forgot-password, r14). */
const resetError = observation({ url: 'https://example.com/reset', title: 'Error', elements: [], text: 'Internal Server Error' });
/** The same address after the submit, the form re-rendered under the error: the button is still there. */
const resetErrorForm = observation({
  url: 'https://example.com/reset',
  title: 'Error',
  elements: [retrieveEl],
  text: 'Internal Server Error',
});
/** A form page whose text differs per round, so each click reads 'page changed'. */
const resetFormN = (n: number) =>
  observation({ url: 'https://example.com/reset', title: 'Reset', elements: [retrieveEl], text: `reset form ${n}` });
/** The r14 post-submit round (M1.1 r34): step_done 0.38, error 0.49, ready 0.18, target none 0.98. */
const POST = (over: SeqEntry = {}): SeqEntry =>
  CS({
    step_done: 0.4,
    error: 0.45,
    ready: 0.2,
    right_page: 0.5,
    action: ['wait', { wait: 0.5, click: 0.3, none: 0.1 }],
    target: ['none', { none: 0.97, ambiguous: 0.02 }],
    ...over,
  });
const GIVE_UP: SeqEntry = { recover: ['give-up', { 'give-up': 0.9 }] };
const SUBMIT_STEPS = ['click the Retrieve button', 'open the Next page'];
const POST_REVIEW = { step: 'click the Retrieve button', why: 'post-action', candidates: [] };
const CLICK_WAIT_WAIT: Array<[Op, string | null, string | undefined]> = [
  ['click', 'e1', undefined],
  ['wait', null, undefined],
  ['wait', null, undefined],
];

test("T-post-notready: not ready after the clause's own effective click ends post-action; a no-change click or a fill keeps not-ready", async () => {
  const h = harness({
    observations: { p1: [resetForm, resetError, resetError, resetError] },
    script: [CS(), POST(), POST(), POST()],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-post-notready goal', steps: SUBMIT_STEPS });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.deepEqual(r.step_review, POST_REVIEW);
  assert.equal(r.note, FORCED_POST_ACTION_LINE);
  assert.deepEqual(actsOf(h), CLICK_WAIT_WAIT);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.records[0].step_review, { why: 'post-action', candidates: 0 });

  // Leg B: a click seen to change nothing is not an effective click.
  const hb = harness({ observations: { p1: [resetForm] }, script: [CS(), POST(), POST(), POST()], config: FORCED });
  const rb = await hb.call({ goal: 'chain-post-notready nochange goal', steps: SUBMIT_STEPS });
  assert.equal(rb.step_review?.why, 'not-ready');
  assert.equal(rb.note, FORCED_NOT_READY_LINE);

  // Leg C: a clause that only filled keeps the not-ready bounce.
  const hc = harness({
    observations: { p1: [formEmpty, formFilled, formFilled, formFilled] },
    script: [AHEAD(0.05), POST(), POST(), POST()],
    config: FORCED,
  });
  const rc = await hc.call({
    goal: 'chain-post-notready fill goal',
    steps: ['type the value named email into Email', 'open the Next page'],
    values: navValues,
  });
  assert.equal(rc.step_review?.why, 'not-ready');
});

test("T-post-error: a page-error end after the clause's own effective click carries why post-action, its note and the recover telemetry", async () => {
  const h = harness({
    observations: { p1: [resetForm, resetError] },
    script: [CS(), POST({ error: 0.9, ...GIVE_UP })],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-post-error goal', steps: SUBMIT_STEPS });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'page-error');
  assert.deepEqual(r.step_review, POST_REVIEW);
  assert.equal(r.note, FORCED_POST_ACTION_LINE);
  assert.equal(navRounds(h)[1].recover, 'give-up');
  assert.equal(navRounds(h)[0].recover, undefined);
});

test("T-post-reload: the recover path never reloads after the step's own effective click (chain and legacy browse_step)", async () => {
  const RELOAD: SeqEntry = { error: 0.9, recover: ['reload', { reload: 0.9 }] };
  const h = harness({
    observations: { p1: [resetForm, resetError, resetError] },
    script: [CS(), POST(RELOAD), ADV()],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-post-reload goal', steps: SUBMIT_STEPS });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'page-error');
  assert.deepEqual(r.step_review, POST_REVIEW);
  assert.deepEqual(actsOf(h), [['click', 'e1', undefined]]);
  assert.equal(h.requests.length, 2);
  assert.equal(navRounds(h)[1].recover, 'reload');

  // Leg B: legacy browse_step refuses the reload the same way (plain page-error).
  const hl = harness({
    observations: { p1: [resetForm, resetError, resetError] },
    script: [CS(), POST(RELOAD), { done: 0.9 }],
  });
  const rl = await hl.call({ goal: 'chain-post-reload legacy goal', step: 'click the Retrieve button' });
  assert.equal(rl.status, 'error');
  assert.equal(rl.reason, 'page-error');
  assert.deepEqual(actsOf(hl), [['click', 'e1', undefined]]);

  // Leg C (r10 L199/L200 shape): memory carries the click across an error end,
  // so a resumed call's recover reload is refused as well.
  const hc = harness({
    observations: { p1: [resetForm, resetError] },
    script: [CS(), POST({ error: 0.9, ...GIVE_UP }), POST(), POST(RELOAD), ADV()],
    config: FORCED,
  });
  const argsC = { goal: 'chain-post-reload resume goal', steps: SUBMIT_STEPS };
  const rc1 = await hc.call(argsC);
  assert.equal(rc1.status, 'error');
  assert.equal(rc1.step_review?.why, 'post-action');
  const rc2 = await hc.call(argsC);
  assert.equal(rc2.status, 'error');
  assert.equal(rc2.reason, 'page-error');
  assert.deepEqual(rc2.step_review, POST_REVIEW);
  assert.deepEqual(actsOf(hc), [
    ['click', 'e1', undefined],
    ['wait', null, undefined],
  ]);
  assert.equal(navRounds(hc)[1].recover, 'reload');
});

test('T-error-gate: below the 0.85 bar no advance passes an error the page shows; at 0.85 the clause still advances (done before error)', async () => {
  // Leg A (r11b L4/L10): click evidence at stepDone 0.55 with error 0.68.
  const ha = harness({
    observations: { p1: [resetForm, resetError, resetError] },
    script: [CS(), POST({ step_done: 0.55, error: 0.68, ...GIVE_UP }), ADV()],
    config: FORCED,
  });
  const ra = await ha.call({ goal: 'chain-error-gate click goal', steps: SUBMIT_STEPS });
  assert.equal(ra.status, 'error');
  assert.deepEqual(ra.step_review, POST_REVIEW);
  assert.equal(ha.requests.length, 2);

  // Leg B: fill evidence at 0.6 with error 0.7 (no click: a plain page-error).
  const hb = harness({
    observations: { p1: [formEmpty, formFilled, formFilled] },
    script: [AHEAD(0.05), CS({ step_done: 0.6, error: 0.7, ...GIVE_UP }), ADV()],
    config: FORCED,
  });
  const rb = await hb.call({
    goal: 'chain-error-gate fill goal',
    steps: ['type the value named email into Email', 'open the Next page'],
    values: navValues,
  });
  assert.equal(rb.status, 'error');
  assert.equal(rb.step_review, undefined);
  assert.equal(hb.requests.length, 2);

  // Leg C: action none at 0.6 with error 0.7, no act on the clause.
  const hc = harness({
    observations: { p1: [resetForm, resetForm, resetForm] },
    script: [CS({ ready: 0.2 }), POST({ step_done: 0.6, error: 0.7, ready: 0.95, action: ['none', { none: 0.9 }], ...GIVE_UP }), ADV()],
    config: FORCED,
  });
  const rc = await hc.call({ goal: 'chain-error-gate none goal', steps: SUBMIT_STEPS });
  assert.equal(rc.status, 'error');
  assert.equal(hc.requests.length, 2);

  // Leg D: a met click count with error 0.7.
  const hd = harness({
    observations: { p1: [resetFormN(0), resetFormN(1), resetFormN(2), resetFormN(2)] },
    script: [CS(), CS(), CS({ step_done: 0.3, error: 0.7, ...GIVE_UP })],
    config: FORCED,
  });
  const rd = await hd.call({ goal: 'chain-error-gate count goal', steps: ['click the Retrieve button twice', 'open the Next page'] });
  assert.equal(rd.status, 'error');
  assert.equal(rd.step_review?.step, 'click the Retrieve button twice');
  assert.equal(hd.requests.length, 3);

  // Leg E: stepDone 0.9 with error 0.68 still advances (C2: done before error).
  const he = harness({
    observations: { p1: [resetForm, resetError, resetError] },
    script: [CS(), POST({ step_done: 0.9, error: 0.68, ...GIVE_UP }), ADV()],
    config: FORCED,
  });
  const re = await he.call({ goal: 'chain-error-gate confident goal', steps: SUBMIT_STEPS });
  assert.equal(re.status, 'done');
  assert.equal(he.requests.length, 3);

  // Leg F: legacy browse_step click evidence (done 0.6) with error 0.7 never ends done/goal-met.
  const hf = harness({
    observations: { p1: [resetForm, resetError, resetError] },
    script: [CS(), { done: 0.6, error: 0.7, ...GIVE_UP }],
  });
  const rf = await hf.call({ goal: 'chain-error-gate legacy click goal', step: 'click the Retrieve button' });
  assert.equal(rf.status, 'error');
  assert.equal(rf.reason, 'page-error');

  // Leg G: legacy browse_step met count with error 0.7 never ends done/goal-met.
  const hg = harness({
    observations: { p1: [resetFormN(0), resetFormN(1), resetFormN(2), resetFormN(2)] },
    script: [CS(), CS(), { done: 0.1, error: 0.7, ...GIVE_UP }],
  });
  const rg = await hg.call({ goal: 'chain-error-gate legacy count goal', step: 'click the Retrieve button twice' });
  assert.equal(rg.status, 'error');
  assert.equal(rg.reason, 'page-error');
});

test('T-repeat-resume: a resumed clause never re-clicks a target it already clicked with effect (chain memory carries the click)', async () => {
  const h = harness({
    observations: { p1: [resetForm, resetErrorForm] },
    script: [CS(), POST(), POST(), POST(), CS({ step_done: 0.1 })],
    config: FORCED,
  });
  const args = { goal: 'chain-repeat-resume goal', steps: SUBMIT_STEPS };
  const r1 = await h.call(args);
  assert.equal(r1.step_review?.why, 'post-action');
  const r2 = await h.call(args);
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.reason, 'step-uncertain');
  assert.equal(r2.step_review?.why, 'repeat');
  assert.deepEqual(actsOf(h), CLICK_WAIT_WAIT);
  assert.equal(h.requests.length, 5);

  // Leg B: the carried clicks belong to the resumed clause only; after it
  // advances, the next clause may click the same element.
  const STEPS2 = ['click the Retrieve button', 'press Retrieve to resend'];
  const hb = harness({
    observations: { p1: [resetForm, resetErrorForm] },
    script: [CS(), POST(), POST(), POST(), ADV(), CS(), ADV()],
    config: FORCED,
  });
  const argsB = { goal: 'chain-repeat-resume scope goal', steps: STEPS2 };
  assert.equal((await hb.call(argsB)).step_review?.why, 'post-action');
  const rb = await hb.call(argsB);
  assert.equal(rb.status, 'done');
  assert.equal(actsOf(hb).filter((a) => a[0] === 'click').length, 2);

  // Leg C: in one call, an earlier clause's click on the same element does
  // not block the next clause's click.
  const hc = harness({
    observations: { p1: [resetFormN(0), resetFormN(1), resetFormN(2), resetFormN(3)] },
    script: [CS(), ADV(), CS(), ADV()],
    config: FORCED,
  });
  const rc = await hc.call({ goal: 'chain-repeat-resume clause goal', steps: STEPS2 });
  assert.equal(rc.status, 'done');
  assert.equal(actsOf(hc).filter((a) => a[0] === 'click').length, 2);
});

test('T-repeat-after-wait: in one call a wait between two clicks on the same target no longer hides the first click', async () => {
  const h = harness({
    observations: { p1: [resetForm, resetErrorForm] },
    script: [CS(), POST(), CS({ step_done: 0.1 })],
    config: FORCED,
  });
  const r = await h.call({ goal: 'chain-repeat-wait goal', steps: SUBMIT_STEPS });
  assert.equal(r.step_review?.why, 'repeat');
  assert.deepEqual(actsOf(h), [
    ['click', 'e1', undefined],
    ['wait', null, undefined],
  ]);

  // Leg B: a different control at the same path (another accessible name) is
  // not the clicked target, so it acts.
  const retryEl = el({
    id: 'e1',
    path: '#retrieve',
    name: 'Try again',
    fingerprint: { tag: 'button', role: 'button', name: 'Try again', x: 0, y: 0 },
  });
  const retryPage = observation({ url: 'https://example.com/reset', title: 'Error', elements: [retryEl], text: 'Internal Server Error' });
  const hb = harness({
    observations: { p1: [resetForm, retryPage, retryPage, retryPage] },
    script: [CS(), POST(), CS({ step_done: 0.1 }), ADV(), ADV()],
    config: FORCED,
  });
  const rb = await hb.call({ goal: 'chain-repeat-wait other name goal', steps: SUBMIT_STEPS });
  assert.equal(rb.status, 'done');
  assert.equal(actsOf(hb).filter((a) => a[0] === 'click').length, 2);
});

test("T-repeat-pick: an explicit pick of the clicked target is the caller's instruction and acts", async () => {
  const h = harness({
    observations: { p1: [resetForm, resetErrorForm] },
    script: [CS(), POST(), POST(), POST(), ADV(), ADV()],
    config: FORCED,
  });
  const args = { goal: 'chain-repeat-pick goal', steps: SUBMIT_STEPS };
  const r1 = await h.call(args);
  assert.equal(r1.step_review?.why, 'post-action');
  const r2 = await h.call({ ...args, pick: { role: 'button', name: 'Retrieve', action: 'click' } });
  assert.equal(r2.status, 'done');
  assert.equal(actsOf(h).filter((a) => a[0] === 'click').length, 2);
});

test('T-repeat-dialog: a click that opened a dialog still reaches chain memory, so the resume never re-clicks it (shared act site and token act)', async () => {
  const h = harness({
    observations: { p1: [resetForm, resetErrorForm] },
    script: [CS(), CS({ step_done: 0.1 })],
    config: FORCED,
  });
  const args = { goal: 'chain-repeat-dialog goal', steps: SUBMIT_STEPS };
  h.driver.dialogOnNextAct = { pageId: 'p1', type: 'confirm', message: 'Send it?' };
  const r1 = await h.call(args);
  assert.equal(r1.status, 'blocked');
  assert.equal(r1.reason, 'dialog-open');
  const r2 = await h.call(args);
  assert.equal(r2.step_review?.why, 'repeat');
  assert.deepEqual(actsOf(h), [['click', 'e1', undefined]]);

  // Leg B: the confirmed token click opens the dialog.
  const placePage = observation({
    url: 'https://example.com/cart',
    title: 'Cart',
    elements: [el({ type: 'submit', name: 'Place order' })],
  });
  const ht = harness({
    observations: { p1: [placePage] },
    script: [CS({ step_done: 0.1 })],
    config: { ...FORCED, gate: { mode: 'confirm' } },
  });
  const tArgs = { goal: 'chain-repeat-dialog token goal', steps: ['place the order', 'open the Next page'] };
  const t1 = await ht.call({ ...tArgs, pick: { role: 'button', name: 'Place order', action: 'click' } });
  assert.equal(t1.status, 'needs_confirmation');
  ht.driver.dialogOnNextAct = { pageId: 'p1', type: 'confirm', message: 'Place it?' };
  const t2 = await ht.call({ ...tArgs, confirm_token: t1.confirm_token });
  assert.equal(t2.status, 'blocked');
  assert.equal(t2.reason, 'dialog-open');
  // The gate would ask again before the repeat guard; turn it off so the guard decides.
  ht.deps.config = makeConfig(FORCED);
  const t3 = await ht.call(tArgs);
  assert.equal(t3.step_review?.why, 'repeat');
  assert.deepEqual(actsOf(ht), [['click', 'e1', undefined]]);
});
