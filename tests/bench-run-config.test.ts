// r24b WP-A: the recorded run config, the zero-spend baseline preflight, the
// stance default (O6), the measured-run rule (O3), the caller identity (O4) and
// the observed environment (O7). These drive the real `runBench` with a fake
// runner; the claude spawn paths run against a fake `claude` on PATH. Nothing
// here spends money or launches Chrome.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  benchConfigText,
  computeRunConfig,
  mcpConfigFor,
  runBench,
  type BenchAppConfig,
  type BenchDeps,
  type BenchResultsFile,
  type BenchRoute,
  type BenchRunRecord,
  type RunContext,
} from '../bench/run.js';
import {
  CONFIG_KEYS,
  LIST_NAMES,
  OBSERVED_KEYS,
  callerListHashes,
  callerListSummaries,
  callerModelOf,
  canonicalJson,
  compareObserved,
  emptyObserved,
  filesSha256,
  listSha256,
  mergeListHashes,
  observedListsFileName,
  parseCallerVersion,
  readCallerVersion,
  sha256Hex,
  toolTextSha256,
  wingmanConfigSha256,
} from '../bench/run-config.js';
import {
  claudeArgv,
  hookNameFromEvent,
  initFromEvent,
  listsFromInit,
  runClaude,
  type CallerLists,
} from '../bench/claude-run.js';
import { SERVED_TOOLS } from '../src/surfaces/tool-text.js';
import { packageRoot } from '../src/package-root.js';

const PRICES = {
  llm: {
    sonnet: { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 },
  },
  typesafe: { input_per_mtok: 0.042, output_per_mtok: 0 },
  killed_run_charge_usd: 0.01,
};

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePrices(dir: string): string {
  const p = path.join(dir, 'prices.json');
  fs.writeFileSync(p, JSON.stringify(PRICES));
  return p;
}

function fakeRecord(task: object, route: BenchRoute, usd: number): BenchRunRecord {
  const t = task as { id: string };
  return {
    task: t.id,
    route,
    ok: true,
    wall_ms: 100,
    browser_tool_calls: 1,
    per_step_ms: 100,
    llm: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, cli_reported_usd: null },
    typesafe: { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 },
    wingman: { calls: 0, fallback: 0, needs_confirmation: 0 },
    usd,
  };
}

// Only the bench's own lines are captured; everything else (the test runner's reporter flushes asynchronously and
// would otherwise be swallowed while a capture is active, silently dropping other tests' results) passes through.
const BENCH_LINE = /^(BENCH-|jev-browser-wingman bench:)/;

async function capture(fn: () => Promise<number>): Promise<{ exit: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const tee = (chunks: string[], orig: typeof process.stdout.write, stream: NodeJS.WriteStream) =>
    (s: unknown, ...rest: unknown[]): boolean => {
      if (BENCH_LINE.test(String(s))) {
        chunks.push(String(s));
        return true;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any).call(stream, s, ...rest);
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).stdout.write = tee(outChunks, origOut, process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).stderr.write = tee(errChunks, origErr, process.stderr);
  try {
    const exit = await fn();
    return { exit, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** The results files of a dir (the local `.observed-lists.json` siblings are NOT results files). */
function resultsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.observed-lists.json'));
}

function listsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.observed-lists.json'));
}

function readResults(dir: string, name?: string): BenchResultsFile {
  const files = resultsFiles(dir).sort();
  return JSON.parse(fs.readFileSync(path.join(dir, name ?? files[files.length - 1]), 'utf8')) as BenchResultsFile;
}

function seedResults(dir: string, name: string, totalUsd: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({
      date: name.replace(/\.json$/, ''),
      purpose: 'measure',
      harness_version: 1,
      model: 'sonnet',
      cap_usd: 5,
      phase_cap_usd: 10,
      aborted: null,
      total_usd: totalUsd,
      runs: [],
      summary: {},
    }),
  );
}

const GIT = { head: 'a'.repeat(40), dirty: false };
const ENV_BASE = { TYPESAFE_API_KEY: 'bench-test-key' };
const ENV_ON = { ...ENV_BASE, BENCH_GATE_ON: '1', BENCH_POLICY_ON: 'true' };
const ENV_LEGACY_OFF = { ...ENV_BASE, BENCH_GATE_OFF: '1', BENCH_POLICY_OFF: 'true' };
const ARGV = [
  '--cap-usd', '5', '--phase-cap-usd', '10',
  '--tasks', 't4-add-elements,t10-saucedemo-checkout',
  '--routes', 'forced', '--repeats', '1', '--purpose', 'experiment',
];
const LISTS: CallerLists = {
  tools: ['Bash', 'Read', 'mcp__x__y'],
  skills: ['s1'],
  plugins: ['p1@1.0'],
  agents: ['a1'],
  mcp_servers: ['x:connected'],
  hooks: ['SessionStart:startup'],
};
const H = callerListHashes(LISTS);

const SPEC_KEYS = [
  'config_version', 'gate_mode', 'policy_mode', 'git_head', 'git_dirty', 'routes', 'repeats', 'tasks', 'model',
  'log_labels', 'caller_cli_version', 'adapter', 'harness_version', 'playwright_mcp', 'wingman_config_sha256',
  'mcp_config_sha256', 'caller_argv_sha256', 'tool_text_sha256', 'tasks_sha256', 'prompts_sha256', 'fixtures_sha256',
  'profile_sha256', 'fixture_server', 'max_turns_by_route', 'per_run_timeout_ms', 'caller_model',
];

interface Harness {
  deps: Partial<BenchDeps>;
  resultsDir: string;
  runCalls: () => number;
  prepares: () => number;
}

interface HarnessOpts {
  /** The caller model each cell reports; `undefined` omits `caller` entirely. A function sees the 1-based cell number. */
  model?: string | ((n: number) => string | undefined);
  /** The init lists each cell reports (null: no lists). Sees the 1-based cell number and the route. */
  lists?: (n: number, route: BenchRoute) => CallerLists | null;
}

