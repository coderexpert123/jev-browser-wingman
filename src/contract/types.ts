export const OPS = [
  'click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll',
  'scroll_up', 'dblclick', 'hover', 'upload', 'navigate', 'back', 'wait', 'scroll_to', 'reload',
] as const;
export type Op = (typeof OPS)[number];
/** Ops that act on no element: the loop always passes elementId null for them. Adapters still accept an element id for `scroll` (today's verified-element wheel; tests/conformance.test.ts:280 uses it). `scroll_to` is targeted (it scrolls one element into view). */
export const TARGETLESS_OPS: readonly Op[] = ['scroll', 'scroll_up', 'wait', 'navigate', 'back', 'reload'];
/** Ops a Driver without an `ops` declaration is assumed to support (the pre-0.3.0 set). */
export const LEGACY_OPS: readonly Op[] = ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll'];
/** Fixed key enumeration for `press` (§ 5.4 key Choice ids = these). ShiftTab = Shift+Tab; SelectAll = Ctrl+A (Cmd+A on macOS). */
export const PRESS_KEYS = [
  'Enter', 'Tab', 'ShiftTab', 'Escape', 'Space', 'Backspace', 'SelectAll', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
] as const;
export type PressKey = (typeof PRESS_KEYS)[number];
/** browse_step `pick` (§ 5.6). */
export interface PickInput { role?: string; name?: string; action: Op; nth?: number; value?: string }

export const STATUSES = ['done', 'needs_confirmation', 'blocked', 'login', 'ambiguous', 'error', 'fallback'] as const;
export type Status = (typeof STATUSES)[number];

export const SENSITIVE_HOST_CATEGORIES = ['banking', 'payments', 'webmail', 'identity', 'government', 'tax', 'health'] as const;
export type SensitiveHostCategory = (typeof SENSITIVE_HOST_CATEGORIES)[number];

export const REASONS = {
  done: ['goal-met', 'answered'],
  needs_confirmation: ['irreversible-heuristic', 'irreversible-jev'],
  blocked: ['captcha', 'page-blocked', 'dialog-open', 'covered-target', 'lock-held', 'busy'],
  login: ['login-page'],
  ambiguous: ['tab-ambiguous', 'target-uncertain', 'no-action', 'no-value'],
  error: ['page-error', 'stale-element', 'act-failed', 'tool-fault', 'invalid-input', 'confirm-token-invalid'],
  fallback: [
    'mode-off', 'no-browser', 'no-key', 'breaker-open', 'jev-error', 'shadow', 'budget-steps', 'budget-time',
    'state-too-large', 'unsupported-page', 'unsupported-op',
    'sensitive-banking', 'sensitive-payments', 'sensitive-webmail', 'sensitive-identity', 'sensitive-auth-path',
    'sensitive-government', 'sensitive-tax', 'sensitive-health', 'sensitive-password', 'sensitive-otp',
    'sensitive-payment-field', 'step-uncertain', 'takeover-offered', 'target-covered', 'no-progress',
  ],
} as const;
export type Reason = (typeof REASONS)[keyof typeof REASONS][number];

export interface Rect { x: number; y: number; w: number; h: number }          // document coordinates, integers
export interface Fingerprint { tag: string; role: string; name: string; x: number; y: number }

export interface ElementRecord {
  id: string;              // 'e1', 'e2', … in document order among candidates
  path: string;            // unique CSS selector of the element to act on (the wrapping label for a proxied control)
  controlPath?: string;    // the real input when `path` is a proxy label (styled checkbox/radio)
  tag: string;             // lowercase tag of the control (input for a proxied control)
  role: string;            // explicit role attribute, else implicit role (§ 3.5)
  name: string;            // accessible name, whitespace-collapsed, ≤80 chars
  type: string;            // input type / button.type, else ''
  attrName: string;        // the name attribute, ≤80 chars, else ''
  placeholder?: string;    // placeholder attribute, collapsed, ≤80 chars, else '' (§ 3.5 amendment 2026-09-21b)
  htmlId?: string;         // the element's id attribute, ≤80 chars, else '' (§ 3.5 amendment 2026-09-21b)
  ariaLabel: string;       // aria-label attribute, ≤80 chars, else ''
  autocomplete: string;    // autocomplete attribute lowercased, else ''
  state: { checked?: boolean; filled?: boolean; selected?: string; disabled: boolean; expanded?: boolean };
  editable: boolean;
  inViewport: boolean;
  rect: Rect;
  form: number;            // index into Observation.forms, or -1
  options?: Array<{ value: string; label: string }>;   // native <select> only; label ≤80, value ≤200
  obscured?: boolean;      // § 3.5 amendment 2026-09-21h: the enumerate-time occlusion probe found another element on top
  coveredBy?: string;      // what covers it when `obscured` (tag plus #id), ≤80 chars; page-derived — redact before egress
  fingerprint: Fingerprint;
}

