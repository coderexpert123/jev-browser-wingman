# r18 progress (HEAD b2a3037; npm ci ran once - package-lock changed; build ok, 109 files)

## Part 1 chrome-only (16 files, serial, one per invocation)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (21 s) | adapter-playwright 10/10 | page-scripts 23/23 (gained 2) | doctor 28/28 on RE-RUN | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.
- doctor FIRST run failed: "all ten checks pass on a clean ephemeral setup" -> `coexistence: observer fingerprint changed across attach/detach` (log part1/logs/doctor.first.log); re-run passed. So the coexistence flake survives the de78ea2 fix in the cloud (1 fail in 2 runs this round; r17c's 3 CLI doctor runs and Part-1 doctor run were all green). doctor uses a temp home - no wingman log.jsonl slice exists.

## Stage A - gauntlet smoke (t15/t16/t17 forced x1, cap-usd 1, phase cap 12.909115 = ledger 11.909115 + 1, experiment): 0/3, 0.6730 USD
- t15 ok=False 29.9 s 0.2538 (handoffs 2, wingman_acts 2) | t16 ok=False 16.2 s 0.1994 (0 handoffs) | t17 ok=False 23.7 s 0.2198 (handoffs 1, wingman_acts 2). No end_state defined for these tasks.
- Log (evidence/stageA-log-slice.jsonl): t15 2x fallback/step-uncertain with 2 `wait` acts; t16 error/page-error (1 wait); t17 error/page-error then fallback/step-uncertain; host `herokuapp.com` on every record.
- ROOT CAUSE (zero-spend, deterministic): bench/run.ts navigates a task with a relative path to START_BASE = https://the-internet.herokuapp.com + path. The new tasks' paths are /upload.html, /hover-reveal.html, /double-click.html - repo fixtures that the bench never serves. curl: the-internet.herokuapp.com/upload.html, /hover-reveal.html, /double-click.html all HTTP 404 (/upload alone is 200 - a different page). So all three cells ran against a 404 page: a harness/task wiring gap, NOT a routing or mechanism finding (the upload/hover/dblclick ops were never reachable). A re-run would 404 identically, so none was spent. Not fixed (report-only).

## Stage C - direct keep-alive probe (12 asks, 8 s apart, alternating arms; ~USD 0.00x, 297 in / 20 out tokens per ask)
- old arm (createDefaultAsk({apiKey, fetchFn: fetch})): ms 221, 177, 143, 161, 188, 242 -> min 143 / median 188 / max 242; first 221, rest-median 177.
- new arm (createDefaultAsk({apiKey}), shared undici dispatcher): ms 152, 155, 227, 155, 170, 190 -> min 152 / median 170 / max 227; first 152, rest-median 170.
- Both arms flat; no slow post-idle ask in either; the new arm's median is 18 ms lower (n=6 each - inside the spread). Per the spec's discriminator this is the "bimodality was never connection setup" reading for THIS trivial payload on THIS cloud box at 8 s idle. Not tested: idle > 8 s (the 55 s / Keep-Alive-hint cap question) and the real multi-question payloads - the cold/warm split inside real cells is read from Stage D's jev first/rest.

## Stage B part 1 (t1-t14 requested, playwright+forced interleaved, cap-usd 3.00, phase cap 16.582134 = ledger 12.582134 + 4, measure): ABORTED AT CAP after 19 of 28 cells, total 4.1378 USD
- Reporter output: stageB/B1-report.txt (verbatim `node dist/bench/report.js`). Cells done: t1-t9 both routes + t10 playwright. NOT run (cap): t10 forced, t11-t14 both routes (9 cells).
- playwright 10/10 ok (wall med 14.3 s, usd med 0.205). forced 8/9 ok (wall med 13.8 s, usd med 0.176; max 63.1 s t9).
- forced FAIL: t7-sort-table ok=false (22.8 s, 0.257): 3 wingman calls on "click the Last Name column header of the first table", 0 acts: fallback/step-uncertain, ambiguous/target-uncertain x2 (jev_calls 2). Routing finding (sort-header click never committed).
- Notable forced runs: t6 42.0 s (fallback/step-uncertain x2, 1 click + 5 waits) vs playwright 29.3 s; t9 forced 63.1 s, 4 wingman calls, 28 rounds, 3 fallbacks (one error/act-failed) vs playwright 28.6 s; t3 forced no-progress end after 1 click + 2 fills but oracle true.
- Cost floor: every cell carries ~34k cache-write tokens (caller session), so ~USD 0.17 minimum per cell; the 34-cell gauntlet needs ~USD 7, not the 4 allotted.
