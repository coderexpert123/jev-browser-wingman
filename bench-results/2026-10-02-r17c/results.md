# r17c - t13 count evidence and t14 Escape redesign (HEAD 7ec9045)

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, Xvfb :99, cloud Sonnet caller, gate off, policy off, `--purpose measure`, `--cap-usd 3.00`, `--phase-cap-usd 18.702391` (ledger 10.702391 + 8). `npm ci` skipped (package-lock unchanged); `npm run build` ran once (tsc ok, 107 files). Non-Chrome suite not re-run (operator: 474/474 local). Total r17c spend 1.2066 USD (Stage 0 attempt 1 0.2204, attempt 2 0.0784, A 0.3890, B 0.5188).

## Part 1 (Chrome-only, 16 files, serial, one per invocation) - all green, no first-run failures
| file | result | wall | file | result | wall |
|---|---|---|---|---|---|
| acquire | 6/6 | 0 s | adapter-playwright | 10/10 | 31 s |
| chrome | 28/28 | 14 s | page-scripts | 21/21 | 6 s |
| conformance | 28/28 | 38 s | doctor | 28/28 | 9 s |
| conformance-ops | 44 pass + 1 todo (O18) | 36 s | with-chrome | 32/32 | 5 s |
| chain-e2e | 20/20 (E18b incl.) | 118 s | with-chrome-forced | 3/3 | 11 s |
| pick-e2e | 2/2 | 7 s | runner-sweep | 2/2 | 1 s |
| adapter-cdp | 10/10 (no wedge) | 23 s | runner-sweep-leak | 1/1 | 1 s |
| scaffold | 16/16 | 5 s | ephemeral-sweep | 7/7 | 0 s |

## Part 1b KB proof
`KB_CDP_GROWTH_WAIT=true` (src/adapters/cdp.ts), `.build/kb-r17c`, chain-e2e: 19/20, the single failure is **E18b** (async wheel-triggered append is waited out). PROVEN. src restored via git checkout and rebuilt.

