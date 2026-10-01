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
  STUCK_NONE_MIN,
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
  NoHistoryError,
  StaleElementError,
  WingmanError,
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
  buildRecoverRequest,
  buildRoundRequest,
  buildTargetRequest,
  elementCriterion,
  offeredOps,
  RECOVER_OPEN_PREFIX,
  UNTRUSTED_SENTENCE,
  urlBindings,
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
interface ChainMemoryEntry { cursor: number; acts: number; cursorActed?: boolean; stuckTried?: boolean }
const chainMemory = new Map<string, ChainMemoryEntry>();

/** Chain state for the current browse_step call, when it runs chain mode
 * (§ 5.5.2). Created by runBrowse, read by finish() for progress and the
 * memory write-back. */
interface ChainState {
  key: string;
  clauses: string[];
  N: number;
  // § r11 Q1 compound-clause decomposition: `clauses`/`N` are the EXPANDED
  // sub-clause list; `parents[i]` maps each expanded index back to its caller
  // clause index and `callerN` is the caller's original clause count, so
  // caller-facing progress and step_number stay in the caller's numbering.
  parents: number[];
  callerN: number;
  cursor: number;
  priorActs: number;
  clauseRetried: boolean;
  firstCommitDone: boolean;
  wrongPageRounds: number;
  notReadyRounds: number;
  recoverActs: number;
  // r13 stuck recover (D1): `cursorActed` = an element-targeted act already
  // happened on this clause; `stuckUsed` = the one stuck round was started;
  // `stuckPending` = a deferred stuck round awaits (set at the would-be bounce).
  cursorActed: boolean;
  stuckUsed: boolean;
  stuckPending: StuckPending | null;
  // r13 D1 guard 1: the look that consumed the clause's retry was itself a
  // confident none (verb in STUCK_VERBS, target none >= STUCK_NONE_MIN), so a
  // stuck recovery follows two consecutive none looks, never an ambiguous one.
  retryNone: boolean;
}

/** r13: the bounce a stuck recovery defers (why + the candidates captured at trigger time). */
type StuckPending = {
  why: 'no-match' | 'low-confidence' | 'wrong-page';
  candidates: Array<{ label: string; role?: string; name?: string }>;
};

/** r13 D1 rule 7: the decided action verbs that may trigger a stuck recovery. */
const STUCK_VERBS: ReadonlySet<string> = new Set(['click', 'navigate', 'back']);

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
  // r14 D2: the page address this act was made on. Internal only, never reaches buildState.
  beforeUrl?: string;
  result?: string;
  // § outcome evidence WP-B scope (orchestrator decision, 2026-09-28): which
  // step this act belonged to — the chain clause index (`c<cursor>`) in
  // chain mode, else `'single'` (a legacy browse_step entry or a wingman_do
  // call is one implicit step for this purpose). Internal only — never
  // reaches buildState's history mapping.
  stepKey?: string;
  // § outcome evidence bar fix (verifier, 2026-09-28): for a `select` act
  // only, the option's LABEL that the act intended to land on — looked up
  // from the acted-on element's own `options` by the `value` the driver was
  // told to select. `elementStateSignal`'s select branch reads back
  // `el.state.selected`, which is the option's raw LABEL text, not its
  // `value` attribute (they differ on any `<option value="…">label</option>`
  // where the two aren't equal) — so this is the only form comparable to
  // `result`. Undefined whenever the intended option's label can't be
  // resolved (e.g. no matching entry in `options`), in which case the
  // evidence check must fall back to "unconfirmed" rather than guess.
  // Internal only — never reaches buildState's history mapping.
  intendedLabel?: string;
  // r13 D6: a stuck-recover navigate that is NOT the clause's own named
  // binding act is never step evidence. Internal only.
  stuckRecover?: true;
}

/** § outcome evidence: element-state verbs read `state` directly (no new
 * page call — it is already on every enumerated element); every other verb
 * (click-family, and any el-targeted verb outside this set) falls back to a
 * page-level signal so a targetless act never gets a false "unchanged". */
const ELEMENT_STATE_VERBS: ReadonlySet<Op> = new Set(['fill', 'select', 'check', 'uncheck']);

/** § WP-count: the click-family verbs, matching every other click-family
 * classification in this file (isFileInput's conversion check, the pick
 * gate). A repeat-count step ("click X twice") only ever means one of these. */
const CLICK_FAMILY_OPS: ReadonlySet<Op> = new Set(['click', 'dblclick', 'press']);

/** § outcome evidence fix (2026-09-28, r6 Finding 2 / diagnosis 3): the
 * targetless verbs whose whole point is to leave the current page. They get
 * a page-level before/result like click-family (pageSignal with no `el`,
 * since there is no acted-on element) so a repeated navigate/back/reload
 * that lands on the same page can trip the no-progress guard — r6 showed
 * a fresh-install task repeat `navigate` 24x to budget-steps because no
 * signal was ever recorded for it. Also read by runChainEarly (below) to
 * skip the ready/right_page gate for these verbs: "is the CURRENT page
 * ready" is asked about the page the step is about to abandon, so it was
 * bouncing not-ready on effectively every first-navigate step (r6:
 * part3-wingman-log.jsonl — every not-ready round's decided action was
 * navigate, actionP 0.94-0.98). scroll/scroll_up/wait stay outside this set:
 * they aren't navigation and keep their existing no-signal/no-guard behavior. */
const NAVIGATION_OPS: ReadonlySet<Op> = new Set(['navigate', 'back', 'reload']);

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
  if (NAVIGATION_OPS.has(verb)) return pageSignal(obs); // targetless nav: page-level signal, no element
  return undefined; // remaining targetless / binding-only verb: no signal, no guard, no result
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
 * `decision.el`) never match: they carry no path and no signal.
 * Deliberate asymmetry (r11 Q3): unlike lastEvidenceEntry, this guard reads only the literal last entry — a wait may itself change the page. */
