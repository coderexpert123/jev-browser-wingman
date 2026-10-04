# r21 - the pre-publish optimization round (HEAD c8c4aff on main)

**Headline: this is NOT the run the README refreshes from.** The gauntlet missed its acceptance bar (forced 33/34), P-5 failed its pre-registered bar and was measured as rejected (the gauntlet ran on the P-5-off candidate via an uncommitted flip), the pre-registered t6 bars were all missed, and two of the eight new mutant flags are unproven. Everything below is evidence; nothing was fixed or committed to main.

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99, cloud Sonnet caller, gate off, policy off, harness_version 3. `npm ci` skipped (lock unchanged); build ok (113 files). Phase cap 54.31133 = ledger 38.31133 + 16, `--cap-usd 3.00`. **Spend: 9.1932 USD** (the single gauntlet) **plus under 0.10 USD** of Jev asks (capture x2, news probes), of 16.

## Part 1 (Chrome-only, 19 invocations incl. act-nav, pointer-enum, doctor x2)
acquire 6/6 | chrome 28/28 | conformance 28/28 | **conformance-ops forty-two pass + 2 FAIL + 1 todo (red on the first run AND the re-run)** | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (22 s) | adapter-playwright 10/10 | page-scripts 30/30 | act-nav 6/6 | pointer-enum 2/2 | doctor 37/37 twice | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.
- **conformance-ops O8 `wait sleeps about one second` fails on BOTH adapters, deterministically** (`wait took 3005 ms (3006 ms), expected 900-3000`). P-2's growth-poll makes a wait on a never-changing page run its full 3 s budget; the spec's own T-wait-static pins [2900, 3800] ms for exactly that. O8's window predates P-2 and the 3000 edge is crossed by 5-6 ms: a **stale pin, not a defect in P-2**; the WP-4 gate never ran conformance-ops. Not fixed.

## Part 1b - the eight-flag mutants pass (grep for `= true` in src before and after: clean; every restore byte-identical)
| flag | mapped pin(s) | red under flip | extras | verdict |
|---|---|---|---|---|
| KB_CAPTCHA_SCOPED | page-scripts "captcha-decoys.html does not set the captcha signal" | 1/1 | 1 (the svg-carried captcha pin; a consequence - it also pins the scoped rule) | PROVEN |
| KB_CURSOR_POINTER | pointer-enum "click Save ..." and "enumerate lists the decoy divs" | 2/2 | 0 | PROVEN |
| KB_PW_NOWAIT | act-nav T-nav-nowait | 1/1 | 0 | PROVEN |
| KB_PW_PRECLICK | act-nav T-preclick-guard | 1/1 | 0 | PROVEN |
| KB_CDP_PRECLICK | act-nav T-cdp-preclick | **0/1** | 0 | **NOT PROVEN** - the flip moves the measured duration (9117 ms -> 5124 ms) but the pin asserts only `>= 3500`, so it passes either way |
| KB_OBS_RETRY | loop "a fast mid-navigation observe failure retries ..." | 1/1 | 0 | PROVEN |
| KB_PW_WAIT_GROWTH | act-nav T-wait-growth, T-wait-static | 2/2 | 0 | PROVEN |
| KB_CDP_WAIT_GROWTH | none named; the T-wait pins run on the playwright driver | **0 red** | 0 | **NOT PROVEN** - nothing goes red (act-nav, adapter-cdp, chain-e2e 20/20, conformance-ops); the only effect is the CDP O8 leg flipping red -> green |
6 of 8 proven; 1 extra failure in total (a consequence). Both unproven flags are on the CDP adapter (a loose bound on one pin, no pin on the other).

## Part 2 - live captcha stage (shipped build; the results/captcha dumps carry the evidence)
- **recon, shipped scoped rule: `signals.captcha=false` on bbc.com/news, npr.org and theguardian.com/us.** Fixtures: challenge TRUE, decoys FALSE (as required).
- **The preface's "they no longer match even the OLD regex today / vendor content moved" is not what the live data shows.** The same recon on a build with `KB_CAPTCHA_SCOPED = true` (the pre-fix rule; flipped, then restored and rebuilt) reports **`captcha=true` on all three sites today**. The raw dump shows why: bbc and guardian each carry a 0x0 `recaptcha/api2/aframe` iframe; npr carries that plus an `size=invisible` anchor iframe (256x60, area 15360), a `grecaptcha-badge` div (256x60), a `grecaptcha-logo` div (256x66) and a hidden `g-recaptcha-response` textarea. All are NOT visible; the scoped rule excludes them, the old any-substring rule matched them.
- **Sub-floor check (area under 16000):** the only sub-floor matches are npr's invisible-mode anchor iframe and badge (15360, visible=false) - decoys, correctly not blocking. **No visible real challenge widget of any size appeared**, so there is no sub-floor real-widget input for the next rule iteration (Turnstile compact 15600 never appeared).
- **browse_step probes (gate/policy off, goal "Report the page headline", via the MCP server):** bbc.com/news -> `fallback / step-uncertain`, 0 steps, 2 Jev calls; npr.org -> `fallback / step-uncertain`, 0 steps, 2 Jev calls. **Not blocked/captcha** (the pre-fix signal ends both before any Jev ask). Neither completed a read (a one-step "report" goal has no act to take), but both passed the captcha gate and reached Jev.

