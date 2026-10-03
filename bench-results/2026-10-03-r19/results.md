# r19 - gauntlet closure and the publish run (HEAD 61df9bb)

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99, cloud Sonnet caller, gate off, policy off, harness_version 3. `npm ci` skipped (lock unchanged, node_modules present); build ok (109 files). Phase cap 31.532306 = ledger 15.532306 + 16; `--cap-usd 3.00`. **Round spend 11.3518 USD of 16** (attempt 1 2.2668 aborted + invocation 2 8.3341 + invocation 3 0.7509; no cap was hit; no spend beyond the publish run and two $0 doctor/KB-free parts).

## Part 1 (Chrome-only, 16 files, doctor run twice per spec) - all green, no re-runs
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (22 s) | adapter-playwright 10/10 | page-scripts 27/27 | **doctor 37/37 twice** | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.

## The 68-cell publish run - how it was actually run (read this first)
The single 68-cell invocation **aborted after 11 cells** on a harness-side `cdp timeout: Page.navigate` (the page-reset navigation; the same flake that aborted r17 invocation B), spending 2.2668 USD. A full rerun projected ~14.3 USD against 13.73 left under the 16 cap, so it could not fit. I finished within the cap with two invocations (t6-t17 x2 = 48 cells; t1-t5 x1 = the missing repeat 2, 10 cells), then merged the three files into one 68-cell file with a documented script (results/gauntlet/merge.mjs): P1's 10 t1-t5 cells + P3's 10 + P2's 48, dropping P1's superseded t6-dynamic-loading/playwright sample so every task x route has n=2; `task_pairs` rebuilt with the harness's own exported `summarizePairs`, `summary` recomputed with the same formulas. **The publish table is therefore a merge of three invocations (one aborted), not a single run**; machine load and cache state differ between them (cells 1-11 ran earlier, back-to-back with Part 1). Files: results/gauntlet/publish-merged.json (+ publish-report.txt, merge.mjs, invariant-check.py); the three source files in results/.

## Acceptance
- 68/68 cells present, `aborted=null` on the merged file (each source invocation that finished also `aborted=null`).
- **forced 34/34 ok; playwright 32/34 (only t15-file-upload x2 red, the tolerated one); 66/68 overall.** Bar met.
- Forced t7-sort-table and t17-double-click - the two watch cells that had never passed forced - passed 2/2 each.

