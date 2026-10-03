# r18 - measurement rigor, warm Jev speed, generality gauntlet (HEAD b2a3037 -> 2f25f26)

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99, cloud Sonnet caller, gate off, policy off, harness_version 3. `npm ci` ran once (package-lock changed at b2a3037); lock unchanged at 2f25f26. Round spend **9.438 USD of 10** (ledger-measured: A1 0.673 + B1 4.138 + A2 0.742 + D 0.998 + B2 2.887; Stage C probe ~0.00x, not in the ledger). Stage B's own 4 USD cap was exhausted by 19 cells (every cell carries ~34k caller cache-write tokens, a ~0.17 USD floor when the prompt cache is cold), so Stage B ran as B1 (aborted at cap, 19 cells) + B2 (remaining 14 cells) and Stage D ran before B2 so the t9 deliverable could not be starved. Stage order actually executed: Part 1, A (blocked), C, B1, [fix 2f25f26 pulled], A re-run, D, B2.

## Part 1 (Chrome-only, 16 files, serial) - green; doctor on re-run
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (21 s) | adapter-playwright 10/10 | page-scripts 23/23 | **doctor 28/28 only on re-run** (first run: `coexistence: observer fingerprint changed across attach/detach`; the flake survives de78ea2 in the cloud: 1 fail in 2 runs; log part1/logs/doctor.first.log) | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.

