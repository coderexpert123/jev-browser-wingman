// Takeover loop-mode tests (§ WP-T1b): browse_step inside the run loop.
// FakeDriver plus a scripted fake ask in the tests/loop.test.ts style — the
// harness shapes are written fresh here (helpers stay unimported between test
// files; the FakeDriver helper itself is shared infrastructure). Each § 3.18
// decision branch gets an input that would pass under a wrong rule order, and
// the § 8 known-bad cases (gate-bypass, >-threshold, best-grade-batch,
// token-ignore) flip their named test.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runStep, type LoopDeps } from '../src/core/loop.js';
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
    takeover?: { threshold?: number; mode?: TakeoverMode };
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
      ? { takeover: { threshold: takeover.threshold ?? 0.7, mode: takeover.mode ?? 'auto' } }
      : {}),
  } as WingmanConfig;
}

type NoulAnswers = {
  done?: number;
  blocked?: number;
  login?: number;
  error?: number;
  irreversible?: number;
  handle1?: number;
  handle2?: number;
  handle3?: number;
};
type ChoiceAnswers = {
  action?: [string, Record<string, number>];
  target?: [string, Record<string, number>];
  value?: [string, Record<string, number>];
  group?: [string, Record<string, number>];
  option?: [string, Record<string, number>];
  exec1?: [string, Record<string, number>];
  exec2?: [string, Record<string, number>];
  exec3?: [string, Record<string, number>];
};
type SeqEntry = (NoulAnswers & ChoiceAnswers) | { fail: string };

function choice(c: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: c, probabilities, confidence: 0.9 };
}

/** Standard round answers: click e1, nothing terminal. */
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

/** Routing-stage answers: handle<k> noul, exec<k> choice. */
function R(over: SeqEntry = {}): SeqEntry {
  return {
    exec1: ['wingman', { wingman: 0.9, caller: 0.05 }],
    ...over,
  };
}

const NOUL_KEYS = ['done', 'blocked', 'login', 'error', 'irreversible', 'handle1', 'handle2', 'handle3'] as const;
const CHOICE_KEYS = ['action', 'target', 'value', 'group', 'option', 'exec1', 'exec2', 'exec3'] as const;

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

// ---- required tests (§ WP-T1b items 1–21) ----

// 1. At-threshold entry (§ 8: a `>` temp copy flips this test).
test('a step graded exactly at the threshold takes over and runs to done', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.7 }), S(), { done: 0.9 }],
  });
  const r = await h.call({ goal: 'Open the details', step: 'click the Details button' });
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'goal-met');
  assert.ok(r.routing, 'no routing array on a takeover result');
  assert.equal(r.routing?.[0].executor, 'wingman');
  assert.equal(r.routing?.[0].handle, 0.7);
  assert.ok(r.steps >= 1);
  assert.ok(h.driver.actCalls().length >= 1);
});

// 2. Below threshold returns to the caller, never acts.
test('a step graded below threshold returns to the caller as route-caller and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.69 })],
  });
  const r = await h.call({ goal: 'g', step: 'click the Details button' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'route-caller');
  assert.deepEqual(r.routing?.[0], { step: 'click the Details button', handle: 0.69, executor: 'caller' });
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 1);
});

// 3. exec=caller wins even at a high handle (decision rule 2, not rule 1).
test('exec caller with a high handle grade returns route-caller and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9, exec1: ['caller', { caller: 0.9, wingman: 0.05 }] })],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'route-caller');
  assert.equal(r.routing?.[0].executor, 'caller');
  assert.equal(r.routing?.[0].handle, 0.9);
  assert.equal(h.driver.actCalls().length, 0);
});

// 4. Grader misbehaviour is route-unclear, not a low grade.
test('a missing handle answer is ambiguous route-unclear and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R()], // exec1 only: no handle1 answer
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.reason, 'route-unclear');
  assert.equal(r.routing?.[0].handle, null);
  assert.equal(r.routing?.[0].executor, 'caller');
  assert.equal(h.driver.actCalls().length, 0);
});

