// WP-T3: the bench front-door route (`browse`), the gate/policy stance
// injection flags, and the `experiment` purpose. These drive the real
// `runBench`, the real prompt builder and the real config renderer with a
// fake runner (the `bench-cap.test.ts` style); the live OG-9 run itself is
// operator-gated and never run by a builder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runBench,
  buildPrompt,
  benchConfigText,
  allowedToolsFor,
  mcpConfigFor,
  type BenchAppConfig,
  type BenchDeps,
  type BenchRoute,
  type BenchRunRecord,
  type BenchTask,
  type RunContext,
} from '../bench/run.js';
import type { BenchPrices } from '../bench/cap.js';
import type { CdpConnection } from '../src/adapters/cdp-connection.js';

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

test('browse route prompt carries no routing rules', () => {
  const browse = buildPrompt(TASK, 'browse');
  const playwright = buildPrompt(TASK, 'playwright');
  assert.equal(browse, playwright);
  assert.ok(!browse.toLowerCase().includes('wingman'));
  assert.ok(!browse.includes('ROUTING RULES'));
});

test('browse route allows the wingman tools', () => {
  assert.deepEqual(allowedToolsFor('browse'), ['mcp__playwright', 'mcp__jev-browser-wingman']);
});

test('browse route mcp config registers the wingman server', () => {
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
  assert.equal(wingman.env.WINGMAN_HOME, home);
  assert.equal(wingman.env.WINGMAN_CDP_ENDPOINT, endpoint);
  assert.ok(cfg.mcpServers['playwright'], 'playwright server missing from the browse mcp config');
});

test('benchConfigText emits gate off and policy off only when the flags are set', () => {
  const on = JSON.parse(
    benchConfigText({ ...BASE_APP, gate_off: true, policy_off: true }, null),
  ) as Record<string, unknown>;
  assert.deepEqual(on.gate, { mode: 'off' });
  assert.deepEqual(on.policy, { mode: 'off' });
  const off = JSON.parse(benchConfigText({ ...BASE_APP }, null)) as Record<string, unknown>;
  assert.equal(Object.hasOwn(off, 'gate'), false);
  assert.equal(Object.hasOwn(off, 'policy'), false);
});

test('--routes browse runs only the browse route', async () => {
  const resDir = tmpDir('jevw-browse-routes-');
  const pricesPath = writePrices(tmpDir('jevw-browse-prices-'));
  const runner = recordingRunner();
  const { exit, err } = await capture(() =>
    runBench(
      ['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain', '--routes', 'browse'],
      baseDeps(resDir, pricesPath, runner.runOne),
    ),
  );
  assert.equal(err, '');
  assert.equal(exit, 0);
  assert.deepEqual(runner.routes, ['browse']);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as {
    runs: Array<{ route: BenchRoute }>;
  };
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].route, 'browse');
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
