// WP-H: the benchmark harness entry point.
//
//   node dist/bench/run.js --cap-usd <x> --phase-cap-usd <y>
//        [--tasks <id,...>] [--routes <csv>] [--secrets-file <path>]
//        [--purpose cap-proof|measure|experiment]
//        [--baseline <file> [--expect-diff <key,...>]] [--preflight-only]
//
// tasks.json entries x routes x repeats on one Chrome (port 9344, profile
// bench/.home/profile, window offscreen). Spend caps are enforced by
// bench/cap.ts; the USD ceilings live there and nowhere else.
//
// The gate/policy stance (WP-T3, r24b O6): the committed bench/config.json
// ships `gate_off: true` and `policy_off: true` (the off stance every publish
// run used); env BENCH_GATE_ON=1 / BENCH_POLICY_ON=1 (or true) opt in to
// confirm / enforce for that run. The old BENCH_GATE_OFF / BENCH_POLICY_OFF
// are accepted as no-ops (the default already is off).
//
// This module is NOT run by a builder: every live benchmark run is the
// operator-gated OG-6/OG-9 stage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkStart, priceRun, shouldAbort, type BenchPrices } from './cap.js';
import { claudeArgv, runClaude } from './claude-run.js';
import type { CallerLists } from './claude-run.js';
import { CONFIG_KEYS, LIST_OBSERVED_KEYS, POST_KEYS, RUN_CONFIG_VERSION, applyListHashes, callerListHashes, callerModelOf, compareObserved, compareToBaseline, emptyObserved, filesSha256, mergeListHashes, observedListsFileName, parseStanceEnv, readBaselineConfig, readCallerVersion, readGitInfo, sha256Hex, summarizeObservedLists, toolTextSha256, treeEntries, wingmanConfigSha256, type BenchRunConfig, type GitInfo, type ListSummaries, type ObservedEnv, type ObservedKey } from './run-config.js';
import { evaluateOracle, evaluateExpression } from './oracle.js';
import { ensureChrome, stopChrome } from '../src/browser/chrome.js';
import { expandHome } from '../src/contract/home.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { packageRoot } from '../src/package-root.js';
import { OPS } from '../src/contract/types.js';
import { loadProfiles, withheldClasses, type Profile } from '../src/core/profiles.js';
import type { WithholdableClass } from '../src/contract/constants.js';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';

export interface BenchTask {
  id: string;
  path: string;
  goal: string;
  values: Record<string, string>;
  oracle: string;
  // r17 D8: a verbatim page expression evaluated beside the oracle at run
  // end. Its value is recorded as evidence (end_state on the run record),
  // never compared to anything — it is not a second oracle.
  end_state?: string;
  resetStorage?: boolean;
  // r18 fixture tasks (t15-t17): the path is served by the local fixture
  // server (fixtures/pages/<name>.html), not the-internet.herokuapp.com. The
  // server is started once per invocation when any selected task is local.
  local?: boolean;
}

export type BenchRoute = 'playwright' | 'wingman' | 'browse' | 'forced';

const KNOWN_ROUTES: BenchRoute[] = ['playwright', 'wingman', 'browse', 'forced'];

export interface BenchAppConfig {
  cli: string;
  model: string;
  per_run_timeout_ms: number;
  max_turns: number;
  port: number;
  routes: BenchRoute[];
  repeats: number;
  // WP-T3 stance flags: the committed config.json ships both true (off, r24b O6);
  // the confirm / enforce stance is opted into per run through BENCH_GATE_ON / BENCH_POLICY_ON.
  gate_off?: boolean;
  policy_off?: boolean;
  // WP-F: per-route max-turns override (spec § 6 WP-F F2); falls back to
  // max_turns when the route is absent from the map.
  route_max_turns?: Partial<Record<BenchRoute, number>>;
}

export interface BenchRunRecord {
  task: string;
  route: BenchRoute;
  ok: boolean;
  wall_ms: number;
  browser_tool_calls: number;
  per_step_ms: number;
  llm: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    usd: number;
    cli_reported_usd: number | null;
  };
  typesafe: { calls: number; input_tokens: number; output_tokens: number; usd: number };
  wingman: { calls: number; fallback: number; needs_confirmation: number };
  // r24d: true when every wingman log record of this cell ended fallback/jev-error with zero Jev tokens (see jevDownCell).
  jev_down?: true;
  // Phase breakdown (ms) read from the run's log records. Present only when
  // at least one wingman record carried phases. Round-level values are
  // medians across all rounds of the run; attach_ms is the invocation sum,
  // first_observe_ms the max across invocations.
  wingman_phases?: {
    attach_ms: number;
    first_observe_ms: number;
    observe_ms: number;
    jev_ms: number;
    act_ms: number;
    settle_ms: number;
    rounds: number;
    // r18 D2: per-call cold/warm Jev split, per-phase sums over all rounds,
    // and the per-round outcome-class tally (kindless rounds bucket `other`).
    jev_first_ms: number;
    jev_rest_ms: number;
    observe_sum_ms: number;
    jev_sum_ms: number;
    act_sum_ms: number;
    settle_sum_ms: number;
    round_kinds: RoundKinds;
  } | null;
  usd: number;
  // WP-F (forced-handoff spec § 6 WP-F F3): per-run handoff/raw-act records.
  // Populated for every route; empty/zero on routes that never call
  // browse_step.
  handoff_records?: Array<Partial<HandoffRecord>>;
  handoffs?: number;
  picks?: number;
  wingman_acts?: number;
  nav_by_wingman?: number;
  raw_acts?: number;
  raw_script?: number;
  tool_use_counts?: Record<string, number>;
  first_call_invalid?: number;
  // r17 D8: verbatim string captured when the task defines end_state
  // (evidence beside the oracle verdict — no pass/fail attached to it).
  end_state?: string;
  caller?: { claude_code_version: string | null; model: string | null; lists_sha256?: Record<string, string>; lists?: CallerLists }; // r24b (O4, O7): the system/init event's version and model, and its list hashes (the names ride only each route's first cell, which runBench lifts into the local observed-lists file and strips)
}

/** One `browse_step` handoff, parsed from a run's fresh log lines (F3). */
export interface HandoffRecord {
  status: string;
  reason?: string;
  steps: number;
  rounds: number;
  pick?: true;
  progress?: { step_index: number; steps_done: number; steps_total: number };
  // WP-outcome-evidence WP-C: this handoff's step_review why (when it carried
  // one) and its candidate count — never the candidate labels.
  why?: string;
  candidates?: number;
}

export interface BenchResultsFile {
  date: string;
  purpose: 'cap-proof' | 'measure' | 'experiment';
  harness_version: number;
  model: string;
  cap_usd: number;
  phase_cap_usd: number;
  aborted: null | 'cap' | 'error' | 'jev-down';
  total_usd: number;
  config?: BenchRunConfig; // r24b: the effective run config (spec .build-r24b-spec.md section 3)
  baseline?: { file: string; expect_diff: string[] }; // r24b: the baseline this run was compared to (--baseline / --expect-diff)
  observed?: ObservedEnv; // r24b (O7): Node/Chrome versions and per-route caller-list hashes
  observed_lists?: Record<string, ListSummaries> | null; // r24b (O7, amendment 16): per route, per list: hash + count ONLY; the names go to the local <stamp>.observed-lists.json, never pushed
  runs: BenchRunRecord[];
  summary: Record<string, {
    success_rate: number;
    median_wall_ms: number;
    median_usd: number;
    fallback_rate: number;
    // r19 D9 (M-2): the wall spread over the route's cells, feeding the
    // publish table's wall spread column (n=2 medians are noisy; the spread
    // carries that honesty).
    wall_min_ms: number;
    wall_max_ms: number;
  }>;
  // r19 D9 (M-2): per task×route aggregates over repeats for the publish
  // table's pair lines. Absent on results files written before this field
  // existed (report.ts omits the block when it is missing).
  task_pairs?: Record<
    string,
    Record<string, { n: number; ok: number; wall_min_ms: number; wall_med_ms: number; wall_max_ms: number; median_usd: number }>
  >;
}

