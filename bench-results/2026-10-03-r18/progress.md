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

## Stage A RE-RUN at 2f25f26 (fix: tasks with `local: true` resolve against a per-invocation ephemeral fixture server) - t15/t16/t17 forced x1, cap-usd 1, phase cap 17.719952 = ledger 16.719952 + 1, experiment: 2/3, 0.7415 USD (stageA/A2-rerun-forced-2026-10-03-063509.json, A2-report.txt)
- t15-file-upload ok=TRUE 17.0 s 0.2239 (handoffs 1, picks 1): the `upload` op FIRES in the wingman loop (2 upload acts then 1 more; both wingman calls ended fallback/no-progress after the upload, the caller's pick finished it; host 127.0.0.1).
- t16-hover-reveal ok=TRUE 10.9 s 0.1767: hover -> click inside ONE browse_step call, done/goal-met, 5 rounds, clickEvidence true. (Harness columns show handoffs 0 / wingman_acts 0 for it although the log has the call - same single-call under-count as r17c t13.)
- t17-double-click ok=FALSE 33.2 s 0.3409 (5 handoffs, 3 picks, 0 wingman_acts): Jev picked `dblclick` at 0.99 every time but every call ended step-uncertain / target-uncertain with ZERO acts; the caller's pick was refused invalid-input.
  ZERO-SPEND ROOT CAUSE (evidence/probe-dbl.mjs): on double-click.html both adapters enumerate 0 elements - the target is `<div id="dbl-target" ondblclick=...>`, and page-scripts' interactive detection recognises the `onclick` ATTRIBUTE (lines 78/198/512) but not `ondblclick`, so the dblclick op has nothing to target. By hand, `dblclick('#dbl-target')` -> #dbl-count = 1 (oracle true), so the fixture is reachable; the shape is a known-failing gauntlet row (enumeration coverage gap), not a mechanism failure of the op. Not fixed (report-only). No re-run spent: the failure is deterministic (empty element table), not page state.
- Mechanisms: upload PASS, hover PASS, dblclick = enumeration gap (op chosen, never actable). Gate decision: proceed (t17 stays as a named known-failing row, per spec R4).
- Budget note: round spend so far 5.56 of 10 (A1 0.673 + B1 4.138 + A2 0.742 + probe ~0.01). The stage-B cap of 4 was consumed by 19 cells (~0.17 USD floor per cell), so the remaining 15 gauntlet cells + Stage D must share the remaining ~4.4. Order: Stage D (deliverable) next, then Stage B2 (remaining cells, new shapes first) capped to what is left.

## Stage D - t9-long-chain, playwright,forced x2 in ONE invocation (cap-usd 3.00, phase cap 19.961469 = ledger 17.461469 + 2.5, experiment): 4/4 ok, 0.9984 USD (stageD/D-t9-2026-10-03-064036.json, D-report.txt)
| cell | route | ok | wall s | usd | llm in/out/cache-read/cache-write | jev calls (in/out) |
|---|---|---|---|---|---|---|
| 1 | playwright | T | 96.5 | 0.3906 | 22/1890/663659/43486 | 0 |
| 2 | forced | T | 50.1 | 0.2832 | 14/1672/385783/37259 | 3 (63057/16504) |
| 3 | playwright | T | 28.9 | 0.1173 | 8/1270/240647/6951 | 0 |
| 4 | forced | T | 50.8 | 0.2072 | 18/1913/545525/3519 | 4 (38171/9775) |
- Spread: playwright wall min 28.9 / med 62.7 / max 96.5 (n=2, the 96.5 s cell is the cold-cache one: 43,486 cache-write tokens vs 6,951 in cell 3); forced wall 50.1 / 50.5 / 50.8. Medians: forced 0.81x playwright; min-to-min forced/playwright 1.73x; max-to-max 0.53x. n=2 - direction only, load-covariant (cache state differs 6x between the playwright cells).
- Decomposition (forced, harness v3 wingman_phases): 
  - cell 2: 28 rounds, 3 wingman calls, round_kinds act 17 / advance 6 / wait 0 / bounce 1 / done 0 / error 1 / other 3 (sum 28). observe sum 232 ms (med 7), jev sum 4126 ms (med 141; first/rest 136/142), act sum 2127 ms (med 83), settle sum 4232 ms (med 223). In-round total 10,717 ms of 50.1 s wall = 21%; remaining ~39.4 s is outside the rounds (caller turns + tool-call transport).
  - cell 4: 21 rounds, 4 wingman calls (3 picks), act 10 / advance 5 / wait 0 / bounce 2 / done 0 / error 1 / other 3 (sum 21). observe 170, jev 2594 (med 139; first 0 = empty bucket / rest 141), act 1568, settle 2376 ms. In-round 6,708 ms of 50.8 s = 13%; ~44.1 s outside.
- jev cold/warm: first/rest = 136/142 ms in the one cell that has a first-round bucket - no cold 926 ms first round (r16/OG-9: ~926 cold vs ~404 warm). Per-round jev is ~140 ms flat here (both cells), agreeing with Stage C's flat arms. The cold/warm bimodality did not reproduce on this box/endpoint, so Stage C's "not connection setup" verdict is consistent.
- Where the rounds go: ~60% act rounds (17/28, 10/21), advance 21-24%, wait 0 (r17-era wait storms absent), bounce 1-2, error 1 (an act-failed end in each), other 3. settle (fixed ~220 ms per acted round) is the largest wingman phase after jev; act is ~83 ms median.
