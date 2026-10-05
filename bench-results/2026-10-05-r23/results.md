# r23 - the deterministic publish run (HEAD 301431b on main)

**Verdict up front: NOT publish-ready. Forced 32/34 - both forced t13 cells failed, deterministically, on a LOCAL fixture, so it is a genuine defect finding (a fixture-parity gap), not site health. The t9 headline target (<= 4 calls) was also missed (8 and 5). README refresh from this run: NO.** Everything else held: invariant PASS, doctor 3/3, Part 1 all green, the live canaries healthy.

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99 (verified alive before every Chrome stage), cloud Sonnet caller, gate off, policy off, harness_version 3. `npm ci` skipped (lock unchanged); build ok (115 files); no `= true` KB flags. 15 of the 17 shapes ran on LOCAL fixtures; t10 (saucedemo) and t11 (todomvc) stayed live. Phase cap 83.609923 = ledger 67.609923 + 16, `--cap-usd 3.00`. **Spend 10.4420 USD** of 16 (one invocation).

## Part 1 (Chrome-only, 20 invocations) - all green, no re-runs
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo | **chain-e2e 20/20 (E12 green - the ccdb003 pin fix)** | pick-e2e 2/2 | adapter-cdp 10/10 | adapter-playwright 10/10 | page-scripts 30/30 | act-nav 7/7 | **fixture-server 14/14 (new)** | **bench-fixtures 14/14 (new)** | doctor 37/37 twice | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.

## The 68-cell acceptance
68/68 cells present, `aborted=null`, one invocation. **Forced 32/34**; playwright 32/34 (t15-file-upload x2, the tolerated one). Forced failures: **t13-infinite-scroll rep 1 and rep 2** (23.7 s and 24.9 s, 3 calls each, `end_state` "0 items | scrollY=0" both times). Every other forced cell passed, including t7, t9, t15, t17 and the live canaries.

### Why t13 fails - a deterministic fixture-parity defect
- **Trace:** all 6 forced t13 calls are identical: a single `scroll` act that waits its whole ~1.5 s growth budget (act 1513-1523 ms), reads "no visible change", and bounces `no-progress` (`countMetP` 0.14-0.18, never near 0.5). No site, no network: the host is `127.0.0.1`.
- **Mechanism (zero-spend probe, evidence/probe-geom.mjs):** `fixtures/pages/infinite_scroll.html` starts with only a heading and one link, so the page does not overflow the viewport. In headless Chrome on the repo fixture server: initial `innerHeight` 608 = `scrollHeight` 608, `scrollY` 0, 0 blocks. After `mouse.wheel(0, 0.8 x innerHeight)` - exactly what both adapters send - and 1.8 s: still `scrollY` 0, still 0 blocks. A wheel cannot scroll a non-overflowing page, so no `scroll` event fires and the fixture's scroll listener never appends. A synthetic `scroll` event does append (1 block). The deployed page uses jQuery jscroll (`$('.scroll').jscroll()`, confirmed in a live fetch), which loads a first block on init so the real page overflows; the local mirror's hand-written listener has no initial load.
- **Why playwright passes:** its caller drives the page with `browser_evaluate` (10 items, scrollY 3212), which can fire the scroll event itself. That is why the failure is forced-only.
- The bench-fixtures pins did not catch it. Not fixed (report-only).

## LIVE INVARIANT (typesafe.calls === tool_use_counts[browse_step])
```
results/gauntlet/invariant-check.py over the r23 file:
forced cells checked: 34   mismatches: 0   (sum typesafe.calls 71 == sum browse_step uses 71)
```
**Verdict: PASS.**

## The t9 deterministic headline - the target was NOT met
First t9 run with no site timing involved (local fixtures, 127.0.0.1):