function harness(env: NodeJS.ProcessEnv, over: Partial<BenchDeps> = {}, opts: HarnessOpts = {}): Harness {
  const resultsDir = tmpDir('jevw-rc-results-');
  const pricesPath = writePrices(tmpDir('jevw-rc-prices-'));
  let runs = 0;
  let prepares = 0;
  const modelOf = (n: number): string | undefined =>
    opts.model === undefined ? 'm-test' : typeof opts.model === 'function' ? opts.model(n) : opts.model;
  const listsOf = opts.lists ?? (() => LISTS);
  const deps: Partial<BenchDeps> = {
    runOne: async (task, route) => {
      runs += 1;
      const rec = fakeRecord(task, route, 0.02);
      const model = modelOf(runs);
      if (model !== undefined) {
        const lists = listsOf(runs, route);
        rec.caller = {
          claude_code_version: '9.9.9',
          model,
          ...(lists ? { lists_sha256: callerListHashes(lists), lists } : {}),
        };
      }
      return { record: rec, usd: 0.02 };
    },
    prepareBrowser: async () => {
      prepares += 1;
    },
    stopBrowser: async () => {},
    resultsDir,
    pricesPath,
    env,
    gitInfo: () => GIT,
    callerVersion: () => '9.9.9',
    nodeVersion: () => 'v22.1.0',
    chromeVersion: async () => 'Chrome/130.0.1',
    ...over,
  };
  return { deps, resultsDir, runCalls: () => runs, prepares: () => prepares };
}

async function preflightConfig(env: NodeJS.ProcessEnv, argv: string[]): Promise<Record<string, unknown>> {
  const h = harness(env);
  const r = await capture(() => runBench([...argv, '--preflight-only'], h.deps));
  assert.equal(r.exit, 0, r.out + r.err);
  assert.equal(h.runCalls(), 0);
  assert.equal(h.prepares(), 0);
  assert.equal(resultsFiles(h.resultsDir).length, 0);
  const marker = 'BENCH-PREFLIGHT: ok nothing ran config=';
  const line = r.out.split('\n').find((l) => l.startsWith(marker));
  assert.ok(line, r.out);
  return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
}

function writeBaseline(config: Record<string, unknown>, over: Record<string, unknown> = {}, observed?: Record<string, unknown>): string {
  const p = path.join(tmpDir('jevw-rc-base-'), 'base.json');
  fs.writeFileSync(p, JSON.stringify({ config: { ...config, caller_model: 'm-test', ...over }, ...(observed ? { observed } : {}) }));
  return p;
}

const OBS_EQ = {
  node_version: 'v22.1.0',
  chrome_version: 'Chrome/130.0.1',
  caller_tools_sha256: { forced: H.tools },
  caller_skills_sha256: { forced: H.skills },
  caller_plugins_sha256: { forced: H.plugins },
  caller_agents_sha256: { forced: H.agents },
  caller_mcp_servers_sha256: { forced: H.mcp_servers },
  caller_hooks_sha256: { forced: H.hooks },
};

const configJson = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'bench', 'config.json'), 'utf8')) as BenchAppConfig;

// ---- 1 ----

test('r24b config: the results file records the effective stance, flags, caller and hashes', async () => {
  const h = harness(ENV_BASE);
  const r = await capture(() => runBench(ARGV, h.deps));
  assert.equal(r.exit, 0, r.out + r.err);
  const files = resultsFiles(h.resultsDir);
  assert.equal(files.length, 1);
  const res = readResults(h.resultsDir);
  const c = res.config as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(c), SPEC_KEYS);
  assert.deepEqual(Object.keys(c), [...CONFIG_KEYS]);
  assert.equal(c.gate_mode, 'off');
  assert.equal(c.policy_mode, 'off');
  assert.equal(c.git_head, 'a'.repeat(40));
  assert.equal(c.git_dirty, false);
  assert.deepEqual(c.routes, ['forced']);
  assert.equal(c.repeats, 1);
  assert.deepEqual(c.tasks, ['t4-add-elements', 't10-saucedemo-checkout']);
  assert.equal(c.model, configJson.model);
  assert.equal(c.per_run_timeout_ms, configJson.per_run_timeout_ms);
  assert.equal(c.log_labels, true);
  assert.equal(c.caller_cli_version, '9.9.9');
  assert.equal(c.caller_model, 'm-test');
  assert.equal(c.adapter, 'playwright');
  assert.equal(c.harness_version, res.harness_version);
  assert.equal(c.playwright_mcp, '@playwright/mcp@0.0.80');
  assert.equal(c.fixture_server, true);
  const turns = (rt: BenchRoute): number => configJson.route_max_turns?.[rt] ?? configJson.max_turns;
  assert.deepEqual(c.max_turns_by_route, {
    playwright: turns('playwright'),
    wingman: turns('wingman'),
    browse: turns('browse'),
    forced: turns('forced'),
  });
  assert.equal(c.tool_text_sha256, toolTextSha256());
  const on = { ...configJson, gate_off: true, policy_off: true };
  assert.deepEqual(c.wingman_config_sha256, {
    playwright: wingmanConfigSha256(benchConfigText(on, null, 'playwright')),
    wingman: wingmanConfigSha256(benchConfigText(on, null, 'wingman')),
    browse: wingmanConfigSha256(benchConfigText(on, null, 'browse')),
    forced: wingmanConfigSha256(benchConfigText(on, null, 'forced')),
  });
  for (const k of ['tasks_sha256', 'prompts_sha256', 'fixtures_sha256', 'profile_sha256', 'tool_text_sha256']) {
    assert.match(String(c[k]), /^[0-9a-f]{64}$/, k);
  }
  for (const k of ['mcp_config_sha256', 'caller_argv_sha256']) {
    const m = c[k] as Record<string, string>;
    assert.deepEqual(Object.keys(m), ['playwright', 'wingman', 'browse', 'forced'], k);
    for (const v of Object.values(m)) assert.match(v, /^[0-9a-f]{64}$/, k);
  }
  for (const run of res.runs) {
    assert.deepEqual(run.caller, { claude_code_version: '9.9.9', model: 'm-test', lists_sha256: callerListHashes(LISTS) });
    assert.equal('lists' in (run.caller ?? {}), false);
  }
  assert.equal('baseline' in res, false);

  // second leg: a live-only task selection has no fixture server
  const h2 = harness(ENV_BASE);
  const argv2 = ARGV.map((a) => (a === 't4-add-elements,t10-saucedemo-checkout' ? 't10-saucedemo-checkout' : a));
  const r2 = await capture(() => runBench(argv2, h2.deps));
  assert.equal(r2.exit, 0, r2.out + r2.err);
  assert.equal(readResults(h2.resultsDir).config?.fixture_server, false);

  // third leg: no caller on the records reads null; two models read mixed
  const h3b = harness(ENV_BASE, {}, { model: () => undefined });
  const r3 = await capture(() => runBench(ARGV, h3b.deps));
  assert.equal(r3.exit, 0, r3.out + r3.err);
  assert.equal(readResults(h3b.resultsDir).config?.caller_model, null);
  const h4 = harness(ENV_BASE, {}, { model: (n) => (n % 2 === 1 ? 'm-a' : 'm-b') });
  const r4 = await capture(() => runBench(ARGV, h4.deps));
  assert.equal(r4.exit, 0, r4.out + r4.err);
  assert.equal(readResults(h4.resultsDir).config?.caller_model, 'mixed:m-a|m-b');
});

