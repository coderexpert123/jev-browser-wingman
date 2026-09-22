// Takeover loop-mode tests (§ WP-T1b, amendment 2026-09-21d): browse_step
// enters the run loop directly and the FIRST ROUND decides the call. FakeDriver
// plus a scripted fake ask in the tests/loop.test.ts style — the harness shapes
// are written fresh here (helpers stay unimported between test files; the
// FakeDriver helper itself is shared infrastructure). Each § 3.19 decision
// branch gets an input that would pass under a wrong rule order, and the § 8
// known-bad cases (threshold `>`, single-candidate bypass, evidence-less
// bounce, retry skip, gate-bypass, token-ignore) flip their named test.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runStep, VALUE_ANCHOR_SENTENCE, type LoopDeps } from '../src/core/loop.js';
import { FakeDriver } from './helpers/fake-driver.js';
import { ConfirmTokenStore } from '../src/core/tokens.js';
import { createMutex } from '../src/core/mutex.js';
import { DEFAULT_BUDGETS } from '../src/contract/constants.js';
import type { GateMode, TakeoverMode } from '../src/contract/constants.js';
import { assertNoValues } from '../src/core/withhold.js';
import type {
  ElementRecord,
  JevAnswer,
  JevAsk,
  JevRequest,
  Mode,
  Observation,
  PageInfo,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../src/contract/types.js';

// ---- fixtures (written fresh; do not import from tests/loop.test.ts) ----

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

function makeConfig(
  overrides: Partial<WingmanConfig> & {
    gate?: { mode: GateMode };
    takeover?: { threshold?: number; mode?: TakeoverMode; retry?: boolean };
  } = {},
): WingmanConfig {
  const { gate, takeover, ...rest } = overrides;
  return {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    profile_dir: path.join(os.tmpdir(), 'jevw-t1b-profile'),
    port: 9222,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS },
    ...rest,
    ...(gate ? { gate } : {}),
    ...(takeover
      ? {
          takeover: {
            ...(takeover.threshold !== undefined ? { threshold: takeover.threshold } : {}),
            ...(takeover.mode !== undefined ? { mode: takeover.mode } : {}),
            ...(takeover.retry !== undefined ? { retry: takeover.retry } : {}),
          },
        }
      : {}),
  } as WingmanConfig;
}

type NoulAnswers = {
  done?: number;
  blocked?: number;
  login?: number;
  error?: number;
  irreversible?: number;
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

/** Standard round answers: click e1 at 0.9 (a committing round), nothing terminal. */
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

const NOUL_KEYS = ['done', 'blocked', 'login', 'error', 'irreversible'] as const;
const CHOICE_KEYS = ['action', 'target', 'value', 'group', 'option'] as const;

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
  config?: Parameters<typeof makeConfig>[0];
  ask?: JevAsk | null;
  now?: () => number;
  forceMode?: Mode;
}): Harness {
  const driver = new FakeDriver({ pages: opts.pages ?? [page()], observations: opts.observations });
  const { ask, requests } = scriptedAsk(opts.script);
  const records: WingmanLogRecord[] = [];
  const deps: LoopDeps = {
    config: makeConfig(opts.config),
    driverFactory: () => driver,
    resolveEndpoint: async () => 'http://127.0.0.1:9222',
    ask: opts.ask !== undefined ? opts.ask : ask,
    mutex: createMutex(),
    tokens: new ConfirmTokenStore(),
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
    tokens: deps.tokens,
    deps,
    call: (input: unknown) => runStep(input, deps),
  };
}

// § 3.17 note table, inlined (not imported) so drift on either side fails.
const CALLER_LINE =
  'Step returned to you — do this step with your browser tools, then call browse_step again with the same goal and your next proposed step.';
const OFFER_LINE =
  'Takeover available — call browse_step again with the same arguments and takeover: true to accept, or do the step with your browser tools.';
const RESUME_LINE =
  'Takeover paused — call browse_step again with the same goal (and the same values) to continue from here.';

function assertNoRoutingQuestions(request: JevRequest): void {
  const keys = Object.keys(request.questions as Record<string, unknown>);
  for (const k of keys) {
    assert.ok(!/^handle\d+$/.test(k) && !/^exec\d+$/.test(k), `stale routing question ${k} in a round request`);
  }
}

// ---- required tests (§ WP-T1b items 1–24, amendment 2026-09-21d) ----

