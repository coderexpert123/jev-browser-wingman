# r24c full gauntlet + capture probe (HEAD 2f8e460179f1c6c6c135df98013f3fa15271c685)

## HEADLINE: the forced measurement is NOT clean: Jev returned HTTP 402 from mid-run (environmental, not a code result)
Forced 23/34. The 11 forced failures are t6..t17 rep 2 (all but t12), each ending fallback/jev-error x3 with 0 tokens used. The first jev-error record in the log slice is at 2026-10-07T02:55:34Z (record 28 of 65); 37 records end fallback/jev-error. The post-run capture probe's two Jev requests both returned status=402 error=http retries=0 (response.ok=false), so the Jev endpoint was refusing requests (402 = payment/quota). The 11 failures say nothing about the r24c step fixes.

## Part 1 (23 files, all green, no timeouts, leaks 0)
```
withhold rc=0 wall=0s leaked=0 # tests 18 # pass 18 # fail 0 # skipped 0 # todo 0 
questions rc=0 wall=0s leaked=0 # tests 33 # pass 33 # fail 0 # skipped 0 # todo 0 
pick rc=0 wall=1s leaked=0 # tests 23 # pass 23 # fail 0 # skipped 0 # todo 0 
egress rc=0 wall=0s leaked=0 # tests 6 # pass 6 # fail 0 # skipped 0 # todo 0 
lib rc=0 wall=1s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
cli rc=0 wall=5s leaked=0 # tests 6 # pass 6 # fail 0 # skipped 0 # todo 0 
leak-scan rc=0 wall=0s leaked=0 # tests 4 # pass 4 # fail 0 # skipped 0 # todo 0 
chain rc=0 wall=2s leaked=0 # tests 209 # pass 209 # fail 0 # skipped 0 # todo 0 
outcome-evidence rc=0 wall=0s leaked=0 # tests 49 # pass 49 # fail 0 # skipped 0 # todo 0 
loop rc=0 wall=5s leaked=0 # tests 56 # pass 56 # fail 0 # skipped 0 # todo 0 
takeover rc=0 wall=0s leaked=0 # tests 38 # pass 38 # fail 0 # skipped 0 # todo 0 
boundary rc=0 wall=0s leaked=0 # tests 19 # pass 19 # fail 0 # skipped 0 # todo 0 
bounce-escalation rc=0 wall=1s leaked=0 # tests 8 # pass 8 # fail 0 # skipped 0 # todo 0 
handback-triage rc=0 wall=0s leaked=0 # tests 12 # pass 12 # fail 0 # skipped 0 # todo 0 
grader-replay rc=0 wall=1s leaked=0 # tests 14 # pass 14 # fail 0 # skipped 0 # todo 0 
bench-browse rc=0 wall=0s leaked=0 # tests 31 # pass 31 # fail 0 # skipped 0 # todo 0 
bench-cap rc=0 wall=1s leaked=0 # tests 11 # pass 11 # fail 0 # skipped 0 # todo 0 
bench-run-config rc=0 wall=2s leaked=0 # tests 17 # pass 17 # fail 0 # skipped 0 # todo 0 
chain-e2e rc=0 wall=120s leaked=0 # tests 20 # pass 20 # fail 0 # skipped 0 # todo 0 
pick-e2e rc=0 wall=6s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
redaction-e2e rc=0 wall=4s leaked=0 # tests 1 # pass 1 # fail 0 # skipped 0 # todo 0 
act-nav rc=0 wall=68s leaked=0 # tests 7 # pass 7 # fail 0 # skipped 0 # todo 0 
adapter-playwright rc=0 wall=30s leaked=0 # tests 10 # pass 10 # fail 0 # skipped 0 # todo 0 
P1DONE
```
## leak-teeth
```
LEAK /tmp/r24b-known-bad/log-slice.jsonl t11-todomvc-spa.item1 hits=15
LEAK /tmp/r24b-known-bad/log-slice.jsonl t11-todomvc-spa.item2 hits=2
leaks=1 files=1 hits=17
exit=1
```
## Preflight
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="2f8e460179f1c6c6c135df98013f3fa15271c685"
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.292"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version
BENCH-OBSERVED: warnings=0 (preflight sees the Node version only; warnings never block)
BENCH-PREFLIGHT: ok nothing ran config={"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"2f8e460179f1c6c6c135df98013f3fa15271c685","git_dirty":false,"routes":["playwright","forced"],"repeats
exit=0
```
files-outside-allowlist=0; typesafe-base-url-set=0; caller_cli_version=2.1.292 (operator-accepted); 7b hash line count=1
```
CLAUDE.md now=210634c00a0f r24b=210634c00a0f
bench/CLAUDE.md now=5d6701666878 r24b=5d6701666878
2.1.292 (Claude Code)
```
env-names.txt: names only, in preflight/.
## Smoke (spend 0.379626; slice 14975 bytes, 19 rounds; t4 ok 27.3 s, t11 ok 17.7 s)
```
a PASS
b PASS
c PASS
g PASS
i PASS
h titles=19 PASS
d PASS
e PASS (log_stance off/off=4, handoff_records sum 4)
f PASS (with_url=19)
j PASS (leaks=0 files=2 hits=0, exit=0)
```
smoke markers: 7 x <value:item1, 1 x <value:item2. smoke leak scan: leaks=0 files=2 hits=0 exit=0.
smoke observed: {"node_version":"v22.22.0","chrome_version":"Chrome/141.0.7390.37","caller_tools_sha256":{"forced":"d72dfbbfcd596b3c814589988946a4ad1dc0da2dc56e3eaa6bc8949cf109ccc2"},"caller_skills_sha256":{"forced":"c63abdf381ba3b8ead3567e3b54964a16572719699461ce4ceecfc2f4dc58301"},"caller_plugins_sha256":{"forced":"1aa91757661dc31a707db2c2dfe082049b2bfea99bc6ef0c612ab4eb18bca9b0"},"caller_agents_sha256":{"forced":"eec7d3f094f7a5f7fdd06009b5ea638630466fcf58284553c431d2756e83031d"},"caller_mcp_s
observed_lists.forced: keys=tools,skills,plugins,agents,mcp_servers,hooks
## Gauntlet
```
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
BENCH REPORT 2026-10-07-030040.json purpose=measure model=sonnet harness=3 aborted=null total_usd=9.753586 runs=68
route playwright n=34 ok=32/34 wall_s min=7.9 med=11.1 max=28.7 usd min=0.070987 med=0.176356 max=0.428248
route forced n=34 ok=23/34 wall_s min=8.5 med=12.5 max=37.2 usd min=0.054262 med=0.1151125 max=0.214063
Playwright 32/34 (t15 both reps: the known red). Forced 23/34: see headline.

### triage-r24c lines 1-13
```
HANDBACK-TRIAGE results=bench/results/2026-10-07-030040.json offset=0 handbacks=40
class landed-not-advanced 2
class other 36
class press-split 1
class target-uncertain 1
no_wingman_done_cells 12 t6-dynamic-loading#2 t7-sort-table#2 t8-status-404#2 t9-long-chain#2 t10-saucedemo-checkout#2 t11-todomvc-spa#2 t12-js-confirm-dialog#2 t13-infinite-scroll#2 t14-key-press#2 t15-file-upload#2 t16-hover-reveal#2 t17-double-click#2
route playwright runs=34 ok=32 usd_total=5.411069 usd_median=0.176356 tool_calls_total=187 tool_calls_median=4 tool_calls_mean=5.5 wall_median_ms=11111.5
route forced runs=34 ok=23 usd_total=4.342517 usd_median=0.115113 tool_calls_total=105 tool_calls_median=2.5 tool_calls_mean=3.088235 wall_median_ms=12480.5
r24_flags 9 finalNavEvidence=1 hoverEvidence=1 pressFocusSum=1 readySkipped=1 sameDocEvidence=3 stuckSecond=1 waitEvidence=1
r24_flag_suspects 1 t9-long-chain#1/call2/r10/stuckSecond
handback t8-status-404#1 call1 fallback/step-uncertain why=low-confidence class=target-uncertain
handback t11-todomvc-spa#1 call1 fallback/step-uncertain why=no-match class=press-split
handback t11-todomvc-spa#1 call2 fallback/step-uncertain why=no-match class=landed-not-advanced
```
### triage-r24b line 1 and policy line
```
HANDBACK-TRIAGE results=/tmp/r24b.json offset=0 handbacks=27
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
log_stance off/off=65
telemetry rounds=311 with_url=311
```
### config/policy_ends/log_stance/telemetry r24c
```
config {"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"2f8e460179f1c6c6c135df98013f3fa15271c685","git_dirty":false,"routes":["playwright","forced"],"repeats":2,"tasks":["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedemo-checkout","t11-todomvc-spa","t12-js-confirm-dialog","t13-infinite-scroll","t14-key-press","t15-file-upload","t16-hover-reveal","t17-double-click"],"model":"sonnet","log_labels":true,"caller_cli_version":"2.1.292","adapter":"playwright","harnes
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
log_stance off/off=65
telemetry rounds=193 with_url=193
```
### r24c-flags
```
r24c_flags stateEvidence=2 waitEvidence=1 stuckSecond=1 pressFocusSum=1
```
### Step 18 like-for-like
(i) policy_ends 0 line present: YES. (ii) log_stance off/off=65 == forced handoff_records 65: YES. (iii) BENCH-BASELINE-POST ok keys=1: YES. (iv) caller_model claude-sonnet-5-5 and cli 2.1.292 equal the smoke, not mixed: YES. (v) aborted null: YES. (vi) node, chrome and forced list hashes equal the smoke: YES.
## Invariant: forced=34 matches=34 mismatches=0
## Suspects: 1 (t9-long-chain#1/call2/r10/stuckSecond; explain/t9-long-chain-1.txt)
## Capture probe (Jev tokens only)
```
capture: 2 rounds -> /home/user/jev-browser-wingman/bench-results/2026-10-07-r24c/capture/xcall.jsonl (2 calls, thresholds from dist/src/contract/constants.js)
exit=0
leaks=0 files=1 hits=0
exit=0
```
Both capture requests were answered 402 (no response answers, no target probabilities to report). Request-side: markers of the bound value name in xcall.jsonl: 2. Leak scan: leaks=0 files=1 hits=0, exit=0. The wire question (cross-call redaction on the second call) cannot be judged from responses; r24b reference 0.97 on the checkbox is not reproduced.
## Spend: smoke 0.379626 + gauntlet 9.753586 = 10.133212 (capture probe outside the ledger, 402 so no tokens)
LEDGER0=108.818270 LEDGER1=109.197896 after=118.951482
Log slice bytes: smoke 14975, gauntlet 145448
