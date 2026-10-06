// Unit tests for the grader-replay harness (r21 P-4, spec D7-D8). Pure parts
// only — no chrome, no network. The CLI subprocess pins drive the real
// bench/grader-replay.mjs end-to-end (exit codes included: the D8 self-check
// must be able to FAIL, proven against a corrupted capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// bench/grader-replay.mjs is a plain ESM module outside tsconfig's include
// (the package compiles with allowJs off), so a STATIC import cannot be used:
// tsc rewrites relative specifiers against the output tree, and the .mjs is
// never copied to the out dir. The test therefore imports the real file at
// run time from the repo root. run-tests.mjs always spawns test files with
// cwd = the package root (it resolves --dist against process.cwd()), so the
// repo-root anchor is the runner's own convention.
import { pathToFileURL } from 'node:url';

const harnessPath = path.join(process.cwd(), 'bench', 'grader-replay.mjs');
const harnessRepoRoot = (): string => path.resolve(path.dirname(harnessPath), '..');
const gr: any = await import(pathToFileURL(harnessPath).href);
const { parseSlice, extractRoundProbs, extractResponseProbs, mirrorDecision, applyThresholdOverrides, evaluateCapture, computeMargins, globToRegex, askStage, mergeCapture, parseArgs } = gr;

// The spec-pinned baseline (D7 margins block + constants.ts current values).
const BASE = {
  done: 0.85,
  error: 0.5,
  stepDone: 0.85,
  stepDoneWithEvidence: 0.5,
  ready: 0.3,
  rightPage: 0.5,
  target: 0.5,
};

function tmpRepoDir(): string {
  fs.mkdirSync(path.join(harnessRepoRoot(), '.build'), { recursive: true });
  return fs.mkdtempSync(path.join(harnessRepoRoot(), '.build', 'grader-replay-test-'));
}