export interface FormRecord { index: number; id: string; name: string; actionPath: string; method: string }

export interface PageSignals {
  password: boolean;         // any input[type=password] in the document
  currentPassword: boolean;  // autocomplete=current-password present
  newPassword: boolean;      // autocomplete=new-password present
  otpAutocomplete: boolean;  // autocomplete=one-time-code present
  ccAutocomplete: boolean;   // any autocomplete value starting with cc-
  otpText: boolean;          // visible text matches OTP_TEXT_RE (§ 3.5)
  captcha: boolean;          // CAPTCHA_RE matches an iframe src or an element id/class
}

export interface Observation {
  url: string;
  title: string;
  elements: ElementRecord[];
  forms: FormRecord[];
  signals: PageSignals;
  text: string;              // visible text excerpt, ≤ max_text_chars
  truncated: boolean;        // true when more than MAX_ENUMERATED candidates existed
}

export interface PageInfo { id: string; url: string; title: string; visible: boolean }   // id = CDP targetId
export type AttachTarget =
  | { cdpEndpoint: string }
  | { launch: { profileDir: string; headed: boolean; port: number; chromePath: string | null } };
export interface DialogEvent { pageId: string; type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string }

export interface Driver {
  readonly name: string;                                  // 'playwright' | 'cdp' for the shipped adapters
  /** the ops this adapter executes; absent = LEGACY_OPS. The router never asks Jev for an op outside this set (§ 5.5.6). */
  readonly ops?: readonly Op[];
  attach(target: AttachTarget): Promise<void>;
  pages(): Promise<PageInfo[]>;                            // default-context page targets only
  observe(pageId: string): Promise<Observation>;
  /** elementId is null only for ops in TARGETLESS_OPS; scroll also accepts an element id (legacy form, same wheel).
   * value: fill text, select option value, press key (a PressKey; absent = Enter), navigate URL (http/https), upload absolute file path. */
  act(pageId: string, elementId: string | null, op: Op, value?: string): Promise<void>;
  settle(pageId: string, budgetMs: number): Promise<{ settled: boolean; ms: number }>;
  onDialog(handler: (e: DialogEvent) => void): void;
  detach(): Promise<void>;
}

export interface DoInput {
  goal: string; values?: Record<string, string>; url_match?: string; confirm_token?: string;
  max_steps?: number; max_ms?: number;
}
export interface CheckInput { question: string; url_match?: string }

export interface WingmanResult {
  status: Status;
  reason: Reason;
  steps: number;
  last_action?: { verb: Op; label: string };
  candidates?: Array<{ label: string; role?: string; name?: string }>;
  pending?: { verb: Op; label: string };
  confirm_token?: string;
  shadow?: true;
  answer?: number;                    // wingman_check only, 0..1 rounded to 2 decimals
  note?: string;                      // static continuation hint on non-done wingman_do results; never page text
  step_review?: {                    // browse_step only (§ 3.17, amendment 2026-09-21d): entry-round bounce/offer evidence
    step: string;                    // the redacted proposed step text, capped to LABEL_MAX
    why: 'no-match' | 'multi-match' | 'low-confidence' | 'no-value' | 'offered' | 'target-covered'
       | 'already-done' | 'wrong-page' | 'not-ready' | 'no-progress' | 'repeat';
    candidates: Array<{ label: string; role?: string; name?: string }>;   // top 3 target candidates: redacted criteria labels
  };
  progress?: { step_index: number; steps_done: number; steps_total: number };
  missing_binding?: string;           // a binding NAME, never a value
  cost: { jev_calls: number; input_tokens: number; output_tokens: number; ms: number };
  labels_untrusted: true;
}

