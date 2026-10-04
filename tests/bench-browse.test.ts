// WP-T3: the bench front-door route (`browse`) and the gate/policy stance
// injection flags. WP-F (2026-09-26 forced-handoff spec) adds the `forced`
// route, transcript capture, per-run handoff records, the raw-act/script
// derivation, `--repeats`, and the `forced-verdict` tool. These drive the real
// `runBench`, the real prompt builder and the real config renderer with a
// fake runner (the `bench-cap.test.ts` style); the live OG-9 run itself is
// operator-gated and never run by a builder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runBench,
  buildPrompt,
  BROWSE_ENGAGEMENT_LINE,
  FORCED_ENGAGEMENT_LINE,
  benchConfigText,
  allowedToolsFor,
  mcpConfigFor,
  transcriptPathFor,
  maxTurnsFor,
  handoffRecordsFromLog,
  firstInvalidRun,
  deriveRawCounts,
  freshLogSlice,
  summarizePairs,
  type BenchAppConfig,
  type BenchDeps,
  type BenchResultsFile,
  type BenchRoute,
  type BenchRunRecord,
  type BenchTask,
  type HandoffRecord,
  type RunContext,
} from '../bench/run.js';
import { tallyToolUse } from '../bench/claude-run.js';
import { forcedVerdict } from '../bench/forced-verdict.js';
import { loadProfiles } from '../src/core/profiles.js';
import { packageRoot } from '../src/package-root.js';
import type { BenchPrices } from '../bench/cap.js';
import type { CdpConnection } from '../src/adapters/cdp-connection.js';

const ROOT = packageRoot();

