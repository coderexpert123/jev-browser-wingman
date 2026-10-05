# r23b — the clean deterministic publish run (HEAD b3b9cd2)

## Part 1 (chrome-only, 19 files, 20 runs incl. doctor x2)
All green on first run, no re-runs: acquire, chrome, conformance, conformance-ops, chain-e2e (E12 PASS), pick-e2e, adapter-cdp, adapter-playwright, page-scripts, act-nav, fixture-server, bench-fixtures, doctor x2, with-chrome, with-chrome-forced, runner-sweep, runner-sweep-leak, ephemeral-sweep, scaffold. See part1/summary.txt.

## Part 2 — 68 cells, one invocation (results/gauntlet/)
- 68/68 cells ran, no abort, total spend about USD 10.25 (cap 16; phase cap = ledger 78.051904 + 16).
- **Forced 34/34 ok — acceptance MET.** Playwright 32/34 (t15 both reps red: the known tolerated red, undiagnosed).
- Route walls: forced min 9.0 / med 13.1 / max 70.1 s; playwright min 8.7 / med 11.7 / max 36.8 s.
- **Invariant typesafe.calls == tool_use_counts[browse_step]: 34 of 34 forced cells match, 0 mismatches.**
- **t13 (local, deterministic): both forced cells ok**, 1 call, 9 rounds, 8 acts, 0 waits, 14.8/15.3 s. Fixture fix verified.
- **t6 forced:** 3 calls each; wait acts 6 and 9; walls 35.7/48.2 s (r23: 7/9 waits, 49.7 s median).
- t12 forced 14.7-15.4 s; t14 forced 12.1-13.9 s.
- t10/t11 live canaries: all 4 cells ok (forced t10 22.9/24.3 s, t11 19.6/31.4 s); no site-health issue, no curl probe needed.

## t9 headline (deterministic local chain)
| rep | calls | rounds | wall | error ends | ambiguous ends | resumeSkippedPostAction |
|---|---|---|---|---|---|---|
| 1 | 3 | 51 | 30.7 s | 0 | 0 | 0 records |
| 2 | 8 | 64 | 70.1 s | 2 (page-error, act-failed) | 0 | 0 records |
- vs r23 (8/5 calls, 3 error ends), r21b (8 calls, 3 error ends): rep 1 reaches the r19-healthy shape (3 calls, 0 errors); rep 2 still fragments (8 calls). The target of 4 or fewer calls is met by one of two reps; not a publish bar.
- Stuck-none grades (target1 == none, first call of each rep, step "go to the next page"-class steps): rep 1 drew 0.64 0.89 0.86 0.63 0.94 0.94 0.76 0.99 0.95 0.95 0.67 0.97 0.95 0.96 0.96 0.98; rep 2 drew 0.64 0.82 0.83 0.63 0.96 0.94 0.77 0.99 0.98 0.97 0.95 0.52. Recovery calls in rep 2 drew 0.89-0.93 on some and 0.76/0.76 on the re-send call (the low draws that precede bounces).
- Rep 2's act-failed error end (locator.click timeout, 1 round, 6.97 s) ended despite the new locator-wait retry: the retry fired (call took about 7 s) but did not rescue it, so the F-1 widening is not sufficient for that transition. No resumeSkippedPostAction record was written in either rep (the caller restructures chains between calls).
- Playwright t9: 36.8/31.2 s, so rep 1 forced (30.7 s) is at parity, rep 2 (70.1 s) is 2.2x.

## Part 3 — doctor x3 (doctor/)
PASS, PASS, PASS (verdict PASS each; handoff probe SKIP: no browsing tool registered).

## Spend
This run about USD 10.25; ledger now about 88.30.

## Publish verdict
Acceptance (forced 34/34, invariant clean, t13 fixed, canaries healthy) is met, so the README can refresh from this run: **YES**, with the honest caveat that t9 forced is bimodal (30.7 s / 70.1 s, 3 / 8 calls), so the table median (50.4 s) reflects that spread rather than a stable number.
