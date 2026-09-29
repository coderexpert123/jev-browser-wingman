// Outcome-evidence + no-progress guard tests (WP-outcome-evidence WP-A/WP-B).
//
// The bug this closes: buildState's history never carried what an action
// actually did to the page, so step_done/done had no evidence a fill/select/
// check took, and the loop kept repeating the same act until budget-steps.
// These tests drive a scripted ask that decides step_done purely from
// whether request.state's history carries an observed `result` — so they
// fail on the unfixed loop (no `result` ever appears) and pass once the
// outcome-evidence choke point (annotateLastOutcome, called every round
// right after the fresh obs) fills it in.
//
// FakeDriver only; no browser. Chain mode (browse_step, one clause) exercises
// the same shared act/history site wingman_do uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runStep, runDo, parseRepeatCount, type LoopDeps } from '../src/core/loop.js';
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
  Op,
  PageInfo,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../src/contract/types.js';

// ---- fixtures (mirrors tests/chain.test.ts) ----

function el(overrides: Partial<ElementRecord> = {}): ElementRecord {
  return {
    id: 'e1',
    path: '#e1',
    tag: 'input',
    role: 'textbox',
    name: 'Amount',
    type: 'text',
    attrName: '',
    ariaLabel: '',
    autocomplete: '',
    state: { disabled: false, filled: false },
    editable: true,
    inViewport: true,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    form: -1,
    fingerprint: { tag: 'input', role: 'textbox', name: 'Amount', x: 0, y: 0 },
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
    url: 'https://example.com/form',
    title: 'Form',
    elements: [el()],
    forms: [],
    signals: { ...cleanSignals },
    text: 'plain page text',
    truncated: false,
    ...overrides,
  };
}

function page(overrides: Partial<PageInfo> = {}): PageInfo {
  return { id: 'p1', url: 'https://example.com/form', title: 'Form', visible: true, ...overrides };
}

function makeConfig(overrides: Partial<WingmanConfig> = {}): WingmanConfig {
  return {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    profile_dir: path.join(os.tmpdir(), 'jevw-outcome-evidence-profile'),
    port: 9222,
    chrome_path: null,
    secrets_file: null,
    plugin: null,
    sensitive_hosts: {},
    budgets: { ...DEFAULT_BUDGETS, max_steps: 3 },
    ...overrides,
  } as WingmanConfig;
}

function choice(c: string, probabilities: Record<string, number>): JevAnswer {
  return { type: 'choice', choice: c, probabilities, confidence: 0.9 };
}

interface Harness {
  driver: FakeDriver;
  requests: JevRequest[];
  records: WingmanLogRecord[];
  deps: LoopDeps;
  call: (input: unknown) => Promise<WingmanResult>;
  callDo: (input: unknown) => Promise<WingmanResult>;
}

function harness(opts: {
  observations: Record<string, Observation[]>;
  ask: JevAsk;
  config?: Partial<WingmanConfig>;
}): Harness {
  const driver = new FakeDriver({ pages: [page()], observations: opts.observations });
  const requests: JevRequest[] = [];
  const records: WingmanLogRecord[] = [];
  const ask: JevAsk = async (request, callOpts) => {
    requests.push(request);
    return opts.ask(request, callOpts);
  };
  const tokens = new ConfirmTokenStore();
  const deps: LoopDeps = {
    config: makeConfig(opts.config),
    driverFactory: () => driver,
    resolveEndpoint: async () => 'http://127.0.0.1:9222',
    ask,
    mutex: createMutex(),
    tokens,
    writeLog: async (record) => {
      records.push(record);
    },
  };
  return {
    driver,
    requests,
    records,
    deps,
    call: (input: unknown) => runStep(input, deps),
    callDo: (input: unknown) => runDo(input, deps),
  };
}

/** A round of noul answers that never blocks, never errors, and treats the
 * page as ready and on the right page — the parts every scripted ask below
 * needs regardless of what it decides for step_done/action/target. */
function baseNouls(): Record<string, JevAnswer> {
  return {
    done: { type: 'noul', noul: 0.05 },
    blocked: { type: 'noul', noul: 0.05 },
    login: { type: 'noul', noul: 0.05 },
    error: { type: 'noul', noul: 0.05 },
    irreversible: { type: 'noul', noul: 0.05 },
    right_page: { type: 'noul', noul: 0.95 },
    ready: { type: 'noul', noul: 0.95 },
  };
}

async function reply(answers: Record<string, JevAnswer>): ReturnType<JevAsk> {
  return { ok: true, answers, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1, status: 200, retries: 0 };
}

// ---- T-repeat: fill, scripted purely on observed evidence in the state ----

/** step_done reads ONLY request.state's serialized history: 0.95 once it
 * carries a `"result":"filled"` entry, 0.1 otherwise. On the unfixed loop
 * that entry never appears, so this never advances and the call runs to
 * budget-steps, filling every round. On the fixed loop it advances the round
 * right after the first fill actually lands. */
function repeatAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.95 : 0.1 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
}

test('T-repeat: fill takes effect and the chain call ends done, filling exactly once', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask: repeatAsk() });
  const r = await h.call({
    goal: 'outcome-evidence repeat goal',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'goal-met');
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1, 'fill must happen exactly once, not repeat every round');
});

// ---- T-select: select advances only once the option is actually selected ----

function selectEl(selected: string): ElementRecord {
  return el({
    tag: 'select',
    role: 'combobox',
    name: 'Country',
    type: '',
    editable: false,
    state: { disabled: false, selected },
    options: [
      { value: 'us', label: 'United States' },
      { value: 'ca', label: 'Canada' },
    ],
    fingerprint: { tag: 'select', role: 'combobox', name: 'Country', x: 0, y: 0 },
  });
}

