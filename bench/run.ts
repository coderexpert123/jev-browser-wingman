// WP-H: the benchmark harness entry point.
//
//   node dist/bench/run.js --cap-usd <x> --phase-cap-usd <y>
//        [--tasks <id,...>] [--routes <csv>] [--secrets-file <path>]
//        [--purpose cap-proof|measure|experiment]
//
// 8 tasks x 3 routes x 1 repeat on one Chrome (port 9344, profile
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
import { evaluateOracle } from './oracle.js';
import { ensureChrome, stopChrome } from '../src/browser/chrome.js';
import { expandHome } from '../src/contract/home.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { packageRoot } from '../src/package-root.js';

export interface BenchTask {
  id: string;
  path: string;
  goal: string;
  values: Record<string, string>;
  oracle: string;
}

export type BenchRoute = 'playwright' | 'wingman' | 'browse';

const KNOWN_ROUTES: BenchRoute[] = ['playwright', 'wingman', 'browse'];

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
}

const PKG_ROOT = packageRoot();
const BENCH_HOME = path.join(PKG_ROOT, 'bench', '.home');
const HARNESS_VERSION = 1;

function readTasks(): BenchTask[] {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bench', 'tasks.json'), 'utf8')) as BenchTask[];
}

function readAppConfig(): BenchAppConfig {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'bench', 'config.json'), 'utf8')) as BenchAppConfig;
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

function resultsFileName(now: Date): string {
  return `${now.getFullYear()}-${twoDigit(now.getMonth() + 1)}-${twoDigit(now.getDate())}-${twoDigit(now.getHours())}${twoDigit(now.getMinutes())}.json`;
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

// The harness may navigate the shared page before a run; the tools may not.
async function resetPages(ctx: RunContext, startUrl: string): Promise<void> {
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
  await ctx.observer.send('Page.navigate', { url: startUrl }, sessionId);
}

export function mcpConfigFor(ctx: RunContext, route: BenchRoute): object {
  const servers: Record<string, unknown> = {
    playwright: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ctx.endpoint },
    },
  };
  // 'wingman' and 'browse' (WP-T3 front door) both register the wingman
  // server alongside Playwright MCP.
  if (route !== 'playwright') {
    // OG-9 bench-only isolation: forward WINGMAN_BROWSE_ONLY so the spawned
    // server lists browse_step without the legacy wingman_do/wingman_check.
    // Unset (the default) leaves the server env exactly as before.
    const browseOnly = process.env.WINGMAN_BROWSE_ONLY === '1' ? { WINGMAN_BROWSE_ONLY: '1' } : {};
    servers['jev-browser-wingman'] = {
      command: 'node',
      args: [ctx.mainJsPath, 'mcp'],
      env: { WINGMAN_HOME: ctx.home, WINGMAN_CDP_ENDPOINT: ctx.endpoint, ...browseOnly },
    };
  }
  return { mcpServers: servers };
}

export function allowedToolsFor(route: BenchRoute): string[] {
  return route === 'playwright' ? ['mcp__playwright'] : ['mcp__playwright', 'mcp__jev-browser-wingman'];
}

const START_BASE = 'https://the-internet.herokuapp.com';

function defaultRunOne(ctx: RunContext, secretsFile: string | null): BenchDeps['runOne'] {
  return async (task, route) => {
    const logPath = path.join(ctx.home, 'log.jsonl');
    const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    const mcpConfigPath = path.join(ctx.home, `mcp-${route}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfigFor(ctx, route), null, 2));

    await resetPages(ctx, START_BASE + task.path);

    const res = await runClaude({
      prompt: buildPrompt(task, route),
      mcpConfigPath,
      allowedTools: allowedToolsFor(route),
      model: ctx.app.model,
      maxTurns: ctx.app.max_turns,
      timeoutMs: ctx.app.per_run_timeout_ms,
      cwd: path.join(PKG_ROOT, 'bench', '.home'),
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
    const roundPhases: Array<{ observeMs: number; jevMs: number; actMs: number; settleMs: number }> = [];
    if (fs.existsSync(logPath)) {
      const fresh = fs.readFileSync(logPath, 'utf8').slice(before);
      for (const line of fresh.split('\n')) {
        if (!line.trim()) continue;
        let rec: {
          jev_calls?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
          status?: unknown;
          phases?: { attachMs?: unknown; firstObserveMs?: unknown; rounds?: Array<Record<string, unknown>> };
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
    };
    return { record, usd };
  };
}

// WP-T3: the pure renderer for the bench home's config.json. The gate/policy
// off stance appears only when the run's flags are set; the committed
// bench/config.json ships gate_off/policy_off false, so the default stance
// always enforces.
export function benchConfigText(app: BenchAppConfig, secretsFile: string | null): string {
  const config: Record<string, unknown> = {
    mode: 'on',
    adapter: 'playwright',
    window: 'offscreen',
    port: app.port,
    profile_dir: path.join(BENCH_HOME, 'profile'),
    secrets_file: secretsFile ? path.resolve(expandHome(secretsFile)) : null,
  };
  if (app.gate_off === true) {
    config.gate = { mode: 'off' };
  }
  if (app.policy_off === true) {
    config.policy = { mode: 'off' };
  }
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

  let capUsd: number | undefined;
  let phaseCapUsd: number | undefined;
  let tasksFilter: string[] | null = null;
  let routesFilter: BenchRoute[] | null = null;
  let secretsFile: string | null = null;
  let purpose: 'cap-proof' | 'measure' | 'experiment' = 'measure';

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--cap-usd' || flag === '--phase-cap-usd' || flag === '--tasks' || flag === '--routes' || flag === '--secrets-file' || flag === '--purpose') {
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
      date: resultsFileName(new Date()),
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
      fs.writeFileSync(path.join(resultsDir, file.date), JSON.stringify(file, null, 2));
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
