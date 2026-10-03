# r17c progress (HEAD 7ec9045)

## Part 1 chrome-only at 7ec9045 (16 files, serial, one per invocation; no first-run failures, no re-runs)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 (E18b included) | pick-e2e 2/2 | adapter-cdp 10/10 (23 s, no wedge) | adapter-playwright 10/10 | page-scripts 21/21 | doctor 28/28 | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16. chrome-cmd not in scope this round.

## Part 1b KB_CDP_GROWTH_WAIT (build .build/kb-r17c, flag flipped in src/adapters/cdp.ts, restored via git checkout, rebuilt)
chain-e2e under the flag: 19/20, the single failure is E18b "an async wheel-triggered append is waited out, not bounced (r17c)" - PROVEN. Log: part1b/chain-e2e.flagged.log. src clean after restore.

## Stage 0 attempt 1 (t14 forced x1, phase cap 18.702391 = ledger 10.702391 + 8): oracle FALSE, 21.4 s, 0.2204 USD
- Escape was NEVER attempted: all 3 browse_step calls ended `error/act-failed`, steps 0, jev_calls 0, ms 40-116, host '' (page not on the target URL), act_error `TypeError: Failed to execute ... on ...: parameter 1 is not of type ...` in the FIRST observe (observeMs 0). end_state " | focus=none" (no #result, no active element).
- Zero-spend probes (evidence/probe-esc.mjs, probe-obs.mjs): plain Playwright on /key_presses: Escape -> "You entered: ESCAPE", Enter -> "You entered: ENTER", no reload, focus stays on #target. The shipped driver's observe() works on about:blank AND /key_presses on both adapters (2 elements, scrollY 0). So the failure is bench page state, not the key and not observe on the page itself.