// ---- 2 ----

test('r24b default stance: a bare launch is gate off and policy off (O6)', async () => {
  assert.equal(configJson.gate_off, true);
  assert.equal(configJson.policy_off, true);
  const c = await preflightConfig(ENV_BASE, ARGV);
  assert.equal(c.gate_mode, 'off');
  assert.equal(c.policy_mode, 'off');
  const m = await preflightConfig({ ...ENV_BASE, BENCH_MODEL: 'glm-5.3' }, ARGV);
  assert.equal(m.model, 'glm-5.3');
  assert.equal(m.gate_mode, 'off');
  assert.equal(m.policy_mode, 'off');
});

// ---- 3 ----

test('r24b stance env: opt-in works, the legacy names stay harmless, bad values are refused loudly', async () => {
  const on = await preflightConfig(ENV_ON, ARGV);
  assert.equal(on.gate_mode, 'confirm');
  assert.equal(on.policy_mode, 'enforce');
  assert.equal((on.wingman_config_sha256 as Record<string, string>).forced, '861ee3bf215152fb5c5f4815b697806ca5e4a72a54c569be8d310ac0306c2023');
  assert.deepEqual(await preflightConfig(ENV_LEGACY_OFF, ARGV), await preflightConfig(ENV_BASE, ARGV));
  await preflightConfig({ ...ENV_BASE, BENCH_GATE_OFF: '' }, ARGV);
  const bad: Array<[NodeJS.ProcessEnv, string]> = [
    [
      { ...ENV_BASE, BENCH_GATE_OFF: '0' },
      'BENCH-REFUSED: BENCH_GATE_OFF must be 1 or true when set (the default stance is already off; use BENCH_GATE_ON=1 to turn the gate on)',
    ],
    [{ ...ENV_BASE, BENCH_POLICY_ON: 'yes' }, 'BENCH-REFUSED: BENCH_POLICY_ON must be 1 or true when set'],
    [{ ...ENV_BASE, BENCH_GATE_ON: '1', BENCH_GATE_OFF: '1' }, 'BENCH-REFUSED: BENCH_GATE_ON and BENCH_GATE_OFF are both set'],
    [{ ...ENV_BASE, BENCH_POLICY_ON: 'true', BENCH_POLICY_OFF: 'true' }, 'BENCH-REFUSED: BENCH_POLICY_ON and BENCH_POLICY_OFF are both set'],
  ];
  for (const [env, line] of bad) {
    const h = harness(env);
    const r = await capture(() => runBench(ARGV, h.deps));
    assert.equal(r.exit, 2, line);
    assert.ok(r.err.includes(line), r.err);
    assert.equal(h.runCalls(), 0);
    assert.equal(resultsFiles(h.resultsDir).length, 0);
  }
});

// ---- 4 ----

test('r24b preflight: a stance mismatch against the baseline REFUSES before any cell', async () => {
  const b = writeBaseline(await preflightConfig(ENV_BASE, ARGV));
  const h = harness({ ...ENV_BASE, BENCH_GATE_ON: '1' });
  const r = await capture(() => runBench([...ARGV, '--baseline', b], h.deps));
  assert.equal(r.exit, 2, r.out + r.err);
  assert.ok(r.out.includes('BENCH-BASELINE: MISMATCH gate_mode baseline="off" run="confirm"'), r.out);
  assert.ok(r.out.split('\n').some((l) => l.startsWith('BENCH-BASELINE: MISMATCH wingman_config_sha256 baseline=')), r.out);
  assert.ok(r.out.includes('BENCH-REFUSED: baseline mismatch: 2 of 25 keys; nothing ran'), r.out);
  assert.equal(h.runCalls(), 0);
  assert.equal(h.prepares(), 0);
  assert.equal(resultsFiles(h.resultsDir).length, 0);

  const h2 = harness(ENV_ON);
  const r2 = await capture(() => runBench([...ARGV, '--baseline', b], h2.deps));
  assert.equal(r2.exit, 2, r2.out + r2.err);
  assert.ok(r2.out.includes('BENCH-REFUSED: baseline mismatch: 3 of 25 keys; nothing ran'), r2.out);
  assert.equal(h2.runCalls(), 0);
  assert.equal(h2.prepares(), 0);
  assert.equal(resultsFiles(h2.resultsDir).length, 0);

  for (const env of [ENV_BASE, ENV_LEGACY_OFF]) {
    const h3 = harness(env);
    const r3 = await capture(() => runBench([...ARGV, '--baseline', b], h3.deps));
    assert.equal(r3.exit, 0, r3.out + r3.err);
    assert.ok(r3.out.includes('BENCH-BASELINE: ok baseline=base.json keys=25 expected_diffs=none'), r3.out);
    assert.equal(h3.runCalls(), 2);
    assert.equal(resultsFiles(h3.resultsDir).length, 1);
  }
});

// ---- 5 ----

