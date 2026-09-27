// Run loop and security boundary (§ WP-C7).
// The round decision rule is § 3.7, implemented exactly, in order.
// Security invariants proven by tests/boundary.test.ts: binding values are
// redacted before any ask, URLs leave without query string or fragment, the
// sensitive-surface policy runs before every ask, irreversible actions need a
// confirm token, and the log record never carries page content.
//
// Forced handoff (spec 2026-09-26-wingman-forced-handoff): chain mode with
// per-clause memory (§ 5.5.2), the § 5.5.1 repairing validators, the new verbs
// and capability negotiation (§ 5.5.3/§ 5.5.6), done-before-error early rules
// with recover (§ 5.5.4), the forced note table (§ 5.5.5), pick integration
// (§ 5.6) and the state-size rule (§ 5.5.7).

import {
  CHAIN_MEMORY_MAX,
  LABEL_MAX,
  READY_MAX_WAITS,
  RECOVER_MAX_PER_CLAUSE,
  SETTLE_MAX_MS,
  TAKEOVER_MARGIN_FLOOR,
  TAKEOVER_MARGIN_RATIO,
  THRESHOLDS,
  TIME_FLOOR_MS,
  TWO_STAGE,
  WAIT_MAX_PER_CALL,
  WRONG_PAGE_MAX,
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
  PickInput,
  Reason,
  Status,
  WingmanConfig,
  WingmanLogRecord,
  WingmanResult,
} from '../contract/types.js';
import { LEGACY_OPS, OPS, PRESS_KEYS, TARGETLESS_OPS } from '../contract/types.js';
import {
  ActFailedError,
  AttachError,
  CoveredTargetError,
  DialogOpenError,
  StaleElementError,
} from '../contract/errors.js';
import { evaluatePolicy } from './policy.js';
import { gateHeuristic } from './gate.js';
import { gateModeOf, handoffOf, policyModeOf, takeoverOf } from './config.js';
import { ConfirmTokenStore, type PendingAction } from './tokens.js';
import { isPathLike, redactDeep, redactValues, typeHint } from './withhold.js';
import {
  buildCheckRequest,
  buildGroupRequest,
  buildOptionFinalRequest,
  buildOptionRequests,
  buildRoundRequest,
  buildTargetRequest,
  elementCriterion,
  offeredOps,
  UNTRUSTED_SENTENCE,
} from './questions.js';
import { candidateOf, resolvePick, validatePick } from './pick.js';
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

// § 5.5.1 missing-binding detector: names the steps mention as "value named x"
// must exist in values. Case-insensitive; captures are lower-cased before the
// lookup (binding names are lower-case by BINDING_RE).
const VALUE_NAMED_RE = /\bvalue named ([a-z][a-z0-9_]{0,39})\b/gi;

/** KB proof switch (KB-D b / WP-D Db): composed into the pick obscured check.
 * Never flip in shipped code. */
const KB_PICK_OBSCURED = false;

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

// Escalating bounce text (amendment 2026-09-22): when a browse_step call
// bounces (status fallback, reason step-uncertain or target-covered), the
// result note escalates by how many bounces this goal has already seen —
// keyed on the goal text, in-process (one MCP-server process per caller
// session, so a module-level map IS per-session state; nothing persists).
// Tier 1 appends to the bounce's static note; tiers 2 and 3 replace it. Done
// results carry no escalation; non-bounce non-done results keep the § 3.17
// static table; wingman_do's CONTINUE_LINE is untouched. Static text only —
// never page content, so the egress rules are unaffected. In forced handoff
// mode (§ 5.5.5 rule 4e) the counter is never touched.
export const BOUNCE_TIER1_LINE =
  'Retry with a more specific description of the target, or perform this step yourself with your raw browser tools.';
export const BOUNCE_TIER2_LINE =
  'wingman has now declined 2 steps of this goal. Complete the remaining steps with your own browser tools and stop calling wingman for this goal.';
export const BOUNCE_TIER3_LINE =
  'wingman is not able to progress on this goal. Drive the remaining steps yourself; do not call wingman again for this goal.';

// Policy-neutral tool text (2026-09-25): the caller-facing note, not the tool
// description, is where the sensitive-page handoff lives. Any fallback result
// whose reason names a sensitive/unsupported page carries this line for all
// three tools, in place of CONTINUE_LINE, the browse_step note table and the
// bounce counter. Static text only — never page content, so the egress rules
// are unaffected.
export const SENSITIVE_LINE =
  'This page is sensitive under the active policy. Do this step with your own browser tools, then call again once you reach a non-sensitive page.';

// § 5.5.5 forced note table (Q4). In forced mode the caller's action tools are
// withheld, so a note pointing at them dead-ends; browse_step and wingman_do
// alike get these lines. wingman_check keeps SENSITIVE_LINE — it only reads.
// Static text only — never page content.
export const FORCED_BOUNCE_LINE =
  'Step returned to you. Call browse_step again with the same goal, steps and values plus pick: { role, name, action } naming the element to use (from step_review.candidates, or from your own snapshot or screenshot), or with a more specific step.';
export const FORCED_ALREADY_DONE_LINE =
  'wingman judged this step already done and acted on nothing. Check the page with your own snapshot: if the step is not done, call browse_step again with pick naming the element; otherwise continue with the remaining steps.';
export const FORCED_RESUME_LINE =
  'Not finished. Call browse_step again with the same goal, steps and values to resume from progress.';
export const FORCED_OFFER_LINE =
  'Takeover available. Call browse_step again with the same arguments and takeover: true to accept.';
export const FORCED_LOGIN_LINE =
  'The page asks for sign-in. Ask the user to sign in (including any two-factor step), then call browse_step again with the same arguments.';
export const FORCED_DIALOG_LINE =
  'A dialog is open. Answer it with your own browser tools, then call browse_step again with the same arguments.';
export const FORCED_UNAVAILABLE_LINE =
  'The wingman cannot act in this setup right now. Tell the user and ask them to run jev-browser-wingman doctor, which names the fix.';
export const FORCED_TAB_LINE =
  'Several tabs could be the page. Call browse_step again with the same arguments plus url_match naming the page, or switch or close tabs with your own browser tools.';
export const FORCED_VALUE_LINE =
  'A value was missing or unclear. Call browse_step again with the needed value in values and named in the step, or with pick naming the element and the value.';
export const FORCED_BLOCKED_LINE =
  'The page is blocked by a captcha, an access notice or a covering overlay. Clear it with the user, or pick the overlay\'s dismiss control, then call browse_step again with the same arguments.';
export const FORCED_SENSITIVE_LINE =
  'This page is sensitive under the active policy, so wingman sends nothing from it for a decision. Drive it with browse_step and pick naming each element (a pick makes no decision-service call), or ask the user to do this step.';
export const FORCED_WRONG_PAGE_LINE =
  'This page does not fit the current step. Check where you are with your own snapshot, then call browse_step again with pick on the link that leads there, or with the page address in values and a step that opens it.';
export const FORCED_NOT_READY_LINE =
  'The page did not finish loading what the step needs. Check it with your own snapshot; call browse_step again with the same arguments once it is ready, or with pick naming the element.';
export const FORCED_PAGE_ERROR_LINE =
  'The page shows an error wingman could not recover from. Look at it with your own snapshot, then call browse_step again with pick or a changed step, or ask the user.';
export const PICK_UNMATCHED_LINE =
  'The pick matched no single element. Call again with pick using a role and name from candidates, and add nth when several elements share them.';
export const UNSUPPORTED_OP_LINE =
  'The active wingman adapter cannot perform this action. Do this step with your own browser tools, then call browse_step again with the remaining steps.';
export const STATE_TOO_LARGE_LINE =
  'The page is too large for one decision. Take your own snapshot, then call browse_step again with pick naming the element to use.';

const bounceCounts = new Map<string, number>();

// § 5.5.2 chain memory: deterministic in-process cursor memory keyed on
// [goal, clauses] (values never enter the key; the key is never logged or
// returned). A done call deletes its entry; every other end stores the cursor
// and the accumulated act count. Eviction is oldest-first above
// CHAIN_MEMORY_MAX.
interface ChainMemoryEntry { cursor: number; acts: number }
const chainMemory = new Map<string, ChainMemoryEntry>();

/** Chain state for the current browse_step call, when it runs chain mode
 * (§ 5.5.2). Created by runBrowse, read by finish() for progress and the
 * memory write-back. */
interface ChainState {
  key: string;
  clauses: string[];
  N: number;
  cursor: number;
  priorActs: number;
  clauseRetried: boolean;
  firstCommitDone: boolean;
  wrongPageRounds: number;
  notReadyRounds: number;
  recoverActs: number;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function capLabel(s: string): string {
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s;
}

function cut40(s: string): string {
  return s.length > 40 ? s.slice(0, 40) : s;
}

/** § 5.5.3: a file input. click/dblclick/press on one convert to upload. */
function isFileInput(el: ElementRecord): boolean {
  return el.tag === 'input' && el.type === 'file';
}

// § outcome evidence (WP-outcome-evidence WP-A/WP-B): one history entry per
// act, identity plus a verb-specific outcome signal. `path`/`fingerprint` are
// the acted-on element's identity (absent for targetless/binding-only verbs);
// `before` is that signal captured from the round's obs BEFORE the act,
// `result` the same signal recomputed from the FRESH obs at the top of the
// next round (annotateLastOutcome below). Neither `path`, `fingerprint` nor
// `before` ever reaches buildState's `raw.history` — only verb/label/result
// do, and those pass through the existing redactDeep like every other field.
interface HistoryEntry {
  verb: Op;
  label: string;
  path?: string;
  fingerprint?: Fingerprint;
  before?: string;
  result?: string;
  // § outcome evidence WP-B scope (orchestrator decision, 2026-09-28): which
  // step this act belonged to — the chain clause index (`c<cursor>`) in
  // chain mode, else `'single'` (a legacy browse_step entry or a wingman_do
  // call is one implicit step for this purpose). Internal only — never
  // reaches buildState's history mapping.
  stepKey?: string;
}

/** § outcome evidence: element-state verbs read `state` directly (no new
 * page call — it is already on every enumerated element); every other verb
 * (click-family, and any el-targeted verb outside this set) falls back to a
 * page-level signal so a targetless act never gets a false "unchanged". */
const ELEMENT_STATE_VERBS: ReadonlySet<Op> = new Set(['fill', 'select', 'check', 'uncheck']);

function elementStateSignal(verb: Op, el: ElementRecord): string {
  if (verb === 'fill') return el.state.filled ? 'filled' : 'empty';
  if (verb === 'select') return el.state.selected !== undefined ? `selected: ${el.state.selected}` : 'unknown';
  return el.state.checked ? 'checked' : 'unchecked'; // check / uncheck
}

/** A short, stable, cheap string hash (FNV-ish) — never a value itself, just
 * a fingerprint of `obs.text` so the click-family page-level signal below
 * can detect a text change without carrying the whole text around. */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** § outcome evidence (widened 2026-09-28, operator: a same-title/same-url
 * click that visibly changes the page — e.g. "click Add Element" twice,
 * which appends a Delete button each time — must NOT read as unchanged).
 * The click-family page-level signal: url, title, a short hash of obs.text,
 * the element count, and — when the acted element itself is still findable —
 * its own state and obscured flag. All of it is already on every obs; zero
 * new driver calls. 'no visible change' only when every part matches. */
function pageSignal(obs: Observation, el?: ElementRecord): string {
  const parts = [obs.url, obs.title, shortHash(obs.text), String(obs.elements.length)];
  if (el) parts.push(JSON.stringify(el.state), String(el.obscured ?? false));
  return parts.join('\u0000');
}

/** The outcome signal for one (verb, el, obs) at either end of an act: the
 * pre-act `before` and the post-act `result` are the same function applied to
 * two different observations. `el` is the acted-on element from THAT obs
 * (undefined for a targetless/binding-only verb, which never gets a signal —
 * no per-element state exists to read and no extra page call is added). */
function outcomeSignal(verb: Op, el: ElementRecord | undefined, obs: Observation): string | undefined {
  if (ELEMENT_STATE_VERBS.has(verb) && el) return elementStateSignal(verb, el);
  if (el) return pageSignal(obs, el); // click-family: cheap page-level signal
  return undefined; // targetless / binding-only verb: no signal, no guard, no result
}

/** § outcome evidence choke point: run once at the top of every round, right
 * after the fresh obs is fetched. Fills the LAST history entry's `result`
 * (never touches earlier entries — each is annotated exactly once, on the
 * round right after its act) by re-reading the same acted-on element from the
 * fresh obs; 'element gone' when it can no longer be found. Zero new driver
 * calls. Covers chain, legacy and token-consuming paths alike: they all
 * re-enter this same loop top. */
function annotateLastOutcome(history: HistoryEntry[], obs: Observation): HistoryEntry[] {
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.result !== undefined || last.before === undefined) return history;
  let result: string;
  if (last.path !== undefined) {
    const fresh = obs.elements.find(
      (e) => e.path === last.path && (last.fingerprint === undefined || fingerprintMatches(e.fingerprint, last.fingerprint)),
    );
    result = fresh ? elementStateSignal(last.verb, fresh) : 'element gone';
    if (!ELEMENT_STATE_VERBS.has(last.verb)) {
      // click-family el-targeted verb: fall back to the page-level signal,
      // same shape `before` was computed with, unless the element is gone.
      result = fresh ? (pageSignal(obs, fresh) !== last.before ? 'page changed' : 'no visible change') : 'element gone';
    }
  } else {
    result = pageSignal(obs) !== last.before ? 'page changed' : 'no visible change';
  }
  const updated: HistoryEntry = { ...last, result };
  return [...history.slice(0, -1), updated];
}

