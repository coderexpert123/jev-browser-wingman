# r17c progress (HEAD 7ec9045)

## Part 1 chrome-only at 7ec9045 (16 files, serial, one per invocation; no first-run failures, no re-runs)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 (E18b included) | pick-e2e 2/2 | adapter-cdp 10/10 (23 s, no wedge) | adapter-playwright 10/10 | page-scripts 21/21 | doctor 28/28 | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16. chrome-cmd not in scope this round.

## Part 1b KB_CDP_GROWTH_WAIT (build .build/kb-r17c, flag flipped in src/adapters/cdp.ts, restored via git checkout, rebuilt)
chain-e2e under the flag: 19/20, the single failure is E18b "an async wheel-triggered append is waited out, not bounced (r17c)" - PROVEN. Log: part1b/chain-e2e.flagged.log. src clean after restore.

## Stage 0 attempt 1 (t14 forced x1, phase cap 18.702391 = ledger 10.702391 + 8): oracle FALSE, 21.4 s, 0.2204 USD
- Escape was NEVER attempted: all 3 browse_step calls ended `error/act-failed`, steps 0, jev_calls 0, ms 40-116, host '' (page not on the target URL), act_error `TypeError: Failed to execute ... on ...: parameter 1 is not of type ...` in the FIRST observe (observeMs 0). end_state " | focus=none" (no #result, no active element).
- Zero-spend probes (evidence/probe-esc.mjs, probe-obs.mjs): plain Playwright on /key_presses: Escape -> "You entered: ESCAPE", Enter -> "You entered: ENTER", no reload, focus stays on #target. The shipped driver's observe() works on about:blank AND /key_presses on both adapters (2 elements, scrollY 0). So the failure is bench page state, not the key and not observe on the page itself.

## Stage 0 attempt 2 (re-run once; attempt 1 never reached Escape): oracle TRUE, 16.3 s, 0.0784 USD, handoffs 1, picks 1
- end_state "You entered: ESCAPE | focus=target" (Escape landed on the input, no reload). Calls: (1) click -> focus-only click bounced fallback/step-uncertain after 1 click, 4 rounds; (2) done/goal-met, 1 press, keyEvidence true + clickEvidence true ("page changed"). Stage 0 PASSES -> A and B proceed.

## Invocation A (playwright x1, t13+t14): total 0.3890 USD
- t13 ok 18.4 s 0.198 (raw_script 1; end_state "10 items | scrollY=3148") | t14 ok 13.2 s 0.191 (raw_acts 2; end_state "You entered: ESCAPE | focus=target")

## Invocation B (forced x3, t13+t14): 6/6 oracle true, total 0.5188 USD (results/B-forced-2026-10-03-015316.json)
- t13 x3: ok 16.7/16.2/15.6 s, 0.172/0.056/0.056 USD; end_state "10 items | scrollY=3148/3132/3148". Each cell = ONE browse_step call (tool_use_counts), 8 scroll acts, final round countEvidence=10 (countMetP 0.50-0.51) -> done/goal-met. NOTE harness columns show handoffs 0 / wingman.calls 0 / handoff_records [] for these cells although the log has the call (harness under-count on single-call goal-met cells).
- t14 x3: ok 15.8/14.0/13.8 s, 0.078/0.078/0.078 USD, handoffs 1 picks 1 wingman_acts 1; end_state "You entered: ESCAPE | focus=target" x3. Each = 2 calls: focus-only click bounced fallback/step-uncertain (4 rounds) then done/goal-met on 1 press (keyEvidence + clickEvidence).

## Doctor 3x on the bench Chrome: PASS x3 (coexistence identical fingerprint). Final write-up: results.md. Total r17c spend 1.2066 USD.
