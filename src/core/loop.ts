// Run loop and security boundary (§ WP-C7).
// The round decision rule is § 3.7, implemented exactly, in order.
// Security invariants proven by tests/boundary.test.ts: binding values are
// redacted before any ask, URLs leave without query string or fragment, the
// sensitive-surface policy runs before every ask, irreversible actions need a
// confirm token, and the log record never carries page content.

import {
  LABEL_MAX,
  SETTLE_MAX_MS,
  THRESHOLDS,
  TIME_FLOOR_MS,
  TWO_STAGE,
} from '../contract/constants.js';
import type {
  CheckInput,
  DialogEvent,
  DoInput,
  Driver,
  ElementRecord,
  Fingerprint,
  JevAsk,
  JevChoiceAnswer,
  JevRequest,
  JevResult,
  LockCheckResult,
  Mode,
  Observation,
  Op,
  Reason,
  Status,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../contract/types.js';
import { OPS } from '../contract/types.js';
import {
  ActFailedError,
  AttachError,
  CoveredTargetError,
  DialogOpenError,
  StaleElementError,
} from '../contract/errors.js';
import { evaluatePolicy } from './policy.js';
import { gateHeuristic } from './gate.js';
import { gateModeOf, policyModeOf, takeoverOf } from './config.js';
import { ConfirmTokenStore, type PendingAction } from './tokens.js';
import { redactDeep, redactValues } from './withhold.js';
import {
  buildCheckRequest,
  buildGroupRequest,
  buildOptionFinalRequest,
  buildOptionRequests,
  buildRoutingRequest,
  buildRoundRequest,
  buildTargetRequest,
  elementCriterion,
} from './questions.js';
import { registrableDomain } from './etld.js';

export interface LoopDeps {
  config: WingmanConfig;
  driverFactory: (config: WingmanConfig) => Driver;
  resolveEndpoint: () => Promise<string | null>;
  ask: JevAsk | null; // null means no key
  lockCheck?: () => Promise<LockCheckResult>;
  mutex: { tryAcquire(): boolean; release(): void };
  tokens: ConfirmTokenStore;
  writeLog: (r: WingmanLogRecord) => Promise<void>;
  now?: () => number;
  forceMode?: Mode;
}

type Answer = JevChoiceAnswer | { type: 'noul'; noul: number };
type AnswerMap = Record<string, Answer>;

const BINDING_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Result-text steering (2026-09-21): a wingman_do run that ends for any reason
// other than done carries this static line so the calling model re-calls the
// tool instead of finishing the goal with raw browser tools. Static text only —
// no page content, so the egress rules are unaffected.
export const CONTINUE_LINE =
  'Goal not finished — call wingman_do again with the same goal (and the same values) to continue from here. Do not switch to raw browser tools.';

// § 3.17 browse_step static result notes, appended by finish() per tool.
// Static text only — never page content, so the egress rules are unaffected.
export const BROWSE_STEP_CALLER_LINE =
  'Step returned to you — do this step with your browser tools, then call browse_step again with the same goal and your next proposed step.';
export const BROWSE_STEP_OFFER_LINE =
  'Takeover available — call browse_step again with the same arguments and takeover: true to accept, or do the step with your browser tools.';
export const BROWSE_STEP_RESUME_LINE =
  'Takeover paused — call browse_step again with the same goal (and the same values) to continue from here.';

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** § 3.11 wingman_do schema plus the binding-name pattern. */
export function validateDoInput(x: unknown): { ok: true; input: DoInput } | { ok: false } {
  if (!isPlainObject(x)) return { ok: false };
  const o = x as Record<string, unknown>;
  const allowed = new Set(['goal', 'values', 'url_match', 'confirm_token', 'max_steps', 'max_ms']);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) return { ok: false };
  }
  if (typeof o.goal !== 'string' || o.goal.length > 500) return { ok: false };
  if (o.values !== undefined) {
    if (!isPlainObject(o.values)) return { ok: false };
    const entries = Object.entries(o.values);
    if (entries.length > 20) return { ok: false };
    for (const [name, value] of entries) {
      if (!BINDING_RE.test(name)) return { ok: false };
      if (typeof value !== 'string' || value.length > 2000) return { ok: false };
    }
  }
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false };
  }
  if (o.confirm_token !== undefined && (typeof o.confirm_token !== 'string' || o.confirm_token.length > 64)) {
    return { ok: false };
  }
  if (o.max_steps !== undefined) {
    const maxStepsRaw = o.max_steps;
    if (typeof maxStepsRaw !== 'number' || !Number.isInteger(maxStepsRaw) || maxStepsRaw < 1 || maxStepsRaw > 8) {
      return { ok: false };
    }
  }
  if (o.max_ms !== undefined) {
    const maxMsRaw = o.max_ms;
    if (typeof maxMsRaw !== 'number' || !Number.isInteger(maxMsRaw) || maxMsRaw < 1000 || maxMsRaw > 50000) {
      return { ok: false };
    }
  }
  return { ok: true, input: o as unknown as DoInput };
}

/** § 3.11 wingman_check schema. */
export function validateCheckInput(x: unknown): { ok: true; input: CheckInput } | { ok: false } {
  if (!isPlainObject(x)) return { ok: false };
  const o = x as Record<string, unknown>;
  const allowed = new Set(['question', 'url_match']);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) return { ok: false };
  }
  if (typeof o.question !== 'string' || o.question.length > 300) return { ok: false };
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false };
  }
  return { ok: true, input: o as unknown as CheckInput };
}

/** § 3.17 browse_step schema plus the binding-name pattern. */
export interface StepInput {
  goal: string;
  step?: string;
  steps?: string[];
  values?: Record<string, string>;
  url_match?: string;
  confirm_token?: string;
  takeover?: boolean;
  max_steps?: number;
  max_ms?: number;
}

