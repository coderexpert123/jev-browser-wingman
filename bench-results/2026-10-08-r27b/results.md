# r27b full gauntlet, r25+r26 code (HEAD 10ac0cb7a2a0c6605de6653b2aa64908818665aa)
(retry of r27; the first attempt was refused for the invalid --purpose gauntlet; this run uses --purpose measure)

BUILD: ok; tree clean; chain 221/221 pass 0 fail; Jev probe exit 0 (status 200); no cold-start retry needed.

## BENCH-BASELINE
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="10ac0cb7a2a0c6605de6653b2aa64908818665aa"
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.294"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: expected-diff prompts_sha256 baseline="7c9dcc33b4a65dffd9439f100d065dd0f771429667b200276cf007b6de9b46f6" run="027f31908de892a62378d8f48d351ec91f213cd69d1e3ec5fd1c98a3affeb0a2"
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version,prompts_sha256
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version,prompts_sha256
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
## Summary (68 cells, aborted null, total_usd 9.099553)
```
BENCH REPORT 2026-10-08-110201.json purpose=measure model=sonnet harness=3 aborted=null total_usd=9.099553 runs=68
route playwright n=34 ok=32/34 wall_s min=11.4 med=15.5 max=37.4 usd min=0.07369 med=0.185321 max=0.311015
route forced n=34 ok=34/34 wall_s min=11.3 med=16.0 max=51.8 usd min=0.056116 med=0.0745565 max=0.227374
```
| metric | r27b | r24d reference |
|---|---|---|
| forced ok | 34/34 | 33/34 |
| playwright ok | 32/34 (t15 both reps, the known red) | 32/34 |
| forced hand-backs | 2 (both t9 rep 2) | 7 |
| forced usd_total | 3.753 (median 0.0746/cell) | 4.016 (0.124) |
| playwright usd_total | 5.347 (median 0.185) | 5.516 (0.176) |
| forced wall median | 16.0 s | 12.0 s |
| playwright wall median | 15.5 s | 12.7 s |
| forced tool_calls mean | 2.38 | 2.65 |
| playwright tool_calls mean | 5.35 | 5.38 |

Wall medians are higher on BOTH routes (forced 16.0 vs 12.0, playwright 15.5 vs 12.7), so this reads as run-environment drift rather than a forced-only regression; not investigated.

## Checks
- a. Oracle ok: forced 34/34, playwright 32/34 (t15-file-upload, both reps).
- b. Forced hand-backs: 2, both t9 rep 2 (call 3 fallback/step-uncertain why=wrong-page class=error-page; call 4 fallback/step-uncertain why=no-match class=target-uncertain). The success criterion of 0 is not met: t9 is not among the tasks the r25/r26 fixes target; t9 rep 2 took 5 calls, 56 rounds, 51.8 s with 2 error ends (page-error x2) before the two hand-backs, and still passed. t9 rep 1: 3 calls, 52 rounds, 39.9 s, 2 error ends (page-error, act-failed), 0 hand-backs. t8 and t11 hand-backs are 0 (r24d: 2 and 5).
- c. pressAfterFill:true appears 4 times (2 per t11 forced rep): met.
- d. t10: both forced reps took 2 calls (login/login-page then done/goal-met); loginSuppressed:true appears 10 times in the log slice; t10 ends done/goal-met on both reps.
- e. waitSatisfied:true appears 0 times (the t6 wait clause was never re-sent alone; t6 passed in 1 call, 5 rounds each rep).
- f. Spend: total 9.099553 (forced 3.753 vs 4.016; playwright 5.347 vs 5.516).
- g. Wall/tool calls: see table.
- h. BENCH-OBSERVED warnings=0.
- Invariant typesafe.calls == browse_step: 34 of 34 forced cells match, 0 mismatches.
- Per forced cell (calls, rounds, hand-backs, error ends): every task except t9 is 1 call (t10 is 2: login end then done); full list in the explain files.

## triage (first 13 lines)
```
HANDBACK-TRIAGE results=bench/results/2026-10-08-110201.json offset=0 handbacks=2
class error-page 1
class target-uncertain 1
no_wingman_done_cells 0 
route playwright runs=34 ok=32 usd_total=5.34689 usd_median=0.185321 tool_calls_total=182 tool_calls_median=4 tool_calls_mean=5.352941 wall_median_ms=15460
route forced runs=34 ok=34 usd_total=3.752663 usd_median=0.074557 tool_calls_total=81 tool_calls_median=2 tool_calls_mean=2.382353 wall_median_ms=15951.5
r24_flags 14 finalNavEvidence=1 hoverEvidence=2 pressFocusSum=2 readySkipped=2 sameDocEvidence=4 stuckSecond=1 waitEvidence=2
r24_flag_suspects 0
handback t9-long-chain#2 call3 fallback/step-uncertain why=wrong-page class=error-page
handback t9-long-chain#2 call4 fallback/step-uncertain why=no-match class=target-uncertain
config {"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"10ac0cb7a2a0c6605de6653b2aa64908818665aa","git_dirty":false,"routes":["playwright","forced"],"repeats":2,"tasks":["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-so
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
observed {"node_version":"v22.22.0","chrome_version":"Chrome/141.0.7390.37","caller_tools_sha256":{"playwright":"eb118c362480aa65c7a91633b3418492a665483f32617faf1435bfcc67ee9161","forced":"d72dfbbfcd596b3c814589988946a4ad1dc0da2dc56e3eaa6bc8949cf109ccc2"},"caller_skills_sha256":{"playwright":"c63abd
```
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
log_stance off/off=42
telemetry rounds=268 with_url=268

## Spend: 9.099553. LEDGER before=132.070126 after=141.169679
Log slice bytes: 193317
