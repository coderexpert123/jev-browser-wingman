# r11 validation — STOPPED after Part 1 (bench-cap test failure)

Code under test: `forced-handoff-0.3.0` @ 408bd54 (descendant check OK; r11 commits fc70aba, 1c5105d, 4788e02 + ceiling lift).
Environment: cloud Linux, Xvfb :99, chromium-wrapper installed, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller model for later parts would be Sonnet (not run).

Parts 2 and 3 were NOT run, per the rule "if ANY test file or the proof fails, STOP after Part 1". Spend: USD 0.

## Part 1 result: 50/51 files green, 1 FAIL

`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0.
Totals (one file per invocation, sequential): 709 tests, 707 pass, 1 fail, 1 skip (chrome-cmd win32-only skip, the permitted one).
Per-file counts: part1/per-file-counts.txt. No live Chrome after any file except runner-sweep-leak (its designed drill leaf, killed by my loop; the file itself passed).

### The failure: tests/bench-cap.test.ts #2 "refuses a cap above the operator ceiling" (failed on both runs)
```
0 !== 2   (exit expected 2, got 0)
```
Root cause (verified from source): the test (line 132-142) runs `--cap-usd 6 --phase-cap-usd 20` and asserts exit 2 and
`/BENCH-REFUSED: cap above operator ceiling \(5 per run, 30 per phase\)/`. Commit 408bd54 raised
`OPERATOR_CEILINGS` in bench/cap.ts to `{ runUsd: 100, phaseUsd: 500 }`, so 6/20 is now under the ceiling and is accepted
(exit 0), and the message text would now read "(100 per run, 500 per phase)". The test was not updated with the ceiling lift.
Diagnosis: a stale test, not a product defect; deterministic (failed identically on rerun). Not fixed (report-only rule).
Suggested fix (for the owner, not applied): use caps above the new ceiling (e.g. `--cap-usd 101 --phase-cap-usd 501`) and update the regex to 100/500.

### Gates
- `lazy-chrome --dist dist`: `LAZY-CHROME: ok listed=24 chrome=0 answered=false` (exit 0)
- `lazy-chrome --dist dist --known-bad tool-call`: `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (exit 1) — as required.

### Known-bad proof (splitCompoundClause)
Deviation: the literal flip (`return [clause];` as first statement) does NOT build — dead code below it then fails TS
(`src/core/loop.ts(591,9): error TS18047: 'next' is possibly 'null'`), the same trap CLAUDE.md warns about. Used the documented
flag form instead: first statements `const KB_M1: boolean = Boolean(process.env.KB_M1_OFF === undefined); if (KB_M1) return [clause];`.
Built to .build/kb-m1, ran chain: 52 tests, 45 pass, 7 FAIL — exactly the expected set:
```
not ok 45 - splitCompoundClause: the r11 boundary table, verbatim
not ok 46 - expandClauses: parents map back to the caller clause; over the cap returns null
not ok 47 - T-decompose-order
not ok 48 - T-decompose-progress
not ok 49 - T-decompose-resume
not ok 50 - T-decompose-twice
not ok 51 - T-decompose-premature
```
Restored with `git checkout -- src/core/loop.ts`; `git status --short` empty; .build/kb-m1 removed. Un-mutated chain run: 52/52 pass (chain log in the full run).

### Other observation
chain-e2e passed 8/8 on Linux (no E1/E2 flake).

## Parts 2 and 3: not run
No forced-verdict, no r8-r11 comparison, no fresh-install check; nothing to report on decomposition telemetry.

## Pre-push scan note
`apikey_` and the TYPESAFE_API_KEY value: no hits. The bound-value grep (`grep -F` of bench/tasks.json values) matched only the 2-character
value "42" as an incidental numeral (test count 42 for outcome-evidence, test number 42 in kb-m1.log, a source line number 142).
Duration/timing lines were stripped from the logs beforehand. No bound value leaked; this is a documented false positive, pushed deliberately.
