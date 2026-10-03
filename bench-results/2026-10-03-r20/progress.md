# r20 progress (HEAD 009d935 on main; npm ci skipped - lock unchanged; build ok, 110 files)

## Part 1 chrome-only (16 files, one per invocation; no first-run failures, no re-runs)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (22 s) | adapter-playwright 10/10 | page-scripts 27/27 | doctor 37/37 | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16. All green.

## Confirmation gauntlet (ONE invocation, all 17 tasks, playwright,forced, --repeats 2, cap-usd 3.00, phase cap 42.884062 = ledger 26.884062 + 16): 68/68 cells, aborted=null, total_usd 11.4273 (results/gauntlet/r20-publish-2026-10-03-125014.json, r20-report.txt, r19-r20-compare.md, evidence/R20-log-slice.jsonl)
- forced 34/34 ok (publish bar met); playwright 32/34 (t15-file-upload x2 only - tolerated).
- LIVE INVARIANT (invariant-check.py): typesafe.calls == browse_step tool uses for all 34 forced cells, 0 mismatches (sum 60 == 60); playwright cells 0 / 0.
- Navigation retry: the single invocation completed with no abort; the retry is silent (no log line), so whether any reset retried is not observable. r19 attempt 1 died at cell 11 and r17-B at cell 14 on the same flake; n=1 clean run is weak evidence.
- r19 vs r20 wall medians per task x route: 23 of 34 within +-15%; 11 outside (both directions, playwright included: t12 pw +64%, t10 pw +36%, t6 pw -33%), so the drift is not forced-path-specific. Biggest forced mover: t9 forced 44.9 -> 77.7 s (cells 61.4 and 94.0 s): 5 and 8 browse_step calls (r19: 3), 60/61 rounds (r19: 48/49), 2 act-failed ends with `locator.click: Timeout 3000ms exceeded ... waiting for scheduled navigations to finish` - live-site navigation latency + caller fragmentation, no code change in the forced path; both cells ok.

## Part 3 doctor x3 on the bench Chrome (port 9344): doctor/doctor{1,2,3}.log
- run 1: PASS coexistence  observer fingerprint identical across attach/detach (1 page(s)) | verdict: PASS
- run 2: PASS coexistence  observer fingerprint identical across attach/detach (1 page(s)) | verdict: PASS
- run 3: PASS coexistence  observer fingerprint identical across attach/detach (1 page(s)) | verdict: PASS

## Final: results.md written (forced 34/34 single invocation, playwright 32/34, invariant PASS 60==60, doctor 3/3, 23/34 pairs within +-15%, README from r19 still accurate on completion/aggregates). Round spend 11.4273 of 16 USD.
