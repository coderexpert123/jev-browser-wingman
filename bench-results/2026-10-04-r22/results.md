# r22 - the clean publish run attempt (HEAD 5c13fa0 on main)

**Verdict up front: NOT publish-ready. Forced 33/34 (t13 failed, and failed again on the one allowed re-run), the t9 recovery targets were not met, and the run coincided with an intermittent ~30 s stall on the live site. Refresh the README from this run: NO.** The invariant, doctor and the rest of the suite are green. Nothing was fixed or committed to main.

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99, cloud Sonnet caller, gate off, policy off, harness_version 3. `npm ci` skipped (lock unchanged); build ok (113 files); no `= true` KB flags; the rejected P-5 candidacy is reverted on main (c666906). Phase cap 73.245369 = ledger 57.245369 + 16, `--cap-usd 3.00`. **Spend 10.3646 USD** of 16 (gauntlet 10.1622 + one t13 re-run 0.2024).

## Part 1 (Chrome-only, 18 invocations) - one stale pin
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O8 passes) | **chain-e2e nineteen pass + 1 FAIL: E12** | pick-e2e 2/2 | adapter-cdp 10/10 | adapter-playwright 10/10 | page-scripts 30/30 | act-nav 7/7 (tightened T-cdp-preclick, new T-cdp-wait-growth) | doctor 37/37 twice | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.
- **E12** (r15: "a same-address submit that leaves the page not ready ends post-action, and the resume never re-submits") fails 2 of 2 runs: it expects the second call's `step_review.why === 'repeat'` and gets `'no-match'`. Mechanism: F-2 (resume-cheap) - the re-sent chain now advances past the remembered post-action clause (progress step 2, 1 done) and ends no-match on "click Done" instead of bouncing at the cursor. The spec never mentions E12. **Diagnostic (scratch copy of the compiled test with only that assertion replaced by a log line, run alone, deleted):** E12 then passes through its safety assertion, `submitCounts() == ['1','1']` - one submit and no reload - so the "never re-submits" guarantee holds; only the `repeat` expectation is stale (same family as r21's O8). Not fixed.

## Environment incident (zero spend)
The first two gauntlet launches died with `ensureChrome failed: Chrome did not answer on port 9344 within 10 s` before any cell (no results file; ledger unchanged). Cause: the Xvfb from session start had exited and left a stale `/tmp/.X99-lock` (its pid had been reused by a kernel worker), so the headed bench Chrome had no display; Part 1 uses headless Chrome and was unaffected. I removed the stale lock/socket, restarted Xvfb, verified `chrome ensure`, and the third launch ran. This is not the documented cold-start flake, so the one-clean-retry rule did not apply.

## The 68-cell run (one invocation) - acceptance NOT met
68/68 cells, `aborted=null`. **Forced 33/34**; playwright 32/34 (t15-file-upload x2, the tolerated one).
- **The failed forced cell: t13-infinite-scroll rep 1** (23.8 s, 3 calls, `end_state` "1 items | scrollY=0"). Log: three calls, each a single scroll act that waited the whole ~1.5 s growth budget, read "no visible change", and bounced `no-progress` (`countMetP` 0.14-0.18); the page never moved. Rep 2 passed (12.7 s, 10 items, 1 call, 8 scrolls, `countEvidence` 10).
- **The one allowed re-run of that cell** (t13 forced x1, 0.2024 USD): **failed again** - 30.7 s, 4 calls, "3 items | scrollY=332". t13 forced thus failed 2 of 3 attempts this evening after passing in every earlier round (r17c through r21b).
- **Zero-spend probe that explains the difference:** timing `the-internet.herokuapp.com/infinite_scroll` with curl, about 3 of 14 requests across the session returned their first byte after **29-30 s** (29.4, 30.2, 30.2 s) while the rest answered in 0.13-0.65 s - the live site intermittently stalls ~30 s. Infinite scroll appends each block with a request to that host, so a stalled block never lands inside the growth wait: that predicts exactly "few items, scrollY 0-332". A probe through the bench Chrome (6 fresh t13 loads + driver scroll) could not finish: its first `Page.navigate` timed out on the same stall. I mark this **a defect-class finding with a strong external cause, not a known-failing shape**: it is not deterministic, and I cannot prove from here that the wingman is blameless.

## LIVE INVARIANT (typesafe.calls === tool_use_counts[browse_step])
```
results/gauntlet/invariant-check.py over the r22 file:
forced cells checked: 34   mismatches: 0   (sum typesafe.calls 63 == sum browse_step uses 63)
```
**Verdict: PASS.**