function selectAsk(): JevAsk {
  return async (request) => {
    // "Canada" is also the bound value `country`, so the observed result
    // arrives redacted (buildState's redactDeep tokenizes it like every
    // other string) — this is exactly the redaction case the dedicated
    // "redaction" test below re-checks in isolation.
    const hasEvidence = JSON.stringify(request.state).includes('"result":"selected: <value:country>"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.95 : 0.1 },
      action: choice('select', { select: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('country', { country: 0.9, none: 0.05 }),
      option: choice('o2', { o1: 0.05, o2: 0.9, none: 0.05 }),
    });
  };
}

test('T-select: select takes effect and the chain call ends done, selecting exactly once', async () => {
  const before = observation({ elements: [selectEl('United States')] });
  const after = observation({ elements: [selectEl('Canada')] });
  const h = harness({ observations: { p1: [before, after] }, ask: selectAsk() });
  const r = await h.call({
    goal: 'outcome-evidence select goal',
    steps: ['select Canada'],
    values: { country: 'Canada' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const selectActs = h.driver.actCalls().filter((a) => a.op === 'select');
  assert.equal(selectActs.length, 1, 'select must happen exactly once, not repeat every round');
});

// ---- T-check: check advances only once the box is actually checked ----

function checkEl(checked: boolean): ElementRecord {
  return el({
    tag: 'input',
    role: 'checkbox',
    name: 'Agree',
    type: 'checkbox',
    editable: false,
    state: { disabled: false, checked },
    fingerprint: { tag: 'input', role: 'checkbox', name: 'Agree', x: 0, y: 0 },
  });
}

function checkAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"checked"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.95 : 0.1 },
      action: choice('check', { check: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
}

test('T-check: check takes effect and the chain call ends done, checking exactly once', async () => {
  const before = observation({ elements: [checkEl(false)] });
  const after = observation({ elements: [checkEl(true)] });
  const h = harness({ observations: { p1: [before, after] }, ask: checkAsk() });
  const r = await h.call({ goal: 'outcome-evidence check goal', steps: ['agree to terms'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const checkActs = h.driver.actCalls().filter((a) => a.op === 'check');
  assert.equal(checkActs.length, 1, 'check must happen exactly once, not repeat every round');
});

// ---- T-no-progress: the fill never takes; the guard must stop the call ----

/** Always proposes the same fill on the same element, never sees evidence it
 * took (the observation script below never flips filled to true) and never
 * says the step is done. On the unfixed loop (no guard) this runs to
 * budget-steps, filling every round. With the guard it must stop the SECOND
 * time the identical (verb, element) repeats with no observed change. */
function noProgressAsk(): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
}

test('T-no-progress: a repeated no-effect fill ends fallback/no-progress, not budget-steps', async () => {
  const stillEmpty = observation(); // filled stays false every round — the fill never takes
  const h = harness({ observations: { p1: [stillEmpty] }, ask: noProgressAsk(), config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } } });
  const r = await h.call({
    goal: 'outcome-evidence no-progress goal',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected no-progress, got reason ${r.reason} after ${r.steps} steps`);
  assert.equal(r.step_review?.why, 'no-progress');
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1, 'the guard must stop the SECOND identical no-change fill, not act it');
});

test('T-no-progress (wingman_do): a repeated no-effect fill ends fallback/no-progress with no step_review', async () => {
  const stillEmpty = observation();
  const h = harness({ observations: { p1: [stillEmpty] }, ask: noProgressAsk(), config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } } });
  const r = await h.callDo({ goal: 'fill the amount field with 42', values: { amount: '42' } });
  assert.equal(r.status, 'fallback');
  assert.equal(r.reason, 'no-progress');
  assert.equal(r.step_review, undefined, 'wingman_do carries no step_review (browse_step-only field)');
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1);
});

// ---- redaction: an option's label equal to a bound value is tokenized ----

test('redaction: a select result carrying a bound value is tokenized before it reaches the request', async () => {
  // "Canada" is both the select's post-act label AND a bound value, so once
  // history's result field renders "selected: Canada" it must be redacted
  // exactly like every other string in state, per buildState's existing
  // redactDeep over the whole `raw` object.
  const before = observation({ elements: [selectEl('United States')] });
  const after = observation({ elements: [selectEl('Canada')] });
  const seenRequests: JevRequest[] = [];
  const ask: JevAsk = async (request) => {
    seenRequests.push(request);
    const hasEvidence = JSON.stringify(request.state).includes('selected: <value:country>');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.95 : 0.1 },
      action: choice('select', { select: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('country', { country: 0.9, none: 0.05 }),
      option: choice('o2', { o1: 0.05, o2: 0.9, none: 0.05 }),
    });
  };
  const h = harness({ observations: { p1: [before, after] }, ask });
  const r = await h.call({
    goal: 'outcome-evidence redaction goal',
    steps: ['select Canada'],
    values: { country: 'Canada' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  for (const req of seenRequests) {
    assertNoValues(JSON.stringify(req), { country: 'Canada' });
  }
});

// ---- T-click-repeat: same button, url/title never change (WP-outcome-
// evidence widened signal, operator 2026-09-28: the-internet.herokuapp.com's
// "click Add Element twice" task — each click appends a Delete button, but
// the page's url and title never move, so a url+title-only signal reads the
// second click as a no-op and wrongly stops the task). ----

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

/** url and title never change across rounds — only elements.length and text
 * do, exactly like the real add_remove_elements fixture. */
function addElementsObs(n: number): Observation {
  const elements = [addButton()];
  for (let i = 0; i < n; i++) elements.push(deleteButton(i));
  return observation({ elements, text: `${n} delete button(s) present` });
}

/** Always proposes click on the Add Element button; `done` reads only
 * elements.length from the state text (>= 3 total elements = 2 successful
 * clicks landed), so it can only turn true once the SECOND click is actually
 * allowed to happen. */
function clickTwiceAsk(): JevAsk {
  return async (request) => {
    const stateStr = JSON.stringify((request.state as { text?: string }).text ?? '');
    const m = /(\d+) delete button/.exec(stateStr);
    const deleteCount = m ? Number(m[1]) : 0;
    return reply({
      ...baseNouls(),
      done: { type: 'noul', noul: deleteCount >= 2 ? 0.95 : 0.05 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
}

test('T-click-repeat: clicking the same button twice, page text/count changing, must NOT trip no-progress', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickTwiceAsk(),
  });
  const r = await h.callDo({ goal: 'click the Add Element button twice' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'both clicks must land — a same-url/title page change must not read as no-progress');
});

/** Clicking a button that truly does nothing — url, title, text, element
 * count and every element's own state stay identical round to round. */
function clickAsk(): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      done: { type: 'noul', noul: 0.05 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
}

test('T-click-no-progress: a repeated no-effect click ends fallback/no-progress, not budget-steps', async () => {
  const inert = observation({ elements: [addButton()], text: 'nothing happens' });
  const h = harness({ observations: { p1: [inert] }, ask: clickAsk(), config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } } });
  const r = await h.callDo({ goal: 'click the inert button' });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected no-progress, got reason ${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'the guard must stop the SECOND identical no-change click, not act it');
});

// ---- T-navigate-no-progress: navigate is targetless (no `el`), so on the
// unfixed loop outcomeSignal() returns undefined for it and isNoProgress
// never gets a `before`/`result` pair to compare — a stuck navigate repeats
// to budget-steps instead of tripping the guard. This is r6's Finding 2,
// reproduced live on a fresh-install task: 24 identical `navigate` acts
// ending `budget-steps`, never `no-progress` (bench-results/2026-09-28-r6/
// results.md Part 3 Finding 2). Fixed by giving navigate/back/reload a
// page-level before/result via pageSignal (no element). ----

/** Always proposes navigate to the same url binding; the observation never
 * changes (same url/title/text/element count), so a navigate that actually
 * landed somewhere new never happens here — this is the "stuck navigate"
 * shape, not a real one. */
function navigateAsk(): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.05 },
      action: choice('navigate', { navigate: 0.9, none: 0.05 }),
      url: choice('dest', { dest: 0.9, none: 0.05 }),
    });
}

test('T-navigate-no-progress: a repeated no-effect navigate ends fallback/no-progress, not budget-steps', async () => {
  const stuck = observation(); // url/title/text/element count never change — the navigate never lands anywhere new
  const h = harness({
    observations: { p1: [stuck] },
    ask: navigateAsk(),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({
    goal: 'outcome-evidence navigate no-progress goal',
    steps: ['open the destination page'],
    values: { dest: 'https://example.com/next' },
  });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected no-progress, got reason ${r.reason} after ${r.steps} steps`);
  assert.equal(r.step_review?.why, 'no-progress');
  const navActs = h.driver.actCalls().filter((a) => a.op === 'navigate');
  assert.equal(navActs.length, 1, 'the guard must stop the SECOND identical no-change navigate, not act it');
});

// ---- T-step-boundary: the SAME element+verb on two DIFFERENT chain steps
// must never read as no-progress (orchestrator decision, 2026-09-28, scope
// rule 1) — the guard compares against the last act only WITHIN the current
// step (chain clause index / the single implicit step of a non-chain call);
// a step advance resets it. Static fixture (url/title/text/elements.length
// never change), so without the fix this is indistinguishable from a real
// stuck repeat and would wrongly bounce on step two's first click. ----

/** One click per clause, using request.state.step to key a per-clause round
 * counter (same pattern as tests/chain.test.ts's t2Ask): round 1 of a clause
 * commits the click, round 2 advances. Both clauses target the same 'e1'. */
function twoStepSameElementAsk(): JevAsk {
  let lastStep = '';
  let seen = 0;
  return async (request) => {
    const step = (request.state as { step?: string }).step ?? '';
    if (step !== lastStep) {
      lastStep = step;
      seen = 0;
    }
    seen += 1;
    const answers = { ...baseNouls() };
    if (seen === 1) {
      answers.step_done = { type: 'noul', noul: 0.05 };
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 });
    } else {
      answers.step_done = { type: 'noul', noul: 0.95 };
    }
    return reply(answers);
  };
}

test('T-step-boundary: the same element+verb on two different chain steps ends done, not no-progress', async () => {
  const inert = observation({ elements: [addButton()], text: 'static page, never changes' });
  const h = harness({ observations: { p1: [inert] }, ask: twoStepSameElementAsk() });
  const r = await h.call({
    goal: 'outcome-evidence step-boundary goal',
    steps: ['click e1 for step one', 'click e1 for step two'],
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'both steps must click — a step advance must reset the no-progress guard');
});

// ---- T-recover-continue: an error+recover('continue') round is exempt from
// the no-progress guard outright (orchestrator decision, 2026-09-28, scope
// rule 2) — it falls through to the SAME normal decision (same verb+path, no
// observed change on this static fixture), and the existing recover
// mechanism (a probability-driven give-up, not the guard) owns when that
// stops. Proves the guard doesn't short-circuit recovery: two continues land
// their (otherwise identical) clicks, then a give-up ends real page-error —
// never no-progress. ----

function recoverContinueAsk(): JevAsk {
  let call = 0;
  return async () => {
    call += 1;
    const answers: Record<string, JevAnswer> = { ...baseNouls(), step_done: { type: 'noul', noul: 0.05 } };
    if (call === 1) {
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 });
    } else if (call === 2) {
      // error + recover 'continue' (0.8 >= THRESHOLDS.recover 0.6): falls
      // through to the SAME normal decision as call 1 — same verb+path, no
      // observed change on the static fixture.
      answers.error = { type: 'noul', noul: 0.9 };
      answers.recover = choice('continue', { continue: 0.8, back: 0.05 });
      answers.action = choice('click', { click: 0.9, none: 0.05 });
      answers.target = choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 });
    } else {
      // error again, but recover's own probability now misses the 0.6
      // threshold -> 'give-up' -> real page-error, independent of the guard.
      answers.error = { type: 'noul', noul: 0.9 };
      answers.recover = choice('continue', { continue: 0.3, back: 0.05 });
    }
    return reply(answers);
  };
}

