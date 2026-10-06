// Tests for bench/handback-triage.mjs (r24 WP-M, .build-r24-spec.md § 5 WP-M / § 6).
// Pure parts run in-process on synthetic results + log records; the exit-code
// proof spawns the real script (the alignment check must be able to FAIL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// bench/*.mjs is outside tsconfig's include: import at run time from the repo
// root (run-tests.mjs spawns test files with cwd = package root), the
// tests/grader-replay.test.ts pattern.
const scriptPath = path.join(process.cwd(), 'bench', 'handback-triage.mjs');
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const ht: any = await import(pathToFileURL(scriptPath).href);
const { triage } = ht;

function tmpRepoDir(): string {
  fs.mkdirSync(path.join(repoRoot, '.build'), { recursive: true });
  return fs.mkdtempSync(path.join(repoRoot, '.build', 'handback-triage-test-'));
}

type Rec = { status: string; reason: string; steps: number; phases: { rounds: any[] }; step_review?: { why: string }; tool: string };

function rec(status: string, reason: string, rounds: any[], why?: string, steps = 1): Rec {
  return { tool: 'browse_step', status, reason, steps, phases: { rounds }, ...(why ? { step_review: { why } } : {}) };
}

function handoff(r: Rec) {
  return { status: r.status, reason: r.reason, rounds: r.phases.rounds.length, steps: r.steps };
}

function run(task: string, recs: Rec[], extra: Record<string, unknown> = {}) {
  return {
    task,
    route: 'forced',
    ok: true,
    usd: 0.1,
    wall_ms: 1000,
    tool_use_counts: { browse_step: recs.length },
    handoff_records: recs.map(handoff),
    ...extra,
  };
}

const jsonl = (recs: Rec[]) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('handback-triage classifies one end per class', () => {
  const recs: Rec[] = [
    // landed-not-advanced: an own act on the end clause whose result landed.
    rec('fallback', 'low-confidence', [
      { kind: 'act', step_text: 'click the Start button' },
      { kind: 'wait', step_text: 'click the Start button', historyResult: 'element gone' },
    ], 'low-confidence'),
    // press-split: names one key, no landed own act.
    rec('fallback', 'no-match', [{ kind: 'act', step_text: 'press Enter' }], 'no-match'),
    // not-ready: right page, no error.
    rec('fallback', 'not-ready', [{ kind: 'wait', step_text: 'click the Start button', rightPageP: 0.9, errorP: 0.1 }], 'not-ready'),
    // error-page: not-ready with a high errorP.
    rec('fallback', 'not-ready', [{ kind: 'wait', step_text: 'click Retrieve', rightPageP: 0.9, errorP: 0.6 }], 'not-ready'),
    // stuck-exhausted: a stuck round on the end clause (wrong-page, but right page and no error evidence).
    rec('fallback', 'no-match', [
      { kind: 'act', step_text: 'open the Status Codes link', stuck: 'back' },
      { kind: 'act', step_text: 'open the Status Codes link' },
    ], 'wrong-page'),
    // target-uncertain: plain no-match.
    rec('fallback', 'no-match', [{ kind: 'act', step_text: 'choose the second option' }], 'no-match'),
    // other: no-value is none of the above.
    rec('fallback', 'no-value', [{ kind: 'act', step_text: 'type the name' }], 'no-value'),
    rec('done', 'goal-met', [{ kind: 'done', step_text: 'finish' }]),
  ];
  const results = { runs: [run('t-x', recs)] };
  const out = triage(results, jsonl(recs));
  assert.equal(out.handback_total, 7);
  assert.deepEqual(out.classes, {
    'landed-not-advanced': 1,
    'press-split': 1,
    'not-ready': 1,
    'error-page': 1,
    'stuck-exhausted': 1,
    'target-uncertain': 1,
    other: 1,
  });
  assert.deepEqual(out.no_wingman_done_cells, []);
});

test('handback-triage finds the alignment offset past a foreign prefix', () => {
  const recs: Rec[] = [
    rec('fallback', 'no-match', [{ kind: 'act', step_text: 'choose the second option' }], 'no-match', 2),
    rec('done', 'goal-met', [{ kind: 'done', step_text: 'finish' }], undefined, 2),
  ];
  const junk = [0, 1, 2].map((i) => rec('junk', `j${i}`, [], undefined, 9));
  const out = triage({ runs: [run('t-x', recs)] }, jsonl([...junk, ...recs]));
  assert.equal(out.offset, 3);
  assert.equal(out.handback_total, 1);
});

test('handback-triage exits 2 when the log does not align', () => {
  const recs: Rec[] = [
    rec('fallback', 'no-match', [{ kind: 'act', step_text: 'choose the second option' }], 'no-match'),
    rec('done', 'goal-met', [{ kind: 'done', step_text: 'finish' }]),
  ];
  const dir = tmpRepoDir();
  try {
    const resultsPath = path.join(dir, 'results.json');
    const logOk = path.join(dir, 'ok.jsonl');
    const logBad = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(resultsPath, JSON.stringify({ runs: [run('t-x', recs)] }));
    fs.writeFileSync(logOk, jsonl(recs));
    fs.writeFileSync(logBad, jsonl(recs.slice(0, 1))); // missing one record
    const good = spawnSync(process.execPath, [scriptPath, '--results', resultsPath, '--log', logOk], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /^HANDBACK-TRIAGE results=.* offset=0 handbacks=1\n/);
    const bad = spawnSync(process.execPath, [scriptPath, '--results', resultsPath, '--log', logBad], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /alignment failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handback-triage flags an r24 rule round as suspect only when a later call re-runs its clause', () => {
  const mk = (laterClause: string) => {
    const recs: Rec[] = [
      rec('fallback', 'low-confidence', [{ kind: 'advance', step_text: 'click X', sameDocEvidence: true }], 'low-confidence'),
      rec('done', 'goal-met', [{ kind: 'done', step_text: laterClause }]),
    ];
    return triage({ runs: [run('t-x', recs)] }, jsonl(recs));
  };
  const re = mk('click X');
  assert.equal(re.flags.length, 1);
  assert.equal(re.flags[0].flag, 'sameDocEvidence');
  assert.equal(re.flags[0].suspect, true);
  const other = mk('click Y');
  assert.equal(other.flags.length, 1);
  assert.equal(other.flags[0].suspect, false);
});

test('handback-triage counts tool calls per run from tool_use_counts', () => {
  const a = [rec('done', 'goal-met', [{ kind: 'done', step_text: 'a' }], undefined, 1)];
  const b = [rec('done', 'goal-met', [{ kind: 'done', step_text: 'b' }], undefined, 2)];
  const results = {
    runs: [
      run('t-a', a, { tool_use_counts: { x: 1, y: 2 } }),
      run('t-b', b, { tool_use_counts: { x: 4 } }),
    ],
  };
  const out = triage(results, jsonl([...a, ...b]));
  assert.equal(out.byRoute.forced.runs, 2);
  assert.equal(out.byRoute.forced.tool_calls_total, 7);
  assert.equal(out.byRoute.forced.tool_calls_median, 3.5);
  assert.equal(out.byRoute.forced.tool_calls_mean, 3.5);
  assert.deepEqual(out.cells.map((c: any) => c.tool_calls), [3, 4]);
});