## Stage verdicts
- **Stage A (gauntlet smoke): PASS on the mechanisms for upload and hover; t17 is a named known-failing row.**
  - First attempt (b2a3037): 0/3, root cause a harness gap, not mechanism - relative task paths were joined to `https://the-internet.herokuapp.com`, where `/upload.html`, `/hover-reveal.html`, `/double-click.html` return HTTP 404 (curl-verified); the wingman saw a 404 page (`page-error`, `step-uncertain`). Fixed by the operator in 2f25f26 (`local: true` + per-invocation fixture server).
  - Re-run (2f25f26): t15 ok (17.0 s, 0.224; the `upload` op fires in the loop, then the caller's pick finishes), t16 ok (10.9 s, 0.177; hover -> click inside ONE browse_step call, clickEvidence true), **t17 ok=false** (33.2 s, 0.341): Jev chose `dblclick` at 0.99 on every call but 5 calls ended step-uncertain/target-uncertain with 0 acts, and the caller's pick was refused `invalid-input`. Zero-spend root cause (evidence/probe-dbl.mjs): both adapters enumerate **0 elements** on double-click.html - the target is `<div ondblclick=...>` and `page-scripts` treats an `onclick` attribute as interactive (lines 78/198/512) but not `ondblclick`. By hand `dblclick('#dbl-target')` sets the counter to 1 (oracle true). So the op is never actable on that fixture: an enumeration-coverage gap, not a Jev routing failure. Not fixed.
- **Stage B (full gauntlet, 34 cells): 31/34 ok.** playwright 16/17, forced 15/17. Table below. Red rows (findings, not fixed):
  1. **t7-sort-table forced FALSE** (22.8 s, 0.257): 3 wingman calls on "click the Last Name column header of the first table", 0 acts - fallback/step-uncertain, then ambiguous/target-uncertain x2. The sort-header click never commits.
  2. **t17-double-click forced FALSE** - the enumeration gap above (playwright control TRUE 12.3 s: the caller's own tools dblclick fine).
  3. **t15-file-upload playwright FALSE** (15.4 s, 0.220): tool sequence snapshot -> click -> `browser_file_upload`, oracle false. Cause not diagnosed (no transcript retained for playwright cells; I did not probe the Playwright MCP's file-path handling). Forced route passes the same task.
- **Stage C (keep-alive probe): both arms flat.** old arm (fetchFn injected) median 188 ms (143-242), new arm (shared undici dispatcher) median 170 ms (152-227), n=6 each, 8 s spacing, tiny payload: no slow post-idle ask in either arm; the new arm's 18 ms lower median is inside the spread. Verdict per the spec's discriminator: the cold/warm bimodality was not connection setup on this box. Not tested: idle > 8 s (the 55 s / Keep-Alive-hint cap question) and real multi-question payloads.
- **Stage D (t9, both routes x2, one invocation): 4/4 ok, 0.998 USD.** Detail below.

## Jev cold/warm verdict (numbers)
First-round vs later-round jev in real cells (harness v3 `jev first/rest`, ms): t9 forced 136/142; t10 forced 158/137; t6/t11/t15/t16 first bucket empty (0) / rest 137-156; per-round jev medians 135-160 ms throughout. Prior cold/warm figures were ~926 / ~404 ms (r16/OG-9, operator machine); here the first round is **not** slower than the rest (136 vs 142), so no cold-start penalty is visible - consistent with Stage C's flat arms. Because the probe showed the OLD client equally flat, this run cannot attribute the absence to the warm session; it only shows the bimodality did not reproduce on this box/endpoint.

## t9 round decomposition (Stage D, forced) and the 1.4x
| cell | wall s | calls | rounds | kinds (act/advance/wait/bounce/done/error/other) | observe | jev (med; first/rest) | act | settle | in-round total | share of wall |
|---|---|---|---|---|---|---|---|---|---|---|
| D2 | 50.1 | 3 | 28 | 17/6/0/1/0/1/3 | 232 ms | 4126 ms (141; 136/142) | 2127 ms | 4232 ms | 10,717 ms | 21% |
| D4 | 50.8 | 4 | 21 | 10/5/0/2/0/1/3 | 170 ms | 2594 ms (139; -/141) | 1568 ms | 2376 ms | 6,708 ms | 13% |
(B1's t9 forced cell: 63.1 s, 4 calls, 28 rounds, kinds 11/5/1/4/0/1/6, observe 240 / jev 4060 / act 2834 / settle 2769 ms = 9,903 ms = 16% of wall.)
- 79-87% of forced t9 wall is OUTSIDE the wingman rounds (caller turns and tool-call transport); settle (~220 ms per acted round) and jev (~140 ms/round) are the wingman's two big phases, act ~83 ms median, observe ~7 ms.
- Rounds split ~60% act / 21-24% advance / 0 wait / 1-4 bounce / 1 error; no wait storms.
- The forced/playwright t9 wall ratio is not a stable 1.4x: B1 63.1/28.6 = 2.2x; D 50.1/96.5 = 0.52x and 50.8/28.9 = 1.76x (the 96.5 s playwright cell is the cold-cache one: 43,486 cache-write tokens vs 6,951). n=3 pairs, ratio range 0.52x-2.2x: cache state and caller turn count, not wingman machinery, dominate; the data do not support a point estimate.

## Gauntlet table (all 17 shapes x 2 routes; raw tokens in/out/cache-read/cache-write are the caller's)
| task | playwright ok | wall s | usd | in/out/cache-read/cache-write | forced ok | wall s | usd | in/out/cache-read/cache-write | ts_calls (harness) |
|---|---|---|---|---|---|---|---|---|---|
| t1-checkboxes | True | 11.6 | 0.192 | 8/228/199490/34315 | True | 11.1 | 0.175 | 6/224/141250/34441 | 0 |
| t2-dropdown | True | 10.9 | 0.192 | 8/260/199272/34193 | True | 10.4 | 0.175 | 6/243/141238/34454 | 0 |
| t3-dynamic-controls | True | 14.2 | 0.215 | 10/363/259932/35010 | True | 18.0 | 0.198 | 8/384/200680/35332 | 0 |
| t4-add-elements | True | 15.2 | 0.196 | 8/385/199468/34867 | True | 13.8 | 0.175 | 6/210/141242/34430 | 0 |
| t5-inputs | True | 10.9 | 0.192 | 8/250/199397/34130 | True | 10.0 | 0.175 | 6/234/141252/34453 | 0 |
| t6-dynamic-loading | True | 29.3 | 0.214 | 10/360/259203/34830 | True | 42.0 | 0.240 | 12/609/320687/35859 | 1 |
| t7-sort-table | True | 14.4 | 0.225 | 10/382/262631/37464 | False | 22.8 | 0.257 | 12/1204/322756/37943 | 2 |
| t8-status-404 | True | 11.4 | 0.195 | 8/240/200275/34897 | True | 11.5 | 0.176 | 6/277/141230/34424 | 0 |
| t9-long-chain | True | 28.6 | 0.287 | 12/1773/337446/42415 | True | 63.1 | 0.393 | 24/2187/697419/39648 | 4 |
| t10-saucedemo-checkout | True | 29.1 | 0.266 | 14/939/381109/36707 | True | 29.1 | 0.271 | 12/1568/326703/39209 | 2 |
| t11-todomvc-spa | True | 19.9 | 0.269 | 14/622/388230/38143 | True | 27.5 | 0.284 | 14/1164/388069/39821 | 2 |
| t12-js-confirm-dialog | True | 15.0 | 0.217 | 10/400/261143/35278 | True | 17.8 | 0.220 | 10/466/261626/35746 | 0 |
| t13-infinite-scroll | True | 20.4 | 0.204 | 8/384/202633/36593 | True | 14.7 | 0.177 | 6/223/142068/34853 | 0 |
| t14-key-press | True | 14.0 | 0.214 | 10/299/260716/35008 | True | 13.8 | 0.199 | 8/368/201863/35324 | 1 |
| t15-file-upload | False | 15.4 | 0.220 | 10/738/260434/34920 | True | 17.7 | 0.104 | 10/667/297106/1279 | 1 |
| t16-hover-reveal | True | 14.8 | 0.214 | 10/339/260078/34777 | True | 17.0 | 0.103 | 10/627/296801/1300 | 2 |
| t17-double-click | True | 12.3 | 0.193 | 8/251/200430/34436 | False | 33.2 | 0.341 | 20/1701/567609/38647 | 5 |

Route spreads over the 17 tasks: playwright 16/17 ok, wall min/med/max 10.9/14.8/29.3 s, usd 0.192/0.214/0.287 (sum 3.703); forced 15/17 ok, wall 10.0/17.7/63.1 s, usd 0.103/0.198/0.393 (sum 3.663). t17 forced is the Stage A re-run cell; all other cells come from B1/B2.

## Caveats (numbers, not adjectives)
- Prompt-cache state confounds USD: forced t15/t16 in B2a cost 0.104/0.103 with 1,279/1,300 cache-write tokens vs 0.22 with ~35k when cold (same tasks, same route). Cross-route USD comparisons below ~2x are not interpretable.
- The harness `ts_calls` / `wingman.calls` / handoff columns undercount single-call goal-met cells (forced t12: ts_calls 0, log shows 1 call with 2 Jev asks; t13: 0 vs 9 Jev asks; t16 handoffs 0). Use the wingman log (evidence/*-log-slice.jsonl) for call counts.
- n=1 per cell in the gauntlet; t9 n=2+1. Live the-internet.herokuapp.com, saucedemo, todomvc.
- The `doctor` coexistence flake (1 of 2 whole-file runs this round) is unresolved in the cloud.
- Stage C used a trivial 297-token payload at 8 s spacing only.

## Appendix: reporter output (verbatim `node dist/bench/report.js <file>`)

### results/stageA/A2-report.txt
```
BENCH REPORT 2026-10-03-063509.json purpose=experiment model=sonnet harness=3 aborted=null total_usd=0.741517 runs=3
cell t15-file-upload forced ok=true wall_s=17.0 usd=0.223865 llm_in=10 llm_out=678 llm_cache_read=262492 llm_cache_write=35956 ts_calls=1 ts_in=1961 ts_out=522 fallbacks=1 rounds=2
cell t16-hover-reveal forced ok=true wall_s=10.9 usd=0.176735 llm_in=6 llm_out=225 llm_cache_read=142070 llm_cache_write=34859 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=false wall_s=33.2 usd=0.340917 llm_in=20 llm_out=1701 llm_cache_read=567609 llm_cache_write=38647 ts_calls=5 ts_in=3170 ts_out=838 fallbacks=1 rounds=5
route forced n=3 ok=2/3 wall_s min=10.9 med=17.0 max=33.2 usd min=0.176735 med=0.223865 max=0.340917
phases t15-file-upload/forced attach=17 first_observe=9 observe=9+17 jev=61+121 jev first/rest=0/121 act=22+44 settle=108+215 kinds act=1 advance=0 wait=0 bounce=1 done=0 error=0 other=0
phases t17-double-click/forced attach=67 first_observe=7 observe=7+34 jev=0+249 jev first/rest=0/136 act=0+0 settle=0+0 kinds act=0 advance=0 wait=0 bounce=4 done=0 error=0 other=1
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageB/B1-report.txt
```
BENCH REPORT 2026-10-03-063320.json purpose=measure model=sonnet harness=3 aborted=cap total_usd=4.137818 runs=19
cell t1-checkboxes playwright ok=true wall_s=11.6 usd=0.191972 llm_in=8 llm_out=228 llm_cache_read=199490 llm_cache_write=34315 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=11.1 usd=0.174907 llm_in=6 llm_out=224 llm_cache_read=141250 llm_cache_write=34441 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown playwright ok=true wall_s=10.9 usd=0.191929 llm_in=8 llm_out=260 llm_cache_read=199272 llm_cache_write=34193 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=10.4 usd=0.175237 llm_in=6 llm_out=243 llm_cache_read=141238 llm_cache_write=34454 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls playwright ok=true wall_s=14.2 usd=0.214742 llm_in=10 llm_out=363 llm_cache_read=259932 llm_cache_write=35010 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=18.0 usd=0.198483 llm_in=8 llm_out=384 llm_cache_read=200680 llm_cache_write=35332 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements playwright ok=true wall_s=15.2 usd=0.196391 llm_in=8 llm_out=385 llm_cache_read=199468 llm_cache_write=34867 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=13.8 usd=0.174653 llm_in=6 llm_out=210 llm_cache_read=141242 llm_cache_write=34430 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs playwright ok=true wall_s=10.9 usd=0.191581 llm_in=8 llm_out=250 llm_cache_read=199397 llm_cache_write=34130 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=10.0 usd=0.175102 llm_in=6 llm_out=234 llm_cache_read=141252 llm_cache_write=34453 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading playwright ok=true wall_s=29.3 usd=0.213803 llm_in=10 llm_out=360 llm_cache_read=259203 llm_cache_write=34830 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=42.0 usd=0.24047 llm_in=12 llm_out=609 llm_cache_read=320687 llm_cache_write=35859 ts_calls=1 ts_in=14801 ts_out=3664 fallbacks=1 rounds=9
cell t7-sort-table playwright ok=true wall_s=14.4 usd=0.225039 llm_in=10 llm_out=382 llm_cache_read=262631 llm_cache_write=37464 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=false wall_s=22.8 usd=0.257209 llm_in=12 llm_out=1204 llm_cache_read=322756 llm_cache_write=37943 ts_calls=2 ts_in=0 ts_out=0 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=11.4 usd=0.19457 llm_in=8 llm_out=240 llm_cache_read=200275 llm_cache_write=34897 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=11.5 usd=0.175632 llm_in=6 llm_out=277 llm_cache_read=141230 llm_cache_write=34424 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain playwright ok=true wall_s=28.6 usd=0.286921 llm_in=12 llm_out=1773 llm_cache_read=337446 llm_cache_write=42415 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=63.1 usd=0.393066 llm_in=24 llm_out=2187 llm_cache_read=697419 llm_cache_write=39648 ts_calls=4 ts_in=54361 ts_out=13898 fallbacks=3 rounds=28
cell t10-saucedemo-checkout playwright ok=true wall_s=29.1 usd=0.266111 llm_in=14 llm_out=939 llm_cache_read=381109 llm_cache_write=36707 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
route playwright n=10 ok=10/10 wall_s min=10.9 med=14.3 max=29.3 usd min=0.191581 med=0.205097 max=0.286921
route forced n=9 ok=8/9 wall_s min=10.0 med=13.8 max=63.1 usd min=0.174653 med=0.175632 max=0.393066
phases t6-dynamic-loading/forced attach=16 first_observe=8 observe=7+65 jev=137+1103 jev first/rest=0/139 act=1000+5070 settle=218+1311 kinds act=1 advance=1 wait=5 bounce=1 done=0 error=0 other=1
phases t7-sort-table/forced attach=33 first_observe=11 observe=10+19 jev=0+0 jev first/rest=0/0 act=0+0 settle=0+0 kinds act=0 advance=0 wait=0 bounce=2 done=0 error=0 other=0
phases t9-long-chain/forced attach=73 first_observe=11 observe=8+240 jev=145+4060 jev first/rest=126/147 act=0+2834 settle=0+2769 kinds act=11 advance=5 wait=1 bounce=4 done=0 error=1 other=6
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageB/report-064223.txt
```
BENCH REPORT 2026-10-03-064223.json purpose=measure model=sonnet harness=3 aborted=null total_usd=0.641275 runs=4
cell t15-file-upload playwright ok=false wall_s=15.4 usd=0.22018 llm_in=10 llm_out=738 llm_cache_read=260434 llm_cache_write=34920 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=17.7 usd=0.104045 llm_in=10 llm_out=667 llm_cache_read=297106 llm_cache_write=1279 ts_calls=1 ts_in=1961 ts_out=522 fallbacks=1 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=14.8 usd=0.213552 llm_in=10 llm_out=339 llm_cache_read=260078 llm_cache_write=34777 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=17.0 usd=0.103498 llm_in=10 llm_out=627 llm_cache_read=296801 llm_cache_write=1300 ts_calls=2 ts_in=3507 ts_out=934 fallbacks=1 rounds=4
route playwright n=2 ok=1/2 wall_s min=14.8 med=15.1 max=15.4 usd min=0.213552 med=0.216866 max=0.22018
route forced n=2 ok=2/2 wall_s min=17.0 med=17.3 max=17.7 usd min=0.103498 med=0.1037715 max=0.104045
phases t15-file-upload/forced attach=18 first_observe=7 observe=7+13 jev=78+156 jev first/rest=0/156 act=18+36 settle=108+216 kinds act=1 advance=0 wait=0 bounce=1 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=31 first_observe=8 observe=6+26 jev=60+283 jev first/rest=0/142 act=30+119 settle=108+432 kinds act=2 advance=1 wait=0 bounce=1 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageB/report-064236.txt
```
BENCH REPORT 2026-10-03-064236.json purpose=measure model=sonnet harness=3 aborted=null total_usd=0.193053 runs=1
cell t17-double-click playwright ok=true wall_s=12.3 usd=0.193053 llm_in=8 llm_out=251 llm_cache_read=200430 llm_cache_write=34436 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
route playwright n=1 ok=1/1 wall_s min=12.3 med=12.3 max=12.3 usd min=0.193053 med=0.193053 max=0.193053
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageB/report-064501.txt
```
BENCH REPORT 2026-10-03-064501.json purpose=measure model=sonnet harness=3 aborted=null total_usd=1.782216 runs=8
cell t11-todomvc-spa playwright ok=true wall_s=19.9 usd=0.268877 llm_in=14 llm_out=622 llm_cache_read=388230 llm_cache_write=38143 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=27.5 usd=0.283984 llm_in=14 llm_out=1164 llm_cache_read=388069 llm_cache_write=39821 ts_calls=2 ts_in=17448 ts_out=4533 fallbacks=1 rounds=9
cell t12-js-confirm-dialog playwright ok=true wall_s=15.0 usd=0.216665 llm_in=10 llm_out=400 llm_cache_read=261143 llm_cache_write=35278 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=17.8 usd=0.219555 llm_in=10 llm_out=466 llm_cache_read=261626 llm_cache_write=35746 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll playwright ok=true wall_s=20.4 usd=0.203798 llm_in=8 llm_out=384 llm_cache_read=202633 llm_cache_write=36593 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=14.7 usd=0.176682 llm_in=6 llm_out=223 llm_cache_read=142068 llm_cache_write=34853 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press playwright ok=true wall_s=14.0 usd=0.21401 llm_in=10 llm_out=299 llm_cache_read=260716 llm_cache_write=35008 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=13.8 usd=0.198645 llm_in=8 llm_out=368 llm_cache_read=201863 llm_cache_write=35324 ts_calls=1 ts_in=1833 ts_out=466 fallbacks=0 rounds=2
route playwright n=4 ok=4/4 wall_s min=14.0 med=17.4 max=20.4 usd min=0.203798 med=0.21533750000000002 max=0.268877
route forced n=4 ok=4/4 wall_s min=13.8 med=16.2 max=27.5 usd min=0.176682 med=0.2091 max=0.283984
phases t11-todomvc-spa/forced attach=28 first_observe=11 observe=8+<sum withheld by push scan, see evidence/reporter-output-verbatim.txt> jev=135+996 jev first/rest=0/137 act=18+179 settle=213+1079 kinds act=5 advance=3 wait=0 bounce=1 done=0 error=0 other=0
phases t14-key-press/forced attach=17 first_observe=7 observe=7+14 jev=80+160 jev first/rest=0/160 act=22+44 settle=108+215 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageB/report-064532.txt
```
BENCH REPORT 2026-10-03-064532.json purpose=measure model=sonnet harness=3 aborted=null total_usd=0.270534 runs=1
cell t10-saucedemo-checkout forced ok=true wall_s=29.1 usd=0.270534 llm_in=12 llm_out=1568 llm_cache_read=326703 llm_cache_write=39209 ts_calls=2 ts_in=46038 ts_out=11336 fallbacks=1 rounds=19
route forced n=1 ok=1/1 wall_s min=29.1 med=29.1 max=29.1 usd min=0.270534 med=0.270534 max=0.270534
phases t10-saucedemo-checkout/forced attach=39 first_observe=10 observe=9+162 jev=137+2962 jev first/rest=158/137 act=0+477 settle=0+1977 kinds act=9 advance=8 wait=0 bounce=1 done=0 error=0 other=1
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```

### results/stageD/D-report.txt
```
BENCH REPORT 2026-10-03-064036.json purpose=experiment model=sonnet harness=3 aborted=null total_usd=0.998353 runs=4
cell t9-long-chain playwright ok=true wall_s=96.5 usd=0.390586 llm_in=22 llm_out=1890 llm_cache_read=663659 llm_cache_write=43486 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=50.1 usd=0.283227 llm_in=14 llm_out=1672 llm_cache_read=385783 llm_cache_write=37259 ts_calls=3 ts_in=63057 ts_out=16504 fallbacks=1 rounds=28
cell t9-long-chain playwright ok=true wall_s=28.9 usd=0.117334 llm_in=8 llm_out=1270 llm_cache_read=240647 llm_cache_write=6951 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=50.8 usd=0.207206 llm_in=18 llm_out=1913 llm_cache_read=545525 llm_cache_write=3519 ts_calls=4 ts_in=38171 ts_out=9775 fallbacks=2 rounds=21
route playwright n=2 ok=2/2 wall_s min=28.9 med=62.7 max=96.5 usd min=0.117334 med=0.25395999999999996 max=0.390586
route forced n=2 ok=2/2 wall_s min=50.1 med=50.5 max=50.8 usd min=0.207206 med=0.2452165 max=0.283227
phases t9-long-chain/forced attach=47 first_observe=9 observe=7+232 jev=141+4126 jev first/rest=136/142 act=83+2127 settle=223+4232 kinds act=17 advance=6 wait=0 bounce=1 done=0 error=1 other=3
phases t9-long-chain/forced attach=57 first_observe=8 observe=8+170 jev=139+2594 jev first/rest=0/141 act=0+1568 settle=0+2376 kinds act=10 advance=5 wait=0 bounce=2 done=0 error=1 other=3
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty
```
