export const PACKAGE_NAME = 'jev-browser-wingman';
export const PACKAGE_VERSION = '0.3.0';
export const ENV = {
  HOME: 'WINGMAN_HOME', CDP_ENDPOINT: 'WINGMAN_CDP_ENDPOINT',
  PLAYWRIGHT_CDP: 'PLAYWRIGHT_MCP_CDP_ENDPOINT', // deleted by WP-R
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
  max_steps: 24, max_ms: 90_000, jev_timeout_ms: 10_000, max_elements: 240, max_text_chars: 3_000, max_state_chars: 24_000,
} as const;
export const BUDGET_LIMITS = {
  max_steps: [1, 24], max_ms: [5_000, 120_000], jev_timeout_ms: [1_000, 10_000],
  max_elements: [20, 240], max_text_chars: [0, 3_000], max_state_chars: [2_000, 24_000],
} as const;
export const GATE_MODES = ['confirm', 'off'] as const;   // § 3.8 config key gate.mode; default 'off' (0.3.0, Q6: confirm is opt-in)
export type GateMode = (typeof GATE_MODES)[number];
export const DEFAULT_GATE = { mode: 'off' } as const;
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
  stepDone: 0.85, stepDoneNoAction: 0.5, key: 0.5, url: 0.5, file: 0.5, toolClass: 0.8,
  // ready 0.5 -> 0.3 (2026-09-28, r10, from the r9 distribution): readyP
  // median was 0.50 over 163 rounds and all 17 not-ready bounces had readyP
  // 0.34-0.47 with errorP <= 0.18, so the 0.5 bar was uninformative. 0.3 lets
  // genuinely-ready rounds proceed while still bouncing truly-not-ready ones.
  rightPage: 0.5, ready: 0.3, recover: 0.6,
  // Evidence-backed step_done bar (operator-approved tuning, 2026-09-28,
  // cloud round 7: bench-results/2026-09-28-r7/results.md telemetry + Part 3).
  // stepDoneP undershoots THRESHOLDS.stepDone even after a verified outcome
  // (e.g. /inputs 'type 42' -> historyResult 'filled' at stepDoneP 0.83;
  // /dropdown 'Choose Option 2' -> 'selected: Option 2' at stepDoneP 0.52),
  // while rounds that did advance ran a median of 0.89. runChainEarly's rule 3
  // accepts this lower bar only when the last history entry is the current
  // step's own fill/select/check/uncheck AND its observed result confirms
  // that verb's end state — never for click-family or any other verb.
  // Verifier fix (2026-09-28): 'select' now also requires the confirmed
  // option to match the INTENDED one (not just any selection), 'fill'
  // requires the field to have been empty immediately before this act (not
  // just non-empty after — a pre-filled field proves nothing), and the whole
  // rule is gated off for a step whose text names more than one supplied
  // binding (a compound step must clear the ordinary 0.85 bar instead, so
  // completing only the first of several named fields can't advance it).
  // See hasStepEvidence and runChainEarly rule 3 in src/core/loop.ts.
  stepDoneWithEvidence: 0.5,
  // r14 landed-navigation evidence: a chain clause whose own click-family act
  // landed ('page changed' or 'element gone') and left the document it was
  // made on advances at this stepDone while the error Noul is below its
  // threshold (r13: landed own address-changing clicks read stepDoneP 0.30-0.82
  // on the next round; an open clause on any other page read <= 0.17; the one
  // wrong landing 0.14).
  stepDoneWithNavEvidence: 0.25,
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
// Forced handoff (spec 2026-09-26-wingman-forced-handoff § 5.3, § 5.8a, § 5.9). No browsing product is named here.
export const HANDOFF_MODES = ['optional', 'forced'] as const;
export type HandoffMode = (typeof HANDOFF_MODES)[number];
export const HANDOFF_TOOLS = ['all', 'browse-only'] as const;
export type HandoffTools = (typeof HANDOFF_TOOLS)[number];
export const HANDOFF_OPTIONAL = { mode: 'optional', tools: 'all', retain: [] } as const;
export const HANDOFF_FORCED = { mode: 'forced', tools: 'browse-only', retain: [] } as const;
// Capability classes of a caller's browsing-tool call (§ 5.8a).
// `script` moved here from RETAINED_CLASSES (operator directive 2026-09-28):
// a fresh-install round showed a calling agent bypassing forced handoff by
// running the caller's own script-class tools (e.g. an "evaluate" or
// "run code unsafe" call) to perform page actions directly. Withholding
// `script` has no op-based fallback (see CLASS_OPS below), so it is an
// explicit override of the § 10.4 dead-end rule, not an ops-derived class.
export const WITHHOLDABLE_CLASSES = [
  'element-act', 'type', 'select', 'key', 'hover', 'upload', 'navigate', 'back', 'scroll',
  'script',
] as const;
export const RETAINED_CLASSES = [
  'pointer-xy', 'drag', 'tabs', 'dialog', 'read', 'wait', 'session', 'unknown',
] as const;
export const CAPABILITY_CLASSES = [...WITHHOLDABLE_CLASSES, ...RETAINED_CLASSES] as const;
export type WithholdableClass = (typeof WITHHOLDABLE_CLASSES)[number];
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];
// A class is withheld only if the active adapter declares EVERY op listed for it (§ 10.4 dead-end rule).
// `script` has no listed ops: no adapter can execute arbitrary script on the
// caller's behalf, so the dead-end rule would otherwise always retain it.
// profiles.ts's withheldClasses() special-cases `script` to withhold it by
// default in forced mode anyway; opt back in per-config with `handoff.retain: ["script"]`.
export const CLASS_OPS: Record<WithholdableClass, readonly string[]> = {
  'element-act': ['click', 'dblclick', 'check', 'uncheck'],
  type: ['fill'], select: ['select'], key: ['press'], hover: ['hover'], upload: ['upload'],
  navigate: ['navigate'], back: ['back'], scroll: ['scroll', 'scroll_up', 'scroll_to'],
  script: [],
};
export const CLASS_CRITERIA: Record<CapabilityClass, string> = {
  'element-act': 'Clicks, double-clicks, checks or unchecks one page element chosen by reference or description',
  type: 'Types or fills text into one or more page fields',
  select: 'Chooses an option in a dropdown or select element',
  key: 'Presses a keyboard key or shortcut',
  hover: 'Moves the pointer over a page element',
  upload: 'Attaches or uploads files to a file input',
  navigate: 'Opens a web address in the current tab',
  back: 'Goes back to the previous page',
  scroll: 'Scrolls the page or an element',
  'pointer-xy': 'Clicks, moves or presses the mouse at screen or page coordinates rather than on an element',
  drag: 'Drags one element or data onto another, or drops files onto a page',
  tabs: 'Lists, opens, closes or switches browser tabs, windows or pages',
  dialog: 'Accepts or dismisses a JavaScript alert, confirm or prompt dialog',
  read: 'Reads the page: snapshots, screenshots, text search, console, network or performance data',
  wait: 'Waits for time to pass or for text or an element to appear or disappear',
  script: 'Runs arbitrary JavaScript or code in the page or browser',
  session: 'Manages the browser itself: reload the page, go forward in history, resize, close, install, emulate devices or network conditions',
  unknown: 'None of these describes the tool',
};
export const HANDOFF_REFUSAL_TEXT =
  'jev-browser-wingman forced handoff: this browser action is handled by the wingman. Call browse_step with your goal, the ordered remaining steps in steps, and every URL, file path and text in values; if it returns a step to you, call it again with pick naming the element by role and name.';
export const CHAIN_MAX_STEPS = 12;
export const CHAIN_MEMORY_MAX = 64;
export const WAIT_OP_MS = 1_000;
export const WAIT_MAX_PER_CALL = 5;
export const NAV_TIMEOUT_MS = 15_000;
export const PICK_NTH_MAX = 20;
export const PATH_VALUE_MAX = 1_000;
export const GOAL_MAX = 2_000;             // browse_step goal length (was 500)
export const CLASSIFY_MAX_TOOLS = 64;
export const CLASSIFY_TIMEOUT_MS = 10_000;
export const READY_MAX_WAITS = 2;          // consecutive not-ready rounds that wait; the next one bounces `not-ready`
export const WRONG_PAGE_MAX = 2;           // consecutive low `right_page` rounds on one clause → bounce `wrong-page`
export const RECOVER_MAX_PER_CLAUSE = 2;   // recover acts per clause; the next error ends `error/page-error`
// r13: a chain clause's `none` target probability at or above this, on a fresh clause whose decided action is click/navigate/back, triggers the stuck recover ask (from r12: hub-miss rounds answered none at 0.80-1.0)
export const STUCK_NONE_MIN = 0.8;