test('r24b preflight: --expect-diff must name exactly the keys that differ', async () => {
  const b = writeBaseline(await preflightConfig(ENV_BASE, ARGV));
  const run = async (extra: string[], env: NodeJS.ProcessEnv = ENV_BASE): Promise<{ r: Awaited<ReturnType<typeof capture>>; h: Harness }> => {
    const h = harness(env);
    const r = await capture(() => runBench([...ARGV, ...extra], h.deps));
    return { r, h };
  };
  {
    const { r, h } = await run(['--repeats', '2', '--baseline', b]);
    assert.equal(r.exit, 2, r.out + r.err);
    assert.ok(r.out.includes('BENCH-BASELINE: MISMATCH repeats baseline=1 run=2'), r.out);
    assert.ok(r.out.includes('BENCH-REFUSED: baseline mismatch: 1 of 25 keys; nothing ran'), r.out);
    assert.equal(h.runCalls(), 0);
  }
  {
    const { r } = await run(['--repeats', '2', '--baseline', b, '--expect-diff', 'repeats']);
    assert.equal(r.exit, 0, r.out + r.err);
    assert.ok(r.out.includes('BENCH-BASELINE: expected-diff repeats baseline=1 run=2'), r.out);
    assert.ok(r.out.includes('BENCH-BASELINE: ok baseline=base.json keys=25 expected_diffs=repeats'), r.out);
  }
  {
    const { r, h } = await run(['--repeats', '2', '--baseline', b, '--expect-diff', 'repeats,model']);
    assert.equal(r.exit, 2, r.out + r.err);
    assert.ok(r.out.includes('BENCH-BASELINE: EXPECTED-DIFF-ABSENT model value="sonnet"'), r.out);
    assert.ok(r.out.includes('BENCH-REFUSED: baseline mismatch: 1 of 25 keys; nothing ran'), r.out);
    assert.equal(h.runCalls(), 0);
  }
  {
    const { r, h } = await run(['--baseline', b, '--expect-diff', 'nope']);
    assert.equal(r.exit, 2);
    assert.ok(r.err.includes('BENCH-REFUSED: --expect-diff names unknown config key nope'), r.err);
    assert.equal(h.runCalls(), 0);
  }
  {
    const { r, h } = await run(['--expect-diff', 'repeats']);
    assert.equal(r.exit, 2);
    assert.ok(r.err.includes('BENCH-REFUSED: --expect-diff needs --baseline'), r.err);
    assert.equal(h.runCalls(), 0);
  }
  {
    // a listed POST key is not a pre-run absence
    const { r } = await run(['--baseline', b, '--expect-diff', 'caller_model', '--preflight-only']);
    assert.equal(r.exit, 0, r.out + r.err);
    const { r: r2, h: h2 } = await run(['--baseline', b, '--expect-diff', 'caller_model']);
    assert.equal(r2.exit, 4, r2.out + r2.err);
    assert.ok(r2.out.includes('BENCH-BASELINE-POST: EXPECTED-DIFF-ABSENT caller_model value="m-test"'), r2.out);
    assert.equal(h2.runCalls(), 1);
  }
});

// ---- 6 ----

test('r24b preflight: a results file without config refuses; one with config is a baseline', async () => {
  const dir = tmpDir('jevw-rc-old-');
  seedResults(dir, '2026-01-01-0000.json', 1);
  const h = harness(ENV_BASE);
  const r = await capture(() => runBench([...ARGV, '--baseline', path.join(dir, '2026-01-01-0000.json')], h.deps));
  assert.equal(r.exit, 2, r.out + r.err);
  assert.ok(
    r.out.includes(
      'BENCH-REFUSED: baseline 2026-01-01-0000.json has no config object (a results file written before r24b records none; use bench/baselines/<run>.json)',
    ),
    r.out,
  );
  assert.equal(h.runCalls(), 0);

  const first = harness(ENV_BASE);
  const r1 = await capture(() => runBench(ARGV, first.deps));
  assert.equal(r1.exit, 0, r1.out + r1.err);
  const firstName = resultsFiles(first.resultsDir)[0];
  const second = harness(ENV_BASE);
  const r2 = await capture(() => runBench([...ARGV, '--baseline', path.join(first.resultsDir, firstName)], second.deps));
  assert.equal(r2.exit, 0, r2.out + r2.err);
  assert.deepEqual(readResults(second.resultsDir).baseline, { file: firstName, expect_diff: [] });
});

// ---- 7 ----