/** § 3.17 browse_step validation: the validateDoInput rules where they
 * overlap, plus goal required, exactly one of step/steps, steps 2–3 non-empty
 * strings ≤ 300, takeover boolean, max_steps 1–24 (the C27 config ceiling,
 * not wingman_do's 8), max_ms 1000–50000. */
export function validateStepInput(x: unknown): { ok: true; input: StepInput } | { ok: false } {
  if (!isPlainObject(x)) return { ok: false };
  const o = x as Record<string, unknown>;
  const allowed = new Set([
    'goal', 'step', 'steps', 'values', 'url_match', 'confirm_token', 'takeover', 'max_steps', 'max_ms',
  ]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) return { ok: false };
  }
  if (typeof o.goal !== 'string' || o.goal.length > 500) return { ok: false };
  const hasStep = o.step !== undefined;
  const hasSteps = o.steps !== undefined;
  if (hasStep === hasSteps) return { ok: false };
  if (hasStep) {
    if (typeof o.step !== 'string' || o.step.length < 1 || o.step.length > 300) return { ok: false };
  } else {
    if (!Array.isArray(o.steps) || o.steps.length < 2 || o.steps.length > 3) return { ok: false };
    for (const s of o.steps) {
      if (typeof s !== 'string' || s.length < 1 || s.length > 300) return { ok: false };
    }
  }
  if (o.values !== undefined) {
    if (!isPlainObject(o.values)) return { ok: false };
    const entries = Object.entries(o.values);
    if (entries.length > 20) return { ok: false };
    for (const [name, value] of entries) {
      if (!BINDING_RE.test(name)) return { ok: false };
      if (typeof value !== 'string' || value.length > 2000) return { ok: false };
    }
  }
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false };
  }
  if (o.confirm_token !== undefined && (typeof o.confirm_token !== 'string' || o.confirm_token.length > 64)) {
    return { ok: false };
  }
  if (o.takeover !== undefined && typeof o.takeover !== 'boolean') return { ok: false };
  if (o.max_steps !== undefined) {
    const maxStepsRaw = o.max_steps;
    if (typeof maxStepsRaw !== 'number' || !Number.isInteger(maxStepsRaw) || maxStepsRaw < 1 || maxStepsRaw > 24) {
      return { ok: false };
    }
  }
  if (o.max_ms !== undefined) {
    const maxMsRaw = o.max_ms;
    if (typeof maxMsRaw !== 'number' || !Number.isInteger(maxMsRaw) || maxMsRaw < 1000 || maxMsRaw > 50000) {
      return { ok: false };
    }
  }
  return { ok: true, input: o as unknown as StepInput };
}

function capLabel(s: string): string {
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s;
}

/** § 3.5 fingerprint rule: stale when tag, role or name differ, or |Δ| > 64 px. */
function fingerprintMatches(fresh: Fingerprint, pending: Fingerprint): boolean {
  return (
    fresh.tag === pending.tag &&
    fresh.role === pending.role &&
    fresh.name === pending.name &&
    Math.abs(fresh.x - pending.x) <= 64 &&
    Math.abs(fresh.y - pending.y) <= 64
  );
}

/** § 3.7 rule 7 fit check. */
function opFits(verb: Op, el: ElementRecord): boolean {
  switch (verb) {
    case 'fill':
      return el.editable;
    case 'select':
      return el.tag === 'select';
    case 'check':
    case 'uncheck':
      return el.role === 'checkbox' || el.role === 'radio' || el.role === 'switch';
    case 'press':
      return el.editable || el.role === 'button';
    default:
      return true; // click and scroll fit anything
  }
}

/** The ask never sees the query string or the fragment (egress rule). */
function scrubUrl(u: string): string {
  const parsed = new URL(u);
  return parsed.origin + parsed.pathname;
}

/** Confirm-token URL comparison: origin + pathname + search. */
function urlKey(u: string): string {
  const parsed = new URL(u);
  return parsed.origin + parsed.pathname + parsed.search;
}

function safeHost(u: string): string {
  try {
    return registrableDomain(new URL(u).hostname);
  } catch {
    return '';
  }
}

function askFailReason(r: { error: string }): Reason {
  if (r.error === 'no-key') return 'no-key';
  if (r.error === 'circuit-open') return 'breaker-open';
  return 'jev-error';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Outcome of the native-select option requests (§ 3.6 / § 3.7 rule 8). */
type OptionOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'no-value' }
  | { kind: 'budget-time' }
  | { kind: 'ask-failed'; error: string };