// 1. First round decides: a target exactly at the threshold commits; the entry
// ask IS the round-1 ask (the fail-first no-pre-pass pin: the pre-amendment
// build's request 1 is the routing ask, which carries handle1/exec1). The
// second element at 0.6 keeps the threshold rule the ONLY commit basis here —
// with a lone candidate the single-candidate rule would commit regardless and
// a `>` mutation of the threshold comparison would go unseen.
test('first round commits at the threshold and runs to done; no ask precedes the round-1 ask', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.7, e2: 0.6, none: 0.0, ambiguous: 0.0 }] }), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'Open the details', step: 'click the Details button' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.ok(r.steps >= 1);
  assert.ok(h.driver.actCalls().length >= 1);
  assert.equal(h.requests.length, 2);
  assertNoRoutingQuestions(h.requests[0]);
  assertNoRoutingQuestions(h.requests[1]);
  assert.ok(r.step_review === undefined, 'no step_review on a committed result');
});

// 2. Single-candidate rule: below the threshold, one plausible element acts.
// (Fail-first: KB-single-bypass — a threshold-only commit bounces here.)
test('a single-candidate round commits below the threshold and acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [
      S({ target: ['e1', { e1: 0.6, e2: 0.1, none: 0.2, ambiguous: 0.1 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(h.driver.actCalls()[0].elementId, 'e1');
});

// 3. A split round (two plausible candidates, none committed) bounces with
// evidence and never acts.
test('a split round bounces low-confidence with step_review and never acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.6, e2: 0.55, none: 0.0, ambiguous: 0.0 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'low-confidence');
  assert.equal(r.step_review?.step, 'click the Details button');
  const labels = (r.step_review?.candidates ?? []).map((c) => c.label);
  assert.ok(labels.length >= 2, 'both plausible candidates appear in the evidence');
  assert.ok(labels.some((l) => l.includes('button "Details"')), `criteria label missing: ${labels.join(' | ')}`);
  assert.ok(labels.some((l) => l.includes('button "Other"')), `criteria label missing: ${labels.join(' | ')}`);
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(r.note, CALLER_LINE);
});

// 4. Bounce evidence is redacted: a binding value planted in the element names
// and the step text never survives into the result or any request.
test('bounce evidence is redacted', async () => {
  const values = { email: 'secret.value@example.com' };
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [
            el({ name: 'secret.value@example.com' }),
            el({ id: 'e2', path: '#e2', name: 'Other', fingerprint: { tag: 'button', role: 'button', name: 'Other', x: 0, y: 0 } }),
          ],
        }),
      ],
    },
    script: [S({ target: ['e1', { e1: 0.6, e2: 0.55 }] })],
  });
  const r = await h.call({
    goal: 'g',
    step: 'fill secret.value@example.com into the field',
    values,
  });
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.step, 'fill <value:email> into the field');
  assertNoValues(JSON.stringify(r), values);
  for (const request of h.requests) {
    assertNoValues(JSON.stringify(request), values);
  }
});