test('r24b config: the hash recipes discriminate and match the spec values', () => {
  const FIXED: BenchAppConfig = {
    cli: 'claude',
    model: 'sonnet',
    per_run_timeout_ms: 600000,
    max_turns: 40,
    port: 9344,
    routes: ['playwright', 'forced'],
    repeats: 2,
    route_max_turns: { forced: 30 },
  };
  const off = { ...FIXED, gate_off: true, policy_off: true };
  assert.equal(wingmanConfigSha256(benchConfigText(off, null, 'forced')), '3735e56fd01871cc2bd3f077eeab00e90479a8607d2bee3506a64f6b7e0f076b');
  assert.equal(wingmanConfigSha256(benchConfigText(off, null, 'playwright')), '7db8441a1a4845f474b65b2705cec45a9965362b8886255c9dfb7a2bcb5cfc09');
  assert.equal(wingmanConfigSha256(benchConfigText(FIXED, null, 'forced')), '861ee3bf215152fb5c5f4815b697806ca5e4a72a54c569be8d310ac0306c2023');
  assert.equal(wingmanConfigSha256(benchConfigText(FIXED, null, 'playwright')), 'a0c39319db3ecde289054c8be00ea1a50c2b3199d8f3af828fbc540b2791f42a');

  const cfg = computeRunConfig(off, [], [], GIT, '9.9.9');
  assert.deepEqual(cfg.mcp_config_sha256, {
    playwright: 'cb482cf816c0f1258cbc35fef82623a5c4728bf34e82cb7f8282f95a25da73cb',
    wingman: 'eddf514350cbc4545142aa1d7f04bb33674285d2bdba66389ae7fe720efb3d33',
    browse: 'eddf514350cbc4545142aa1d7f04bb33674285d2bdba66389ae7fe720efb3d33',
    forced: 'b22a6bc6c776b6c57ee29e18f2223c80a1909a182c27a9b4a63189879ddfa44d',
  });
  assert.equal(cfg.log_labels, true);
  // the stripping is real: an extra Playwright arg hashes differently from the pinned value
  const ctx = {
    app: off,
    prices: {},
    home: '<HOME>',
    endpoint: '<ENDPOINT>',
    observer: {},
    keptTargetId: '<TARGET>',
    mainJsPath: '<MAIN>',
  } as unknown as RunContext;
  const mutated = mcpConfigFor(ctx, 'forced') as { mcpServers: Record<string, { args: string[]; env?: Record<string, string> }> };
  delete mutated.mcpServers['jev-browser-wingman']?.env?.WINGMAN_LOG_LABELS;
  assert.equal(sha256Hex(JSON.stringify(mutated)), cfg.mcp_config_sha256.forced);
  mutated.mcpServers.playwright.args.push('--foo');
  assert.notEqual(sha256Hex(JSON.stringify(mutated)), cfg.mcp_config_sha256.forced);

  assert.deepEqual(cfg.caller_argv_sha256, {
    playwright: 'fb2553ff594cb24e32364e7f352d5f3442c41821d3a064c67944cb3d56269095',
    wingman: '46ce0c33c213c3c255a087880ff2ec55792f947c935f6d114b1f697518c4138b',
    browse: '46ce0c33c213c3c255a087880ff2ec55792f947c935f6d114b1f697518c4138b',
    forced: 'd5106ff0065b9757d63a65894abc41508562f75bed6ff2fd630840cd7a6fe1cd',
  });
  assert.deepEqual(claudeArgv({ prompt: 'p', mcpConfigPath: 'm', allowedTools: ['a', 'b'], model: 'sonnet', maxTurns: 7 }), [
    '-p', 'p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-turns', '7',
    '--mcp-config', 'm', '--strict-mcp-config', '--allowedTools', 'a', 'b',
  ]);

  const withSecrets = wingmanConfigSha256(benchConfigText(off, 'C:/x/secrets.env', 'forced'));
  assert.notEqual(benchConfigText(off, 'C:/x/secrets.env', 'forced'), benchConfigText(off, null, 'forced'));
  assert.equal(withSecrets, wingmanConfigSha256(benchConfigText(off, null, 'forced')));

  const grown = JSON.parse(JSON.stringify(SERVED_TOOLS)) as Array<{ description: string }>;
  grown[2].description += 'x';
  assert.notEqual(toolTextSha256(grown), toolTextSha256());

  const mk = (files: Record<string, string>): Array<[string, string]> => {
    const d = tmpDir('jevw-rc-files-');
    return Object.entries(files).map(([label, content]) => {
      const abs = path.join(d, label.replace(/\//g, '_'));
      fs.writeFileSync(abs, content);
      return [label, abs];
    });
  };
  assert.equal(filesSha256(mk({ 'a.txt': 'x\r\ny\r\n' })), filesSha256(mk({ 'a.txt': 'x\ny\n' })));
  assert.notEqual(filesSha256(mk({ 'a.txt': 'x\ny\n' })), filesSha256(mk({ 'a.txt': 'x\ny\nz' })));
  assert.notEqual(filesSha256(mk({ 'a.txt': 'x\ny\n' })), filesSha256(mk({ 'b.txt': 'x\ny\n' })));
  assert.equal(canonicalJson({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
});

// ---- 8 ----

test('r24b config: the served tool list is the list tool_text_sha256 hashes', async () => {
  const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');
  const listFor = async (extra: Record<string, unknown>): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> => {
    const home = tmpDir('jevw-rc-mcp-');
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ adapter: 'playwright', window: 'headless', profile_dir: path.join(home, 'profile'), port: 9222, ...extra }),
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (['WINGMAN_HOME', 'WINGMAN_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL'].includes(k)) continue;
      env[k] = v;
    }
    env.WINGMAN_HOME = home;
    env.WINGMAN_CDP_ENDPOINT = 'http://127.0.0.1:9222';
    env.TYPESAFE_API_KEY = 'dummy-key';
    const transport = new StdioClientTransport({ command: process.execPath, args: [mainJs, 'mcp'], env });
    const client = new Client({ name: 'wingman-rc-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const res = await client.listTools();
      return res.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    } finally {
      await client.close();
    }
  };
  const shadow = await listFor({ mode: 'shadow', handoff: { mode: 'optional' } });
  assert.deepEqual(shadow, JSON.parse(JSON.stringify(SERVED_TOOLS)));
  const on = await listFor({ mode: 'on' });
  assert.deepEqual(on, [JSON.parse(JSON.stringify(SERVED_TOOLS))[2]]);
});

// ---- 9 ----

test('r24b baseline: bench/baselines/r23b.json carries every config key with a source', () => {
  const j = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'bench', 'baselines', 'r23b.json'), 'utf8')) as {
    config: Record<string, unknown>;
    sources: Record<string, unknown>;
    observed: Record<string, unknown>;
    observed_sources: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(j.config), SPEC_KEYS);
  assert.deepEqual(Object.keys(j.sources).sort(), [...SPEC_KEYS].sort());
  for (const v of Object.values(j.sources)) assert.ok(typeof v === 'string' && v.length > 0);
  assert.equal(j.config.gate_mode, 'off');
  assert.equal(j.config.policy_mode, 'off');
  assert.match(String(j.config.git_head), /^[0-9a-f]{40}$/);
  assert.equal(j.config.caller_cli_version, null);
  assert.equal(j.config.caller_model, null);
  assert.equal(j.config.log_labels, false);
  for (const k of ['mcp_config_sha256', 'caller_argv_sha256']) {
    assert.deepEqual(Object.keys(j.config[k] as object), ['playwright', 'wingman', 'browse', 'forced'], k);
  }
  assert.deepEqual(Object.keys(j.observed), [...OBSERVED_KEYS]);
  for (const v of Object.values(j.observed)) assert.equal(v, null);
  assert.deepEqual(Object.keys(j.observed_sources), [...OBSERVED_KEYS]);
  for (const v of Object.values(j.observed_sources)) assert.ok(typeof v === 'string' && v.length > 0);
});

// ---- 10 ----

