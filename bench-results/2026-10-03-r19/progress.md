# r19 progress (HEAD 61df9bb; npm ci skipped - lock unchanged, node_modules present; build ok, 109 files)

## Part 1 chrome-only (16 files, doctor run twice per spec; one file per invocation; no first-run failures, no re-runs)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (22 s) | adapter-playwright 10/10 | page-scripts 27/27 | doctor 37/37 (run 1) | doctor 37/37 (run 2) | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16. All green; the r18 doctor coexistence flake did not recur in 2 of 2 whole-file runs.

## Publish run attempt 1 (all 17 tasks, playwright,forced, --repeats 2, cap-usd 3.00, phase cap 31.532306 = ledger 15.532306 + 16): ABORTED `error` after 11 of 68 cells, 2.2668 USD
- Abort text: `cdp timeout: Page.navigate` (the harness's page-reset navigation, same flake as r17 invocation B). No Chrome leaked (swept). Results saved for the 11 completed cells: results/P1-aborted-2026-10-03-102309.json (+ P1-aborted-report.txt, evidence/P1-log-slice.jsonl).
- Loop order is repeats-outer: the 11 cells are repeat 1 of t1-t5 (both routes) + t6 playwright. All 11 ok. Forced cells show ts_calls=1 (log-slice byte fix live). first/rest jev ~246-303 / 137-191 ms on t1-t5 forced.
- Budget: a full 68-cell rerun projects ~14.3 USD (68 x ~0.21) vs 13.73 left under the 16 cap, so it cannot fit. Plan within the cap: invocation 2 = t6..t17 x2 routes x repeats 2 (48 cells), invocation 3 = t1..t5 x2 routes x repeats 1 (10 cells, the missing repeat 2), then merge the three files' runs (dropping the superseded 1st t6-playwright sample to keep n=2) with the harness's own summarizePairs. The merge is documented in results.md; the publish table is therefore a merged file, not one invocation.

## Publish run invocation 2 (t6..t17, playwright,forced, --repeats 2): 48/48 cells present, aborted=null, 8.3341 USD (results/P2-t6-t17-2026-10-03-104024.json, P2-report.txt, evidence/P2-log-slice.jsonl)
- forced 24/24 ok (incl. t7-sort-table x2 and t17-double-click x2 - never passed forced before), playwright 22/24 (only t15-file-upload x2 red, the tolerated one).
- t14 both routes ok, end_state "You entered: ESCAPE | focus=target" x4. forced ts_calls == browse_step tool uses on the cells inspected (t7 1/1, t14 2/2, t17 1/1); full invariant check follows on the merged file.
- Round spend so far 10.6009 USD of 16.