test('T-recover-continue: continue retries land (exempt from no-progress); give-up still ends page-error', async () => {
  const inert = observation({ elements: [addButton()], text: 'static page, never changes' });
  const h = harness({ observations: { p1: [inert] }, ask: recoverContinueAsk() });
  const r = await h.call({ goal: 'outcome-evidence recover-continue goal', steps: ['click e1 repeatedly'] });
  assert.equal(r.status, 'error', `expected error, got ${r.status}/${r.reason} after ${r.steps} steps`);
  assert.equal(r.reason, 'page-error', `expected page-error (the give-up path), not no-progress`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'both the initial click and the continue-exempted retry must land');
});

// ---- WP-evidence: evidence-backed step_done bar (operator-approved tuning,
// 2026-09-28; THRESHOLDS.stepDoneWithEvidence in src/contract/constants.ts).
// Cloud round 7 (bench-results/2026-09-28-r7/results.md) showed step_done
// undershooting THRESHOLDS.stepDone (0.85) even after a verified fill/select
// outcome. runChainEarly's rule 3 now also advances at stepDoneWithEvidence
// (0.5) when the LAST history entry belongs to the CURRENT step, its verb is
// fill/select/check/uncheck, and its observed result confirms that verb's own
// end state. Click-family and any non-confirming result keep the 0.85 bar. ----