| | r19 (live) | r21b (live) | r22 (live) | r23 (LOCAL) | target |
|---|---|---|---|---|---|
| forced calls per cell | 3 / 3 | 8 / 8 | 6 / 6 | **8 / 5** | <= 4 |
| forced rounds per cell | 48 / 49 | 61 / 61 | 53 / 53 | **58 / 37** | - |
| error ends per cell | 0 / 0 | 1 / 2 | 3 / 2 | **3 / 1** | 0 |
| forced wall | 43.3 / 46.6 s | 64.4 / 88.3 s | 94.5 / 86.8 s | **50.8 / 37.5 s** | - |
- **The recovery fragmentation is not (only) live-site timing:** it persists on a deterministic local server. `act-failed: locator.click: Timeout 3000ms exceeded` still ends calls on "go back" steps (twice in cell 1) - on `127.0.0.1`, so this is not network latency. F-2's resume skip never showed up: **no `resumeSkippedPostAction` field appears in any of the 71 log records**; the callers also restructured the chain between calls (`steps_total` 7 -> 6 -> 3 -> 2 and 7 -> 5 -> 3 -> 2), so a re-sent identical chain with a remembered post-action cursor did not occur.
- The first call now ends `step-uncertain` at step 2 of 7 ("open Checkboxes and tick the first checkbox", 6 rounds, 1.9 s) rather than the live-site step 5 - a different, shorter first call; the recovery after it is what costs the calls.
- Playwright t9: 28.8 / 31.5 s (median 30.2; r19 36.5).

## Deterministic metrics (comparable across cells for the first time)
- **t6 forced:** 52.2 / 47.3 s (median 49.7; r19 49.0), 2 / 3 calls, wait acts **7 / 9** (r19: 9, r21b: 7 / 10), act-time sum 19.2 / 25.3 s (each wait ~3 s). The wait COUNT is now measured on a deterministic page and is unchanged - confirming the withdrawn P-2 wait-count hypothesis was the right call to withdraw.
- **t12 forced:** 13.0 / 14.5 s (median 13.7; r19 17.0), 1 call each, 0 waits, same shape.
- **t14 forced:** 12.3 / 11.8 s (median 12.1; r19 13.5), 2 calls each, same shape (focus-only click bounce, then the press).
- **t13 forced:** failed (above); playwright 27.8 / 30.3 s (r19 18.1) - slower driving through evaluate on the local page.
- Jev first-round median 223 ms vs later rounds 139 ms (31 forced cells).

## Canary health (live: t10 saucedemo, t11 todomvc)
All four canary pairs passed: t10 forced 2/2 (23.2 / 20.4 s), playwright 2/2; t11 forced 2/2 (30.8 / 25.6 s), playwright 2/2. No site-health issue on the canaries; no environmental excuse needed for any failure in this run.

## r19 comparison (wall medians; +-15% bucket)
**17 of 34 pairs within +-15%**, and almost every pair outside it moved DOWN - local fixtures remove network time. Route medians: forced 13.5 -> 11.8 s, playwright 14.3 -> 12.5 s; usd medians forced 0.187 -> 0.162, playwright 0.192 -> 0.177 (usd sums forced 5.31 -> 5.03, playwright 5.81 -> 5.41). The only pairs that got slower are t13 on both routes (see above).
| task | route | r19 wall med s | r21b wall med s | r23 wall med s | r23 vs r19 | within +-15% |
|---|---|---|---|---|---|---|
| t1-checkboxes | playwright | 13.9 | 15.9 | 14.4 | +4% | yes |
| t1-checkboxes | forced | 11.4 | 11.4 | 10.7 | -6% | yes |
| t2-dropdown | playwright | 11.1 | 12.1 | 8.6 | -22% | NO |
| t2-dropdown | forced | 11.7 | 13.2 | 10.1 | -14% | yes |
| t3-dynamic-controls | playwright | 14.1 | 14.6 | 12.9 | -8% | yes |
| t3-dynamic-controls | forced | 17.6 | 16.2 | 15.3 | -13% | yes |
| t4-add-elements | playwright | 13.8 | 13.5 | 14.8 | +7% | yes |
| t4-add-elements | forced | 11.3 | 13.2 | 10.1 | -10% | yes |
| t5-inputs | playwright | 10.9 | 12.7 | 9.0 | -17% | NO |
| t5-inputs | forced | 10.4 | 10.7 | 9.8 | -6% | yes |
| t6-dynamic-loading | playwright | 34.6 | 27.7 | 15.3 | -56% | NO |
| t6-dynamic-loading | forced | 49.0 | 51.9 | 49.7 | +2% | yes |
| t7-sort-table | playwright | 14.4 | 13.5 | 11.7 | -19% | NO |
| t7-sort-table | forced | 11.4 | 10.5 | 10.0 | -13% | yes |
| t8-status-404 | playwright | 11.9 | 12.5 | 12.4 | +4% | yes |
| t8-status-404 | forced | 13.1 | 11.6 | 11.7 | -11% | yes |
| t9-long-chain | playwright | 36.5 | 37.2 | 30.2 | -17% | NO |
| t9-long-chain | forced | 44.9 | 76.4 | 44.1 | -2% | yes |
| t10-saucedemo-checkout | playwright | 22.1 | 26.9 | 18.6 | -16% | NO |
| t10-saucedemo-checkout | forced | 26.9 | 28.9 | 21.8 | -19% | NO |
| t11-todomvc-spa | playwright | 19.3 | 19.6 | 15.3 | -21% | NO |
| t11-todomvc-spa | forced | 24.7 | 30.1 | 28.2 | +14% | yes |
| t12-js-confirm-dialog | playwright | 13.3 | 14.5 | 10.9 | -18% | NO |
| t12-js-confirm-dialog | forced | 17.0 | 18.1 | 13.7 | -19% | NO |
| t13-infinite-scroll | playwright | 18.1 | 20.5 | 29.0 | +60% | NO |
| t13-infinite-scroll | forced | 14.4 | 15.5 | 24.3 | +69% | NO |
| t14-key-press | playwright | 13.9 | 15.0 | 11.5 | -17% | NO |
| t14-key-press | forced | 13.5 | 15.6 | 12.1 | -10% | yes |
| t15-file-upload | playwright | 16.0 | 16.3 | 13.1 | -18% | NO |
| t15-file-upload | forced | 11.4 | 11.0 | 9.7 | -14% | yes |
| t16-hover-reveal | playwright | 15.9 | 17.9 | 11.4 | -28% | NO |
| t16-hover-reveal | forced | 15.3 | 17.7 | 12.4 | -19% | NO |
| t17-double-click | playwright | 11.6 | 11.1 | 9.7 | -16% | NO |
| t17-double-click | forced | 11.7 | 10.8 | 10.3 | -12% | yes |