export interface BenchDeps {
  runOne(task: BenchTask, route: BenchRoute): Promise<{ record: BenchRunRecord; usd: number }>;
  prepareBrowser(): Promise<void>;
  stopBrowser(): Promise<void>;
  resultsDir: string;
  pricesPath: string;
  env: NodeJS.ProcessEnv;
  // Test seam: the known-bad proof stubs this to false to show the loop
  // would run all 16 runs without the abort check.
  shouldAbort?: typeof shouldAbort;
  // Test seam: a fixed clock makes the same-second collision test deterministic.
  now?: () => Date;
  // r24b test seam: HEAD + tracked-dirty for the recorded config (default: git in the package root).
  gitInfo?: () => GitInfo;
  // r24b test seam: the caller CLI version (default: readCallerVersion(), which spawns claude --version).
  callerVersion?: () => string | null;
  // r24b (O7) test seam: the Node version (default: process.version).
  nodeVersion?: () => string;
  // r24b (O7) test seam: the Chrome version (default: Browser.getVersion over the bench observer, null without one).
  chromeVersion?: () => Promise<string | null>;
}

const PKG_ROOT = packageRoot();
const BENCH_HOME = path.join(PKG_ROOT, 'bench', '.home');
// r18 D2: 3 adds the per-call cold/warm Jev split, the per-phase sums and the
// round_kinds tally to wingman_phases (aggregatePhases). The bench-browse pin
// was missed once at spec time — grep tests/ for harness_version on every bump.
const HARNESS_VERSION = 3;

function readTasks(): BenchTask[] {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bench', 'tasks.json'), 'utf8')) as BenchTask[];
}

// r18 D8: expand a leading `@REPO@` in every task value into the repo root,
// with the root's backslashes folded to forward slashes (the win32 cmd spawn
// mangles backslash-before-quote in the prompt; forward slashes also satisfy
// isPathLike's `^[A-Za-z]:[\\/]`). Everything else passes through untouched.
// Pure: values objects are never mutated in place.
export function expandTaskValuePlaceholders(tasks: BenchTask[], repoRoot: string): BenchTask[] {
  const root = repoRoot.replace(/\\/g, '/');
  return tasks.map((task) => {
    const entries = Object.entries(task.values ?? {});
    if (entries.length === 0) return task;
    let changed = false;
    const values: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (typeof value === 'string' && value.startsWith('@REPO@')) {
        values[name] = root + value.slice('@REPO@'.length);
        changed = true;
      } else {
        values[name] = value;
      }
    }
    return changed ? { ...task, values } : task;
  });
}

