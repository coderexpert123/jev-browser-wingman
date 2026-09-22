// Escalating bounce text (amendment 2026-09-22): a per-goal bounce counter,
// in-process, keyed on the goal text, escalates the static note on browse_step
// bounce results (fallback/step-uncertain and fallback/target-covered). Tier 1
// keeps the current static note and appends the retry-or-take-over sentence;
// tiers 2 and 3 REPLACE the note. Done results carry no note and touch the
// counter; non-bounce non-done results keep the § 3.17 static table. Harness
// shapes written fresh (helpers stay unimported between test files; FakeDriver
// is shared infrastructure). Each bounce asserts an EXACT string so any drift
// on either side fails.
//
// The counter is module-level and survives across separate runStep calls (and
// separate harness instances) within this process: every test uses a goal text
// unique to it, except the tier-ladder test, which walks one goal up the
// ladder deliberately.

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
import type {
  ElementRecord,
  JevAnswer,
  JevAsk,
  JevRequest,
  Observation,
  PageInfo,
  WingmanConfig,
  WingmanResult,
} from '../src/contract/types.js';

// ---- fixtures (written fresh; do not import from other test files) ----

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
    elements: [el(), el({ id: 'e2', path: '#e2', name: 'Other' })],
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
    profile_dir: path.join(os.tmpdir(), 'jevw-bounce-profile'),
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

/** A committing entry round: click e1 at 0.9 — clears the threshold rule. */
function COMMIT(over: SeqEntry = {}): SeqEntry {
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

/** A split entry round: click e1 0.6 vs e2 0.55 — under the threshold and
 * within the margin ratio, so the entry decision never commits. */
function SPLIT(over: SeqEntry = {}): SeqEntry {
  return {
    done: 0.05,
    blocked: 0.05,
    login: 0.05,
    irreversible: 0.05,
    action: ['click', { click: 0.9, none: 0.05 }],
    target: ['e1', { e1: 0.6, e2: 0.55, none: 0.05, ambiguous: 0.05 }],
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
    if ('fail' in step) throw new Error('no fail entries in this harness');
    const answers: Record<string, JevAnswer> = {};
    for (const key of ['done', 'blocked', 'login', 'error', 'irreversible'] as const) {
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

function harness(opts: {
  observations: Record<string, Observation[]>;
  script: SeqEntry[];
  config?: Parameters<typeof makeConfig>[0];
}): { call: (input: unknown) => Promise<WingmanResult>; requests: JevRequest[] } {
  const driver = new FakeDriver({ pages: [page()], observations: opts.observations });
  const { ask, requests } = scriptedAsk(opts.script);
  const deps: LoopDeps = {
    config: makeConfig(opts.config),
    driverFactory: () => driver,
    resolveEndpoint: async () => 'http://127.0.0.1:9222',
    ask,
    mutex: createMutex(),
    tokens: new ConfirmTokenStore(),
    writeLog: async () => {},
  };
  return { call: (input: unknown) => runStep(input, deps), requests };
}

/** The § 3.17 static notes, inlined (not imported) so drift on either side fails. */
const CALLER_LINE =
  'Step returned to you — do this step with your browser tools, then call browse_step again with the same goal and your next proposed step.';
const OFFER_LINE =
  'Takeover available — call browse_step again with the same arguments and takeover: true to accept, or do the step with your browser tools.';
const RESUME_LINE =
  'Takeover paused — call browse_step again with the same goal (and the same values) to continue from here.';

// The escalation tiers, exact strings (amendment 2026-09-22).
const TIER1 =
  'Retry with a more specific description of the target, or perform this step yourself with your raw browser tools.';
const TIER2 =
  'wingman has now declined 2 steps of this goal. Complete the remaining steps with your own browser tools and stop calling wingman for this goal.';
const TIER3 =
  'wingman is not able to progress on this goal. Drive the remaining steps yourself; do not call wingman again for this goal.';

const BOUNCE_ROUND = { config: { takeover: { retry: false } } };

// ---- tier ladder: bounces 1, 2, 3 on one goal produce the three tiers ----

test('bounce 1 on a goal appends the retry-or-take-over sentence to the caller note', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const r = await h.call({ goal: 'esc-ladder-goal', step: 's' });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.note, `${CALLER_LINE} ${TIER1}`);
});

test('bounce 2 on the same goal replaces the note with the stop-calling sentence', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const r = await h.call({ goal: 'esc-ladder-goal', step: 's' });
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.note, TIER2);
});