## herokuapp observational note (never the table)
Ten-request TTFB probe of `the-internet.herokuapp.com/infinite_scroll`: 0.36, 0.34, 0.15, **30.13**, 0.35, 0.23, **28.67**, 0.35, 0.16, **29.12** s - 3 of 10 stalled 28-30 s. The live site is still stalling (r22: 3 of 14; r22b: 3 of 10 plus 1 of 10 on `/`; now 3 of 10), so the migration to local fixtures was the right call. The live captcha recon (shipped scoped rule) reads `captcha=false` on bbc, npr and guardian. Raw data: results/observational/.

## Doctor x3 (bench Chrome, port 9344)
3 of 3 `verdict: PASS`; `coexistence: observer fingerprint identical across attach/detach (1 page(s))` each time. Part 1's doctor was 37/37 twice as well.

## Caveats
- n=2 per task x route. t10/t11 are the only live cells and both were healthy.
- One bound todo-text value appeared literally in a wingman log `step_text` (the caller typed it instead of naming the binding); it is redacted in the pushed log slice.
- Verbatim reporter output below has 2 numeric tokens replaced with `<withheld>` (and the comparison table 0) because a 2-character bound value collides with them in the pre-push scan; unmodified copies: results/gauntlet/.
- The t9 telemetry cannot say whether the F-1 retry fired (no field exists), only that the act-failed ends persist.

## Publish verdict
**Refresh the README from this run: NO.** (1) Forced is 32/34: t13 fails deterministically on the local fixture because the mirror lacks jscroll's initial block load, so a wheel cannot scroll the page - a fixture bug, fixable without touching the loop. (2) The t9 target (<= 4 calls) is missed on the deterministic fixture (8 and 5), so the recovery fragmentation is not explained by live-site timing alone, and the 3000 ms `locator.click` act-failed ends occur on a local server. Next steps for the integrator: give `infinite_scroll.html` an initial-load step (so the page overflows on load) and add a bench-fixtures pin that the page's `scrollHeight` exceeds the viewport; then re-run. For provenance the r21b run remains the best README source until then.