// 5. Target none bounces as no-match.
test('target none bounces as no-match', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S({ target: ['none', { none: 0.9, e1: 0.05, ambiguous: 0.05 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.equal(h.driver.actCalls().length, 0);
});

// 6. Target ambiguous bounces as multi-match.
test('target ambiguous bounces as multi-match', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S({ target: ['ambiguous', { ambiguous: 0.8, e1: 0.1, none: 0.1 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'multi-match');
  assert.equal(h.driver.actCalls().length, 0);
});

// 7. An action-none entry round bounces as no-match, with candidates.
test('an action-none round bounces as no-match with candidates', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      {
        done: 0.3,
        blocked: 0.05,
        login: 0.05,
        irreversible: 0.05,
        action: ['none', { none: 0.9 }],
        target: ['e1', { e1: 0.9 }],
      },
    ],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-match');
  assert.ok((r.step_review?.candidates ?? []).length >= 1, 'candidates carried in the evidence');
  assert.equal(h.driver.actCalls().length, 0);
});

// 8. Self-retry: an uncertain first round re-observes and re-asks once, and the
// retry round commits. (Fail-first: KB-retry-skip bounces after one ask.)
test('self-retry fires on a target-uncertain first round and the retry commits', async () => {
  const h = harness({
    observations: { p1: [observation(), observation()] },
    script: [
      S({ target: ['none', { none: 0.9, e1: 0.05, ambiguous: 0.05 }] }),
      S(),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 'click Details' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 1);
  assert.ok(h.requests.length >= 3, `retry round ran (asks: ${h.requests.length})`);
});

// 9. Self-retry is skippable by config.
test('self-retry is skippable by config', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S({ target: ['none', { none: 0.9, e1: 0.05, ambiguous: 0.05 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 'click Details' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(h.requests.length, 1);
  assert.equal(h.driver.actCalls().length, 0);
});

// 10. The retry round's non-commit is final: exactly one retry, then bounce.
test('a non-committing retry round is final', async () => {
  const h = harness({
    observations: { p1: [observation(), observation()] },
    script: [
      S({ target: ['none', { none: 0.9, e1: 0.05, ambiguous: 0.05 }] }),
      S({ target: ['ambiguous', { ambiguous: 0.8, e1: 0.1, none: 0.1 }] }),
    ],
  });
  const r = await h.call({ goal: 'g', step: 'click Details' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'multi-match', 'the bounce carries the retry round’s evidence');
  assert.equal(h.requests.length, 2);
  assert.equal(h.driver.actCalls().length, 0);
});

// 11. A batch enters on step 1 only; steps 2–n are absorbed by the continuation.
test('a batch enters on step 1 and absorbs steps 2–n', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S(), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'g', steps: ['s1', 's2', 's3'] });
  assert.equal(r.status, 'done');
  assert.ok(h.driver.actCalls().length >= 1);
  // Round 1's state carries the redacted proposals[0] and never the others.
  const state = JSON.stringify(h.requests[0].state);
  assert.ok(state.includes('s1'), 'entry step text in round-1 state');
  assert.ok(!state.includes('"s2"') && !state.includes('"s3"'), 'steps 2–n never enter the state');
});

// 12. A gate fire inside a takeover pauses with a token (§ 8 KB-gate target).
test('takeover pauses at a gate fire with needs_confirmation, a token and the pending action', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [S()],
  });
  const r = await h.call({ goal: 'Order', step: 'click Place order' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-heuristic');
  assert.equal(r.pending?.verb, 'click');
  assert.match(r.confirm_token ?? '', /^wct_/);
  assert.equal(h.driver.actCalls().length, 0);
});

// 13. A confirm token through browse_step runs the pending action once, with no
// entry machinery (§ 8 KB-token target).
test('a confirm token through browse_step executes exactly the pending action once', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [{ done: 0.9 }],
  });
  const token = h.tokens.mint({
    url: 'https://example.com/list',
    elementPath: '#e1',
    fingerprint: { tag: 'button', role: 'button', name: 'Details', x: 0, y: 0 },
    verb: 'click',
    label: 'Details',
  });
  const r = await h.call({ goal: 'g', step: 'click Details', confirm_token: token });
  assert.equal(r.status, 'done');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].elementId, 'e1');
  assert.equal(acts[0].op, 'click');
  // The only ask is the continuation round; no entry decision preceded it.
  assert.equal(h.requests.length, 1);
  assertNoRoutingQuestions(h.requests[0]);
  assert.equal(r.step_review, undefined);
});

// 14. A takeover continuation can end ambiguous, with the resume note and no
// step_review (continuation ends never carry it).
test('takeover continuation ends ambiguous and returns that reason', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      S(),
      {
        done: 0.3,
        blocked: 0.05,
        login: 0.05,
        irreversible: 0.05,
        action: ['none', { none: 0.9 }],
        target: ['e1', { e1: 0.5, none: 0.3, ambiguous: 0.1 }],
      },
    ],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'no-action');
  assert.ok(Array.isArray(r.candidates));
  assert.equal(r.note, RESUME_LINE);
  assert.equal(r.step_review, undefined);
});

// 15. The takeover shares wingman_do's step budget.
test('takeover ends at budget-steps when max_steps is exhausted', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S(), S()],
  });
  const r = await h.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-steps');
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(r.steps, 1);
});

// 16. Offer mode: a committing round reports the offer, never acts.
test('offer mode returns takeover-offered with step_review and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S()],
    config: { takeover: { mode: 'offer' } },
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'takeover-offered');
  assert.equal(r.step_review?.why, 'offered');
  assert.equal(r.note, OFFER_LINE);
  assert.equal(h.driver.actCalls().length, 0);
});