const PRICES: BenchPrices = {
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

const TASK: BenchTask = {
  id: 't9-long-chain',
  path: '/login',
  goal: 'Log in and reach the secure area',
  values: { username: 'tomsmith' },
  oracle: 'h1=Secure Area',
};

const BASE_APP: BenchAppConfig = {
  cli: 'claude',
  model: 'sonnet',
  per_run_timeout_ms: 240000,
  max_turns: 25,
  port: 9344,
  routes: ['playwright', 'wingman', 'browse'],
  repeats: 1,
};

function fakeRecord(task: BenchTask, route: BenchRoute, usd: number): BenchRunRecord {
  return {
    task: task.id,
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

function recordingRunner(): { runOne: BenchDeps['runOne']; routes: BenchRoute[] } {
  const routes: BenchRoute[] = [];
  return {
    runOne: async (task, route) => {
      routes.push(route);
      return { record: fakeRecord(task, route, 0.02), usd: 0.02 };
    },
    routes,
  };
}

function baseDeps(resultsDir: string, pricesPath: string, runOne: BenchDeps['runOne']): Partial<BenchDeps> {
  return {
    runOne,
    prepareBrowser: async () => {},
    stopBrowser: async () => {},
    resultsDir,
    pricesPath,
    env: { TYPESAFE_API_KEY: 'bench-test-key' },
  };
}

async function capture(fn: () => Promise<number>): Promise<{ exit: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).stdout.write = (s: unknown) => {
    outChunks.push(String(s));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).stderr.write = (s: unknown) => {
    errChunks.push(String(s));
    return true;
  };
  try {
    const exit = await fn();
    return { exit, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function resultsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
}

test('both routes carry the task goal verbatim in the prompt', () => {
  for (const route of ['playwright', 'wingman', 'browse'] as BenchRoute[]) {
    const prompt = buildPrompt(TASK, route);
    assert.ok(prompt.includes(TASK.goal), `task goal missing from the ${route} prompt`);
  }
});

test('browse route prompt carries the engagement line, not the wingman routing rules', () => {
  const browse = buildPrompt(TASK, 'browse');
  const playwright = buildPrompt(TASK, 'playwright');
  // 2026-09-21 (operator): browse is no longer route-identical to playwright —
  // it carries exactly one engagement line before the goal so the route
  // measures usage-when-engaged. The wingman route's ROUTING RULES block is
  // still forbidden here.
  assert.notEqual(browse, playwright);
  assert.ok(browse.includes(BROWSE_ENGAGEMENT_LINE), 'engagement line missing from the browse prompt');
  const goalIdx = browse.indexOf(TASK.goal);
  const engageIdx = browse.indexOf(BROWSE_ENGAGEMENT_LINE);
  assert.ok(engageIdx !== -1 && goalIdx !== -1 && engageIdx < goalIdx, 'engagement line must precede the goal');
  assert.ok(!browse.includes('ROUTING RULES'));
  assert.ok(!browse.includes('wingman_do'));
  assert.ok(!playwright.toLowerCase().includes('wingman'));
  // the goal itself stays verbatim
  assert.ok(browse.includes(TASK.goal));
});

test('forced route prompt carries the literal engagement line before the goal', () => {
  const forced = buildPrompt(TASK, 'forced');
  const playwright = buildPrompt(TASK, 'playwright');
  assert.notEqual(forced, playwright);
  assert.ok(forced.includes(FORCED_ENGAGEMENT_LINE), 'forced engagement line missing from the forced prompt');
  assert.equal(FORCED_ENGAGEMENT_LINE, FORCED_ENGAGEMENT_LINE.trim());
  const goalIdx = forced.indexOf(TASK.goal);
  const engageIdx = forced.indexOf(FORCED_ENGAGEMENT_LINE);
  assert.ok(engageIdx !== -1 && goalIdx !== -1 && engageIdx < goalIdx, 'engagement line must precede the goal');
  assert.ok(!forced.includes('ROUTING RULES'));
  assert.ok(!forced.includes('wingman_do'));
  assert.ok(forced.includes(TASK.goal));
});

test('r22 F-3: the forced engagement line carries the post-action exception (inline spec text, not a constant mirror)', () => {
  // Spec .build-r22-spec.md F-3, inlined per the spec-of-record rule: the
  // engagement line's "call it again with the same arguments" recovery must
  // except the post-action note's "only the steps after this one" recovery,
  // or the two lines hand the caller contradictory instructions. Single-line
  // ASCII (the win32 cmd spawn constraint), em-dashes folded to hyphens.
  const FORCED_ENGAGEMENT_LINE_SPEC =
    'For this browsing task, hand the page work to the wingman browse_step tool: pass the goal, the ordered list of remaining steps in steps, and every URL and text it needs in values; if it returns a step to you, call it again with pick naming the element by role and name, and when a call ends unfinished, call it again with the same arguments. If a result\'s note says the step\'s action already ran, send only the steps after that one instead.';
  assert.equal(FORCED_ENGAGEMENT_LINE, FORCED_ENGAGEMENT_LINE_SPEC);
  assert.equal(FORCED_ENGAGEMENT_LINE_SPEC, FORCED_ENGAGEMENT_LINE_SPEC.trim());
  assert.ok(!/[‘’“”–—]/.test(FORCED_ENGAGEMENT_LINE_SPEC), 'single-line ASCII: no curly quotes or dashes');
});

test('browse route allows the wingman tools', () => {
  assert.deepEqual(allowedToolsFor('browse'), ['mcp__playwright', 'mcp__jev-browser-wingman']);
});

test('forced route allows the wingman tools (the non-playwright rule, unchanged)', () => {
  assert.deepEqual(allowedToolsFor('forced'), ['mcp__playwright', 'mcp__jev-browser-wingman']);
});

test('browse route mcp config registers the wingman server with its fixed env', () => {
  const home = tmpDir('jevw-browse-home-');
  const endpoint = 'http://127.0.0.1:9344';
  const ctx: RunContext = {
    app: BASE_APP,
    prices: {} as BenchPrices,
    home,
    endpoint,
    observer: {} as CdpConnection,
    keptTargetId: 'target-1',
    mainJsPath: path.join('dist', 'src', 'cli', 'main.js'),
  };
  const cfg = mcpConfigFor(ctx, 'browse') as {
    mcpServers: Record<string, { env: Record<string, string> }>;
  };
  const wingman = cfg.mcpServers['jev-browser-wingman'];
  assert.ok(wingman, 'jev-browser-wingman server missing from the browse mcp config');
  assert.deepEqual(wingman.env, { WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: endpoint });
  assert.ok(cfg.mcpServers['playwright'], 'playwright server missing from the browse mcp config');
});

test('forced route mcp config has the exact wrapped shape', () => {
  const home = tmpDir('jevw-forced-home-');
  const endpoint = 'http://127.0.0.1:9344';
  const mainJs = path.join('dist', 'src', 'cli', 'main.js');
  const ctx: RunContext = {
    app: BASE_APP,
    prices: {} as BenchPrices,
    home,
    endpoint,
    observer: {} as CdpConnection,
    keptTargetId: 'target-1',
    mainJsPath: mainJs,
  };
  assert.deepEqual(mcpConfigFor(ctx, 'forced'), {
    mcpServers: {
      playwright: {
        command: 'node',
        args: [mainJs, 'with-browser', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
        env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint, WINGMAN_HOME: home },
      },
      'jev-browser-wingman': {
        command: 'node',
        args: [mainJs, 'mcp'],
        env: { WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: endpoint },
      },
    },
  });
});

test('non-forced routes keep the plain playwright registration', () => {
  const home = tmpDir('jevw-plain-home-');
  const endpoint = 'http://127.0.0.1:9344';
  const ctx: RunContext = {
    app: BASE_APP,
    prices: {} as BenchPrices,
    home,
    endpoint,
    observer: {} as CdpConnection,
    keptTargetId: 'target-1',
    mainJsPath: 'main.js',
  };
  for (const route of ['playwright', 'wingman', 'browse'] as BenchRoute[]) {
    const cfg = mcpConfigFor(ctx, route) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(cfg.mcpServers['playwright'], {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint },
    });
  }
});

test('transcript capture paths: wingman routes record one, playwright records none', () => {
  const home = tmpDir('jevw-transcript-home-');
  for (const route of ['wingman', 'browse', 'forced'] as BenchRoute[]) {
    const p = transcriptPathFor(home, TASK.id, route);
    assert.ok(p, `${route} must record a transcript path`);
    assert.ok(p.startsWith(home + path.sep), `${route} transcript must live under the bench home`);
    assert.match(path.basename(p), new RegExp(`^transcript-${TASK.id}-${route}-\\d+\\.ndjson$`));
  }
  assert.equal(transcriptPathFor(home, TASK.id, 'playwright'), null);
});

test('benchConfigText always writes gate and policy explicitly, and handoff per route', () => {
  // Phase-S smoke cell: BENCH_GATE_OFF unset → gate confirm written explicitly.
  const smoke = JSON.parse(benchConfigText({ ...BASE_APP }, null)) as Record<string, unknown>;
  assert.deepEqual(smoke.gate, { mode: 'confirm' });
  assert.deepEqual(smoke.policy, { mode: 'enforce' });
  assert.deepEqual(smoke.handoff, { mode: 'optional', tools: 'all', retain: [] });
  // Off stance: both keys still written, now as off.
  const offs = JSON.parse(benchConfigText({ ...BASE_APP, gate_off: true, policy_off: true }, null)) as Record<string, unknown>;
  assert.deepEqual(offs.gate, { mode: 'off' });
  assert.deepEqual(offs.policy, { mode: 'off' });
  assert.deepEqual(offs.handoff, { mode: 'optional', tools: 'all', retain: [] });
  // The forced route writes the forced/browse-only handoff.
  const forced = JSON.parse(benchConfigText({ ...BASE_APP }, null, 'forced')) as Record<string, unknown>;
  assert.deepEqual(forced.gate, { mode: 'confirm' });
  assert.deepEqual(forced.handoff, { mode: 'forced', tools: 'browse-only', retain: [] });
  const forcedOff = JSON.parse(benchConfigText({ ...BASE_APP, gate_off: true, policy_off: true }, null, 'forced')) as Record<string, unknown>;
  assert.deepEqual(forcedOff.gate, { mode: 'off' });
  assert.deepEqual(forcedOff.handoff, { mode: 'forced', tools: 'browse-only', retain: [] });
});

test('maxTurnsFor uses the per-route override, else the configured max', () => {
  const app: BenchAppConfig = { ...BASE_APP, route_max_turns: { forced: 30 } };
  assert.equal(maxTurnsFor(app, 'forced'), 30);
  assert.equal(maxTurnsFor(app, 'browse'), BASE_APP.max_turns);
  assert.equal(maxTurnsFor(app, 'wingman'), BASE_APP.max_turns);
  assert.equal(maxTurnsFor(app, 'playwright'), BASE_APP.max_turns);
  assert.equal(maxTurnsFor(BASE_APP, 'forced'), BASE_APP.max_turns);
});

test('committed bench/config.json keeps its routes and carries route_max_turns.forced', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'config.json'), 'utf8')) as BenchAppConfig;
  assert.deepEqual(cfg.routes, ['playwright', 'wingman', 'browse']);
  assert.deepEqual(cfg.route_max_turns, { forced: 30 });
});