// 5. A high batch takes over once; steps 2–n are absorbed by the continuation.
test('a batch whose steps all grade high takes over once and absorbs the remaining steps', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      R({
        handle1: 0.9, handle2: 0.9, handle3: 0.9,
        exec2: ['wingman', { wingman: 0.9, caller: 0.05 }],
        exec3: ['wingman', { wingman: 0.9, caller: 0.05 }],
      }),
      S(),
      { done: 0.9 },
    ],
  });
  const r = await h.call({ goal: 'g', steps: ['s1', 's2', 's3'] });
  assert.equal(r.status, 'done');
  assert.equal(r.routing?.length, 3);
  // One routing ask carrying all six questions; the takeover asks follow.
  const q = h.requests[0].questions as Record<string, unknown>;
  assert.equal(Object.keys(q).length, 6);
  for (const k of ['handle1', 'exec1', 'handle2', 'exec2', 'handle3', 'exec3']) assert.ok(k in q, k);
  assert.ok(h.driver.actCalls().length >= 1);
});

// 6. Mixed batch never partially executes (§ 8: a best-grade temp copy flips this).
test('a mixed batch with a low first step returns the whole batch to the caller and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      R({
        handle1: 0.3,
        handle2: 0.95,
        handle3: 0.95,
        exec2: ['wingman', { wingman: 0.9, caller: 0.05 }],
        exec3: ['wingman', { wingman: 0.9, caller: 0.05 }],
      }),
    ],
  });
  const r = await h.call({ goal: 'g', steps: ['s1', 's2', 's3'] });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'route-caller');
  assert.equal(r.routing?.length, 3);
  assert.equal(r.routing?.[0].executor, 'caller');
  assert.equal(r.routing?.[1].executor, 'wingman');
  assert.equal(h.driver.actCalls().length, 0);
  assert.equal(h.requests.length, 1);
});

// 7. A gate fire inside a takeover pauses with a token (§ 8 KB-gate target).
test('takeover pauses at a gate fire with needs_confirmation, a token and the pending action', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [R({ handle1: 0.9 }), S()],
  });
  const r = await h.call({ goal: 'Order', step: 'click Place order' });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.reason, 'irreversible-heuristic');
  assert.equal(r.pending?.verb, 'click');
  assert.match(r.confirm_token ?? '', /^wct_/);
  assert.equal(h.driver.actCalls().length, 0);
});

// 8. A confirm token through browse_step runs the pending action once, no
// routing ask (§ 8 KB-token target).
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
  // The only ask is the continuation round; no routing ask ran.
  assert.equal(h.requests.length, 1);
  assert.ok(!('handle1' in (h.requests[0].questions as Record<string, unknown>)));
});

// 9. A takeover continuation can end ambiguous, with the resume note.
test('takeover continuation ends ambiguous and returns that reason', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [
      R({ handle1: 0.9 }),
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
});

// 10. The takeover shares wingman_do's step budget.
test('takeover ends at budget-steps when max_steps is exhausted', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 }), S(), S()],
  });
  const r = await h.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'budget-steps');
  assert.equal(h.driver.actCalls().length, 1);
  assert.equal(r.steps, 1);
});

// 11. Offer mode grades and offers, never acts.
test('offer mode returns takeover-offered with routing and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 })],
    config: { takeover: { mode: 'offer' } },
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'takeover-offered');
  assert.equal(r.routing?.[0].executor, 'wingman');
  assert.equal(r.note, OFFER_LINE);
  assert.equal(h.driver.actCalls().length, 0);
});

// 12. takeover: true accepts an offer-mode proposal at a passing grade; the
// threshold is never waived (a failing grade still refuses).
test('takeover true accepts an offer-mode proposal at a passing grade; a failing grade still refuses', async () => {
  const h1 = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 }), S(), { done: 0.9 }],
    config: { takeover: { mode: 'offer' } },
  });
  const r1 = await h1.call({ goal: 'g', step: 's', takeover: true });
  assert.equal(r1.status, 'done');
  assert.ok(h1.driver.actCalls().length >= 1);

  const h2 = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.5 })],
    config: { takeover: { mode: 'offer' } },
  });
  const r2 = await h2.call({ goal: 'g', step: 's', takeover: true });
  assert.equal(r2.status, 'fallback');
  assert.equal(r2.reason, 'route-caller');
  assert.equal(h2.driver.actCalls().length, 0);
});

