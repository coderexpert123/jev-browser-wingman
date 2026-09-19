export const OPS = ['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scroll'] as const;
export type Op = (typeof OPS)[number];

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
    'state-too-large', 'unsupported-page',
    'sensitive-banking', 'sensitive-payments', 'sensitive-webmail', 'sensitive-identity', 'sensitive-auth-path',
    'sensitive-government', 'sensitive-tax', 'sensitive-health', 'sensitive-password', 'sensitive-otp',
    'sensitive-payment-field',
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
  ariaLabel: string;       // aria-label attribute, ≤80 chars, else ''
  autocomplete: string;    // autocomplete attribute lowercased, else ''
  state: { checked?: boolean; filled?: boolean; selected?: string; disabled: boolean; expanded?: boolean };
  editable: boolean;
  inViewport: boolean;
  rect: Rect;
  form: number;            // index into Observation.forms, or -1
  options?: Array<{ value: string; label: string }>;   // native <select> only; label ≤80, value ≤200
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
  attach(target: AttachTarget): Promise<void>;
  pages(): Promise<PageInfo[]>;                            // default-context page targets only
  observe(pageId: string): Promise<Observation>;
  act(pageId: string, elementId: string, op: Op, value?: string): Promise<void>;
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
  candidates?: Array<{ label: string }>;
  pending?: { verb: Op; label: string };
  confirm_token?: string;
  shadow?: true;
  answer?: number;                    // wingman_check only, 0..1 rounded to 2 decimals
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
  ts: string; tool: 'wingman_do' | 'wingman_check'; mode: 'off' | 'shadow' | 'on'; adapter: string;
  status: Status; reason: Reason; steps: number; host: string; gate_hits: number;
  jev_calls: number; input_tokens: number; output_tokens: number; ms: number;
  would?: { verb: Op; role: string };   // shadow mode only
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
  'adapter-attach', 'default-context', 'coexistence', 'jev-round',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
export interface DoctorCheck { id: DoctorCheckId; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }
export interface DoctorReport { verdict: 'PASS' | 'FAIL'; version: string; client: string; checks: DoctorCheck[] }