## P-5 decision (D12): REJECT, with numbers
Existing enumerate pins pass unchanged with the flag active (page-scripts 30/30, adapter-cdp 10/10, adapter-playwright 10/10) and the pointer-enum value pin is green (2/2); the many.html wall delta is +1.9 ms per the commit (not re-measured). **The live-inflation criterion (<= +30%) fails on all three sites** (candidate counts from the recon, which enumerates through the real build; heuristic off = build with `KB_CURSOR_POINTER = true`, 2 loads each):
| site | heuristic off | heuristic on | inflation |
|---|---|---|---|
| bbc.com/news | 119 / 119 | 474 / 474 | +298% |
| npr.org | 230 / 220 | 542 / 542 | +141% to +147% |
| theguardian.com/us | 284 / 284 | 533 / 533 | +88% |
The smallest inflation is 2.9x the cap. **Consequence:** D12 says revert the WP-2 commit before the gauntlet. The r21 work is ONE squashed commit (c8c4aff), so there is no separable commit to `git revert`, and a literal revert needs src and test edits (pointer-enum pins the flag active) - report-only territory. To still measure the decided candidate, the gauntlet ran with the working tree flipped to `KB_CURSOR_POINTER = true` (D-11 polarity), uncommitted, source restored after launch (diff in evidence/p5-reject-flip.diff), dist rebuilt from clean source afterwards. **The operator needs to land the P-5 removal** (or reverse the call); until then the shipped tree and the measured candidate differ by that one flag. The per-cell "t15-t17 wall within noise" inflation check is moot on a P-5-off run; the live-page counts above are the inflation evidence.

