export const PACKAGE_NAME = 'jev-browser-wingman';
export const PACKAGE_VERSION = '0.2.1';
export const ENV = {
  HOME: 'WINGMAN_HOME', CDP_ENDPOINT: 'WINGMAN_CDP_ENDPOINT', PLAYWRIGHT_CDP: 'PLAYWRIGHT_MCP_CDP_ENDPOINT',
  KEY: 'TYPESAFE_API_KEY', BASE_URL: 'TYPESAFE_BASE_URL',
} as const;
export const DEFAULT_PORT = 9222;
export const DEFAULT_PROFILE_DIR = '~/.jev-browser-wingman/profile';
export const LABEL_MAX = 80;
export const CRITERION_MAX = 120;
export const MAX_ENUMERATED = 1000;
export const TOKEN_TTL_MS = 600_000;
export const TOKEN_MAX_LIVE = 32;
export const REDACT_MIN_LEN = 4;
export const DEFAULT_BUDGETS = {
  max_steps: 24, max_ms: 45_000, jev_timeout_ms: 10_000, max_elements: 240, max_text_chars: 3_000, max_state_chars: 24_000,
} as const;
export const BUDGET_LIMITS = {
  max_steps: [1, 24], max_ms: [5_000, 50_000], jev_timeout_ms: [1_000, 10_000],
  max_elements: [20, 240], max_text_chars: [0, 3_000], max_state_chars: [2_000, 24_000],
} as const;
export const GATE_MODES = ['confirm', 'off'] as const;   // § 3.8 config key gate.mode; default 'confirm'
export type GateMode = (typeof GATE_MODES)[number];
export const DEFAULT_GATE = { mode: 'confirm' } as const;
export const POLICY_MODES = ['enforce', 'off'] as const; // § 3.8 config key policy.mode; default 'off' (amendment 2026-09-22, operator: opt-in)
export type PolicyMode = (typeof POLICY_MODES)[number];
export const DEFAULT_POLICY_MODE: PolicyMode = 'off';
export const DEFAULT_POLICY = { mode: DEFAULT_POLICY_MODE } as const;
export const TAKEOVER_MODES = ['auto', 'offer'] as const;   // § 3.20 config key takeover.mode; default 'auto'
export type TakeoverMode = (typeof TAKEOVER_MODES)[number];
export const DEFAULT_TAKEOVER = { threshold: 0.7, mode: 'auto', retry: true } as const;
export const TAKEOVER_THRESHOLD_RANGE = [0.5, 0.95] as const;
// § 3.19 top-candidate margin rule (amendment 2026-09-22): below the takeover
// threshold, a round commits to the highest-probability listed element when its
// probability reaches TAKEOVER_MARGIN_FLOOR and out-scores every other entry in
// the probability map — every other listed element AND every non-element answer
// (`none`, `ambiguous`) — by at least TAKEOVER_MARGIN_RATIO. Retires the
// TAKEOVER_SINGLE_FLOOR candidate-set rule.
export const TAKEOVER_MARGIN_FLOOR = 0.5 as const;
export const TAKEOVER_MARGIN_RATIO = 2 as const;
export const THRESHOLDS = {
  done: 0.85, doneNoAction: 0.5, login: 0.5, blocked: 0.5, error: 0.5, irreversible: 0.5, target: 0.5, value: 0.5,
} as const;
export const TWO_STAGE = { groupSize: 30, topGroups: 3 } as const;
export const SELECT_CHUNK = 250;
export const ACT_TIMEOUT_MS = 3_000;
export const EVAL_TIMEOUT_MS = 5_000;    // bound on every adapter Runtime.evaluate; a modal dialog blocks evaluation
export const SETTLE_MAX_MS = 3_000;
export const TIME_FLOOR_MS = 1_500;      // stop before any step when less than this remains
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_PATH = '/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';
export const POLICY_SELF_TEST_HOST = 'accounts.google.com';