/** § outcome evidence WP-B: true when `decision` repeats the exact same
 * (verb, element path) as the last recorded act AND that act's observed
 * result (per annotateLastOutcome, already computed from this round's fresh
 * obs before decision-making) is identical to its pre-act baseline — i.e.
 * the act had no observable effect. Targetless/binding-only verbs (no
 * `decision.el`) never match: they carry no path and no signal. */
function isNoProgress(
  decision: { el: ElementRecord | null; verb: Op },
  history: HistoryEntry[],
  currentStepKey: string,
): boolean {
  if (history.length === 0 || decision.el === null) return false;
  const last = history[history.length - 1];
  if (
    last.path === undefined ||
    last.path !== decision.el.path ||
    last.verb !== decision.verb ||
    last.result === undefined ||
    last.stepKey !== currentStepKey
  ) {
    return false;
  }
  // Element-state verbs store the SAME kind of signal in `before` and
  // `result` (both from elementStateSignal), so they compare directly:
  // 'empty' === 'empty' means the fill never took. Click-family verbs store
  // the raw page-level signal in `before` but a already-compared VERDICT
  // word in `result` ('page changed' / 'no visible change') — comparing
  // `result === before` there would never match (a word never equals a raw
  // url+title+hash string), so 'no visible change' IS the no-progress signal
  // for them.
  return ELEMENT_STATE_VERBS.has(last.verb) ? last.result === last.before : last.result === 'no visible change';
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

/** § 5.5.3 fit check (B2-E3). upload only fits a file input; no other verb
 * fits one; dblclick/hover/scroll_to fit any non-file element. */
function opFits(verb: Op, el: ElementRecord): boolean {
  if (isFileInput(el)) return verb === 'upload';
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
    case 'dblclick':
    case 'hover':
    case 'scroll_to':
      return true;
    default:
      return true; // click and the targetless wheel fit anything else
  }
}

/** § 5.4 top-candidate margin rule applied to the action (verb) probabilities:
 * the highest-probability offered op commits when it reaches
 * TAKEOVER_MARGIN_FLOOR and out-scores every other entry by at least
 * TAKEOVER_MARGIN_RATIO. */
function marginCommitOp(probs: Record<string, number>, ops: readonly Op[]): string | null {
  let top: string | null = null;
  let topProb = 0;
  for (const op of ops) {
    const p = probs[op] ?? 0;
    if (p > topProb) {
      top = op;
      topProb = p;
    }
  }
  if (top === null || topProb < TAKEOVER_MARGIN_FLOOR) return null;
  for (const [id, p] of Object.entries(probs)) {
    if (id === top) continue;
    if (p * TAKEOVER_MARGIN_RATIO > topProb) return null;
  }
  return top;
}

/** § 3.19 top-candidate margin rule (amendment 2026-09-22). Returns the id of
 * the highest-probability listed element when its probability reaches
 * TAKEOVER_MARGIN_FLOOR and out-scores every OTHER entry in the probability map
 * — every other listed element AND every non-element answer (`none`,
 * `ambiguous`) — by at least TAKEOVER_MARGIN_RATIO; null otherwise. The caller
 * acts on the returned element, including when the answer's own choice was a
 * meta-answer. */
function marginCommitTarget(
  probs: Record<string, number>,
  elements: Array<ElementRecord>,
): string | null {
  let topId: string | null = null;
  let topProb = 0;
  for (const e of elements) {
    const p = probs[e.id] ?? 0;
    if (p > topProb) {
      topId = e.id;
      topProb = p;
    }
  }
  if (topId === null || topProb < TAKEOVER_MARGIN_FLOOR) return null;
  for (const [id, p] of Object.entries(probs)) {
    if (id === topId) continue;
    if (p * TAKEOVER_MARGIN_RATIO > topProb) return null;
  }
  return topId;
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

// Value-question anchor (§ 3.7 rule 8, amendment 2026-09-21e): on
// browse_step-originated rounds whose proposal names a supplied binding, the
// value question is anchored, not re-rolled — the proposal itself carries the
// value, so a below-threshold grade must not bounce `no-value`. The anchor is
// static text appended to the value question's instruction; the value itself
// stays withheld (redaction unchanged).
export const VALUE_ANCHOR_SENTENCE =
  "The calling agent's proposal explicitly supplies the value for this element; treat a value as present.";

/** Binding names the entry step text mentions (case-insensitive), in order of
 * first mention. The proposal "carries" a value binding when its step text
 * names one; names survive redaction, values never do. */
function bindingsInStep(step: string, values: Record<string, string>): string[] {
  const lower = step.toLowerCase();
  return Object.keys(values)
    .map((name) => ({ name, at: lower.indexOf(name.toLowerCase()) }))
    .filter((b) => b.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((b) => b.name);
}

/** Appends the value-question anchor before the fixed untrusted-data sentence,
 * which always stays last (§ 3.6). No-op when the request carries no value
 * question. Static text only — never a value. */
function anchorValueQuestion(request: JevRequest): void {
  const q = request.questions.value;
  if (q && q.type === 'choice') {
    q.instructions = q.instructions.replace(
      ` ${UNTRUSTED_SENTENCE}`,
      ` ${VALUE_ANCHOR_SENTENCE} ${UNTRUSTED_SENTENCE}`,
    );
  }
}

/** Outcome of the native-select option requests (§ 3.6 / § 3.7 rule 8). */
type OptionOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'no-value' }
  | { kind: 'budget-time' }
  | { kind: 'ask-failed'; error: string };

// ---------------------------------------------------------------------------
// § 5.5.1 validators. Each returns { ok: false, message } on failure; the
// caller turns that into error/invalid-input with the note
// `Invalid input: <message>` (§ 5.5.5 rule 2), for all three tools.
// ---------------------------------------------------------------------------

/** wingman_do validation: its § 3.11 rules, reported with messages. */
export function validateDoInput(
  x: unknown,
): { ok: true; input: DoInput } | { ok: false; message: string } {
  if (!isPlainObject(x)) return { ok: false, message: 'arguments must be an object with at least a goal.' };
  const o = x as Record<string, unknown>;
  const allowed = new Set(['goal', 'values', 'url_match', 'confirm_token', 'max_steps', 'max_ms']);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      return { ok: false, message: `unknown argument ${cut40(key)}; allowed: goal, values, url_match, confirm_token, max_steps, max_ms.` };
    }
  }
  if (typeof o.goal !== 'string' || o.goal.length < 1 || o.goal.length > 500) {
    return { ok: false, message: 'goal must be a non-empty string of at most 500 characters.' };
  }
  if (o.values !== undefined) {
    if (!isPlainObject(o.values)) return { ok: false, message: 'values must be an object of at most 20 entries.' };
    const entries = Object.entries(o.values);
    if (entries.length > 20) return { ok: false, message: 'values must be an object of at most 20 entries.' };
    for (const [name, value] of entries) {
      if (!BINDING_RE.test(name)) {
        return { ok: false, message: `value name ${cut40(name)} is invalid; use lowercase letters, digits and underscores, starting with a letter.` };
      }
      if (typeof value !== 'string' || value.length > 2000) {
        return { ok: false, message: `value ${cut40(name)} must be text of at most 2000 characters.` };
      }
    }
  }
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false, message: 'url_match must be a string of at most 200 characters.' };
  }
  if (o.confirm_token !== undefined && (typeof o.confirm_token !== 'string' || o.confirm_token.length > 64)) {
    return { ok: false, message: 'confirm_token must be the string returned by needs_confirmation.' };
  }
  if (o.max_steps !== undefined) {
    const maxStepsRaw = o.max_steps;
    if (typeof maxStepsRaw !== 'number' || !Number.isInteger(maxStepsRaw) || maxStepsRaw < 1 || maxStepsRaw > 8) {
      return { ok: false, message: 'max_steps must be an integer from 1 to 8.' };
    }
  }
  if (o.max_ms !== undefined) {
    const maxMsRaw = o.max_ms;
    if (typeof maxMsRaw !== 'number' || !Number.isInteger(maxMsRaw) || maxMsRaw < 1000 || maxMsRaw > 50000) {
      return { ok: false, message: 'max_ms must be an integer from 1000 to 50000.' };
    }
  }
  return { ok: true, input: o as unknown as DoInput };
}

/** wingman_check validation: its § 3.11 rules, reported with messages. */
export function validateCheckInput(
  x: unknown,
): { ok: true; input: CheckInput } | { ok: false; message: string } {
  if (!isPlainObject(x)) return { ok: false, message: 'arguments must be an object with a question.' };
  const o = x as Record<string, unknown>;
  const allowed = new Set(['question', 'url_match']);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      return { ok: false, message: `unknown argument ${cut40(key)}; allowed: question, url_match.` };
    }
  }
  if (typeof o.question !== 'string' || o.question.length < 1 || o.question.length > 300) {
    return { ok: false, message: 'question must be a non-empty string of at most 300 characters.' };
  }
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false, message: 'url_match must be a string of at most 200 characters.' };
  }
  return { ok: true, input: o as unknown as CheckInput };
}

/** § 3.17 browse_step schema (§ 5.5.1, B2-E2). */
export interface StepInput {
  goal: string;
  step?: string;
  steps?: string[];
  values?: Record<string, string>;
  pick?: PickInput;
  url_match?: string;
  confirm_token?: string;
  takeover?: boolean;
  max_steps?: number;
  max_ms?: number;
}

/** § 5.5.1 browse_step validation (C1). Forgiving normalisations run before
 * the checks, in this order: (1) finite numbers and booleans in values become
 * strings; (2) neither step nor steps → steps = [goal cut to 300]; (3) both →
 * steps = [step, ...steps], cut to 12. After normalisation `steps` present
 * means chain mode and `step` alone means legacy mode. */