function readAppConfig(): BenchAppConfig {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bench', 'config.json'), 'utf8')) as BenchAppConfig;
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

// Second-stamped name; a taken name gets `_2`..`_99`. `_` (0x5F) sorts after
// `.` (0x2E), so the newest-file sort used by readme-bench still holds.
export function resultsFileName(now: Date, taken: (name: string) => boolean = () => false): string {
  const base = `${now.getFullYear()}-${twoDigit(now.getMonth() + 1)}-${twoDigit(now.getDate())}-${twoDigit(now.getHours())}${twoDigit(now.getMinutes())}${twoDigit(now.getSeconds())}`;
  const first = `${base}.json`;
  if (!taken(first)) return first;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}_${n}.json`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('results file name exhausted');
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function phaseSpentFrom(resultsDir: string): number {
  let total = 0;
  if (!fs.existsSync(resultsDir)) return 0;
  for (const name of fs.readdirSync(resultsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')) as { total_usd?: unknown };
      if (typeof parsed.total_usd === 'number' && Number.isFinite(parsed.total_usd)) total += parsed.total_usd;
    } catch {
      // unreadable results file contributes nothing
    }
  }
  return total;
}

function readSecretsKey(secretsFile: string | null): string | null {
  if (!secretsFile) return null;
  try {
    const text = fs.readFileSync(expandHome(secretsFile), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*TYPESAFE_API_KEY\s*=\s*(\S+)\s*$/);
      if (m) return m[1];
    }
  } catch {
    // unreadable secrets file: no key found there
  }
  return null;
}

// The browse route's single engagement line (2026-09-21, operator; full
// outcome-phrasing and recovery guidance 2026-09-22, operator): it sits
// BEFORE the goal in the prompt and is its only route-specific steering —
// no routing rules. Kept ASCII and on the prompt's single line because the
// win32 cmd spawn requires it (the 2026-09-22 text's em-dash is folded to a
// hyphen for exactly that reason).
export const BROWSE_ENGAGEMENT_LINE =
  "For this browsing task, use the wingman browse_step tool: propose the WHOLE remaining outcome as the goal (e.g. 'complete the form and submit'), not single actions - it continues autonomously across pages. If it bounces a step, perform that step yourself with your raw browser tools and continue.";

// WP-F (forced-handoff spec § 6 WP-F F2): the forced route's engagement line.
// Literal, ASCII, one line (same win32 cmd-spawn constraint as the browse line).
// r22 F-3: the line carries the post-action exception so its "call it again
// with the same arguments" recovery never contradicts FORCED_POST_ACTION_LINE's
// "only the steps after this one" recovery (the r22 diagnosis: a caller that
// re-sent the whole chain against a post-action cursor burned two calls).
export const FORCED_ENGAGEMENT_LINE =
  'For this browsing task, hand the page work to the wingman browse_step tool: pass the goal, the ordered list of remaining steps in steps, and every URL and text it needs in values; if it returns a step to you, call it again with pick naming the element by role and name, and when a call ends unfinished, call it again with the same arguments. If a result\'s note says the step\'s action already ran, send only the steps after that one instead.';

export function buildPrompt(task: BenchTask, route: BenchRoute): string {
  // Route-neutral for 'playwright' (WP-T3): base + goal + values + DONE, no
  // routing rules, no wingman mention. The 'wingman' route carries the
  // steering clauses; the 'browse' route carries exactly one engagement line
  // before the goal (2026-09-21, operator: browse measured 0/3 browse_step
  // engagement with the tool merely registered, so the route now tests
  // usage-when-engaged). The task goal travels in EVERY prompt (2026-09-21
  // defect fix): without it the oracle endpoint is unreachable by
  // instruction and every "oracle false" partly measures wandering. Goals in
  // tasks.json are single-line ASCII, so the wingman cmd-spawn constraint
  // (one line, ASCII) still holds.
  let prompt = 'Use the browser tools on the page that is already open. Stay on this site.';
  if (route === 'browse') {
    prompt += ` ${BROWSE_ENGAGEMENT_LINE}`;
  } else if (route === 'forced') {
    prompt += ` ${FORCED_ENGAGEMENT_LINE}`;
  }
  prompt += ` Your goal: ${task.goal}`;
  if (route === 'wingman') {
    // The win32 spawn goes through `cmd /c` with verbatim arguments, so the
    // prompt MUST stay a single ASCII line: newlines split the command line
    // and non-ASCII characters depend on the console codepage (observed
    // 2026-09-21: multi-line prompt ran as garbage commands, 0 usage).
    prompt +=
      ' ROUTING RULES, follow these exactly: Use the wingman MCP tool (wingman_do) for ALL browser work on this task; it runs the entire observe-decide-act loop internally at ~1 s per step and returns one compact result. Call it ONCE with the full goal. PREFER wingman_do for navigation, clicking, filling fields with known values, selecting options, and scrolling. DEPRIORITIZE the raw Playwright browser tools for all of the above; do not use them for navigation, clicks, typing, selects, or scrolls. Reserve raw browser tools ONLY for what wingman_do\'s do-not-use list covers (sensitive hosts, credentials, sign-in or payment pages) or when wingman_do returns blocked, needs_confirmation, or fallback. Do not interleave raw browser calls between wingman_do calls.';
  }
  const entries = Object.entries(task.values ?? {});
  if (entries.length > 0) {
    prompt += ` Use these values: ${entries.map(([name, value]) => `${name} = "${value}"`).join('; ')}.`;
  }
  prompt += ' Reply DONE when finished.';
  return prompt;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// r18 D2/D3: one round's phase timings as collected from a log record's
// phases.rounds. `isFirst` is true for round index 0 WITHIN its own call's
// rounds array (the per-call cold round). `kind` is the WP-2a outcome class
// when the loop side has landed; kindless rounds (or an unknown string) are
// bucketed `other` — that is the shape until WP-2a ships.
export interface AggregateRound {
  observeMs: number;
  jevMs: number;
  actMs: number;
  settleMs: number;
  kind?: string;
  isFirst?: boolean;
}

export interface RoundKinds {
  act: number;
  advance: number;
  wait: number;
  bounce: number;
  done: number;
  error: number;
  other: number;
}

export interface PhasesAggregate {
  observe_ms: number;
  jev_ms: number;
  act_ms: number;
  settle_ms: number;
  rounds: number;
  jev_first_ms: number;
  jev_rest_ms: number;
  observe_sum_ms: number;
  jev_sum_ms: number;
  act_sum_ms: number;
  settle_sum_ms: number;
  round_kinds: RoundKinds;
}

const ROUND_KINDS: ReadonlyArray<Exclude<keyof Omit<RoundKinds, 'other'>, never>> = [
  'act',
  'advance',
  'wait',
  'bounce',
  'done',
  'error',
];

// r18 D2: the pure phases aggregation that replaces the inline medians in
// defaultRunOne. The five existing median/count fields keep their semantics;
// jev_first_ms / jev_rest_ms are medians over the per-call cold rounds and
// the rest; the *_sum_ms fields are plain sums over all rounds; round_kinds
// tallies the rounds' outcome class with `other` absorbing kindless rounds.
// median() of an empty set stays 0, so an empty first/rest bucket reads 0.
export function aggregatePhases(rounds: AggregateRound[]): PhasesAggregate {
  const first = rounds.filter((r) => r.isFirst === true).map((r) => r.jevMs);
  const rest = rounds.filter((r) => r.isFirst !== true).map((r) => r.jevMs);
  const round_kinds: RoundKinds = { act: 0, advance: 0, wait: 0, bounce: 0, done: 0, error: 0, other: 0 };
  for (const round of rounds) {
    const kind = round.kind as unknown;
    if (typeof kind === 'string' && (ROUND_KINDS as readonly string[]).includes(kind)) {
      round_kinds[kind as keyof Omit<RoundKinds, 'other'>] += 1;
    } else {
      round_kinds.other += 1;
    }
  }
  return {
    observe_ms: Math.round(median(rounds.map((r) => r.observeMs))),
    jev_ms: Math.round(median(rounds.map((r) => r.jevMs))),
    act_ms: Math.round(median(rounds.map((r) => r.actMs))),
    settle_ms: Math.round(median(rounds.map((r) => r.settleMs))),
    rounds: rounds.length,
    jev_first_ms: Math.round(median(first)),
    jev_rest_ms: Math.round(median(rest)),
    observe_sum_ms: Math.round(rounds.reduce((s, r) => s + r.observeMs, 0)),
    jev_sum_ms: Math.round(rounds.reduce((s, r) => s + r.jevMs, 0)),
    act_sum_ms: Math.round(rounds.reduce((s, r) => s + r.actMs, 0)),
    settle_sum_ms: Math.round(rounds.reduce((s, r) => s + r.settleMs, 0)),
    round_kinds,
  };
}

function summarize(runs: BenchRunRecord[]): BenchResultsFile['summary'] {
  const summary: BenchResultsFile['summary'] = {};
  for (const route of KNOWN_ROUTES) {
    const rows = runs.filter((r) => r.route === route);
    if (rows.length === 0) continue;
    const oks = rows.filter((r) => r.ok === true).length;
    const fallbacks = rows.filter((r) => (r.wingman?.fallback ?? 0) > 0).length;
    summary[route] = {
      success_rate: round6(oks / rows.length),
      median_wall_ms: round6(median(rows.map((r) => r.wall_ms))),
      median_usd: round6(median(rows.map((r) => r.usd))),
      fallback_rate: round6(fallbacks / rows.length),
      wall_min_ms: round6(Math.min(...rows.map((r) => r.wall_ms))),
      wall_max_ms: round6(Math.max(...rows.map((r) => r.wall_ms))),
    };
  }
  return summary;
}

// r19 D9 (M-2): per task×route aggregates over repeats. Pure; `ok` counts
// records with ok === true; min/med/max and median_usd follow the same
// median()/round6 semantics as summarize. Exported for the bench-browse pin.
export function summarizePairs(runs: BenchRunRecord[]): NonNullable<BenchResultsFile['task_pairs']> {
  const groups = new Map<string, Map<string, BenchRunRecord[]>>();
  for (const run of runs) {
    let byRoute = groups.get(run.task);
    if (!byRoute) {
      byRoute = new Map();
      groups.set(run.task, byRoute);
    }
    const rows = byRoute.get(run.route);
    if (rows) rows.push(run);
    else byRoute.set(run.route, [run]);
  }
  const pairs: NonNullable<BenchResultsFile['task_pairs']> = {};
  for (const [task, byRoute] of groups) {
    pairs[task] = {};
    for (const [route, rows] of byRoute) {
      const walls = rows.map((r) => r.wall_ms);
      pairs[task][route] = {
        n: rows.length,
        ok: rows.filter((r) => r.ok === true).length,
        wall_min_ms: round6(Math.min(...walls)),
        wall_med_ms: round6(median(walls)),
        wall_max_ms: round6(Math.max(...walls)),
        median_usd: round6(median(rows.map((r) => r.usd))),
      };
    }
  }
  return pairs;
}

export interface RunContext {
  app: BenchAppConfig;
  prices: BenchPrices;
  home: string;
  endpoint: string;
  observer: CdpConnection;
  keptTargetId: string;
  mainJsPath: string;
  // r18: the invocation's fixture-server url when any selected task is local
  // (set by runBench after prepareBrowser, the same way ctx.prices is).
  fixtureUrl?: string;
}

// r20 (H-1): retry the reset navigation ONLY on the CDP command timeout —
// `cdp timeout: Page.navigate` is the exact rejection CdpConnection's
// per-command timer produces. Any other rejection (a JSON-RPC error response
// from a failed navigation, a closed socket) is deterministic or fatal and
// rethrows immediately: a retry must not turn a real failure into three slow
// attempts. A timed-out navigate may still have completed; re-navigating the
// SAME startUrl is idempotent, which is why no other reset step re-runs.
export const RESET_NAV_RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000];
export async function navigateResetWithRetry(
  conn: Pick<CdpConnection, 'send'>,
  sessionId: string,
  url: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await conn.send('Page.navigate', { url }, sessionId);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= RESET_NAV_RETRY_BACKOFF_MS.length || msg !== 'cdp timeout: Page.navigate') throw e;
      await sleep(RESET_NAV_RETRY_BACKOFF_MS[attempt]);
    }
  }
}

// The harness may navigate the shared page and clear its origin's storage before a run; the tools may not.
// r20 (H-1): takes the observer and kept target id directly (not the whole
// RunContext) so a scripted `{ send }` fake can drive it in tests.
export async function resetPages(
  observer: Pick<CdpConnection, 'send'>,
  keptTargetId: string,
  startUrl: string,
  clearOrigin?: string,
): Promise<void> {
  const { targetInfos } = await observer.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
    'Target.getTargets',
  );
  for (const t of targetInfos) {
    if (t.type === 'page' && t.targetId !== keptTargetId) {
      await observer.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
  }
  const { sessionId } = await observer.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId: keptTargetId,
    flatten: true,
  });
  if (clearOrigin) {
    await observer.send('Storage.clearDataForOrigin', {
      origin: clearOrigin,
      storageTypes: 'all',
    }, sessionId);
  }
  await navigateResetWithRetry(observer, sessionId, startUrl);
}

export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.80';

export function mcpConfigFor(ctx: RunContext, route: BenchRoute): object {
  const servers: Record<string, unknown> = {
    // WP-F: the forced route wraps the caller's own playwright registration
    // through `with-browser` (spec § 6 WP-F F2) so its withholdable-class
    // tools are proxied away; every other route registers it plain. The
    // bench names the product in its own config; it is a measurement
    // harness, not product code.
    playwright:
      route === 'forced'
        ? {
            command: 'node',
            args: [ctx.mainJsPath, 'with-browser', '--', 'npx', '-y', PLAYWRIGHT_MCP_PACKAGE, '--browser', 'chrome'],
            env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ctx.endpoint, WINGMAN_HOME: ctx.home },
          }
        : {
            command: 'npx',
            args: ['-y', PLAYWRIGHT_MCP_PACKAGE, '--browser', 'chrome'],
            env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ctx.endpoint },
          },
  };
  // 'wingman', 'browse' and 'forced' all register the wingman server
  // alongside Playwright MCP, in its plain (un-wrapped) shape.
  if (route !== 'playwright') {
    servers['jev-browser-wingman'] = {
      command: 'node',
      args: [ctx.mainJsPath, 'mcp'],
      // r24b (O1 b): the only place the label/title log switch is set; src/lib.ts reads it (WP-T2). Inert until WP-T2 lands.
      env: { WINGMAN_HOME: ctx.home, WINGMAN_CDP_ENDPOINT: ctx.endpoint, WINGMAN_LOG_LABELS: '1' },
    };
  }
  return { mcpServers: servers };
}

export function allowedToolsFor(route: BenchRoute): string[] {
  return route === 'playwright' ? ['mcp__playwright'] : ['mcp__playwright', 'mcp__jev-browser-wingman'];
}

// WP-F F1: transcript capture path, one per wingman-touching run; `playwright`
// never records one (it never calls a wingman tool). `<home>/transcript-<task>-<route>-<ts>.ndjson`.
export function transcriptPathFor(home: string, taskId: string, route: BenchRoute): string | null {
  if (route === 'playwright') return null;
  return path.join(home, `transcript-${taskId}-${route}-${Date.now()}.ndjson`);
}

// WP-F F2: the per-route max-turns override, else the configured default.
export function maxTurnsFor(app: BenchAppConfig, route: BenchRoute): number {
  return app.route_max_turns?.[route] ?? app.max_turns;
}

interface LoggedRecord {
  tool?: unknown;
  status?: unknown;
  reason?: unknown;
  steps?: unknown;
  pick?: unknown;
  progress?: unknown;
  // r18: rounds carry the loop's per-round `kind` outcome class when WP-2a's
  // telemetry has landed on the log side; kindless logs aggregate as `other`.
  phases?: { rounds?: Array<{ kind?: unknown }> };
  acts_by_op?: Record<string, unknown>;
  // WP-outcome-evidence WP-C: written by loop.ts's buildLogRecord from the
  // call's final step_review, why + a candidate COUNT only (never labels).
  step_review?: { why?: unknown; candidates?: unknown };
}

// r19 D-5 (spec C2): slice the fresh tail of the log by BYTE offset. `before`
// comes from fs.statSync().size — a byte count — but slicing the DECODED
// string by it cuts N UTF-16 code units into the fresh region whenever the
// prefix holds any multi-byte UTF-8 character (a U+2026 in a t9 goal clause
// is enough). The first fresh line then loses its head, JSON.parse fails, and
// both parsers skip it silently, so single-call cells under-count handoffs
// and wingman.calls. Buffers slice in bytes, so the two sides agree.
export function freshLogSlice(buf: Buffer, before: number): string {
  return buf.subarray(before).toString('utf8');
}

// WP-F F3: parse a run's fresh log lines into `browse_step` handoff records
// only (`wingman_do`/`wingman_check` lines and unparsable lines are skipped).
export function handoffRecordsFromLog(lines: string[]): HandoffRecord[] {
  const records: HandoffRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: LoggedRecord;
    try {
      rec = JSON.parse(line) as LoggedRecord;
    } catch {
      continue;
    }
    if (rec.tool !== 'browse_step') continue;
    const record: HandoffRecord = {
      status: typeof rec.status === 'string' ? rec.status : 'unknown',
      reason: typeof rec.reason === 'string' ? rec.reason : undefined,
      steps: typeof rec.steps === 'number' ? rec.steps : 0,
      rounds: Array.isArray(rec.phases?.rounds) ? rec.phases!.rounds!.length : 0,
    };
    if (rec.pick === true) record.pick = true;
    if (rec.progress && typeof rec.progress === 'object') {
      record.progress = rec.progress as HandoffRecord['progress'];
    }
    if (typeof rec.step_review?.why === 'string') record.why = rec.step_review.why;
    if (typeof rec.step_review?.candidates === 'number') record.candidates = rec.step_review.candidates;
    records.push(record);
  }
  return records;
}

// WP-F F3: the LEADING run of `invalid-input` records only (a later one, once
// a real handoff has already succeeded, does not count).
export function firstInvalidRun(records: HandoffRecord[]): number {
  let n = 0;
  for (const r of records) {
    if (r.reason === 'invalid-input') n += 1;
    else break;
  }
  return n;
}

function bareToolName(name: string): string {
  const idx = name.lastIndexOf('__');
  return idx === -1 ? name : name.slice(idx + 2);
}

// WP-F F3: derive raw_acts/raw_script from a run's tool_use tally, via the
// playwright profile's tool→class map and the derived withheld set
// `withheldClasses(OPS, [])` (§ 10.4: every withholdable class the wingman
// contract can in principle do, i.e. every class whose ops are a subset of
// the full OPS enumeration). `script` is checked ahead of the withheld set
// (operator directive 2026-09-28 moved `script` into WITHHOLDABLE_CLASSES so
// forced mode withholds it by default; it stays its own raw_script bucket
// here rather than folding into raw_acts).
export function deriveRawCounts(counts: Record<string, number>, profile: Profile | null): { raw_acts: number; raw_script: number } {
  if (!profile) return { raw_acts: 0, raw_script: 0 };
  const withheld = new Set<WithholdableClass>(withheldClasses(OPS, []));
  let raw_acts = 0;
  let raw_script = 0;
  for (const [rawName, n] of Object.entries(counts)) {
    const cls = profile.tools[bareToolName(rawName)];
    if (cls === undefined) continue;
    if (cls === 'script') raw_script += n;
    else if (withheld.has(cls as WithholdableClass)) raw_acts += n;
  }
  return { raw_acts, raw_script };
}

/** r24d: consecutive wingman-route cells that must read `jev_down` before the run stops. */
export const JEV_DOWN_STREAK = 3;

/**
 * r24d detection rule (the smallest the run records can see): a cell is "decision service down" when its fresh log slice has
 * at least one wingman record, EVERY record ended status `fallback` with reason `jev-error` (or `breaker-open`, the loop's
 * name for repeated jev failures), and the records carry zero Jev tokens in total. A 402/401 reaches the log only as
 * `jev-error` plus 0 tokens (the HTTP status is never logged), so that pair is the whole signal. One transient jev-error
 * cannot trip it: a healthy call in the same cell carries tokens or a non-fallback end, and `runBench` stops only after
 * JEV_DOWN_STREAK consecutive wingman-route cells (playwright cells neither count nor reset) read down.
 */
export function jevDownCell(freshLines: string[]): boolean {
  let records = 0;
  let tokens = 0;
  for (const line of freshLines) {
    if (!line.trim()) continue;
    let rec: { status?: unknown; reason?: unknown; input_tokens?: unknown; output_tokens?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.status !== 'string') continue;
    records += 1;
    if (rec.status !== 'fallback' || (rec.reason !== 'jev-error' && rec.reason !== 'breaker-open')) return false;
    tokens += (typeof rec.input_tokens === 'number' ? rec.input_tokens : 0) + (typeof rec.output_tokens === 'number' ? rec.output_tokens : 0);
  }
  return records > 0 && tokens === 0;
}

const START_BASE = 'https://the-internet.herokuapp.com';

// r18: the start URL for a task. Three branches, in order: a local task with a
// fixture-server url resolves against the server (which serves
// fixtures/pages/<name>.html at /<name>.html); a non-local task with an
// absolute http(s) path uses it verbatim (the r16 rule); everything else —
// including a local task whose invocation somehow has no fixture server —
// resolves against START_BASE. Pure: no I/O, no global state.
export function resolveStartUrl(task: Pick<BenchTask, 'path' | 'local'>, fixtureUrl: string | undefined): string {
  if (task.local === true && fixtureUrl !== undefined) return fixtureUrl + task.path;
  if (task.local !== true && /^https?:\/\//.test(task.path)) return task.path;
  return START_BASE + task.path;
}

function defaultRunOne(ctx: RunContext, secretsFile: string | null): BenchDeps['runOne'] {
  // WP-F: the playwright profile is loaded once; it drives the raw_acts/
  // raw_script derivation for every run (§ 6 WP-F F3, § 5.8a).
  const playwrightProfile: Profile | null = loadProfiles(ctx.home).find((p) => p.id === 'playwright-mcp') ?? null;

  return async (task, route) => {
    const logPath = path.join(ctx.home, 'log.jsonl');
    const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    // WP-F: config.json is rewritten per run, because `handoff` differs by
    // route (forced/browse-only for `forced`, else optional/all).
    fs.writeFileSync(path.join(ctx.home, 'config.json'), benchConfigText(ctx.app, secretsFile, route));

    const mcpConfigPath = path.join(ctx.home, `mcp-${route}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigFor(ctx, route), null, 2));

    const startUrl = resolveStartUrl(task, ctx.fixtureUrl);
    await resetPages(
      ctx.observer,
      ctx.keptTargetId,
      startUrl,
      task.resetStorage ? new URL(startUrl).origin : undefined,
    );

    const transcriptPath = transcriptPathFor(ctx.home, task.id, route);
    const res = await runClaude({
      prompt: buildPrompt(task, route),
      mcpConfigPath,
      allowedTools: allowedToolsFor(route),
      model: ctx.app.model,
      maxTurns: maxTurnsFor(ctx.app, route),
      timeoutMs: ctx.app.per_run_timeout_ms,
      cwd: path.join(PKG_ROOT, 'bench', '.home'),
      ...(transcriptPath ? { transcriptPath } : {}),
    });

    const ok = await evaluateOracle(ctx.observer, ctx.keptTargetId, task.oracle);

    // TypeSafe usage: only the log lines the run appended.
    let tsCalls = 0;
    let tsInput = 0;
    let tsOutput = 0;
    let fallbackCount = 0;
    let confirmCount = 0;
    let attachSum = 0;
    let firstObserveMax = 0;
    let wingmanActs = 0;
    let navByWingman = 0;
    // r18 D2: rounds carry `isFirst` (index 0 within their own call's rounds
    // array — the per-call cold round) and `kind` when the log side wrote one.
    const roundPhases: AggregateRound[] = [];
    const freshLines: string[] = [];
    if (fs.existsSync(logPath)) {
      const fresh = freshLogSlice(fs.readFileSync(logPath), before);
      for (const line of fresh.split('\n')) {
        if (!line.trim()) continue;
        freshLines.push(line);
        let rec: {
          jev_calls?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
          status?: unknown;
          phases?: { attachMs?: unknown; firstObserveMs?: unknown; rounds?: Array<Record<string, unknown>> };
          acts_by_op?: Record<string, unknown>;
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        tsCalls += 1;
        tsInput += typeof rec.input_tokens === 'number' ? rec.input_tokens : 0;
        tsOutput += typeof rec.output_tokens === 'number' ? rec.output_tokens : 0;
        if (rec.status === 'fallback') fallbackCount += 1;
        if (rec.status === 'needs_confirmation') confirmCount += 1;
        const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
        if (rec.acts_by_op && typeof rec.acts_by_op === 'object') {
          for (const [op, n] of Object.entries(rec.acts_by_op)) {
            if (typeof n !== 'number') continue;
            wingmanActs += n;
            if (op === 'navigate') navByWingman += n;
          }
        }
        if (rec.phases) {
          if (num(rec.phases.attachMs)) attachSum += rec.phases.attachMs;
          if (num(rec.phases.firstObserveMs)) firstObserveMax = Math.max(firstObserveMax, rec.phases.firstObserveMs);
          const rounds = rec.phases.rounds ?? [];
          for (let ri = 0; ri < rounds.length; ri++) {
            const round = rounds[ri];
            roundPhases.push({
              observeMs: num(round.observeMs) ? round.observeMs : 0,
              jevMs: num(round.jevMs) ? round.jevMs : 0,
              actMs: num(round.actMs) ? round.actMs : 0,
              settleMs: num(round.settleMs) ? round.settleMs : 0,
              ...(typeof round.kind === 'string' ? { kind: round.kind } : {}),
              isFirst: ri === 0,
            });
          }
        }
      }
    }
    const wingmanPhases: BenchRunRecord['wingman_phases'] =
      route !== 'playwright' && roundPhases.length > 0
        ? {
            attach_ms: Math.round(attachSum),
            first_observe_ms: Math.round(firstObserveMax),
            ...aggregatePhases(roundPhases),
          }
        : null;

    // WP-F F3: handoff records and the raw-act/script derivation.
    const handoffRecords = handoffRecordsFromLog(freshLines);
    const toolUseCounts = res.toolUseCounts ?? {};
    const { raw_acts, raw_script } = deriveRawCounts(toolUseCounts, playwrightProfile);

    const usage = res.usage;
    const llmUsage = {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
    };
    const tsUsage = { input_tokens: tsInput, output_tokens: tsOutput };
    const llmUsd = priceRun({ llm: llmUsage, typesafe: { input_tokens: 0, output_tokens: 0 } }, ctx.prices, ctx.app.model);
    const tsUsd = priceRun({ llm: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, typesafe: tsUsage }, ctx.prices, ctx.app.model);
    const killedCharge = res.killed ? ctx.prices.killed_run_charge_usd : 0;
    const usd = round6(llmUsd + tsUsd + killedCharge);

    const record: BenchRunRecord = {
      task: task.id,
      route,
      ok,
      wall_ms: res.wallMs,
      browser_tool_calls: res.browserToolCalls,
      per_step_ms: Math.round(res.wallMs / Math.max(1, res.browserToolCalls)),
      llm: {
        input_tokens: llmUsage.input_tokens,
        output_tokens: llmUsage.output_tokens,
        cache_read_tokens: llmUsage.cache_read_tokens,
        cache_write_tokens: llmUsage.cache_write_tokens,
        usd: round6(llmUsd),
        cli_reported_usd: res.cliReportedUsd,
      },
      typesafe: { calls: tsCalls, input_tokens: tsInput, output_tokens: tsOutput, usd: round6(tsUsd) },
      wingman:
        route !== 'playwright'
          ? { calls: tsCalls, fallback: fallbackCount, needs_confirmation: confirmCount }
          : { calls: 0, fallback: 0, needs_confirmation: 0 },
      ...(route !== 'playwright' ? { wingman_phases: wingmanPhases } : {}),
      usd,
      ...(route !== 'playwright' && jevDownCell(freshLines) ? { jev_down: true as const } : {}),
      handoff_records: handoffRecords,
      handoffs: handoffRecords.length,
      picks: handoffRecords.filter((r) => r.pick === true).length,
      wingman_acts: wingmanActs,
      nav_by_wingman: navByWingman,
      raw_acts,
      raw_script,
      tool_use_counts: toolUseCounts,
      first_call_invalid: firstInvalidRun(handoffRecords),
      ...(res.init ? { caller: { ...res.init, ...(res.lists ? { lists_sha256: callerListHashes(res.lists), lists: res.lists } : {}) } } : {}),
    };
    if (task.end_state !== undefined) {
      record.end_state = String(
        (await evaluateExpression(ctx.observer, ctx.keptTargetId, task.end_state)) ?? '',
      );
    }
    return { record, usd };
  };
}