## Part 3 - the 68-cell gauntlet (one invocation, 17 tasks x 2 routes x 2 repeats; P-5-off candidate)
68/68 cells present, `aborted=null`. **ACCEPTANCE NOT MET: forced 33/34.** playwright 32/34 (t15-file-upload x2, the tolerated one).
- **The one forced failure: t9-long-chain, repeat 1** (57.8 s, 2 `browse_step` calls, oracle false). Log: call 1, step 1 of 7 ("open Checkboxes ..."): round 1 clicked the link (act 101 ms, settle 3003 ms); round 2's observe threw -> `error/act-failed`, act_error `evaluation timed out` (call ended at 8.4 s, i.e. the observe eval hit its own timeout - a slow failure, which the fast-fail gate rightly leaves unretried). Call 2: attach took 13.8 s, one `wait` (3007 ms), then an error round with `recover: reload` -> `error/page-error` at 17.5 s; the caller stopped. Repeat 2 of the same cell passed (63.0 s, 4 calls). **Non-deterministic, mechanism-explained to the call level, root cause on the live page not isolated.** It is the shape the spec's R1 named (dropping Playwright's post-click wait moves the failure from the click to the next observe): the r20 `locator.click` timeout shape did not recur (0 such act_errors in the 52 wingman records), but a navigation click on the live site still cost a call. Reported as a defect finding.
- **Live invariant PASS:** `typesafe.calls === tool_use_counts[browse_step]` on all 34 forced cells, 0 mismatches (52 == 52).
- **Pre-registered metrics (forced; r19/r20 baselines) - none cleanly met:**
  | metric | baseline | bar | r21 | verdict |
  |---|---|---|---|---|
  | t6 wait acts per cell | 9 | <= 3 | **10** | MISSED |
  | t6 Jev calls per cell | ~16 | <= 5 | **~15** | MISSED |
  | t6 wall median | 49.0 / 48.2 s | <= 41 s | **48.6 s** | MISSED (+1%) |
  | t9 forced median | 44.9 s (r19) / 77.7 s (r20) | lower | 60.4 s (57.8 FAILED / 63.0) | no clean improvement |
  | t12 forced median | 17.0 s (r19) / 21.7 s (r20) | unchanged | 23.0 s (17.9 / 28.1) | +6% vs r20, +35% vs r19 |
  P-2 changed the cost per wait, not the number of waits: wait `act_ms` rose from ~1000 ms to ~3005 ms (sum of act time per t6 cell 28.4 s vs 9.1 s in r20) while the loop still picks `wait` 10 times (kinds: wait 10, act 1, advance 1, bounce 2); calls per cell fell 3 -> 2, wall unchanged. **Load caveat:** the playwright cells for the same tasks moved the same way in this file (t6 +31%, t9 +40%, t12 +43% vs r20), so the run was slower (r20 C5 rule: absolute walls are load-confounded). Forced/playwright wall ratios did improve (t6 2.09 -> 1.61, t9 2.23 -> 1.24, t12 1.00 -> 0.74), but at n=2, with a failed t9 cell and the load-independent t6 count bars missed, **no improvement is claimed.**
- r20 vs r21, per task x route (wall medians; 25 of 34 pairs within +-15%):
| task | route | r20 wall med s | r21 wall med s | delta | r20 usd | r21 usd | within +-15% |
|---|---|---|---|---|---|---|---|
| t1-checkboxes | playwright | 14.0 | 15.8 | +13% | 0.156 | 0.134 | yes |
| t1-checkboxes | forced | 11.2 | 10.7 | -4% | 0.123 | 0.098 | yes |
| t2-dropdown | playwright | 11.8 | 10.4 | -12% | 0.142 | 0.114 | yes |
| t2-dropdown | forced | 11.0 | 10.9 | -1% | 0.124 | 0.099 | yes |
| t3-dynamic-controls | playwright | 14.5 | 15.0 | +3% | 0.165 | 0.137 | yes |
| t3-dynamic-controls | forced | 20.5 | 18.6 | -9% | 0.137 | 0.120 | yes |
| t4-add-elements | playwright | 15.1 | 15.2 | +1% | 0.147 | 0.139 | yes |
| t4-add-elements | forced | 11.5 | 11.3 | -1% | 0.123 | 0.098 | yes |
| t5-inputs | playwright | 13.2 | 10.3 | -22% | 0.142 | 0.117 | NO |
| t5-inputs | forced | 13.4 | 11.3 | -15% | 0.124 | 0.099 | NO |
| t6-dynamic-loading | playwright | 23.1 | 30.2 | +31% | 0.155 | 0.130 | NO |
| t6-dynamic-loading | forced | 48.2 | 48.6 | +1% | 0.215 | 0.140 | yes |
| t7-sort-table | playwright | 14.7 | 13.5 | -9% | 0.174 | 0.145 | yes |
| t7-sort-table | forced | 10.4 | 10.5 | +2% | 0.123 | 0.098 | yes |
| t8-status-404 | playwright | 11.8 | 12.1 | +2% | 0.144 | 0.117 | yes |
| t8-status-404 | forced | 11.4 | 10.7 | -6% | 0.123 | 0.098 | yes |
| t9-long-chain | playwright | 34.8 | 48.9 | +40% | 0.321 | 0.271 | NO |
| t9-long-chain | forced | 77.7 | 60.4 | -22% | 0.349 | 0.195 | NO |
| t10-saucedemo-checkout | playwright | 30.0 | 27.1 | -10% | 0.267 | 0.223 | yes |
| t10-saucedemo-checkout | forced | 27.5 | 29.1 | +6% | 0.202 | 0.173 | yes |
| t11-todomvc-spa | playwright | 25.0 | 20.3 | -19% | 0.221 | 0.184 | NO |
| t11-todomvc-spa | forced | 27.7 | 22.2 | -20% | 0.251 | 0.171 | NO |
| t12-js-confirm-dialog | playwright | 21.8 | 31.2 | +43% | 0.164 | 0.155 | NO |
| t12-js-confirm-dialog | forced | 21.7 | 23.0 | +6% | 0.189 | 0.146 | yes |
| t13-infinite-scroll | playwright | 21.5 | 35.7 | +66% | 0.154 | 0.128 | NO |
| t13-infinite-scroll | forced | 17.3 | 15.6 | -10% | 0.125 | 0.100 | yes |
| t14-key-press | playwright | 13.6 | 13.8 | +1% | 0.144 | 0.132 | yes |
| t14-key-press | forced | 13.9 | 14.8 | +7% | 0.146 | 0.119 | yes |
| t15-file-upload | playwright | 16.7 | 16.5 | -1% | 0.170 | 0.140 | yes |
| t15-file-upload | forced | 11.5 | 10.3 | -11% | 0.125 | 0.100 | yes |
| t16-hover-reveal | playwright | 16.3 | 15.5 | -5% | 0.183 | 0.134 | yes |
| t16-hover-reveal | forced | 13.1 | 14.8 | +13% | 0.124 | 0.128 | yes |
| t17-double-click | playwright | 10.9 | 11.2 | +2% | 0.141 | 0.115 | yes |
| t17-double-click | forced | 10.7 | 11.0 | +3% | 0.123 | 0.098 | yes |

  Route medians: forced wall 13.9 -> 13.3 s, playwright 15.0 -> 15.2 s; usd sums forced 5.45 -> 4.16, playwright 5.98 -> 5.03 (prompt-cache state). Jev first-round median 224 ms vs later 146 ms (31 cells).

## Part 4 - grader capture -> replay
Capture files carry page text and stay untracked (.calib/); the replay reports are in results/capture/. Capture A (3 fixture tasks + the guardian page): the fixture rounds hit 404 pages because **I** passed `form.html` and the harness appends `.html` (my invocation error, not a defect); guardian (dense real page, two-stage `group` requests): 2 rounds for the 1 call, round 1 with 10 questions and round 2 with 12 (error/recover appear from round 2), stage-1 and stage-2 requests merged into one round, end status copied onto each round - **pairing sane**; self-check PASS (7 mirrored, 1 unmirrored, 0 mismatches). Capture B (correct names `form`, `hover-reveal`, `double-click`): 6 rounds / 3 calls, each act -> advance -> done/goal-met on the real fixture pages; self-check **PASS (4 mirrored, 2 unmirrored, 0 mismatches)**. **The capture -> replay loop is validated end to end.**

## Doctor x3 (bench Chrome, port 9344, clean shipped build)
3 of 3 `verdict: PASS`; `coexistence: observer fingerprint identical across attach/detach (1 page(s))` each time. Part 1's doctor was 37/37 twice as well.

## Caveats
- n=2 per task x route; live third-party sites; USD is cache-state-confounded; one run-wide slowdown visible on the playwright control cells.
- The gauntlet measured "r21 minus P-5", not the shipped tree; the flip was uncommitted and the working tree is restored (clean).
- t9's observe-timeout failure is one cell of two and its page-level cause is not isolated.
- 2 of 8 new KB flags are unproven (both CDP-adapter); conformance-ops O8 is red on a stale pin.
- Verbatim reporter output below has 0 numeric tokens replaced with `<withheld>` (and the comparison table 0) because a 2-character bound value collides with them in the pre-push scan; unmodified copies: results/gauntlet/.

## Publish-readiness verdict
**No - this is not the run the README table refreshes from, and I would not publish on it.** (1) Forced 33/34 misses the 34/34 bar on a defect-shaped, non-deterministic t9 failure. (2) The measured candidate is not the shipped tree (P-5 off vs on). (3) The round's pre-registered speed bars (t6/t9/t12) are not met; the optimization deliverable did not land as specified. (4) conformance-ops O8 is red and two mutant flags are unproven. The r20 README table (34/34 forced, from a single clean 68-cell run) remains the better published source until a clean r21+ run lands.

## Reporter output, verbatim (`node dist/bench/report.js results/gauntlet/r21-gauntlet-2026-10-04-075635.json`)
```
BENCH REPORT 2026-10-04-075635.json purpose=measure model=sonnet harness=3 aborted=null total_usd=9.19318 runs=68
cell t1-checkboxes playwright ok=true wall_s=18.7 usd=0.182741 llm_in=10 llm_out=305 llm_cache_read=230586 llm_cache_write=29056 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=10.5 usd=0.145745 llm_in=6 llm_out=225 llm_cache_read=127766 llm_cache_write=27701 ts_calls=1 ts_in=3422 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=10.8 usd=0.160073 llm_in=8 llm_out=233 llm_cache_read=179046 llm_cache_write=27424 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=10.9 usd=0.146062 llm_in=6 llm_out=243 llm_cache_read=127754 llm_cache_write=27712 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=15.3 usd=0.181602 llm_in=10 llm_out=374 llm_cache_read=233054 llm_cache_write=28279 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=19.0 usd=0.167751 llm_in=8 llm_out=399 llm_cache_read=180454 llm_cache_write=28583 ts_calls=1 ts_in=9993 ts_out=2529 fallbacks=1 rounds=5
cell t4-add-elements playwright ok=true wall_s=15.0 usd=0.183952 llm_in=10 llm_out=457 llm_cache_read=232160 llm_cache_write=28645 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=11.0 usd=0.145625 llm_in=6 llm_out=210 llm_cache_read=127758 llm_cache_write=27688 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=10.4 usd=0.162262 llm_in=8 llm_out=266 llm_cache_read=179995 llm_cache_write=27800 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=10.0 usd=0.145925 llm_in=6 llm_out=234 llm_cache_read=127768 llm_cache_write=27711 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=28.0 usd=0.166566 llm_in=8 llm_out=399 llm_cache_read=180202 llm_cache_write=28399 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=48.0 usd=0.186793 llm_in=10 llm_out=492 llm_cache_read=233539 llm_cache_write=28845 ts_calls=2 ts_in=27435 ts_out=6831 fallbacks=2 rounds=16
cell t7-sort-table playwright ok=true wall_s=13.7 usd=0.191348 llm_in=10 llm_out=360 llm_cache_read=235664 llm_cache_write=30725 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=10.6 usd=0.145691 llm_in=6 llm_out=218 llm_cache_read=127756 llm_cache_write=27694 ts_calls=1 ts_in=5329 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=13.0 usd=0.163232 llm_in=8 llm_out=240 llm_cache_read=180052 llm_cache_write=28158 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=10.7 usd=0.145439 llm_in=6 llm_out=206 llm_cache_read=127746 llm_cache_write=27675 ts_calls=1 ts_in=5377 ts_out=1365 fallbacks=0 rounds=3
cell t9-long-chain playwright ok=true wall_s=39.2 usd=0.345988 llm_in=22 llm_out=2027 llm_cache_read=593610 llm_cache_write=36649 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=false wall_s=57.8 usd=0.222158 llm_in=12 llm_out=1604 llm_cache_read=289223 llm_cache_write=29608 ts_calls=2 ts_in=6313 ts_out=1720 fallbacks=0 rounds=4
cell t10-saucedemo-checkout playwright ok=true wall_s=28.9 usd=0.288637 llm_in=20 llm_out=1190 llm_cache_read=508312 llm_cache_write=31529 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=29.9 usd=0.234132 llm_in=12 llm_out=1588 llm_cache_read=291134 llm_cache_write=32120 ts_calls=3 ts_in=59188 ts_out=14625 fallbacks=1 rounds=25
cell t11-todomvc-spa playwright ok=true wall_s=19.4 usd=0.229416 llm_in=14 llm_out=631 llm_cache_read=345468 llm_cache_write=31005 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=22.0 usd=0.217544 llm_in=12 llm_out=931 llm_cache_read=289427 llm_cache_write=30828 ts_calls=3 ts_in=26433 ts_out=6828 fallbacks=2 rounds=13
cell t12-js-confirm-dialog playwright ok=true wall_s=13.7 usd=0.18128 llm_in=10 llm_out=327 llm_cache_read=233255 llm_cache_write=28365 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=17.9 usd=0.203973 llm_in=12 llm_out=531 llm_cache_read=286920 llm_cache_write=29216 ts_calls=1 ts_in=7995 ts_out=1895 fallbacks=1 rounds=5
cell t13-infinite-scroll playwright ok=true wall_s=18.0 usd=0.164176 llm_in=8 llm_out=409 llm_cache_read=179599 llm_cache_write=27770 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=15.9 usd=0.146815 llm_in=6 llm_out=228 llm_cache_read=127764 llm_cache_write=27706 ts_calls=1 ts_in=27394 ts_out=4687 fallbacks=0 rounds=10
cell t14-key-press playwright ok=true wall_s=13.7 usd=0.178607 llm_in=10 llm_out=299 llm_cache_read=232108 llm_cache_write=27856 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=14.0 usd=0.165984 llm_in=8 llm_out=384 llm_cache_read=180407 llm_cache_write=28188 ts_calls=2 ts_in=8886 ts_out=2268 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=16.1 usd=0.185228 llm_in=10 llm_out=756 llm_cache_read=231940 llm_cache_write=27807 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=10.1 usd=0.146872 llm_in=6 llm_out=275 llm_cache_read=127838 llm_cache_write=27793 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=13.8 usd=0.17815 llm_in=10 llm_out=339 llm_cache_read=231470 llm_cache_write=27625 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=18.5 usd=0.204415 llm_in=12 llm_out=648 llm_cache_read=286818 llm_cache_write=28848 ts_calls=3 ts_in=10316 ts_out=2728 fallbacks=2 rounds=8
cell t17-double-click playwright ok=true wall_s=11.7 usd=0.160488 llm_in=8 llm_out=302 llm_cache_read=179019 llm_cache_write=27261 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=11.0 usd=0.14526 llm_in=6 llm_out=201 llm_cache_read=127742 llm_cache_write=27672 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
cell t1-checkboxes playwright ok=true wall_s=12.9 usd=0.086087 llm_in=10 llm_out=266 llm_cache_read=258432 llm_cache_write=1210 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t1-checkboxes forced ok=true wall_s=10.9 usd=0.051122 llm_in=6 llm_out=225 llm_cache_read=155192 llm_cache_write=274 ts_calls=1 ts_in=3422 ts_out=885 fallbacks=0 rounds=2
cell t2-dropdown playwright ok=true wall_s=10.1 usd=0.068503 llm_in=8 llm_out=262 llm_cache_read=205752 llm_cache_write=753 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t2-dropdown forced ok=true wall_s=10.8 usd=0.051467 llm_in=6 llm_out=243 llm_cache_read=155174 llm_cache_write=293 ts_calls=1 ts_in=3634 ts_out=924 fallbacks=0 rounds=2
cell t3-dynamic-controls playwright ok=true wall_s=14.6 usd=0.092601 llm_in=10 llm_out=359 llm_cache_read=259708 llm_cache_write=2473 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t3-dynamic-controls forced ok=true wall_s=18.1 usd=0.073175 llm_in=8 llm_out=402 llm_cache_read=207888 llm_cache_write=1156 ts_calls=1 ts_in=9993 ts_out=2529 fallbacks=1 rounds=5
cell t4-add-elements playwright ok=true wall_s=15.4 usd=0.09467 llm_in=10 llm_out=480 llm_cache_read=258241 llm_cache_write=2658 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t4-add-elements forced ok=true wall_s=11.7 usd=0.051019 llm_in=6 llm_out=210 llm_cache_read=155180 llm_cache_write=266 ts_calls=1 ts_in=7131 ts_out=1850 fallbacks=0 rounds=4
cell t5-inputs playwright ok=true wall_s=10.2 usd=0.072537 llm_in=8 llm_out=266 llm_cache_read=206009 llm_cache_write=1792 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t5-inputs forced ok=true wall_s=12.7 usd=0.051301 llm_in=6 llm_out=234 llm_cache_read=155195 llm_cache_write=284 ts_calls=1 ts_in=3568 ts_out=924 fallbacks=0 rounds=2
cell t6-dynamic-loading playwright ok=true wall_s=32.5 usd=0.092523 llm_in=10 llm_out=397 llm_cache_read=259047 llm_cache_write=2353 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t6-dynamic-loading forced ok=true wall_s=49.3 usd=0.092944 llm_in=10 llm_out=545 llm_cache_read=260949 llm_cache_write=1414 ts_calls=2 ts_in=27435 ts_out=6831 fallbacks=2 rounds=16
cell t7-sort-table playwright ok=true wall_s=13.2 usd=0.098874 llm_in=10 llm_out=358 llm_cache_read=262467 llm_cache_write=3929 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t7-sort-table forced ok=true wall_s=10.5 usd=0.051108 llm_in=6 llm_out=219 llm_cache_read=155177 llm_cache_write=274 ts_calls=1 ts_in=5331 ts_out=1340 fallbacks=0 rounds=2
cell t8-status-404 playwright ok=true wall_s=11.2 usd=0.069977 llm_in=8 llm_out=240 llm_cache_read=207089 llm_cache_write=1127 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t8-status-404 forced ok=true wall_s=10.7 usd=0.050845 llm_in=6 llm_out=210 llm_cache_read=155162 llm_cache_write=261 ts_calls=1 ts_in=3570 ts_out=899 fallbacks=0 rounds=2
cell t9-long-chain playwright ok=true wall_s=58.5 usd=0.195344 llm_in=14 llm_out=2297 llm_cache_read=390994 llm_cache_write=11613 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t9-long-chain forced ok=true wall_s=63.0 usd=0.168795 llm_in=16 llm_out=1663 llm_cache_read=425610 llm_cache_write=2905 ts_calls=4 ts_in=124409 ts_out=29659 fallbacks=3 rounds=58
cell t10-saucedemo-checkout playwright ok=true wall_s=25.4 usd=0.15675 llm_in=16 llm_out=940 llm_cache_read=423540 llm_cache_write=4144 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t10-saucedemo-checkout forced ok=true wall_s=28.3 usd=0.112059 llm_in=10 llm_out=1572 llm_cache_read=262134 llm_cache_write=1984 ts_calls=3 ts_in=56406 ts_out=13925 fallbacks=1 rounds=24
cell t11-todomvc-spa playwright ok=true wall_s=21.3 usd=0.138782 llm_in=14 llm_out=627 llm_cache_read=370993 llm_cache_write=4810 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t11-todomvc-spa forced ok=true wall_s=22.4 usd=0.124912 llm_in=12 llm_out=1042 llm_cache_read=317038 llm_cache_write=3473 ts_calls=3 ts_in=26438 ts_out=6828 fallbacks=2 rounds=13
cell t12-js-confirm-dialog playwright ok=true wall_s=48.7 usd=0.128056 llm_in=14 llm_out=520 llm_cache_read=363787 llm_cache_write=2954 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t12-js-confirm-dialog forced ok=true wall_s=28.1 usd=0.088959 llm_in=10 llm_out=412 llm_cache_read=260472 llm_cache_write=1189 ts_calls=1 ts_in=3551 ts_out=900 fallbacks=0 rounds=2
cell t13-infinite-scroll playwright ok=true wall_s=53.3 usd=0.091836 llm_in=10 llm_out=628 llm_cache_read=259145 llm_cache_write=1238 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t13-infinite-scroll forced ok=true wall_s=15.4 usd=0.052196 llm_in=6 llm_out=228 llm_cache_read=155189 llm_cache_write=281 ts_calls=1 ts_in=27334 ts_out=4696 fallbacks=0 rounds=10
cell t14-key-press playwright ok=true wall_s=13.9 usd=0.085592 llm_in=10 llm_out=299 llm_cache_read=259069 llm_cache_write=895 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t14-key-press forced ok=true wall_s=15.7 usd=0.072828 llm_in=8 llm_out=476 llm_cache_read=207825 llm_cache_write=785 ts_calls=2 ts_in=8886 ts_out=2268 fallbacks=1 rounds=6
cell t15-file-upload playwright ok=false wall_s=16.9 usd=0.095397 llm_in=10 llm_out=791 llm_cache_read=257741 llm_cache_write=1648 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t15-file-upload forced ok=true wall_s=10.4 usd=0.052128 llm_in=6 llm_out=275 llm_cache_read=155300 llm_cache_write=331 ts_calls=1 ts_in=3653 ts_out=978 fallbacks=0 rounds=2
cell t16-hover-reveal playwright ok=true wall_s=17.2 usd=0.089083 llm_in=10 llm_out=373 llm_cache_read=257582 llm_cache_write=1649 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t16-hover-reveal forced ok=true wall_s=11.1 usd=0.051289 llm_in=6 llm_out=225 llm_cache_read=155192 llm_cache_write=281 ts_calls=1 ts_in=6785 ts_out=1794 fallbacks=0 rounds=4
cell t17-double-click playwright ok=true wall_s=10.7 usd=0.069809 llm_in=8 llm_out=251 llm_cache_read=204915 llm_cache_write=1212 ts_calls=0 ts_in=0 ts_out=0 fallbacks=0 rounds=0
cell t17-double-click forced ok=true wall_s=11.1 usd=0.050682 llm_in=6 llm_out=201 llm_cache_read=155156 llm_cache_write=258 ts_calls=1 ts_in=3202 ts_out=856 fallbacks=0 rounds=2
route playwright n=34 ok=32/34 wall_s min=10.1 med=15.2 max=58.5 usd min=0.068503 med=0.1602805 max=0.345988
route forced n=34 ok=33/34 wall_s min=10.0 med=13.3 max=63.0 usd min=0.050682 med=0.14534950000000002 max=0.234132
pair t1-checkboxes playwright n=2 ok=2/2 wall_s min=12.9 med=15.8 max=18.7 usd_med=0.134414
pair t1-checkboxes forced n=2 ok=2/2 wall_s min=10.5 med=10.7 max=10.9 usd_med=0.098434
pair t2-dropdown playwright n=2 ok=2/2 wall_s min=10.1 med=10.4 max=10.8 usd_med=0.114288
pair t2-dropdown forced n=2 ok=2/2 wall_s min=10.8 med=10.9 max=10.9 usd_med=0.098765
pair t3-dynamic-controls playwright n=2 ok=2/2 wall_s min=14.6 med=15.0 max=15.3 usd_med=0.137102
pair t3-dynamic-controls forced n=2 ok=2/2 wall_s min=18.1 med=18.6 max=19.0 usd_med=0.120463
pair t4-add-elements playwright n=2 ok=2/2 wall_s min=15.0 med=15.2 max=15.4 usd_med=0.139311
pair t4-add-elements forced n=2 ok=2/2 wall_s min=11.0 med=11.3 max=11.7 usd_med=0.098322
pair t5-inputs playwright n=2 ok=2/2 wall_s min=10.2 med=10.3 max=10.4 usd_med=0.117399
pair t5-inputs forced n=2 ok=2/2 wall_s min=10.0 med=11.3 max=12.7 usd_med=0.098613
pair t6-dynamic-loading playwright n=2 ok=2/2 wall_s min=28.0 med=30.2 max=32.5 usd_med=0.129545
pair t6-dynamic-loading forced n=2 ok=2/2 wall_s min=48.0 med=48.6 max=49.3 usd_med=0.139869
pair t7-sort-table playwright n=2 ok=2/2 wall_s min=13.2 med=13.5 max=13.7 usd_med=0.145111
pair t7-sort-table forced n=2 ok=2/2 wall_s min=10.5 med=10.5 max=10.6 usd_med=0.0984
pair t8-status-404 playwright n=2 ok=2/2 wall_s min=11.2 med=12.1 max=13.0 usd_med=0.116605
pair t8-status-404 forced n=2 ok=2/2 wall_s min=10.7 med=10.7 max=10.7 usd_med=0.098142
pair t9-long-chain playwright n=2 ok=2/2 wall_s min=39.2 med=48.9 max=58.5 usd_med=0.270666
pair t9-long-chain forced n=2 ok=1/2 wall_s min=57.8 med=60.4 max=63.0 usd_med=0.195477
pair t10-saucedemo-checkout playwright n=2 ok=2/2 wall_s min=25.4 med=27.1 max=28.9 usd_med=0.222694
pair t10-saucedemo-checkout forced n=2 ok=2/2 wall_s min=28.3 med=29.1 max=29.9 usd_med=0.173096
pair t11-todomvc-spa playwright n=2 ok=2/2 wall_s min=19.4 med=20.3 max=21.3 usd_med=0.184099
pair t11-todomvc-spa forced n=2 ok=2/2 wall_s min=22.0 med=22.2 max=22.4 usd_med=0.171228
pair t12-js-confirm-dialog playwright n=2 ok=2/2 wall_s min=13.7 med=31.2 max=48.7 usd_med=0.154668
pair t12-js-confirm-dialog forced n=2 ok=2/2 wall_s min=17.9 med=23.0 max=28.1 usd_med=0.146466
pair t13-infinite-scroll playwright n=2 ok=2/2 wall_s min=18.0 med=35.7 max=53.3 usd_med=0.128006
pair t13-infinite-scroll forced n=2 ok=2/2 wall_s min=15.4 med=15.6 max=15.9 usd_med=0.099506
pair t14-key-press playwright n=2 ok=2/2 wall_s min=13.7 med=13.8 max=13.9 usd_med=0.132099
pair t14-key-press forced n=2 ok=2/2 wall_s min=14.0 med=14.8 max=15.7 usd_med=0.119406
pair t15-file-upload playwright n=2 ok=0/2 wall_s min=16.1 med=16.5 max=16.9 usd_med=0.140313
pair t15-file-upload forced n=2 ok=2/2 wall_s min=10.1 med=10.3 max=10.4 usd_med=0.0995
pair t16-hover-reveal playwright n=2 ok=2/2 wall_s min=13.8 med=15.5 max=17.2 usd_med=0.133617
pair t16-hover-reveal forced n=2 ok=2/2 wall_s min=11.1 med=14.8 max=18.5 usd_med=0.127852
pair t17-double-click playwright n=2 ok=2/2 wall_s min=10.7 med=11.2 max=11.7 usd_med=0.115148
pair t17-double-click forced n=2 ok=2/2 wall_s min=11.0 med=11.0 max=11.1 usd_med=0.097971
phases t1-checkboxes/forced attach=50 first_observe=15 observe=12+23 jev=357+713 jev first/rest=289/424 act=60+119 settle=108+216 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=60 first_observe=10 observe=9+17 jev=186+371 jev first/rest=240/131 act=26+52 settle=108+215 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=60 first_observe=18 observe=8+49 jev=154+811 jev first/rest=225/147 act=21+2901 settle=216+659 kinds act=3 advance=1 wait=0 bounce=1 done=0 error=0 other=0
phases t4-add-elements/forced attach=45 first_observe=9 observe=7+30 jev=179+722 jev first/rest=221/158 act=38+157 settle=216+647 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=45 first_observe=9 observe=8+15 jev=203+406 jev first/rest=236/170 act=26+51 settle=107+214 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=63 first_observe=10 observe=7+125 jev=133+2296 jev first/rest=128/133 act=3005+28398 settle=217+2402 kinds act=1 advance=1 wait=10 bounce=2 done=0 error=0 other=2
phases t7-sort-table/forced attach=55 first_observe=11 observe=10+20 jev=184+367 jev first/rest=224/143 act=33+66 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=45 first_observe=10 observe=9+26 jev=213+611 jev first/rest=254/179 act=0+91 settle=0+364 kinds act=1 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t9-long-chain/forced attach=13882 first_observe=14 observe=7+28 jev=181+603 jev first/rest=235/67 act=51+3108 settle=109+3221 kinds act=1 advance=0 wait=1 bounce=0 done=0 error=2 other=0
phases t10-saucedemo-checkout/forced attach=86 first_observe=15 observe=8+222 jev=144+4269 jev first/rest=130/145 act=0+511 settle=0+2536 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=2
phases t11-todomvc-spa/forced attach=80 first_observe=12 observe=8+107 jev=209+2726 jev first/rest=0/209 act=0+244 settle=0+1287 kinds act=6 advance=4 wait=0 bounce=2 done=0 error=0 other=1
phases t12-js-confirm-dialog/forced attach=47 first_observe=15 observe=9+49 jev=134+994 jev first/rest=212/130 act=0+85 settle=0+221 kinds act=1 advance=1 wait=0 bounce=1 done=0 error=0 other=2
phases t13-infinite-scroll/forced attach=51 first_observe=10 observe=7+71 jev=166+1895 jev first/rest=250/165 act=220+1591 settle=215+2148 kinds act=9 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t14-key-press/forced attach=63 first_observe=12 observe=8+48 jev=164+981 jev first/rest=105/164 act=0+125 settle=0+430 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=45 first_observe=10 observe=9+18 jev=185+370 jev first/rest=223/147 act=33+66 settle=109+217 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=79 first_observe=10 observe=7+61 jev=162+1118 jev first/rest=0/171 act=47+306 settle=215+1078 kinds act=5 advance=1 wait=0 bounce=2 done=0 error=0 other=0
phases t17-double-click/forced attach=52 first_observe=10 observe=8+16 jev=165+330 jev first/rest=212/118 act=36+71 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t1-checkboxes/forced attach=45 first_observe=11 observe=9+18 jev=161+322 jev first/rest=193/129 act=51+101 settle=107+214 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t2-dropdown/forced attach=48 first_observe=10 observe=9+18 jev=346+692 jev first/rest=249/443 act=24+48 settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t3-dynamic-controls/forced attach=48 first_observe=13 observe=7+41 jev=143+802 jev first/rest=204/143 act=18+2885 settle=216+652 kinds act=3 advance=1 wait=0 bounce=1 done=0 error=0 other=0
phases t4-add-elements/forced attach=51 first_observe=10 observe=9+34 jev=152+661 jev first/rest=224/149 act=40+182 settle=218+655 kinds act=3 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t5-inputs/forced attach=46 first_observe=9 observe=9+18 jev=219+438 jev first/rest=234/204 act=51+101 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t6-dynamic-loading/forced attach=60 first_observe=10 observe=7+114 jev=144+2351 jev first/rest=120/144 act=3005+28375 settle=217+2394 kinds act=1 advance=1 wait=10 bounce=2 done=0 error=0 other=2
phases t7-sort-table/forced attach=49 first_observe=11 observe=11+21 jev=208+415 jev first/rest=263/152 act=38+75 settle=111+222 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t8-status-404/forced attach=64 first_observe=12 observe=10+20 jev=182+364 jev first/rest=224/140 act=47+94 settle=197+394 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t9-long-chain/forced attach=104 first_observe=15 observe=8+478 jev=141+8772 jev first/rest=152/139 act=0+7922 settle=0+8269 kinds act=23 advance=17 wait=2 bounce=4 done=0 error=0 other=12
phases t10-saucedemo-checkout/forced attach=81 first_observe=11 observe=8+209 jev=148+3687 jev first/rest=137/148 act=0+500 settle=0+2458 kinds act=11 advance=10 wait=0 bounce=1 done=0 error=1 other=1
phases t11-todomvc-spa/forced attach=86 first_observe=19 observe=10+140 jev=132+1617 jev first/rest=0/134 act=0+288 settle=0+1302 kinds act=6 advance=4 wait=0 bounce=2 done=0 error=0 other=1
phases t12-js-confirm-dialog/forced attach=47 first_observe=12 observe=11+21 jev=382+763 jev first/rest=316/447 act=47+94 settle=112+223 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t13-infinite-scroll/forced attach=55 first_observe=11 observe=8+80 jev=148+1529 jev first/rest=251/146 act=221+1401 settle=217+2376 kinds act=9 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t14-key-press/forced attach=68 first_observe=12 observe=9+55 jev=163+1045 jev first/rest=127/163 act=0+138 settle=0+442 kinds act=2 advance=2 wait=0 bounce=1 done=0 error=0 other=1
phases t15-file-upload/forced attach=48 first_observe=10 observe=9+17 jev=204+407 jev first/rest=288/119 act=30+59 settle=109+218 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
phases t16-hover-reveal/forced attach=53 first_observe=9 observe=9+34 jev=144+607 jev first/rest=195/128 act=25+139 settle=110+442 kinds act=2 advance=2 wait=0 bounce=0 done=0 error=0 other=0
phases t17-double-click/forced attach=44 first_observe=8 observe=7+14 jev=168+336 jev first/rest=222/114 act=43+85 settle=110+219 kinds act=1 advance=1 wait=0 bounce=0 done=0 error=0 other=0
legend: cell lines carry RAW tokens (no price table); route min/med/max is the spread convention; phases lines med+sum, first/rest medians are 0 when the bucket is empty; pair lines aggregate repeats
```