test('r24b post-run check: the resolved model is compared right after the first cell (O4)', async () => {
  const pre = await preflightConfig(ENV_BASE, ARGV);
  {
    const b = writeBaseline(pre, { caller_model: 'm-A' });
    const h = harness(ENV_BASE, {}, { model: 'm-B' });
    const r = await capture(() => runBench([...ARGV, '--baseline', b], h.deps));
    assert.equal(r.exit, 4, r.out + r.err);
    assert.ok(r.out.includes('BENCH-BASELINE: ok baseline=base.json keys=25 expected_diffs=none'), r.out);
    assert.ok(r.out.includes('BENCH-BASELINE-POST: MISMATCH caller_model baseline="m-A" run="m-B"'), r.out);
    assert.ok(r.out.includes('BENCH-ABORTED: baseline mismatch: 1 of 1 keys after 1 run(s)'), r.out);
    assert.equal(h.runCalls(), 1);
    assert.equal(resultsFiles(h.resultsDir).length, 1);
    const res = readResults(h.resultsDir);
    assert.equal(res.aborted, 'error');
    assert.equal(res.runs.length, 1);
    assert.equal(res.config?.caller_model, 'm-B');
  }
  {
    const b = writeBaseline(pre, { caller_model: 'm-A' });
    const h = harness(ENV_BASE, {}, { model: 'm-B' });
    const r = await capture(() => runBench([...ARGV, '--baseline', b, '--expect-diff', 'caller_model'], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(h.runCalls(), 2);
    assert.ok(r.out.includes('BENCH-BASELINE-POST: expected-diff caller_model baseline="m-A" run="m-B"'), r.out);
    assert.ok(r.out.includes('BENCH-BASELINE-POST: ok baseline=base.json keys=1 expected_diffs=caller_model'), r.out);
  }
  {
    const b = writeBaseline(pre, { caller_model: 'm-B' });
    const h = harness(ENV_BASE, {}, { model: 'm-B' });
    const r = await capture(() => runBench([...ARGV, '--baseline', b, '--expect-diff', 'caller_model'], h.deps));
    assert.equal(r.exit, 4, r.out + r.err);
    assert.ok(r.out.includes('BENCH-BASELINE-POST: EXPECTED-DIFF-ABSENT caller_model value="m-B"'), r.out);
  }
  {
    const b = writeBaseline(pre, { caller_model: null });
    const h = harness(ENV_BASE, {}, { model: () => undefined });
    const r = await capture(() => runBench([...ARGV, '--baseline', b], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    const h2 = harness(ENV_BASE, {}, { model: () => undefined });
    const r2 = await capture(() => runBench([...ARGV, '--baseline', b, '--expect-diff', 'caller_model'], h2.deps));
    assert.equal(r2.exit, 4, r2.out + r2.err);
    assert.ok(r2.out.includes('EXPECTED-DIFF-ABSENT caller_model value=null'), r2.out);
  }
});

// ---- 11 ----

test('r24b measured runs need a baseline (O3)', async () => {
  const noPurpose = ARGV.slice(0, -2);
  const refusal =
    'BENCH-REFUSED: --purpose measure needs --baseline <file> (a measured run must name the run it is comparable to; use --purpose experiment for an unbaselined run)';
  {
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(noPurpose, h.deps));
    assert.equal(r.exit, 2, r.out + r.err);
    assert.ok(r.err.includes(refusal), r.err);
    assert.equal(h.runCalls(), 0);
    assert.equal(resultsFiles(h.resultsDir).length, 0);
  }
  {
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench([...noPurpose, '--purpose', 'measure', '--preflight-only'], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
  }
  for (const purpose of ['cap-proof', 'experiment']) {
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench([...noPurpose, '--purpose', purpose], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(resultsFiles(h.resultsDir).length, 1);
  }
  {
    const b = writeBaseline(await preflightConfig(ENV_BASE, ARGV));
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench([...noPurpose, '--purpose', 'measure', '--baseline', b], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    const res = readResults(h.resultsDir);
    assert.equal(res.purpose, 'measure');
    assert.ok(res.baseline);
  }
  {
    const h = harness(ENV_BASE, { callerVersion: () => null });
    const r = await capture(() => runBench(ARGV, h.deps));
    assert.equal(r.exit, 2, r.out + r.err);
    assert.ok(r.err.includes('BENCH-REFUSED: caller CLI version unreadable (claude --version failed or printed no version)'), r.err);
  }
});

// ---- 12 ----

const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  model: 'fake-model',
  claude_code_version: '9.9.9',
  tools: ['Bash', 'Read', 'mcp__x__y'],
  skills: ['s1'],
  agents: ['a1'],
  plugins: [{ name: 'p1', version: '1.0', path: 'C:\\secret' }],
  mcp_servers: [{ name: 'x', status: 'connected' }],
};

test('r24b caller identity: pure helpers and the real spawn paths (O4)', async () => {
  assert.equal(parseCallerVersion('2.1.291 (Claude Code)'), '2.1.291');
  assert.equal(parseCallerVersion(''), null);
  assert.equal(parseCallerVersion('no version'), null);
  assert.equal(callerModelOf([]), null);
  assert.equal(callerModelOf([null, undefined, '']), null);
  assert.equal(callerModelOf(['b', 'a', 'a']), 'mixed:a|b');
  assert.equal(callerModelOf(['a', 'a']), 'a');
  assert.deepEqual(initFromEvent({ type: 'system', subtype: 'init', model: 'swe-2-max', claude_code_version: '2.1.284', tools: [] }), {
    claude_code_version: '2.1.284',
    model: 'swe-2-max',
  });
  for (const e of [{ type: 'system', subtype: 'hook_started' }, { type: 'assistant' }, null, 'x']) {
    assert.equal(initFromEvent(e), null);
  }
  assert.deepEqual(initFromEvent({ type: 'system', subtype: 'init', model: 7 }), { claude_code_version: null, model: null });

  // wiring through a fake `claude` on PATH
  const dir = tmpDir('jevw-rc-fake-');
  const script = [
    "const a = process.argv.slice(2);",
    "if (a.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }",
    `console.log(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }))});`,
    `console.log(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }))});`,
    `console.log(${JSON.stringify(JSON.stringify(INIT_EVENT))});`,
    `console.log(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'PostToolUse:Bash' }))});`,
    `console.log(${JSON.stringify(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001 }))});`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'fake-claude.js'), script);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n', { mode: 0o755 });
  }
  const savedPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + (savedPath ?? '');
  try {
    assert.equal(readCallerVersion(), '9.9.9');
    const res = await runClaude({
      prompt: 'x',
      mcpConfigPath: 'm.json',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 1,
      timeoutMs: 30000,
      cwd: dir,
    });
    assert.deepEqual(res.init, { claude_code_version: '9.9.9', model: 'fake-model' });
    assert.deepEqual(res.lists, LISTS);
    assert.equal(JSON.stringify(res.lists).includes('secret'), false);
    assert.equal(res.killed, false);
  } finally {
    process.env.PATH = savedPath;
  }
});

// ---- 13 ----

test('r24b observed environment: Node and Chrome versions are recorded and compared as WARNINGS (O7)', async () => {
  const pre = await preflightConfig(ENV_BASE, ARGV);
  const argvFor = (b: string): string[] => [...ARGV, '--baseline', b];
  {
    const b = writeBaseline(pre, {}, OBS_EQ);
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(argvFor(b), h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(h.runCalls(), 2);
    assert.ok(r.out.includes('BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)'), r.out);
    assert.equal(r.out.includes('BENCH-OBSERVED-WARN'), false);
  }
  {
    const b = writeBaseline(pre, {}, { ...OBS_EQ, node_version: 'v20.0.0' });
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(argvFor(b), h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(h.runCalls(), 2);
    assert.ok(r.out.includes('BENCH-OBSERVED-WARN: observed node_version baseline="v20.0.0" run="v22.1.0"'), r.out);
    assert.ok(r.out.includes('warnings=1'), r.out);
  }
  {
    const b = writeBaseline(pre);
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(argvFor(b), h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(h.runCalls(), 2);
    const warns = r.out.split('\n').filter((l) => l.startsWith('BENCH-OBSERVED-WARN'));
    assert.equal(warns.length, 8, r.out);
    for (const w of warns) assert.ok(w.includes('baseline=<unrecorded>'), w);
    assert.ok(warns.some((w) => w.includes('observed caller_tools_sha256[forced]')));
    assert.ok(r.out.includes('warnings=8'), r.out);
  }
  {
    const b = writeBaseline(pre, {}, OBS_EQ);
    const h = harness(ENV_BASE, { chromeVersion: async () => null });
    const r = await capture(() => runBench(argvFor(b), h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.ok(r.out.includes('BENCH-OBSERVED-WARN: observed chrome_version baseline="Chrome/130.0.1" run=null'), r.out);
    assert.equal(readResults(h.resultsDir).observed?.chrome_version, null);
  }
  {
    const allX = {
      node_version: 'x',
      chrome_version: 'x',
      caller_tools_sha256: { forced: 'x' },
      caller_skills_sha256: { forced: 'x' },
      caller_plugins_sha256: { forced: 'x' },
      caller_agents_sha256: { forced: 'x' },
      caller_mcp_servers_sha256: { forced: 'x' },
      caller_hooks_sha256: { forced: 'x' },
    };
    const b = writeBaseline(pre, {}, allX);
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(argvFor(b), h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(h.runCalls(), 2);
  }
  {
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(ARGV, h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.equal(r.out.includes('BENCH-OBSERVED'), false);
    const res = readResults(h.resultsDir);
    assert.equal(res.observed?.node_version, 'v22.1.0');
    assert.equal(res.observed?.chrome_version, 'Chrome/130.0.1');
  }
  {
    const b = writeBaseline(pre, {}, { ...OBS_EQ, node_version: 'v20.0.0' });
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench([...argvFor(b), '--preflight-only'], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    const iWarn = r.out.indexOf('BENCH-OBSERVED-WARN: observed node_version');
    const iSum = r.out.indexOf('BENCH-OBSERVED: warnings=1 (preflight sees the Node version only; warnings never block)');
    const iPre = r.out.indexOf('BENCH-PREFLIGHT: ok nothing ran config=');
    assert.ok(iWarn >= 0 && iWarn < iSum && iSum < iPre, r.out);
  }
});

// ---- 14 ----

test("r24b observed environment: the caller's init lists are hashed, listed once, stripped from run records and compared as WARNINGS (O7)", async () => {
  const pre = await preflightConfig(ENV_BASE, ARGV);
  {
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench(ARGV, h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    const res = readResults(h.resultsDir);
    const o = res.observed as unknown as Record<string, unknown>;
    assert.deepEqual(o.caller_tools_sha256, { forced: listSha256(LISTS.tools) });
    assert.deepEqual(o.caller_skills_sha256, { forced: listSha256(LISTS.skills) });
    assert.deepEqual(o.caller_plugins_sha256, { forced: listSha256(LISTS.plugins) });
    assert.deepEqual(o.caller_agents_sha256, { forced: listSha256(LISTS.agents) });
    assert.deepEqual(o.caller_mcp_servers_sha256, { forced: listSha256(LISTS.mcp_servers) });
    assert.deepEqual(o.caller_hooks_sha256, { forced: listSha256(LISTS.hooks) });
    assert.deepEqual(res.observed_lists, { forced: callerListSummaries(LISTS) });
    for (const run of res.runs) {
      assert.ok(run.caller?.lists_sha256);
      assert.equal('lists' in (run.caller ?? {}), false);
    }
  }
  {
    const b = writeBaseline(pre, {}, OBS_EQ);
    const h = harness(ENV_BASE, {}, {
      lists: (n) => (n === 2 ? { ...LISTS, tools: ['Bash', 'Read', 'other'] } : LISTS),
    });
    const r = await capture(() => runBench([...ARGV, '--baseline', b], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    const res = readResults(h.resultsDir);
    const o = res.observed as unknown as Record<string, unknown>;
    assert.deepEqual(o.caller_tools_sha256, { forced: 'mixed' });
    assert.ok(r.out.includes('BENCH-OBSERVED-WARN: observed caller_tools_sha256[forced] mixed across runs'), r.out);
    assert.deepEqual(res.observed_lists, { forced: callerListSummaries(LISTS) });
  }
  {
    const b = writeBaseline(pre, { routes: ['forced'] }, OBS_EQ);
    const h = harness(ENV_BASE, {}, {
      lists: (_n, route) => (route === 'playwright' ? { ...LISTS, tools: ['Bash', 'Read'] } : LISTS),
    });
    const r = await capture(() =>
      runBench([...ARGV.map((a) => (a === 'forced' ? 'playwright,forced' : a)), '--baseline', b, '--expect-diff', 'routes'], h.deps),
    );
    assert.equal(r.exit, 0, r.out + r.err);
    const res = readResults(h.resultsDir);
    const tools = (res.observed as unknown as Record<string, Record<string, string>>).caller_tools_sha256;
    assert.deepEqual(Object.keys(tools).sort(), ['forced', 'playwright']);
    assert.notEqual(tools.forced, 'mixed');
    assert.notEqual(tools.playwright, 'mixed');
    assert.equal(r.out.includes('mixed across runs'), false);
  }
  {
    const b = writeBaseline(pre, {}, { ...OBS_EQ, caller_skills_sha256: { forced: 'zz' } });
    const h = harness(ENV_BASE);
    const r = await capture(() => runBench([...ARGV, '--baseline', b], h.deps));
    assert.equal(r.exit, 0, r.out + r.err);
    assert.ok(
      r.out.includes(`BENCH-OBSERVED-WARN: observed caller_skills_sha256[forced] baseline="zz" run="${listSha256(LISTS.skills)}"`),
      r.out,
    );
  }
});

// ---- 15 ----

test('r24b observed environment: pure helpers (O7)', () => {
  assert.equal(listSha256(['b', 'a']), listSha256(['a', 'b']));
  assert.notEqual(listSha256(['b', 'a']), listSha256(['a']));
  assert.deepEqual(Object.keys(callerListHashes(LISTS)).sort(), [...LIST_NAMES].sort());
  assert.deepEqual(
    mergeListHashes([{ route: 'forced', hashes: { tools: 'h1' } }, { route: 'forced', hashes: { tools: 'h1' } }]),
    { caller_tools_sha256: { forced: 'h1' } },
  );
  assert.deepEqual(
    mergeListHashes([{ route: 'forced', hashes: { tools: 'h1' } }, { route: 'forced', hashes: { tools: 'h2' } }]),
    { caller_tools_sha256: { forced: 'mixed' } },
  );
  assert.deepEqual(
    mergeListHashes([{ route: 'forced', hashes: { tools: 'h1' } }, { route: 'playwright', hashes: { tools: 'h2' } }]),
    { caller_tools_sha256: { forced: 'h1', playwright: 'h2' } },
  );
  assert.deepEqual(mergeListHashes([]), {});
  assert.deepEqual(mergeListHashes([{ route: 'forced', hashes: undefined }]), {});

  assert.deepEqual(compareObserved(emptyObserved(), null, ['node_version']), [
    'BENCH-OBSERVED-WARN: observed node_version baseline=<unrecorded> run=null',
  ]);
  const eq = { ...emptyObserved(), node_version: 'v1' };
  assert.deepEqual(compareObserved(eq, { node_version: 'v1' }, ['node_version']), []);
  assert.deepEqual(compareObserved(eq, { node_version: null }, ['node_version']), [
    'BENCH-OBSERVED-WARN: observed node_version baseline=<unrecorded> run="v1"',
  ]);
  const lists = { ...emptyObserved(), caller_tools_sha256: { forced: 'a', playwright: 'b' } };
  const only = compareObserved(lists, null, ['caller_tools_sha256'], 'forced');
  assert.equal(only.length, 1);
  assert.ok(only[0].includes('caller_tools_sha256[forced]'));

  assert.deepEqual(listsFromInit(INIT_EVENT), { ...LISTS, hooks: [] });
  const p = listsFromInit({ type: 'system', subtype: 'init', plugins: [{ name: 'solo' }, { version: '1' }] });
  assert.deepEqual(p?.plugins, ['solo']);
  assert.equal(listsFromInit({ type: 'assistant' }), null);
  assert.equal(listsFromInit(null), null);
  assert.equal(hookNameFromEvent({ type: 'system', subtype: 'hook_started', hook_name: 'X' }), 'X');
  assert.equal(hookNameFromEvent(INIT_EVENT), null);
  assert.equal(hookNameFromEvent(null), null);
  assert.equal(hookNameFromEvent({ type: 'system', subtype: 'hook_started' }), null);
});

// ---- 16 (spec section 16 amendment) ----

test('r24b amendment: the pushed results JSON carries hashes and counts only; the names go to a separate local file', async () => {
  const h = harness(ENV_BASE);
  const r = await capture(() => runBench(ARGV, h.deps));
  assert.equal(r.exit, 0, r.out + r.err);
  const names = resultsFiles(h.resultsDir);
  assert.equal(names.length, 1);
  const text = fs.readFileSync(path.join(h.resultsDir, names[0]), 'utf8');
  const res = JSON.parse(text) as BenchResultsFile;
  // hashes + counts, per route and list
  assert.deepEqual(res.observed_lists, { forced: callerListSummaries(LISTS) });
  assert.equal(res.observed_lists?.forced.tools.count, LISTS.tools.length);
  // no name array anywhere under observed_lists, and no list name anywhere in the results text
  const walk = (v: unknown): void => {
    assert.equal(Array.isArray(v), false, 'observed_lists holds no array');
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(res.observed_lists);
  for (const n of ['mcp__x__y', 'SessionStart:startup', 'p1@1.0', 'x:connected']) {
    assert.equal(text.includes(n), false, `results JSON leaks list name ${n}`);
  }
  for (const run of res.runs) assert.equal('lists' in (run.caller ?? {}), false);
  // the names live in the local sibling file
  const local = listsFiles(h.resultsDir);
  assert.deepEqual(local, [observedListsFileName(names[0])]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.resultsDir, local[0]), 'utf8')), { forced: LISTS });
  // no cell produced lists: no sibling file, observed_lists null
  const h2 = harness(ENV_BASE, {}, { lists: () => null });
  const r2 = await capture(() => runBench(ARGV, h2.deps));
  assert.equal(r2.exit, 0, r2.out + r2.err);
  assert.equal(readResults(h2.resultsDir).observed_lists, null);
  assert.equal(listsFiles(h2.resultsDir).length, 0);
});