// 13. takeover: false grades only, even in auto mode at a passing grade.
test('takeover false grades only and returns takeover-offered at a passing grade', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.95 })],
  });
  const r = await h.call({ goal: 'g', step: 's', takeover: false });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'takeover-offered');
  assert.equal(h.driver.actCalls().length, 0);
});

// 14. Shadow grades read-only, with routing and no act.
test('shadow grades and returns fallback shadow with routing and never acts', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 })],
    forceMode: 'shadow',
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'shadow');
  assert.equal(r.shadow, true);
  assert.equal(r.routing?.[0].executor, 'wingman');
  assert.equal(h.requests.length, 1);
  assert.equal(h.driver.actCalls().length, 0);
});

// 15. The policy check precedes the routing ask: no Jev call on a sensitive page.
test('a sensitive page stops takeover before the routing ask', async () => {
  const h = harness({
    observations: { p1: [observation({ signals: { ...cleanSignals, password: true } })] },
    script: [R({ handle1: 0.9 })],
  });
  const r = await h.call({ goal: 'g', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'sensitive-password');
  assert.equal(r.cost.jev_calls, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.driver.actCalls().length, 0);
});

// 16. The operator's gate-off stance is reachable from a takeover.
test('gate mode off lets a takeover act on a submit button without needs_confirmation', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ type: 'submit', name: 'Place order' })] })] },
    script: [R({ handle1: 0.9 }), S(), { done: 0.9 }],
    config: { gate: { mode: 'off' } },
  });
  const r = await h.call({ goal: 'Order', step: 'click Place order' });
  assert.equal(r.status, 'done');
  assert.equal(r.confirm_token, undefined);
  assert.equal(r.pending, undefined);
  assert.equal(h.driver.actCalls().length, 1);
});

// 17. Exactly one of step/steps.
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

// 18. Batch size bounds.
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

// 19. The § 3.17 note table, exact strings.
test('route-caller results carry the caller note; takeover-offered the offer note; a non-done takeover end the resume note', async () => {
  const h1 = harness({ observations: { p1: [observation()] }, script: [R({ handle1: 0.3 })] });
  const r1 = await h1.call({ goal: 'g', step: 's' });
  assert.equal(r1.reason, 'route-caller');
  assert.equal(r1.note, CALLER_LINE);

  const h2 = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 })],
    config: { takeover: { mode: 'offer' } },
  });
  const r2 = await h2.call({ goal: 'g', step: 's' });
  assert.equal(r2.reason, 'takeover-offered');
  assert.equal(r2.note, OFFER_LINE);

  const h3 = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 }), S(), S()],
  });
  const r3 = await h3.call({ goal: 'g', step: 's', max_steps: 1 });
  assert.equal(r3.status, 'fallback');
  assert.equal(r3.reason, 'budget-steps');
  assert.equal(r3.note, RESUME_LINE);
});

// 20. Exactly one log record per call; routing absent on a token continuation.
test('exactly one log record per browse_step call with tool browse_step', async () => {
  const h1 = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 }), S(), { done: 0.9 }],
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
  assert.equal(r2.routing, undefined);
});

// 21. Binding values never reach any request, even when the step and goal echo
// them (§ 8: the unredacted-builder leak throws here).
test('binding values never appear in any routing or round request when the step text echoes them', async () => {
  const values = { email: 'secret.value@example.com' };
  const h = harness({
    observations: { p1: [observation()] },
    script: [R({ handle1: 0.9 }), S(), { done: 0.9 }],
  });
  const r = await h.call({
    goal: 'Subscribe secret.value@example.com to the newsletter',
    step: 'fill secret.value@example.com into the email field and click Details',
    values,
  });
  assert.equal(r.status, 'done');
  assert.ok(h.requests.length >= 2);
  for (const request of h.requests) {
    assertNoValues(JSON.stringify(request), values);
  }
});
