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
import { runStep, runDo, type LoopDeps } from '../src/core/loop.js';
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
    writeLog: async () => {},
  };
  return {
    driver,
    requests,
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