/** step_done reads only whether request.state's history carries a confirmed
 * `"result":"filled"` entry: 0.6 (inside the evidence tier, below the
 * ordinary 0.85 bar) once it does, 0.05 otherwise. `action` stays 'fill' on
 * both rounds (never 'none'), so the pre-existing stepDoneNoAction path can
 * never fire here — only the new evidence path can explain an advance. */
function evidenceAdvanceAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.6 : 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
}

test('WP-evidence-a: step_done 0.6 with a confirmed fill result advances (evidence-backed bar)', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask: evidenceAdvanceAsk() });
  const r = await h.call({
    goal: 'evidence bar goal',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'goal-met');
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1, 'only the first fill should act; the second round must advance on evidence, not repeat the fill');
});

/** Same shape as evidenceAdvanceAsk, but step_done never clears 0.4 — below
 * stepDoneWithEvidence (0.5) even once the fill result confirms. */
function evidenceBelowBarAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.4 : 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
}

test('WP-evidence-b: step_done 0.4 with a confirmed fill result does not advance (below the evidence bar)', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({
    observations: { p1: [unfilled, filled] },
    ask: evidenceBelowBarAsk(),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({
    goal: 'evidence bar goal below threshold',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.notEqual(r.status, 'done', `must not advance/finish on a 0.4 step_done, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected the no-progress guard to end this, got reason ${r.reason}`);
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 2, 'the first fill and its identical repeat both land; the guard — not evidence — stops the third');
});

/** Always proposes click on the Add Element button at stepDone 0.6 (inside
 * the evidence tier) — click is not an element-state verb, so hasStepEvidence
 * must never fire for it regardless of the 'page changed' result. */
function clickEvidenceAsk(): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
}

test('WP-evidence-c: click step at step_done 0.6 with a page-changed result advances on bare-click evidence, not hasStepEvidence', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2), addElementsObs(3)] },
    ask: clickEvidenceAsk(),
  });
  const r = await h.call({ goal: 'evidence click goal', steps: ['click the add element button'] });
  assert.equal(r.status, 'done', `expected done via WP-click bare-click evidence, got ${r.status}/${r.reason}`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'one page-changing click is the evidence; no further click lands');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.clickEvidence === true), 'the advance must come from the bare-click branch (clickEvidence telemetry)');
});

/** step_done sits at 0.6 (evidence tier) every round, but the fill never
 * takes — the observation script never flips filled to true, so the
 * observed result stays 'empty' and hasStepEvidence must read that as no
 * confirmation. */
function fillNoEvidenceAsk(): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
}

test('WP-evidence-d: fill step at step_done 0.6 with an unconfirmed (empty) result does not advance', async () => {
  const stillEmpty = observation();
  const h = harness({
    observations: { p1: [stillEmpty] },
    ask: fillNoEvidenceAsk(),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({
    goal: 'evidence unconfirmed fill goal',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.notEqual(r.status, 'done', `must not advance on an unconfirmed result, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress');
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1, 'the guard stops the second identical no-change fill before evidence ever has a confirming result to read');
});

/** Step 0 fills (confirmed 'filled', evidence present) and advances on the
 * ordinary 0.85 bar. Step 1 clicks: its first round proposes step_done 0.6
 * (evidence tier) — if hasStepEvidence ignored stepKey it would wrongly read
 * step 0's leftover 'filled' history entry as step 1's own evidence and
 * advance without ever clicking. Both steps key off request.state.step. */
function stepBoundaryEvidenceAsk(): JevAsk {
  const seen: Record<string, number> = {};
  return async (request) => {
    const step = (request.state as { step?: string }).step ?? '';
    seen[step] = (seen[step] ?? 0) + 1;
    const n = seen[step];
    if (step.includes('fill')) {
      if (n === 1) {
        return reply({
          ...baseNouls(),
          step_done: { type: 'noul', noul: 0.05 },
          action: choice('fill', { fill: 0.9, none: 0.05 }),
          target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
          value: choice('amount', { amount: 0.9, none: 0.05 }),
        });
      }
      // Advance step 0 on the ordinary bar, independent of the evidence path
      // under test at the step boundary below.
      return reply({ ...baseNouls(), step_done: { type: 'noul', noul: 0.95 } });
    }
    if (n === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.6 }, // evidence tier: must NOT read step 0's fill evidence
        action: choice('click', { click: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      });
    }
    return reply({ ...baseNouls(), step_done: { type: 'noul', noul: 0.95 } });
  };
}

test('WP-evidence-e: evidence from a previous step\'s act does not count for the next step', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask: stepBoundaryEvidenceAsk() });
  const r = await h.call({
    goal: 'evidence step-boundary goal',
    steps: ['fill the amount field', 'click the button'],
    values: { amount: '42' },
  });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(fillActs.length, 1);
  assert.equal(
    clickActs.length,
    1,
    "step 1's click must actually be acted — step 0's fill evidence must not spuriously advance step 1 at the evidence tier",
  );
});

// ---- WP-evidence-f/g/h: verifier fixes (2026-09-28) — wrong-option select,
// pre-filled fill, and multi-binding compound steps must never count as
// evidence. See hasStepEvidence and runChainEarly rule 3 in src/core/loop.ts. ----

/** Same shape as selectAsk() (T-select, above) but drives step_done into the
 * evidence tier (0.6) rather than the ordinary 0.95 bar, so only the new
 * evidence path — never the plain 0.85 bar — could explain an advance. */
function wrongOptionSelectAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"selected:');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.6 : 0.1 },
      action: choice('select', { select: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('country', { country: 0.9, none: 0.05 }),
      option: choice('o2', { o1: 0.05, o2: 0.9, none: 0.05 }),
    });
  };
}

test('WP-evidence-f: select landing on the WRONG option does not advance on the evidence bar (intended-option mismatch)', async () => {
  // The bound value asks for 'Canada' (intendedLabel), but the driver's
  // observed post-act state never leaves 'United States' — modeling a
  // select that silently landed on (or never left) the wrong option. The
  // OLD code (`result.startsWith('selected:')`) would have accepted this as
  // evidence; the fix requires the confirmed label to match the intended one.
  const before = observation({ elements: [selectEl('United States')] });
  const wrongAfter = observation({ elements: [selectEl('United States')] });
  const h = harness({ observations: { p1: [before, wrongAfter] }, ask: wrongOptionSelectAsk() });
  const r = await h.call({
    goal: 'evidence wrong-option goal',
    steps: ['select Canada'],
    values: { country: 'Canada' },
  });
  assert.notEqual(
    r.status,
    'done',
    `must not advance when the observed selection doesn't match the intended option, got ${r.status}/${r.reason}`,
  );
  assert.equal(r.reason, 'no-progress', `expected the no-progress guard to end this, got reason ${r.reason}`);
  const selectActs = h.driver.actCalls().filter((a) => a.op === 'select');
  assert.equal(selectActs.length, 1, 'the guard stops the second identical no-change select before evidence ever confirms the intended option');
});

/** step_done reads the same 'result':'filled' evidence flag as WP-evidence-a,
 * but the field is ALREADY filled in every scripted observation — including
 * the one taken BEFORE the act — so 'filled' never confirms this act did
 * anything. */
function preFilledFillAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.6 : 0.1 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
}

test('WP-evidence-g: a field already filled BEFORE the act does not advance on the evidence bar (pre-filled, not confirmed by this act)', async () => {
  const alreadyFilled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({
    observations: { p1: [alreadyFilled] },
    ask: preFilledFillAsk(),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({
    goal: 'evidence pre-filled goal',
    steps: ['fill the amount field'],
    values: { amount: '42' },
  });
  assert.notEqual(r.status, 'done', `must not treat a pre-filled field as fresh evidence, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected the no-progress guard to end this, got reason ${r.reason}`);
});

/** Always fills the 'name' binding on e1, never 'email' — the step names
 * both. step_done rides the evidence tier (0.6) once the fill confirms. */
function multiBindingAsk(): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.6 : 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('name', { name: 0.9, email: 0.05, none: 0.05 }),
    });
  };
}

test('WP-evidence-h: a compound step naming two bindings does not advance on the evidence bar after only the first fills', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask: multiBindingAsk() });
  const r = await h.call({
    goal: 'evidence multi-binding goal',
    steps: ['fill name and email'],
    values: { name: 'Jane', email: 'jane@x.com' },
  });
  assert.notEqual(
    r.status,
    'done',
    `must not advance on the evidence bar while the step names two bindings and only one is confirmed filled, got ${r.status}/${r.reason}`,
  );
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.ok(fillActs.length >= 1, 'at least the first (name) fill must land');
});