// 17. takeover: true executes; takeover: false observes and offers.
test('takeover false observes and offers; takeover true executes', async () => {
  const h1 = harness({
    observations: { p1: [observation()] },
    script: [S(), { done: 0.9 }],
    config: { takeover: { mode: 'offer' } },
  });
  const r1 = await h1.call({ goal: 'g', step: 's', takeover: true });
  assert.equal(r1.status, 'done');
  assert.ok(h1.driver.actCalls().length >= 1);

  const h2 = harness({
    observations: { p1: [observation()] },
    script: [S()],
  });
  const r2 = await h2.call({ goal: 'g', step: 's', takeover: false });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.reason, 'takeover-offered');
  assert.equal(r2.step_review?.why, 'offered');
  assert.equal(h2.driver.actCalls().length, 0);
});

// 18. Shadow runs the entry round read-only.
test('shadow runs the entry round read-only', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [S()],
    forceMode: 'shadow',
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'shadow');
  assert.equal(r.shadow, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.driver.actCalls().length, 0);
});

// 19. The policy check precedes any ask: no Jev call on a sensitive page.
test('a sensitive page stops before any ask', async () => {
  const h = harness({
    observations: { p1: [observation({ signals: { ...cleanSignals, password: true } })] },
    script: [S()],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-password');
  assert.equal(r.cost.jev_calls, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

// 20. The operator's gate-off stance is reachable from a takeover.
test('gate mode off lets a takeover act on a submit button without needs_confirmation', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [S(), { done: 0.9 }],
    config: { gate: { mode: 'off' } },
  });
  const r = await h.call({ goal: 'Order', step: 'click Place order' });
  assert.equal(r.status, 'done');
  assert.equal(r.confirm_token, undefined);
  assert.equal(r.pending, undefined);
  assert.equal(h.driver.actCalls().length, 1);
});

// 21. Exactly one of step/steps.
test('an input with both step and steps is invalid-input; an input with neither is invalid-input', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [] });
  const r1 = await h1.call({ goal: 'g', step: 's', steps: ['a', 'b'] });
  assert.equal(r1.status, 'error');
  assert.equal(r1.reason, 'invalid-input');

  const h2 = harness({ observations: { p1: [observation()] }, script: [] });
  const r2 = await h2.call({ goal: 'g' });
  assert.equal(r2.status, 'error');
  assert.equal(r2.reason, 'invalid-input');
});

// 22. Batch size bounds.
test('an empty steps array or a 4-step batch is invalid-input', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [] });
  const r1 = await h1.call({ goal: 'g', steps: [] });
  assert.equal(r1.status, 'error');
  assert.equal(r1.reason, 'invalid-input');

  const h2 = harness({ observations: { p1: [observation()] }, script: [] });
  const r2 = await h2.call({ goal: 'g', steps: ['a', 'b', 'c', 'd'] });
  assert.equal(r2.status, 'error');
  assert.equal(r2.reason, 'invalid-input');
});

// 23. The § 3.17 note table, exact strings.
test('step-uncertain results carry the caller note; takeover-offered the offer note; a non-done takeover end the resume note', async () => {
  const h1 = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.6, e2: 0.55 }] })],
    config: { takeover: { retry: false } },
  });
  const r1 = await h1.call({ goal: 'g', step: 's' });
  assert.equal(r1.reason, 'step-uncertain');
  assert.equal(r1.note, CALLER_LINE);

  const h2 = harness({
    observations: { p1: [observation()] },
    script: [S()],
    config: { takeover: { mode: 'offer' } },
  });
  const r2 = await h2.call({ goal: 'g', step: 's' });
  assert.equal(r2.reason, 'takeover-offered');
  assert.equal(r2.note, OFFER_LINE);

  const h3 = harness({
    observations: { p1: [observation()] },
    script: [S(), S()],
  });
  const r3 = await h3.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r3.status, 'fallback');
  assert.equal(r3.reason, 'budget-steps');
  assert.equal(r3.note, RESUME_LINE);
});