function isNoProgress(
  decision: { el: ElementRecord | null; verb: Op },
  history: HistoryEntry[],
  currentStepKey: string,
): boolean {
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  if (decision.el === null) {
    // Targetless: no element identity to compare, so only the navigation
    // verbs (navigate/back/reload) carry a signal at all (outcomeSignal
    // above) — scroll/scroll_up/wait never do and correctly never match here.
    if (!NAVIGATION_OPS.has(decision.verb)) return false;
    if (
      last.path !== undefined ||
      last.verb !== decision.verb ||
      last.result === undefined ||
      last.stepKey !== currentStepKey
    ) {
      return false;
    }
    return last.result === 'no visible change';
  }
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

/** § r11 Q3: the last signal-carrying history entry for `stepKey`. Walks back
 * from the end, skipping entries whose `before === undefined` (signal-less
 * acts — wait, bare scroll/scroll_up, any verb with no outcome signal), which
 * previously shadowed the evidence of the act before them for the rest of the
 * call. Returns the FIRST entry that carries `before`, but only when its
 * stepKey matches — a signal-less entry is skipped unconditionally (a
 * pre-advance wait is incidental), never allowed to leak the previous
 * clause's evidence, which the stepKey check on the carried entry still
 * guards. */
function lastEvidenceEntry(history: HistoryEntry[], stepKey: string): HistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.before === undefined) continue;
    return h.stepKey === stepKey ? h : undefined;
  }
  return undefined;
}

/** Evidence-backed step_done bar (operator-approved tuning, 2026-09-28; see
 * THRESHOLDS.stepDoneWithEvidence). True only when the last SIGNAL-CARRYING
 * history entry (r11 Q3: `lastEvidenceEntry` reads through signal-less acts
 * such as wait/scroll, so their `before === undefined` entries no longer
 * shadow a good act) belongs to the CURRENT step (`stepKey` match), its verb
 * is one of the four element-state verbs, and its observed `result` confirms
 * that verb's OWN intended end state:
 *   - fill: `result === 'filled'` AND `before !== 'filled'` (verifier fix,
 *     2026-09-28) — a field already non-empty BEFORE this act proves nothing:
 *     'filled' only means non-empty, never that THIS act supplied the
 *     intended value, so a pre-filled field must not count as fresh evidence.
 *     Since `elementStateSignal('fill', …)` only ever returns 'filled' or
 *     'empty', `before !== 'filled'` is exactly "before was 'empty'".
 *   - select: `result === \`selected: ${intendedLabel}\`` (verifier fix,
 *     2026-09-28) — starts-with 'selected:' alone would accept ANY selection,
 *     including the wrong option; `intendedLabel` (recorded at the act site)
 *     is the option Jev actually asked for, so this confirms the CORRECT
 *     option landed, not merely that some option did. Undefined
 *     `intendedLabel` (label couldn't be resolved) never confirms.
 *   - check/'checked', uncheck/'unchecked': these are two-valued and the
 *     value IS the goal, so no before-check is needed (unlike fill, a
 *     confirmed 'checked' can't be "the wrong value").
 *   - navigate (r12): `result === 'page changed'` (r13 D6: unless the entry is a
 *     stuck-recover navigate, `stuckRecover`, that the clause did not name) — navigate only ever targets
 *     a url-typed binding Jev chose, and a landed navigation that visibly
 *     changed the page is the step's end state. back/reload are NOT evidence.
 *     Residual risk: this cannot verify it is the RIGHT page — right_page /
 *     wrong-page handling remains Jev's job.
 * A click-family or targetless verb (incl. back/reload), an entry from a previous step, or a
 * result that doesn't confirm the verb's end state all return false, leaving
 * the 0.85 bar as the only path to advance. Residual, accepted risk (verifier,
 * 2026-09-28): neither fill nor select can confirm the acted-on ELEMENT was
 * the one the step actually named — that would need semantic matching of the
 * step text to the element, which is Jev's own job, not a mechanical check. */
function hasStepEvidence(history: HistoryEntry[], currentStepKey: string): boolean {
  const last = lastEvidenceEntry(history, currentStepKey);
  if (last === undefined) return false;
  if (last.verb === 'navigate') return last.stuckRecover !== true && last.result === 'page changed';
  if (!ELEMENT_STATE_VERBS.has(last.verb) || last.result === undefined) return false;
  switch (last.verb) {
    case 'fill':
      return last.result === 'filled' && last.before !== 'filled';
    case 'select':
      return last.intendedLabel !== undefined && last.result === `selected: ${last.intendedLabel}`;
    case 'check':
      return last.result === 'checked';
    case 'uncheck':
      return last.result === 'unchecked';
    default:
      return false;
  }
}

/** § WP-count word-form counts: "N times" with N spelled out, two..ten.
 * once/twice/thrice have no digit form and are matched separately below. */
const REPEAT_WORD_COUNTS: Readonly<Record<string, number>> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** § WP-count deterministic repeat-count evidence (operator-approved,
 * 2026-09-28 — see the click-count dispatch): a step naming an explicit
 * count ("click the Add button twice") is its own evidence bar, independent
 * of Jev's stepDoneP/done Noul, which never fires reliably on a repeated
 * click (hasStepEvidence above deliberately excludes click-family). Only
 * explicit count WORDS count — no attempt at general-purpose number parsing:
 * once=1, twice=2, thrice=3, or "<N> times" with N a digit string 1..50 or a
 * spelled-out word two..ten (case-insensitive, word-bounded throughout). A
 * step naming MORE THAN ONE count expression is ambiguous by construction
 * (which one governs?) and returns undefined rather than guess — e.g. "click
 * it twice, then submit 2 times" never resolves to either 2. */
export function parseRepeatCount(step: string): number | undefined {
  let count: number | undefined;
  let matches = 0;
  const onceCount = (step.match(/\bonce\b/gi) ?? []).length;
  if (onceCount > 0) { matches += onceCount; count = 1; }
  const twiceCount = (step.match(/\btwice\b/gi) ?? []).length;
  if (twiceCount > 0) { matches += twiceCount; count = 2; }
  const thriceCount = (step.match(/\bthrice\b/gi) ?? []).length;
  if (thriceCount > 0) { matches += thriceCount; count = 3; }
  for (const m of step.matchAll(/\b(\d{1,2})\s+times\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) { matches += 1; count = n; }
  }
  for (const m of step.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten)\s+times\b/gi)) {
    matches += 1;
    count = REPEAT_WORD_COUNTS[m[1].toLowerCase()];
  }
  return matches === 1 ? count : undefined;
}

/** § r11 Q1 compound-clause decomposition: the action words observed in
 * caller step texts. A conditional separator (`and` or a bare `,`) is a
 * candidate boundary only when the word immediately after it matches this
 * list; the actionability check below also requires the fragment following a
 * candidate to contain one of these verbs. Word-bounded, case-insensitive
 * (`back` covers "and go back"-style tails). */
