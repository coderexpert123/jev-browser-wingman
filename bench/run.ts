// WP-H: the benchmark harness entry point.
//
//   node dist/bench/run.js --cap-usd <x> --phase-cap-usd <y>
//        [--tasks <id,...>] [--routes <csv>] [--secrets-file <path>]
//        [--purpose cap-proof|measure|experiment]
//
// tasks.json entries x routes x repeats on one Chrome (port 9344, profile
// bench/.home/profile, window offscreen). Spend caps are enforced by
// bench/cap.ts; the USD ceilings live there and nowhere else.
//
// The gate-off/policy-off stance (WP-T3) travels per run only: env
// BENCH_GATE_OFF=1 / BENCH_POLICY_OFF=1 (or true) inject the off stance into
// the bench home's config.json for that run; the committed bench/config.json
// ships both flags false.
//
// This module is NOT run by a builder: every live benchmark run is the
// operator-gated OG-6/OG-9 stage.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkStart, priceRun, shouldAbort, type BenchPrices } from './cap.js';
import { runClaude } from './claude-run.js';
import { evaluateOracle, evaluateExpression } from './oracle.js';
import { ensureChrome, stopChrome } from '../src/browser/chrome.js';
import { expandHome } from '../src/contract/home.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { packageRoot } from '../src/package-root.js';
import { OPS } from '../src/contract/types.js';
import { loadProfiles, withheldClasses, type Profile } from '../src/core/profiles.js';
import type { WithholdableClass } from '../src/contract/constants.js';

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
  // WP-T3 stance flags: the committed config.json ships both false; the off
  // stance is injected per run through BENCH_GATE_OFF / BENCH_POLICY_OFF.
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
  aborted: null | 'cap' | 'error';
  total_usd: number;
  runs: BenchRunRecord[];
  summary: Record<string, { success_rate: number; median_wall_ms: number; median_usd: number; fallback_rate: number }>;
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
}

const PKG_ROOT = packageRoot();
const BENCH_HOME = path.join(PKG_ROOT, 'bench', '.home');
const HARNESS_VERSION = 2;

function readTasks(): BenchTask[] {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bench', 'tasks.json'), 'utf8')) as BenchTask[];
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
export const FORCED_ENGAGEMENT_LINE =
  'For this browsing task, hand the page work to the wingman browse_step tool: pass the goal, the ordered list of remaining steps in steps, and every URL and text it needs in values; if it returns a step to you, call it again with pick naming the element by role and name, and when a call ends unfinished, call it again with the same arguments.';

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
    };
  }
  return summary;
}

export interface RunContext {
  app: BenchAppConfig;
  prices: BenchPrices;
  home: string;
  endpoint: string;
  observer: CdpConnection;
  keptTargetId: string;
  mainJsPath: string;
}