test('--repeats runs a route more than once; out-of-range values are refused', async () => {
  const resDir = tmpDir('jevw-repeats-ok-');
  const pricesPath = writePrices(tmpDir('jevw-repeats-prices-'));
  const runner = recordingRunner();
  const { exit, err } = await capture(() =>
    runBench(
      ['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain', '--routes', 'forced', '--repeats', '2'],
      baseDeps(resDir, pricesPath, runner.runOne),
    ),
  );
  assert.equal(err, '');
  assert.equal(exit, 0);
  assert.deepEqual(runner.routes, ['forced', 'forced']);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as { runs: Array<{ route: BenchRoute }> };
  assert.equal(parsed.runs.length, 2);

  for (const bad of ['0', '6', 'x']) {
    const resDir2 = tmpDir('jevw-repeats-bad-');
    const runner2 = recordingRunner();
    const { exit: exit2, err: err2 } = await capture(() =>
      runBench(
        ['--cap-usd', '5', '--phase-cap-usd', '10', '--routes', 'forced', '--repeats', bad],
        baseDeps(resDir2, writePrices(tmpDir('jevw-repeats-prices-bad-')), runner2.runOne),
      ),
    );
    assert.equal(exit2, 2, `--repeats ${bad} must be refused`);
    assert.match(err2, new RegExp(`BENCH-REFUSED: --repeats`));
    assert.equal(runner2.routes.length, 0);
  }
});