const VERB_RE =
  /\b(?:open|go|navigate|return|click|press|select|choose|pick|check|uncheck|tick|fill|type|enter|scroll|hover|wait|submit|upload|attach|dismiss|close|enable|disable|set|clear|add|remove|start|toggle|switch|reload|refresh|back)\b/i;

/** § r11 Q1: an anaphora word anywhere in the text after a candidate boundary
 * suppresses the split — "then it", "click the same", "do it again" are
 * continuations of the same action, not a new one. */
const ANAPHORA_RE = /\b(it|them|there|again|same|another)\b/i;

/** § r11 Q1: split a caller clause into ordered sub-clauses at accepted
 * boundaries. Exported for unit tests only — same style as parseRepeatCount.
 *
 * Candidate separators, scanned left to right:
 *   - unconditional: `;` and the word `then`;
 *   - conditional: the word `and`, or a bare `,` — each only when the word
 *     immediately following the separator matches VERB_RE ("fill name and
 *     email", "click the Add Element button" never split).
 * A conditional candidate is additionally REJECTED while scanning (r11b):
 * inside single quotes ("click the 'Add and Close' button" never splits —
 * naïve ', ' and ' parity), when the word it introduces is `check`/`verify`
 * followed by `that`/`if`/`whether` (an assertion tail Jev cannot act on, not
 * a control action — "and check that the toggle is enabled"), or when the
 * text from it to the next match/clause end is exactly one verb word and
 * nothing else — a compound name's tail, not a sub-goal, so "click Save and
 * Close", "click Add and Remove" and "fill email and submit" stay whole
 * (under-splitting is the accepted safe direction).
 * A surviving candidate is ACCEPTED only when the text between it and the
 * next candidate (or the clause end) is actionable: it contains a VERB_RE
 * word and no ANAPHORA_RE word. An unaccepted candidate's separator text
 * stays inside the fragment ("then the box should be checked", "click the
 * box and then it" keep the clause whole). Split points drop the separator
 * itself; each fragment is then trimmed of leading/trailing whitespace and
 * commas, plus one dangling separator word a skipped candidate left at a
 * fragment end before an accepted `then` ("click A and" → "click A"), and
 * empties are dropped. The split is verbatim — no text is ever rewritten,
 * reordered, or invented, so a count word can never be separated from the
 * verb it counts and parseRepeatCount keeps working per sub-clause. */