// The harness may navigate the shared page and clear its origin's storage before a run; the tools may not.
async function resetPages(ctx: RunContext, startUrl: string, clearOrigin?: string): Promise<void> {
  const { targetInfos } = await ctx.observer.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
    'Target.getTargets',
  );
  for (const t of targetInfos) {
    if (t.type === 'page' && t.targetId !== ctx.keptTargetId) {
      await ctx.observer.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    }
  }
  const { sessionId } = await ctx.observer.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId: ctx.keptTargetId,
    flatten: true,
  });
  if (clearOrigin) {
    await ctx.observer.send('Storage.clearDataForOrigin', {
      origin: clearOrigin,
      storageTypes: 'all',
    }, sessionId);
  }
  await ctx.observer.send('Page.navigate', { url: startUrl }, sessionId);
}

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
            args: [ctx.mainJsPath, 'with-browser', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
            env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ctx.endpoint, WINGMAN_HOME: ctx.home },
          }
        : {
            command: 'npx',
            args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
            env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ctx.endpoint },
          },
  };
  // 'wingman', 'browse' and 'forced' all register the wingman server
  // alongside Playwright MCP, in its plain (un-wrapped) shape.
  if (route !== 'playwright') {
    servers['jev-browser-wingman'] = {
      command: 'node',
      args: [ctx.mainJsPath, 'mcp'],
      env: { WINGMAN_HOME: ctx.home, WINGMAN_CDP_ENDPOINT: ctx.endpoint },
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
  phases?: { rounds?: unknown[] };
  acts_by_op?: Record<string, unknown>;
  // WP-outcome-evidence WP-C: written by loop.ts's buildLogRecord from the
  // call's final step_review, why + a candidate COUNT only (never labels).
  step_review?: { why?: unknown; candidates?: unknown };
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

const START_BASE = 'https://the-internet.herokuapp.com';

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

    const startUrl = /^https?:\/\//.test(task.path)
      ? task.path
      : START_BASE + task.path;
    await resetPages(
      ctx,
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
    const roundPhases: Array<{ observeMs: number; jevMs: number; actMs: number; settleMs: number }> = [];
    const freshLines: string[] = [];
    if (fs.existsSync(logPath)) {
      const fresh = fs.readFileSync(logPath, 'utf8').slice(before);
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
          for (const round of rec.phases.rounds ?? []) {
            roundPhases.push({
              observeMs: num(round.observeMs) ? round.observeMs : 0,
              jevMs: num(round.jevMs) ? round.jevMs : 0,
              actMs: num(round.actMs) ? round.actMs : 0,
              settleMs: num(round.settleMs) ? round.settleMs : 0,
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
            observe_ms: Math.round(median(roundPhases.map((r) => r.observeMs))),
            jev_ms: Math.round(median(roundPhases.map((r) => r.jevMs))),
            act_ms: Math.round(median(roundPhases.map((r) => r.actMs))),
            settle_ms: Math.round(median(roundPhases.map((r) => r.settleMs))),
            rounds: roundPhases.length,
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
      handoff_records: handoffRecords,
      handoffs: handoffRecords.length,
      picks: handoffRecords.filter((r) => r.pick === true).length,
      wingman_acts: wingmanActs,
      nav_by_wingman: navByWingman,
      raw_acts,
      raw_script,
      tool_use_counts: toolUseCounts,
      first_call_invalid: firstInvalidRun(handoffRecords),
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

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--cap-usd' || flag === '--phase-cap-usd' || flag === '--tasks' || flag === '--routes' || flag === '--secrets-file' || flag === '--purpose' || flag === '--repeats') {
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
      } else if (value === 'cap-proof' || value === 'measure' || value === 'experiment') purpose = value;
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

  const app = readAppConfig();
  // BENCH_MODEL overrides the caller model from config.json for one pass;
  // config.json itself stays the default (sonnet).
  const modelOverride = env.BENCH_MODEL;
  if (typeof modelOverride === 'string' && modelOverride.trim() !== '') {
    app.model = modelOverride.trim();
  }
  // WP-T3 stance injection: the off stance travels per run through the env,
  // never in the committed config.json (both flags ship false there).
  if (env.BENCH_GATE_OFF === '1' || env.BENCH_GATE_OFF === 'true') {
    app.gate_off = true;
  }
  if (env.BENCH_POLICY_OFF === '1' || env.BENCH_POLICY_OFF === 'true') {
    app.policy_off = true;
  }
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

  let tasks = readTasks();
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

  await fullDeps.prepareBrowser();
  if (!deps?.runOne) {
    const ctx = holder.ctx;
    if (!ctx) {
      throw new Error('prepareBrowser did not produce a browser context');
    }
    // checkStart already refused when prices were missing or incomplete.
    ctx.prices = prices as BenchPrices;
    fullDeps.runOne = defaultRunOne(ctx, secretsFile);
  }

  const runs: BenchRunRecord[] = [];
  let aborted: null | 'cap' | 'error' = null;
  let exitCode = 0;
  let runIndex = 0;

  try {
    for (let repeat = 0; repeat < app.repeats; repeat++) {
      for (const task of tasks) {
        for (const route of app.routes) {
          const { record, usd } = await fullDeps.runOne(task, route);
          runs.push({ ...record, usd });
          runIndex += 1;
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
    const file: BenchResultsFile = {
      date: '',
      purpose,
      harness_version: HARNESS_VERSION,
      model: app.model,
      cap_usd: capUsd!,
      phase_cap_usd: phaseCapUsd!,
      aborted,
      total_usd: round6(runs.reduce((s, r) => s + r.usd, 0)),
      runs,
      summary: summarize(runs),
    };
    try {
      fs.mkdirSync(resultsDir, { recursive: true });
      const name = resultsFileName(clock(), (n) => fs.existsSync(path.join(resultsDir, n)));
      file.date = name;
      fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(file, null, 2), { flag: 'wx' });
    } catch (err) {
      process.stderr.write(`jev-browser-wingman bench: could not write results: ${(err as Error).message}\n`);
      if (exitCode === 0) exitCode = 1;
    }
    await fullDeps.stopBrowser().catch(() => {});
  }

  return exitCode;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runBench(process.argv.slice(2)).then((code) => process.exit(code));
}