## Stage 0 verdict: PASS (on the one allowed re-run)
- **Attempt 1:** oracle false, but Escape was never attempted. All 3 `browse_step` calls ended `error/act-failed`, 0 steps, `jev_calls` 0, 40-116 ms, host '', act_error `TypeError: Failed to execute ... on ...: parameter 1 is not of type ...` in the first observe (observeMs 0). end_state " | focus=none" (no #result, no active element). I did not extend PRESS_KEYS or change anything. Zero-spend probes: (a) plain Playwright on /key_presses - Escape gives "You entered: ESCAPE", Enter gives "You entered: ENTER", no reload, focus stays on #target (so the r17 "Enter reloads" reading does not reproduce in this probe); (b) the shipped driver's observe() succeeds on about:blank and on /key_presses with both adapters. So the failure is bench page state at cell start, not the key and not observe on the page. Same shape (act-failed x2, host '') preceded the passing t12 rep 3 in r17. Cause not found; recurring and intermittent. Stage 0's gate wording ("Escape does not land") was not met - Escape was never tried - so I re-ran Stage 0 once rather than stop, and say so here.
- **Attempt 2:** oracle TRUE, end_state "You entered: ESCAPE | focus=target", 16.3 s, 0.0784 USD.

## Per-cell table
| cell | task | route | ok | wall s | usd | handoffs | picks | wingman_acts | end_state |
|---|---|---|---|---|---|---|---|---|---|
| S0a | t14 | forced | F | 21.4 | 0.2204 | 2 | 0 | 0 | " \| focus=none" (act-failed x3) |
| S0b | t14 | forced | T | 16.3 | 0.0784 | 1 | 1 | 1 | "You entered: ESCAPE \| focus=target" |
| A1 | t13 | playwright | T | 18.4 | 0.1982 | 0 | 0 | 0 | "10 items \| scrollY=3148" (raw_script 1) |
| A2 | t14 | playwright | T | 13.2 | 0.1909 | 0 | 0 | 0 | "You entered: ESCAPE \| focus=target" (raw_acts 2) |
| B1 | t13 | forced | T | 16.7 | 0.1717 | 0* | 0 | 0* | "10 items \| scrollY=3148" |
| B2 | t14 | forced | T | 15.8 | 0.0780 | 1 | 1 | 1 | "You entered: ESCAPE \| focus=target" |
| B3 | t13 | forced | T | 16.2 | 0.0564 | 0* | 0 | 0* | "10 items \| scrollY=3132" |
| B4 | t14 | forced | T | 14.0 | 0.0780 | 1 | 1 | 1 | "You entered: ESCAPE \| focus=target" |
| B5 | t13 | forced | T | 15.6 | 0.0564 | 0* | 0 | 0* | "10 items \| scrollY=3148" |
| B6 | t14 | forced | T | 13.8 | 0.0783 | 1 | 1 | 1 | "You entered: ESCAPE \| focus=target" |
*Harness under-count: for the t13 forced cells the results JSON shows handoffs 0 / wingman.calls 0 / handoff_records [] although `tool_use_counts` has 1 `browse_step` and the wingman log has the call with 8 scroll acts. The wingman log is the source of truth here. Not fixed.

## t13 count-evidence verdict: FIRED LIVE, in ONE call, 3/3
- Each forced t13 cell is a single `browse_step` call: `acts_by_op.scroll` = 8, status `done/goal-met`, progress 1/1. No caller re-delegation, no raw tools.
- countMetP per round (cell 1): 0.35, 0.38, 0.32, 0.41, 0.40, 0.43, 0.38, 0.39, then **0.50 with `countEvidence: 10`** on round 9. Cell 2: 0.32, 0.40, 0.34, 0.39, 0.41, 0.46, 0.39, 0.37, then 0.50 with countEvidence 10. Cell 3: 0.29, 0.37, 0.32, 0.40, 0.41, 0.41, 0.37, 0.34, then 0.51 with countEvidence 10. Jev alone stayed below 0.5 on all 24 pre-evidence rounds (r17: 0.28-0.32); the stop came from the loop's count evidence reading 10 blocks.
- Why-buckets on t13: `done/goal-met` 3, **no-progress 0** (r17: 23 of 24 calls ended no-progress). All 8 scroll rounds read `historyResult: "page changed"` (r17: "no visible change").
- Growth wait visible in act_ms: scroll act_ms r17 median 8 ms (max 15, 0 of 15 >= 200 ms) vs r17c median 223.5 ms (22-229, 16 of 24 >= 200 ms). The ~225 ms acts are the 200 ms-poll wait engaging.
- scrollY telemetry: `Observation.scrollY` is evidence-only; no scrollY field exists in the round/log records, so none is reported. end_state scrollY 3132-3148 (oracle-side).

## t14 oracle and end_state
- Oracle TRUE in all 5 cells that reached the page (forced 3/3 plus the Stage-0 retry, playwright 1/1); end_state "You entered: ESCAPE | focus=target" every time: #result contains escape and focus is the input, not body.
- Forced t14 shape (3 of 3, identical): call 1 = click the input field -> round 1 `click` (actMs ~110-130), then rounds with `historyResult: "focus changed"` (a focus-only click) and a `press` decision; ends `fallback/step-uncertain` after 1 act (the focus-only-click bounce from r16 persists, now harmless); call 2 = `done/goal-met`, 1 `press`, `clickEvidence` + `keyEvidence` true, historyResult "page changed". Focus telemetry: the click round's result is "focus changed" (focus moved to the field) before the press.

## Doctor cloud confirmation (3 runs, bench Chrome on port 9344, WINGMAN_HOME=bench/.home)
3/3 `verdict: PASS`; `coexistence: observer fingerprint identical across attach/detach (1 page(s))` all three times. Logs in evidence/doctor{1,2,3}.log.

## Telemetry (forced runs, 9 wingman records; evidence/B-forced-log-slice.jsonl)
- Buckets: done/goal-met 6, fallback/step-uncertain 3 (all the t14 focus-only click), no-progress 0 (r17: 26), repeat 0, post-action 0.
- loginSuppressed 0 (no t10 cells). keyEvidence: 3 rounds (one per t14 cell, all `true` with clickEvidence). countEvidence 3 (t13). act_error 0 on B; stuck/recover 0; re-submits 0; repeats on remembered targets 0; reloads after effective clicks 0; premature advances 0 (all 6 done ends were oracle-true).
- Stage 0 attempt 1 had 3 `act-failed` records (above); that is the only error status this round.

## Caveats
Small n (3 forced cells per task, 1 playwright). Live the-internet.herokuapp.com. The intermittent first-observe TypeError (host '') is unexplained and recurs (r17 t12 rep 3, r17c Stage 0 attempt 1). Harness handoff/wingman-call counters under-count single-call goal-met cells. The scrollY observation is not logged.

## Verdict on the r17 residuals
- **t13 count evidence: CLOSED** (3/3 forced cells stop at 10 on count evidence in one call, 0 no-progress; growth wait shows in act_ms; KB proof E18b).
- **t14 oracle: CLOSED** with the Escape redesign (5/5 reaching the page, end_state proves the key lands on the input). Residual: the focus-only click still bounces `step-uncertain` once per t14 cell (costs one extra handoff), and a start-of-cell `act-failed` flake (not Escape-related) cost one Stage-0 cell.
