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
const { triage, explainCell, policyEnds, isRerun, sameChain } = ht;

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

// r24b (.build-r24b-spec.md § 6 WP-R): run config / policy ends / stance / telemetry / suspect blocks / --explain.
const EXPLAIN_REC = {
  ...rec(
    'done',
    'goal-met',
    [
      {
        observeMs: 10.4, jevMs: 400, actMs: 20, settleMs: 5, kind: 'act', cursor: 0, url: 'https://x.test/a', els: 3, text_h: '1naxefc',
        step_text: 'click the Add Element button', action: 'click', actionP: 0.9, stepDoneP: 0.05,
        cands: [{ id: 'e1', p: 0.9, role: 'button', tag: 'button' }],
        act: { verb: 'click', id: 'e1', role: 'button', tag: 'button', ok: true },
      },
      {
        observeMs: 9, jevMs: 380, actMs: 0, settleMs: 0, kind: 'advance', cursor: 0, url: 'https://x.test/a', els: 4, text_h: 'syr4a3',
        step_text: 'click the Add Element button', stepDoneP: 0.49, errorP: 0.04, historyResult: 'page changed', leftPage: false, sameDocEvidence: true,
      },
    ],
  ),
  jev_calls: 2,
  stance: { gate: 'off', policy: 'off' },
  step_texts: ['click the Add Element button'],
  step_parents: [0],
};

test('handback-triage --explain prints every call and round of one cell in the fixed format', () => {
  const lines = explainCell({ runs: [run('t-x', [EXPLAIN_REC])] }, jsonl([EXPLAIN_REC]), 't-x#1');
  assert.deepEqual(lines, [
    'EXPLAIN t-x#1 ok=true calls=1 tool_calls=1 usd=0.1',
    'call1 done/goal-met why=null steps=1 rounds=2 jev_calls=2 stance=off/off',
    '  step1 "click the Add Element button"',
    '  step_parents [0]',
    '  r1 ms=10/400/20/5 kind=act cursor=0 url="https://x.test/a" els=3 th=1naxefc step="click the Add Element button" action=click actionP=0.9 stepDoneP=0.05 cands=[{"id":"e1","p":0.9,"role":"button","tag":"button"}] act={"verb":"click","id":"e1","role":"button","tag":"button","ok":true}',
    '  r2 ms=9/380/0/0 kind=advance cursor=0 url="https://x.test/a" els=4 th=syr4a3 step="click the Add Element button" stepDoneP=0.49 errorP=0.04 historyResult="page changed" leftPage=false flags=sameDocEvidence',
  ]);
});