async function runTool(
  tool: 'wingman_do' | 'wingman_check' | 'browse_step',
  input: unknown,
  deps: LoopDeps,
): Promise<WingmanResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const mode: Mode = deps.forceMode ?? deps.config.mode;
  const acc = {
    jevCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    gateHits: 0,
    would: undefined as WingmanLogRecord['would'],
  };
  const dialogEvents: DialogEvent[] = [];
  let steps = 0;
  let lastAction: { verb: Op; label: string } | undefined;
  let pageUrl: string | null = null;

  // Per-phase wall-time capture (ms). Numbers only — never page text.
  // `cur` is the round bucket the current ask/act/settle belongs to.
  type PhaseRound = { observeMs: number; jevMs: number; actMs: number; settleMs: number };
  const phaseAcc: {
    attachMs?: number;
    firstObserveMs?: number;
    rounds: PhaseRound[];
  } = { rounds: [] };
  let cur: PhaseRound | null = null;
  const beginRound = (): PhaseRound => {
    const round: PhaseRound = { observeMs: 0, jevMs: 0, actMs: 0, settleMs: 0 };
    phaseAcc.rounds.push(round);
    cur = round;
    return round;
  };
  /** Timed observe: fills the current round's observeMs and, once, firstObserveMs. */
  const observeTimed = async (pageId: string): Promise<Observation> => {
    const t = now();
    const obs = await driver!.observe(pageId);
    const ms = now() - t;
    if (cur) cur.observeMs += ms;
    if (phaseAcc.firstObserveMs === undefined) phaseAcc.firstObserveMs = ms;
    return obs;
  };

  const mk = (status: Status, reason: Reason, extra: Partial<WingmanResult> = {}): WingmanResult => ({
    status,
    reason,
    steps,
    ...(lastAction ? { last_action: { verb: lastAction.verb, label: lastAction.label } } : {}),
    ...extra,
    cost: {
      jev_calls: acc.jevCalls,
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
      ms: now() - startedAt,
    },
    labels_untrusted: true,
  });

  // Exactly one log record per call; log errors never mask the tool result.
  // The continuation note is appended here (the single return path) so it is
  // the last field of the serialized result: for needs_confirmation the
  // pending/confirm_token fields stay primary, ahead of it.
  const finish = async (r: WingmanResult): Promise<WingmanResult> => {
    if (tool === 'wingman_do' && r.status !== 'done') {
      r.note = CONTINUE_LINE;
    } else if (tool === 'browse_step' && r.status !== 'done') {
      // § 3.17 note table: done carries no note; route-caller and
      // route-unclear the caller line; takeover-offered the offer line;
      // every other non-done status the resume line.
      r.note =
        r.reason === 'route-caller' || r.reason === 'route-unclear'
          ? BROWSE_STEP_CALLER_LINE
          : r.reason === 'takeover-offered'
            ? BROWSE_STEP_OFFER_LINE
            : BROWSE_STEP_RESUME_LINE;
    }
    try {
      await deps.writeLog(buildLogRecord(r));
    } catch {
      // ignore
    }
    return r;
  };

  function buildLogRecord(r: WingmanResult): WingmanLogRecord {
    return {
      ts: new Date(now()).toISOString(),
      tool,
      mode,
      adapter: deps.config.adapter,
      status: r.status,
      reason: r.reason,
      steps: r.steps,
      host: pageUrl ? safeHost(pageUrl) : '',
      gate_hits: acc.gateHits,
      jev_calls: r.cost.jev_calls,
      input_tokens: r.cost.input_tokens,
      output_tokens: r.cost.output_tokens,
      ms: r.cost.ms,
      ...(acc.would ? { would: acc.would } : {}),
      phases: {
        ...(phaseAcc.attachMs !== undefined ? { attachMs: phaseAcc.attachMs } : {}),
        ...(phaseAcc.firstObserveMs !== undefined ? { firstObserveMs: phaseAcc.firstObserveMs } : {}),
        rounds: phaseAcc.rounds,
      },
    };
  }

  /** One ask that counts toward cost; enforces the timeout pin. Time-floor checks sit at the call sites. */
  async function askWithCost(
    request: JevRequest,
    purpose: 'wingman_do' | 'wingman_check' | 'browse_step',
    remaining: () => number,
  ): Promise<JevResult> {
    acc.jevCalls += 1;
    const tAsk = now();
    const r = await (deps.ask as JevAsk)(request, {
      purpose,
      timeoutMs: Math.min(deps.config.budgets.jev_timeout_ms, remaining() - 500),
    });
    if (cur) cur.jevMs += now() - tAsk;
    if (r.ok) {
      acc.inputTokens += r.usage.inputTokens;
      acc.outputTokens += r.usage.outputTokens;
    }
    return r;
  }

  function buildState(
    obs: Observation,
    history: Array<{ verb: Op; label: string }>,
    goal: string | null,
    values: Record<string, string>,
    step?: string,
  ): object {
    const raw: Record<string, unknown> = {
      url: scrubUrl(obs.url),
      title: obs.title,
      text: obs.text,
      truncated: obs.truncated,
    };
    if (goal !== null) {
      raw.goal = goal;
      raw.history = history.map((h) => ({ verb: h.verb, label: h.label }));
    }
    // § 3.19 flow item 4: round 1 of a takeover entry carries the proposed
    // step text (already redacted and cut to 300 by the caller); rounds ≥ 2
    // never do.
    if (step !== undefined) {
      raw.step = step;
    }
    return redactDeep(raw, values);
  }

  function topTargetCandidates(
    answers: AnswerMap,
    obs: Observation,
    values: Record<string, string>,
  ): Array<{ label: string }> {
    const target = answers['target'] as JevChoiceAnswer | undefined;
    if (!target) return [];
    return Object.entries(target.probabilities)
      .filter(([id]) => id !== 'none' && id !== 'ambiguous')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => {
        const el = obs.elements.find((e) => e.id === id);
        return { label: capLabel(redactValues(el ? elementCriterion(el) : id, values)) };
      });
  }

  /** § 3.7 rules 1–5, which need only the first request's answers. Null = continue to rules 6–9. */
  function decideEarly(
    answers: AnswerMap,
    round: number,
    obs: Observation,
    values: Record<string, string>,
  ): WingmanResult | null {
    const noulOf = (id: string): number => {
      const a = answers[id];
      return a && a.type === 'noul' ? a.noul : 0;
    };
    // 1. login
    if (noulOf('login') >= THRESHOLDS.login) {
      return mk('login', 'login-page');
    }
    // 2. blocked
    if (noulOf('blocked') >= THRESHOLDS.blocked) {
      return mk('blocked', 'page-blocked');
    }
    // 3. error (round ≥ 2 only; the question is only asked then)
    if (round >= 2 && noulOf('error') >= THRESHOLDS.error) {
      return mk('error', 'page-error');
    }
    // 4. done
    if (noulOf('done') >= THRESHOLDS.done) {
      return mk('done', 'goal-met');
    }
    // 5. action none
    const action = answers['action'] as JevChoiceAnswer | undefined;
    if (action && action.choice === 'none') {
      if (noulOf('done') >= THRESHOLDS.doneNoAction) {
        return mk('done', 'goal-met');
      }
      return mk('ambiguous', 'no-action', { candidates: topTargetCandidates(answers, obs, values) });
    }
    return null;
  }

  /** § 3.7 rules 6–8 plus value resolution for fill/select. `actionAnswers` is
   * the request that carried the `action` question (request 1 in both shapes;
   * request 2 never repeats it). */
  async function decideTarget(
    answers: AnswerMap,
    actionAnswers: AnswerMap,
    obs: Observation,
    values: Record<string, string>,
    state: object,
    remaining: () => number,
  ): Promise<{ result?: WingmanResult; bounds?: boolean; el: ElementRecord; verb: Op; binding?: string; optionValue?: string }> {
    const action = actionAnswers['action'] as JevChoiceAnswer | undefined;
    // Answers are untrusted: an out-of-set action choice, a target id that is
    // not in the observation, or a value choice naming no real binding must
    // resolve to an ambiguous decision — never to an act on some other element.
    const uncertain = (): {
      result: WingmanResult;
      el: ElementRecord;
      verb: Op;
    } => ({
      result: mk('ambiguous', 'target-uncertain', { candidates: topTargetCandidates(answers, obs, values) }),
      el: obs.elements[0],
      verb: 'click',
    });
    const rawVerb = action?.choice;
    const verb: Op | null =
      typeof rawVerb === 'string' && (OPS as readonly string[]).includes(rawVerb) ? (rawVerb as Op) : null;
    if (verb === null) {
      return uncertain();
    }
    const target = answers['target'] as JevChoiceAnswer | undefined;
    const targetId = target?.choice ?? 'none';
    const targetProb = target ? (target.probabilities[targetId] ?? 0) : 0;
    // 6. target uncertainty (action ≠ scroll)
    if (verb !== 'scroll' && (targetId === 'none' || targetId === 'ambiguous' || targetProb < THRESHOLDS.target)) {
      return uncertain();
    }
    const el = obs.elements.find((e) => e.id === targetId);
    if (!el) {
      return uncertain();
    }
    // 7. op fit
    if (!opFits(verb, el)) {
      return uncertain();
    }
    // 8. value
    let binding: string | undefined;
    let optionValue: string | undefined;
    if (verb === 'fill') {
      const valueAnswer = answers['value'] as JevChoiceAnswer | undefined;
      if (
        !valueAnswer ||
        valueAnswer.choice === 'none' ||
        (valueAnswer.probabilities[valueAnswer.choice] ?? 0) < THRESHOLDS.value
      ) {
        return { result: mk('ambiguous', 'no-value'), el, verb };
      }
      binding = valueAnswer.choice;
      if (!(binding in values)) {
        return { result: mk('ambiguous', 'no-value'), el, verb };
      }
    } else if (verb === 'select') {
      const valueAnswer = answers['value'] as JevChoiceAnswer | undefined;
      if (
        valueAnswer &&
        valueAnswer.choice !== 'none' &&
        valueAnswer.choice in values &&
        (valueAnswer.probabilities[valueAnswer.choice] ?? 0) >= THRESHOLDS.value
      ) {
        binding = valueAnswer.choice;
        const wanted = values[binding] ?? '';
        const local = (el.options ?? []).find(
          (o) => o.label.toLowerCase() === wanted.toLowerCase() || o.value.toLowerCase() === wanted.toLowerCase(),
        );
        if (local) {
          optionValue = local.value;
        }
      }
      if (optionValue === undefined) {
        const outcome = await resolveOption(obs, el, binding, values, state, remaining);
        if (outcome.kind === 'value') {
          optionValue = outcome.value;
        } else if (outcome.kind === 'no-value') {
          return { result: mk('ambiguous', 'no-value'), el, verb };
        } else if (outcome.kind === 'budget-time') {
          return { result: mk('fallback', 'budget-time'), bounds: true, el, verb };
        } else {
          return { result: mk('fallback', askFailReason(outcome)), bounds: true, el, verb };
        }
      }
    }
    return {
      el,
      verb,
      ...(binding !== undefined ? { binding } : {}),
      ...(optionValue !== undefined ? { optionValue } : {}),
    };
  }

  /** § 3.6 option requests for a native select; each obeys the time rule and counts toward cost. */
  async function resolveOption(
    obs: Observation,
    el: ElementRecord,
    bindingName: string | undefined,
    values: Record<string, string>,
    state: object,
    remaining: () => number,
  ): Promise<OptionOutcome> {
    // Option labels are page text and can echo a typed value, so they leave
    // redacted against the call's bindings, like every other egress surface.
    const chunks = buildOptionRequests({ state, select: el, bindingName, bindings: values });
    if (chunks.length === 0) return { kind: 'no-value' };
    const winners: Array<{ value: string; label: string; prob: number }> = [];
    for (const { request, ids } of chunks) {
      if (remaining() < TIME_FLOOR_MS) return { kind: 'budget-time' };
      const r = await askWithCost(request, 'wingman_do', remaining);
      if (!r.ok) return { kind: 'ask-failed', error: r.error };
      const ans = r.answers['option'] as JevChoiceAnswer | undefined;
      if (!ans || ans.choice === 'none') continue;
      const value = ids[ans.choice];
      if (value === undefined) continue; // an out-of-set choice names no real option
      const label = (el.options ?? []).find((o) => o.value === value)?.label ?? ans.choice;
      winners.push({ value, label, prob: ans.probabilities[ans.choice] ?? 0 });
    }
    if (chunks.length === 1) {
      // With one chunk the chunk request is final.
      const w = winners[0];
      return w && w.prob >= THRESHOLDS.value ? { kind: 'value', value: w.value } : { kind: 'no-value' };
    }
    if (winners.length === 0) return { kind: 'no-value' };
    const final = buildOptionFinalRequest({ state, winners, bindings: values });
    if (remaining() < TIME_FLOOR_MS) return { kind: 'budget-time' };
    const r = await askWithCost(final.request, 'wingman_do', remaining);
    if (!r.ok) return { kind: 'ask-failed', error: r.error };
    const ans = r.answers['option'] as JevChoiceAnswer | undefined;
    if (!ans || ans.choice === 'none' || (ans.probabilities[ans.choice] ?? 0) < THRESHOLDS.value) {
      return { kind: 'no-value' };
    }
    const finalValue = final.ids[ans.choice];
    return finalValue !== undefined ? { kind: 'value', value: finalValue } : { kind: 'no-value' };
  }

  /** The one fixed confirm-token point (§ WP-C7 item 3). */
  async function runTokenAction(
    pageId: string,
    driver: Driver,
    obs: Observation,
    token: string,
    values: Record<string, string>,
    maxSteps: number,
    remaining: () => number,
    history: Array<{ verb: Op; label: string }>,
  ): Promise<{ result: WingmanResult | null; history: Array<{ verb: Op; label: string }> }> {
    const action = deps.tokens.consume(token);
    if (!action) {
      return { result: mk('error', 'confirm-token-invalid'), history };
    }
    if (urlKey(action.url) !== urlKey(obs.url)) {
      return { result: mk('error', 'confirm-token-invalid'), history };
    }
    const el = obs.elements.find(
      (e) => e.path === action.elementPath && fingerprintMatches(e.fingerprint, action.fingerprint),
    );
    if (!el) {
      return { result: mk('error', 'confirm-token-invalid'), history };
    }
    let actValue: string | undefined;
    if (action.verb === 'fill') {
      const v = action.binding !== undefined ? values[action.binding] : undefined;
      if (v === undefined) {
        return { result: mk('error', 'invalid-input'), history };
      }
      actValue = v;
    } else if (action.verb === 'select') {
      actValue = action.optionValue;
    }
    if (steps >= maxSteps) {
      return { result: mk('fallback', 'budget-steps'), history };
    }
    if (remaining() < TIME_FLOOR_MS) {
      return { result: mk('fallback', 'budget-time'), history };
    }
    const tAct0 = now();
    await driver.act(pageId, el.id, action.verb, actValue);
    if (cur) cur.actMs += now() - tAct0;
    steps += 1;
    // Result labels are redacted against the call's bindings and capped (§ WP-C7 item 5).
    lastAction = { verb: action.verb, label: capLabel(redactValues(el.name, values)) };
    // § 3.7 rule 11.
    if (dialogEvents.some((e) => e.pageId === pageId)) {
      return { result: mk('blocked', 'dialog-open'), history };
    }
    const settleBudget = Math.min(SETTLE_MAX_MS, remaining() - 1000);
    if (settleBudget > 0) {
      const tSettle0 = now();
      await driver.settle(pageId, settleBudget);
      if (cur) cur.settleMs += now() - tSettle0;
    }
    if (dialogEvents.some((e) => e.pageId === pageId)) {
      return { result: mk('blocked', 'dialog-open'), history };
    }
    return { result: null, history: [...history, { verb: action.verb, label: el.name }] };
  }

  const validated =
    tool === 'wingman_do'
      ? validateDoInput(input)
      : tool === 'browse_step'
        ? validateStepInput(input)
        : validateCheckInput(input);
  if (!validated.ok) {
    return finish(mk('error', 'invalid-input'));
  }

  if (!deps.mutex.tryAcquire()) {
    return finish(mk('blocked', 'busy'));
  }

  let attached = false;
  let driver: Driver | null = null;

  try {
    if (mode === 'off') {
      return await finish(mk('fallback', 'mode-off'));
    }
    if (!deps.ask) {
      return await finish(mk('fallback', 'no-key'));
    }
    if (deps.lockCheck) {
      const lock = await deps.lockCheck();
      if (!lock.ok) {
        return await finish(mk('blocked', 'lock-held'));
      }
    }
    const endpoint = await deps.resolveEndpoint();
    if (!endpoint) {
      return await finish(mk('fallback', 'no-browser'));
    }

    driver = deps.driverFactory(deps.config);
    driver.onDialog((e) => dialogEvents.push(e));

    try {
      const tAttach = now();
      await driver.attach({ cdpEndpoint: endpoint });
      phaseAcc.attachMs = now() - tAttach;
      attached = true;
    } catch (e) {
      if (e instanceof AttachError) {
        return await finish(mk('fallback', 'no-browser'));
      }
      throw e;
    }

    const allPages = await driver.pages();
    let visiblePages = allPages.filter((p) => p.visible);
    const urlMatch =
      tool === 'wingman_check'
        ? (validated.input as CheckInput).url_match
        : (validated.input as DoInput | StepInput).url_match;
    if (urlMatch !== undefined) {
      visiblePages = visiblePages.filter((p) => p.url.includes(urlMatch));
    }
    if (visiblePages.length !== 1) {
      const values: Record<string, string> =
        tool === 'wingman_check' ? {} : ((validated.input as DoInput | StepInput).values ?? {});
      const candidates = visiblePages
        .slice(0, 3)
        .map((p) => ({ label: capLabel(redactValues(p.title, values)) }));
      return await finish(mk('ambiguous', 'tab-ambiguous', { candidates }));
    }
    const pageId = visiblePages[0].id;

    if (tool === 'wingman_check') {
      return await finish(await runCheck(pageId, driver, validated.input as CheckInput));
    }
    if (tool === 'browse_step') {
      return await finish(await runBrowse(pageId, driver, validated.input as StepInput));
    }
    return await finish(await runDoRounds(pageId, driver, validated.input as DoInput));
  } catch (e) {
    let status: Status = 'error';
    let reason: Reason = 'tool-fault';
    if (e instanceof StaleElementError) {
      reason = 'stale-element';
    } else if (e instanceof CoveredTargetError) {
      status = 'blocked';
      reason = 'covered-target';
    } else if (e instanceof DialogOpenError) {
      status = 'blocked';
      reason = 'dialog-open';
    } else if (e instanceof ActFailedError) {
      reason = 'act-failed';
    }
    return await finish(mk(status, reason));
  } finally {
    if (driver && attached) {
      try {
        await driver.detach();
      } catch {
        // detach errors never mask the result
      }
    }
    deps.mutex.release();
  }

  // ---- wingman_check: preamble, policy, one observe, one ask (§ WP-C7 item 4) ----
  async function runCheck(pageId: string, driver: Driver, check: CheckInput): Promise<WingmanResult> {
    const remaining = () => deps.config.budgets.max_ms - (now() - startedAt);
    if (remaining() < TIME_FLOOR_MS) {
      return mk('fallback', 'budget-time');
    }
    beginRound(); // one pseudo-round: observe + ask (no act/settle on check)
    const obs = await observeTimed(pageId);
    pageUrl = obs.url;
    const policy = evaluatePolicy(obs.url, obs.signals, deps.config.sensitive_hosts, policyModeOf(deps.config));
    if (policy.sensitive) {
      return mk('fallback', policy.reason as Reason);
    }
    const state = buildState(obs, [], null, {});
    const request = buildCheckRequest({ state, question: check.question, values: {} });
    if (remaining() < TIME_FLOOR_MS) {
      return mk('fallback', 'budget-time');
    }
    const r = await askWithCost(request, 'wingman_check', remaining);
    if (!r.ok) {
      return mk('fallback', askFailReason(r));
    }
    if (mode === 'shadow') {
      // The answer is neither returned nor logged (§ WP-C7 item 4).
      return mk('fallback', 'shadow', { shadow: true });
    }
    const answer = r.answers['answer'];
    const noul = answer && answer.type === 'noul' ? answer.noul : 0;
    return mk('done', 'answered', { answer: round2(noul) });
  }

  // ---- browse_step: routing pre-pass, then takeover entry (§ 3.18, § 3.19) ----
  // No fork: the entry rides runDoRounds' existing gated rounds; this stage
  // only grades and decides entry. The one new policy call site below is the
  // routing pre-pass's own round-1 prelude check, which must precede the
  // routing ask and therefore cannot reuse the round prelude's line.
  async function runBrowse(pageId: string, driver: Driver, stepInput: StepInput): Promise<WingmanResult> {
    const values = stepInput.values ?? {};
    const proposals = stepInput.steps ?? [stepInput.step as string];
    const maxMs = Math.min(stepInput.max_ms ?? Number.POSITIVE_INFINITY, deps.config.budgets.max_ms);
    const remaining = () => maxMs - (now() - startedAt);

    // Token continuation (§ 3.19 flow item 2): no routing ask and no routing
    // pre-pass — the token is handled at the existing fixed point inside
    // runDoRounds, which runs the full round-1 prelude itself. `routing` is
    // absent on this path.
    if (stepInput.confirm_token !== undefined) {
      return runDoRounds(pageId, driver, {
        goal: stepInput.goal,
        values,
        confirm_token: stepInput.confirm_token,
        ...(stepInput.max_steps !== undefined ? { max_steps: stepInput.max_steps } : {}),
        ...(stepInput.max_ms !== undefined ? { max_ms: stepInput.max_ms } : {}),
      });
    }

    // Round-1 prelude exactly as wingman_do round 1 (§ 3.19 flow item 1):
    // observe (timed), dialog check, captcha check, policy — a hit returns
    // before any ask. The routing ask records one phase bucket.
    if (remaining() < TIME_FLOOR_MS) {
      return mk('fallback', 'budget-time');
    }
    beginRound();
    const obs = await observeTimed(pageId);
    pageUrl = obs.url;
    if (dialogEvents.some((e) => e.pageId === pageId)) {
      return mk('blocked', 'dialog-open');
    }
    if (obs.signals.captcha) {
      return mk('blocked', 'captcha');
    }
    const policy = evaluatePolicy(obs.url, obs.signals, deps.config.sensitive_hosts, policyModeOf(deps.config));
    if (policy.sensitive) {
      return mk('fallback', policy.reason as Reason);
    }

    // § 3.18 routing state: the buildState output with the goal, plus the
    // element table as redacted criteria strings and the redacted step texts
    // cut to 300. No element paths, queries or fragments leave in it.
    const state = buildState(obs, [], stepInput.goal, values) as Record<string, unknown>;
    state.elements = obs.elements.map((e) => redactValues(elementCriterion(e), values));
    state.steps = proposals.map((s) => redactValues(s, values).slice(0, 300));
    const request = buildRoutingRequest({ state, steps: proposals, elements: obs.elements, bindings: values });

    if (remaining() < TIME_FLOOR_MS) {
      return mk('fallback', 'budget-time');
    }
    const r = await askWithCost(request, 'browse_step', remaining);
    if (!r.ok) {
      return mk('fallback', askFailReason(r));
    }

    // § 3.18 executor decision, per step, in order. The comparison uses the
    // same 2-decimal value `routing` reports — one rounding, one decision —
    // and it is >=: a handle exactly at the threshold takes over.
    const threshold = takeoverOf(deps.config).threshold;
    const routing = proposals.map((s, i) => {
      const handleAnswer = r.answers[`handle${i + 1}`];
      const execAnswer = r.answers[`exec${i + 1}`];
      const handleNoul =
        handleAnswer !== undefined && handleAnswer.type === 'noul' ? handleAnswer.noul : null;
      const execChoice =
        execAnswer !== undefined &&
        execAnswer.type === 'choice' &&
        (execAnswer.choice === 'wingman' || execAnswer.choice === 'caller')
          ? execAnswer.choice
          : null;
      if (handleNoul === null || execChoice === null) {
        // The grader misbehaved — the route-unclear material, not a low grade.
        return { step: capLabel(redactValues(s, values)), handle: null, executor: 'caller' as const };
      }
      const handle = round2(handleNoul);
      const executor = handle >= threshold && execChoice === 'wingman' ? ('wingman' as const) : ('caller' as const);
      return { step: capLabel(redactValues(s, values)), handle, executor };
    });

    // Shadow grades only (§ 3.19): the routing ask runs, nothing acts, and
    // acc.would stays unset (routing already carries the decision).
    if (mode === 'shadow') {
      return mk('fallback', 'shadow', { shadow: true, routing });
    }

    // Call-level outcome (§ 3.18), in order. Only step 1's grade decides
    // entry: the element table the grades were computed against is stale the
    // moment anything acts, so a mixed batch returns whole, never partially
    // executes.
    const first = routing[0];
    if (first.handle === null) {
      return mk('ambiguous', 'route-unclear', { routing });
    }
    if (first.executor === 'caller') {
      return mk('fallback', 'route-caller', { routing });
    }
    // Step 1 routes to the wingman. Participation: the call's `takeover`
    // field overrides the config mode. The threshold is never waived by
    // `takeover: true` — the grade above already had to clear it.
    const participation =
      stepInput.takeover === true
        ? 'execute'
        : stepInput.takeover === false
          ? 'offer'
          : takeoverOf(deps.config).mode;
    if (participation === 'offer') {
      return mk('fallback', 'takeover-offered', { routing });
    }
    // Entry (§ 3.19 flow item 4): round 1 re-observes and runs the standard
    // § 3.7 rules against a state that carries the step text. One envelope:
    // the routing ask and every round share this call's max_ms/max_steps,
    // clamped by the config budgets inside runDoRounds. `routing` rides the
    // takeover's own end status too (§ 3.17: every result that completed the
    // routing ask carries it).
    const entryResult = await runDoRounds(
      pageId,
      driver,
      {
        goal: stepInput.goal,
        values,
        ...(stepInput.max_steps !== undefined ? { max_steps: stepInput.max_steps } : {}),
        ...(stepInput.max_ms !== undefined ? { max_ms: stepInput.max_ms } : {}),
      },
      proposals[0],
    );
    entryResult.routing = routing;
    return entryResult;
  }

  // ---- wingman_do rounds (§ 3.7, in order) ----
  async function runDoRounds(pageId: string, driver: Driver, doInput: DoInput, entryStep?: string): Promise<WingmanResult> {
    const values = doInput.values ?? {};
    const maxSteps = Math.min(doInput.max_steps ?? Number.POSITIVE_INFINITY, deps.config.budgets.max_steps);
    const maxMs = Math.min(doInput.max_ms ?? Number.POSITIVE_INFINITY, deps.config.budgets.max_ms);
    const remaining = () => maxMs - (now() - startedAt);
    const shadowResult = (): WingmanResult => mk('fallback', 'shadow', { shadow: true });
    let history: Array<{ verb: Op; label: string }> = [];
    const token = doInput.confirm_token;
    let tokenHandled = false;
    let round = 0;

    while (true) {
      round += 1;
      if (remaining() < TIME_FLOOR_MS) {
        return mk('fallback', 'budget-time');
      }
      const bucket = beginRound();
      const obs = await observeTimed(pageId);
      pageUrl = obs.url;

      // A dialog reported through onDialog before an act.
      if (dialogEvents.some((e) => e.pageId === pageId)) {
        return mk('blocked', 'dialog-open');
      }
      if (obs.signals.captcha) {
        return mk('blocked', 'captcha');
      }
      const policy = evaluatePolicy(obs.url, obs.signals, deps.config.sensitive_hosts, policyModeOf(deps.config));
      if (policy.sensitive) {
        // A policy hit leaves a confirm token unconsumed.
        return mk('fallback', policy.reason as Reason);
      }

      // The confirm token is handled at one fixed point: after tab
      // resolution, the first observe and the policy check, before any ask.
      // In shadow mode it is neither consumed nor executed (§ 3.7 rule 10).
      if (token !== undefined && !tokenHandled) {
        tokenHandled = true;
        if (mode !== 'shadow') {
          const outcome = await runTokenAction(pageId, driver, obs, token, values, maxSteps, remaining, history);
          if (outcome.result) {
            return outcome.result;
          }
          history = outcome.history; // the act counted as a step; continue under the gate
          continue;
        }
      }

      const state = buildState(
        obs,
        history,
        doInput.goal,
        values,
        entryStep !== undefined && round === 1 ? redactValues(entryStep, values).slice(0, 300) : undefined,
      );
      // Time rule: before every ask.
      if (remaining() < TIME_FLOOR_MS) {
        return mk('fallback', 'budget-time');
      }
      const twoStage = obs.elements.length > deps.config.budgets.max_elements;
      let primary: AnswerMap;
      let secondary: AnswerMap | null = null;

      if (twoStage) {
        const built = buildGroupRequest({ state, elements: obs.elements, bindings: values, round });
        const r1 = await askWithCost(built.request, 'wingman_do', remaining);
        if (!r1.ok) {
          return mk('fallback', askFailReason(r1));
        }
        primary = r1.answers as AnswerMap;
        const early = decideEarly(primary, round, obs, values);
        if (early) {
          return mode === 'shadow' ? shadowResult() : early;
        }
        const groupAnswer = primary['group'] as JevChoiceAnswer | undefined;
        const topIds = groupAnswer
          ? Object.entries(groupAnswer.probabilities)
              .filter(([id]) => id !== 'none' && id !== 'ambiguous')
              .sort((a, b) => b[1] - a[1])
              .slice(0, TWO_STAGE.topGroups)
              .map(([id]) => id)
          : [];
        const targetElements = topIds.flatMap((id) => {
          const index = Number(id.slice(1)) - 1;
          return index >= 0 && index < built.groups.length ? built.groups[index] : [];
        });
        if (targetElements.length === 0) {
          return mode === 'shadow' ? shadowResult() : mk('ambiguous', 'target-uncertain', { candidates: [] });
        }
        const r2 = await (async () => {
          if (remaining() < TIME_FLOOR_MS) {
            return { ok: false as const, error: 'budget-time' as const };
          }
          return await askWithCost(
            buildTargetRequest({ state, elements: targetElements, bindings: values, round }),
            'wingman_do',
            remaining,
          );
        })();
        if (!r2.ok) {
          return mk('fallback', r2.error === 'budget-time' ? 'budget-time' : askFailReason(r2));
        }
        secondary = r2.answers as AnswerMap;
      } else {
        const built = buildRoundRequest({ state, elements: obs.elements, bindings: values, round });
        const r = await askWithCost(built, 'wingman_do', remaining);
        if (!r.ok) {
          return mk('fallback', askFailReason(r));
        }
        primary = r.answers as AnswerMap;
        const early = decideEarly(primary, round, obs, values);
        if (early) {
          return mode === 'shadow' ? shadowResult() : early;
        }
      }

      // § 3.7 rules 6–9 from the answers that carry target/value/irreversible;
      // the verb comes from the answers that carried `action` (request 1).
      const decisionAnswers = (secondary ?? primary) as AnswerMap;
      const decide = await decideTarget(decisionAnswers, primary, obs, values, state, remaining);

      if (mode === 'shadow') {
        // Rule 10: shadow overrides steps 1–9 — after the first round's
        // answers the call returns fallback/shadow, whatever they decided.
        // Loop bounds (budget-time, a failed ask) are not steps 1–9 decisions.
        if (decide.result && decide.bounds) {
          return decide.result;
        }
        if (!decide.result) {
          // Steps 1–8 chose an act.
          const gate = gateHeuristic(decide.el, decide.el.form >= 0 ? obs.forms[decide.el.form] : undefined, decide.verb);
          const irreversibleAnswer = decisionAnswers['irreversible'];
          const irreversibleP =
            irreversibleAnswer && irreversibleAnswer.type === 'noul' ? irreversibleAnswer.noul : 0;
          if (gate.hit || irreversibleP >= THRESHOLDS.irreversible) {
            acc.gateHits = 1;
          }
          acc.would = { verb: decide.verb, role: decide.el.role };
        }
        return shadowResult();
      }

      if (decide.result) {
        return decide.result;
      }
      const { el, verb, binding, optionValue } = decide;

      // Rule 9 gate, then act — the gate call always precedes the act call.
      // With gate.mode 'off' (§ 3.8) the gate heuristic and the Jev
      // irreversible probability never produce needs_confirmation: the act
      // proceeds exactly as a non-gated action would and no token is minted.
      if (gateModeOf(deps.config) !== 'off') {
        const gate = gateHeuristic(el, el.form >= 0 ? obs.forms[el.form] : undefined, verb);
        const irreversibleAnswer = decisionAnswers['irreversible'];
        const irreversibleP = irreversibleAnswer && irreversibleAnswer.type === 'noul' ? irreversibleAnswer.noul : 0;
        if (gate.hit || irreversibleP >= THRESHOLDS.irreversible) {
          const pending: PendingAction = {
            url: obs.url,
            elementPath: el.path,
            fingerprint: el.fingerprint,
            verb,
            ...(binding !== undefined ? { binding } : {}),
            ...(optionValue !== undefined ? { optionValue } : {}),
            label: el.name,
          };
          const confirmToken = deps.tokens.mint(pending);
          return mk('needs_confirmation', gate.hit ? 'irreversible-heuristic' : 'irreversible-jev', {
            pending: { verb, label: capLabel(redactValues(el.name, values)) },
            confirm_token: confirmToken,
          });
        }
      }

      // Rule 11: act, then dialog, settle, dialog again, history.
      if (steps >= maxSteps) {
        return mk('fallback', 'budget-steps');
      }
      if (remaining() < TIME_FLOOR_MS) {
        return mk('fallback', 'budget-time');
      }
      const actValue =
        verb === 'fill'
          ? binding !== undefined
            ? values[binding]
            : undefined
          : verb === 'select'
            ? optionValue
            : undefined;
      const tAct = now();
      await driver.act(pageId, el.id, verb, actValue);
      bucket.actMs += now() - tAct;
      steps += 1;
      lastAction = { verb, label: capLabel(redactValues(el.name, values)) };
      if (dialogEvents.some((e) => e.pageId === pageId)) {
        return mk('blocked', 'dialog-open');
      }
      const settleBudget = Math.min(SETTLE_MAX_MS, remaining() - 1000);
      if (settleBudget > 0) {
        const tSettle = now();
        await driver.settle(pageId, settleBudget);
        bucket.settleMs += now() - tSettle;
      }
      if (dialogEvents.some((e) => e.pageId === pageId)) {
        return mk('blocked', 'dialog-open');
      }
      history = [...history, { verb, label: el.name }];
      // next round
    }
  }
}

export async function runDo(input: unknown, deps: LoopDeps): Promise<WingmanResult> {
  return runTool('wingman_do', input, deps);
}

export async function runCheck(input: unknown, deps: LoopDeps): Promise<WingmanResult> {
  return runTool('wingman_check', input, deps);
}

export async function runStep(input: unknown, deps: LoopDeps): Promise<WingmanResult> {
  return runTool('browse_step', input, deps);
}
