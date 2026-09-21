// WP-H: spend-cap enforcement tests. These drive the real `runBench` with a
// fake runner; the live USD 0.01 abort-proof run itself is operator-gated
// (OG-6 step 2) and never run by a builder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { BenchRoute } from '../bench/run.js';
import os from 'node:os';
import path from 'node:path';
import { runBench, type BenchDeps, type BenchRunRecord } from '../bench/run.js';

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

function fakeRunner(usdPerRun: number): { runOne: BenchDeps['runOne']; calls: () => number } {
  let calls = 0;
  return {
    runOne: async (task, route) => {
      calls += 1;
      return { record: fakeRecord(task, route, usdPerRun), usd: usdPerRun };
    },
    calls: () => calls,
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

async function capture(
  fn: () => Promise<number>,
): Promise<{ exit: number; out: string; err: string }> {
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

test('refuses without a cap', async () => {
  const resDir = tmpDir('jevw-cap-refuse-');
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--phase-cap-usd', '10'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 2);
  assert.match(out, /BENCH-REFUSED: --cap-usd is required/);
  assert.equal(runner.calls(), 0);
  assert.equal(resultsFiles(resDir).length, 0);
});

test('refuses a cap above the operator ceiling', async () => {
  const resDir = tmpDir('jevw-cap-ceiling-');
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--cap-usd', '6', '--phase-cap-usd', '20'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 2);
  assert.match(out, /BENCH-REFUSED: cap above operator ceiling \(5 per run, 30 per phase\)/);
  assert.equal(runner.calls(), 0);
});

test('refuses without prices', async () => {
  const resDir = tmpDir('jevw-cap-noprices-');
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '10'], baseDeps(resDir, path.join(tmpDir('jevw-cap-empty-'), 'absent.json'), runner.runOne)),
  );
  assert.equal(exit, 2);
  assert.match(out, /BENCH-REFUSED: bench\/prices\.json missing or incomplete/);
  assert.equal(runner.calls(), 0);
});

test('refuses when the phase cap is already spent', async () => {
  const resDir = tmpDir('jevw-cap-spent-');
  seedResults(resDir, '2026-01-01-0000.json', 10);
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '10'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 2);
  assert.match(out, /BENCH-REFUSED: phase cap reached \(spent 10\.00 of 10\.00\)/);
  assert.equal(runner.calls(), 0);
});

test('a 0.01 cap stops after the first run', async () => {
  const resDir = tmpDir('jevw-cap-abort-');
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--cap-usd', '0.01', '--phase-cap-usd', '10'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 3);
  assert.match(out, /BENCH-ABORTED: cap reached after 1 runs/);
  assert.equal(runner.calls(), 1);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as {
    aborted: unknown;
    runs: unknown[];
  };
  assert.equal(parsed.aborted, 'cap');
  assert.equal(parsed.runs.length, 1);
});

test('a harness without the abort check would run all 27', async () => {
  // Known-bad proof: with the abort check stubbed out, the identical fake
  // runner runs all 9 tasks x 3 routes, so the previous test discriminates.
  const resDir = tmpDir('jevw-cap-nobad-');
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const deps = baseDeps(resDir, pricesPath, runner.runOne) as BenchDeps;
  deps.shouldAbort = () => false;
  const { exit } = await capture(() => runBench(['--cap-usd', '0.01', '--phase-cap-usd', '10'], deps));
  assert.equal(exit, 0);
  assert.equal(runner.calls(), 27);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as { aborted: unknown; runs: unknown[] };
  assert.equal(parsed.aborted, null);
  assert.equal(parsed.runs.length, 27);
});

test('the phase cap counts earlier results files', async () => {
  const resDir = tmpDir('jevw-cap-earlier-');
  seedResults(resDir, '2026-01-01-0000.json', 9.99);
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const { exit, out } = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '10'], baseDeps(resDir, pricesPath, runner.runOne)),
  );
  assert.equal(exit, 3);
  assert.match(out, /BENCH-ABORTED: cap reached after 1 runs/);
  assert.equal(runner.calls(), 1);
});

test('BENCH_MODEL overrides the configured caller model', async () => {
  const resDir = tmpDir('jevw-cap-model-');
  const pricesPath = writePrices(tmpDir('jevw-cap-prices-'));
  const runner = fakeRunner(0.02);
  const deps = baseDeps(resDir, pricesPath, runner.runOne) as BenchDeps;
  deps.env = { TYPESAFE_API_KEY: 'bench-test-key', BENCH_MODEL: 'glm-5.3' };
  const { exit } = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '10', '--tasks', 't9-long-chain'], deps),
  );
  assert.equal(exit, 0);
  assert.equal(runner.calls(), 3);
  const files = resultsFiles(resDir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(resDir, files[0]), 'utf8')) as { model: string };
  assert.equal(parsed.model, 'glm-5.3');
});