// 24. Exactly one log record per call; step_review absent on a token
// continuation.
test('exactly one log record per browse_step call with tool browse_step', async () => {
  const h1 = harness({
    observations: { p1: [observation()] },
    script: [S(), { done: 0.9 }],
  });
  const r1 = await h1.call({ goal: 'g', step: 's' });
  assert.equal(r1.status, 'done');
  assert.equal(h1.records.length, 1);
  assert.equal(h1.records[0].tool, 'browse_step');

  const h2 = harness({ observations: { p1: [observation()] }, script: [{ done: 0.9 }] });
  const token = h2.tokens.mint({
    url: 'https://example.com/list',
    elementPath: '#e1',
    fingerprint: { tag: 'button', role: 'button', name: 'Details', x: 0, y: 0 },
    verb: 'click',
    label: 'Details',
  });
  const r2 = await h2.call({ goal: 'g', step: 's', confirm_token: token });
  assert.equal(r2.status, 'done');
  assert.equal(r2.step_review, undefined);
});

// ---- value-question anchor (§ 3.7 rule 8, amendment 2026-09-21e) ----

const FILL_ELEMENT = el({
  tag: 'input',
  role: 'textbox',
  name: 'Email',
  type: 'email',
  editable: true,
  path: '#email',
  fingerprint: { tag: 'input', role: 'textbox', name: 'Email', x: 0, y: 0 },
});

function fillRound(valueAnswer: [string, Record<string, number>]): SeqEntry {
  return S({ action: ['fill', { fill: 0.9, click: 0.05 }], target: ['e1', { e1: 0.9 }], value: valueAnswer });
}

// 25. A browse-origin fill round whose proposal names a supplied binding is
// anchored: the value grade below the § 3.7 threshold (0.46) must NOT bounce
// no-value — the proposal itself carries the value. Fail-first: against the
// pre-amendment build the round bounces `step-uncertain`/`no-value`.
test('a browse-origin fill round with a supplied binding commits below the value threshold', async () => {
  const values = { email: '77' };
  const h = harness({
    observations: { p1: [observation({ elements: [FILL_ELEMENT] })] },
    script: [fillRound(['email', { email: 0.46, none: 0.5 }]), { done: 0.9, action: ['none', { none: 0.9 }] }],
  });
  const r = await h.call({ goal: 'g', step: 'fill the email field', values });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  const acts = h.driver.actCalls();
  assert.equal(acts.length, 1);
  assert.equal(acts[0].op, 'fill');
  assert.equal(acts[0].value, '77');
  // The value question is anchored in the request; the anchor is static text
  // and the value stays withheld.
  const valueQ = (h.requests[0].questions as Record<string, { instructions?: string }>).value;
  assert.ok(valueQ?.instructions?.includes(VALUE_ANCHOR_SENTENCE), 'value question carries the anchor sentence');
  assertNoValues(JSON.stringify(h.requests), values);
});

// 26. A browse-origin round whose step text names no supplied binding is NOT
// anchored: the same 0.46 value grade still bounces no-value.
test('a browse-origin fill round with no named binding still bounces no-value below the threshold', async () => {
  const values = { email: '77' };
  const h = harness({
    observations: { p1: [observation({ elements: [FILL_ELEMENT] })] },
    script: [fillRound(['email', { email: 0.46, none: 0.5 }])],
  });
  const r = await h.call({ goal: 'g', step: 'fill the first field', values });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'no-value');
  const valueQ = (h.requests[0].questions as Record<string, { instructions?: string }>).value;
  assert.ok(!valueQ?.instructions?.includes(VALUE_ANCHOR_SENTENCE), 'unanchored request carries no anchor');
  assert.equal(h.driver.actCalls().length, 0);
});

// 27. Continuation two-part rule, single-candidate leg (amendment 2026-09-21g):
// a continuation round with a lone candidate in [floor, threshold) acts. Pin,
// not fail-first — the shipped fixed 0.5 bar also acted here.
test('a continuation round with a lone candidate in [floor, threshold) acts', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [
      S(),
      S({ target: ['e1', { e1: 0.6, e2: 0.1, none: 0.2, ambiguous: 0.1 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 2);
  assert.equal(h.driver.actCalls()[1].elementId, 'e1');
});

// 28. Continuation two-part rule, fail-first proof (amendment 2026-09-21g): a
// continuation round with two plausible candidates below the threshold bounces
// target-uncertain. The shipped rule 6 had no candidate-set check and acted.
test('a continuation round with two candidates below the threshold bounces target-uncertain', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S(), S({ target: ['e1', { e1: 0.55, e2: 0.55, none: 0.0, ambiguous: 0.0 }] })],
  });
  const r = await h.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.ok(Array.isArray(r.candidates));
  assert.equal(r.note, RESUME_LINE);
  assert.equal(r.step_review, undefined);
  assert.equal(h.driver.actCalls().length, 1, 'round 2 acts nothing');
});