## Reporter output, verbatim (`node dist/bench/report.js results/gauntlet/r23-gauntlet-2026-10-05-043152.json`)
```
BENCH REPORT 2026-10-05-043152.json purpose=measure model=sonnet harness=3 aborted=null total_usd=10.441981 runs=68
cell t1-checkboxes playwright ok=true wall_s=19.2 usd=0.199593 llm_in=10 llm_out=266 llm_cache_read=245161 llm_cache_write=32540 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=11.2 usd=0.161917 llm_in=6 llm_out=224 llm_cache_read=135212 llm_cache_write=31422 ts_calls=1 ts_in=3406 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=8.9 usd=0.176606 llm_in=8 llm_out=233 llm_cache_read=189994 llm_cache_write=30957 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=10.6 usd=0.162256 llm_in=6 llm_out=243 llm_cache_read=135200 llm_cache_write=31435 ts_calls=1 ts_in=3620 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=12.3 usd=0.198335 llm_in=10 llm_out=343 llm_cache_read=247366 llm_cache_write=31720 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=13.2 usd=0.162579 llm_in=6 llm_out=247 llm_cache_read=135228 llm_cache_write=31456 ts_calls=1 ts_in=7804 ts_out=2010 fallbacks=0 rounds=4
cell t4-add-elements playwright ok=true wall_s=16.9 usd=0.200479 llm_in=10 llm_out=447 llm_cache_read=246539 llm_cache_write=31942 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=10.1 usd=0.161819 llm_in=6 llm_out=210 llm_cache_read=135204 llm_cache_write=31411 ts_calls=1 ts_in=7103 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=8.4 usd=0.178867 llm_in=8 llm_out=266 llm_cache_read=190943 llm_cache_write=31352 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=9.9 usd=0.162119 llm_in=6 llm_out=234 llm_cache_read=135214 llm_cache_write=31434 ts_calls=1 ts_in=3554 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=15.2 usd=0.180009 llm_in=8 llm_out=301 llm_cache_read=190599 llm_cache_write=31544 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=52.2 usd=0.22442 llm_in=12 llm_out=642 llm_cache_read=305271 llm_cache_write=32625 ts_calls=2 ts_in=19733 ts_out=4999 fallbacks=2 rounds=12
cell t7-sort-table playwright ok=true wall_s=11.7 usd=0.208995 llm_in=10 llm_out=368 llm_cache_read=250150 llm_cache_write=34240 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=10.2 usd=0.161906 llm_in=6 llm_out=219 llm_cache_read=135202 llm_cache_write=31418 ts_calls=1 ts_in=5351 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=15.5 usd=0.180226 llm_in=8 llm_out=286 llm_cache_read=191000 llm_cache_write=31630 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=11.6 usd=0.18312 llm_in=8 llm_out=383 llm_cache_read=191551 llm_cache_write=31888 ts_calls=2 ts_in=7276 ts_out=1865 fallbacks=1 rounds=5
cell t9-long-chain playwright ok=true wall_s=28.8 usd=0.383339 llm_in=24 llm_out=1889 llm_cache_read=682832 llm_cache_write=40022 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=50.8 usd=0.34491 llm_in=20 llm_out=2715 llm_cache_read=547789 llm_cache_write=35993 ts_calls=8 ts_in=114641 ts_out=28042 fallbacks=4 rounds=58
cell t10-saucedemo-checkout playwright ok=true wall_s=18.9 usd=0.232043 llm_in=12 llm_out=879 llm_cache_read=306707 llm_cache_write=33816 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=23.2 usd=0.21997 llm_in=10 llm_out=1234 llm_cache_read=249486 llm_cache_write=33124 ts_calls=3 ts_in=56419 ts_out=13925 fallbacks=1 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=14.7 usd=0.247292 llm_in=14 llm_out=620 llm_cache_read=366940 llm_cache_write=34098 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=30.8 usd=0.353527 llm_in=22 llm_out=1919 llm_cache_read=610739 llm_cache_write=37316 ts_calls=6 ts_in=36162 ts_out=9375 fallbacks=4 rounds=20
cell t12-js-confirm-dialog playwright ok=true wall_s=11.1 usd=0.198176 llm_in=10 llm_out=378 llm_cache_read=246962 llm_cache_write=31570 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=13.0 usd=0.202302 llm_in=10 llm_out=403 llm_cache_read=248338 llm_cache_write=32371 ts_calls=1 ts_in=7960 ts_out=1896 fallbacks=1 rounds=5
cell t13-infinite-scroll playwright ok=true wall_s=27.8 usd=0.228604 llm_in=12 llm_out=909 llm_cache_read=304344 llm_cache_write=32968 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=false wall_s=23.7 usd=0.228011 llm_in=12 llm_out=865 llm_cache_read=305481 llm_cache_write=32798 ts_calls=3 ts_in=8645 ts_out=2292 fallbacks=3 rounds=6
cell t14-key-press playwright ok=true wall_s=12.2 usd=0.196039 llm_in=10 llm_out=299 llm_cache_read=246552 llm_cache_write=31349 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=12.3 usd=0.183457 llm_in=8 llm_out=389 llm_cache_read=191574 llm_cache_write=31914 ts_calls=2 ts_in=10672 ts_out=2733 fallbacks=1 rounds=7
cell t15-file-upload playwright ok=false wall_s=12.7 usd=0.202203 llm_in=10 llm_out=701 llm_cache_read=246485 llm_cache_write=31390 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=9.9 usd=0.163067 llm_in=6 llm_out=275 llm_cache_read=135284 llm_cache_write=31516 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=11.8 usd=0.196455 llm_in=10 llm_out=339 llm_cache_read=246262 llm_cache_write=31323 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=10.1 usd=0.162104 llm_in=6 llm_out=225 llm_cache_read=135212 llm_cache_write=31430 ts_calls=1 ts_in=6785 ts_out=1794 fallbacks=0 rounds=4
cell t17-double-click playwright ok=true wall_s=10.1 usd=0.177975 llm_in=8 llm_out=266 llm_cache_read=190495 llm_cache_write=31150 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=9.9 usd=0.16213 llm_in=6 llm_out=246 llm_cache_read=135188 llm_cache_write=31395 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
cell t1-checkboxes playwright ok=true wall_s=9.7 usd=0.071781 llm_in=8 llm_out=228 llm_cache_read=220715 llm_cache_write=566 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=10.3 usd=0.054434 llm_in=6 llm_out=223 llm_cache_read=166361 llm_cache_write=272 ts_calls=1 ts_in=3406 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=8.3 usd=0.071735 llm_in=8 llm_out=233 llm_cache_read=220398 llm_cache_write=559 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=9.6 usd=0.054813 llm_in=6 llm_out=243 llm_cache_read=166343 llm_cache_write=292 ts_calls=1 ts_in=3620 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=13.5 usd=0.092019 llm_in=10 llm_out=343 llm_cache_read=278192 llm_cache_write=903 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=17.5 usd=0.080647 llm_in=8 llm_out=634 llm_cache_read=222780 llm_cache_write=1008 ts_calls=2 ts_in=11890 ts_out=3048 fallbacks=2 rounds=7
cell t4-add-elements playwright ok=true wall_s=12.7 usd=0.095338 llm_in=10 llm_out=450 llm_cache_read=277044 llm_cache_write=1452 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=10.1 usd=0.054369 llm_in=6 llm_out=210 llm_cache_read=166349 llm_cache_write=266 ts_calls=1 ts_in=7103 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=9.6 usd=0.074351 llm_in=8 llm_out=250 llm_cache_read=219831 llm_cache_write=1234 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=9.7 usd=0.054651 llm_in=6 llm_out=234 llm_cache_read=166364 llm_cache_write=284 ts_calls=1 ts_in=3554 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=15.4 usd=0.074533 llm_in=8 llm_out=329 llm_cache_read=221300 llm_cache_write=849 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=47.3 usd=0.157797 llm_in=16 llm_out=809 llm_cache_read=451995 llm_cache_write=2392 ts_calls=3 ts_in=24885 ts_out=6334 fallbacks=3 rounds=15
cell t7-sort-table playwright ok=true wall_s=11.7 usd=0.103182 llm_in=10 llm_out=333 llm_cache_read=280651 llm_cache_write=3723 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=9.8 usd=0.05444 llm_in=6 llm_out=218 llm_cache_read=166346 llm_cache_write=273 ts_calls=1 ts_in=5349 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=9.3 usd=0.073523 llm_in=8 llm_out=240 llm_cache_read=221735 llm_cache_write=901 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=11.8 usd=0.075849 llm_in=8 llm_out=391 llm_cache_read=222694 llm_cache_write=759 ts_calls=2 ts_in=7276 ts_out=1864 fallbacks=1 rounds=5
cell t9-long-chain playwright ok=true wall_s=31.5 usd=0.318029 llm_in=30 llm_out=1820 llm_cache_read=879896 llm_cache_write=7112 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=37.5 usd=0.206869 llm_in=18 llm_out=2299 llm_cache_read=515799 llm_cache_write=3830 ts_calls=5 ts_in=76864 ts_out=20235 fallbacks=3 rounds=37
cell t10-saucedemo-checkout playwright ok=true wall_s=18.3 usd=0.124806 llm_in=12 llm_out=907 llm_cache_read=338014 llm_cache_write=2603 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=20.4 usd=0.088957 llm_in=8 llm_out=987 llm_cache_read=223274 llm_cache_write=1253 ts_calls=2 ts_in=58252 ts_out=14188 fallbacks=0 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=16.0 usd=0.145093 llm_in=14 llm_out=626 llm_cache_read=396879 llm_cache_write=4426 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=25.6 usd=0.205206 llm_in=18 llm_out=1601 llm_cache_read=521070 llm_cache_write=6300 ts_calls=5 ts_in=28353 ts_out=7352 fallbacks=3 rounds=16
cell t12-js-confirm-dialog playwright ok=true wall_s=10.7 usd=0.09605 llm_in=10 llm_out=327 llm_cache_read=277404 llm_cache_write=2105 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=14.5 usd=0.114916 llm_in=12 llm_out=515 llm_cache_read=336607 llm_cache_write=1557 ts_calls=1 ts_in=7960 ts_out=1896 fallbacks=1 rounds=5
cell t13-infinite-scroll playwright ok=true wall_s=30.3 usd=0.138873 llm_in=14 llm_out=907 llm_cache_read=391284 llm_cache_write=2091 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=false wall_s=24.9 usd=0.141385 llm_in=14 llm_out=1027 llm_cache_read=394196 llm_cache_write=1951 ts_calls=3 ts_in=8645 ts_out=2292 fallbacks=3 rounds=6
cell t14-key-press playwright ok=true wall_s=10.9 usd=0.089076 llm_in=10 llm_out=299 llm_cache_read=277556 llm_cache_write=345 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=11.8 usd=0.075681 llm_in=8 llm_out=375 llm_cache_read=222715 llm_cache_write=759 ts_calls=2 ts_in=8851 ts_out=2266 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=13.5 usd=0.095801 llm_in=10 llm_out=715 llm_cache_read=277387 llm_cache_write=488 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=9.6 usd=0.055478 llm_in=6 llm_out=275 llm_cache_read=166469 llm_cache_write=331 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=11.1 usd=0.090095 llm_in=10 llm_out=339 llm_cache_read=277091 llm_cache_write=494 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=14.7 usd=0.098341 llm_in=10 llm_out=615 llm_cache_read=279653 llm_cache_write=1289 ts_calls=3 ts_in=8475 ts_out=2261 fallbacks=2 rounds=7
cell t17-double-click playwright ok=true wall_s=9.4 usd=0.074246 llm_in=8 llm_out=251 llm_cache_read=219707 llm_cache_write=1212 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=10.7 usd=0.054767 llm_in=6 llm_out=250 llm_cache_read=166325 llm_cache_write=258 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
route playwright n=34 ok=32/34 wall_s min=8.3 med=12.5 max=31.5 usd min=0.071735 med=0.17729050000000002 max=0.383339
route forced n=34 ok=32/34 wall_s min=9.6 med=11.8 max=52.2 usd min=0.054369 med=0.16191149999999999 max=0.353527
pair t1-checkboxes playwright n=2 ok=2/2 wall_s min=9.7 med=14.4 max=19.2 usd_med=0.135687
pair t1-checkboxes forced n=2 ok=2/2 wall_s min=10.3 med=10.7 max=11.2 usd_med=0.108176
pair t2-dropdown playwright n=2 ok=2/2 wall_s min=8.3 med=8.6 max=8.9 usd_med=0.124171
pair t2-dropdown forced n=2 ok=2/2 wall_s min=9.6 med=10.1 max=10.6 usd_med=0.108535
pair t3-dynamic-controls playwright n=2 ok=2/2 wall_s min=12.3 med=12.9 max=13.5 usd_med=0.145177
pair t3-dynamic-controls forced n=2 ok=2/2 wall_s min=13.2 med=15.3 max=17.5 usd_med=0.121613
pair t4-add-elements playwright n=2 ok=2/2 wall_s min=12.7 med=14.8 max=16.9 usd_med=0.147909
pair t4-add-elements forced n=2 ok=2/2 wall_s min=10.1 med=10.1 max=10.1 usd_med=0.108094
pair t5-inputs playwright n=2 ok=2/2 wall_s min=8.4 med=9.0 max=9.6 usd_med=0.126609
pair t5-inputs forced n=2 ok=2/2 wall_s min=9.7 med=9.8 max=9.9 usd_med=0.108385
pair t6-dynamic-loading playwright n=2 ok=2/2 wall_s min=15.2 med=15.3 max=15.4 usd_med=0.127271
pair t6-dynamic-loading forced n=2 ok=2/2 wall_s min=47.3 med=49.7 max=52.2 usd_med=0.191109
pair t7-sort-table playwright n=2 ok=2/2 wall_s min=11.7 med=11.7 max=11.7 usd_med=0.156089
pair t7-sort-table forced n=2 ok=2/2 wall_s min=9.8 med=10.0 max=10.2 usd_med=0.108173
pair t8-status-404 playwright n=2 ok=2/2 wall_s min=9.3 med=12.4 max=15.5 usd_med=0.126875
pair t8-status-404 forced n=2 ok=2/2 wall_s min=11.6 med=11.7 max=11.8 usd_med=0.129485
pair t9-long-chain playwright n=2 ok=2/2 wall_s min=28.8 med=30.2 max=31.5 usd_med=0.350684
pair t9-long-chain forced n=2 ok=2/2 wall_s min=37.5 med=44.1 max=50.8 usd_med=0.27589
pair t10-saucedemo-checkout playwright n=2 ok=2/2 wall_s min=18.3 med=18.6 max=18.9 usd_med=0.178425
pair t10-saucedemo-checkout forced n=2 ok=2/2 wall_s min=20.4 med=21.8 max=23.2 usd_med=0.154464
pair t11-todomvc-spa playwright n=2 ok=2/2 wall_s min=14.7 med=15.3 max=16.0 usd_med=0.196193
pair t11-todomvc-spa forced n=2 ok=2/2 wall_s min=25.6 med=28.2 max=30.8 usd_med=0.279366
pair t12-js-confirm-dialog playwright n=2 ok=2/2 wall_s min=10.7 med=10.9 max=11.1 usd_med=0.147113
pair t12-js-confirm-dialog forced n=2 ok=2/2 wall_s min=13.0 med=13.7 max=14.5 usd_med=0.158609
pair t13-infinite-scroll playwright n=2 ok=2/2 wall_s min=27.8 med=29.0 max=30.3 usd_med=0.183739
pair t13-infinite-scroll forced n=2 ok=0/2 wall_s min=23.7 med=24.3 max=24.9 usd_med=0.184698
pair t14-key-press playwright n=2 ok=2/2 wall_s min=10.9 med=11.5 max=12.2 usd_med=0.142558
pair t14-key-press forced n=2 ok=2/2 wall_s min=11.8 med=12.1 max=12.3 usd_med=0.129569
pair t15-file-upload playwright n=2 ok=0/2 wall_s min=12.7 med=13.1 max=13.5 usd_med=0.149002
pair t15-file-upload forced n=2 ok=2/2 wall_s min=9.6 med=9.7 max=9.9 usd_med=0.109273
pair t16-hover-reveal playwright n=2 ok=2/2 wall_s min=11.1 med=11.4 max=11.8 usd_med=0.143275
pair t16-hover-reveal forced n=2 ok=2/2 wall_s min=10.1 med=12.4 max=14.7 usd_med=0.130222
pair t17-double-click playwright n=2 ok=2/2 wall_s min=9.4 med=9.7 max=10.1 usd_med=0.126111
pair t17-double-click forced n=2 ok=2/2 wall_s min=9.9 med=10.3 max=10.7 usd_med=0.108449
phases t1-checkboxes/forced attach=67 first_observe=25 observe=17+34 jev=208+416 jev first/rest=276/140 act=66+132 settle=113+225 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=55 first_observe=10 observe=10+19 jev=190+380 jev first/rest=254/126 act=45+89 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=79 first_observe=14 observe=10+43 jev=133+608 jev first/rest=221/127 act=59+2952 settle=112+466 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t4-add-elements/forced attach=80 first_observe=16 observe=9+41 jev=143+688 jev first/rest=273/136 act=53+220 settle=221+673 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=59 first_observe=12 observe=12+23 jev=261+522 jev first/rest=318/204 act=40+79 settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=85 first_observe=10 observe=10+115 jev=135+1739 jev first/rest=138/135 act=2029+19198 settle=220+1769 kinds act=1 advance=1 wait=7 bounce=2 done=0 error=0 other=1
phases t7-sort-table/forced attach=56 first_observe=14 observe=14+27 jev=192+384 jev first/rest=236/148 act=52+104 settle=114+228 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=100 first_observe=17 observe=10+53 jev=139+735 jev first/rest=133/139 act=0+102 settle=0+275 kinds act=1 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t9-long-chain/forced attach=191 first_observe=19 observe=10+597 jev=133+8391 jev first/rest=137/132 act=0+1670 settle=0+5813 kinds act=24 advance=15 wait=0 bounce=6 done=0 error=3 other=10
phases t10-saucedemo-checkout/forced attach=118 first_observe=15 observe=11+287 jev=148+3834 jev first/rest=232/144 act=0+676 settle=0+2511 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=155 first_observe=21 observe=12+238 jev=148+2635 jev first/rest=0/155 act=0+534 settle=0+1766 kinds act=8 advance=3 wait=0 bounce=6 done=0 error=0 other=3
phases t12-js-confirm-dialog/forced attach=55 first_observe=16 observe=10+53 jev=169+891 jev first/rest=255/166 act=0+156 settle=0+226 kinds act=1 advance=1 wait=0 bounce=1 done=0 error=0 other=2
phases t13-infinite-scroll/forced attach=107 first_observe=15 observe=9+56 jev=149+907 jev first/rest=201/135 act=757+4550 settle=109+657 kinds act=3 advance=0 wait=0 bounce=3 done=0 error=0 other=0
phases t14-key-press/forced attach=82 first_observe=14 observe=9+66 jev=139+942 jev first/rest=126/139 act=0+168 settle=0+463 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=2
phases t15-file-upload/forced attach=68 first_observe=16 observe=11+22 jev=202+404 jev first/rest=258/146 act=34+68 settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=53 first_observe=11 observe=11+40 jev=211+837 jev first/rest=243/178 act=20+136 settle=111+443 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t17-double-click/forced attach=56 first_observe=10 observe=10+19 jev=221+441 jev first/rest=321/120 act=51+102 settle=112+224 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t1-checkboxes/forced attach=<withheld> first_observe=16 observe=13+26 jev=183+366 jev first/rest=238/128 act=64+128 settle=112+224 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=58 first_observe=13 observe=11+22 jev=192+384 jev first/rest=248/136 act=36+71 settle=111+221 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=<withheld> first_observe=16 observe=11+79 jev=138+1021 jev first/rest=145/138 act=26+2991 settle=220+904 kinds act=4 advance=1 wait=0 bounce=2 done=0 error=0 other=0
phases t4-add-elements/forced attach=68 first_observe=15 observe=8+39 jev=146+642 jev first/rest=221/142 act=44+179 settle=221+671 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=58 first_observe=16 observe=12+24 jev=177+353 jev first/rest=212/141 act=40+79 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=100 first_observe=15 observe=9+143 jev=138+2126 jev first/rest=178/136 act=3006+25250 settle=220+2291 kinds act=1 advance=1 wait=9 bounce=3 done=0 error=0 other=1
phases t7-sort-table/forced attach=52 first_observe=17 observe=14+28 jev=184+368 jev first/rest=238/130 act=46+92 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=76 first_observe=13 observe=10+54 jev=129+686 jev first/rest=126/129 act=0+113 settle=0+334 kinds act=1 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t9-long-chain/forced attach=155 first_observe=12 observe=9+379 jev=137+5558 jev first/rest=131/138 act=0+1060 settle=0+4054 kinds act=17 advance=13 wait=0 bounce=3 done=0 error=1 other=3
phases t10-saucedemo-checkout/forced attach=101 first_observe=16 observe=10+262 jev=148+3744 jev first/rest=204/147 act=0+586 settle=0+2485 kinds act=11 advance=11 wait=0 bounce=0 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=145 first_observe=17 observe=11+188 jev=140+1831 jev first/rest=0/143 act=0+352 settle=0+1327 kinds act=6 advance=4 wait=0 bounce=4 done=0 error=0 other=2
phases t12-js-confirm-dialog/forced attach=76 first_observe=19 observe=10+57 jev=147+885 jev first/rest=272/142 act=0+112 settle=0+230 kinds act=1 advance=1 wait=0 bounce=1 done=0 error=0 other=2
phases t13-infinite-scroll/forced attach=107 first_observe=13 observe=10+60 jev=145+841 jev first/rest=146/144 act=759+4556 settle=112+672 kinds act=3 advance=0 wait=0 bounce=3 done=0 error=0 other=0
phases t14-key-press/forced attach=76 first_observe=18 observe=10+66 jev=152+873 jev first/rest=119/152 act=0+146 settle=0+437 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=72 first_observe=12 observe=11+21 jev=238+476 jev first/rest=300/176 act=33+66 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=106 first_observe=13 observe=10+71 jev=147+861 jev first/rest=0/151 act=0+264 settle=0+704 kinds act=3 advance=1 wait=0 bounce=2 done=0 error=0 other=1
phases t17-double-click/forced attach=55 first_observe=10 observe=9+18 jev=186+372 jev first/rest=223/149 act=53+106 settle=114+227 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty; pair lines aggregate repeats
```
