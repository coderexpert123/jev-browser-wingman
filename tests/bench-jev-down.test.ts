// r24d item 1: the bench stops when the decision service is dead. Two seams are driven here.
//  - producer -> detector: a REAL wingman (the built MCP server, real loop, real log.jsonl) against a stub Jev that answers
//    HTTP 402, whose real log lines feed `jevDownCell` (the rule that marks a cell `jev_down`);
//  - detector -> consumer: the real `runBench` loop over cells carrying that flag (fake runner, as bench-cap does).
// `bench/run.ts` is imported as a namespace and the new symbols are read off it at run time, so against the pre-change
// build every test fails at its own assertion instead of the file failing to compile.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as benchRun from '../bench/run.js';
import { runBench, type BenchDeps, type BenchRoute, type BenchRunRecord } from '../bench/run.js';
import { launchTestChrome } from './helpers/chrome.js';
import { fillDefaultAnswers, startTypeSafeStub } from './helpers/typesafe-stub.js';
import { startFixtureServer } from '../src/fixture-server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jevDownCell = (lines: string[]): boolean => (benchRun as any).jevDownCell(lines) as boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const streakLimit = (): unknown => (benchRun as any).JEV_DOWN_STREAK;

const mainJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

const PRICES = {
  llm: { sonnet: { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 } },
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

function resultsFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
}

async function capture(fn: () => Promise<number>): Promise<{ exit: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  // Pass-through filter (tests/CLAUDE.md: a sink would drop the runner's TAP lines): only bench output is swallowed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).stdout.write = (s: unknown, ...rest: unknown[]) => {
    if (typeof s === 'string' && /^(BENCH-|jev-browser-wingman bench)/.test(s)) {
      outChunks.push(s);
      return true;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origOut as any).call(process.stdout, s, ...rest);
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

function baseDeps(resultsDir: string, pricesPath: string, runOne: BenchDeps['runOne']): Partial<BenchDeps> {
  return {
    runOne,
    prepareBrowser: async () => {},
    stopBrowser: async () => {},
    resultsDir,
    pricesPath,
    env: { TYPESAFE_API_KEY: 'bench-test-key' },
    callerVersion: () => '9.9.9',
    gitInfo: () => ({ head: 'a'.repeat(40), dirty: false }),
  };
}

const CELL_USD = 0.05;

function cell(task: object, route: BenchRoute, down: boolean): BenchRunRecord {
  const t = task as { id: string };
  const rec: BenchRunRecord = {
    task: t.id,
    route,
    ok: !down,
    wall_ms: 100,
    browser_tool_calls: 1,
    per_step_ms: 100,
    llm: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, cli_reported_usd: null },
    typesafe: { calls: route === 'playwright' ? 0 : 3, input_tokens: down ? 0 : 3000, output_tokens: down ? 0 : 900, usd: 0 },
    wingman: route === 'playwright' ? { calls: 0, fallback: 0, needs_confirmation: 0 } : { calls: 3, fallback: down ? 3 : 0, needs_confirmation: 0 },
    usd: CELL_USD,
  };
  // The flag is only ever set by the producer on wingman-route cells that read down (see defaultRunOne).
  return down && route !== 'playwright' ? ({ ...rec, jev_down: true } as BenchRunRecord) : rec; // cast: the field does not exist before r24d
}

/** A fake runner over the real route interleave (playwright, forced per task): the n-th FORCED cell is down when downAt(n). */
function runnerWhere(downAt: (forcedIndex: number) => boolean): { runOne: BenchDeps['runOne']; calls: () => number } {
  let calls = 0;
  let forced = 0;
  return {
    runOne: async (task, route) => {
      calls += 1;
      const down = route === 'forced' ? downAt(forced++) : false;
      return { record: cell(task, route, down), usd: CELL_USD };
    },
    calls: () => calls,
  };
}

const ARGV = ['--cap-usd', '5', '--phase-cap-usd', '10', '--purpose', 'experiment', '--routes', 'playwright,forced'];