## The t9 deliverable (primary): the target was NOT met
| metric | r19 | r21b | r22 | target |
|---|---|---|---|---|
| t9 forced calls per cell | 3 / 3 | 8 / 8 | **6 / 6** | <= 4 |
| t9 forced rounds per cell | 48 / 49 | 61 / 61 | 53 / 53 | - |
| error ends per cell | 0 / 0 | 1 / 2 | **3 / 2** | 0 |
| act time sum per cell | 5.1 / 5.1 s | 2.0 / 2.3 s | **16.7 / 14.0 s** | - |
| t9 forced wall | 43.3 / 46.6 s | 64.4 / 88.3 s | **94.5 / 86.8 s** | - |
- Round kinds, cell 1: act 22, advance 13, wait 5, bounce 2, error 3, other 8; cell 2: act 23, advance 12, wait 4, bounce 4, error 2, other 8. Both cells passed.
- **The nav-shaped failures survive F-1:** cell 1's first call ended `act-failed: evaluation timed out` after 25.3 s (9 rounds: click 2, check 1, back 1); a later call ended `locator.click: Timeout 3000ms exceeded` (7.8 s); cell 2's call ended `act-failed: evaluation timed out` after 23.5 s. The log carries no field that says whether F-1's retry fired, but the call durations show waiting, and the failures still end the call. Full round traces: evidence/t9-round-trace.json.
- **F-2 never had a chance to fire:** the caller restructured the chain between calls (`steps_total` 7 -> 5 -> 4), so there was never a re-sent chain with a remembered post-action cursor, and no `resumeSkippedPostAction` field appears in any of the 63 log records. The t9 call-count target is "reachable by design" only when the caller re-sends the same chain; this run's caller did not.
- **Not attributable to the wingman alone:** playwright t9 slowed the same way (40.1 s and **100.0 s**, median 70.1 vs 36.5 s in r19), and that cell uses no wingman code. On both routes t9 doubled while nearly every other cell got faster - consistent with the site stalls hitting a navigation-heavy chain.

## t6 and t12 (vs r19 / r21b)
- t6 forced: 36.9 / 45.4 s (median 41.1; r19 49.0, r21b 51.9), 2 calls, wait acts 7 / 10 (unchanged), act-time sum 19.4 / 28.2 s (unchanged). -16% vs r19, but the playwright t6 cells fell further (19.8 s vs 34.6 s), so no t6 speed credit is claimed.
- t12 forced: 13.1 / 15.8 s (median 14.4 vs 17.0 / 18.1), 1 call each, 0 waits, unchanged shape.