test('handback-triage --explain refuses an unknown cell', () => {
  const dir = tmpRepoDir();
  try {
    const resultsPath = path.join(dir, 'results.json');
    const logPath = path.join(dir, 'log.jsonl');
    fs.writeFileSync(resultsPath, JSON.stringify({ runs: [run('t-x', [EXPLAIN_REC])] }));
    fs.writeFileSync(logPath, jsonl([EXPLAIN_REC]));
    const bad = spawnSync(process.execPath, [scriptPath, '--results', resultsPath, '--log', logPath, '--explain', 't-x#9'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown cell t-x#9/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handback-triage counts policy ends from the results alone, even when the log does not align', () => {
  const hs = [
    { status: 'needs_confirmation', reason: 'irreversible-heuristic', rounds: 1, steps: 1 },
    { status: 'fallback', reason: 'sensitive-password', rounds: 1, steps: 1 },
    { status: 'fallback', reason: 'unsupported-page', rounds: 1, steps: 1 },
    { status: 'fallback', reason: 'no-match', rounds: 1, steps: 1 },
    { status: 'done', reason: 'goal-met', rounds: 1, steps: 1 },
  ];
  const results = { runs: [{ ...run('t-x', []), handoff_records: hs }] };
  assert.deepEqual(policyEnds(results), { total: 3, needs_confirmation: 1, sensitive: 1, unsupported_page: 1 });
  const dir = tmpRepoDir();
  try {
    const resultsPath = path.join(dir, 'results.json');
    const logPath = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(resultsPath, JSON.stringify(results));
    fs.writeFileSync(logPath, '');
    const r = spawnSync(process.execPath, [scriptPath, '--results', resultsPath, '--log', logPath], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.deepEqual(r.stdout.split('\n').filter((l: string) => l !== ''), [
      'config none',
      'policy_ends 3 needs_confirmation=1 sensitive=1 unsupported_page=1',
      'observed none',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handback-triage appends config, policy ends, log stance, telemetry and suspect blocks after the r24 lines', () => {
  const recs: Rec[] = [
    { ...rec('fallback', 'low-confidence', [{ kind: 'advance', step_text: 'click X', sameDocEvidence: true, url: 'https://x.test/' }], 'low-confidence'), stance: { gate: 'off', policy: 'off' } } as any,
    rec('done', 'goal-met', [{ kind: 'done', step_text: 'click X' }]),
  ];
  const results = { config: { gate_mode: 'off', policy_mode: 'off' }, observed: { node_version: 'v22.1.0' }, runs: [run('t-x', recs)] };
  const dir = tmpRepoDir();
  try {
    const resultsPath = path.join(dir, 'results.json');
    const logPath = path.join(dir, 'log.jsonl');
    fs.writeFileSync(resultsPath, JSON.stringify(results));
    fs.writeFileSync(logPath, jsonl(recs));
    const r = spawnSync(process.execPath, [scriptPath, '--results', resultsPath, '--log', logPath], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l: string) => l !== '');
    assert.match(lines[0], /^HANDBACK-TRIAGE results=.* offset=0 handbacks=1$/);
    assert.deepEqual(lines.slice(-7), [
      'config {"gate_mode":"off","policy_mode":"off"}',
      'policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0',
      'observed {"node_version":"v22.1.0"}',
      'log_stance absent=1 off/off=1',
      'telemetry rounds=2 with_url=1',
      'suspect t-x#1/call1/r1/sameDocEvidence',
      '  r1 ms=0/0/0/0 kind=advance url="https://x.test/" step="click X" flags=sameDocEvidence',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handback-triage suspect rule: a repeated identical clause is not a re-run when the cursor says the chain advanced (O9)', () => {
  const step_texts = ['click X', 'click X'];
  const mk = (c2: number | undefined, st2: string[] | undefined, withCursor = true) => {
    const c1 = withCursor ? { cursor: 0 } : {};
    const call1: any = { ...rec('fallback', 'low-confidence', [{ kind: 'advance', step_text: 'click X', sameDocEvidence: true, ...c1 }], 'low-confidence'), ...(withCursor ? { step_texts } : {}) };
    const cur = c2 === undefined ? {} : { cursor: c2 };
    const call2: any = { ...rec('done', 'goal-met', [{ kind: 'act', step_text: 'click X', ...cur }, { kind: 'done', step_text: 'click X', ...cur }]), ...(st2 ? { step_texts: st2 } : {}) };
    return [call1, call2];
  };
  const verdict = (recs: any[]) => {
    const out = triage({ runs: [run('t-x', recs)] }, jsonl(recs));
    return { out, direct: isRerun(recs[0], recs[0].phases.rounds[0], recs[1]), same: sameChain(recs[0], recs[1]) };
  };
  // cursor advanced on the same re-sent chain: not a re-run
  let v = verdict(mk(1, step_texts));
  assert.deepEqual(v.out.suspect_lines, []);
  assert.equal(v.out.flags.length, 1);
  assert.equal(v.out.flags[0].suspect, false);
  assert.equal(v.direct, false);
  assert.equal(v.same, true);
  // same cursor: genuinely re-run
  v = verdict(mk(0, step_texts));
  assert.equal(v.out.suspect_lines[0], 'suspect t-x#1/call1/r1/sameDocEvidence');
  assert.equal(v.direct, true);
  assert.equal(v.same, true);
  // restructured chain (different step_texts): conservative fallback, still a suspect
  v = verdict(mk(1, ['click X']));
  assert.equal(v.out.suspect_lines[0], 'suspect t-x#1/call1/r1/sameDocEvidence');
  assert.equal(v.direct, true);
  assert.equal(v.same, false);
  // r23b / r24 shape (no cursor, no step_texts): pure text rule
  v = verdict(mk(undefined, undefined, false));
  assert.equal(v.out.suspect_lines[0], 'suspect t-x#1/call1/r1/sameDocEvidence');
  assert.equal(v.direct, true);
  assert.equal(v.same, false);
});

// r24b recheck: teeth for two survivors of the mutation pass (sameChain compared lengths only; the per-task repeat counter was never
// exercised with two reps, but the cloud prompt runs `--explain '<task>#<rep>'` on a repeats-2 gauntlet).
test('handback-triage recheck: sameChain compares the step texts, not only their count', () => {
  assert.equal(sameChain({ step_texts: ['click X', 'click Y'] }, { step_texts: ['click X', 'click X'] }), false);
  assert.equal(sameChain({ step_texts: ['click X', 'click X'] }, { step_texts: ['click X', 'click X'] }), true);
  // same length, different chain, cursor advanced: the pure text rule applies, so the re-run is still a suspect
  const call1: any = { ...rec('fallback', 'low-confidence', [{ kind: 'advance', step_text: 'click X', sameDocEvidence: true, cursor: 0 }], 'low-confidence'), step_texts: ['click X', 'click Y'] };
  const call2: any = { ...rec('done', 'goal-met', [{ kind: 'act', step_text: 'click X', cursor: 1 }, { kind: 'done', step_text: 'click X', cursor: 1 }]), step_texts: ['click X', 'click X'] };
  assert.equal(isRerun(call1, call1.phases.rounds[0], call2), true);
});

test('handback-triage recheck: the second repeat of a task is cell #2 for suspects and --explain', () => {
  const clean = rec('done', 'goal-met', [{ kind: 'done', step_text: 'click X' }]);
  const rep2 = [
    rec('fallback', 'low-confidence', [{ kind: 'advance', step_text: 'click X', sameDocEvidence: true }], 'low-confidence'),
    rec('done', 'goal-met', [{ kind: 'done', step_text: 'click X' }]),
  ];
  const all = [clean, ...rep2];
  const results = { runs: [run('t-x', [clean]), run('t-x', rep2)] };
  const out = triage(results, jsonl(all));
  assert.deepEqual(out.cells.map((c: any) => `${c.task}#${c.rep}`), ['t-x#1', 't-x#2']);
  assert.equal(out.suspect_lines[0], 'suspect t-x#2/call1/r1/sameDocEvidence');
  const lines = explainCell(results, jsonl(all), 't-x#2');
  assert.equal(lines[0], 'EXPLAIN t-x#2 ok=true calls=2 tool_calls=2 usd=0.1');
  assert.throws(() => explainCell(results, jsonl(all), 't-x#3'), /unknown cell t-x#3/);
});