// WP-T3/WP-F: the pure renderer for the bench home's config.json. Q6
// (operator, 2026-09-26): the gate default is now 'off', so `gate` and
// `policy` are ALWAYS written explicitly (never left absent) — `confirm`/
// `enforce` unless the run's off-stance flags are set. `handoff` is written
// forced/browse-only for the `forced` route, else optional/all (§ 6 WP-F F2).
// `defaultRunOne` calls this per run, so config.json is rewritten per route.
export function benchConfigText(app: BenchAppConfig, secretsFile: string | null, route?: BenchRoute): string {
  const config: Record<string, unknown> = {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    port: app.port,
    profile_dir: path.join(BENCH_HOME, 'profile'),
    secrets_file: secretsFile ? path.resolve(expandHome(secretsFile)) : null,
    gate: app.gate_off === true ? { mode: 'off' } : { mode: 'confirm' },
    policy: app.policy_off === true ? { mode: 'off' } : { mode: 'enforce' },
    handoff:
      route === 'forced'
        ? { mode: 'forced', tools: 'browse-only', retain: [] }
        : { mode: 'optional', tools: 'all', retain: [] },
  };
  return JSON.stringify(config, null, 2);
}

// r24b: the effective, machine-independent run config (spec .build-r24b-spec.md
// section 3). `selected` is the run's task list; `rawTasks` is the whole
// tasks.json as read (values unexpanded). Stance, adapter and the per-route
// config hashes derive from benchConfigText, the one renderer of the bench home;
// the per-route MCP hashes derive from mcpConfigFor with placeholder paths; the
// per-route caller argv hashes derive from claudeArgv (every fixed flag, the model,
// the turn cap and the allowed tools; the prompt and the config path are placeholders).
// caller_model is learned after the first cell, so it starts null.
export function computeRunConfig(
  app: BenchAppConfig,
  selected: BenchTask[],
  rawTasks: BenchTask[],
  git: GitInfo,
  callerVersion: string | null,
  home: string = BENCH_HOME,
): BenchRunConfig {
  const forcedCfg = JSON.parse(benchConfigText(app, null, 'forced')) as {
    adapter: string;
    gate: { mode: 'off' | 'confirm' };
    policy: { mode: 'off' | 'enforce' };
  };
  const mcpCtx: RunContext = {
    app,
    prices: {} as BenchPrices,
    home: '<HOME>',
    endpoint: '<ENDPOINT>',
    observer: {} as CdpConnection,
    keptTargetId: '<TARGET>',
    mainJsPath: '<MAIN>',
  };
  const forcedMcp = mcpConfigFor(mcpCtx, 'forced') as { mcpServers: Record<string, { env?: Record<string, string> }> };
  const logLabels = forcedMcp.mcpServers['jev-browser-wingman']?.env?.WINGMAN_LOG_LABELS === '1';
  const wingmanByRoute: Record<string, string> = {};
  const mcpByRoute: Record<string, string> = {};
  const argvByRoute: Record<string, string> = {};
  const turnsByRoute: Record<string, number> = {};
  for (const route of KNOWN_ROUTES) {
    wingmanByRoute[route] = wingmanConfigSha256(benchConfigText(app, null, route));
    const mcp = mcpConfigFor(mcpCtx, route) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    delete mcp.mcpServers['jev-browser-wingman']?.env?.WINGMAN_LOG_LABELS;
    mcpByRoute[route] = sha256Hex(JSON.stringify(mcp));
    argvByRoute[route] = sha256Hex(
      JSON.stringify(
        claudeArgv({
          prompt: '<PROMPT>',
          mcpConfigPath: '<MCP_CONFIG>',
          allowedTools: allowedToolsFor(route),
          model: app.model,
          maxTurns: maxTurnsFor(app, route),
        }),
      ),
    );
    turnsByRoute[route] = maxTurnsFor(app, route);
  }
  const profile = loadProfiles(home).find((p) => p.id === 'playwright-mcp') ?? null;
  return {
    config_version: RUN_CONFIG_VERSION,
    gate_mode: forcedCfg.gate.mode,
    policy_mode: forcedCfg.policy.mode,
    git_head: git.head,
    git_dirty: git.dirty,
    routes: [...app.routes],
    repeats: app.repeats,
    tasks: selected.map((t) => t.id),
    model: app.model,
    log_labels: logLabels,
    caller_cli_version: callerVersion,
    adapter: forcedCfg.adapter,
    harness_version: HARNESS_VERSION,
    playwright_mcp: PLAYWRIGHT_MCP_PACKAGE,
    wingman_config_sha256: wingmanByRoute,
    mcp_config_sha256: mcpByRoute,
    caller_argv_sha256: argvByRoute,
    tool_text_sha256: toolTextSha256(),
    tasks_sha256: sha256Hex(JSON.stringify(rawTasks)),
    prompts_sha256: sha256Hex(JSON.stringify(rawTasks.map((t) => KNOWN_ROUTES.map((r) => buildPrompt(t, r))))),
    fixtures_sha256: filesSha256(treeEntries(path.join(PKG_ROOT, 'fixtures'))),
    profile_sha256: sha256Hex(JSON.stringify(profile)),
    fixture_server: selected.some((t) => t.local === true),
    max_turns_by_route: turnsByRoute,
    per_run_timeout_ms: app.per_run_timeout_ms,
    caller_model: null,
  };
}