export function splitCompoundClause(clause: string): string[] {
  // Separators are matched as whole words, never inside other words — `then`
  // inside `next` is not a boundary.
  const CANDIDATE_RE = /;|\b(?:then|and)\b|,/gi;
  interface Cand {
    start: number;
    end: number;
  }
  const seps = Array.from(clause.matchAll(CANDIDATE_RE)).map((m) => ({
    sep: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
  const cands: Cand[] = [];
  let scanned = 0;
  for (let i = 0; i < seps.length; i++) {
    const { sep, start, end } = seps[i];
    // Quote parity over the text before this separator: any match inside
    // single quotes is part of a quoted name, never a boundary.
    if ((clause.slice(scanned, start).match(/['‘’]/g) ?? []).length % 2 === 1) {
      continue;
    }
    scanned = end;
    if (sep === ',' || sep.toLowerCase() === 'and') {
      // Conditional: the word immediately following must be an action verb,
      // and `check`/`verify` + that/if/whether is an assertion tail, not an
      // action — never a boundary.
      const next = /^[^A-Za-z]*([A-Za-z]+)(?:[^A-Za-z]+([A-Za-z]+))?/.exec(clause.slice(end));
      if (next === null || !VERB_RE.test(next[1])) continue;
      if (
        /^(?:check|verify)$/i.test(next[1]) &&
        next[2] !== undefined &&
        /^(?:that|if|whether)$/i.test(next[2])
      ) {
        continue;
      }
      // A separator whose tail to the next match/clause end is a lone verb
      // word closes a compound name ("Save and Close"), it does not open a
      // sub-goal — a bare verb with no object is not actionable.
      const nameTail = clause
        .slice(end, i + 1 < seps.length ? seps[i + 1].start : clause.length)
        .replace(/^[,\s]+|[,\s.;!?]+$/g, '');
      if (/^[A-Za-z]+$/.test(nameTail) && VERB_RE.test(nameTail)) continue;
    }
    cands.push({ start, end });
  }
  // A candidate is accepted when the text after it (to the next candidate or
  // the end of the clause) is actionable: verb present, no anaphora.
  const cuts: Cand[] = cands.filter((c, i) => {
    const tailEnd = i + 1 < cands.length ? cands[i + 1].start : clause.length;
    const tail = clause.slice(c.end, tailEnd);
    return VERB_RE.test(tail) && !ANAPHORA_RE.test(tail);
  });
  if (cuts.length === 0) return [clause];
  const parts: string[] = [];
  let pos = 0;
  for (const c of cuts) {
    parts.push(clause.slice(pos, c.start));
    pos = c.end;
  }
  parts.push(clause.slice(pos));
  const frags = parts
    .map((p) =>
      p
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .replace(/(?:\band\b|\bthen\b|;)\s*$/i, '')
        .replace(/[,\s]+$/g, ''),
    )
    .filter((p) => p.length > 0);
  return frags.length > 0 ? frags : [clause];
}

/** § r11 Q1: expand every caller clause into ordered sub-clauses.
 * `parents[i]` is the caller index of expanded clause i. All-or-nothing: when
 * the expansion would exceed EXPANDED_CHAIN_MAX returns null and the
 * caller's list runs unsplit — no partial expansion, no invented merges at
 * the cap. Null callers fall back to the identity (clauses = steps, parents =
 * [0..steps.length-1]). Expansion of a valid caller list (<= 12, the
 * validator's CHAIN_MAX_STEPS) is bounded by EXPANDED_CHAIN_MAX; the 12 bound
 * was the CALLER-list limit misapplied to sub-clauses (r11b evidence: 11 of 24
 * calls fell back unsplit). */
const EXPANDED_CHAIN_MAX = 36;

export function expandClauses(steps: string[]): { clauses: string[]; parents: number[] } | null {
  const clauses: string[] = [];
  const parents: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (const sub of splitCompoundClause(steps[i])) {
      clauses.push(sub);
      parents.push(i);
    }
  }
  return clauses.length > EXPANDED_CHAIN_MAX ? null : { clauses, parents };
}

/** § WP-count: true when the trailing CONTIGUOUS run of history entries
 * (walking back from the most recent act) are all: this step
 * (`stepKey === currentStepKey`), a click-family verb, an OBSERVED change
 * (`result === 'page changed'` or — r11 Q3 — `'element gone'`, the strictly
 * stronger change signal of an acted element that can't even be re-found;
 * an entry not yet annotated or annotated 'no visible change' never counts),
 * and the SAME target as the last SIGNAL-CARRYING entry (`path` when present,
 * else `label`) — and that run is at least `count` long. r11 Q3: entries with
 * `before === undefined` (signal-less acts — wait, bare scroll/scroll_up) are
 * SKIPPED rather than breaking the walk, and the run's anchor is the first
 * signal-carrying entry, not the literal tail — a wait between two clicks of
 * the same target no longer hides the run. An intervening SIGNAL-CARRYING
 * act that breaks any of the run conditions (a different verb, a different
 * target, a step boundary, a click that had no visible effect) ends the run
 * at that point; entries before the break are never counted even if they'd
 * otherwise qualify. Residual,
 * accepted risk (matches hasStepEvidence's own disclaimer above): a count
 * met by clicks on the right label but on a page where the click's effect
 * wasn't the step's intended one is not mechanically detectable — this
 * checks that N clicks on the same target each visibly did something, never
 * that the something was correct. */
function hasRepeatCountEvidence(history: HistoryEntry[], currentStepKey: string, count: number): boolean {
  if (history.length === 0) return false;
  // The anchor is the first SIGNAL-CARRYING entry walking back (r11 Q3),
  // found lazily — signal-less tail entries are skipped, not a break.
  let anchor: HistoryEntry | undefined;
  const sameTarget = (h: HistoryEntry): boolean =>
    anchor!.path !== undefined ? h.path === anchor!.path : h.label === anchor!.label;
  let run = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.before === undefined) continue; // signal-less act: skip, don't break
    if (anchor === undefined) anchor = h;
    if (
      h.stepKey !== currentStepKey ||
      !CLICK_FAMILY_OPS.has(h.verb) ||
      (h.result !== 'page changed' && h.result !== 'element gone') ||
      !sameTarget(h)
    ) {
      break;
    }
    run += 1;
  }
  return run >= count;
}

/** § WP-click: true when the last SIGNAL-CARRYING history entry (r11 Q3:
 * `lastEvidenceEntry` reads through signal-less acts such as wait/scroll) is
 * a click-family act on the current step that produced a visible change —
 * 'page changed' or 'element gone' (the strictly stronger signal of an acted
 * element that can no longer be re-found by path+fingerprint — a real DOM
 * change, not a stale enumeration). This is the
 * evidence bar for a click step with NO explicit count word (where
 * hasRepeatCountEvidence can't fire because parseRepeatCount returns
 * undefined). A single 'page changed'/'element gone' click is enough — Jev's
 * stepDoneP
 * never reliably crosses 0.85 on a repeated click, but one observed
 * change IS the signal that the click landed. The stepDoneP >= 0.5 gate
 * (THRESHOLDS.stepDoneWithEvidence) is applied at the call site, not here
 * — this function checks only the history evidence. */
function hasBareClickEvidence(history: HistoryEntry[], currentStepKey: string): boolean {
  const last = lastEvidenceEntry(history, currentStepKey);
  if (last === undefined) return false;
  if (!CLICK_FAMILY_OPS.has(last.verb)) return false;
  return last.result === 'page changed' || last.result === 'element gone';
}

/** r14 D1: landed-navigation evidence — hasBareClickEvidence's entry (this
 * step's last signal-carrying act, click-family, 'page changed' or
 * 'element gone') was made on a document the page has since left. */
function hasNavClickEvidence(history: HistoryEntry[], currentStepKey: string, currentUrl: string): boolean {
  if (!hasBareClickEvidence(history, currentStepKey)) return false;
  const last = lastEvidenceEntry(history, currentStepKey)!;
  return last.beforeUrl !== undefined && leftDocument(last.beforeUrl, currentUrl);
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

/** r13 D4: the exact predicate decideTarget's navigate branch and the stuck
 * round share — a url-typed binding whose value is an http(s) address. */
function isNavigableBinding(name: string, values: Record<string, string>): boolean {
  return name in values && typeHint(values[name]) === 'url' && /^https?:\/\//i.test(values[name]);
}

/** r13 D3 (amended by the verifier wave): the supplied address IS the page we
 * are already on — origin, path AND query equal, hash ignored; false on any
 * parse error. Origin plus pathname alone (the spec's first cut) hid a
 * query-routed hub (`/?view=home` vs `/?view=item`) from the offer. The hash
 * stays ignored so a page that became `/#` after an `href="#"` click still
 * counts as the supplied `/`. Hash-routed hubs keep only `back`. */
function sameDocument(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return false;
  }
}

/** r14 D1: the page left the document an act was made on — both addresses
 * parse and sameDocument says they differ. A parse failure is never "left". */
function leftDocument(from: string, to: string): boolean {
  try { new URL(from); new URL(to); } catch { return false; }
  return !sameDocument(from, to);
}

/** r13 D3: the one reader of a recover answer, shared by the error path
 * (decideEarly, runChainEarly rule 4) and the stuck round: the chosen id when
 * its probability clears THRESHOLDS.recover, else 'give-up'. */
function recoverChoice(answers: AnswerMap): string {
  const rec = answers['recover'] as JevChoiceAnswer | undefined;
  const rc = rec?.choice;
  return rec && typeof rc === 'string' && (rec.probabilities[rc] ?? 0) >= THRESHOLDS.recover ? rc : 'give-up';
}

/** r13 D8: one error-message line with page content stripped — cut at the first
 * `<` (drops HTML snippets), quote-strip, redact bound values, collapse
 * whitespace, strip one leading `-`, cap at 120 chars. */
function sanitizeErrorLine(line: string, values: Record<string, string>): string {
  let s = line;
  const lt = s.indexOf('<');
  if (lt >= 0) s = s.slice(0, lt) + '…';
  s = s.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '…');
  s = redactValues(s, values);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.startsWith('-')) s = s.slice(1).trim();
  return s.slice(0, 120);
}

/** r13 D8: the act-error log field. A non-WingmanError never carries message
 * text (only its class name); a WingmanError carries the sanitized first line
 * and, with two or more lines, the sanitized last line. */
export function describeActError(
  e: unknown,
  op: Op | null,
  values: Record<string, string>,
): { op?: Op; head: string; tail?: string } {
  const opPart = op !== null ? { op } : {};
  if (!(e instanceof WingmanError)) {
    return { ...opPart, head: e instanceof Error ? 'fault: ' + e.name : 'fault' };
  }
  const lines = e.message
    .split(/\r?\n/)
    .map((l) => sanitizeErrorLine(l, values))
    .filter((l) => l !== '');
  const head = lines[0] ?? '';
  return lines.length >= 2 ? { ...opPart, head, tail: lines[lines.length - 1] } : { ...opPart, head };
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
  // r13 D8: the op of the driver.act call in flight (set just before each of
  // the 2 act sites, cleared after it resolves) and the sanitized act error
  // the catch block records for the log.
  let inFlightOp: Op | null = null;
  let actError: WingmanLogRecord['act_error'];

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
    // Noul-question probabilities (tuning data, 2026-09-28): only when that
    // question was asked this round (§ CLAUDE.md round-shape gotcha — never
    // assign an optional telemetry field from a possibly-undefined source).
    doneP?: number; stepDoneP?: number; readyP?: number; rightPageP?: number; errorP?: number;
    // § WP-count: set only on the round where a deterministic repeat-count
    // advance/done fired (runChainEarly rule 3 / decideEarly rule 3b), to the
    // count that was satisfied. Guarded like every other optional field here
    // — never assigned when the branch didn't fire.
    countEvidence?: number;
    step_text?: string;    // redacted current step text (chain clause or legacy step), browse_step only
    clickEvidence?: true;  // WP-click: set on the round where bare-click evidence fired
    stuck?: string;        // r13: the stuck-recover answer id (back / open_<name> / give-up), stuck rounds only
    navEvidence?: true;    // r14: set only on an advance that ONLY landed-navigation evidence allowed
    leftPage?: boolean;    // r14: chain rounds whose last history entry has beforeUrl: did the page leave that document
  };
  const phaseAcc: {
    attachMs?: number;
    firstObserveMs?: number;
    stepTextsStart?: string;
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
    // Noul-question probabilities (tuning data, 2026-09-28): written only
    // when that question was actually asked this round. step_done/ready/
    // right_page are chain-only; `error` rides whenever round >= 2 in
    // every mode (wingman_do and browse_step included), so a multi-round
    // non-chain call gets errorP too — guarded per the round-shape gotcha
    // (never assign from a possibly-undefined source, since `{k: undefined}`
    // is not deep-equal to `{}`).
    const noulOf = (id: string): number | undefined => {
      const a = answers[id];
      return a && a.type === 'noul' ? a.noul : undefined;
    };
    const done = noulOf('done');
    if (done !== undefined) cur.doneP = done;
    const stepDone = noulOf('step_done');
    if (stepDone !== undefined) cur.stepDoneP = stepDone;
    const ready = noulOf('ready');
    if (ready !== undefined) cur.readyP = ready;
    const rightPage = noulOf('right_page');
    if (rightPage !== undefined) cur.rightPageP = rightPage;
    const error = noulOf('error');
    if (error !== undefined) cur.errorP = error;
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
      // § 5.5.2 progress on every chain-mode result. r11 Q1: parent-mapped —
      // the cursor/N run over the EXPANDED sub-clause list, but the caller
      // sees its own numbering (expansion preserves order, so parents[cursor]
      // is exactly the count of fully-completed caller clauses).
      if (r.progress === undefined) {
        r.progress = {
          step_index: chainState.cursor >= chainState.N ? chainState.callerN : chainState.parents[chainState.cursor] + 1,
          steps_done: chainState.cursor >= chainState.N ? chainState.callerN : chainState.parents[chainState.cursor],
          steps_total: chainState.callerN,
        };
      }
      // Memory write-back: done deletes, anything else stores.
      chainMemory.delete(chainState.key);
      if (r.status !== 'done') {
        chainMemory.set(chainState.key, {
          cursor: chainState.cursor,
          acts: chainState.priorActs + steps,
          cursorActed: chainState.cursorActed,
          stuckTried: chainState.stuckUsed,
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
      ...(phaseAcc.stepTextsStart !== undefined ? { step_texts_start: phaseAcc.stepTextsStart } : {}),
      ...(actError !== undefined ? { act_error: actError } : {}),
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
    history: HistoryEntry[],
    stepText: string | undefined,
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
    // 3b. § WP-count deterministic repeat-count evidence: the browse_step
    // step text (or the wingman_do goal, which is this call's only step) names
    // an explicit count ("click it twice") that the acted-on history already
    // satisfies — this ends the call as done regardless of Jev's done Noul,
    // which (like stepDoneP) never fires reliably on a repeated click.
    if (stepText !== undefined) {
      const repeatCount = parseRepeatCount(stepText);
      if (repeatCount !== undefined && hasRepeatCountEvidence(history, 'single', repeatCount)) {
        if (cur) cur.countEvidence = repeatCount;
        return { result: mk('done', 'goal-met') };
      }
      // § WP-click: a count-less click step whose last act visibly changed
      // the page ends done at the evidence bar (0.5) instead of 0.85.
      if (
        repeatCount === undefined &&
        hasBareClickEvidence(history, 'single') &&
        noulOf('done') >= THRESHOLDS.stepDoneWithEvidence
      ) {
        if (cur) cur.clickEvidence = true;
        return { result: mk('done', 'goal-met') };
      }
    }
    // 4. error (round ≥ 2 only; the question is only asked then)
    if (round >= 2 && noulOf('error') >= THRESHOLDS.error) {
      if (tool !== 'browse_step') {
        // wingman_do keeps error → page-error and is never asked recover.
        return { result: mk('error', 'page-error') };
      }
      // § 5.5.4 recover, exactly as chain rule 4; the counter is per call.
      const r = recoverChoice(answers);
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
        (urlAnswer.probabilities[c] ?? 0) >= THRESHOLDS.url &&
        isNavigableBinding(c, values)
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
    inFlightOp = action.verb;
    await driver.act(pageId, el.id, action.verb, actValue);
    inFlightOp = null;
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
          beforeUrl: obs.url,
          stepKey,
          ...(action.verb === 'select' && action.optionValue !== undefined
            ? { intendedLabel: el.options?.find((o) => o.value === action.optionValue)?.label }
            : {}),
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
    actError = describeActError(
      e,
      inFlightOp,
      tool === 'wingman_check' ? {} : ((validated.input as DoInput | StepInput).values ?? {}),
    );
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
      // r11 Q1: the key stays on the caller's ORIGINAL clause array —
      // expansion is deterministic, so the stored cursor stays valid across
      // calls and a mid-clause resume lands on the exact sub-clause.
      const clauses = stepInput.steps as string[];
      const key = JSON.stringify([stepInput.goal, clauses]);
      const mem = chainMemory.get(key);
      // § r11 Q1: each caller clause expands into ordered sub-clauses; null
      // (would exceed EXPANDED_CHAIN_MAX) falls back to the identity mapping.
      const exp = expandClauses(clauses);
      chainState = {
        key,
        clauses: exp?.clauses ?? clauses,
        N: (exp?.clauses ?? clauses).length,
        parents: exp?.parents ?? clauses.map((_, i) => i),
        callerN: clauses.length,
        cursor: mem?.cursor ?? 0,
        priorActs: mem?.acts ?? 0,
        clauseRetried: false,
        firstCommitDone: false,
        wrongPageRounds: 0,
        notReadyRounds: 0,
        recoverActs: 0,
        cursorActed: mem?.cursorActed ?? false,
        stuckUsed: mem?.stuckTried ?? false,
        stuckPending: null,
        retryNone: false,
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
    // r13: hoisted from the loop body — the round's merged answer map, read by
    // stuckEligible (D1 rules 7-8) at the two chain bounce sites.
    let decisionAnswers: AnswerMap = {};

    /** A committed decision about to pass the gate and the act site. */
    interface Decision {
      el: ElementRecord | null;
      verb: Op;
      binding?: string;
      optionValue?: string;
      gate: boolean;
      // r13: set on a stuck-recover decision (carries the deferred bounce).
      stuck?: StuckPending;
    }

    // Legacy entry state: `entryPending` is true while the next round's entry
    // decision is still due. `retried` pins the at-most-one retry of § 3.19.
    const entryStep = entry?.kind === 'legacy' ? redactValues(entry.step, values).slice(0, 300) : undefined;
    const entryBindings = entry?.kind === 'legacy' ? bindingsInStep(entry.step, values) : [];
    // § WP-count: the one step text decideEarly's repeat-count rule checks —
    // the browse_step legacy step ONLY, never the wingman_do goal (verifier
    // fix, 2026-09-28: a wingman_do goal is a whole-task description that
    // may legitimately name several actions — e.g. bench t9-long-chain's
    // "...click the Add Element button twice; open Inputs and type the
    // amount..." run via a single wingman_do call per the wingman_do route
    // prompt, "call it ONCE with the full goal". Reading a count word
    // anywhere in that text and applying it against the whole call's history
    // (stepKey 'single') ended the ENTIRE goal done/goal-met the moment the
    // embedded "twice" clause's two clicks landed, abandoning every clause
    // after it, even though Jev's own `done` noul never crossed threshold.
    // A legacy browse_step `step` has no such multi-clause risk — chain mode
    // already scopes this correctly per clause via `steps`/`clauses`, and a
    // single `step` is documented as one atomic instruction). Raw (never
    // redacted or capped) since this is parsed internally only, never
    // returned or logged.
    const legacyStepText = entry?.kind === 'legacy' ? entry.step : undefined;
    let entryPending = entry !== undefined;
    let retried = false;
    const retryAllowed = entry?.kind === 'legacy' && takeoverOf(deps.config).retry;
    type ReviewWhy = 'no-match' | 'multi-match' | 'low-confidence' | 'no-value' | 'offered' | 'target-covered'
      | 'already-done' | 'wrong-page' | 'not-ready' | 'repeat';
    const entryReview = (why: ReviewWhy, candidates: Array<{ label: string; role?: string; name?: string }>) => ({
      step_review: { step: capLabel(entryStep ?? ''), why, candidates },
    });
    const bounce = (why: ReviewWhy, candidates: Array<{ label: string; role?: string; name?: string }>) =>
      mk('fallback', 'step-uncertain', entryReview(why, candidates));
    const canRetry = () => retryAllowed && !retried && remaining() >= TIME_FLOOR_MS;

    // Chain state (§ 5.5.2), created by runBrowse.
    const chain = entry?.kind === 'chain' ? chainState : null;
    // r11 Q1: `entry.clauses` is the caller's ORIGINAL array (chainState's is
    // the expanded list) — the step_texts_start telemetry names the caller's
    // own first clause.
    if (entry?.kind === 'chain') phaseAcc.stepTextsStart = redactValues(entry.clauses[0], values).slice(0, 300);
    const N = chain?.N ?? 0;
    const clauseText = (i: number): string => redactValues(chain!.clauses[i], values).slice(0, 300);
    const clauseReviewStep = () => capLabel(clauseText(Math.min(chain!.cursor, N - 1)));
    /** A wrong-page / not-ready bounce: no retry (§ 5.5.2 rules 5–6). */
    const chainBounce = (why: 'wrong-page' | 'not-ready'): WingmanResult =>
      mk('fallback', 'step-uncertain', { step_review: { step: clauseReviewStep(), why, candidates: [] } });
    /** § 5.5.2 rule 9: one retry per clause, then the bounce with evidence. */
    /** The chain round's Jev state (also the stuck round's): the clause text and
     * the caller-numbered step position (r11 Q1 OPEN-1). */
    const chainRoundState = (obs: Observation): object =>
      buildState(
        obs,
        history,
        doInput.goal,
        values,
        clauseText(chain!.cursor),
        // r11 Q1 OPEN-1: Jev-visible step numbers stay in the CALLER's
        // numbering — same parent mapping as finish()'s progress, so a
        // cursor inside caller clause p reports "step p+1 of callerN".
        {
          stepNumber: chain!.cursor >= N ? chain!.callerN : chain!.parents[chain!.cursor] + 1,
          stepsTotal: chain!.callerN,
        },
      );
    /** r13 D1: may this would-be bounce attempt a stuck recovery instead? All
     * of rules 1-9, in order. */
    const confidentNoneLook = (): boolean => {
      const action = decisionAnswers['action'] as JevChoiceAnswer | undefined; // 7
      if (!action || typeof action.choice !== 'string' || !STUCK_VERBS.has(action.choice)) return false;
      const target = decisionAnswers['target'] as JevChoiceAnswer | undefined; // 8
      return !!target && target.choice === 'none' && (target.probabilities?.['none'] ?? 0) >= STUCK_NONE_MIN;
    };
    const stuckEligible = (why: ReviewWhy): boolean => {
      if (why !== 'no-match' && why !== 'low-confidence' && why !== 'wrong-page') return false; // 1
      if (participation !== 'execute') return false; // 2
      const c = chain!;
      if (c.cursorActed) return false; // 3
      if (c.stuckUsed || c.stuckPending !== null) return false; // 4
      if (c.recoverActs >= RECOVER_MAX_PER_CLAUSE) return false; // 5
      if (steps >= maxSteps || remaining() < TIME_FLOOR_MS) return false; // 6
      if (!confidentNoneLook()) return false; // 7-8
      // D1 guard 1: with the retry on, the retry round must have been a
      // confident none too (two consecutive looks), never an ambiguous one.
      if (takeoverOf(deps.config).retry && !c.retryNone) return false;
      // 9: a destination exists.
      if (offeredSet.has('back')) return true;
      return offeredSet.has('navigate') && Object.keys(urlBindings(values)).length > 0;
    };
    /** r13 D3: the deferred bounce a failed/declined stuck recovery returns —
     * identical to what the trigger site would have returned. */
    const stuckBounce = (p: StuckPending): WingmanResult =>
      p.why === 'wrong-page'
        ? chainBounce('wrong-page')
        : mk('fallback', 'step-uncertain', { step_review: { step: clauseReviewStep(), why: p.why, candidates: p.candidates } });
    const chainNonCommit = (
      why: ReviewWhy,
      candidates: Array<{ label: string; role?: string; name?: string }>,
    ): WingmanResult | null => {
      if (takeoverOf(deps.config).retry && !chain!.clauseRetried && remaining() >= TIME_FLOOR_MS) {
        chain!.clauseRetried = true;
        chain!.retryNone = confidentNoneLook();
        return null; // the next round retries the clause
      }
      if (stuckEligible(why)) {
        chain!.stuckPending = { why: why as StuckPending['why'], candidates };
        return null;
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
      // Multi-action-step guard (verifier, 2026-09-28): the evidence bar
      // reads only the LAST act, so a compound step naming more than one
      // supplied binding (e.g. "fill name and email") could otherwise be
      // marked done after only the FIRST field lands — the second still
      // empty. `bindingsInStep` (already used to anchor the value question,
      // above) is the cheapest available signal for "how many fields does
      // this step's text actually name": count ≤ 1 permits the evidence bar,
      // count ≥ 2 forces the ordinary 0.85 stepDone bar, which judges the
      // WHOLE step text rather than the single most recent act. Residual,
      // accepted risk (flagged for the orchestrator): a compound step whose
      // second target isn't a named `values` binding (e.g. "check the box
      // and select the option", where neither half names a supplied value)
      // still reads as count ≤ 1 and is not caught by this guard — closing
      // that gap needs semantic parsing of the step text, out of scope here.
      const stepBindingCount = bindingsInStep(chain!.clauses[chain!.cursor], values).length;
      // § WP-count: a step naming an explicit repeat count ("click it
      // twice") is its own evidence bar — no Jev threshold at all, since the
      // observed count IS the evidence (Jev's stepDoneP never reliably
      // crosses THRESHOLDS.stepDone on a repeated click; see the click-count
      // dispatch evidence). Must be checked, and fire, before any FURTHER act
      // in this step — it lives in this same rule-3 early-return, ahead of
      // the decide step that would otherwise perform click count+1.
      const repeatCount = parseRepeatCount(chain!.clauses[chain!.cursor]);
      const repeatCountMet =
        repeatCount !== undefined && hasRepeatCountEvidence(history, `c${chain!.cursor}`, repeatCount);
      // § WP-click: a count-less click step advances at the evidence bar
      // once its last act was a click that visibly changed the page.
      const bareClickEvidence =
        repeatCount === undefined &&
        hasBareClickEvidence(history, `c${chain!.cursor}`);
      const priorAdvance =
        stepDone >= THRESHOLDS.stepDone ||
        (action?.choice === 'none' && stepDone >= THRESHOLDS.stepDoneNoAction) ||
        (stepDone >= THRESHOLDS.stepDoneWithEvidence &&
          stepBindingCount <= 1 &&
          hasStepEvidence(history, `c${chain!.cursor}`)) ||
        repeatCountMet ||
        (stepDone >= THRESHOLDS.stepDoneWithEvidence && bareClickEvidence);
      // r14 D1: landed-navigation evidence (below the 0.5 evidence bar, never
      // through an error). Condition 6 (orchestrator R2b): never on the final
      // expanded clause, where an advance would end the call done/goal-met.
      const navAdvance =
        !priorAdvance &&
        bareClickEvidence &&
        chain!.cursor < chain!.N - 1 &&
        stepBindingCount <= 1 &&
        stepDone >= THRESHOLDS.stepDoneWithNavEvidence &&
        noulOf('error') < THRESHOLDS.error &&
        hasNavClickEvidence(history, `c${chain!.cursor}`, obs.url);
      if (priorAdvance || navAdvance) {
        if (repeatCountMet && cur) cur.countEvidence = repeatCount;
        if (bareClickEvidence && cur) cur.clickEvidence = true;
        if (navAdvance && cur) cur.navEvidence = true;
        return { kind: 'advance' };
      }
      // 4. error and recover (round ≥ 2; the question rides only then)
      if (round >= 2 && noulOf('error') >= THRESHOLDS.error) {
        const r = recoverChoice(answers);
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
      // 5. ready (Q5) — skipped outright when this round's decided action is
      // a targetless navigation verb (diagnosis 2026-09-28, r6 Part 3
      // Finding: every not-ready bounce in the fresh-install sample carried
      // a decided action of navigate at actionP 0.94-0.98). `ready` asks
      // about the CURRENT page's state, but a navigate/back/reload step is,
      // by definition, the one that leaves the current page — gating it on
      // the current page's readiness was bouncing not-ready on effectively
      // every first-navigate step. `action` (read at rule 3 above) already
      // carries the round's decided verb before rule 5 runs, so it is
      // available here without re-asking anything.
      //
      // right_page (rule 6, below) is deliberately NOT included in this
      // skip (verifier finding, 2026-09-28): unlike `ready`, a low
      // `right_page` never blocked or detoured the round on its own — it
      // only counts consecutive wrong-page rounds toward WRONG_PAGE_MAX, and
      // the r6 evidence for this skip was entirely about not-ready bounces,
      // never about wrong-page ones. `back`/`navigate` is the model's
      // documented recovery move for a wrong page (§ ACTION_CRITERIA:
      // "back: … because the last action led to a wrong or broken page"), so
      // skipping right_page whenever the decided action is back/navigate
      // would freeze the counter on exactly the rounds it exists to count,
      // letting a flapping wrong-page recovery loop (e.g. bouncing between
      // two or more always-wrong pages) run to budget-steps instead of
      // cleanly bouncing wrong-page.
      const decidedAction = action?.choice;
      const skipsReadyGate =
        typeof decidedAction === 'string' && (NAVIGATION_OPS as ReadonlySet<string>).has(decidedAction);
      if (!skipsReadyGate) {
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
      }
      // 6. right page (Q5): below WRONG_PAGE_MAX the round continues to rule 7
      // and the decide step unchanged, so Jev may still choose back/navigate.
      // Always runs, even when rule 5 was skipped above (see comment there).
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
        chain!.cursorActed = false;
        chain!.stuckUsed = false;
        chain!.stuckPending = null;
        chain!.retryNone = false;
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
      if (early.kind === 'bounceWrongPage') {
        if (stuckEligible('wrong-page')) {
          chain!.stuckPending = { why: 'wrong-page', candidates: [] };
          return { t: 'continue' };
        }
        return { t: 'result', result: chainBounce('wrong-page') };
      }
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
      if (isBrowse) {
        bucket.step_text = chain
          ? clauseText(Math.min(chain.cursor, N - 1))
          : (entryStep ?? '');
      }
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
      const lastEntry = history.length > 0 ? history[history.length - 1] : undefined;
      if (chain && lastEntry?.beforeUrl !== undefined) bucket.leftPage = leftDocument(lastEntry.beforeUrl, obs.url);

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
          if (chain) chain.cursorActed = true;
          continue;
        }
      }

      let decision: Decision | null = null;
      decisionAnswers = {};

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

      // ---- r13 stuck round (D2): a deferred stuck recovery runs here, after
      // the observe/dialog/captcha/policy/token/pick blocks, as one recover
      // ask in place of the normal round ask. It yields a mechanical decision
      // for the SHARED act tail, or the deferred bounce.
      if (decision === null && chain && chain.stuckPending !== null) {
        const pend = chain.stuckPending;
        chain.stuckPending = null;
        chain.stuckUsed = true;
        const urlNames = offeredSet.has('navigate')
          ? Object.keys(urlBindings(values)).filter((n) => isNavigableBinding(n, values) && !sameDocument(values[n], obs.url))
          : [];
        const back = offeredSet.has('back');
        if (!back && urlNames.length === 0) return stuckBounce(pend);
        const sized = withStateSize(chainRoundState(obs),
          (s) => buildRecoverRequest({ state: s, bindings: values, back, urlNames }), (p) => p);
        if (!sized.ok || remaining() < TIME_FLOOR_MS) return stuckBounce(pend);
        const rr = await askWithCost(sized.payload, 'browse_step', remaining);
        if (!rr.ok) return mk('fallback', askFailReason(rr));
        const id = recoverChoice(rr.answers as AnswerMap);
        const offeredIds = new Set<string>([...(back ? ['back'] : []), ...urlNames.map((n) => RECOVER_OPEN_PREFIX + n)]);
        bucket.stuck = offeredIds.has(id) ? redactValues(id, values) : 'give-up';
        if (!offeredIds.has(id)) return stuckBounce(pend);
        chain.recoverActs += 1;
        chain.wrongPageRounds = 0;
        chain.notReadyRounds = 0;
        recoveredThisRound = true;
        decision = id === 'back'
          ? { el: null, verb: 'back', gate: false, stuck: pend }
          : { el: null, verb: 'navigate', binding: id.slice(RECOVER_OPEN_PREFIX.length), gate: false, stuck: pend };
      }

      // ---- build the state, ask, and decide (§ 3.7 / § 5.5.2) ----
      if (decision === null) {
        const state0 = chain
          ? chainRoundState(obs)
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
            const early = decideEarly(primary, round, obs, values, legacyRecoverActs, hasOp, history, legacyStepText);
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
            const early = decideEarly(primary, round, obs, values, legacyRecoverActs, hasOp, history, legacyStepText);
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
        // § WP-click repeat guard: on a count-less click step, if the last act
        // was a same-target click that changed the page and Jev picks the SAME
        // target again, hand back instead of clicking — the step already has its
        // evidence (one page change) and re-clicking the same target with
        // stepDoneP < 0.5 is the r6/r7/r8/r9 over-click defect. Scope: chain
        // clause + legacy browse_step only, never wingman_do.
        const guardStepText = chain
          ? chain.clauses[chain.cursor]
          : (entry?.kind === 'legacy' ? entry.step : undefined);
        if (
          isBrowse &&
          !recoveredThisRound &&
          guardStepText !== undefined &&
          parseRepeatCount(guardStepText) === undefined &&
          hasBareClickEvidence(history, currentStepKey) &&
          decision.el !== null &&
          CLICK_FAMILY_OPS.has(decision.verb)
        ) {
          const last = history[history.length - 1];
          const sameTarget = last.path !== undefined ? decision.el.path === last.path : decision.el.name === last.label;
          if (sameTarget) {
            const candidates = [candidateOf(decision.el, values)];
            const step = chain ? clauseReviewStep() : capLabel(entryStep ?? '');
            return mk('fallback', 'step-uncertain', { step_review: { step, why: 'repeat', candidates } });
          }
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
        const stuckPend = decision.stuck;
        inFlightOp = decision.verb;
        try {
          await driver.act(pageId, decision.el ? decision.el.id : null, decision.verb, actValue);
        } catch (e) {
          // r13 D7: a stuck-recover back with no history is the deferred
          // bounce, not an act failure; every other error propagates.
          if (stuckPend !== undefined && e instanceof NoHistoryError) {
            inFlightOp = null;
            return stuckBounce(stuckPend);
          }
          throw e;
        }
        inFlightOp = null;
        bucket.actMs += now() - tAct;
        if (decision.verb === 'wait') {
          waits += 1;
        } else {
          steps += 1;
        }
        if (chain && decision.el !== null) chain.cursorActed = true;
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
            beforeUrl: obs.url,
            stepKey: currentStepKey,
            ...(decision.verb === 'select' && decision.optionValue !== undefined && decision.el
              ? { intendedLabel: decision.el.options?.find((o) => o.value === decision.optionValue)?.label }
              : {}),
            // r13 D6: a stuck navigate is not step evidence unless the clause
            // itself names the chosen binding.
            ...(decision.stuck !== undefined &&
            decision.verb === 'navigate' &&
            !(decision.binding !== undefined &&
              bindingsInStep(chain!.clauses[chain!.cursor], values).includes(decision.binding))
              ? { stuckRecover: true as const }
              : {}),
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
