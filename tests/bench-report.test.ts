// r18 WP-1: bench measurement reporting tests. Shape pins for the exported
// pure `aggregatePhases`, the D9 reporter's exact-line output (expected block
// hand-built from the spec templates), and the `@REPO@` value expansion.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregatePhases,
  expandTaskValuePlaceholders,
  type AggregateRound,
  type BenchResultsFile,
  type BenchRunRecord,
  type BenchTask,
} from '../bench/run.js';
import { reportMain } from '../bench/report.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture(
  fn: () => number,
): { exit: number; out: string; err: string } {
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
    const exit = fn();
    return { exit, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------------------------------------------------------------------------
// aggregatePhases (r18 D2)

test('aggregatePhases splits the per-call cold Jev round from the warm rest', () => {
  // First round of the (single) call: jevMs 900; three warm rounds: 400.
  const rounds: AggregateRound[] = [
    { observeMs: 10, jevMs: 900, actMs: 30, settleMs: 200, isFirst: true },
    { observeMs: 12, jevMs: 400, actMs: 40, settleMs: 210 },
    { observeMs: 11, jevMs: 400, actMs: 50, settleMs: 220 },
    { observeMs: 13, jevMs: 400, actMs: 60, settleMs: 230 },
  ];
  const agg = aggregatePhases(rounds);
  assert.equal(agg.jev_first_ms, 900);
  assert.equal(agg.jev_rest_ms, 400);
  // The overall median is unchanged by the split: 400 dominates 900,400,400,400.
  assert.equal(agg.jev_ms, 400);
  assert.equal(agg.observe_ms, 12); // median(10,11,12,13)=11.5 -> round 12
  assert.equal(agg.act_ms, 45); // median(30,40,50,60)=45
  assert.equal(agg.settle_ms, 215); // median(200,210,220,230)=215
  assert.equal(agg.rounds, 4);
  assert.equal(agg.jev_sum_ms, 2100);
  assert.equal(agg.observe_sum_ms, 46);
  assert.equal(agg.act_sum_ms, 180);
  assert.equal(agg.settle_sum_ms, 860);
});

test('a warm round with a HIGHER jevMs than the first does not leak into jev_first_ms', () => {
  // Discriminator: a max-based first/rest implementation would read 1200.
  const rounds: AggregateRound[] = [
    { observeMs: 10, jevMs: 900, actMs: 30, settleMs: 200, isFirst: true },
    { observeMs: 10, jevMs: 1200, actMs: 30, settleMs: 200 },
    { observeMs: 10, jevMs: 400, actMs: 30, settleMs: 200 },
  ];
  const agg = aggregatePhases(rounds);
  assert.equal(agg.jev_first_ms, 900);
  assert.equal(agg.jev_rest_ms, 800); // median(1200, 400)
});

test('aggregatePhases tallies round kinds and buckets kindless rounds as other', () => {
  const rounds: AggregateRound[] = [
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, isFirst: true, kind: 'act' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'advance' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'wait' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'bounce' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'done' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'error' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1, kind: 'not-a-kind' },
    { observeMs: 1, jevMs: 1, actMs: 1, settleMs: 1 },
  ];
  const agg = aggregatePhases(rounds);
  assert.deepEqual(agg.round_kinds, {
    act: 1,
    advance: 1,
    wait: 1,
    bounce: 1,
    done: 1,
    error: 1,
    other: 2, // the unknown string AND the kindless round
  });
});

test('aggregatePhases reads 0 medians on an empty first/rest bucket', () => {
  const onlyWarm = aggregatePhases([{ observeMs: 5, jevMs: 300, actMs: 20, settleMs: 100 }]);
  assert.equal(onlyWarm.jev_first_ms, 0);
  assert.equal(onlyWarm.jev_rest_ms, 300);
  const onlyFirst = aggregatePhases([{ observeMs: 5, jevMs: 300, actMs: 20, settleMs: 100, isFirst: true }]);
  assert.equal(onlyFirst.jev_first_ms, 300);
  assert.equal(onlyFirst.jev_rest_ms, 0);
  const empty = aggregatePhases([]);
  assert.equal(empty.jev_first_ms, 0);
  assert.equal(empty.jev_rest_ms, 0);
  assert.equal(empty.rounds, 0);
  assert.deepEqual(empty.round_kinds, { act: 0, advance: 0, wait: 0, bounce: 0, done: 0, error: 0, other: 0 });
});

// ---------------------------------------------------------------------------
// expandTaskValuePlaceholders (r18 D8)

test('expandTaskValuePlaceholders expands @REPO@ to a forward-slash absolute path without mutating the input', () => {
  const tasks: BenchTask[] = [
    {
      id: 't15-file-upload',
      path: '/upload.html',
      goal: 'g',
      values: { sample: '@REPO@/fixtures/files/sample-upload.txt' },
      oracle: 'o',
    },
    { id: 't2', path: '/login', goal: 'g2', values: { username: 'tomsmith' }, oracle: 'o2' },
    { id: 't3', path: '/status_codes', goal: 'g3', values: {}, oracle: 'o3' },
  ];
  const snapshot = JSON.stringify(tasks);
  const out = expandTaskValuePlaceholders(tasks, 'D:\\My Repos\\jev-browser-wingman');
  assert.equal(out[0].values.sample, 'D:/My Repos/jev-browser-wingman/fixtures/files/sample-upload.txt');
  // Non-@REPO@ values pass through untouched.
  assert.equal(out[1].values.username, 'tomsmith');
  assert.deepEqual(out[2].values, {});
  // The input tasks (and their values objects) are not mutated in place.
  assert.equal(JSON.stringify(tasks), snapshot);
  assert.equal(tasks[0].values.sample, '@REPO@/fixtures/files/sample-upload.txt');
});

// ---------------------------------------------------------------------------
// The D9 reporter: exact-line pin over a real fixture file through reportMain.

function fixtureRun(over: Partial<BenchRunRecord>): BenchRunRecord {
  return {
    task: 't9-long-chain',
    route: 'forced',
    ok: true,
    wall_ms: 1000,
    browser_tool_calls: 3,
    per_step_ms: 333,
    llm: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, cli_reported_usd: null },
    typesafe: { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 },
    wingman: { calls: 0, fallback: 0, needs_confirmation: 0 },
    usd: 0,
    ...over,
  };
}