## r19 comparison - and why it is not usable as a "within noise" read this time
Most simple cells were 15-43% FASTER than r19 on both routes (forced median wall 13.5 -> 10.8 s, playwright 14.3 -> 11.5 s), so only 8 of 34 pairs fall within +-15% of r19 - in the wrong direction for a noise check; t9 moved the other way (+92% playwright, +102% forced). Both routes move together, so route-vs-route is the only fair reading; usd medians: forced 0.187 -> 0.158, playwright 0.192 -> 0.174.
| task | route | r19 wall med s | r21b wall med s | r22 wall med s | r22 vs r19 | within +-15% |
|---|---|---|---|---|---|---|
| t1-checkboxes | playwright | 13.9 | 15.9 | 36.3 | +161% | NO |
| t1-checkboxes | forced | 11.4 | 11.4 | 9.4 | -17% | NO |
| t2-dropdown | playwright | 11.1 | 12.1 | 7.9 | -29% | NO |
| t2-dropdown | forced | 11.7 | 13.2 | 9.3 | -20% | NO |
| t3-dynamic-controls | playwright | 14.1 | 14.6 | 12.3 | -13% | yes |
| t3-dynamic-controls | forced | 17.6 | 16.2 | 13.9 | -21% | NO |
| t4-add-elements | playwright | 13.8 | 13.5 | 12.5 | -10% | yes |
| t4-add-elements | forced | 11.3 | 13.2 | 9.8 | -13% | yes |
| t5-inputs | playwright | 10.9 | 12.7 | 9.0 | -17% | NO |
| t5-inputs | forced | 10.4 | 10.7 | 8.8 | -15% | NO |
| t6-dynamic-loading | playwright | 34.6 | 27.7 | 19.8 | -43% | NO |
| t6-dynamic-loading | forced | 49.0 | 51.9 | 41.1 | -16% | NO |
| t7-sort-table | playwright | 14.4 | 13.5 | 10.6 | -27% | NO |
| t7-sort-table | forced | 11.4 | 10.5 | 8.8 | -23% | NO |
| t8-status-404 | playwright | 11.9 | 12.5 | 8.7 | -27% | NO |
| t8-status-404 | forced | 13.1 | 11.6 | 9.4 | -28% | NO |
| t9-long-chain | playwright | 36.5 | 37.2 | 70.1 | +92% | NO |
| t9-long-chain | forced | 44.9 | 76.4 | 90.7 | +102% | NO |
| t10-saucedemo-checkout | playwright | 22.1 | 26.9 | 17.7 | -20% | NO |
| t10-saucedemo-checkout | forced | 26.9 | 28.9 | 23.6 | -13% | yes |
| t11-todomvc-spa | playwright | 19.3 | 19.6 | 15.7 | -19% | NO |
| t11-todomvc-spa | forced | 24.7 | 30.1 | 20.2 | -18% | NO |
| t12-js-confirm-dialog | playwright | 13.3 | 14.5 | 10.9 | -18% | NO |
| t12-js-confirm-dialog | forced | 17.0 | 18.1 | 14.4 | -15% | yes |
| t13-infinite-scroll | playwright | 18.1 | 20.5 | 16.7 | -8% | yes |
| t13-infinite-scroll | forced | 14.4 | 15.5 | 18.3 | +27% | NO |
| t14-key-press | playwright | 13.9 | 15.0 | 9.4 | -32% | NO |
| t14-key-press | forced | 13.5 | 15.6 | 11.8 | -12% | yes |
| t15-file-upload | playwright | 16.0 | 16.3 | 12.2 | -24% | NO |
| t15-file-upload | forced | 11.4 | 11.0 | 9.7 | -15% | yes |
| t16-hover-reveal | playwright | 15.9 | 17.9 | 10.6 | -33% | NO |
| t16-hover-reveal | forced | 15.3 | 17.7 | 12.4 | -19% | NO |
| t17-double-click | playwright | 11.6 | 11.1 | 8.5 | -27% | NO |
| t17-double-click | forced | 11.7 | 10.8 | 8.9 | -24% | NO |


## Doctor x3 (bench Chrome, port 9344)
3 of 3 `verdict: PASS`; `coexistence: observer fingerprint identical across attach/detach (1 page(s))` each time. Part 1's doctor was 37/37 twice as well.

## Caveats
- n=2 per task x route; the run was measured while the live site was intermittently stalling (~30 s first-byte on roughly one request in five); one time-of-day effect made most simple cells faster.
- Whether F-1's retry fired and whether F-2 skipped anything cannot be read from the log (no telemetry fired for F-2; none exists for F-1).
- t15 playwright is still undiagnosed; E12 and (previously) O8 are stale pins left for the integrator.
- Verbatim reporter output below has 3 numeric tokens replaced with `<withheld>` (and the comparison table 0) because a 2-character bound value collides with them in the pre-push scan; unmodified copies are in results/gauntlet/.

## Publish verdict
**Refresh the README from this run: NO.** (1) Forced 33/34 misses the publish bar (and the single allowed re-run of the failed cell failed too). (2) The t9 deliverable missed: 6 calls per cell against a target of 4, 2-3 error ends against 0, and the mid-navigation `evaluation timed out` / `locator.click` failures still occur. (3) The environment was not clean: the site stalled ~30 s on roughly 1 request in 5, which can independently produce both the t13 and the t9 symptoms. The r21b run (forced 34/34, one clean 68-cell invocation) remains the better README source. Recommended before the next attempt: add a pre-flight site-health check (a few timed requests; abort the run if any exceed a few seconds) so a stalled site cannot spoil a publish run; update E12; and re-run when the site answers consistently.