function readResults(dir: string): { aborted: unknown; total_usd: number; runs: Array<{ route: string; jev_down?: unknown }> } {
  const files = resultsFiles(dir);
  assert.equal(files.length, 1, 'exactly one results file');
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

// ---- detector -> consumer: the runBench loop ----------------------------------------------------------------------

test('r24d: consecutive down wingman cells stop the run with exit 5, aborted jev-down, and the spend still lands', async () => {
  assert.equal(streakLimit(), 3, 'the streak limit is the pinned smallest rule');
  const resDir = tmpDir('jevw-down-abort-');
  const pricesPath = writePrices(tmpDir('jevw-down-prices-'));
  const runner = runnerWhere(() => true);
  const { exit, out } = await capture(() => runBench(ARGV, baseDeps(resDir, pricesPath, runner.runOne)));
  assert.equal(exit, 5, out);
  assert.match(out, /BENCH-ABORTED: decision service down after 6 runs/);
  // playwright cells interleave and neither count nor reset the streak: 3 forced cells = 6 runs, not 34.
  assert.equal(runner.calls(), 6);
  const file = readResults(resDir);
  assert.equal(file.aborted, 'jev-down');
  assert.equal(file.runs.length, 6);
  assert.equal(file.runs.filter((r) => r.jev_down === true).length, 3);
  assert.equal(Math.round(file.total_usd * 1e6), Math.round(6 * CELL_USD * 1e6), 'already-spent USD is in the results file');
  // The ledger counts it: the same phase authority is now spent, so a second launch refuses.
  const again = runnerWhere(() => false);
  const second = await capture(() =>
    runBench(['--cap-usd', '5', '--phase-cap-usd', '0.3', '--purpose', 'experiment'], baseDeps(resDir, pricesPath, again.runOne)),
  );
  assert.equal(second.exit, 2);
  assert.match(second.out, /BENCH-REFUSED: phase cap reached/);
  assert.equal(again.calls(), 0);
});

test('r24d: a single transient down cell among healthy cells never aborts', async () => {
  const resDir = tmpDir('jevw-down-transient-');
  const pricesPath = writePrices(tmpDir('jevw-down-prices-'));
  const runner = runnerWhere((n) => n === 4);
  const { exit, out } = await capture(() => runBench(ARGV, baseDeps(resDir, pricesPath, runner.runOne)));
  assert.equal(exit, 0, out);
  assert.doesNotMatch(out, /decision service down/);
  assert.equal(runner.calls(), 34);
  const file = readResults(resDir);
  assert.equal(file.aborted, null);
  assert.equal(file.runs.filter((r) => r.jev_down === true).length, 1);
});

test('r24d: runs of down cells shorter than the streak, separated by healthy cells, never abort', async () => {
  const resDir = tmpDir('jevw-down-pairs-');
  const pricesPath = writePrices(tmpDir('jevw-down-prices-'));
  // forced index 0,1 down; 2 healthy; 3,4 down; 5 healthy; ... (never 3 in a row)
  const runner = runnerWhere((n) => n % 3 !== 2);
  const { exit, out } = await capture(() => runBench(ARGV, baseDeps(resDir, pricesPath, runner.runOne)));
  assert.equal(exit, 0, out);
  assert.equal(runner.calls(), 34);
  assert.equal(readResults(resDir).aborted, null);
});

test('r24d: the abort fires on the third consecutive down cell, not before and not only at the end', async () => {
  const resDir = tmpDir('jevw-down-late-');
  const pricesPath = writePrices(tmpDir('jevw-down-prices-'));
  // healthy for forced 0..3, then the service dies: 4,5,6 down -> stop after forced cell 6 (7 forced + 7 playwright = 14 runs)
  const runner = runnerWhere((n) => n >= 4);
  const { exit, out } = await capture(() => runBench(ARGV, baseDeps(resDir, pricesPath, runner.runOne)));
  assert.equal(exit, 5, out);
  assert.match(out, /after 14 runs/);
  assert.equal(runner.calls(), 14);
  assert.equal(readResults(resDir).aborted, 'jev-down');
});

// ---- producer -> detector: a real wingman against a stub Jev -----------------------------------------------------------

let chrome: Awaited<ReturnType<typeof launchTestChrome>>;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

test.before(async () => {
  chrome = await launchTestChrome({ headless: true });
  fixture = await startFixtureServer();
});

test.after(async () => {
  await fixture.close();
  await chrome.close();
});

function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (['WINGMAN_HOME', 'WINGMAN_CDP_ENDPOINT', 'PLAYWRIGHT_MCP_CDP_ENDPOINT', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL'].includes(k)) continue;
    env[k] = v;
  }
  return env;
}

async function openFixturePage(name: string): Promise<string> {
  const res = await fetch(`${chrome.endpoint}/json/new?${fixture.url}/${name}.html`, { method: 'PUT' });
  const info = (await res.json()) as { id: string };
  const deadline = Date.now() + 10_000;
  for (;;) {
    const list = (await (await fetch(`${chrome.endpoint}/json/list`)).json()) as Array<{ id: string; url: string; title: string }>;
    const t = list.find((p) => p.id === info.id);
    if ((t && t.url.startsWith(`${fixture.url}/${name}.html`) && t.title !== '') || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return info.id;
}

/** One real wingman server on a temp home pointed at `stubUrl`; `step()` calls browse_step and returns the home's whole log. */
async function withWingman(stubUrl: string, body: (step: () => Promise<string[]>) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-jevdown-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ mode: 'on', adapter: 'cdp', window: 'headless', profile_dir: path.join(home, 'profile'), port: chrome.port }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mainJs, 'mcp'],
    env: { ...scrubEnv(), WINGMAN_HOME: home, WINGMAN_CDP_ENDPOINT: chrome.endpoint, TYPESAFE_API_KEY: 'dummy-key', TYPESAFE_BASE_URL: stubUrl },
  });
  const client = new Client({ name: 'bench-jev-down', version: '0.0.0' });
  await client.connect(transport);
  const pageId = await openFixturePage('chain-index');
  try {
    await body(async () => {
      await client.callTool({ name: 'browse_step', arguments: { goal: 'r24d jev-down probe', steps: ['click the Checkboxes link'], url_match: 'chain-index.html' } });
      return fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    });
  } finally {
    await client.close();
    await fetch(`${chrome.endpoint}/json/close/${pageId}`).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function healthyAnswers(q: Record<string, { type: string; criteria?: Record<string, unknown> }>): Record<string, unknown> {
  const explicit: Record<string, unknown> = {};
  for (const k of ['done', 'right_page', 'ready', 'step_done']) if (k in q) explicit[k] = { type: 'noul', noul: 0.95 };
  return fillDefaultAnswers(q, explicit);
}

test('r24d: a real wingman against a stub Jev that answers 402 produces log lines that read as a down cell', { timeout: 120_000 }, async () => {
  const stub = await startTypeSafeStub(() => ({ status: 402, body: { error: 'payment required' } }));
  try {
    await withWingman(stub.url, async (step) => {
      const lines = await step();
      const rec = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      // sanity on the producer's real shape: the exact pair the rule keys on
      assert.equal(rec.status, 'fallback');
      assert.equal(rec.reason, 'jev-error');
      assert.equal(rec.input_tokens, 0);
      assert.equal(rec.output_tokens, 0);
      assert.ok(stub.requests.length >= 1, 'the stub was reached');
      assert.equal(jevDownCell(lines), true);
    });
  } finally {
    await stub.close();
  }
});

test('r24d: one 402 followed by a healthy call in the same cell is not a down cell', { timeout: 120_000 }, async () => {
  let n = 0;
  const stub = await startTypeSafeStub((body) => {
    n += 1;
    if (n === 1) return { status: 402, body: { error: 'payment required' } };
    const q = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, unknown> }>;
    return { status: 200, body: { answers: healthyAnswers(q), usage: { input_tokens: 400, output_tokens: 50 } } };
  });
  try {
    await withWingman(stub.url, async (step) => {
      const first = await step();
      assert.equal(jevDownCell(first), true, 'the lone 402 call by itself reads down');
      const both = await step();
      const last = JSON.parse(both[both.length - 1]) as Record<string, unknown>;
      assert.notEqual(last.reason, 'jev-error', 'the second call reached Jev');
      assert.ok(Number(last.input_tokens) > 0, 'the healthy call carries Jev tokens');
      assert.equal(jevDownCell(both), false);
    });
  } finally {
    await stub.close();
  }
});

test('r24d: jevDownCell edge shapes (no records, malformed lines, mixed ends, tokens)', () => {
  const rec = (o: Record<string, unknown>): string => JSON.stringify({ tool: 'browse_step', input_tokens: 0, output_tokens: 0, ...o });
  assert.equal(jevDownCell([]), false, 'no wingman record is not evidence');
  assert.equal(jevDownCell(['not json', '']), false);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'jev-error' })]), true);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'jev-error' }), rec({ status: 'fallback', reason: 'breaker-open' })]), true);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'jev-error' }), rec({ status: 'done', reason: 'goal-met' })]), false);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'step-uncertain' })]), false);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'no-key' })]), false);
  assert.equal(jevDownCell([rec({ status: 'fallback', reason: 'jev-error', input_tokens: 10 })]), false, 'Jev answered earlier in the cell');
});