// 29. Continuation two-part rule, threshold leg (amendment 2026-09-21g): a
// continuation round at or above the threshold acts regardless of candidate
// count.
test('a continuation round at the threshold or above acts regardless of candidate count', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [
      S(),
      S({ target: ['e1', { e1: 0.8, e2: 0.55, none: 0.0, ambiguous: 0.0 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 2);
});

// 30. Two-stage action carry (amendment 2026-09-21h, fail-first proof): on a
// dense page the entry decision must see request 1's `action` answer. The
// pre-amendment stage-2 decision set was `secondary ?? primary`, so `action`
// read undefined and every dense-page entry bounced no-match.
test('a two-stage entry round commits: request 1\'s action carries into the stage-2 decision', async () => {
  const five = [
    el(),
    el({ id: 'e2', path: '#e2', name: 'Other' }),
    el({ id: 'e3', path: '#e3', name: 'Third' }),
    el({ id: 'e4', path: '#e4', name: 'Fourth' }),
    el({ id: 'e5', path: '#e5', name: 'Fifth' }),
  ];
  const h = harness({
    observations: { p1: [observation({ elements: five })] },
    script: [
      { action: ['click', { click: 0.9, none: 0.05 }], group: ['g1', { g1: 0.9, g2: 0.05 }] },
      // Request 2 carries no action answer — the real two-stage shape (the
      // question-level pin below). Without the carry fix the entry decision
      // reads no verb here and bounces no-match.
      S({ target: ['e1', { e1: 0.9, none: 0.05, ambiguous: 0.0 }], action: undefined }),
      { done: 0.9 },
    ],
    config: { budgets: { ...DEFAULT_BUDGETS, max_elements: 4 } },
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(h.requests.length, 3, 'group ask + target ask + done round');
  const q1 = h.requests[0].questions as Record<string, unknown>;
  const q2 = h.requests[1].questions as Record<string, unknown>;
  assert.ok('group' in q1 && 'action' in q1, 'request 1 is the group request');
  assert.ok(!('target' in q1), 'request 1 carries no target question');
  assert.ok('target' in q2, 'request 2 is the target request');
  assert.ok(!('action' in q2), 'request 2 never repeats the action question (the shape pin)');
  assert.equal(r.status, 'done');
  assert.equal(r.step_review, undefined);
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(h.driver.actCalls()[0].elementId, 'e1');
});

// 31. Obstruction gate (amendment 2026-09-21h, fail-first proof): a committed
// entry target the enumerate-time probe reports covered bounces target-covered
// with redacted evidence, zero acts, and no self-retry — acting into an
// overlay is never right; the caller dismisses it and re-proposes.
test('an obscured entry target bounces target-covered with evidence and never acts', async () => {
  const h = harness({
    observations: {
      p1: [observation({ elements: [el({ obscured: true, coveredBy: 'div#veil' })] })],
    },
    script: [S({ target: ['e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }] })],
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button', values: { email: '77secret99' } });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'target-covered');
  assert.equal(r.step_review?.why, 'target-covered');
  assert.equal(r.step_review?.step, 'click the Details button');
  const labels = (r.step_review?.candidates ?? []).map((c) => c.label);
  assert.ok(labels.length >= 1, 'evidence carried');
  assert.ok(labels.some((l) => l.includes('button "Details"')), `criterion in evidence: ${labels.join(' | ')}`);
  assert.ok(labels.some((l) => l.includes('div#veil')), `cover named in evidence: ${labels.join(' | ')}`);
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 1, 'no self-retry: the caller dismisses the overlay and re-proposes');
  assert.equal(r.note, RESUME_LINE);
  assertNoValues(JSON.stringify(r), { email: '77secret99' });
  for (const req of h.requests) {
    assertNoValues(JSON.stringify(req), { email: '77secret99' });
  }
});

// 32. The gate keys on the chosen element only (amendment 2026-09-21h): an
// unobscured target commits on a page that also lists obscured elements.
test('an unobscured target commits on a page that also lists obscured elements', async () => {
  const h = harness({
    observations: {
      p1: [
        observation({
          elements: [el({ obscured: true, coveredBy: 'div#veil' }), el({ id: 'e2', path: '#e2', name: 'Other' })],
        }),
      ],
    },
    script: [S({ target: ['e2', { e2: 0.9, e1: 0.05, none: 0.0, ambiguous: 0.0 }] }), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(h.driver.actCalls()[0].elementId, 'e2');
});

// 33. Top-candidate margin rule, entry (amendment 2026-09-22, the measured-case
// fail-first proof): the answer chose the `ambiguous` meta-answer but one
// element dominates the probability map (the live Amazon /s shape: searchbox
// 0.66 vs ambiguous 0.25, every other element <= 0.07) — the round commits on
// the margin rule and acts on the dominating element. Fail-first: the
// pre-amendment build bounces 'multi-match' on any ambiguous choice.
test('an ambiguous choice with a dominating element commits on the margin rule and acts on that element', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [
      S({ target: ['ambiguous', { e1: 0.66, ambiguous: 0.25, e2: 0.07, none: 0.02 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 'click the search box' });
  assert.equal(r.status, 'done');
  assert.equal(r.step_review, undefined);
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(h.driver.actCalls()[0].elementId, 'e1');
});

// 34. Top-candidate margin rule, entry tightening (amendment 2026-09-22, the
// fail-first proof): a within-2x element runner-up bounces low-confidence —
// the pre-amendment single-candidate leg committed exactly this pair (the 0.4
// runner-up is below the 0.5 floor, so the candidate set held one member).
test('an entry round with a within-2x element runner-up bounces low-confidence', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.66, e2: 0.4, none: 0.0, ambiguous: 0.0 }] })],
    config: { takeover: { retry: false } },
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'low-confidence');
  assert.equal(h.driver.actCalls().length, 0);
});

// 35. Margin floor boundary (amendment 2026-09-22, pin): below the floor the
// round bounces whatever the rivals look like; exactly at the floor with
// dominated rivals it acts. The bounce leg is green on the pre-amendment build
// too — it pins TAKEOVER_MARGIN_FLOOR against drift, it does not discriminate
// the amendment (33/34/36/37 do).
test('an entry round below the margin floor bounces and one exactly at the floor acts', async () => {
  const below = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.45, e2: 0.1, none: 0.25, ambiguous: 0.2 }] })],
    config: { takeover: { retry: false } },
  });
  const rb = await below.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(rb.status, 'fallback');
  assert.equal(rb.reason, 'step-uncertain');
  assert.equal(rb.step_review?.why, 'low-confidence');
  assert.equal(below.driver.actCalls().length, 0);

  const at = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S({ target: ['e1', { e1: 0.5, e2: 0.24, none: 0.13, ambiguous: 0.13 }] }), { done: 0.9 }],
  });
  const ra = await at.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(ra.status, 'done');
  assert.equal(at.driver.actCalls().length, 1);
  assert.equal(at.driver.actCalls()[0].elementId, 'e1');
});