// ---- WP-count: deterministic repeat-count evidence (click-count dispatch,
// 2026-09-28). A step naming an explicit count ("click it twice") is its own
// evidence bar — Jev's stepDoneP/done Noul never fires reliably on a
// repeated click (see WP-evidence-c above), so a fixed, never-crossing
// stepDoneP is scripted throughout: if these tests only pass because the
// script eventually crosses THRESHOLDS.stepDone, they're not proving the
// count bar fired at all. ----

function addButton2(): ElementRecord {
  return el({
    id: 'e2',
    path: '#add2',
    tag: 'button',
    role: 'button',
    name: 'Add Element 2',
    type: 'button',
    editable: false,
    state: { disabled: false },
    fingerprint: { tag: 'button', role: 'button', name: 'Add Element 2', x: 0, y: 0 },
  });
}

/** Both buttons always present; only `text` varies round to round, so a
 * click on EITHER one registers as a page change (pageSignal picks up the
 * text hash) without needing the delete-button-count shape. */
function twoButtonsObs(n: number): Observation {
  return observation({ elements: [addButton(), addButton2()], text: `${n} clicks so far` });
}

/** Always proposes click on e1, at a FIXED step_done that never reaches
 * THRESHOLDS.stepDone (0.85) or THRESHOLDS.stepDoneWithEvidence — click is
 * never evidence-backed by hasStepEvidence either (click-family is excluded
 * there by design), so the ONLY way a chain call built on this ask can ever
 * advance is the repeat-count branch. */
function clickStepDoneAsk(fixedP: number): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: fixedP },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
}

/** Strictly alternates e1/e2 every round — never two consecutive rounds on
 * the same target, so the trailing contiguous run is always length 1. */
function alternatingTargetAsk(): JevAsk {
  let round = 0;
  return async () => {
    round += 1;
    const onE1 = round % 2 === 1;
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.3 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice(onE1 ? 'e1' : 'e2', {
        e1: onE1 ? 0.9 : 0.05,
        e2: onE1 ? 0.05 : 0.9,
        none: 0.02,
        ambiguous: 0.02,
      }),
    });
  };
}

test('WP-count-a: chain step "click the Add button twice" advances after exactly 2 clicks (count evidence, no threshold)', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-count goal a', steps: ['click the Add button twice'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'exactly 2 clicks must land — count evidence, not stepDoneP 0.3, must end the step');
});

test('WP-count-b: chain step "click the Add button 3 times" advances after exactly 3 clicks', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2), addElementsObs(3)] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 6 } },
  });
  const r = await h.call({ goal: 'WP-count goal b', steps: ['click the Add button 3 times'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 3, 'exactly 3 clicks must land — count evidence, not stepDoneP 0.3, must end the step');
});

test('WP-count-c: a step with no count word never advances on count evidence (falls back to the ordinary stepDone bar)', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 3 } },
  });
  const r = await h.call({ goal: 'WP-count goal c', steps: ['click the Add button'] });
  assert.notEqual(r.status, 'done', `no count word in the step must never trigger a count-evidence advance, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'step-uncertain', `expected the WP-click repeat guard to hand back (no count, stepDoneP 0.3 < 0.5), got ${r.reason}`);
  assert.equal(r.step_review?.why, 'repeat');
});

test('WP-count-d: clicks that produce no visible change do not count toward the repeat count', async () => {
  const inert = observation({ elements: [addButton()], text: 'nothing happens' });
  const h = harness({
    observations: { p1: [inert] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-count goal d', steps: ['click the Add button twice'] });
  assert.notEqual(r.status, 'done', `a click with no observed page change must never satisfy the repeat count, got ${r.status}/${r.reason}`);
});

test('WP-count-e: two clicks on DIFFERENT targets for a "twice" step do not satisfy the count', async () => {
  const h = harness({
    observations: { p1: [twoButtonsObs(0), twoButtonsObs(1), twoButtonsObs(2), twoButtonsObs(3)] },
    ask: alternatingTargetAsk(),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 3 } },
  });
  const r = await h.call({
    goal: 'WP-count goal e',
    steps: ['click the Add button twice'],
    values: {},
  });
  assert.notEqual(r.status, 'done', `clicks on two different targets must never satisfy a "twice" step, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'budget-steps', `expected budget-steps (count never satisfied across targets), got ${r.reason}`);
});