function node(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [harnessPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      cwd: harnessRepoRoot(),
      env: opts.env ?? { ...process.env },
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// --- margins parser -----------------------------------------------------------

test('margins parser histograms a fixture slice string', () => {
  const slice = [
    {
      ts: 't1',
      phases: {
        rounds: [
          { doneP: 0.87, readyP: 0.28, stepDoneP: 0.55, target1: 'e1', target1P: 0.52 },
          { doneP: 0.84, readyP: 0.42, stepDoneP: 0.1, target1: 'e2', target1P: 0.48 },
        ],
      },
    },
    {
      ts: 't2',
      phases: {
        rounds: [{ doneP: 0.33, target1: 'ambiguous', target1P: 0.9, errorP: 0.52 }],
      },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const { records, skipped } = parseSlice(slice);
  assert.equal(skipped, 0);
  assert.equal(records.length, 2);
  const rounds = records.flatMap((r: any) => extractRoundProbs(r));
  assert.equal(rounds.length, 3);
  const m = computeMargins(rounds);
  const byKey = (k: string) => m.find((x: any) => x.key === k);

  // done 0.85: |0.02| and |0.01| inside 0.05; |0.52| beyond.
  const done = byKey('done');
  assert.equal(done.n, 3);
  assert.equal(done.within05, 2);
  assert.equal(done.within10, 0);
  assert.equal(done.beyond, 1);
  assert.equal(done.nearest[0].p, 0.84);

  // ready 0.3: 0.28 below within 0.05; 0.42 above, |0.12| beyond.
  const ready = byKey('ready');
  assert.equal(ready.n, 2);
  assert.equal(ready.within05, 1);
  assert.equal(ready.beyond, 1);
  assert.equal(ready.below, 1);
  assert.equal(ready.above, 1);

  // stepDoneWithEvidence 0.5: 0.55 within 0.05 above; 0.1 beyond.
  const stepDone = byKey('stepDoneWithEvidence');
  assert.equal(stepDone.n, 2);
  assert.equal(stepDone.within05, 1);
  assert.equal(stepDone.above, 1);

  // target 0.5 counts only element-chosen rows: 'ambiguous' is excluded.
  const target = byKey('target');
  assert.equal(target.n, 2);
  assert.equal(target.within05, 2);

  // 0.05 < |m| <= 0.10 band: probe with a purpose-built round.
  const band = computeMargins([{ target1: 'e1', target1P: 0.58, doneP: 0.76 }]);
  assert.equal(band.find((x: any) => x.key === 'target').within10, 1);
  assert.equal(band.find((x: any) => x.key === 'done').within10, 1);
});

test('globToRegex matches spec-style slice patterns', () => {
  const re = globToRegex('**/evidence/*.jsonl');
  assert.ok(re.test('a/b/evidence/R20-log-slice.jsonl'));
  assert.ok(re.test('evidence/x.jsonl'));
  assert.ok(!re.test('a/evidence/x.txt'));
  assert.ok(!re.test('a/b/evidence/deep/x.jsonl'));
  const p = globToRegex('P*.jsonl');
  assert.ok(p.test('P1-log-slice.jsonl'));
  assert.ok(!p.test('Q1-log-slice.jsonl'));
});

// --- response extraction ------------------------------------------------------

test('extractResponseProbs reads nouls and the target choice map', () => {
  const probs = extractResponseProbs({
    done: { type: 'noul', noul: 0.1 },
    ready: { type: 'noul', noul: 0.7 },
    step_done: { type: 'noul', noul: 0.2 },
    action: { type: 'choice', choice: 'click', probabilities: { click: 0.9, none: 0.05 } },
    target: { type: 'choice', choice: 'e2', probabilities: { e2: 0.55, none: 0.2, ambiguous: 0.1 } },
  });
  assert.equal(probs.doneP, 0.1);
  assert.equal(probs.readyP, 0.7);
  assert.equal(probs.stepDoneP, 0.2);
  assert.equal(probs.actionP, 0.9);
  assert.equal(probs.target1, 'e2');
  assert.equal(probs.target1P, 0.55);
  assert.equal(probs.target2, 'none');
  assert.equal(probs.target2P, 0.2);
  const empty = extractResponseProbs({});
  assert.equal(empty.doneP, undefined);
  assert.equal(empty.target1, undefined);
});

// --- the replay decision function ---------------------------------------------

test('mirrorDecision: committed round, bounced round, and the rule order', () => {
  // Committed: a listed element at/above the target bar.
  assert.deepEqual(mirrorDecision({ target1: 'e1', target1P: 0.92, doneP: 0.1 }, BASE, { round: 1 }), {
    kind: 'act',
    gate: 'target',
  });
  // Bounced: below the bar, no rival rule.
  assert.deepEqual(mirrorDecision({ target1: 'e1', target1P: 0.3, doneP: 0.1 }, BASE, { round: 1 }), {
    kind: 'bounce',
    gate: 'target',
  });
  // done precedes everything (C2).
  assert.equal(mirrorDecision({ doneP: 0.9 }, BASE, { round: 3 }).kind, 'done');
  // error fires only from round 2.
  assert.equal(mirrorDecision({ errorP: 0.6, target1: 'e1', target1P: 0.9 }, BASE, { round: 1 }).kind, 'act');
  assert.equal(mirrorDecision({ errorP: 0.6 }, BASE, { round: 2 }).kind, 'error');
  // ready gate precedes the target bar.
  assert.deepEqual(mirrorDecision({ readyP: 0.2, target1: 'e1', target1P: 0.9 }, BASE, { round: 1 }), {
    kind: 'wait',
    gate: 'ready',
  });
  // right_page below bar bounces even with a committable target.
  assert.deepEqual(
    mirrorDecision({ rightPageP: 0.3, readyP: 0.9, target1: 'e1', target1P: 0.9 }, BASE, { round: 1 }),
    { kind: 'bounce', gate: 'right_page' },
  );
  // The plain stepDone advance bar is chain-only (0.85; evidence bars out of scope).
  assert.equal(mirrorDecision({ stepDoneP: 0.9 }, BASE, { round: 2, chain: true }).kind, 'advance');
  assert.equal(mirrorDecision({ stepDoneP: 0.9 }, BASE, { round: 2, chain: false }).kind, 'bounce');
  // A non-element top choice never commits at the target gate.
  assert.equal(mirrorDecision({ target1: 'none', target1P: 0.95 }, BASE, { round: 1 }).kind, 'bounce');
  // stepDone in the evidence band [0.5, 0.85) does NOT advance (mirror scope).
  assert.equal(mirrorDecision({ stepDoneP: 0.6 }, BASE, { round: 2, chain: true }).kind, 'bounce');
});

test('candidate-threshold flips go both directions under overrides', () => {
  const bounced = { target1: 'e1', target1P: 0.3, doneP: 0.1 };
  const committed = { target1: 'e1', target1P: 0.55, doneP: 0.1 };
  const lower = applyThresholdOverrides(BASE, { target: 0.25 });
  const higher = applyThresholdOverrides(BASE, { target: 0.6 });
  // Lowering the bar flips the recorded bounce into a commit.
  assert.equal(mirrorDecision(bounced, lower, { round: 1 }).kind, 'act');
  // Raising the bar flips the recorded commit into a bounce.
  assert.equal(mirrorDecision(committed, higher, { round: 1 }).kind, 'bounce');
  // Baseline reproduces both recorded classes.
  assert.equal(mirrorDecision(bounced, BASE, { round: 1 }).kind, 'bounce');
  assert.equal(mirrorDecision(committed, BASE, { round: 1 }).kind, 'act');
  assert.throws(() => applyThresholdOverrides(BASE, { nope: 0.5 }), /unknown threshold key/);
  assert.throws(() => applyThresholdOverrides(BASE, { target: 3 }), /must be a number/);
});

// --- D8 drift self-check -------------------------------------------------------

function captureLine(kind: string, probs: any, mirrored = true) {
  return {
    ts: '2026-10-04T00:00:00Z',
    tool: 'browse_step',
    host: '127.0.0.1',
    round: 1,
    chain: true,
    request: { questions: {} },
    response: { ok: true, answers: {} },
    ms: 10,
    decision: { kind, status: 'done', reason: 'goal-met', probs, mirrored },
  };
}

test('D8 self-check: green capture passes, corrupting one probability fails it', () => {
  const good = [
    captureLine('act', { target1: 'e1', target1P: 0.92, doneP: 0.1 }),
    captureLine('bounce', { target1: 'e1', target1P: 0.3, doneP: 0.1 }),
    captureLine('other', { target1: 'e1', target1P: 0.4 }, false), // unmirrored, never judged
  ];
  const ok = evaluateCapture(good, BASE);
  assert.equal(ok.checked, 2);
  assert.equal(ok.unmirrored, 1);
  assert.deepEqual(ok.mismatches, []);

  const corrupted = JSON.parse(JSON.stringify(good));
  corrupted[0].decision.probs.target1P = 0.1; // recorded 'act', probabilities now say bounce
  const bad = evaluateCapture(corrupted, BASE);
  assert.equal(bad.mismatches.length, 1);
  assert.equal(bad.mismatches[0].line, 1);
  assert.equal(bad.mismatches[0].recorded, 'act');
  assert.equal(bad.mismatches[0].replayed, 'bounce');
  assert.equal(bad.mismatches[0].gate, 'target');
});

test('D8 self-check via the real CLI: corrupted capture exits 1, green exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-replay-cli-'));
  try {
    const good = [
      captureLine('act', { target1: 'e1', target1P: 0.92, doneP: 0.1 }),
      captureLine('bounce', { target1: 'e1', target1P: 0.3, doneP: 0.1 }),
    ];
    const goodPath = path.join(dir, 'good.jsonl');
    fs.writeFileSync(goodPath, good.map((l: unknown) => JSON.stringify(l)).join('\n') + '\n');
    const greenRun = node(['replay', '--capture', goodPath]);
    assert.equal(greenRun.status, 0, `expected self-check PASS, got: ${greenRun.out}`);
    assert.match(greenRun.out, /self-check PASS/);

    const corrupted = JSON.parse(JSON.stringify(good));
    corrupted[1].decision.probs.target1P = 0.9; // recorded 'bounce', probabilities now commit
    const badPath = path.join(dir, 'corrupt.jsonl');
    fs.writeFileSync(badPath, corrupted.map((l: unknown) => JSON.stringify(l)).join('\n') + '\n');
    const badRun = node(['replay', '--capture', badPath]);
    assert.equal(badRun.status, 1, `expected self-check exit 1, got: ${badRun.out}`);
    assert.match(badRun.out, /SELF-CHECK FAILED/);
    assert.match(badRun.out, /line 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay with a threshold override reports would-change rows and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-replay-ovr-'));
  try {
    const lines = [captureLine('bounce', { target1: 'e1', target1P: 0.3, doneP: 0.1 })];
    const capPath = path.join(dir, 'cap.jsonl');
    fs.writeFileSync(capPath, lines.map((l: unknown) => JSON.stringify(l)).join('\n') + '\n');
    const ovrPath = path.join(dir, 'ovr.json');
    fs.writeFileSync(ovrPath, JSON.stringify({ target: 0.25 }));
    const reportPath = path.join(dir, 'report.md');
    const run = node(['replay', '--capture', capPath, '--thresholds', ovrPath, '--report', reportPath]);
    assert.equal(run.status, 0, run.out);
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /Would-change rows under the override set: 1 of 1/);
    assert.match(report, /1 bounce->commit flips/);
    assert.match(report, /Baseline self-check: PASS/);
    assert.match(report, /NOT the full/); // the honest scope header is present

    // D9: a stale mirror (baseline self-check red) refuses to bless overrides.
    const stale = JSON.parse(JSON.stringify(lines));
    stale[0].decision.probs.target1P = 0.9; // recorded 'bounce', mirror now commits
    const staleCap = path.join(dir, 'stale.jsonl');
    fs.writeFileSync(staleCap, stale.map((l: unknown) => JSON.stringify(l)).join('\n') + '\n');
    const staleRun = node(['replay', '--capture', staleCap, '--thresholds', ovrPath]);
    assert.equal(staleRun.status, 1, `expected baseline-fail exit 1, got: ${staleRun.out}`);
    assert.match(staleRun.out, /BASELINE SELF-CHECK FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- real CLI margins over a fixture slice file ---------------------------------

test('margins CLI end-to-end over a repo-relative fixture slice', () => {
  const dir = tmpRepoDir();
  try {
    const slice = [
      { ts: 't1', phases: { rounds: [{ doneP: 0.87, readyP: 0.28, target1: 'e1', target1P: 0.52 }] } },
      { ts: 't2', phases: { rounds: [{ doneP: 0.84, readyP: 0.42, target1: 'e2', target1P: 0.48 }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const sliceRel = path.join(path.relative(harnessRepoRoot(), dir), 'slice.jsonl').split('\\').join('/');
    fs.writeFileSync(path.join(dir, 'slice.jsonl'), slice + '\n');
    const reportPath = path.join(dir, 'margins.md');
    const run = node(['margins', '--slices', sliceRel, '--report', reportPath]);
    assert.equal(run.status, 0, run.out);
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /Jev grader margins/);
    assert.match(report, /\| done 0\.85 \| doneP \| 2 \| 2 \| 0 \| 0 \|/);
    assert.match(report, /\| ready 0\.30 \| readyP \| 2 \| 1 \| 0 \| 1 \|/);
    assert.match(report, /\| target 0\.50 \| target1P \| 2 \| 2 \| 0 \| 0 \|/);
    assert.match(report, /probabilities only/); // the C3 scope note
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- F1 (verifier, 2026-10-04): capture merge pairing ---------------------------
// A two-stage round (element count over max_elements) makes TWO askWithCost
// calls — request 1 (group) then request 2 (target) — but the pre-fix merge
// consumed exactly one recorded ask per round, shifting every later pairing
// by one. Silent by construction: unmatched rounds only mark mirrored:false
// and capture still exits 0. These pins drive mergeCapture (the extracted
// merge) over synthetic records+asks built in the real recorded shapes.

function askLine(ts: string, stage: string, questions: object, answers: object) {
  return { ts, stage, ms: 10, request: { questions }, response: { ok: true, answers } };
}
const noul = (v: number) => ({ type: 'noul', noul: v });
const choice = (c: string, probs: Record<string, number>) => ({ type: 'choice', choice: c, probabilities: probs });
function recLine(ts: string, rounds: Array<[string | null, number]>) {
  return {
    ts,
    tool: 'wingman_do',
    host: 'h',
    status: 'done',
    reason: 'goal-met',
    phases: {
      rounds: rounds.map(([kind, jevMs]) => ({
        observeMs: 1,
        jevMs,
        actMs: 0,
        settleMs: 0,
        ...(kind !== null ? { kind } : {}),
      })),
    },
  };
}

test('askStage classifies the real request shapes', () => {
  // buildRoundRequest / buildCheckRequest open their round.
  assert.equal(askStage({ questions: { done: {}, action: {}, target: {} } }), 'round');
  assert.equal(askStage({ questions: { answer: {} } }), 'round');
  // buildGroupRequest opens a two-stage round; buildTargetRequest rides it.
  assert.equal(askStage({ questions: { done: {}, action: {}, group: {} } }), 'group');
  assert.equal(askStage({ questions: { target: {}, irreversible: {} } }), 'target');
  // select-option chunks and the final ride the round; the r13 stuck ask
  // (recover as the ONLY question) opens its own round.
  assert.equal(askStage({ questions: { option: {} } }), 'option');
  assert.equal(askStage({ questions: { recover: {} } }), 'recover');
  // buildRoundRequest carries recover as an EXTRA question next to done —
  // that is a normal round ask, not the stuck ask.
  assert.equal(askStage({ questions: { done: {}, recover: {} } }), 'round');
});

test('F1: a two-stage round consumes BOTH its asks; later pairings stay aligned', () => {
  const records = [
    recLine('t1', [['act', 10]]),
    recLine('t2', [['act', 20]]), // the two-stage round: 2 asks
    recLine('t3', [['act', 10]]),
  ];
  const asks = [
    askLine('a1', 'round', { done: {}, action: {}, target: {} }, { done: noul(0.1), target: choice('e1', { e1: 0.9, none: 0.05 }) }),
    askLine('a2', 'group', { done: {}, action: {}, group: {} }, { done: noul(0.1), action: choice('click', { click: 0.9, none: 0.05 }), group: choice('g1', { g1: 0.8, none: 0.1 }) }),
    askLine('a3', 'target', { target: {}, irreversible: {} }, { target: choice('e2', { e2: 0.9, none: 0.05 }) }),
    askLine('a4', 'round', { done: {}, action: {}, target: {} }, { done: noul(0.1), target: choice('e3', { e3: 0.9, none: 0.05 }) }),
  ];
  const { lines, unpaired } = mergeCapture(records, asks, BASE);
  assert.equal(unpaired, 0);
  assert.equal(lines.length, 3);
  // Round 1 pairs with its own ask.
  assert.equal(lines[0].decision.probs.target1, 'e1');
  // Round 2's merged answers carry request 1's nouls AND request 2's target.
  assert.equal(lines[1].decision.probs.target1, 'e2');
  assert.equal(lines[1].decision.probs.doneP, 0.1);
  assert.equal(lines[1].decision.mirrored, true);
  // THE pre-fix shift: round 3 must pair with a4 (e3), never with a3 (e2 —
  // the previous round's request 2, which read as a plausible 'act' on the
  // wrong round, mirrored:true, the silent corruption).
  assert.equal(lines[2].decision.probs.target1, 'e3');
  assert.equal(lines[2].decision.mirrored, true);
  // All four recorded asks were consumed (3 lines, one two-ask round).
});

test('F1: a round that ended before its ask consumes nothing', () => {
  const records = [
    recLine('t1', [[null, 0]]), // pre-ask end (captcha/policy/token bail): jevMs never moved
    recLine('t2', [['act', 10]]),
  ];
  const asks = [
    askLine('a1', 'round', { done: {}, action: {}, target: {} }, { done: noul(0.1), target: choice('e9', { e9: 0.9, none: 0.05 }) }),
  ];
  const { lines, unpaired } = mergeCapture(records, asks, BASE);
  assert.equal(lines.length, 1);
  // `round` is the per-RECORD round index (what mirrorDecision's error gate
  // reads) — the pairing round is the second record's round 1. The shift
  // itself is asserted by lines.length and the target below: pre-fix, the
  // pre-ask round consumed a1 and a second (unpaired) line was emitted.
  assert.equal(lines[0].round, 1);
  assert.equal(lines[0].decision.probs.target1, 'e9');
  assert.equal(lines[0].decision.mirrored, true);
  assert.equal(unpaired, 0);
});

// --- capture mode's no-key guard (run-tests scrubs TYPESAFE_API_KEY) -------------

test('capture without a key exits 2 and never launches a browser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-replay-cap-'));
  try {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TYPESAFE_API_KEY;
    const outPath = path.join(dir, 'cap.jsonl');
    const run = node(['capture', '--out', outPath, '--task', 'form', 'fill the field'], { env });
    assert.equal(run.status, 2, run.out);
    assert.match(run.out, /TYPESAFE_API_KEY is not set/);
    assert.ok(!fs.existsSync(outPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- capture --call (r24c) ---------------------------------------------------------

test('capture --call parses a url and a browse_step JSON object; bad JSON exits 2', () => {
  const parsed = parseArgs(['--out', 'x.jsonl', '--call', 'https://example.com/', '{"goal":"g","steps":["s"]}']);
  assert.deepEqual(parsed.call, [['https://example.com/', { goal: 'g', steps: ['s'] }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-replay-call-'));
  try {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TYPESAFE_API_KEY;
    const run = node(['capture', '--out', path.join(dir, 'c.jsonl'), '--call', 'https://example.com/', 'not-json'], { env });
    assert.equal(run.status, 2, run.out);
    assert.match(run.out, /--call needs a page url and a JSON object/);
    // r24c recheck: each rejected JSON shape alone (deleting the array, typeof or null conjunct left the test green).
    for (const bad of ['[1]', '"text"', '5', 'null']) {
      const r = node(['capture', '--out', path.join(dir, 'c.jsonl'), '--call', 'https://example.com/', bad], { env });
      assert.equal(r.status, 2, `${bad}: ${r.out}`);
      assert.match(r.out, /--call needs a page url and a JSON object/, bad);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