test('bounce 3 on the same goal replaces the note with the not-able-to-progress sentence', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const r = await h.call({ goal: 'esc-ladder-goal', step: 's' });
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.note, TIER3);
});

test('bounce 4 and beyond stay at tier 3', async () => {
  const h = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const r = await h.call({ goal: 'esc-ladder-goal', step: 's' });
  assert.equal(r.note, TIER3);
});

// ---- the counter is per goal text ----

test('a different goal text starts the ladder again at tier 1', async () => {
  // 'esc-ladder-goal' is already at tier 3+; a fresh goal must see tier 1.
  const h = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const r = await h.call({ goal: 'esc-fresh-goal', step: 's' });
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.note, `${CALLER_LINE} ${TIER1}`);
});

// ---- done results carry no escalation and do not move the counter ----

test('a done result carries no note, and bounces after it resume the ladder, not restart it', async () => {
  const done = harness({ observations: { p1: [observation()] }, script: [{ done: 0.9 }] });
  const rDone = await done.call({ goal: 'esc-done-goal', step: 's' });
  assert.equal(rDone.status, 'done');
  assert.equal(rDone.note, undefined);

  // Two bounces on the same goal: tiers 1 then 2 — the intervening done call
  // neither carried a note nor reset the counter.
  const b1 = harness({ observations: { p1: [observation()] }, script: [SPLIT()], ...BOUNCE_ROUND });
  const r1 = await b1.call({ goal: 'esc-done-goal', step: 's' });
  assert.equal(r1.note, `${CALLER_LINE} ${TIER1}`);

  const doneAgain = harness({ observations: { p1: [observation()] }, script: [{ done: 0.9 }] });
  const rDone2 = await doneAgain.call({ goal: 'esc-done-goal', step: 's' });
  assert.equal(rDone2.note, undefined);

  const b2 = harness({ observations: { p1: [observation()] }, script: [SPLIT()], ...BOUNCE_ROUND });
  const r2 = await b2.call({ goal: 'esc-done-goal', step: 's' });
  assert.equal(r2.note, TIER2);
});

// ---- target-covered is a bounce and escalates; other non-done notes stay static ----

test('a target-covered bounce escalates like any bounce', async () => {
  const h = harness({
    observations: { p1: [observation({ elements: [el({ obscured: true, coveredBy: 'div#veil' })] })] },
    script: [COMMIT()],
  });
  const r = await h.call({ goal: 'esc-covered-goal', step: 'click the Details button' });
  assert.equal(r.reason, 'target-covered');
  assert.equal(r.note, `${RESUME_LINE} ${TIER1}`);
});

test('takeover-offered and budget-steps keep their static notes even after bounces on the goal', async () => {
  // Two bounces first, so the goal sits at tier 2.
  const b1 = harness({ observations: { p1: [observation()] }, script: [SPLIT()], ...BOUNCE_ROUND });
  await b1.call({ goal: 'esc-static-goal', step: 's' });
  const b2 = harness({ observations: { p1: [observation()] }, script: [SPLIT()], ...BOUNCE_ROUND });
  await b2.call({ goal: 'esc-static-goal', step: 's' });

  const offered = harness({
    observations: { p1: [observation()] },
    script: [COMMIT()],
    config: { takeover: { mode: 'offer' } },
  });
  const rOffer = await offered.call({ goal: 'esc-static-goal', step: 's' });
  assert.equal(rOffer.reason, 'takeover-offered');
  assert.equal(rOffer.note, OFFER_LINE);

  const bounded = harness({ observations: { p1: [observation()] }, script: [COMMIT(), COMMIT()] });
  const rBound = await bounded.call({ goal: 'esc-static-goal', step: 's', max_steps: 1 });
  assert.equal(rBound.reason, 'budget-steps');
  assert.equal(rBound.note, RESUME_LINE);

  // wingman_do's continuation line is untouched by the escalation. This third
  // bounce on the goal is also the ladder's tier-3 leg: the two earlier
  // bounces above plus this one.
  const offeredBounce = harness({
    observations: { p1: [observation()] },
    script: [SPLIT()],
    ...BOUNCE_ROUND,
  });
  const rAfter = await offeredBounce.call({ goal: 'esc-static-goal', step: 's' });
  assert.equal(rAfter.reason, 'step-uncertain');
  assert.equal(rAfter.note, TIER3);
});