test('WP-count-f: legacy/single browse_step "click the Add button twice" ends done/goal-met after exactly 2 clicks', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-count goal f', step: 'click the Add button twice' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  assert.equal(r.reason, 'goal-met');
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'exactly 2 clicks must land — count evidence, not the whole-goal done Noul, must end the call');
});

test('parseRepeatCount: explicit count words, digit/word "N times", and ambiguity', () => {
  assert.equal(parseRepeatCount('click it once'), 1);
  assert.equal(parseRepeatCount('click it twice'), 2);
  assert.equal(parseRepeatCount('click it thrice'), 3);
  assert.equal(parseRepeatCount('click it 3 times'), 3);
  assert.equal(parseRepeatCount('click it three times'), 3);
  assert.equal(parseRepeatCount('click it twice, then submit 2 times'), undefined, 'more than one count expression is ambiguous');
  assert.equal(parseRepeatCount('click it at times'), undefined, '"at" is not a count word');
  assert.equal(parseRepeatCount('click it 51 times'), undefined, 'out of the 1..50 digit range');
});

// ---- WP-click (r10): bare-click evidence + same-target repeat guard. A
// count-less click step advances (chain) / ends done (legacy) after ONE
// click that visibly changed the page, once stepDoneP/done >= 0.5
// (THRESHOLDS.stepDoneWithEvidence); below that bar, picking the SAME
// target again hands back why 'repeat' instead of over-clicking. ----

/** Legacy browse_step reads the `done` noul, not step_done: same shape as
 * clickStepDoneAsk but with `done` fixed. */
function clickDoneAsk(fixedP: number): JevAsk {
  return async () =>
    reply({
      ...baseNouls(),
      done: { type: 'noul', noul: fixedP },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
}

test('WP-click-a: chain step "click the Add button" (no count) advances after exactly 1 page-changing click at stepDoneP 0.55', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1)] },
    ask: clickStepDoneAsk(0.55),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-click goal a', steps: ['click the Add button'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'exactly 1 click must land — one observed page change is the evidence');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.clickEvidence === true), 'clickEvidence telemetry must be set on the advancing round');
});

test('WP-click-b: chain step "click the Add button" (no count) hands back why repeat when the same target is picked again below the evidence bar', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickStepDoneAsk(0.3),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-click goal b', steps: ['click the Add button'] });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason} after ${r.steps} steps`);
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'repeat');
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'only the first click lands; the guard bounces the same-target repeat');
});

test('WP-click-c: a step WITH a count word still uses count evidence, not bare-click evidence (2 clicks, not 1)', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2)] },
    ask: clickStepDoneAsk(0.55),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-click goal c', steps: ['click the Add button twice'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 2, 'a "twice" step must not be cut short at 1 click by bare-click evidence');
});

test('WP-click-d: bare-click evidence does not fire when the click produced no visible change', async () => {
  const inert = observation({ elements: [addButton()], text: 'nothing happens' });
  const h = harness({
    observations: { p1: [inert] },
    ask: clickStepDoneAsk(0.55),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-click goal d', steps: ['click the Add button'] });
  assert.notEqual(r.status, 'done', `a click with no observed page change must never advance on bare-click evidence, got ${r.status}/${r.reason}`);
});

test('WP-click-e: a fill step at stepDoneP 0.55 still advances via hasStepEvidence, never via bare-click evidence', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const ask: JevAsk = async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: hasEvidence ? 0.55 : 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
  const h = harness({ observations: { p1: [unfilled, filled] }, ask });
  const r = await h.call({ goal: 'WP-click goal e', steps: ['fill the Amount field'], values: { amount: '42' } });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const fillActs = h.driver.actCalls().filter((a) => a.op === 'fill');
  assert.equal(fillActs.length, 1);
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.every((rd) => rd.clickEvidence === undefined), 'a fill advance must never be attributed to bare-click evidence');
});