function defaultPrepareBrowser(
  app: BenchAppConfig,
  home: string,
  secretsFile: string | null,
  onReady: (ctx: RunContext) => void,
): { prepare: () => Promise<void>; stop: () => Promise<void> } {
  let ctx: RunContext | null = null;
  const profileDir = path.join(home, 'profile');
  const prepare = async (): Promise<void> => {
    fs.mkdirSync(home, { recursive: true });
    // WP-F: config.json is now rewritten per run (defaultRunOne), because its
    // `handoff` key differs by route. Seed it here too so the wingman/browser
    // home is valid before the first run's write.
    fs.writeFileSync(path.join(home, 'config.json'), benchConfigText(app, secretsFile));
    const ensured = await ensureChrome({
      port: app.port,
      profileDir,
      chromePath: null,
      home,
      window: 'offscreen',
    });
    if (!ensured.ok) {
      throw new Error(`ensureChrome failed: ${ensured.message}`);
    }
    const endpoint = ensured.endpoint;
    const observer = await CdpConnection.connect(endpoint);
    const { targetInfos } = await observer.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
      'Target.getTargets',
    );
    let keptTargetId = targetInfos.find((t) => t.type === 'page')?.targetId;
    if (!keptTargetId) {
      const created = await observer.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      keptTargetId = created.targetId;
    }
    ctx = {
      app,
      prices: {} as BenchPrices,
      home,
      endpoint,
      observer,
      keptTargetId,
      mainJsPath: path.join(PKG_ROOT, 'dist', 'src', 'cli', 'main.js'),
    };
    onReady(ctx);
  };
  const stop = async (): Promise<void> => {
    if (ctx) {
      await ctx.observer.close().catch(() => {});
    }
    await stopChrome({ port: app.port, profileDir, home }).catch(() => {});
  };
  return { prepare, stop };
}