// Jev shapes: structurally identical to pa/src/lib/typesafe-client.ts so PA's askSystemOne assigns to JevAsk.
export interface JevCriterionDetail { what: string; not_for?: string; examples?: string[] }
export interface JevChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string | null | JevCriterionDetail> }
export interface JevNoulQuestion { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export interface JevRequest { state: unknown; questions: Record<string, JevQuestion> }
export interface JevChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface JevNoulAnswer { type: 'noul'; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;
export type JevErrorKind = 'no-key' | 'circuit-open' | 'timeout' | 'http' | 'network' | 'invalid-response';
export type JevResult =
  | { ok: true; answers: Record<string, JevAnswer>; usage: { inputTokens: number; outputTokens: number }; latencyMs: number; status: number; retries: number }
  | { ok: false; error: JevErrorKind; status?: number; retryAfterMs?: number; latencyMs: number; retries: number };
export interface JevAskOptions { purpose: string; timeoutMs?: number }
export type JevAsk = (request: JevRequest, opts: JevAskOptions) => Promise<JevResult>;

export type LockCheckResult = { ok: true } | { ok: false; reason: 'lock-held' };
export interface WingmanLogRecord {
  ts: string; tool: 'wingman_do' | 'wingman_check' | 'browse_step'; mode: 'off' | 'shadow' | 'on'; adapter: string;
  status: Status; reason: Reason; steps: number; host: string; gate_hits: number;
  jev_calls: number; input_tokens: number; output_tokens: number; ms: number;
  would?: { verb: Op; role: string };   // shadow mode only
  progress?: { step_index: number; steps_done: number; steps_total: number };
  pick?: true;
  acts_by_op?: Partial<Record<Op, number>>;
  // No-progress telemetry (WP-outcome-evidence): the why and the candidate
  // COUNT of this call's final step_review, when it carries one. Never the
  // candidate labels themselves — those are page text, kept out of log.jsonl
  // like every other field here.
  step_review?: { why: string; candidates: number };
  // WP-click: the redacted first chain clause (chain mode only, capped to 300 chars).
  step_texts_start?: string;
  // r13: the sanitized act error (op in flight, first and last message lines), written only on the exception path.
  act_error?: { op?: Op; head: string; tail?: string };
  // Per-phase wall-time breakdown, ms. Numbers only — never page text.
  // attachMs/firstObserveMs are once per invocation; rounds is one entry per
  // § 3.7 round (wingman_check records one round with observeMs/jevMs only).
  // The per-round fields below are for threshold tuning (WP-outcome-evidence
  // telemetry): action/target are the round's chosen ids and probabilities
  // (labels, not raw page text — already sent to Jev as criteria and
  // returned in results); historyResult is the outcome evidence (§ WP-A) of
  // the element/verb this round acted on, once known. Never a raw value.
  phases?: {
    attachMs?: number;
    firstObserveMs?: number;
    rounds: Array<{
      observeMs: number; jevMs: number; actMs: number; settleMs: number;
      action?: string; actionP?: number;
      target1?: string; target1P?: number; target2?: string; target2P?: number;
      historyResult?: string;
      // Noul-question probabilities (tuning data, 2026-09-28): each present
      // only when that question was asked this round. step_done/ready/
      // right_page are chain-only (buildRoundRequest/buildGroupRequest gate
      // them on `chain`); `error` rides whenever round >= 2 in EVERY mode
      // (gated on round alone, not on `chain`) — so a multi-round wingman_do
      // or browse_step call gets errorP too, just never step_done/ready/
      // right_page. wingman_check is always exactly one round (round 1), so
      // none of the five ever appear there. Probabilities only, never the
      // underlying value.
      doneP?: number; stepDoneP?: number; readyP?: number; rightPageP?: number; errorP?: number;
      // WP-count: present only on the round where a deterministic
      // repeat-count advance/done fired, set to the count that was
      // satisfied (a number, never the step text or any page-derived label).
      countEvidence?: number;
      // WP-click: the redacted current step text (chain clause or legacy
      // step, capped to 300 chars), browse_step only; clickEvidence is set
      // only on the round where bare-click evidence fired.
      step_text?: string;
      clickEvidence?: true;
      // r13: set only on a stuck-recover round: the validated chosen id (back / open_<name>) or give-up.
      stuck?: string;
      // r14: set only on an advance that ONLY landed-navigation evidence allowed.
      navEvidence?: true;
      // r14: chain rounds whose last history entry has beforeUrl: did the page leave that document.
      leftPage?: boolean;
    }>;
  };
}
export interface WingmanPlugin {
  name: string;
  ask?: JevAsk;
  lockCheck?: () => Promise<LockCheckResult>;
  log?: (record: WingmanLogRecord) => void;
  sensitiveHosts?: Partial<Record<SensitiveHostCategory, string[]>>;
}

export interface Budgets {
  max_steps: number; max_ms: number; jev_timeout_ms: number;
  max_elements: number; max_text_chars: number; max_state_chars: number;
}
export type Mode = 'off' | 'shadow' | 'on';
export const WINDOW_MODES = ['offscreen', 'normal', 'minimized', 'headless'] as const;   // § 3.15
export type WindowMode = (typeof WINDOW_MODES)[number];
export interface WingmanConfig {
  mode: Mode;                       // file key absent → 'off'
  adapter: 'playwright' | 'cdp';
  window: WindowMode;               // file key absent → 'offscreen'
  profile_dir: string;              // expanded absolute path
  port: number;
  chrome_path: string | null;
  secrets_file: string | null;
  plugin: string | null;
  sensitive_hosts: Partial<Record<SensitiveHostCategory, string[]>>;
  budgets: Budgets;
}

export const DOCTOR_CHECK_IDS = [
  'key-present', 'config-loaded', 'registration-portable', 'policy-loaded', 'profile-safe',
  'adapter-attach', 'default-context', 'coexistence', 'handoff', 'jev-round',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
export interface DoctorCheck { id: DoctorCheckId; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }
export interface DoctorReport { verdict: 'PASS' | 'FAIL'; version: string; client: string; checks: DoctorCheck[] }