// 36. Top-candidate margin rule, continuation (amendment 2026-09-22, the
// continuation fail-first proof): a mid-takeover round whose answer chose
// `ambiguous` while one element dominates acts on that element. Fail-first:
// the pre-amendment continuation returns target-uncertain on any meta-answer
// choice.
test('a continuation round with an ambiguous choice and a dominating element acts on that element', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [
      S(),
      S({ target: ['ambiguous', { e1: 0.66, ambiguous: 0.25, e2: 0.07, none: 0.02 }] }),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'done');
  assert.equal(h.driver.actCalls().length, 2);
  assert.equal(h.driver.actCalls()[1].elementId, 'e1');
});

// 37. Top-candidate margin rule, continuation tightening (amendment 2026-09-22,
// the continuation fail-first proof): a within-2x element runner-up bounces
// target-uncertain — the pre-amendment single-candidate leg acted round 2 and
// the call ended budget-steps.
test('a continuation round with a within-2x element runner-up bounces target-uncertain', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })] })] },
    script: [S(), S({ target: ['e1', { e1: 0.66, e2: 0.4, none: 0.0, ambiguous: 0.0 }] })],
  });
  const r = await h.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'target-uncertain');
  assert.equal(r.note, RESUME_LINE);
  assert.equal(r.step_review, undefined);
  assert.equal(h.driver.actCalls().length, 1, 'round 2 acts nothing');
});