export function validateStepInput(
  x: unknown,
): { ok: true; input: StepInput } | { ok: false; message: string } {
  if (!isPlainObject(x)) {
    return { ok: false, message: 'arguments must be an object with at least a goal.' };
  }
  const o = x as Record<string, unknown>;
  const allowed = new Set([
    'goal', 'step', 'steps', 'values', 'pick', 'url_match', 'confirm_token', 'takeover', 'max_steps', 'max_ms',
  ]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        message: `unknown argument ${cut40(key)}; allowed: goal, steps, step, values, pick, url_match, confirm_token, takeover, max_steps, max_ms.`,
      };
    }
  }
  if (typeof o.goal !== 'string' || o.goal.length < 1 || o.goal.length > 2000) {
    return { ok: false, message: 'goal must be a non-empty string of at most 2000 characters; move detail into steps.' };
  }
  // Normalisation 1: numbers and booleans in values become strings.
  if (isPlainObject(o.values)) {
    for (const [name, value] of Object.entries(o.values)) {
      if (typeof value === 'number' && Number.isFinite(value)) o.values[name] = String(value);
      else if (typeof value === 'boolean') o.values[name] = String(value);
    }
  }
  // Normalisation 2: neither step nor steps → steps from the goal.
  const hasStep = o.step !== undefined;
  const hasSteps = o.steps !== undefined;
  if (!hasStep && !hasSteps) {
    o.steps = [(o.goal as string).slice(0, 300)];
  } else if (hasStep && hasSteps && Array.isArray(o.steps)) {
    // Normalisation 3: both present → steps = [step, ...steps], cut to 12.
    o.steps = [o.step as string, ...(o.steps as unknown[])].slice(0, 12);
  }
  const stepsNow = o.steps;
  if (stepsNow !== undefined) {
    if (!Array.isArray(stepsNow) || stepsNow.length < 1 || stepsNow.length > 12) {
      return { ok: false, message: 'steps must be an array of 1 to 12 non-empty strings of at most 300 characters; merge or shorten steps, or send the rest on the next call.' };
    }
    for (const s of stepsNow) {
      if (typeof s !== 'string' || s.length < 1 || s.length > 300) {
        return { ok: false, message: 'steps must be an array of 1 to 12 non-empty strings of at most 300 characters; merge or shorten steps, or send the rest on the next call.' };
      }
    }
  }
  if (stepsNow === undefined && hasStep) {
    if (typeof o.step !== 'string' || o.step.length < 1 || o.step.length > 300) {
      return { ok: false, message: 'step must be a non-empty string of at most 300 characters.' };
    }
  }
  if (o.values !== undefined) {
    if (!isPlainObject(o.values)) return { ok: false, message: 'values must be an object of at most 20 entries.' };
    const entries = Object.entries(o.values);
    if (entries.length > 20) return { ok: false, message: 'values must be an object of at most 20 entries.' };
    for (const [name, value] of entries) {
      if (!BINDING_RE.test(name)) {
        return { ok: false, message: `value name ${cut40(name)} is invalid; use lowercase letters, digits and underscores, starting with a letter.` };
      }
      if (typeof value !== 'string' || value.length > 2000) {
        return { ok: false, message: `value ${cut40(name)} must be text of at most 2000 characters.` };
      }
    }
  }
  // § 5.5.1 missing-binding check: every `value named x` the goal or steps
  // mention must exist in values.
  const mentioned = `${typeof o.goal === 'string' ? o.goal : ''}\n${
    Array.isArray(stepsNow) ? (stepsNow as string[]).join('\n') : ''
  }\n${typeof o.step === 'string' ? o.step : ''}`;
  for (const match of mentioned.matchAll(VALUE_NAMED_RE)) {
    const name = match[1].toLowerCase();
    if (!isPlainObject(o.values) || !(name in o.values)) {
      return { ok: false, message: `the steps name the value ${name}, which is missing from values; add values.${name}.` };
    }
  }
  // pick
  const valuesForPick = isPlainObject(o.values) ? (o.values as Record<string, string>) : {};
  if (o.pick !== undefined) {
    if (o.confirm_token !== undefined) {
      return { ok: false, message: 'pick and confirm_token cannot be combined; send confirm_token alone to confirm, or pick alone.' };
    }
    if (!validatePick(o.pick, valuesForPick).ok) {
      return { ok: false, message: 'pick needs action, plus role and name for element actions, and value (the name of a binding in values) for fill, select, navigate and upload.' };
    }
  }
  if (o.url_match !== undefined && (typeof o.url_match !== 'string' || o.url_match.length > 200)) {
    return { ok: false, message: 'url_match must be a string of at most 200 characters.' };
  }
  if (o.confirm_token !== undefined && (typeof o.confirm_token !== 'string' || o.confirm_token.length > 64)) {
    return { ok: false, message: 'confirm_token must be the string returned by needs_confirmation.' };
  }
  if (o.takeover !== undefined && typeof o.takeover !== 'boolean') {
    return { ok: false, message: 'takeover must be true or false.' };
  }
  if (o.max_steps !== undefined) {
    const maxStepsRaw = o.max_steps;
    if (typeof maxStepsRaw !== 'number' || !Number.isInteger(maxStepsRaw) || maxStepsRaw < 1 || maxStepsRaw > 24) {
      return { ok: false, message: 'max_steps must be an integer from 1 to 24.' };
    }
  }
  if (o.max_ms !== undefined) {
    const maxMsRaw = o.max_ms;
    if (typeof maxMsRaw !== 'number' || !Number.isInteger(maxMsRaw) || maxMsRaw < 1000 || maxMsRaw > 120000) {
      return { ok: false, message: 'max_ms must be an integer from 1000 to 120000.' };
    }
  }
  return { ok: true, input: o as unknown as StepInput };
}

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
  // The browse_step goal text, set by runBrowse (the escalation counter's key;
  // null for wingman_do and wingman_check, which never escalate).
  let activeGoal: string | null = null;
  // § 5.5.5 note inputs: the validation message and the pick-mismatch flag.
  let invalidMessage = '';
  let pickUnmatched = false;
  // § 5.5.8 log record inputs.
  let pickRan = false;
  const actsByOp: Partial<Record<Op, number>> = {};
  // § 5.5.2 chain state for this call, when browse_step runs chain mode.
  let chainState: ChainState | null = null;

  // Per-phase wall-time capture (ms). Numbers only — never page text.
  // `cur` is the round bucket the current ask/act/settle belongs to. The
  // non-timing fields (§ telemetry, WP-outcome-evidence WP-C) are labels and
  // probabilities already sent to Jev and returned in results — never raw
  // page text or a bound value.
  type PhaseRound = {
    observeMs: number; jevMs: number; actMs: number; settleMs: number;
    action?: string; actionP?: number;
    target1?: string; target1P?: number; target2?: string; target2P?: number;
    historyResult?: string;
  };
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

  /** Telemetry (WP-outcome-evidence WP-C): the round's chosen action and the
   * target's top-1/top-2 candidates, with probabilities — ids and
   * probabilities only (already sent to Jev as criteria and returned in
   * results), never a raw value or page text beyond that. */
  const recordDecisionTelemetry = (answers: AnswerMap): void => {
    if (!cur) return;
    const action = answers['action'];
    if (action && action.type === 'choice') {
      cur.action = action.choice;
      const p = action.probabilities?.[action.choice];
      if (p !== undefined) cur.actionP = p;
    }
    const target = answers['target'];
    if (target && target.type === 'choice') {
      const ranked = Object.entries(target.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
      if (ranked[0]) {
        cur.target1 = ranked[0][0];
        cur.target1P = ranked[0][1];
      }
      if (ranked[1]) {
        cur.target2 = ranked[1][0];
        cur.target2P = ranked[1][1];
      }
    }
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

  /** § 5.5.5 forced note table: the first matching row wins, top to bottom. */
  const forcedNote = (r: WingmanResult): string => {
    const why = r.step_review?.why;
    if (r.reason === 'step-uncertain') {
      if (why === 'already-done') return FORCED_ALREADY_DONE_LINE;
      if (why === 'wrong-page') return FORCED_WRONG_PAGE_LINE;
      if (why === 'not-ready') return FORCED_NOT_READY_LINE;
      return FORCED_BOUNCE_LINE;
    }
    if (r.reason === 'target-covered' || r.reason === 'no-progress') return FORCED_BOUNCE_LINE;
    if (r.reason === 'takeover-offered') return FORCED_OFFER_LINE;
    if (r.status === 'login') return FORCED_LOGIN_LINE;
    if (r.reason === 'dialog-open') return FORCED_DIALOG_LINE;
    if (r.reason === 'page-error') return FORCED_PAGE_ERROR_LINE;
    if (r.reason === 'no-key' || r.reason === 'no-browser' || r.reason === 'breaker-open') {
      return FORCED_UNAVAILABLE_LINE;
    }
    if (r.reason === 'tab-ambiguous') return FORCED_TAB_LINE;
    if (r.reason === 'no-value') return FORCED_VALUE_LINE;
    if (r.status === 'blocked' && r.reason !== 'lock-held' && r.reason !== 'busy') {
      return FORCED_BLOCKED_LINE;
    }
    return FORCED_RESUME_LINE;
  };

  // Exactly one log record per call; log errors never mask the tool result.
  // Every return path of runTool goes through finish(), so the § 5.5.2 chain
  // memory write-back (delete on done, store otherwise, including the catch)
  // lives here too.
  const finish = async (r: WingmanResult): Promise<WingmanResult> => {
    if (chainState) {
      // § 5.5.2 progress on every chain-mode result.
      if (r.progress === undefined) {
        r.progress = {
          step_index: Math.min(chainState.cursor + 1, chainState.N),
          steps_done: chainState.cursor,
          steps_total: chainState.N,
        };
      }
      // Memory write-back: done deletes, anything else stores.
      chainMemory.delete(chainState.key);
      if (r.status !== 'done') {
        chainMemory.set(chainState.key, {
          cursor: chainState.cursor,
          acts: chainState.priorActs + steps,
        });
        while (chainMemory.size > CHAIN_MEMORY_MAX) {
          const oldest = chainMemory.keys().next().value;
          if (oldest === undefined) break;
          chainMemory.delete(oldest);
        }
      }
    }
    if (r.status === 'fallback' && (r.reason.startsWith('sensitive-') || r.reason === 'unsupported-page')) {
      // § 5.5.5 rule 1 (Q4): forced browse_step AND wingman_do get the forced
      // line; wingman_check always reads, so it keeps the old line.
      r.note =
        tool !== 'wingman_check' && handoffOf(deps.config).mode === 'forced'
          ? FORCED_SENSITIVE_LINE
          : SENSITIVE_LINE;
    } else if (r.reason === 'invalid-input') {
      // § 5.5.5 rule 2: all three tools name the argument to fix.
      r.note = `Invalid input: ${invalidMessage}`;
    } else if (tool === 'wingman_do' && r.status !== 'done') {
      r.note = CONTINUE_LINE;
    } else if (tool === 'browse_step' && r.status !== 'done') {
      // § 5.5.5 rule 4.
      if (pickUnmatched) {
        r.note = PICK_UNMATCHED_LINE;
      } else if (r.reason === 'unsupported-op') {
        r.note = UNSUPPORTED_OP_LINE;
      } else if (r.reason === 'state-too-large') {
        r.note = STATE_TOO_LARGE_LINE;
      } else if (r.missing_binding !== undefined) {
        r.note = `the steps name the value ${r.missing_binding}, which is missing from values; add values.${r.missing_binding}.`;
      } else if (handoffOf(deps.config).mode === 'forced') {
        // § 5.5.5 rule 4e: the forced table; the bounce counter is untouched.
        r.note = forcedNote(r);
      } else {
        // § 3.17 note table (amendment 2026-09-21d): done carries no note;
        // step-uncertain the caller line; takeover-offered the offer line;
        // every other non-done status the resume line. Amendment 2026-09-22:
        // a BOUNCE (step-uncertain, target-covered) escalates by the goal's
        // prior bounce count — tier 1 appends the retry-or-take-over sentence
        // to the static note, tiers 2/3 replace it. Offers, loop bounds and
        // every other non-done end keep the static table unchanged.
        const base =
          r.reason === 'step-uncertain' || r.reason === 'no-progress'
            ? BROWSE_STEP_CALLER_LINE
            : r.reason === 'takeover-offered'
              ? BROWSE_STEP_OFFER_LINE
              : BROWSE_STEP_RESUME_LINE;
        if ((r.reason === 'step-uncertain' || r.reason === 'target-covered') && activeGoal !== null) {
          const n = (bounceCounts.get(activeGoal) ?? 0) + 1;
          bounceCounts.set(activeGoal, n);
          r.note = n === 1 ? `${base} ${BOUNCE_TIER1_LINE}` : n === 2 ? BOUNCE_TIER2_LINE : BOUNCE_TIER3_LINE;
        } else {
          r.note = base;
        }
      }
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
      ...(r.progress ? { progress: r.progress } : {}),
      ...(pickRan ? { pick: true as const } : {}),
      ...(Object.keys(actsByOp).length > 0 ? { acts_by_op: actsByOp } : {}),
      // No-progress telemetry (WP-outcome-evidence WP-C): why + a candidate
      // COUNT only, never the candidate labels. Feeds bench's why breakdown
      // (handoffRecordsFromLog parses log.jsonl, so it has to ride here).
      ...(r.step_review ? { step_review: { why: r.step_review.why, candidates: r.step_review.candidates.length } } : {}),
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
    history: HistoryEntry[],
    goal: string | null,
    values: Record<string, string>,
    step?: string,
    chain?: { stepNumber: number; stepsTotal: number },
  ): object {
    const raw: Record<string, unknown> = {
      url: scrubUrl(obs.url),
      title: obs.title,
      text: obs.text,
      truncated: obs.truncated,
    };
    if (goal !== null) {
      raw.goal = goal;
      // Outcome evidence (§ WP-A): each entry's observed result, when known,
      // rides alongside verb/label. Identity (path/fingerprint) and the
      // pre-act baseline never leave this function.
      raw.history = history.map((h) => ({
        verb: h.verb,
        label: h.label,
        ...(h.result !== undefined ? { result: h.result } : {}),
      }));
    }
    // § 3.19 flow item 4: round 1 of a takeover entry carries the proposed
    // step text (already redacted and cut to 300 by the caller); rounds ≥ 2
    // never do. In chain mode every round carries the current clause
    // (§ 5.5.2 step 5) plus the chain position.
    if (step !== undefined) {
      raw.step = step;
    }
    if (chain !== undefined) {
      raw.step_number = chain.stepNumber;
      raw.steps_total = chain.stepsTotal;
    }
    return redactDeep(raw, values);
  }

  /** § 5.5.7 state-size sizing (orchestrator decision, 2026-09-27): the size
   * measured against budgets.max_state_chars is JSON.stringify(state).length
   * PLUS the serialized length of the single longest question in the built
   * request — not the bare state alone (which would miss the element list
   * riding in the target question's criteria) and not the whole request
   * (whose ~4900 chars of fixed per-round question overhead makes the
   * documented 2000 floor dead for chain mode). See src/core/CLAUDE.md. */
  function requestSize(request: JevRequest): number {
    const stateLen = JSON.stringify(request.state).length;
    let maxQuestion = 0;
    for (const q of Object.values(request.questions)) {
      const qLen = JSON.stringify(q).length;
      if (qLen > maxQuestion) maxQuestion = qLen;
    }
    return stateLen + maxQuestion;
  }

  /** § 5.5.7 state-size rule (C10): applied to every ask round of wingman_do
   * and browse_step. Above budgets.max_state_chars the state text is cut to
   * fit; if the payload still cannot fit (a page whose element table alone is
   * over the limit) the caller returns fallback/state-too-large with zero
   * acts. wingman_check is unchanged. `requestOf` extracts the JevRequest
   * actually sent from `build`'s return value, since the two-stage and
   * single-round builders return different shapes. */
  function withStateSize<T>(
    state0: object,
    build: (s: object) => T,
    requestOf: (payload: T) => JevRequest,
  ): { ok: true; payload: T; state: object } | { ok: false } {
    const maxSize = deps.config.budgets.max_state_chars;
    let s = state0;
    let payload = build(s);
    const len = requestSize(requestOf(payload));
    if (len > maxSize) {
      const excess = len - maxSize;
      const text = (s as { text?: string }).text ?? '';
      s = { ...s, text: text.slice(0, Math.max(0, text.length - excess)) };
      payload = build(s);
      if (requestSize(requestOf(payload)) > maxSize) return { ok: false };
    }
    return { ok: true, payload, state: s };
  }

  /** § 5.6 / B2-E7: candidate evidence mapped through candidateOf, which
   * redacts and carries role and name, skipping ids absent from the page. */
  function topTargetCandidates(
    answers: AnswerMap,
    obs: Observation,
    values: Record<string, string>,
  ): Array<{ label: string; role?: string; name?: string }> {
    const target = answers['target'] as JevChoiceAnswer | undefined;
    if (!target) return [];
    return Object.entries(target.probabilities)
      .filter(([id]) => id !== 'none' && id !== 'ambiguous')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .flatMap(([id]) => {
        const el = obs.elements.find((e) => e.id === id);
        return el ? [candidateOf(el, values)] : [];
      });
  }

  /** § 5.5.1 missing-binding lookup at run time: the first `value named x` in
   * the current step text that names no supplied binding. */
  function missingOf(text: string, values: Record<string, string>): string | undefined {
    for (const m of text.matchAll(VALUE_NAMED_RE)) {
      const name = m[1].toLowerCase();
      if (!(name in values)) return name;
    }
    return undefined;
  }

  /** § 3.7 rules 1–5 (§ 5.5.4 amended order: done precedes error, C2), plus
   * the § 5.5.4 recover read for legacy browse_step. Null = continue to the
   * decide step. Used by the legacy browse_step entry and wingman_do; chain
   * mode has its own early rules (§ 5.5.2 step 7). */
  function decideEarly(
    answers: AnswerMap,
    round: number,
    obs: Observation,
    values: Record<string, string>,
    legacyRecoverActs: number,
    hasOp: (op: Op) => boolean,
  ): { result: WingmanResult } | { mechanical: Op } | { recovered: true } | null {
    const noulOf = (id: string): number => {
      const a = answers[id];
      return a && a.type === 'noul' ? a.noul : 0;
    };
    // 1. login
    if (noulOf('login') >= THRESHOLDS.login) {
      return { result: mk('login', 'login-page') };
    }
    // 2. blocked
    if (noulOf('blocked') >= THRESHOLDS.blocked) {
      return { result: mk('blocked', 'page-blocked') };
    }
    // 3. done (C2: done now precedes error)
    if (noulOf('done') >= THRESHOLDS.done) {
      return { result: mk('done', 'goal-met') };
    }
    // 4. error (round ≥ 2 only; the question is only asked then)
    if (round >= 2 && noulOf('error') >= THRESHOLDS.error) {
      if (tool !== 'browse_step') {
        // wingman_do keeps error → page-error and is never asked recover.
        return { result: mk('error', 'page-error') };
      }
      // § 5.5.4 recover, exactly as chain rule 4; the counter is per call.
      const rec = answers['recover'] as JevChoiceAnswer | undefined;
      const rc = rec?.choice;
      const r =
        rec && typeof rc === 'string' && (rec.probabilities[rc] ?? 0) >= THRESHOLDS.recover ? rc : 'give-up';
      if (r === 'give-up' || legacyRecoverActs >= RECOVER_MAX_PER_CLAUSE) {
        return { result: mk('error', 'page-error') };
      }
      if (r === 'back' || r === 'reload' || r === 'wait') {
        if (hasOp(r)) {
          return { mechanical: r };
        }
        return { result: mk('error', 'page-error') };
      }
      // 'continue' (and anything unrecognized below threshold) falls through.
      if (r !== 'continue') {
        return { result: mk('error', 'page-error') };
      }
      return { recovered: true };
    }
    // 5. action none
    const action = answers['action'] as JevChoiceAnswer | undefined;
    if (action && action.choice === 'none') {
      if (noulOf('done') >= THRESHOLDS.doneNoAction) {
        return { result: mk('done', 'goal-met') };
      }
      return { result: mk('ambiguous', 'no-action', { candidates: topTargetCandidates(answers, obs, values) }) };
    }
    return null;
  }

  /** § 3.7 rules 6–8 plus § 5.5.3: targetless verbs, the navigate/upload
   * binding answers, the press key answer, the file-input conversion and the
   * scroll_to → scroll fallback. `actionAnswers` is the request that carried
   * the `action` question (request 1 in both shapes). `takeover` is true for
   * every browse_step round; wingman_do rounds use the plain threshold rule. */
  async function decideTarget(
    answers: AnswerMap,
    actionAnswers: AnswerMap,
    obs: Observation,
    values: Record<string, string>,
    state: object,
    remaining: () => number,
    anchorBindings: string[] = [],
    takeover = false,
    offeredSet?: ReadonlySet<string>,
  ): Promise<{
    result?: WingmanResult;
    bounds?: boolean;
    el: ElementRecord | null;
    verb: Op;
    binding?: string;
    optionValue?: string;
    keyMissing?: boolean;
  }> {
    const action = actionAnswers['action'] as JevChoiceAnswer | undefined;
    // Answers are untrusted: an out-of-set action choice (never offered,
    // § 5.5.6), a target id that is not in the observation, or a value choice
    // naming no real binding must resolve to an ambiguous decision — never to
    // an act on some other element.
    const uncertain = (keyMissing = false) => ({
      ...(keyMissing ? { keyMissing: true as const } : {}),
      result: mk('ambiguous', 'target-uncertain', { candidates: topTargetCandidates(answers, obs, values) }),
      el: obs.elements[0] ?? null,
      verb: 'click' as Op,
    });
    const rawVerb = action?.choice;
    const verbInOps: Op | null =
      typeof rawVerb === 'string' && (OPS as readonly string[]).includes(rawVerb) ? (rawVerb as Op) : null;
    if (verbInOps === null || (offeredSet !== undefined && !offeredSet.has(verbInOps))) {
      return uncertain();
    }
    let verb: Op = verbInOps;
    const target = answers['target'] as JevChoiceAnswer | undefined;
    const targetId = target?.choice ?? 'none';
    const targetProb = target ? (target.probabilities[targetId] ?? 0) : 0;
    // 6. target uncertainty — skipped for targetless verbs (§ 5.5.3).
    let el: ElementRecord | null = null;
    if (!(TARGETLESS_OPS as readonly string[]).includes(verb)) {
      let elId = targetId;
      if (takeover) {
        const threshold = takeoverOf(deps.config).threshold;
        const chosenElement =
          targetId !== 'none' && targetId !== 'ambiguous' && obs.elements.some((e) => e.id === targetId);
        if (!(chosenElement && targetProb >= threshold)) {
          const marginId = marginCommitTarget(target?.probabilities ?? {}, obs.elements);
          if (marginId === null) {
            // § 5.4 scroll_to row: a non-committing scroll_to target becomes a
            // targetless scroll down — never a non-commit.
            if (verb === 'scroll_to') {
              return { el: null, verb: 'scroll' };
            }
            return uncertain();
          }
          elId = marginId;
        }
      } else if (targetId === 'none' || targetId === 'ambiguous' || targetProb < THRESHOLDS.target) {
        if (verb === 'scroll_to') {
          return { el: null, verb: 'scroll' };
        }
        return uncertain();
      }
      const found = obs.elements.find((e) => e.id === elId);
      if (!found) {
        return uncertain();
      }
      el = found;
    }
    // 7. file-input conversion (§ 5.5.3) runs before the fit check; a click
    // therefore never opens the OS file chooser (P9).
    if (el !== null && (verb === 'click' || verb === 'dblclick' || verb === 'press') && isFileInput(el)) {
      verb = 'upload';
    }
    if (el !== null && !opFits(verb, el)) {
      return uncertain();
    }
    // 8. value
    let binding: string | undefined;
    let optionValue: string | undefined;
    if (verb === 'fill') {
      const valueAnswer = answers['value'] as JevChoiceAnswer | undefined;
      if (
        valueAnswer &&
        valueAnswer.choice !== 'none' &&
        valueAnswer.choice in values &&
        // Amendment 2026-09-21e: an anchored round (the browse_step proposal
        // names a supplied binding) treats a value as present — the grade
        // does not re-roll the caller's explicit supply. Unanchored rounds
        // keep the § 3.7 rule-8 threshold unchanged.
        (anchorBindings.length > 0 || (valueAnswer.probabilities[valueAnswer.choice] ?? 0) >= THRESHOLDS.value)
      ) {
        binding = valueAnswer.choice;
      } else if (anchorBindings.length > 0) {
        binding = anchorBindings[0];
      } else {
        const missing = missingOf(activeStepText, values);
        return {
          result: mk('ambiguous', 'no-value', missing !== undefined ? { missing_binding: missing } : {}),
          el,
          verb,
        };
      }
      if (!(binding in values)) {
        return { result: mk('ambiguous', 'no-value'), el, verb };
      }
    } else if (verb === 'select') {
        if (el === null) return uncertain();
      const valueAnswer = answers['value'] as JevChoiceAnswer | undefined;
      if (
        valueAnswer &&
        valueAnswer.choice !== 'none' &&
        valueAnswer.choice in values &&
        (valueAnswer.probabilities[valueAnswer.choice] ?? 0) >= THRESHOLDS.value
      ) {
        binding = valueAnswer.choice;
        const wanted = values[binding] ?? '';
        const local = (el?.options ?? []).find(
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
    } else if (verb === 'navigate') {
      // § 5.5.3: the binding comes from the url answer — a url-typed binding
      // at ≥ THRESHOLDS.url whose value is an http(s) address.
      const urlAnswer = answers['url'] as JevChoiceAnswer | undefined;
      const c = urlAnswer?.choice;
      if (
        urlAnswer &&
        typeof c === 'string' &&
        c !== 'none' &&
        c in values &&
        (urlAnswer.probabilities[c] ?? 0) >= THRESHOLDS.url &&
        typeHint(values[c]) === 'url' &&
        /^https?:\/\//i.test(values[c])
      ) {
        binding = c;
      } else {
        return { result: mk('ambiguous', 'no-value'), el, verb };
      }
    } else if (verb === 'upload') {
      // § 5.5.3: the binding comes from the file answer — a path-typed
      // binding at ≥ THRESHOLDS.file.
      const fileAnswer = answers['file'] as JevChoiceAnswer | undefined;
      const c = fileAnswer?.choice;
      if (
        fileAnswer &&
        typeof c === 'string' &&
        c !== 'none' &&
        c in values &&
        (fileAnswer.probabilities[c] ?? 0) >= THRESHOLDS.file &&
        isPathLike(values[c])
      ) {
        binding = c;
      } else {
        return { result: mk('ambiguous', 'no-value'), el, verb };
      }
    } else if (verb === 'press') {
      // § 5.5.3: press takes the key answer (∈ PRESS_KEYS, ≥ THRESHOLDS.key);
      // wingman_do falls back to 'Enter', browse_step reports the missing key.
      const keyAnswer = answers['key'] as JevChoiceAnswer | undefined;
      const c = keyAnswer?.choice;
      if (
        keyAnswer &&
        typeof c === 'string' &&
        (PRESS_KEYS as readonly string[]).includes(c) &&
        (keyAnswer.probabilities[c] ?? 0) >= THRESHOLDS.key
      ) {
        optionValue = c;
      } else if (takeover) {
        return { ...uncertain(true), keyMissing: true };
      } else {
        optionValue = 'Enter';
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

  /** The one fixed confirm-token point (§ WP-C7 item 3). § 5.5.6: a token
   * whose verb is not in driverOps is a typed unsupported-op, zero acts, and
   * in the token path `upload` takes `values[binding]` and `press` its key
   * from PendingAction.optionValue. */
  async function runTokenAction(
    pageId: string,
    driver: Driver,
    obs: Observation,
    token: string,
    values: Record<string, string>,
    maxSteps: number,
    remaining: () => number,
    history: HistoryEntry[],
    driverOps: readonly Op[],
    stepKey: string,
  ): Promise<{ result: WingmanResult | null; history: HistoryEntry[] }> {
    const action = deps.tokens.consume(token);
    if (!action) {
      return { result: mk('error', 'confirm-token-invalid'), history };
    }
    if (!(driverOps as readonly string[]).includes(action.verb)) {
      return { result: mk('fallback', 'unsupported-op'), history };
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
    } else if (action.verb === 'select' || action.verb === 'press') {
      actValue = action.optionValue;
    } else if (action.verb === 'upload' || action.verb === 'navigate') {
      const v = action.binding !== undefined ? values[action.binding] : undefined;
      if (v === undefined) {
        return { result: mk('error', 'invalid-input'), history };
      }
      actValue = v;
    }
    if (action.verb !== 'wait' && steps >= maxSteps) {
      return { result: mk('fallback', 'budget-steps'), history };
    }
    if (remaining() < TIME_FLOOR_MS) {
      return { result: mk('fallback', 'budget-time'), history };
    }
    const tAct0 = now();
    await driver.act(pageId, el.id, action.verb, actValue);
    if (cur) cur.actMs += now() - tAct0;
    if (action.verb === 'wait') {
      // never counts as a step (§ 5.5.3)
    } else {
      steps += 1;
    }
    actsByOp[action.verb] = (actsByOp[action.verb] ?? 0) + 1;
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
    return {
      result: null,
      history: [
        ...history,
        {
          verb: action.verb,
          label: el.name,
          path: el.path,
          fingerprint: el.fingerprint,
          before: outcomeSignal(action.verb, el, obs),
          stepKey,
        },
      ],
    };
  }

  const validated =
    tool === 'wingman_do'
      ? validateDoInput(input)
      : tool === 'browse_step'
        ? validateStepInput(input)
        : validateCheckInput(input);
  if (!validated.ok) {
    invalidMessage = validated.message;
    return finish(mk('error', 'invalid-input'));
  }

  if (!deps.mutex.tryAcquire()) {
    return finish(mk('blocked', 'busy'));
  }

  let attached = false;
  let driver: Driver | null = null;
  // § 5.5.6: read after attach; absent = LEGACY_OPS.
  let driverOps: readonly Op[] = LEGACY_OPS;
  // The step text the missing-binding detector reads this round; set per round
  // by runDoRounds (the chain clause, the legacy step, or '' for wingman_do).
  let activeStepText = '';

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

    driverOps = driver.ops ?? LEGACY_OPS;

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

  // ---- browse_step entry (§ 3.19, § 5.5.2, § 5.5.4) ----
  // Chain mode (steps present after § 5.5.1 normalisation) carries the clause
  // list and the per-clause memory; legacy mode keeps the first-round-decides
  // entry. Both ride runDoRounds' rounds; the pick (§ 5.6) rides round 1.
  async function runBrowse(pageId: string, driver: Driver, stepInput: StepInput): Promise<WingmanResult> {
    const values = stepInput.values ?? {};
    activeGoal = stepInput.goal; // the bounce-escalation counter's key

    // Participation (§ 3.19 flow item 5): the call's `takeover` field
    // overrides the config mode, resolved once here and carried by the entry.
    const participation: 'execute' | 'offer' =
      stepInput.takeover === true
        ? 'execute'
        : stepInput.takeover === false
          ? 'offer'
          : takeoverOf(deps.config).mode === 'offer'
            ? 'offer'
            : 'execute';

    const chain = stepInput.steps !== undefined;
    if (chain) {
      // § 5.5.2 memory: keyed on [goal, clauses]; values never enter the key.
      const clauses = stepInput.steps as string[];
      const key = JSON.stringify([stepInput.goal, clauses]);
      const mem = chainMemory.get(key);
      chainState = {
        key,
        clauses,
        N: clauses.length,
        cursor: mem?.cursor ?? 0,
        priorActs: mem?.acts ?? 0,
        clauseRetried: false,
        firstCommitDone: false,
        wrongPageRounds: 0,
        notReadyRounds: 0,
        recoverActs: 0,
      };
    }

    const pick = stepInput.pick;
    const entry =
      chain
        ? {
            kind: 'chain' as const,
            clauses: stepInput.steps as string[],
            participation,
            ...(pick ? { pick } : {}),
          }
        : stepInput.step !== undefined
          ? {
              kind: 'legacy' as const,
              step: stepInput.step,
              participation,
              ...(pick ? { pick } : {}),
            }
          : undefined;

    // Token continuation (§ 3.19 flow item 1): the token is handled at the
    // existing fixed point inside runDoRounds. Legacy keeps no entry (today's
    // path); chain keeps the clause list so the memory cursor applies.
    if (stepInput.confirm_token !== undefined) {
      return runDoRounds(
        pageId,
        driver,
        {
          goal: stepInput.goal,
          values,
          confirm_token: stepInput.confirm_token,
          ...(stepInput.max_steps !== undefined ? { max_steps: stepInput.max_steps } : {}),
          ...(stepInput.max_ms !== undefined ? { max_ms: stepInput.max_ms } : {}),
        },
        chain
          ? { kind: 'chain' as const, clauses: stepInput.steps as string[], participation }
          : undefined,
      );
    }

    return runDoRounds(
      pageId,
      driver,
      {
        goal: stepInput.goal,
        values,
        ...(stepInput.max_steps !== undefined ? { max_steps: stepInput.max_steps } : {}),
        ...(stepInput.max_ms !== undefined ? { max_ms: stepInput.max_ms } : {}),
      },
      entry,
    );
  }

  // ---- wingman_do rounds (§ 3.7, in order) plus the browse_step entry
  // decision (§ 3.19) and chain mode (§ 5.5.2) ----
  async function runDoRounds(
    pageId: string,
    driver: Driver,
    doInput: DoInput,
    entry?: {
      kind: 'chain';
      clauses: string[];
      participation: 'execute' | 'offer';
      pick?: PickInput;
    } | {
      kind: 'legacy';
      step: string;
      participation: 'execute' | 'offer';
      pick?: PickInput;
    },
  ): Promise<WingmanResult> {
    const values = doInput.values ?? {};
    const maxSteps = Math.min(doInput.max_steps ?? Number.POSITIVE_INFINITY, deps.config.budgets.max_steps);
    const maxMs = Math.min(doInput.max_ms ?? Number.POSITIVE_INFINITY, deps.config.budgets.max_ms);
    const remaining = () => maxMs - (now() - startedAt);
    const shadowResult = (): WingmanResult => mk('fallback', 'shadow', { shadow: true });
    let history: HistoryEntry[] = [];
    const token = doInput.confirm_token;
    let tokenHandled = false;
    let round = 0;
    const hasOp = (op: Op): boolean => (driverOps as readonly string[]).includes(op);
    const isBrowse = entry !== undefined;
    const participation = entry?.participation ?? 'execute';
    // § 5.5.6: the offered action set is always intersected with driverOps, so
    // Jev is never asked about an undeclared op.
    const offered: readonly Op[] = offeredOps({
      tool: isBrowse ? 'browse_step' : 'wingman_do',
      bindings: values,
    }).filter((op) => hasOp(op));
    const offeredSet = new Set<string>(offered);
    // Waits this call has executed (§ 5.5.2 / § 5.4 wait caps).
    let waits = 0;
    // § 5.5.4 recover acts for legacy browse_step (per call).
    let legacyRecoverActs = 0;
    // § outcome evidence WP-B scope rule 2 (orchestrator decision,
    // 2026-09-28): true for a round whose decision fell through from an
    // error+recover 'continue' — set by decideEarly/runChainEarly right
    // before their fallthrough `return null`, reset at the top of every
    // round. The no-progress guard defers to the existing recoverActs cap
    // (RECOVER_MAX_PER_CLAUSE, then page-error) for these rounds instead of
    // firing independently.
    let recoveredThisRound = false;

    /** A committed decision about to pass the gate and the act site. */
    interface Decision {
      el: ElementRecord | null;
      verb: Op;
      binding?: string;
      optionValue?: string;
      gate: boolean;
    }

    // Legacy entry state: `entryPending` is true while the next round's entry
    // decision is still due. `retried` pins the at-most-one retry of § 3.19.
    const entryStep = entry?.kind === 'legacy' ? redactValues(entry.step, values).slice(0, 300) : undefined;
    const entryBindings = entry?.kind === 'legacy' ? bindingsInStep(entry.step, values) : [];
    let entryPending = entry !== undefined;
    let retried = false;
    const retryAllowed = entry?.kind === 'legacy' && takeoverOf(deps.config).retry;
    type ReviewWhy = 'no-match' | 'multi-match' | 'low-confidence' | 'no-value' | 'offered' | 'target-covered'
      | 'already-done' | 'wrong-page' | 'not-ready';
    const entryReview = (why: ReviewWhy, candidates: Array<{ label: string; role?: string; name?: string }>) => ({
      step_review: { step: capLabel(entryStep ?? ''), why, candidates },
    });
    const bounce = (why: ReviewWhy, candidates: Array<{ label: string; role?: string; name?: string }>) =>
      mk('fallback', 'step-uncertain', entryReview(why, candidates));
    const canRetry = () => retryAllowed && !retried && remaining() >= TIME_FLOOR_MS;

    // Chain state (§ 5.5.2), created by runBrowse.
    const chain = entry?.kind === 'chain' ? chainState : null;
    const N = chain?.N ?? 0;
    const clauseText = (i: number): string => redactValues(chain!.clauses[i], values).slice(0, 300);
    const clauseReviewStep = () => capLabel(clauseText(Math.min(chain!.cursor, N - 1)));
    /** A wrong-page / not-ready bounce: no retry (§ 5.5.2 rules 5–6). */
    const chainBounce = (why: 'wrong-page' | 'not-ready'): WingmanResult =>
      mk('fallback', 'step-uncertain', { step_review: { step: clauseReviewStep(), why, candidates: [] } });
    /** § 5.5.2 rule 9: one retry per clause, then the bounce with evidence. */
    const chainNonCommit = (
      why: ReviewWhy,
      candidates: Array<{ label: string; role?: string; name?: string }>,
    ): WingmanResult | null => {
      if (takeoverOf(deps.config).retry && !chain!.clauseRetried && remaining() >= TIME_FLOOR_MS) {
        chain!.clauseRetried = true;
        return null; // the next round retries the clause
      }
      return mk('fallback', 'step-uncertain', { step_review: { step: clauseReviewStep(), why, candidates } });
    };
    /** § 5.5.2 end of chain. */
    const endOfChain = (): WingmanResult => {
      if (steps + chain!.priorActs > 0) {
        return mk('done', 'goal-met');
      }
      return mk('fallback', 'step-uncertain', {
        step_review: { step: capLabel(clauseText(N - 1)), why: 'already-done', candidates: [] },
      });
    };

    /** § 3.19 threshold-or-margin rule over the target answer (§ 5.5.2 rule 8
     * and § 3.19 item 3 share it): null = the round commits; else the `why` a
     * failed target commit reports. The threshold rule needs a real listed
     * element as the answer's choice; the top-candidate margin rule
     * (amendment 2026-09-22) does not — it commits on the dominating listed
     * element even when the answer chose the `ambiguous` or `none`
     * meta-answer. */
    function targetUncertainty(
      answers: AnswerMap,
      obs: Observation,
    ): 'no-match' | 'multi-match' | 'low-confidence' | null {
      const target = answers['target'] as JevChoiceAnswer | undefined;
      const choice = target?.choice;
      if (!target || typeof choice !== 'string') return 'no-match';
      const probs = target.probabilities ?? {};
      if (choice !== 'none' && choice !== 'ambiguous') {
        const el = obs.elements.find((e) => e.id === choice);
        if (!el) return 'no-match';
        if ((probs[choice] ?? 0) >= takeoverOf(deps.config).threshold) return null;
      }
      if (marginCommitTarget(probs, obs.elements) !== null) return null;
      if (choice === 'none') return 'no-match';
      if (choice === 'ambiguous') return 'multi-match';
      return 'low-confidence';
    }

    /** § 3.19 item 3: null = the entry round commits (threshold rule or
     * top-candidate margin rule), else the bounce `why`. § 5.4 Verb row / § 5.5.3:
     * a targetless verb commits on the ACTION probabilities; an action outside
     * the offered set is a no-match. */
    function entryUncertainty(
      answers: AnswerMap,
      obs: Observation,
    ): 'no-match' | 'multi-match' | 'low-confidence' | null {
      const action = answers['action'] as JevChoiceAnswer | undefined;
      const choice = action?.choice;
      if (!action || typeof choice !== 'string' || choice === 'none' || !offeredSet.has(choice)) {
        return 'no-match';
      }
      const probs = action.probabilities ?? {};
      if ((TARGETLESS_OPS as readonly string[]).includes(choice)) {
        if ((probs[choice] ?? 0) >= takeoverOf(deps.config).threshold) return null;
        return marginCommitOp(probs, offered) !== null ? null : 'low-confidence';
      }
      return targetUncertainty(answers, obs);
    }

    /** § 5.5.2 step 7 early answers, in order: login → blocked → advance →
     * error+recover → ready → right_page → action none. The first rule that
     * returns or moves to the next round wins; the whole-goal `done` is never
     * read in chain mode. */
    function runChainEarly(answers: AnswerMap, round: number, obs: Observation):
      | { kind: 'result'; result: WingmanResult }
      | { kind: 'advance' }
      | { kind: 'mechanical'; verb: Op }
      | { kind: 'settleOnly' }
      | { kind: 'nonCommit'; why: 'no-match'; candidates: Array<{ label: string; role?: string; name?: string }> }
      | { kind: 'bounceNotReady' }
      | { kind: 'bounceWrongPage' }
      | null {
      const noulOf = (id: string): number => {
        const a = answers[id];
        return a && a.type === 'noul' ? a.noul : 0;
      };
      // 1. login
      if (noulOf('login') >= THRESHOLDS.login) {
        return { kind: 'result', result: mk('login', 'login-page') };
      }
      // 2. blocked
      if (noulOf('blocked') >= THRESHOLDS.blocked) {
        return { kind: 'result', result: mk('blocked', 'page-blocked') };
      }
      // 3. advance (before the error rule, C2)
      const action = answers['action'] as JevChoiceAnswer | undefined;
      const stepDone = noulOf('step_done');
      if (stepDone >= THRESHOLDS.stepDone || (action?.choice === 'none' && stepDone >= THRESHOLDS.stepDoneNoAction)) {
        return { kind: 'advance' };
      }
      // 4. error and recover (round ≥ 2; the question rides only then)
      if (round >= 2 && noulOf('error') >= THRESHOLDS.error) {
        const rec = answers['recover'] as JevChoiceAnswer | undefined;
        const rc = rec?.choice;
        const r =
          rec && typeof rc === 'string' && (rec.probabilities[rc] ?? 0) >= THRESHOLDS.recover ? rc : 'give-up';
        if (r === 'give-up' || chain!.recoverActs >= RECOVER_MAX_PER_CLAUSE) {
          return { kind: 'result', result: mk('error', 'page-error') };
        }
        if (r === 'back' || r === 'reload' || r === 'wait') {
          if (!hasOp(r)) {
            return { kind: 'result', result: mk('error', 'page-error') };
          }
          chain!.recoverActs += 1;
          return { kind: 'mechanical', verb: r };
        }
        // 'continue' (and anything unrecognized) goes on as if no error fired.
        if (r !== 'continue') {
          return { kind: 'result', result: mk('error', 'page-error') };
        }
        recoveredThisRound = true;
      }
      // 5. ready (Q5)
      if (noulOf('ready') < THRESHOLDS.ready) {
        if (chain!.notReadyRounds >= READY_MAX_WAITS || waits >= WAIT_MAX_PER_CALL) {
          return { kind: 'bounceNotReady' };
        }
        chain!.notReadyRounds += 1;
        if (!hasOp('wait')) {
          return { kind: 'settleOnly' };
        }
        return { kind: 'mechanical', verb: 'wait' };
      }
      chain!.notReadyRounds = 0;
      // 6. right page (Q5): below WRONG_PAGE_MAX the round continues to rule 7
      // and the decide step unchanged, so Jev may still choose back/navigate.
      if (noulOf('right_page') < THRESHOLDS.rightPage) {
        chain!.wrongPageRounds += 1;
        if (chain!.wrongPageRounds >= WRONG_PAGE_MAX) {
          return { kind: 'bounceWrongPage' };
        }
      } else {
        chain!.wrongPageRounds = 0;
      }
      // 7. action none without an advance → non-commit no-match.
      if (action?.choice === 'none') {
        return { kind: 'nonCommit', why: 'no-match', candidates: topTargetCandidates(answers, obs, values) };
      }
      return null;
    }

    /** Applies a chain early outcome. */
    async function applyChainEarly(
      early: ReturnType<typeof runChainEarly>,
      bucket: PhaseRound,
    ): Promise<{ t: 'result'; result: WingmanResult } | { t: 'continue' } | { t: 'decision'; decision: Decision } | { t: 'proceed' }> {
      if (early === null) return { t: 'proceed' };
      if (early.kind === 'result') return { t: 'result', result: early.result };
      if (early.kind === 'advance') {
        chain!.cursor += 1;
        chain!.clauseRetried = false;
        chain!.wrongPageRounds = 0;
        chain!.notReadyRounds = 0;
        chain!.recoverActs = 0;
        if (chain!.cursor === N) {
          return { t: 'result', result: endOfChain() };
        }
        return { t: 'continue' };
      }
      if (early.kind === 'mechanical') {
        // § 5.5.2 rules 4–5: straight to the act site — no gate, no
        // participation check.
        return { t: 'decision', decision: { el: null, verb: early.verb, gate: false } };
      }
      if (early.kind === 'settleOnly') {
        const settleBudget = Math.min(SETTLE_MAX_MS, remaining() - 1000);
        if (settleBudget > 0) {
          const tSettle = now();
          // Verifier fix: this was `void driver.settle(...)` — a fire-and-
          // forget call that let the loop advance to the next round's observe
          // before settle actually finished, unlike every other settle call
          // site in this file (all awaited).
          await driver.settle(pageId, settleBudget);
          bucket.settleMs += now() - tSettle;
        }
        return { t: 'continue' };
      }
      if (early.kind === 'bounceNotReady') return { t: 'result', result: chainBounce('not-ready') };
      if (early.kind === 'bounceWrongPage') return { t: 'result', result: chainBounce('wrong-page') };
      const r = chainNonCommit(early.why, early.candidates);
      return r !== null ? { t: 'result', result: r } : { t: 'continue' };
    }

    while (true) {
      round += 1;
      // § 5.5.2 step 1: the chain round cap.
      if (chain && round > maxSteps + 2 * N + WAIT_MAX_PER_CALL + 2) {
        return mk('fallback', 'budget-steps');
      }
      if (remaining() < TIME_FLOOR_MS) {
        return mk('fallback', 'budget-time');
      }
      const bucket = beginRound();
      recoveredThisRound = false;
      const obs = await observeTimed(pageId);
      pageUrl = obs.url;
      // § outcome evidence choke point: fills the last act's observed result
      // from this round's fresh obs, before anything reads history.
      history = annotateLastOutcome(history, obs);
      const lastResult = history.length > 0 ? history[history.length - 1].result : undefined;
      if (cur && lastResult !== undefined) {
        // § outcome evidence secrecy (verifier fix, 2026-09-28): `result` can
        // be `selected: <raw option text>`, which may equal a bound value —
        // buildState redacts it before it reaches Jev (redactDeep over the
        // whole `raw` object), but this telemetry field bypasses buildState
        // entirely and went straight to log.jsonl unredacted. Same redaction
        // here closes that gap; every other result shape ('filled'/'empty'/
        // 'checked'/'unchecked'/'page changed'/'no visible change'/'element
        // gone') is a fixed string redactValues leaves untouched.
        cur.historyResult = redactValues(lastResult, values);
      }

      // A dialog reported through onDialog before an act.
      if (dialogEvents.some((e) => e.pageId === pageId)) {
        return mk('blocked', 'dialog-open');
      }
      if (obs.signals.captcha) {
        return mk('blocked', 'captcha');
      }
      // § 5.6 prelude (Q4): a pick round sends nothing to the decision
      // service, so the policy part is skipped on it; every later round runs
      // it. (One evaluatePolicy call site, guarded on the same line.)
      const pickRound = round === 1 && entry?.pick !== undefined;
      const policy = pickRound
        ? ({ sensitive: false } as ReturnType<typeof evaluatePolicy>)
        : evaluatePolicy(obs.url, obs.signals, deps.config.sensitive_hosts, policyModeOf(deps.config));
      if (policy.sensitive) {
        // A policy hit leaves a confirm token unconsumed.
        return mk('fallback', policy.reason as Reason);
      }
      // The missing-binding detector reads this round's step text.
      activeStepText = chain
        ? chain.clauses[chain.cursor]
        : entry?.kind === 'legacy'
          ? entry.step
          : '';

      // The confirm token is handled at one fixed point: after tab
      // resolution, the first observe and the policy check, before any ask.
      // In shadow mode it is neither consumed nor executed (§ 3.7 rule 10).
      if (token !== undefined && !tokenHandled) {
        tokenHandled = true;
        if (mode !== 'shadow') {
          const outcome = await runTokenAction(
            pageId, driver, obs, token, values, maxSteps, remaining, history, driverOps,
            chain ? `c${chain.cursor}` : 'single',
          );
          if (outcome.result) {
            return outcome.result;
          }
          history = outcome.history; // the act counted as a step; continue under the gate
          continue;
        }
      }

      let decision: Decision | null = null;
      let decisionAnswers: AnswerMap = {};

      // ---- § 5.6 pick round (round 1, no ask) ----
      if (pickRound) {
        if (mode === 'shadow') {
          // Shadow never acts; a pick neither asks nor acts in shadow.
          return shadowResult();
        }
        pickRan = true;
        // After the pick, legacy continues as a committed takeover (§ 5.6).
        entryPending = false;
        const pick = entry!.pick!;
        // § 5.5.6 verb check: before any ask, zero acts.
        if (!hasOp(pick.action)) {
          return mk('fallback', 'unsupported-op');
        }
        const res = resolvePick(obs, pick);
        if (!res.ok) {
          pickUnmatched = true;
          return mk('ambiguous', 'target-uncertain', {
            candidates: res.matches.map((m) => candidateOf(m, values)),
          });
        }
        const pickEl = res.el;
        let pickVerb: Op = pick.action;
        // § 5.5.3 file-input conversion: a pick click on a file input converts
        // the same way and, carrying no value, ends ambiguous/no-value.
        if (
          pickEl !== null &&
          (pickVerb === 'click' || pickVerb === 'dblclick' || pickVerb === 'press') &&
          isFileInput(pickEl)
        ) {
          pickVerb = 'upload';
        }
        let pickBinding: string | undefined;
        let pickOption: string | undefined;
        if (pickVerb === 'fill' || pickVerb === 'select' || pickVerb === 'navigate' || pickVerb === 'upload') {
          pickBinding = pick.value;
          const v = pickBinding !== undefined ? values[pickBinding] : undefined;
          if (pickVerb === 'fill') {
            if (v === undefined) return mk('ambiguous', 'no-value');
          } else if (pickVerb === 'navigate') {
            if (v === undefined || !/^https?:\/\//i.test(v)) return mk('ambiguous', 'no-value');
          } else if (pickVerb === 'upload') {
            if (v === undefined || !isPathLike(v)) return mk('ambiguous', 'no-value');
          } else {
            // select: a local option match, else ambiguous/no-value (§ 5.6).
            const wanted = v ?? '';
            const local = (pickEl?.options ?? []).find(
              (o) => o.label.toLowerCase() === wanted.toLowerCase() || o.value.toLowerCase() === wanted.toLowerCase(),
            );
            if (!local) return mk('ambiguous', 'no-value');
            pickOption = local.value;
          }
        } else if (pickVerb === 'press') {
          pickOption = 'Enter'; // a pick press uses 'Enter' (§ 5.6)
        }
        if (pickEl !== null && !opFits(pickVerb, pickEl)) {
          return mk('ambiguous', 'target-uncertain', { candidates: [candidateOf(pickEl, values)] });
        }
        if (!KB_PICK_OBSCURED && pickEl !== null && pickEl.obscured) {
          const evidence: Array<{ label: string; role?: string; name?: string }> = [candidateOf(pickEl, values)];
          if (pickEl.coveredBy) {
            evidence.push({ label: capLabel(redactValues(pickEl.coveredBy, values)) });
          }
          return mk('fallback', 'target-covered', entryReview('target-covered', evidence));
        }
        // The pick uses the shared gate (heuristic only) and the shared act
        // site; participation is always execute (§ 5.6).
        decision = {
          el: pickEl,
          verb: pickVerb,
          ...(pickBinding !== undefined ? { binding: pickBinding } : {}),
          ...(pickOption !== undefined ? { optionValue: pickOption } : {}),
          gate: pickEl !== null,
        };
      }

      // ---- build the state, ask, and decide (§ 3.7 / § 5.5.2) ----
      if (decision === null) {
        const state0 = chain
          ? buildState(
              obs,
              history,
              doInput.goal,
              values,
              clauseText(chain.cursor),
              { stepNumber: Math.min(chain.cursor + 1, N), stepsTotal: N },
            )
          : buildState(obs, history, doInput.goal, values, entryStep !== undefined && round === 1 ? entryStep : undefined);
        const anchorBindings = chain ? bindingsInStep(chain.clauses[chain.cursor], values) : entryBindings;
        const twoStage = obs.elements.length > deps.config.budgets.max_elements;
        let primary: AnswerMap;
        let secondary: AnswerMap | null = null;
        let sizedState: object = state0;


        if (twoStage) {
          const sized = withStateSize(
            state0,
            (s) =>
              buildGroupRequest({
                state: s,
                elements: obs.elements,
                bindings: values,
                round,
                ops: offered,
                chain: chain !== null,
                recover: isBrowse,
              }),
            (p) => p.request,
          );
          if (!sized.ok) {
            return mk('fallback', 'state-too-large');
          }
          sizedState = sized.state;
          // Time rule: before every ask.
          if (remaining() < TIME_FLOOR_MS) {
            return mk('fallback', 'budget-time');
          }
          const r1 = await askWithCost(sized.payload.request, isBrowse ? 'browse_step' : 'wingman_do', remaining);
          if (!r1.ok) {
            return mk('fallback', askFailReason(r1));
          }
          primary = r1.answers as AnswerMap;
          decisionAnswers = primary;
          recordDecisionTelemetry(primary);
          if (chain) {
            // § 5.5.2 step 6: in shadow mode return after this ask.
            if (mode === 'shadow') return shadowResult();
            const early = runChainEarly(primary, round, obs);
            const stop = await applyChainEarly(early, bucket);
            if (stop.t === 'result') return stop.result;
            if (stop.t === 'continue') continue;
            if (stop.t === 'decision') decision = stop.decision;
          } else {
            const early = decideEarly(primary, round, obs, values, legacyRecoverActs, hasOp);
            if (early) {
              if (mode === 'shadow') return shadowResult();
              if ('recovered' in early) {
                // § outcome evidence WP-B scope rule 2: an error+recover
                // 'continue' fell through to a normal decision this round —
                // exempt from the no-progress guard (the recoverActs cap
                // already owns this retry loop).
                recoveredThisRound = true;
              } else if ('mechanical' in early) {
                legacyRecoverActs += 1;
                decision = { el: null, verb: early.mechanical, gate: false };
              } else {
                const e = early.result;
                // § 5.5.4 zero-step entry done (defence, C4): a non-commit.
                if (entryPending && e.reason === 'goal-met' && steps === 0) {
                  if (canRetry()) {
                    retried = true;
                    continue;
                  }
                  return bounce('already-done', []);
                }
                // An entry round that proposed no action is a non-commit
                // (§ 3.19 item 3, 'no-match'): retry once, else bounce.
                if (entryPending && e.reason === 'no-action') {
                  if (canRetry()) {
                    retried = true;
                    continue;
                  }
                  return bounce('no-match', e.candidates ?? []);
                }
                return e;
              }
            }
          }
          if (decision === null) {
            // Request 2 runs only when a targeted decision still needs its
            // target (§ 5.5.2 step 6 two-stage skip; § 5.5.4 applies it to the
            // legacy entry too).
            const actionAns = primary['action'] as JevChoiceAnswer | undefined;
            const actionChoice = typeof actionAns?.choice === 'string' ? actionAns.choice : undefined;
            const targetlessChoice =
              actionChoice !== undefined && (TARGETLESS_OPS as readonly string[]).includes(actionChoice);
            if (!targetlessChoice) {
              const groupAnswer = primary['group'] as JevChoiceAnswer | undefined;
              const topIds = groupAnswer
                ? Object.entries(groupAnswer.probabilities)
                    .filter(([id]) => id !== 'none' && id !== 'ambiguous')
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, TWO_STAGE.topGroups)
                    .map(([id]) => id)
                : [];
              const groups = sized.payload.groups;
              const targetElements = topIds.flatMap((id) => {
                const index = Number(id.slice(1)) - 1;
                return index >= 0 && index < groups.length ? groups[index] : [];
              });
              if (targetElements.length === 0) {
                if (chain) {
                  const r = chainNonCommit('no-match', topTargetCandidates(primary, obs, values));
                  if (r !== null) return r;
                  continue;
                }
                return mk('ambiguous', 'target-uncertain', { candidates: [] });
              }
              const r2 = await (async () => {
                if (remaining() < TIME_FLOOR_MS) {
                  return { ok: false as const, error: 'budget-time' as const };
                }
                const req = buildTargetRequest({
                  state: sizedState,
                  elements: targetElements,
                  bindings: values,
                  round,
                  chain: chain !== null,
                });
                if (anchorBindings.length > 0) anchorValueQuestion(req);
                return await askWithCost(req, isBrowse ? 'browse_step' : 'wingman_do', remaining);
              })();
              if (!r2.ok) {
                return mk('fallback', r2.error === 'budget-time' ? 'budget-time' : askFailReason(r2));
              }
              secondary = r2.answers as AnswerMap;
            }
          }
        } else {
          const sized = withStateSize(
            state0,
            (s) =>
              buildRoundRequest({
                state: s,
                elements: obs.elements,
                bindings: values,
                round,
                ops: offered,
                chain: chain !== null,
                recover: isBrowse,
              }),
            (p) => p,
          );
          if (!sized.ok) {
            return mk('fallback', 'state-too-large');
          }
          sizedState = sized.state;
          // Time rule: before every ask.
          if (remaining() < TIME_FLOOR_MS) {
            return mk('fallback', 'budget-time');
          }
          const built = sized.payload;
          if (anchorBindings.length > 0) anchorValueQuestion(built);
          const r = await askWithCost(built, isBrowse ? 'browse_step' : 'wingman_do', remaining);
          if (!r.ok) {
            return mk('fallback', askFailReason(r));
          }
          primary = r.answers as AnswerMap;
          decisionAnswers = primary;
          recordDecisionTelemetry(primary);
          if (chain) {
            if (mode === 'shadow') return shadowResult();
            const early = runChainEarly(primary, round, obs);
            const stop = await applyChainEarly(early, bucket);
            if (stop.t === 'result') return stop.result;
            if (stop.t === 'continue') continue;
            if (stop.t === 'decision') decision = stop.decision;
          } else {
            const early = decideEarly(primary, round, obs, values, legacyRecoverActs, hasOp);
            if (early) {
              if (mode === 'shadow') return shadowResult();
              if ('recovered' in early) {
                recoveredThisRound = true;
              } else if ('mechanical' in early) {
                legacyRecoverActs += 1;
                decision = { el: null, verb: early.mechanical, gate: false };
              } else {
                const e = early.result;
                if (entryPending && e.reason === 'goal-met' && steps === 0) {
                  if (canRetry()) {
                    retried = true;
                    continue;
                  }
                  return bounce('already-done', []);
                }
                if (entryPending && e.reason === 'no-action') {
                  if (canRetry()) {
                    retried = true;
                    continue;
                  }
                  return bounce('no-match', e.candidates ?? []);
                }
                return e;
              }
            }
          }
        }

        if (decision === null) {
          const merged = (secondary ? { ...primary, ...secondary } : primary) as AnswerMap;
          decisionAnswers = merged;
          recordDecisionTelemetry(merged);
          if (chain) {
            // § 5.5.2 step 8.
            const cands = () => topTargetCandidates(merged, obs, values);
            const actionAns = merged['action'] as JevChoiceAnswer | undefined;
            const choice = actionAns?.choice;
            if (!actionAns || typeof choice !== 'string' || !offeredSet.has(choice)) {
              const r = chainNonCommit('no-match', cands());
              if (r !== null) return r;
              continue;
            }
            if (choice === 'wait' && waits >= WAIT_MAX_PER_CALL) {
              const r = chainNonCommit('no-match', cands());
              if (r !== null) return r;
              continue;
            }
            if ((TARGETLESS_OPS as readonly string[]).includes(choice)) {
              const probs = actionAns.probabilities ?? {};
              const commits =
                (probs[choice] ?? 0) >= takeoverOf(deps.config).threshold ||
                marginCommitOp(probs, offered) !== null;
              if (!commits) {
                const r = chainNonCommit('low-confidence', cands());
                if (r !== null) return r;
                continue;
              }
            } else {
              // § 5.5.2 rule 8: a targeted verb uses the § 3.19
              // threshold-or-margin rule; failure is a non-commit with its
              // why — except scroll_to, whose non-committing target becomes a
              // targetless scroll down and acts (never a non-commit).
              const tWhy = targetUncertainty(merged, obs);
              if (tWhy !== null && choice !== 'scroll_to') {
                const r = chainNonCommit(tWhy, cands());
                if (r !== null) return r;
                continue;
              }
            }
            let chainDecision: Decision | null =
              choice === 'scroll_to' && targetUncertainty(merged, obs) !== null
                ? { el: null, verb: 'scroll', gate: false }
                : null;
            if (chainDecision === null) {
            const decide = await decideTarget(merged, primary, obs, values, sizedState, remaining, anchorBindings, true, offeredSet);
            if (decide.result) {
              if (decide.bounds) return decide.result;
              if (decide.keyMissing) {
                const r = chainNonCommit('low-confidence', cands());
                if (r !== null) return r;
                continue;
              }
              if (decide.result.reason === 'no-value') {
                const r = chainNonCommit('no-value', cands());
                if (r !== null) return r;
                continue;
              }
              const r = chainNonCommit('no-match', cands());
              if (r !== null) return r;
              continue;
            }
            // § 5.5.2 step 8 bullet 4: a committed element the enumerate-time
            // probe reports covered never acts — fallback/target-covered with
            // evidence, no retry (verifier fix: this bullet was applied only
            // to the pick round and the legacy entry round; chain mode's
            // ordinary Jev-decided commits skipped it and relied solely on
            // the adapter's live act-time CoveredTargetError check, which
            // loses the candidate evidence and can miss elements the
            // enumerate-time probe already knows are covered).
            if (decide.el !== null && decide.el.obscured) {
              const evidence: Array<{ label: string; role?: string; name?: string }> = [
                candidateOf(decide.el, values),
              ];
              if (decide.el.coveredBy) {
                evidence.push({ label: capLabel(redactValues(decide.el.coveredBy, values)) });
              }
              return mk('fallback', 'target-covered', {
                step_review: { step: clauseReviewStep(), why: 'target-covered', candidates: evidence },
              });
            }
            // § 5.5.2 step 10: the first commit of the call under offer.
            if (participation === 'offer' && !chain.firstCommitDone) {
              chain.firstCommitDone = true;
              return mk('fallback', 'takeover-offered', {
                step_review: { step: clauseReviewStep(), why: 'offered', candidates: cands() },
              });
            }
            chainDecision = {
              el: decide.el,
              verb: decide.verb,
              ...(decide.binding !== undefined ? { binding: decide.binding } : {}),
              ...(decide.optionValue !== undefined ? { optionValue: decide.optionValue } : {}),
              gate: decide.el !== null,
            };
            }
            decision = chainDecision;
          } else {
            // Legacy decide (§ 3.7 rules 6–9, amendment 2026-09-21d/2026-09-22).
            const wasEntryRound = entryPending;
            let entryCommit = false;
            if (entryPending) {
              entryPending = false;
              // Amendment 2026-09-21h (two-stage action carry): the entry
              // decision reads request 1 merged under request 2.
              const uncertainty = entryUncertainty(merged, obs);
              if (uncertainty !== null) {
                if (canRetry()) {
                  retried = true;
                  entryPending = true; // the retry round carries the entry decision
                  continue;
                }
                return bounce(uncertainty, topTargetCandidates(merged, obs, values));
              }
              entryCommit = true;
              // Amendment 2026-09-21h (obstruction gate): a committed entry
              // target the enumerate-time probe reports covered never acts.
              const targetAnswer = merged['target'] as JevChoiceAnswer | undefined;
              const chosenId =
                targetAnswer !== undefined &&
                targetAnswer.choice !== 'none' &&
                targetAnswer.choice !== 'ambiguous' &&
                obs.elements.some((e) => e.id === targetAnswer.choice)
                  ? targetAnswer.choice
                  : marginCommitTarget(targetAnswer?.probabilities ?? {}, obs.elements);
              const chosen = chosenId !== null ? obs.elements.find((e) => e.id === chosenId) : undefined;
              if (chosen?.obscured) {
                const evidence = topTargetCandidates(merged, obs, values);
                if (chosen.coveredBy) {
                  evidence.push({ label: capLabel(redactValues(chosen.coveredBy, values)) });
                }
                return mk('fallback', 'target-covered', entryReview('target-covered', evidence));
              }
            }
            const decide = await decideTarget(merged, primary, obs, values, sizedState, remaining, entryBindings, entry !== undefined, offeredSet);
            if (mode === 'shadow') {
              // Rule 10: shadow overrides steps 1–9 — after the first round's
              // answers the call returns fallback/shadow, whatever they decided.
              // Loop bounds (budget-time, a failed ask) are not steps 1–9.
              if (decide.result && decide.bounds) {
                return decide.result;
              }
              if (!decide.result) {
                const gate = decide.el
                  ? gateHeuristic(decide.el, decide.el.form >= 0 ? obs.forms[decide.el.form] : undefined, decide.verb)
                  : { hit: false as const };
                const irreversibleAnswer = merged['irreversible'];
                const irreversibleP =
                  decide.el && irreversibleAnswer && irreversibleAnswer.type === 'noul' ? irreversibleAnswer.noul : 0;
                if (gate.hit || irreversibleP >= THRESHOLDS.irreversible) {
                  acc.gateHits = 1;
                }
                acc.would = { verb: decide.verb, role: decide.el ? decide.el.role : '' };
              }
              return shadowResult();
            }
            if (decide.result) {
              if (wasEntryRound && entryCommit && !decide.bounds) {
                // A committed entry round that still could not finish its
                // decision: value resolution failed (`no-value`), the chosen
                // element does not fit the verb, or the key answer was missing
                // (§ 5.5.3: a press keyMissing becomes low-confidence).
                const cands = topTargetCandidates(merged, obs, values);
                if (decide.keyMissing) return bounce('low-confidence', cands);
                if (decide.result.reason === 'no-value') return bounce('no-value', cands);
                return bounce('no-match', cands);
              }
              return decide.result;
            }
            // § 5.4 wait row, off-chain: over the wait cap it is a no-action.
            if (decide.verb === 'wait' && waits >= WAIT_MAX_PER_CALL) {
              return mk('ambiguous', 'no-action', { candidates: topTargetCandidates(merged, obs, values) });
            }
            // Participation (§ 3.19 item 5): a committed entry round under
            // offer participation reports the offer instead of acting.
            if (wasEntryRound && entryCommit && participation === 'offer') {
              return mk('fallback', 'takeover-offered', entryReview('offered', topTargetCandidates(merged, obs, values)));
            }
            decision = {
              el: decide.el,
              verb: decide.verb,
              ...(decide.binding !== undefined ? { binding: decide.binding } : {}),
              ...(decide.optionValue !== undefined ? { optionValue: decide.optionValue } : {}),
              gate: decide.el !== null,
            };
          }
        }
      }

      // ---- shared gate + act tail (§ 5.5.3) ----
      if (decision !== null) {
        // Rule 9 gate: targeted verbs only; targetless verbs never gate.
        // With gate.mode 'off' (§ 3.8) the gate heuristic and the Jev
        // irreversible probability never produce needs_confirmation: the act
        // proceeds exactly as a non-gated action would and no token is minted.
        if (decision.gate && gateModeOf(deps.config) !== 'off') {
          const gate = decision.el
            ? gateHeuristic(decision.el, decision.el.form >= 0 ? obs.forms[decision.el.form] : undefined, decision.verb)
            : { hit: false as const };
          const irreversibleAnswer = decisionAnswers['irreversible'];
          const irreversibleP =
            decision.el && irreversibleAnswer && irreversibleAnswer.type === 'noul' ? irreversibleAnswer.noul : 0;
          if (gate.hit || irreversibleP >= THRESHOLDS.irreversible) {
            const pending: PendingAction = {
              url: obs.url,
              elementPath: decision.el!.path,
              fingerprint: decision.el!.fingerprint,
              verb: decision.verb,
              ...(decision.binding !== undefined ? { binding: decision.binding } : {}),
              ...(decision.optionValue !== undefined ? { optionValue: decision.optionValue } : {}),
              label: decision.el!.name,
            };
            const confirmToken = deps.tokens.mint(pending);
            return mk('needs_confirmation', gate.hit ? 'irreversible-heuristic' : 'irreversible-jev', {
              pending: { verb: decision.verb, label: capLabel(redactValues(decision.el!.name, values)) },
              confirm_token: confirmToken,
            });
          }
        }
        // Rule 11: act — the one round act site (§ 5.5.3). The steps budget
        // skips wait; wait never counts as a step.
        if (decision.verb !== 'wait' && steps >= maxSteps) {
          return mk('fallback', 'budget-steps');
        }
        if (remaining() < TIME_FLOOR_MS) {
          return mk('fallback', 'budget-time');
        }
        // § outcome evidence WP-B: a deterministic no-progress guard, right
        // before the act — this round's decision repeats the exact (verb,
        // element path) of the last recorded act WITHIN THE SAME STEP, and
        // that act's observed result (annotated above from this round's
        // fresh obs) shows no change from its pre-act baseline. Placed AFTER
        // the budget checks (not before them): when an explicit tight
        // max_steps would already end the call this round, that budget
        // reason wins — this guard is for a call that would otherwise keep
        // repeating past any budget, not for one already ending anyway.
        // Fires for both chain and legacy/wingman_do decisions alike (this
        // is the one shared decision site every mode funnels through).
        // Two scope exemptions (orchestrator decision, 2026-09-28):
        // (1) a clause/step advance resets it — `currentStepKey` ties the
        // comparison to the SAME chain clause (or the single implicit step
        // of a non-chain call), so two different steps landing on the same
        // element never counts as a repeat; (2) a round that fell through
        // from an error+recover 'continue' is exempt outright —
        // `recoveredThisRound` — because the existing recoverActs cap
        // (RECOVER_MAX_PER_CLAUSE, then page-error) already owns that retry
        // loop and this guard would otherwise short-circuit it.
        const currentStepKey = chain ? `c${chain.cursor}` : 'single';
        if (!recoveredThisRound && isNoProgress(decision, history, currentStepKey)) {
          const candidates = decision.el ? [candidateOf(decision.el, values)] : [];
          if (isBrowse) {
            const step = chain ? clauseReviewStep() : capLabel(entryStep ?? '');
            return mk('fallback', 'no-progress', { step_review: { step, why: 'no-progress', candidates } });
          }
          return mk('fallback', 'no-progress', { candidates });
        }
        const actValue =
          decision.verb === 'fill' || decision.verb === 'navigate' || decision.verb === 'upload'
            ? decision.binding !== undefined
              ? values[decision.binding]
              : undefined
            : decision.verb === 'select' || decision.verb === 'press'
              ? decision.optionValue
              : undefined;
        const tAct = now();
        await driver.act(pageId, decision.el ? decision.el.id : null, decision.verb, actValue);
        bucket.actMs += now() - tAct;
        if (decision.verb === 'wait') {
          waits += 1;
        } else {
          steps += 1;
        }
        actsByOp[decision.verb] = (actsByOp[decision.verb] ?? 0) + 1;
        const actLabel = decision.el ? decision.el.name : (decision.binding ?? '');
        lastAction = { verb: decision.verb, label: capLabel(redactValues(actLabel, values)) };
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
        history = [
          ...history,
          {
            verb: decision.verb,
            label: decision.el ? decision.el.name : (decision.binding ?? ''),
            ...(decision.el ? { path: decision.el.path, fingerprint: decision.el.fingerprint } : {}),
            before: outcomeSignal(decision.verb, decision.el ?? undefined, obs),
            stepKey: currentStepKey,
          },
        ];
      }
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