## Reporter output, verbatim (`node dist/bench/report.js results/gauntlet/r22-gauntlet-2026-10-04-163436.json`)
```
BENCH REPORT 2026-10-04-163436.json purpose=measure model=sonnet harness=3 aborted=null total_usd=10.162176 runs=68
cell t1-checkboxes playwright ok=true wall_s=16.4 usd=0.19657 llm_in=10 llm_out=266 llm_cache_read=242234 llm_cache_write=31968 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=10.0 usd=0.158499 llm_in=6 llm_out=224 llm_cache_read=133640 llm_cache_write=30636 ts_calls=1 ts_in=3420 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=8.4 usd=0.174064 llm_in=8 llm_out=257 llm_cache_read=187782 llm_cache_write=30360 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=9.9 usd=0.158838 llm_in=6 llm_out=243 llm_cache_read=133628 llm_cache_write=30649 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=12.2 usd=0.1959 llm_in=10 llm_out=368 llm_cache_read=244687 llm_cache_write=31185 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=16.1 usd=0.180947 llm_in=8 llm_out=366 llm_cache_read=189265 llm_cache_write=31529 ts_calls=1 ts_in=9993 ts_out=2529 fallbacks=1 rounds=5
cell t4-add-elements playwright ok=true wall_s=13.4 usd=0.198235 llm_in=10 llm_out=450 llm_cache_read=243808 llm_cache_write=31550 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=9.8 usd=0.158401 llm_in=6 llm_out=210 llm_cache_read=133632 llm_cache_write=30625 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=9.0 usd=0.175803 llm_in=8 llm_out=266 llm_cache_read=188731 llm_cache_write=30712 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=9.1 usd=0.1587 llm_in=6 llm_out=234 llm_cache_read=133642 llm_cache_write=30648 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=25.8 usd=0.178253 llm_in=8 llm_out=354 llm_cache_read=188396 llm_cache_write=31040 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=36.9 usd=0.22075 llm_in=12 llm_out=581 llm_cache_read=301636 llm_cache_write=32178 ts_calls=2 ts_in=20020 ts_out=4999 fallbacks=2 rounds=12
cell t7-sort-table playwright ok=true wall_s=11.1 usd=0.205275 llm_in=10 llm_out=334 llm_cache_read=247311 llm_cache_write=33611 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=8.8 usd=0.158486 llm_in=6 llm_out=219 llm_cache_read=133630 llm_cache_write=30632 ts_calls=1 ts_in=5331 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=8.9 usd=0.176773 llm_in=8 llm_out=240 llm_cache_read=188788 llm_cache_write=31070 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=9.3 usd=0.158097 llm_in=6 llm_out=204 llm_cache_read=133620 llm_cache_write=30609 ts_calls=1 ts_in=3560 ts_out=899 fallbacks=0 rounds=2
cell t9-long-chain playwright ok=true wall_s=40.1 usd=0.413767 llm_in=28 llm_out=1719 llm_cache_read=805992 llm_cache_write=38960 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=94.5 usd=0.364776 llm_in=22 llm_out=3146 llm_cache_read=597788 llm_cache_write=35654 ts_calls=6 ts_in=106703 ts_out=26624 fallbacks=2 rounds=53
cell t10-saucedemo-checkout playwright ok=true wall_s=16.5 usd=0.229304 llm_in=12 llm_out=946 llm_cache_read=302465 llm_cache_write=33157 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=23.1 usd=0.219816 llm_in=10 llm_out=1431 llm_cache_read=246498 llm_cache_write=32534 ts_calls=3 ts_in=56413 ts_out=13926 fallbacks=1 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=14.9 usd=0.242892 llm_in=14 llm_out=618 llm_cache_read=362224 llm_cache_write=33310 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=23.5 usd=0.301342 llm_in=18 llm_out=1581 llm_cache_read=481082 llm_cache_write=35215 ts_calls=6 ts_in=28396 ts_out=7351 fallbacks=3 rounds=16
cell t12-js-confirm-dialog playwright ok=true wall_s=10.4 usd=0.19676 llm_in=10 llm_out=398 llm_cache_read=244903 llm_cache_write=31277 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=13.1 usd=0.217523 llm_in=12 llm_out=500 llm_cache_read=300873 llm_cache_write=31887 ts_calls=1 ts_in=3553 ts_out=900 fallbacks=0 rounds=2
cell t13-infinite-scroll playwright ok=true wall_s=16.3 usd=0.177582 llm_in=8 llm_out=400 llm_cache_read=188335 llm_cache_write=30682 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=false wall_s=23.8 usd=0.264903 llm_in=16 llm_out=1101 llm_cache_read=415871 llm_cache_write=32816 ts_calls=3 ts_in=12360 ts_out=3196 fallbacks=3 rounds=8
cell t14-key-press playwright ok=true wall_s=9.0 usd=0.176486 llm_in=8 llm_out=296 llm_cache_read=188320 llm_cache_write=30807 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=11.1 usd=0.17957 llm_in=8 llm_out=380 llm_cache_read=189218 llm_cache_write=31122 ts_calls=2 ts_in=8886 ts_out=2269 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=11.0 usd=0.1979 llm_in=10 llm_out=651 llm_cache_read=243480 llm_cache_write=30683 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=9.0 usd=0.159648 llm_in=6 llm_out=275 llm_cache_read=133712 llm_cache_write=30730 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=9.8 usd=0.192564 llm_in=10 llm_out=339 llm_cache_read=243118 llm_cache_write=30537 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=15.2 usd=0.219907 llm_in=12 llm_out=648 llm_cache_read=301500 llm_cache_write=31785 ts_calls=3 ts_in=12067 ts_out=3195 fallbacks=2 rounds=9
cell t17-double-click playwright ok=true wall_s=8.2 usd=0.173042 llm_in=8 llm_out=251 llm_cache_read=187653 llm_cache_write=30122 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=8.8 usd=0.158381 llm_in=6 llm_out=224 llm_cache_read=133616 llm_cache_write=30609 ts_calls=1 ts_in=3202 ts_out=854 fallbacks=0 rounds=2
cell t1-checkboxes playwright ok=true wall_s=56.2 usd=0.108463 llm_in=12 llm_out=335 llm_cache_read=327823 llm_cache_write=1348 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=8.9 usd=0.05375 llm_in=6 llm_out=224 llm_cache_read=164003 llm_cache_write=274 ts_calls=1 ts_in=3420 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=7.4 usd=0.071979 llm_in=8 llm_out=261 llm_cache_read=217400 llm_cache_write=752 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=8.7 usd=0.054106 llm_in=6 llm_out=243 llm_cache_read=163985 llm_cache_write=292 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=12.4 usd=0.115827 llm_in=12 llm_out=405 llm_cache_read=329496 llm_cache_write=2898 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=11.7 usd=0.054384 llm_in=6 llm_out=247 llm_cache_read=164027 llm_cache_write=299 ts_calls=1 ts_in=7900 ts_out=2010 fallbacks=0 rounds=4
cell t4-add-elements playwright ok=true wall_s=11.6 usd=0.076038 llm_in=8 llm_out=382 llm_cache_read=217691 llm_cache_write=1327 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=9.8 usd=0.053662 llm_in=6 llm_out=210 llm_cache_read=163991 llm_cache_write=266 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=9.0 usd=0.071998 llm_in=8 llm_out=266 llm_cache_read=218826 llm_cache_write=623 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=8.5 usd=0.053945 llm_in=6 llm_out=234 llm_cache_read=164006 llm_cache_write=284 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=13.8 usd=0.074536 llm_in=8 llm_out=330 llm_cache_read=218311 llm_cache_write=1085 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=45.4 usd=0.097203 llm_in=10 llm_out=533 llm_cache_read=275643 llm_cache_write=1422 ts_calls=2 ts_in=27435 ts_out=6831 fallbacks=2 rounds=16
cell t7-sort-table playwright ok=true wall_s=10.1 usd=0.106743 llm_in=10 llm_out=342 llm_cache_read=276960 llm_cache_write=4932 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=8.7 usd=0.053751 llm_in=6 llm_out=219 llm_cache_read=163988 llm_cache_write=274 ts_calls=1 ts_in=5331 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=8.4 usd=0.075761 llm_in=8 llm_out=225 llm_cache_read=217219 llm_cache_write=1919 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=9.5 usd=0.053398 llm_in=6 llm_out=205 llm_cache_read=163973 llm_cache_write=257 ts_calls=1 ts_in=3562 ts_out=899 fallbacks=0 rounds=2
cell t9-long-chain playwright ok=true wall_s=100.0 usd=0.357756 llm_in=32 llm_out=2060 llm_cache_read=959489 llm_cache_write=10377 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=86.8 usd=0.245126 llm_in=22 llm_out=2306 llm_cache_read=627285 llm_cache_write=4710 ts_calls=6 ts_in=110054 ts_out=25853 fallbacks=4 rounds=53
cell t10-saucedemo-checkout playwright ok=true wall_s=18.9 usd=0.162812 llm_in=16 llm_out=913 llm_cache_read=446334 llm_cache_write=4045 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=24.0 usd=0.111606 llm_in=10 llm_out=1268 llm_cache_read=276848 llm_cache_write=1902 ts_calls=3 ts_in=56413 ts_out=13926 fallbacks=1 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=16.6 usd=0.145167 llm_in=14 llm_out=641 llm_cache_read=392587 llm_cache_write=4729 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=16.9 usd=0.105219 llm_in=10 llm_out=969 llm_cache_read=276467 llm_cache_write=1760 ts_calls=3 ts_in=26526 ts_out=6851 fallbacks=2 rounds=13
cell t12-js-confirm-dialog playwright ok=true wall_s=11.3 usd=0.093172 llm_in=10 llm_out=426 llm_cache_read=275060 llm_cache_write=1129 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=15.8 usd=0.130412 llm_in=14 llm_out=597 llm_cache_read=387418 llm_cache_write=1344 ts_calls=1 ts_in=3553 ts_out=900 fallbacks=0 rounds=2
cell t13-infinite-scroll playwright ok=true wall_s=17.1 usd=0.074474 llm_in=8 llm_out=402 llm_cache_read=218230 llm_cache_write=787 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=12.7 usd=0.054721 llm_in=6 llm_out=228 llm_cache_read=164000 llm_cache_write=281 ts_calls=1 ts_in=24499 ts_out=4209 fallbacks=0 rounds=9
cell t14-key-press playwright ok=true wall_s=9.8 usd=0.074187 llm_in=8 llm_out=346 llm_cache_read=218196 llm_cache_write=937 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=12.6 usd=0.074827 llm_in=8 llm_out=379 llm_cache_read=219573 llm_cache_write=766 ts_calls=2 ts_in=8886 ts_out=2269 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=13.4 usd=0.094782 llm_in=10 llm_out=683 llm_cache_read=273276 llm_cache_write=673 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=10.4 usd=0.055821 llm_in=6 llm_out=345 llm_cache_read=164111 llm_cache_write=331 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=11.4 usd=0.088916 llm_in=10 llm_out=339 llm_cache_read=273161 llm_cache_write=494 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=9.5 usd=0.053931 llm_in=6 llm_out=225 llm_cache_read=164003 llm_cache_write=281 ts_calls=1 ts_in=6758 ts_out=1794 fallbacks=0 rounds=4
cell t17-double-click playwright ok=true wall_s=8.8 usd=0.069994 llm_in=8 llm_out=251 llm_cache_read=217522 llm_cache_write=253 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=9.1 usd=0.053955 llm_in=6 llm_out=243 llm_cache_read=163967 llm_cache_write=258 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
route playwright n=34 ok=32/34 wall_s min=7.4 med=11.5 max=100.0 usd min=0.069994 med=0.173553 max=0.413767
route forced n=34 ok=33/34 wall_s min=8.5 med=10.8 max=94.5 usd min=0.053398 med=0.158239 max=0.364776
pair t1-checkboxes playwright n=2 ok=2/2 wall_s min=16.4 med=36.3 max=56.2 usd_med=0.152517
pair t1-checkboxes forced n=2 ok=2/2 wall_s min=8.9 med=9.4 max=10.0 usd_med=0.106125
pair t2-dropdown playwright n=2 ok=2/2 wall_s min=7.4 med=7.9 max=8.4 usd_med=0.123022
pair t2-dropdown forced n=2 ok=2/2 wall_s min=8.7 med=9.3 max=9.9 usd_med=0.106472
pair t3-dynamic-controls playwright n=2 ok=2/2 wall_s min=12.2 med=12.3 max=12.4 usd_med=0.155864
pair t3-dynamic-controls forced n=2 ok=2/2 wall_s min=11.7 med=13.9 max=16.1 usd_med=0.117666
pair t4-add-elements playwright n=2 ok=2/2 wall_s min=11.6 med=12.5 max=13.4 usd_med=0.137137
pair t4-add-elements forced n=2 ok=2/2 wall_s min=9.8 med=9.8 max=9.8 usd_med=0.106032
pair t5-inputs playwright n=2 ok=2/2 wall_s min=9.0 med=9.0 max=9.0 usd_med=0.123901
pair t5-inputs forced n=2 ok=2/2 wall_s min=8.5 med=8.8 max=9.1 usd_med=0.106323
pair t6-dynamic-loading playwright n=2 ok=2/2 wall_s min=13.8 med=19.8 max=25.8 usd_med=0.126395
pair t6-dynamic-loading forced n=2 ok=2/2 wall_s min=36.9 med=41.1 max=45.4 usd_med=0.158977
pair t7-sort-table playwright n=2 ok=2/2 wall_s min=10.1 med=10.6 max=11.1 usd_med=0.156009
pair t7-sort-table forced n=2 ok=2/2 wall_s min=8.7 med=8.8 max=8.8 usd_med=0.106118
pair t8-status-404 playwright n=2 ok=2/2 wall_s min=8.4 med=8.7 max=8.9 usd_med=0.126267
pair t8-status-404 forced n=2 ok=2/2 wall_s min=9.3 med=9.4 max=9.5 usd_med=0.105748
pair t9-long-chain playwright n=2 ok=2/2 wall_s min=40.1 med=70.1 max=100.0 usd_med=0.385762
pair t9-long-chain forced n=2 ok=2/2 wall_s min=86.8 med=90.7 max=94.5 usd_med=0.304951
pair t10-saucedemo-checkout playwright n=2 ok=2/2 wall_s min=16.5 med=17.7 max=18.9 usd_med=0.196058
pair t10-saucedemo-checkout forced n=2 ok=2/2 wall_s min=23.1 med=23.6 max=24.0 usd_med=0.165711
pair t11-todomvc-spa playwright n=2 ok=2/2 wall_s min=14.9 med=15.7 max=16.6 usd_med=0.19403
pair t11-todomvc-spa forced n=2 ok=2/2 wall_s min=16.9 med=20.2 max=23.5 usd_med=0.203281
pair t12-js-confirm-dialog playwright n=2 ok=2/2 wall_s min=10.4 med=10.9 max=11.3 usd_med=0.144966
pair t12-js-confirm-dialog forced n=2 ok=2/2 wall_s min=13.1 med=14.4 max=15.8 usd_med=0.173968
pair t13-infinite-scroll playwright n=2 ok=2/2 wall_s min=16.3 med=16.7 max=17.1 usd_med=0.126028
pair t13-infinite-scroll forced n=2 ok=1/2 wall_s min=12.7 med=18.3 max=23.8 usd_med=0.159812
pair t14-key-press playwright n=2 ok=2/2 wall_s min=9.0 med=9.4 max=9.8 usd_med=0.125337
pair t14-key-press forced n=2 ok=2/2 wall_s min=11.1 med=11.8 max=12.6 usd_med=0.127198
pair t15-file-upload playwright n=2 ok=0/2 wall_s min=11.0 med=12.2 max=13.4 usd_med=0.146341
pair t15-file-upload forced n=2 ok=2/2 wall_s min=9.0 med=9.7 max=10.4 usd_med=0.107735
pair t16-hover-reveal playwright n=2 ok=2/2 wall_s min=9.8 med=10.6 max=11.4 usd_med=0.14074
pair t16-hover-reveal forced n=2 ok=2/2 wall_s min=9.5 med=12.4 max=15.2 usd_med=0.136919
pair t17-double-click playwright n=2 ok=2/2 wall_s min=8.2 med=8.5 max=8.8 usd_med=0.121518
pair t17-double-click forced n=2 ok=2/2 wall_s min=8.8 med=8.9 max=9.1 usd_med=0.106168
phases t1-checkboxes/forced attach=48 first_observe=12 observe=10+19 jev=206+412 jev first/rest=256/156 act=79+157 settle=107+214 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=59 first_observe=18 observe=13+26 jev=189+377 jev first/rest=178/199 act=37+73 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=67 first_observe=15 observe=9+49 jev=163+1101 jev first/rest=345/161 act=18+2900 settle=216+652 kinds act=3 advance=1 wait=0 bounce=1 done=0 error=0 other=0
phases t4-add-elements/forced attach=51 first_observe=9 observe=9+36 jev=138+642 jev first/rest=245/121 act=38+165 settle=216+653 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=57 first_observe=11 observe=9+17 jev=202+404 jev first/rest=240/164 act=32+64 settle=108+216 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=75 first_observe=11 observe=7+90 jev=158+2019 jev first/rest=133/158 act=2126+19379 settle=217+1751 kinds act=1 advance=1 wait=7 bounce=2 done=0 error=0 other=1
phases t7-sort-table/forced attach=45 first_observe=11 observe=11+21 jev=185+369 jev first/rest=239/130 act=<withheld>+83 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=61 first_observe=9 observe=13+26 jev=207+413 jev first/rest=248/165 act=43+85 settle=337+673 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t9-long-chain/forced attach=356 first_observe=14 observe=8+431 jev=124+7007 jev first/rest=126/124 act=27+16744 settle=214+10991 kinds act=22 advance=13 wait=5 bounce=2 done=0 error=3 other=8
phases t10-saucedemo-checkout/forced attach=104 first_observe=13 observe=10+247 jev=137+3504 jev first/rest=166/135 act=0+593 settle=0+2469 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=120 first_observe=14 observe=9+150 jev=145+1868 jev first/rest=0/149 act=0+387 settle=0+1307 kinds act=6 advance=4 wait=0 bounce=4 done=0 error=0 other=2
phases t12-js-confirm-dialog/forced attach=56 first_observe=15 observe=11+21 jev=245+489 jev first/rest=287/202 act=59+118 settle=112+223 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t13-infinite-scroll/forced attach=94 first_observe=10 observe=8+63 jev=132+1024 jev first/rest=132/131 act=0+4546 settle=0+653 kinds act=3 advance=0 wait=0 bounce=3 done=0 error=0 other=2
phases t14-key-press/forced attach=68 first_observe=12 observe=8+50 jev=136+904 jev first/rest=133/136 act=0+131 settle=0+434 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=47 first_observe=11 observe=9+17 jev=166+332 jev first/rest=196/136 act=31+61 settle=109+217 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=94 first_observe=10 observe=8+71 jev=147+1213 jev first/rest=0/148 act=47+334 settle=216+1117 kinds act=5 advance=1 wait=0 bounce=2 done=0 error=0 other=1
phases t17-double-click/forced attach=49 first_observe=9 observe=8+16 jev=226+452 jev first/rest=273/179 act=39+<withheld> settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t1-checkboxes/forced attach=48 first_observe=11 observe=10+20 jev=296+591 jev first/rest=288/303 act=55+110 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=51 first_observe=9 observe=8+16 jev=225+450 jev first/rest=285/165 act=25+49 settle=108+215 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=56 first_observe=11 observe=10+37 jev=133+622 jev first/rest=229/128 act=<withheld>+2870 settle=109+444 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t4-add-elements/forced attach=60 first_observe=10 observe=7+29 jev=159+665 jev first/rest=218/148 act=47+181 settle=217+654 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=53 first_observe=10 observe=9+18 jev=214+428 jev first/rest=285/143 act=28+55 settle=112+223 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=67 first_observe=8 observe=8+129 jev=158+2567 jev first/rest=106/158 act=3005+28214 settle=217+2414 kinds act=1 advance=1 wait=10 bounce=2 done=0 error=0 other=2
phases t7-sort-table/forced attach=67 first_observe=14 observe=15+29 jev=247+493 jev first/rest=257/236 act=37+74 settle=110+220 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=51 first_observe=10 observe=10+19 jev=190+380 jev first/rest=227/153 act=47+93 settle=321+642 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t9-long-chain/forced attach=886 first_observe=13 observe=9+514 jev=138+7532 jev first/rest=143/138 act=41+14013 settle=214+11880 kinds act=23 advance=12 wait=4 bounce=4 done=0 error=2 other=8
phases t10-saucedemo-checkout/forced attach=99 first_observe=16 observe=9+232 jev=153+3855 jev first/rest=162/152 act=0+580 settle=0+2469 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=88 first_observe=14 observe=8+122 jev=148+1817 jev first/rest=0/152 act=0+295 settle=0+1319 kinds act=6 advance=4 wait=0 bounce=2 done=0 error=0 other=1
phases t12-js-confirm-dialog/forced attach=51 first_observe=13 observe=11+21 jev=213+425 jev first/rest=244/181 act=53+106 settle=112+223 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t13-infinite-scroll/forced attach=48 first_observe=10 observe=7+69 jev=142+1475 jev first/rest=288/141 act=80+1046 settle=217+2072 kinds act=8 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t14-key-press/forced attach=68 first_observe=14 observe=11+64 jev=169+886 jev first/rest=112/169 act=0+166 settle=0+475 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=48 first_observe=13 observe=11+21 jev=188+375 jev first/rest=242/133 act=31+62 settle=109+217 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=51 first_observe=8 observe=7+28 jev=157+665 jev first/rest=219/134 act=22+135 settle=108+433 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t17-double-click/forced attach=47 first_observe=8 observe=9+17 jev=155+310 jev first/rest=183/127 act=37+74 settle=119+237 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty; pair lines aggregate repeats
```