// --- forced-verdict ---------------------------------------------------------

interface SynthRun {
  route: BenchRoute;
  ok: boolean;
  handoffs: number;
  picks: number;
  wingman_acts: number;
  raw_acts: number;
  raw_script: number;
  handoff_records: Array<Partial<HandoffRecord>>;
}

function synthRuns(over: Partial<Record<BenchRoute, Partial<SynthRun>>> = {}): { runs: BenchRunRecord[] } {
  const f = { ...({ route: 'forced', ok: true, handoffs: 4, picks: 1, wingman_acts: 40, raw_acts: 0, raw_script: 2 } as Partial<SynthRun>), ...(over.forced ?? {}) };
  const p = { ...({ route: 'playwright', ok: false, handoffs: 0, picks: 0, wingman_acts: 0, raw_acts: 0, raw_script: 0 } as Partial<SynthRun>), ...(over.playwright ?? {}) };
  const toRecord = (s: Partial<SynthRun>): BenchRunRecord => ({
    ...fakeRecord(TASK, s.route as BenchRoute, 0.02),
    ok: s.ok ?? true,
    handoffs: s.handoffs,
    picks: s.picks,
    wingman_acts: s.wingman_acts,
    raw_acts: s.raw_acts,
    raw_script: s.raw_script,
    handoff_records: s.handoff_records,
  });
  const forcedRecords: Array<Partial<HandoffRecord>> = f.handoff_records ?? [
    { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
    { status: 'done', reason: 'goal-met', steps: 4, rounds: 4, pick: true, progress: { step_index: 1, steps_done: 1, steps_total: 4 } },
    { status: 'done', reason: 'goal-met', steps: 5, rounds: 5 },
    { status: 'done', reason: 'goal-met', steps: 3, rounds: 3 },
  ];
  // `handoffs` derives from the (possibly overridden) records' length unless
  // the caller names `handoffs` explicitly — the defaults object's own 4
  // must not shadow a handoff_records-only override (e.g. the `handoffs`
  // flip case, which supplies 5 records and no explicit `handoffs`).
  const forcedRun = {
    ...f,
    handoff_records: forcedRecords,
    ok: f.ok === undefined ? true : f.ok,
    handoffs: over.forced?.handoffs ?? forcedRecords.length,
  };
  // Both playwright cells share the override's `ok` (else the default split
  // 0/2 done, 1/2 ok, matching the 3/3-forced healthy baseline below).
  const overridePlaywrightOk = over.playwright?.ok;
  const plays: boolean[] = overridePlaywrightOk === undefined ? [false, true] : [overridePlaywrightOk, overridePlaywrightOk];
  const runs: BenchRunRecord[] = [];
  for (let i = 0; i < 3; i++) runs.push(toRecord(forcedRun)); // three forced cells
  for (const ok of plays) runs.push(toRecord({ ...p, ok }));
  return { runs };
}

test('forcedVerdict: a healthy forced file passes every line and overall', () => {
  const v = forcedVerdict(synthRuns());
  assert.equal(v.pass, true, `expected PASS, failures: ${v.failures.join(',')}`);
  assert.deepEqual(v.failures, []);
  assert.ok(v.lines.every((l) => l.startsWith('FORCED-VERDICT: ')), 'every line carries the prefix');
  assert.ok(v.lines.some((l) => /^FORCED-VERDICT: completion forced=3\/3 playwright=1\/2$/.test(l)), v.lines.join('\n'));
  assert.ok(v.lines.some((l) => /^FORCED-VERDICT: wingman-share 1\.00$/.test(l)), v.lines.join('\n'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: raw-acts 0'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: handoffs max=4'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: picks 3/12'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: zero-step-done 0'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: first-call-success 3/3'));
  assert.ok(v.lines.some((l) => /^FORCED-VERDICT: median-steps 4(\.0+)?$/.test(l)), v.lines.join('\n'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: no-page-error-end 0'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: raw-script 6'));
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: overall PASS'));
});

test('forcedVerdict: each flipped line fails on its own and drags overall', () => {
  const cases: Array<[string, { runs: BenchRunRecord[] }]> = [
    ['completion', synthRuns({ playwright: { ok: true }, forced: { ok: false } })], // 0/1 < 2/2
    ['wingman-share', synthRuns({ forced: { wingman_acts: 4, raw_acts: 96 } })], // 0.04 < 0.90
    ['raw-acts', synthRuns({ forced: { raw_acts: 1 } })],
    ['handoffs', synthRuns({ forced: { handoff_records: [
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
    ] } })], // 5 handoffs > 4
    ['picks', synthRuns({ forced: { picks: 3 } })], // 2*3 !< 4
    // A lone zero-step "done" among otherwise-healthy steps (4,4,5) keeps the
    // aggregate median at the 4 boundary (still PASS) so only this line trips.
    ['zero-step-done', synthRuns({ forced: { picks: 0, handoff_records: [
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 5, rounds: 5 },
      { status: 'done', reason: 'goal-met', steps: 0, rounds: 1 },
    ] } })],
    ['first-call-success', synthRuns({ forced: { handoff_records: [
      { status: 'error', reason: 'invalid-input', steps: 0, rounds: 0 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
    ] } })],
    ['median-steps', synthRuns({ forced: { handoff_records: [
      { status: 'done', reason: 'goal-met', steps: 3, rounds: 3 },
      { status: 'done', reason: 'goal-met', steps: 3, rounds: 3 },
      { status: 'done', reason: 'goal-met', steps: 3, rounds: 3 },
      { status: 'done', reason: 'goal-met', steps: 3, rounds: 3 },
    ] } })], // median 3 < 4 (KB-Fb: passes at a threshold of 2, so the pin discriminates)
    ['no-page-error-end', synthRuns({ forced: { handoff_records: [
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
      { status: 'error', reason: 'page-error', steps: 2, rounds: 2 },
    ] } })],
  ];
  for (const [name, file] of cases) {
    const v = forcedVerdict(file);
    assert.equal(v.pass, false, `${name} flip must FAIL overall`);
    // The wingman-share flip (share < 0.90) necessarily carries raw_acts > 0,
    // so raw-acts trips alongside it; every other line flips alone.
    if (name === 'wingman-share') {
      assert.deepEqual(v.failures, ['wingman-share', 'raw-acts']);
    } else {
      assert.deepEqual(v.failures, [name], `${name} flip must name exactly that line`);
    }
    assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: overall FAIL'), `${name}: overall line`);
  }
});

test('forcedVerdict: wingman-share with a zero denominator FAILs', () => {
  const v = forcedVerdict(synthRuns({ forced: { wingman_acts: 0, raw_acts: 0 } }));
  assert.equal(v.pass, false);
  assert.deepEqual(v.failures, ['wingman-share']);
});

test('forcedVerdict: validity mode requires b >= 2 and m >= 3', () => {
  const good = forcedVerdict(
    { runs: [1, 2, 3].map(() => ({ ...fakeRecord(TASK, 'playwright', 0.02), ok: true })) },
    'validity',
  );
  assert.equal(good.pass, true);
  assert.deepEqual(good.failures, []);
  assert.ok(good.lines.some((l) => l === 'FORCED-VERDICT: validity playwright=3/3'), good.lines.join('\n'));
  const thin = forcedVerdict(
    { runs: [{ ...fakeRecord(TASK, 'playwright', 0.02), ok: true }, { ...fakeRecord(TASK, 'playwright', 0.02), ok: false }] },
    'validity',
  );
  assert.equal(thin.pass, false); // m=2 < 3
  assert.deepEqual(thin.failures, ['validity']);
  const weak = forcedVerdict(
    { runs: [1, 2, 3].map(() => ({ ...fakeRecord(TASK, 'playwright', 0.02), ok: false })) },
    'validity',
  );
  assert.equal(weak.pass, false); // b=0 < 2
});

test('forcedVerdict: smoke mode is informational and reports needs_confirmation', () => {
  // synthRuns applies the override identically to all three forced cells
  // (§ 6 WP-F: three forced bench cells), so one needs_confirmation record
  // per cell totals 3, not 1.
  const v = forcedVerdict(synthRuns({ forced: { handoff_records: [
    { status: 'needs_confirmation', reason: 'irreversible-heuristic', steps: 2, rounds: 2 },
    { status: 'done', reason: 'goal-met', steps: 4, rounds: 4 },
  ] } }), 'smoke');
  assert.equal(v.pass, true);
  assert.deepEqual(v.failures, []);
  assert.ok(v.lines.some((l) => l === 'FORCED-VERDICT: smoke ok=true needs_confirmation=3'), v.lines.join('\n'));
});

// --- log-to-records parser --------------------------------------------------

test('handoffRecordsFromLog parses browse_step lines only, with rounds and progress', () => {
  const lines = [
    JSON.stringify({ ts: 't1', tool: 'browse_step', status: 'error', reason: 'invalid-input', steps: 0, phases: { rounds: [] } }),
    'not json at all',
    JSON.stringify({ ts: 't2', tool: 'browse_step', status: 'done', reason: 'goal-met', steps: 4, pick: true, progress: { step_index: 1, steps_done: 1, steps_total: 4 }, phases: { rounds: [{}, {}, {}] } }),
    JSON.stringify({ ts: 't3', tool: 'wingman_do', status: 'done', reason: 'goal-met', steps: 3 }),
    JSON.stringify({ ts: 't4', tool: 'browse_step', status: 'needs_confirmation', reason: 'irreversible-heuristic', steps: 2 }),
    JSON.stringify({ ts: 't5', tool: 'browse_step', status: 'error', reason: 'invalid-input', steps: 0 }),
  ];
  const recs = handoffRecordsFromLog(lines);
  assert.equal(recs.length, 4);
  assert.deepEqual(
    recs.map((r) => [r.status, r.reason, r.steps, r.rounds]),
    [
      ['error', 'invalid-input', 0, 0],
      ['done', 'goal-met', 4, 3],
      ['needs_confirmation', 'irreversible-heuristic', 2, 0],
      ['error', 'invalid-input', 0, 0],
    ],
  );
  assert.equal(recs[1].pick, true);
  assert.deepEqual(recs[1].progress, { step_index: 1, steps_done: 1, steps_total: 4 });
  // first_call_invalid: only the LEADING run of invalid-input records counts.
  assert.equal(firstInvalidRun(recs), 1);
});

// --- r19 WP-4: the log slice fix (spec D-5/C2) and the M-2 summary fields (D9)

test('freshLogSlice slices bytes, not characters; the old string-slice form is pinned broken', () => {
  // The C2 shape: a U+2026 (3 UTF-8 bytes, 1 UTF-16 code unit) in the log's
  // prefix — exactly what a t9 goal clause quoting "…after the fact…" puts
  // there. `before` is a statSync().size BYTE count.
  const prefix = 'pre…fix\n';
  const record = JSON.stringify({
    ts: 't1',
    tool: 'browse_step',
    status: 'done',
    reason: 'goal-met',
    steps: 2,
    phases: { rounds: [{}, {}] },
  });
  const buf = Buffer.from(prefix + record + '\n', 'utf8');
  const before = Buffer.byteLength(prefix, 'utf8');
  assert.ok(before > prefix.length, 'precondition: the prefix must hold multi-byte UTF-8');
  const fromBuffer = handoffRecordsFromLog(freshLogSlice(buf, before).split('\n'));
  assert.equal(fromBuffer.length, 1, 'the byte-sliced fresh region must parse as exactly 1 handoff record');
  assert.equal(fromBuffer[0].status, 'done');
  assert.equal(fromBuffer[0].reason, 'goal-met');
  assert.equal(fromBuffer[0].rounds, 2);
  // The documented-bad contrast, pinned literally (spec WP-4 pin a): the old
  // form slices the DECODED string by the byte count, cutting 2 characters
  // into the fresh region, so the first fresh line loses its head,
  // JSON.parse fails, and the record is silently skipped (0 counted from a
  // 1-call cell). This assertion cannot regress without failing here.
  const fromString = handoffRecordsFromLog(buf.toString('utf8').slice(before).split('\n'));
  assert.equal(fromString.length, 0, 'the old string-slice form must stay broken — it is WHY the fix exists');
});

test('run.ts reads the fresh log tail as a Buffer subarray, never a decoded-string slice', () => {
  // Source-shape pin (spec WP-4 pin b): the tripwire for a revert to
  // string-slice. Red against the pre-fix source by construction.
  const src = fs.readFileSync(path.join(ROOT, 'bench', 'run.ts'), 'utf8');
  assert.ok(src.includes('readFileSync(logPath), before)'), 'the freshLogSlice buffer call is missing from the read path');
  assert.ok(!src.includes("readFileSync(logPath, 'utf8').slice("), 'revert to string-slice detected in the fresh-log read');
});

test('summarizePairs aggregates per task x route with n/ok/wall spread/median usd', () => {
  const run = (over: Partial<BenchRunRecord>): BenchRunRecord => ({
    ...fakeRecord(TASK, 'forced', 0.02),
    ...over,
  });
  const pairs = summarizePairs([
    run({ task: 't9-long-chain', route: 'forced', ok: true, wall_ms: 300, usd: 0.04 }),
    run({ task: 't9-long-chain', route: 'browse', ok: false, wall_ms: 200, usd: 0.03 }),
    run({ task: 't9-long-chain', route: 'forced', ok: true, wall_ms: 100, usd: 0.02 }),
  ]);
  assert.deepEqual(pairs, {
    't9-long-chain': {
      forced: { n: 2, ok: 2, wall_min_ms: 100, wall_med_ms: 200, wall_max_ms: 300, median_usd: 0.03 },
      browse: { n: 1, ok: 0, wall_min_ms: 200, wall_med_ms: 200, wall_max_ms: 200, median_usd: 0.03 },
    },
  });
});

test('the results file carries wall min/max on the route summary and task_pairs beside it', async () => {
  const resDir = tmpDir('jevw-pairs-ok-');
  const pricesPath = writePrices(tmpDir('jevw-pairs-prices-'));
  const walls = [100, 300];
  let call = 0;
  const runOne: BenchDeps['runOne'] = async (task, route) => {
    const wall = walls[Math.min(call, walls.length - 1)];
    call += 1;
    return { record: { ...fakeRecord(task, route, 0.02), wall_ms: wall }, usd: 0.02 };
  };
  const { exit, err } = await capture(() =>
    runBench(
      ['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain', '--routes', 'forced', '--repeats', '2'],
      baseDeps(resDir, pricesPath, runOne),
    ),
  );
  assert.equal(err, '');
  assert.equal(exit, 0);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as BenchResultsFile;
  assert.equal(parsed.summary.forced?.wall_min_ms, 100);
  assert.equal(parsed.summary.forced?.wall_max_ms, 300);
  assert.deepEqual(parsed.task_pairs?.['t9-long-chain']?.forced, {
    n: 2,
    ok: 2,
    wall_min_ms: 100,
    wall_med_ms: 200,
    wall_max_ms: 300,
    median_usd: 0.02,
  });
});

// --- tool_use tallying and the raw derivation -------------------------------

test('tallyToolUse counts every tool_use block by name and ignores other events', () => {
  const counts: Record<string, number> = {};
  tallyToolUse(
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__playwright__browser_click' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'mcp__jev-browser-wingman__browse_step' }] } },
    counts,
  );
  tallyToolUse({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__playwright__browser_snapshot' }] } }, counts);
  tallyToolUse({ type: 'result', usage: {} }, counts);
  tallyToolUse(null, counts);
  assert.deepEqual(counts, {
    mcp__playwright__browser_click: 1,
    'mcp__jev-browser-wingman__browse_step': 1,
    mcp__playwright__browser_snapshot: 1,
  });
});

test('raw_acts/raw_script derive from the playwright profile and the withheld set', () => {
  const profiles = loadProfiles(tmpDir('jevw-raw-profiles-'));
  const playwright = profiles.find((p) => p.id === 'playwright-mcp');
  assert.ok(playwright, 'shipped playwright-mcp profile not found');
  // Spec example: raw_acts 3 (click, type, navigate), raw_script 1 (evaluate).
  const counts = {
    browser_click: 1,
    browser_type: 1,
    browser_navigate: 1,
    browser_snapshot: 2,
    browser_evaluate: 1,
    browser_tabs: 1,
  };
  assert.deepEqual(deriveRawCounts(counts, playwright), { raw_acts: 3, raw_script: 1 });
  // Prefixed (transcript-shaped) names normalize to the same counts.
  const prefixed: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) prefixed[`mcp__playwright__${k}`] = v;
  assert.deepEqual(deriveRawCounts(prefixed, playwright), { raw_acts: 3, raw_script: 1 });
  assert.deepEqual(deriveRawCounts(prefixed, null), { raw_acts: 0, raw_script: 0 });
});

// --- cloud wrapper and src hygiene ------------------------------------------

test('chromium-wrapper.sh is the cloud-only recipe; ignore-certificate-errors never enters src', () => {
  const text = fs.readFileSync(path.join(ROOT, 'bench', 'cloud', 'chromium-wrapper.sh'), 'utf8');
  assert.match(text, /^#!\/bin\/sh/);
  assert.match(text, /--ignore-certificate-errors/);
  assert.match(text, /setpriv/);
  assert.match(text, /REAL_CHROMIUM/);
  assert.match(text, /--user-data-dir=/);
  assert.match(text, /nobody/);
  assert.match(text, /never.*product|product.*never/s, 'header must state it is never product code');
  const grep = spawnSync('git', ['grep', '-n', 'ignore-certificate-errors', '--', 'src'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(grep.status, 1, `git grep found matches in src:\n${grep.stdout}`);
  assert.equal(grep.stdout, '');
});

// WP-E deleted the WINGMAN_BROWSE_ONLY env switch from src/ entirely; the
// bench's browse/forced routes configure handoff through the wingman config
// (handoff: { mode, tools }, § 5.3/§ 5.10) that mcpConfigFor/benchConfigText
// write, never through that env var. This pins its absence from the tracked
// bench sources so a reintroduction fails here, not just at the gate's grep.
test('WINGMAN_BROWSE_ONLY never re-enters the tracked bench sources', () => {
  const grep = spawnSync('git', ['grep', '-n', 'WINGMAN_BROWSE_ONLY', '--', 'bench'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(grep.status, 1, `git grep found matches in bench:\n${grep.stdout}`);
  assert.equal(grep.stdout, '');
});

test('--routes forced runs only the forced route', async () => {
  const resDir = tmpDir('jevw-forced-routes-');
  const pricesPath = writePrices(tmpDir('jevw-forced-prices-'));
  const runner = recordingRunner();
  const { exit, err } = await capture(() =>
    runBench(
      ['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain', '--routes', 'forced'],
      baseDeps(resDir, pricesPath, runner.runOne),
    ),
  );
  assert.equal(err, '');
  assert.equal(exit, 0);
  assert.deepEqual(runner.routes, ['forced']);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as {
    runs: Array<{ route: BenchRoute }>;
    harness_version: number;
  };
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].route, 'forced');
  assert.equal(parsed.harness_version, 3);
});

test('an unknown --routes value is refused with exit 2', async () => {
  const resDir = tmpDir('jevw-browse-badroute-');
  const pricesPath = writePrices(tmpDir('jevw-browse-prices-bad-'));
  const runner = recordingRunner();
  const { exit, err } = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '10', '--routes', 'nope'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 2);
  assert.match(err, /BENCH-REFUSED: unknown route nope/);
  assert.equal(runner.routes.length, 0);
  assert.equal(resultsFiles(resDir).length, 0);
});

test('purpose experiment is accepted', async () => {
  const resDir = tmpDir('jevw-browse-purpose-');
  const pricesPath = writePrices(tmpDir('jevw-browse-prices-exp-'));
  const runner = recordingRunner();
  const { exit, err } = await capture(() =>
    runBench(
      ['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain', '--routes', 'browse', '--purpose', 'experiment'],
      baseDeps(resDir, pricesPath, runner.runOne),
    ),
  );
  assert.equal(err, '');
  assert.equal(exit, 0);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as { purpose: string };
  assert.equal(parsed.purpose, 'experiment');
});