// r24b (O7): the Chrome the cells drive, as Chrome reports it ('Chrome/130.0.6723.58'); null when unobservable.
async function chromeVersionOf(observer: Pick<CdpConnection, 'send'>): Promise<string | null> {
  try {
    const v = await observer.send<{ product?: string }>('Browser.getVersion');
    return typeof v.product === 'string' && v.product !== '' ? v.product : null;
  } catch {
    return null;
  }
}

export async function runBench(argv: string[], deps?: Partial<BenchDeps>): Promise<number> {
  const resultsDir = deps?.resultsDir ?? path.join(PKG_ROOT, 'bench', 'results');
  const pricesPath = deps?.pricesPath ?? path.join(PKG_ROOT, 'bench', 'prices.json');
  const env = deps?.env ?? process.env;
  const abortFn = deps?.shouldAbort ?? shouldAbort;
  const clock = deps?.now ?? (() => new Date());

  let capUsd: number | undefined;
  let phaseCapUsd: number | undefined;
  let tasksFilter: string[] | null = null;
  let routesFilter: BenchRoute[] | null = null;
  let secretsFile: string | null = null;
  let purpose: 'cap-proof' | 'measure' | 'experiment' = 'measure';
  let repeatsFilter: number | null = null;
  let baselinePath: string | null = null;
  let expectDiff: string[] | null = null;
  let preflightOnly = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preflight-only') {
      preflightOnly = true;
      continue;
    }
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--cap-usd' || flag === '--phase-cap-usd' || flag === '--tasks' || flag === '--routes' || flag === '--secrets-file' || flag === '--purpose' || flag === '--repeats' || flag === '--baseline' || flag === '--expect-diff') {
      if (value === undefined) {
        process.stderr.write(`BENCH-REFUSED: ${flag} needs a value\n`);
        return 2;
      }
      if (flag === '--cap-usd') capUsd = Number(value);
      else if (flag === '--phase-cap-usd') phaseCapUsd = Number(value);
      else if (flag === '--tasks') tasksFilter = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      else if (flag === '--routes') {
        routesFilter = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0) as BenchRoute[];
        for (const r of routesFilter) {
          if (!KNOWN_ROUTES.includes(r)) {
            process.stderr.write(`BENCH-REFUSED: unknown route ${r}\n`);
            return 2;
          }
        }
      } else if (flag === '--secrets-file') secretsFile = value;
      else if (flag === '--repeats') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          process.stderr.write(`BENCH-REFUSED: --repeats must be an integer from 1 to 5\n`);
          return 2;
        }
        repeatsFilter = n;
      } else if (flag === '--baseline') baselinePath = value;
      else if (flag === '--expect-diff') expectDiff = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      else if (value === 'cap-proof' || value === 'measure' || value === 'experiment') purpose = value;
      else {
        process.stderr.write(`BENCH-REFUSED: --purpose must be cap-proof, measure or experiment\n`);
        return 2;
      }
      i += 1;
    } else {
      process.stderr.write(`BENCH-REFUSED: unknown argument ${flag}\n`);
      return 2;
    }
  }

  // r24b: preflight argument checks (spec section 3.4).
  if (expectDiff !== null && baselinePath === null) {
    process.stderr.write('BENCH-REFUSED: --expect-diff needs --baseline\n');
    return 2;
  }
  for (const k of expectDiff ?? []) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      process.stderr.write(`BENCH-REFUSED: --expect-diff names unknown config key ${k}\n`);
      return 2;
    }
  }

  const app = readAppConfig();
  // BENCH_MODEL overrides the caller model from config.json for one pass;
  // config.json itself stays the default (sonnet).
  const modelOverride = env.BENCH_MODEL;
  if (typeof modelOverride === 'string' && modelOverride.trim() !== '') {
    app.model = modelOverride.trim();
  }
  // r24b (O6): the committed config.json ships gate_off/policy_off true (the off stance); BENCH_GATE_ON / BENCH_POLICY_ON
  // opt in; the legacy *_OFF names still work. Bad values are refused loudly (spec section 3.4).
  const stance = parseStanceEnv(env);
  if (!stance.ok) {
    process.stderr.write(stance.line + '\n');
    return 2;
  }
  if (stance.gateOff) app.gate_off = true;
  if (stance.policyOff) app.policy_off = true;
  if (stance.gateOn) app.gate_off = false;
  if (stance.policyOn) app.policy_off = false;
  if (routesFilter) {
    app.routes = routesFilter;
  }
  if (repeatsFilter !== null) {
    app.repeats = repeatsFilter;
  }

  let prices: BenchPrices | null = null;
  try {
    prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8')) as BenchPrices;
  } catch {
    prices = null;
  }

  const phaseSpentUsd = phaseSpentFrom(resultsDir);
  const start = checkStart({ capUsd, phaseCapUsd, prices, phaseSpentUsd });
  if (!start.ok) {
    process.stdout.write(start.line + '\n');
    return 2;
  }

  const key = env.TYPESAFE_API_KEY ?? readSecretsKey(secretsFile);
  if (!key) {
    process.stdout.write('BENCH-REFUSED: no TypeSafe key\n');
    return 2;
  }

  // r18 D8: `@REPO@` in task values expands to this repo (forward slashes)
  // right after the read, so every downstream consumer — filters, prompts,
  // value withholding — sees the absolute path, never the placeholder.
  const rawTasks = readTasks();
  let tasks = expandTaskValuePlaceholders(rawTasks, PKG_ROOT);
  if (tasksFilter) {
    const known = new Set(tasks.map((t) => t.id));
    for (const id of tasksFilter) {
      if (!known.has(id)) {
        process.stderr.write(`BENCH-REFUSED: unknown task ${id}\n`);
        return 2;
      }
    }
    tasks = tasks.filter((t) => tasksFilter!.includes(t.id));
  }

  // r24b: the measured-run rule (O3), the run config (recorded in the results file) and the zero-spend baseline
  // preflight. All run before the fixture server, Chrome or any cell, so a refusal spends nothing and writes no
  // results file.
  if (purpose === 'measure' && baselinePath === null && !preflightOnly) {
    process.stderr.write(
      'BENCH-REFUSED: --purpose measure needs --baseline <file> (a measured run must name the run it is comparable to; use --purpose experiment for an unbaselined run)\n',
    );
    return 2;
  }
  const callerVersion = (deps?.callerVersion ?? (() => readCallerVersion()))();
  if (callerVersion === null) {
    process.stderr.write('BENCH-REFUSED: caller CLI version unreadable (claude --version failed or printed no version)\n');
    return 2;
  }
  const runConfig = computeRunConfig(app, tasks, rawTasks, (deps?.gitInfo ?? (() => readGitInfo(PKG_ROOT)))(), callerVersion);
  let baseCfg: Record<string, unknown> | null = null;
  let baseObs: Record<string, unknown> | null = null;
  if (baselinePath !== null) {
    const base = readBaselineConfig(baselinePath);
    if (!base.ok) {
      process.stdout.write(base.line + '\n');
      return 2;
    }
    baseCfg = base.config;
    baseObs = base.observed;
    const verdict = compareToBaseline(runConfig, baseCfg, expectDiff ?? [], path.basename(baselinePath));
    for (const line of verdict.lines) process.stdout.write(line + '\n');
    if (!verdict.ok) return 2;
  }
  // r24b (O7): the observed environment. WARNINGS only: nothing here can refuse a run (r23b recorded none of it).
  const observed: ObservedEnv = emptyObserved();
  observed.node_version = (deps?.nodeVersion ?? (() => process.version))();
  let observedLists: Record<string, CallerLists> | null = null;
  let observedWarnings = 0;
  const warnObserved = (keys: readonly ObservedKey[], route?: string): void => {
    if (baselinePath === null) return;
    const lines = compareObserved(observed, baseObs, keys, route);
    observedWarnings += lines.length;
    for (const line of lines) process.stdout.write(line + '\n');
  };
  warnObserved(['node_version']);
  if (preflightOnly) {
    if (baselinePath !== null) {
      process.stdout.write(`BENCH-OBSERVED: warnings=${observedWarnings} (preflight sees the Node version only; warnings never block)\n`);
    }
    process.stdout.write(`BENCH-PREFLIGHT: ok nothing ran config=${JSON.stringify(runConfig)}\n`);
    return 0;
  }

  // r18: one ephemeral fixture server for the whole invocation when any
  // selected task is local (t15-t17); every local task resolves against it.
  let fixture: FixtureServer | null = null;
  if (tasks.some((t) => t.local === true)) {
    fixture = await startFixtureServer();
  }

  const home = BENCH_HOME;
  const holder: { ctx: RunContext | null } = { ctx: null };
  const defaults = defaultPrepareBrowser(app, home, secretsFile, (c) => {
    holder.ctx = c;
  });
  const fullDeps: BenchDeps = {
    runOne: deps?.runOne ?? (() => {
      throw new Error('runOne called before prepareBrowser');
    }),
    prepareBrowser: deps?.prepareBrowser ?? defaults.prepare,
    stopBrowser: deps?.stopBrowser ?? defaults.stop,
    resultsDir,
    pricesPath,
    env,
    shouldAbort: abortFn,
  };

  try {
    await fullDeps.prepareBrowser();
    if (!deps?.runOne) {
      const ctx = holder.ctx;
      if (!ctx) {
        throw new Error('prepareBrowser did not produce a browser context');
      }
      // checkStart already refused when prices were missing or incomplete.
      ctx.prices = prices as BenchPrices;
      ctx.fixtureUrl = fixture?.url;
      fullDeps.runOne = defaultRunOne(ctx, secretsFile);
    }
  } catch (err) {
    // The run loop's finally below does not exist yet on this path; close the
    // fixture here so a failed prepare never leaks it.
    if (fixture) {
      await fixture.close().catch(() => {});
    }
    throw err;
  }
  // r24b (O7): the Chrome version, recorded now and compared as a WARNING (no cell has run, nothing is spent).
  observed.chrome_version = await (deps?.chromeVersion ?? (async () => (holder.ctx ? chromeVersionOf(holder.ctx.observer) : null)))();
  warnObserved(['chrome_version']);

  const runs: BenchRunRecord[] = [];
  let aborted: null | 'cap' | 'error' | 'jev-down' = null;
  let exitCode = 0;
  let jevDownStreak = 0;
  let runIndex = 0;
  let postChecked = false;
  const listsWarnedRoutes = new Set<string>();

  try {
    for (let repeat = 0; repeat < app.repeats; repeat++) {
      for (const task of tasks) {
        for (const route of app.routes) {
          const { record, usd } = await fullDeps.runOne(task, route);
          // r24b (O7): the init lists ride each route's first cell only; they are lifted into observed_lists (by route) and
          // stripped from the stored record, which keeps their hashes.
          let stored = record;
          if (record.caller?.lists !== undefined) {
            observedLists ??= {};
            observedLists[record.route] ??= record.caller.lists;
            const { lists: _lists, ...callerRest } = record.caller;
            stored = { ...record, caller: callerRest };
          }
          runs.push({ ...stored, usd });
          if (!listsWarnedRoutes.has(record.route) && record.caller?.lists_sha256 !== undefined) {
            listsWarnedRoutes.add(record.route);
            applyListHashes(observed, record.route, record.caller.lists_sha256);
            warnObserved(LIST_OBSERVED_KEYS, record.route);
          }
          runIndex += 1;
          // r24b (O4): the resolved model is known only from a cell's stream, so it is compared right after the
          // FIRST cell (spec section 3.4); a failure ends the run with the one cell recorded.
          if (!postChecked && baseCfg !== null) {
            postChecked = true;
            const post = compareToBaseline(
              { ...runConfig, caller_model: callerModelOf([record.caller?.model]) },
              baseCfg,
              expectDiff ?? [],
              path.basename(baselinePath!),
              {
                keys: POST_KEYS,
                tag: 'BENCH-BASELINE-POST',
                refuse: (bad, total) => `BENCH-ABORTED: baseline mismatch: ${bad} of ${total} keys after ${runIndex} run(s)`,
              },
            );
            for (const line of post.lines) process.stdout.write(line + '\n');
            if (!post.ok) {
              aborted = 'error';
              exitCode = 4;
              break;
            }
          }
          const stop = abortFn({
            runSpentUsd: usd,
            capUsd: capUsd!,
            phaseSpentUsd: phaseSpentUsd + runs.slice(0, -1).reduce((s, r) => s + r.usd, 0),
            phaseCapUsd: phaseCapUsd!,
          });
          if (stop) {
            process.stdout.write(`BENCH-ABORTED: cap reached after ${runIndex} runs\n`);
            aborted = 'cap';
            exitCode = 3;
            break;
          }
          // r24d: the decision service is evidently dead (exit 5, distinct from cap 3 and baseline-model 4); spend so far is
          // already in `runs`, so the results file and the phase ledger count it.
          if (record.route !== 'playwright') {
            jevDownStreak = record.jev_down === true ? jevDownStreak + 1 : 0;
            if (jevDownStreak >= JEV_DOWN_STREAK) {
              process.stdout.write(
                `BENCH-ABORTED: decision service down after ${runIndex} runs (${jevDownStreak} consecutive wingman cells ended jev-error with zero Jev tokens)\n`,
              );
              aborted = 'jev-down';
              exitCode = 5;
              break;
            }
          }
        }
        if (aborted) break;
      }
      if (aborted) break;
    }
  } catch (err) {
    process.stderr.write(`jev-browser-wingman bench: ${(err as Error).message}\n`);
    aborted = 'error';
    exitCode = 1;
  } finally {
    // r24b (O7): per-run list hashes folded (a disagreement reads 'mixed'), warned once, and the warning tally closed.
    const finalObserved: ObservedEnv = { ...observed, ...mergeListHashes(runs.map((r) => ({ route: r.route, hashes: r.caller?.lists_sha256 }))) };
    if (baselinePath !== null) {
      for (const k of LIST_OBSERVED_KEYS) {
        for (const [route, h] of Object.entries(finalObserved[k] ?? {})) {
          if (h === 'mixed') {
            observedWarnings += 1;
            process.stdout.write(`BENCH-OBSERVED-WARN: observed ${k}[${route}] mixed across runs\n`);
          }
        }
      }
      process.stdout.write(`BENCH-OBSERVED: warnings=${observedWarnings} (warn-only; nothing was blocked)\n`);
    }
    const file: BenchResultsFile = {
      date: '',
      purpose,
      harness_version: HARNESS_VERSION,
      model: app.model,
      cap_usd: capUsd!,
      phase_cap_usd: phaseCapUsd!,
      aborted,
      total_usd: round6(runs.reduce((s, r) => s + r.usd, 0)),
      config: { ...runConfig, caller_model: callerModelOf(runs.map((r) => r.caller?.model)) },
      ...(baselinePath !== null ? { baseline: { file: path.basename(baselinePath), expect_diff: expectDiff ?? [] } } : {}),
      observed: finalObserved,
      // r24b amendment (spec section 16): hashes + counts only here; the name lists go to the local sibling file below.
      observed_lists: summarizeObservedLists(observedLists),
      runs,
      summary: summarize(runs),
      task_pairs: summarizePairs(runs),
    };
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      const name = resultsFileName(clock(), (n) => fs.existsSync(path.join(resultsDir, n)));
      file.date = name;
      fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(file, null, 2), { flag: 'wx' });
      // r24b amendment (spec section 16): the caller's tool/skill/plugin/agent/MCP/hook NAMES stay local; the pushed results
      // JSON holds only their hashes and counts.
      if (observedLists !== null) {
        fs.writeFileSync(path.join(resultsDir, observedListsFileName(name)), JSON.stringify(observedLists, null, 2), { flag: 'wx' });
      }
    } catch (err) {
      process.stderr.write(`jev-browser-wingman bench: could not write results: ${(err as Error).message}\n`);
      if (exitCode === 0) exitCode = 1;
    }
    await fullDeps.stopBrowser().catch(() => {});
    if (fixture) {
      await fixture.close().catch(() => {});
    }
  }

  return exitCode;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runBench(process.argv.slice(2)).then((code) => process.exit(code));
}