## LIVE INVARIANT (typesafe.calls === tool_use_counts[browse_step])
```
python3 over results/gauntlet/publish-merged.json (invariant-check.py):
forced cells checked: 34   mismatches: 0   (sum typesafe.calls 54 == sum browse_step uses 54)
playwright cells: typesafe.calls > 0 in 0 of 34; browse_step uses in 0 of 34
forced cells with zero browse_step: none
```
**Verdict: PASS.** The r19 log-slice byte fix holds end-to-end on the live harness (r18's t12/t13 forced cells showed 0 Jev calls against a non-zero log; here every forced cell counts its calls).

## Per task x route pairs (n=2 each; wall in s, usd = median per cell)
| task | playwright ok | wall med s (min-max) | usd med | forced ok | wall med s (min-max) | usd med | forced browse_step calls (per cell) |
|---|---|---|---|---|---|---|---|
| t1-checkboxes | 2/2 | 13.9 (11.4-16.4) | 0.155 | 2/2 | 11.4 (10.2-12.6) | 0.123 | 1/1 |
| t2-dropdown | 2/2 | 11.1 (10.5-11.6) | 0.142 | 2/2 | 11.7 (10.5-13.0) | 0.124 | 1/1 |
| t3-dynamic-controls | 2/2 | 14.1 (14.0-14.1) | 0.165 | 2/2 | 17.6 (17.3-17.9) | 0.148 | 1/1 |
| t4-add-elements | 2/2 | 13.8 (13.3-14.3) | 0.147 | 2/2 | 11.3 (11.2-11.4) | 0.123 | 1/1 |
| t5-inputs | 2/2 | 10.9 (10.5-11.4) | 0.144 | 2/2 | 10.4 (10.3-10.5) | 0.124 | 1/1 |
| t6-dynamic-loading | 2/2 | 34.6 (29.7-39.6) | 0.092 | 2/2 | 49.0 (48.9-49.1) | 0.214 | 3/3 |
| t7-sort-table | 2/2 | 14.4 (14.2-14.6) | 0.174 | 2/2 | 11.4 (10.8-12.1) | 0.123 | 1/1 |
| t8-status-404 | 2/2 | 11.9 (11.8-12.1) | 0.145 | 2/2 | 13.1 (12.1-14.1) | 0.123 | 1/1 |
| t9-long-chain | 2/2 | 36.5 (30.6-42.3) | 0.326 | 2/2 | 44.9 (43.3-46.6) | 0.254 | 3/3 |
| t10-saucedemo-checkout | 2/2 | 22.1 (20.4-23.7) | 0.222 | 2/2 | 26.9 (26.6-27.3) | 0.215 | 3/3 |
| t11-todomvc-spa | 2/2 | 19.3 (18.7-20.0) | 0.219 | 2/2 | 24.7 (24.2-25.2) | 0.219 | 3/3 |
| t12-js-confirm-dialog | 2/2 | 13.3 (12.9-13.7) | 0.164 | 2/2 | 17.0 (16.1-17.9) | 0.188 | 1/1 |
| t13-infinite-scroll | 2/2 | 18.1 (16.9-19.4) | 0.154 | 2/2 | 14.4 (14.3-14.5) | 0.124 | 1/1 |
| t14-key-press | 2/2 | 13.9 (13.5-14.3) | 0.163 | 2/2 | 13.5 (13.3-13.7) | 0.146 | 2/2 |
| t15-file-upload | 0/2 | 16.0 (15.8-16.1) | 0.171 | 2/2 | 11.4 (11.1-11.7) | 0.125 | 1/1 |
| t16-hover-reveal | 2/2 | 15.9 (15.2-16.7) | 0.183 | 2/2 | 15.3 (10.9-19.7) | 0.159 | 1/3 |
| t17-double-click | 2/2 | 11.6 (11.6-11.7) | 0.141 | 2/2 | 11.7 (10.1-13.3) | 0.123 | 1/1 |

- Cost caveat: USD is confounded by prompt-cache state (the same task/route costs 0.06 vs 0.19 between repeats when the cache is warm vs cold); wall times are the cleaner comparison and even those are n=2.
- Forced route is slower than playwright on the multi-call shapes: t6 49.0 vs 34.6 s (3 calls vs 1 direct), t9 44.9 vs 36.5 s (1.23x; 3 calls, 48-49 rounds), t10 26.9 vs 22.1 s, t11 24.7 vs 19.3 s, t12 17.0 vs 13.3 s, t3 17.6 vs 14.1 s; roughly even or faster on single-op shapes (t1, t4, t5, t7, t13, t15, t17).

## Call-outs
- **t7-sort-table:** forced 2/2 ok (10.8 s and 12.1 s), 1 `browse_step` call each, 2 rounds (act 1, advance 1), first/rest jev 244/139 and 246/162 ms. In r18 every call ended step-uncertain/target-uncertain with 0 acts; the th-as-columnheader enumeration fix works live. Playwright 2/2.
- **t14-key-press:** forced 2/2 ok (13.3 s, 13.7 s), 2 calls each (focus-only click bounce + press; 6 rounds, bounce 1), `end_state` "You entered: ESCAPE | focus=target" on all 4 cells (both routes). Same shape as r17c.
- **t17-double-click:** forced 2/2 ok (13.3 s, 10.1 s), 1 call, 2 rounds (act 1 + advance 1). r18: 0 elements enumerated, 5 calls ended with 0 acts. The `ondblclick` candidacy fix works live. Playwright 2/2.
- **t15-file-upload:** forced 2/2 ok (11.1 s, 11.7 s, 1 call, 2 rounds; the `upload` op returns 'uploaded' and counts as evidence); **playwright 0/2** (snapshot -> click -> file_upload, oracle false, 16.1 / 15.8 s) - cause still undiagnosed.
- **t16-hover-reveal:** forced 2/2, but the second cell took 3 `browse_step` calls and 19.7 s vs 1 call and 10.9 s for the first (per-cell call counts 1/3): caller variation, no failure.

## Jev first-round vs later rounds (harness v3 `jev first/rest`)
Across the 31 forced cells that have a first-round bucket: first-round median **227 ms** (115-323) vs later-round median **139 ms** (121-191); first round slower than the rest in **26 of 31** cells, median per-cell ratio **1.65x**. t9 forced is flat (131/142 and 139/141 ms), t7 244/139, t17 181/141 and 284/128, t15 252/121 and 216/175. So a ~90 ms first-round penalty is visible on short cells here (r18's t9/t10-only read of "no cold first round" does not generalise); the old ~926 ms cold figure still does not appear. This run does not isolate the cause (Stage C in r18 showed both client arms flat on a trivial payload).

## t9 round decomposition (forced, 2 cells)
| cell | wall | calls | rounds | kinds act/advance/wait/bounce/done/error/other | observe | jev | act | settle | in-round total | share of wall |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 43.3 s | 3 | forty-eight | 22/15/2/2/0/0/7 | 415 ms | 7287 ms | 5103 ms | 5505 ms | 18,310 ms | forty-two percent |
| 2 | 46.6 s | 3 | 49 | 22/15/2/2/0/0/8 | 432 ms | 7404 ms | 5122 ms | 5470 ms | 18,428 ms | 40% |
Rounds per t9 cell rose from r18's 21-28 to forty-eight to 49 (act 22, advance 15), and the in-round share of wall rose from 13-21% to 40 to forty-two percent; no errors, 2 waits, 2 bounces per cell. The forced/playwright t9 wall ratio is 1.23x on medians (44.9 vs 36.5 s, n=2).

## Doctor x3 (bench Chrome, port 9344, WINGMAN_HOME=bench/.home)
3 of 3 `verdict: PASS`; `coexistence: observer fingerprint identical across attach/detach (1 page(s))` each time. Logs in doctor/. (Part 1's doctor was 37/37 twice as well; the r18 1-in-2 flake did not recur in 5 whole-file/CLI runs this round.)

## Caveats
- The publish file is a 3-invocation merge (above); n=2 per cell pair; live third-party sites (the-internet.herokuapp.com, saucedemo, todomvc).
- The `cdp timeout: Page.navigate` harness abort is a recurring flake (r17 B, r19 attempt 1), unexplained.
- USD is cache-state-confounded; compare walls, not dollars, across cells.
- t15 playwright cause not diagnosed (no transcript kept for playwright cells).
- Verbatim reporter output below has 3 numeric tokens replaced with `<withheld>` because a 2-character bound value collides with them in the pre-push scan; the unmodified output is results/gauntlet/publish-report.txt.

## Publish verdict
**Content: yes - the table is ready to refresh the README from** (68 cells present, aborted=null, forced 34/34, playwright 32/34 with only the tolerated t15, invariant PASS). **Procedure caveat for the operator:** it is a merged file, not one invocation, and the file lives at results/gauntlet/publish-merged.json with date `r19-publish-merged` - `readme-bench` picks the newest `measure` file by NAME in `bench/results/`, so landing it means placing the merged file there under a date-style name; I did not run `readme-bench --write` (not mine to run). If the README must come from a single uninterrupted 68-cell invocation, that needs a rerun (~14.3 USD, outside this round's remaining 4.6).

## Reporter output, verbatim (`node dist/bench/report.js results/gauntlet/publish-merged.json`)
```
BENCH REPORT publish-merged.json purpose=measure model=sonnet harness=3 aborted=null total_usd=11.351756 runs=68
cell t1-checkboxes playwright ok=true wall_s=16.4 usd=0.229605 llm_in=10 llm_out=330 llm_cache_read=268676 llm_cache_write=38406 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=12.6 usd=0.18698 llm_in=6 llm_out=213 llm_cache_read=146830 llm_cache_write=37220 ts_calls=1 ts_in=3402 ts_out=885 fallbacks=0 rounds=2
cell t1-checkboxes playwright ok=true wall_s=11.4 usd=0.079593 llm_in=8 llm_out=228 llm_cache_read=244194 llm_cache_write=771 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=10.2 usd=0.059475 llm_in=6 llm_out=213 llm_cache_read=183788 llm_cache_write=262 ts_calls=1 ts_in=3402 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=11.6 usd=0.204884 llm_in=8 llm_out=259 llm_cache_read=207642 llm_cache_write=36982 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=10.5 usd=0.187526 llm_in=6 llm_out=243 llm_cache_read=146818 llm_cache_write=37244 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=10.5 usd=0.079836 llm_in=8 llm_out=257 llm_cache_read=243877 llm_cache_write=745 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=13.0 usd=0.060042 llm_in=6 llm_out=243 llm_cache_read=183770 llm_cache_write=292 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=14.0 usd=0.228178 llm_in=10 llm_out=343 llm_cache_read=271092 llm_cache_write=37780 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=17.9 usd=0.211602 llm_in=8 llm_out=365 llm_cache_read=209050 llm_cache_write=38125 ts_calls=1 ts_in=9993 ts_out=2529 fallbacks=1 rounds=5
cell t3-dynamic-controls playwright ok=true wall_s=14.1 usd=0.101721 llm_in=10 llm_out=343 llm_cache_read=307746 llm_cache_write=1126 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=17.3 usd=0.084786 llm_in=8 llm_out=413 llm_cache_read=246016 llm_cache_write=1158 ts_calls=1 ts_in=9993 ts_out=2529 fallbacks=1 rounds=5
cell t4-add-elements playwright ok=true wall_s=13.3 usd=0.209364 llm_in=8 llm_out=385 llm_cache_read=207838 llm_cache_write=37657 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=11.4 usd=0.187089 llm_in=6 llm_out=210 llm_cache_read=146822 llm_cache_write=37220 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t4-add-elements playwright ok=true wall_s=14.3 usd=0.084026 llm_in=8 llm_out=385 llm_cache_read=244168 llm_cache_write=1327 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=11.2 usd=0.059598 llm_in=6 llm_out=210 llm_cache_read=183776 llm_cache_write=266 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=10.5 usd=0.206586 llm_in=8 llm_out=266 llm_cache_read=208591 llm_cache_write=37332 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=10.3 usd=0.187389 llm_in=6 llm_out=234 llm_cache_read=146832 llm_cache_write=37243 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t5-inputs playwright ok=true wall_s=11.4 usd=0.081931 llm_in=8 llm_out=250 llm_cache_read=243310 llm_cache_write=1377 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=10.5 usd=0.05988 llm_in=6 llm_out=234 llm_cache_read=183791 llm_cache_write=284 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=39.6 usd=0.082468 llm_in=8 llm_out=330 llm_cache_read=244788 llm_cache_write=1082 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=49.1 usd=0.277922 llm_in=14 llm_out=738 llm_cache_read=397913 llm_cache_write=39034 ts_calls=3 ts_in=25212 ts_out=6334 fallbacks=3 rounds=15
cell t6-dynamic-loading playwright ok=true wall_s=29.7 usd=0.101053 llm_in=10 llm_out=325 llm_cache_read=306895 llm_cache_write=1088 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=48.9 usd=0.150744 llm_in=14 llm_out=758 llm_cache_read=434858 llm_cache_write=2084 ts_calls=3 ts_in=25219 ts_out=6334 fallbacks=3 rounds=15
cell t7-sort-table playwright ok=true wall_s=14.2 usd=0.238396 llm_in=10 llm_out=357 llm_cache_read=273792 llm_cache_write=40233 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=10.8 usd=0.187155 llm_in=6 llm_out=218 llm_cache_read=146820 llm_cache_write=37226 ts_calls=1 ts_in=5329 ts_out=1340 fallbacks=0 rounds=2
cell t7-sort-table playwright ok=true wall_s=14.6 usd=0.110052 llm_in=10 llm_out=375 llm_cache_read=310127 llm_cache_write=3029 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=12.1 usd=0.059667 llm_in=6 llm_out=218 llm_cache_read=183773 llm_cache_write=273 ts_calls=1 ts_in=5329 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=11.8 usd=0.206859 llm_in=8 llm_out=255 llm_cache_read=208224 llm_cache_write=37478 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=12.1 usd=0.187016 llm_in=6 llm_out=212 llm_cache_read=146810 llm_cache_write=37213 ts_calls=1 ts_in=5383 ts_out=1365 fallbacks=0 rounds=3
cell t8-status-404 playwright ok=true wall_s=12.1 usd=0.083705 llm_in=8 llm_out=225 llm_cache_read=243699 llm_cache_write=1919 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=14.1 usd=0.059564 llm_in=6 llm_out=213 llm_cache_read=183758 llm_cache_write=266 ts_calls=1 ts_in=5386 ts_out=1365 fallbacks=0 rounds=3
cell t9-long-chain playwright ok=true wall_s=42.3 usd=0.444604 llm_in=26 llm_out=1729 llm_cache_read=825678 llm_cache_write=45570 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=43.3 usd=0.317909 llm_in=16 llm_out=1576 llm_cache_read=464525 llm_cache_write=40103 ts_calls=3 ts_in=106606 ts_out=25034 fallbacks=2 rounds=48
cell t9-long-chain playwright ok=true wall_s=30.6 usd=0.207204 llm_in=14 llm_out=1965 llm_cache_read=453177 llm_cache_write=11129 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=46.6 usd=0.189531 llm_in=16 llm_out=1545 llm_cache_read=501938 llm_cache_write=2960 ts_calls=3 ts_in=110161 ts_out=26196 fallbacks=2 rounds=49
cell t10-saucedemo-checkout playwright ok=true wall_s=20.4 usd=0.26378 llm_in=12 llm_out=903 llm_cache_read=336158 llm_cache_write=39827 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=26.6 usd=0.278549 llm_in=12 llm_out=1267 llm_cache_read=338487 llm_cache_write=41490 ts_calls=3 ts_in=56526 ts_out=13927 fallbacks=1 rounds=24
cell t10-saucedemo-checkout playwright ok=true wall_s=23.7 usd=0.179417 llm_in=16 llm_out=911 llm_cache_read=499635 llm_cache_write=4217 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=27.3 usd=0.151413 llm_in=12 llm_out=1306 llm_cache_read=375557 llm_cache_write=4463 ts_calls=3 ts_in=56750 ts_out=13926 fallbacks=1 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=18.7 usd=0.282386 llm_in=14 llm_out=627 llm_cache_read=402510 llm_cache_write=40583 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=24.2 usd=0.297641 llm_in=14 llm_out=1151 llm_cache_read=402419 llm_cache_write=42236 ts_calls=3 ts_in=29117 ts_out=7515 fallbacks=2 rounds=14
cell t11-todomvc-spa playwright ok=true wall_s=20.0 usd=0.155333 llm_in=14 llm_out=678 llm_cache_read=438988 llm_cache_write=3580 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=25.2 usd=0.140426 llm_in=12 llm_out=956 llm_cache_read=374129 llm_cache_write=3387 ts_calls=3 ts_in=26426 ts_out=6829 fallbacks=2 rounds=13
cell t12-js-confirm-dialog playwright ok=true wall_s=12.9 usd=0.227113 llm_in=10 llm_out=312 llm_cache_read=270657 llm_cache_write=37655 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=16.1 usd=0.252032 llm_in=12 llm_out=494 llm_cache_read=333838 llm_cache_write=38476 ts_calls=1 ts_in=3553 ts_out=900 fallbacks=0 rounds=2
cell t12-js-confirm-dialog playwright ok=true wall_s=13.7 usd=0.101101 llm_in=10 llm_out=312 llm_cache_read=307192 llm_cache_write=1129 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=17.9 usd=0.124906 llm_in=12 llm_out=513 llm_cache_read=370798 llm_cache_write=1543 ts_calls=1 ts_in=3553 ts_out=900 fallbacks=0 rounds=2
cell t13-infinite-scroll playwright ok=true wall_s=16.9 usd=0.215378 llm_in=8 llm_out=410 llm_cache_read=209845 llm_cache_write=39000 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=14.5 usd=0.188064 llm_in=6 llm_out=223 llm_cache_read=146828 llm_cache_write=37233 ts_calls=1 ts_in=24500 ts_out=4209 fallbacks=0 rounds=9
cell t13-infinite-scroll playwright ok=true wall_s=19.4 usd=0.092019 llm_in=8 llm_out=362 llm_cache_read=245338 llm_cache_write=3457 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=14.3 usd=0.060561 llm_in=6 llm_out=223 llm_cache_read=183785 llm_cache_write=276 ts_calls=1 ts_in=24464 ts_out=4209 fallbacks=0 rounds=9
cell t14-key-press playwright ok=true wall_s=13.5 usd=0.225791 llm_in=10 llm_out=299 llm_cache_read=270236 llm_cache_write=37388 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=13.3 usd=0.210008 llm_in=8 llm_out=368 llm_cache_read=209003 llm_cache_write=37704 ts_calls=2 ts_in=8886 ts_out=2268 fallbacks=1 rounds=6
cell t14-key-press playwright ok=true wall_s=14.3 usd=0.09989 llm_in=10 llm_out=299 llm_cache_read=306729 llm_cache_write=895 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=13.7 usd=0.082531 llm_in=8 llm_out=368 llm_cache_read=245953 llm_cache_write=754 ts_calls=2 ts_in=8886 ts_out=2268 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=16.1 usd=0.232176 llm_in=10 llm_out=752 llm_cache_read=269958 llm_cache_write=37301 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=11.1 usd=0.189131 llm_in=6 llm_out=328 llm_cache_read=146902 llm_cache_write=37325 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t15-file-upload playwright ok=false wall_s=15.8 usd=0.109432 llm_in=10 llm_out=774 llm_cache_read=305399 llm_cache_write=1646 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=11.7 usd=0.060706 llm_in=6 llm_out=275 llm_cache_read=183896 llm_cache_write=331 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=16.7 usd=0.245804 llm_in=12 llm_out=420 llm_cache_read=331463 llm_cache_write=37341 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=10.9 usd=0.187373 llm_in=6 llm_out=225 llm_cache_read=146830 llm_cache_write=37239 ts_calls=1 ts_in=6785 ts_out=1794 fallbacks=0 rounds=4
cell t16-hover-reveal playwright ok=true wall_s=15.2 usd=0.119286 llm_in=12 llm_out=418 llm_cache_read=368126 llm_cache_write=678 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=19.7 usd=0.130222 llm_in=12 llm_out=734 llm_cache_read=371903 llm_cache_write=1893 ts_calls=3 ts_in=12067 ts_out=3195 fallbacks=2 rounds=9
cell t17-double-click playwright ok=true wall_s=11.7 usd=0.203825 llm_in=8 llm_out=251 llm_cache_read=207513 llm_cache_write=36742 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=13.3 usd=0.186724 llm_in=6 llm_out=201 llm_cache_read=146806 llm_cache_write=37204 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
cell t17-double-click playwright ok=true wall_s=11.6 usd=0.077938 llm_in=8 llm_out=251 llm_cache_read=244002 llm_cache_write=253 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=10.1 usd=0.059261 llm_in=6 llm_out=201 llm_cache_read=183752 llm_cache_write=258 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
route playwright n=34 ok=32/34 wall_s min=10.5 med=14.3 max=42.3 usd min=0.077938 med=0.19162099999999999 max=0.444604
route forced n=34 ok=34/34 wall_s min=10.1 med=13.5 max=49.1 usd min=0.059261 med=0.18685200000000002 max=0.317909
pair t1-checkboxes playwright n=2 ok=2/2 wall_s min=11.4 med=13.9 max=16.4 usd_med=0.154599
pair t1-checkboxes forced n=2 ok=2/2 wall_s min=10.2 med=11.4 max=12.6 usd_med=0.123228
pair t2-dropdown playwright n=2 ok=2/2 wall_s min=10.5 med=11.1 max=11.6 usd_med=0.14236
pair t2-dropdown forced n=2 ok=2/2 wall_s min=10.5 med=11.7 max=13.0 usd_med=0.123784
pair t3-dynamic-controls playwright n=2 ok=2/2 wall_s min=14.0 med=14.1 max=14.1 usd_med=0.16495
pair t3-dynamic-controls forced n=2 ok=2/2 wall_s min=17.3 med=17.6 max=17.9 usd_med=0.148194
pair t4-add-elements playwright n=2 ok=2/2 wall_s min=13.3 med=13.8 max=14.3 usd_med=0.146695
pair t4-add-elements forced n=2 ok=2/2 wall_s min=11.2 med=11.3 max=11.4 usd_med=0.123344
pair t5-inputs playwright n=2 ok=2/2 wall_s min=10.5 med=10.9 max=11.4 usd_med=0.144259
pair t5-inputs forced n=2 ok=2/2 wall_s min=10.3 med=10.4 max=10.5 usd_med=0.123635
pair t6-dynamic-loading playwright n=2 ok=2/2 wall_s min=29.7 med=34.6 max=39.6 usd_med=0.091761
pair t6-dynamic-loading forced n=2 ok=2/2 wall_s min=48.9 med=49.0 max=49.1 usd_med=0.214333
pair t7-sort-table playwright n=2 ok=2/2 wall_s min=14.2 med=14.4 max=14.6 usd_med=0.174224
pair t7-sort-table forced n=2 ok=2/2 wall_s min=10.8 med=11.4 max=12.1 usd_med=0.123411
pair t8-status-404 playwright n=2 ok=2/2 wall_s min=11.8 med=11.9 max=12.1 usd_med=0.145282
pair t8-status-404 forced n=2 ok=2/2 wall_s min=12.1 med=13.1 max=14.1 usd_med=0.12329
pair t9-long-chain playwright n=2 ok=2/2 wall_s min=30.6 med=36.5 max=42.3 usd_med=0.325904
pair t9-long-chain forced n=2 ok=2/2 wall_s min=43.3 med=44.9 max=46.6 usd_med=0.25372
pair t10-saucedemo-checkout playwright n=2 ok=2/2 wall_s min=20.4 med=22.1 max=23.7 usd_med=0.221599
pair t10-saucedemo-checkout forced n=2 ok=2/2 wall_s min=26.6 med=26.9 max=27.3 usd_med=0.214981
pair t11-todomvc-spa playwright n=2 ok=2/2 wall_s min=18.7 med=19.3 max=20.0 usd_med=0.21886
pair t11-todomvc-spa forced n=2 ok=2/2 wall_s min=24.2 med=24.7 max=25.2 usd_med=0.219034
pair t12-js-confirm-dialog playwright n=2 ok=2/2 wall_s min=12.9 med=13.3 max=13.7 usd_med=0.164107
pair t12-js-confirm-dialog forced n=2 ok=2/2 wall_s min=16.1 med=17.0 max=17.9 usd_med=0.188469
pair t13-infinite-scroll playwright n=2 ok=2/2 wall_s min=16.9 med=18.1 max=19.4 usd_med=0.153699
pair t13-infinite-scroll forced n=2 ok=2/2 wall_s min=14.3 med=14.4 max=14.5 usd_med=0.124313
pair t14-key-press playwright n=2 ok=2/2 wall_s min=13.5 med=13.9 max=14.3 usd_med=0.162841
pair t14-key-press forced n=2 ok=2/2 wall_s min=13.3 med=13.5 max=13.7 usd_med=0.14627
pair t15-file-upload playwright n=2 ok=0/2 wall_s min=15.8 med=16.0 max=16.1 usd_med=0.170804
pair t15-file-upload forced n=2 ok=2/2 wall_s min=11.1 med=11.4 max=11.7 usd_med=0.124919
pair t16-hover-reveal playwright n=2 ok=2/2 wall_s min=15.2 med=15.9 max=16.7 usd_med=0.182545
pair t16-hover-reveal forced n=2 ok=2/2 wall_s min=10.9 med=15.3 max=19.7 usd_med=0.158798
pair t17-double-click playwright n=2 ok=2/2 wall_s min=11.6 med=11.6 max=11.7 usd_med=0.140882
pair t17-double-click forced n=2 ok=2/2 wall_s min=10.1 med=11.7 max=13.3 usd_med=0.122993
phases t1-checkboxes/forced attach=43 first_observe=16 observe=11+22 jev=215+429 jev first/rest=292/137 act=50+99 settle=109+217 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t1-checkboxes/forced attach=58 first_observe=9 observe=9+17 jev=189+378 jev first/rest=222/156 act=56+111 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=44 first_observe=11 observe=10+19 jev=219+437 jev first/rest=293/144 act=35+70 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=44 first_observe=21 observe=15+29 jev=199+398 jev first/rest=272/126 act=24+48 settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=51 first_observe=13 observe=9+46 jev=198+990 jev first/rest=269/191 act=23+2899 settle=216+655 kinds act=3 advance=1 wait=0 bounce=1 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=53 first_observe=12 observe=7+40 jev=158+825 jev first/rest=210/141 act=18+2888 settle=215+656 kinds act=3 advance=1 wait=0 bounce=1 done=0 error=0 other=0
phases t4-add-elements/forced attach=<withheld> first_observe=9 observe=6+27 jev=155+733 jev first/rest=303/155 act=43+170 settle=217+651 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t4-add-elements/forced attach=48 first_observe=15 observe=8+35 jev=136+622 jev first/rest=227/126 act=36+157 settle=217+653 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=45 first_observe=10 observe=8+16 jev=194+387 jev first/rest=246/141 act=25+49 settle=109+217 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=58 first_observe=9 observe=11+21 jev=208+416 jev first/rest=279/137 act=29+58 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=102 first_observe=12 observe=7+121 jev=132+2165 jev first/rest=132/134 act=1000+9101 settle=219+2202 kinds act=1 advance=1 wait=9 bounce=3 done=0 error=0 other=1
phases t6-dynamic-loading/forced attach=73 first_observe=11 observe=7+118 jev=144+2138 jev first/rest=142/145 act=1000+9097 settle=219+2198 kinds act=1 advance=1 wait=9 bounce=3 done=0 error=0 other=1
phases t7-sort-table/forced attach=49 first_observe=12 observe=11+21 jev=192+383 jev first/rest=244/139 act=39+78 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t7-sort-table/forced attach=55 first_observe=12 observe=11+22 jev=204+408 jev first/rest=246/162 act=38+75 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=53 first_observe=9 observe=9+27 jev=150+592 jev first/rest=323/135 act=0+452 settle=0+233 kinds act=1 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=47 first_observe=9 observe=8+25 jev=161+515 jev first/rest=217/149 act=0+545 settle=0+223 kinds act=1 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t9-long-chain/forced attach=84 first_observe=14 observe=8+415 jev=142+7287 jev first/rest=131/142 act=11+5103 settle=107+5505 kinds act=22 advance=15 wait=2 bounce=2 done=0 error=0 other=7
phases t9-long-chain/forced attach=107 first_observe=13 observe=9+432 jev=141+7404 jev first/rest=139/141 act=0+5122 settle=0+5470 kinds act=22 advance=15 wait=2 bounce=2 done=0 error=0 other=8
phases t10-saucedemo-checkout/forced attach=80 first_observe=12 observe=10+231 jev=132+3451 jev first/rest=203/131 act=0+562 settle=0+2392 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t10-saucedemo-checkout/forced attach=84 first_observe=12 observe=9+235 jev=150+3744 jev first/rest=155/145 act=0+589 settle=0+2413 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=78 first_observe=14 observe=9+128 jev=133+1721 jev first/rest=0/143 act=8+275 settle=107+1523 kinds act=7 advance=4 wait=0 bounce=2 done=0 error=0 other=1
phases t11-todomvc-spa/forced attach=82 first_observe=12 observe=9+131 jev=139+1772 jev first/rest=0/139 act=0+270 settle=0+1305 kinds act=6 advance=4 wait=0 bounce=2 done=0 error=0 other=1
phases t12-js-confirm-dialog/forced attach=45 first_observe=12 observe=10+19 jev=211+422 jev first/rest=294/128 act=44+87 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t12-js-confirm-dialog/forced attach=52 first_observe=12 observe=10+20 jev=167+333 jev first/rest=209/124 act=46+91 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t13-infinite-scroll/forced attach=54 first_observe=8 observe=8+80 jev=149+1438 jev first/rest=258/148 act=225+1432 settle=221+1973 kinds act=8 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t13-infinite-scroll/forced attach=47 first_observe=12 observe=8+72 jev=136+1394 jev first/rest=233/135 act=223+1415 settle=218+1966 kinds act=8 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t14-key-press/forced attach=64 first_observe=12 observe=8+51 jev=132+852 jev first/rest=138/132 act=0+133 settle=0+438 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t14-key-press/forced attach=68 first_observe=11 observe=9+51 jev=137+793 jev first/rest=115/137 act=0+133 settle=0+438 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=45 first_observe=9 observe=8+16 jev=187+373 jev first/rest=252/121 act=38+76 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t15-file-upload/forced attach=45 first_observe=11 observe=10+19 jev=196+391 jev first/rest=216/175 act=36+71 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=46 first_observe=11 observe=8+33 jev=147+638 jev first/rest=220/133 act=22+131 settle=108+434 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=75 first_observe=9 observe=8+67 jev=141+1160 jev first/rest=0/148 act=<withheld>+318 settle=214+1083 kinds act=5 advance=1 wait=0 bounce=2 done=0 error=0 other=1
phases t17-double-click/forced attach=<withheld> first_observe=10 observe=9+17 jev=161+322 jev first/rest=181/141 act=36+72 settle=116+232 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t17-double-click/forced attach=52 first_observe=11 observe=9+17 jev=206+412 jev first/rest=284/128 act=37+73 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty; pair lines aggregate repeats
```