test('WP-click-f: legacy/single browse_step "click the Add button" (no count) ends done/goal-met after exactly 1 click at done 0.55', async () => {
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1)] },
    ask: clickDoneAsk(0.55),
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'WP-click goal f', step: 'click the Add button' });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason} after ${r.steps} steps`);
  assert.equal(r.reason, 'goal-met');
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'exactly 1 click must land — one observed page change is the evidence');
});

// ---- readyP threshold (r10: THRESHOLDS.ready 0.5 -> 0.3) ----

function readyAsk(readyP: number): JevAsk {
  return async (request) => {
    const hasEvidence = JSON.stringify(request.state).includes('"result":"filled"');
    return reply({
      ...baseNouls(),
      ready: { type: 'noul', noul: readyP },
      step_done: { type: 'noul', noul: hasEvidence ? 0.95 : 0.05 },
      action: choice('fill', { fill: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      value: choice('amount', { amount: 0.9, none: 0.05 }),
    });
  };
}

test('readyP 0.4 (>= 0.3) proceeds: a chain call does not bounce not-ready', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask: readyAsk(0.4) });
  const r = await h.call({ goal: 'ready goal proceeds', steps: ['fill the amount field'], values: { amount: '42' } });
  assert.notEqual(r.step_review?.why, 'not-ready', `readyP 0.4 must clear the 0.3 ready bar, got ${r.status}/${r.reason}`);
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  assert.equal(h.driver.actCalls().filter((a) => a.op === 'fill').length, 1);
});

test('readyP 0.2 (< 0.3) still waits, then bounces not-ready', async () => {
  const h = harness({ observations: { p1: [observation()] }, ask: readyAsk(0.2) });
  const r = await h.call({ goal: 'ready goal bounces', steps: ['fill the amount field'], values: { amount: '42' } });
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'step-uncertain');
  assert.equal(r.step_review?.why, 'not-ready');
  assert.equal(h.driver.actCalls().filter((a) => a.op === 'fill').length, 0, 'a not-ready round never acts on the step');
});

// ---- step_text telemetry redaction (r10) ----

test('log redaction: step_text and step_texts_start carry the redacted step, never the bound value', async () => {
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const secret = '4242';
  for (const input of [
    { goal: 'log redaction chain goal', steps: [`fill the Amount field with ${secret}`], values: { amount: secret } },
    { goal: 'log redaction legacy goal', step: `fill the Amount field with ${secret}`, values: { amount: secret } },
  ]) {
    const h = harness({ observations: { p1: [unfilled, filled] }, ask: readyAsk(0.95) });
    await h.call(input);
    assert.equal(h.records.length, 1);
    const record = h.records[0];
    const rounds = record.phases?.rounds ?? [];
    assert.ok(rounds.length > 0);
    const stepText = rounds[0].step_text;
    assert.ok(stepText !== undefined, 'browse_step rounds carry step_text');
    assert.ok(!stepText.includes(secret), `step_text leaked the bound value: ${stepText}`);
    assert.ok(stepText.includes('<value:amount>'), `step_text should carry the redaction token: ${stepText}`);
    if ('steps' in input) {
      assert.ok(record.step_texts_start !== undefined, 'chain mode records step_texts_start');
      assert.ok(!record.step_texts_start.includes(secret), `step_texts_start leaked the bound value: ${record.step_texts_start}`);
    } else {
      assert.equal(record.step_texts_start, undefined, 'legacy mode has no step_texts_start');
    }
    assertNoValues(JSON.stringify(record), { amount: secret });
  }
});

// ---- r11 WP-B: wait-storm evidence fix (§ r11 Q3). A `wait` (or any
// signal-less act) history entry carries `before === undefined`; the evidence
// functions used to read/break on the literal tail, so a wait after a working
// click shadowed its evidence for the rest of the call. `lastEvidenceEntry`
// now reads through signal-less entries, and 'element gone' (the acted
// element re-rendered away) counts as click-family evidence. ----

/** A clickable fixture distinct from the form `el()` — the Start button. */
function startButton(): ElementRecord {
  return el({
    id: 'e1',
    path: '#start',
    tag: 'button',
    role: 'button',
    name: 'Start',
    type: 'button',
    editable: false,
    state: { disabled: false },
    fingerprint: { tag: 'button', role: 'button', name: 'Start', x: 0, y: 0 },
  });
}

function startObs(withStart: boolean, text: string): Observation {
  return observation({ elements: withStart ? [startButton()] : [], text });
}

test('T-wait-shadow: a click whose target re-renders away, followed by a wait answer, ends done — never storms', async () => {
  // clickedGone drops the scripted target element (re-render), rendered adds a
  // text change. r1 commits click→e1; r2 answers wait + step_done 0.6 (the
  // evidence tier). On the fixed loop r2's advance rule reads THROUGH the
  // would-be wait slot: 'element gone' is click evidence, so the clause
  // advances on r2 and the scripted wait answer never reaches the act site —
  // there is no third ask and no wait storm. (The spec's "exactly 1 wait act"
  // clause is unreachable as written: rule 3 advances before the decide step,
  // so a decided wait can never land on a round that also carries the
  // evidence-tier step_done; the checklist-pinned invariant
  // `requests.length === 2` is the assertion kept here.)
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.05 },
        action: choice('click', { click: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 },
      action: choice('wait', { wait: 0.9, none: 0.05 }),
      target: choice('none', { none: 0.9, e1: 0.05 }),
    });
  };
  const h = harness({
    observations: { p1: [startObs(true, 'loading'), startObs(false, 'loading'), startObs(false, 'Hello World')] },
    ask,
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'wait-shadow storm goal', steps: ['click the Start button'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.filter((a) => a.op === 'click').length, 1, 'exactly 1 click');
  assert.equal(
    acts.filter((a) => a.op === 'wait').length,
    0,
    'the r2 advance precedes the decide step — the scripted wait answer is consumed, never acted',
  );
  assert.equal(h.requests.length, 2, 'no extra asks burned past the advancing round');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.clickEvidence === true), 'the advance came from bare-click evidence on the element-gone click');
});

test('T-element-gone-click: an element-gone click result counts as click evidence at the 0.5 bar', async () => {
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.05 },
        action: choice('click', { click: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 }, // evidence tier — below the ordinary 0.85 bar
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const h = harness({
    observations: { p1: [startObs(true, 'loading'), startObs(false, 'loading')] },
    ask,
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'element-gone click goal', steps: ['click the Start button'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const clickActs = h.driver.actCalls().filter((a) => a.op === 'click');
  assert.equal(clickActs.length, 1, 'one element-gone click is the evidence; no second click lands');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.clickEvidence === true), 'clickEvidence telemetry must be set on the advancing round');
});

test('T-wait-transparency-state: a wait act between a fill and its confirm round still advances on the fill evidence', async () => {
  // r1 commits fill→e1; r2 decides wait at step_done 0.3 (below every advance
  // bar, so the wait ACTUALLY LANDS — its history entry carries
  // `before === undefined`); r3 sits at the evidence tier (0.6). The fill's
  // 'filled' result is annotated from r2's fresh obs and remains the last
  // SIGNAL-CARRYING entry behind the wait, so r3 advances on fill evidence —
  // this is the hasStepEvidence path through lastEvidenceEntry's skip that
  // T-wait-shadow cannot reach (its advance fires before the decide step, so
  // its scripted wait never lands). Without the skip the r3 tail is the wait
  // entry itself, 'wait' is no element-state verb, and the call never ends
  // done.
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.05 },
        action: choice('fill', { fill: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
        value: choice('amount', { amount: 0.9, none: 0.05 }),
      });
    }
    if (call === 2) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.3 }, // below every bar: the wait lands
        action: choice('wait', { wait: 0.9, none: 0.05 }),
        target: choice('none', { none: 0.9, e1: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 }, // evidence tier — below the ordinary 0.85 bar
      // action 'click' deliberately NOT 'none': stepDoneNoAction 0.5 would
      // advance an action-none round without any evidence at all, making the
      // test inert.
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const unfilled = observation();
  const filled = observation({ elements: [el({ state: { disabled: false, filled: true } })] });
  const h = harness({ observations: { p1: [unfilled, filled] }, ask });
  const r = await h.call({ goal: 'wait transparency fill goal', steps: ['fill the amount field'], values: { amount: '42' } });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.filter((a) => a.op === 'fill').length, 1, 'exactly 1 fill — the call must not re-fill');
  assert.equal(acts.filter((a) => a.op === 'wait').length, 1, 'the wait act must land — without it there is no shadow to read through');
  assert.equal(acts.length, 2, 'fill + wait and nothing else');
});

test('T-wait-shadow-landed: a landed wait after an element-gone click does not shadow the click evidence', async () => {
  // The bench storm verbatim: click Start → the button re-renders away
  // ('element gone' on the click entry) → the next act is a wait whose entry
  // carries no `before` → on the unfixed loop that wait entry shadows the
  // click's evidence for the rest of the call, so evidence-tier step_done
  // answers drain into a no-match bounce instead of advancing. r2's wait
  // decides at 0.3 (below every bar — it lands); r3 sits at 0.6 (evidence
  // tier). With the fix, lastEvidenceEntry reads through the wait entry to
  // the 'element gone' click — both halves of Q3 in one round — and the call
  // ends done.
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.05 },
        action: choice('click', { click: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      });
    }
    if (call === 2) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.3 }, // below every bar: the wait lands
        action: choice('wait', { wait: 0.9, none: 0.05 }),
        target: choice('none', { none: 0.9, e1: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.6 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const h = harness({
    observations: { p1: [startObs(true, 'loading'), startObs(false, 'loading'), startObs(false, 'Hello World'), startObs(false, 'Hello World')] },
    ask,
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'wait-shadow landed wait goal', steps: ['click the Start button'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.filter((a) => a.op === 'click').length, 1, 'exactly 1 click');
  assert.equal(acts.filter((a) => a.op === 'wait').length, 1, 'the wait act must land — without it the shadow case is never created');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.clickEvidence === true), 'the advance came from bare-click evidence read through the wait entry');
});

test('T-repeatcount-wait: a landed wait between two same-target clicks does not break the trailing-run count', async () => {
  // r1 click, r2 a decided wait (low step_done — below every advance bar, so
  // the wait DOES reach the act site here), r3 click, r4 low step_done. The
  // wait entry is signal-less and must be SKIPPED by the count walk, not
  // break it: the two 'page changed' clicks on e1 satisfy the count at r4.
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 2) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.3 },
        action: choice('wait', { wait: 0.9, none: 0.05 }),
        target: choice('none', { none: 0.9, e1: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.3 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const h = harness({
    observations: { p1: [addElementsObs(0), addElementsObs(1), addElementsObs(2), addElementsObs(3), addElementsObs(4)] },
    ask,
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'repeatcount wait goal', steps: ['click the Add button twice'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  const acts = h.driver.actCalls();
  assert.equal(acts.filter((a) => a.op === 'click').length, 2, 'exactly 2 clicks land');
  assert.equal(acts.filter((a) => a.op === 'wait').length, 1, 'the scripted wait landed between the clicks');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.countEvidence === 2), 'countEvidence === 2 on the advancing round');
});

test('T-repeatcount-element-gone: an element-gone click satisfies a count clause (count walk, count=1)', async () => {
  // 'click the Start button once' parses to count 1, so bareClickEvidence is
  // gated off (repeatCount !== undefined) and the ONLY advance path is
  // hasRepeatCountEvidence's own 'element gone' acceptance — nothing else in
  // the suite covers that arm (T-decompose-twice exercises 'page changed').
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 1) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.05 },
        action: choice('click', { click: 0.9, none: 0.05 }),
        target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.3 }, // irrelevant: the count bar ignores step_done
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const h = harness({
    observations: { p1: [startObs(true, 'loading'), startObs(false, 'loading'), startObs(false, 'loading')] },
    ask,
    config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } },
  });
  const r = await h.call({ goal: 'repeatcount element gone goal', steps: ['click the Start button once'] });
  assert.equal(r.status, 'done', `expected done, got ${r.status}/${r.reason}`);
  assert.equal(h.driver.actCalls().filter((a) => a.op === 'click').length, 1, 'one element-gone click satisfies the count');
  const rounds = h.records[0].phases?.rounds ?? [];
  assert.ok(rounds.some((rd) => rd.countEvidence === 1), 'countEvidence === 1 on the advancing round');
});

test('T-no-progress-unchanged: a wait between two identical no-effect clicks leaves the literal-tail guard semantics intact', async () => {
  // The guard reads ONLY the literal last history entry (deliberate asymmetry
  // — a wait may itself change the page). Round 2's wait therefore makes round
  // 3's repeat click the "literal tail ≠ same verb" case: the click lands. On
  // round 4 the tail IS the second identical no-change click, so the guard
  // fires exactly as it would with no wait in between — neither stricter nor
  // looser.
  let call = 0;
  const ask: JevAsk = async () => {
    call += 1;
    if (call === 2) {
      return reply({
        ...baseNouls(),
        step_done: { type: 'noul', noul: 0.3 },
        action: choice('wait', { wait: 0.9, none: 0.05 }),
        target: choice('none', { none: 0.9, e1: 0.05 }),
      });
    }
    return reply({
      ...baseNouls(),
      step_done: { type: 'noul', noul: 0.3 },
      action: choice('click', { click: 0.9, none: 0.05 }),
      target: choice('e1', { e1: 0.9, none: 0.05, ambiguous: 0.05 }),
    });
  };
  const inert = observation({ elements: [addButton()], text: 'nothing happens' });
  const h = harness({ observations: { p1: [inert] }, ask, config: { budgets: { ...DEFAULT_BUDGETS, max_steps: 5 } } });
  const r = await h.call({ goal: 'no-progress wait asymmetry goal', steps: ['click the Add button'] });
  const acts = h.driver.actCalls();
  assert.equal(acts.filter((a) => a.op === 'click').length, 2, 'the second identical click still lands past the wait');
  assert.equal(acts.filter((a) => a.op === 'wait').length, 1);
  // The deterministic end: r4's identical click decision meets the literal
  // tail = click2 ('no visible change', same path+verb+step) → no-progress.
  assert.equal(r.status, 'fallback', `expected fallback, got ${r.status}/${r.reason}`);
  assert.equal(r.reason, 'no-progress', `expected the guard to end it, got ${r.reason}`);
});