test('reportMain prints the exact D9 block for a fixture results file', () => {
  const dir = tmpDir('jevw-report-');
  const file = path.join(dir, 'rep-fixture.json');
  const phases = {
    attach_ms: 100,
    first_observe_ms: 40,
    observe_ms: 12,
    jev_ms: 350,
    act_ms: 30,
    settle_ms: 220,
    rounds: 5,
    jev_first_ms: 900,
    jev_rest_ms: 320,
    observe_sum_ms: 60,
    jev_sum_ms: 1740,
    act_sum_ms: 150,
    settle_sum_ms: 1100,
    round_kinds: { act: 2, advance: 1, wait: 1, bounce: 0, done: 0, error: 0, other: 1 },
  };
  const results: BenchResultsFile = {
    date: 'rep-fixture',
    purpose: 'measure',
    harness_version: 3,
    model: 'sonnet',
    cap_usd: 4,
    phase_cap_usd: 8,
    aborted: null,
    total_usd: 0.75,
    runs: [
      fixtureRun({
        task: 't9-long-chain',
        route: 'forced',
        ok: true,
        wall_ms: 1000,
        usd: 0.5,
        llm: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 5, usd: 0.4, cli_reported_usd: null },
        typesafe: { calls: 3, input_tokens: 400, output_tokens: 250, usd: 0.1 },
        wingman: { calls: 3, fallback: 1, needs_confirmation: 0 },
      }),
      fixtureRun({
        task: 't12-js-confirm-dialog',
        route: 'forced',
        ok: false,
        wall_ms: 1234,
        usd: 0.25,
        llm: { input_tokens: 200, output_tokens: 40, cache_read_tokens: 60, cache_write_tokens: 10, usd: 0.2, cli_reported_usd: null },
        typesafe: { calls: 4, input_tokens: 800, output_tokens: 500, usd: 0.05 },
        wingman: { calls: 4, fallback: 2, needs_confirmation: 1 },
        wingman_phases: phases,
      }),
    ],
    summary: {},
  };
  fs.writeFileSync(file, JSON.stringify(results, null, 2));

  const res = capture(() => reportMain([file]));
  assert.equal(res.exit, 0);
  assert.equal(res.err, '');
  // Expected block hand-built from the spec's D9 templates (wall_s 1 decimal,
  // usd as recorded, tokens integers; ok=true|false literal; phases lines only
  // where wingman_phases is non-null).
  const expected = [
    'BENCH REPORT rep-fixture.json purpose=measure model=sonnet harness=3 aborted=null total_usd=0.75 runs=2',
    'cell t9-long-chain forced ok=true wall_s=1.0 usd=0.5 llm_in=100 llm_out=20 llm_cache_read=30 llm_cache_write=5 ts_calls=3 ts_in=400 ts_out=250 fallbacks=1 rounds=0',
    'cell t12-js-confirm-dialog forced ok=false wall_s=1.2 usd=0.25 llm_in=200 llm_out=40 llm_cache_read=60 llm_cache_write=10 ts_calls=4 ts_in=800 ts_out=500 fallbacks=2 rounds=5',
    'route forced n=2 ok=1/2 wall_s min=1.0 med=1.1 max=1.2 usd min=0.25 med=0.375 max=0.5',
    'phases t12-js-confirm-dialog/forced attach=100 first_observe=40 observe=12+60 jev=350+1740 jev first/rest=900/320 act=30+150 settle=220+1100 kinds act=2 advance=1 wait=1 bounce=0 done=0 error=0 other=1',
    'legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty',
  ].join('\n') + '\n';
  assert.equal(res.out, expected);
});

test('reportMain refuses a missing or unreadable file with exit 2 on stderr', () => {
  const missing = capture(() => reportMain([path.join(tmpDir('jevw-report-miss-'), 'absent.json')]));
  assert.equal(missing.exit, 2);
  assert.match(missing.err, /cannot read/);
  assert.equal(missing.out, '');
  const noArg = capture(() => reportMain([]));
  assert.equal(noArg.exit, 2);
  assert.match(noArg.err, /usage/);
});

test('a pre-r18 phases record (no round_kinds, no sums) prints zeros and other=rounds without crashing', () => {
  const dir = tmpDir('jevw-report-legacy-');
  const file = path.join(dir, 'legacy.json');
  const results: BenchResultsFile = {
    date: 'legacy',
    purpose: 'measure',
    harness_version: 2,
    model: 'sonnet',
    cap_usd: 4,
    phase_cap_usd: 8,
    aborted: null,
    total_usd: 0,
    runs: [
      fixtureRun({
        route: 'forced',
        wingman_phases: {
          attach_ms: 543,
          first_observe_ms: 19,
          observe_ms: 9,
          jev_ms: 355,
          act_ms: 27,
          settle_ms: 226,
          rounds: 69,
        } as BenchRunRecord['wingman_phases'],
      }),
    ],
    summary: {},
  };
  fs.writeFileSync(file, JSON.stringify(results));
  const res = capture(() => reportMain([file]));
  assert.equal(res.exit, 0);
  assert.match(
    res.out,
    /phases t9-long-chain\/forced attach=543 first_observe=19 observe=9\+0 jev=355\+0 jev first\/rest=0\/0 act=27\+0 settle=226\+0 kinds act=0 advance=0 wait=0 bounce=0 done=0 error=0 other=69/,
  );
});
