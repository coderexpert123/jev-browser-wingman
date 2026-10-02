# r17 - generalization-fix round (HEAD be0128c)

Environment: cloud Linux, Chrome 141 headless via chromium-wrapper, cloud Sonnet caller, gate off, policy off, `--purpose measure`, `--cap-usd 3.00`, `--phase-cap-usd 30.814594` (ledger 5.814594 + 25). `.build-r17-spec.md` is not in the repo or any branch, so the "8 telemetry items" below follow the items the prompt names, not the spec's numbering.

## Part 1 re-run (51 files, 5 serial chunks) - 852 tests, 849 pass, 1 fail, 1 skip, 1 todo
- browse-step-surface 7/7, chain-e2e 19/19, page-scripts 20/20, adapter-playwright 9/9 (new r17b check test passes). lazy-chrome ok; `--known-bad tool-call` fails with answered=true.
- One failure: doctor "all ten checks pass on a clean ephemeral setup" - `coexistence: observer fingerprint changed across attach/detach`. Isolated re-runs: PASS once, FAIL once (3 runs, 2 fails): intermittent, not in a r17-touched file, not fixed. Logs: part1-rerun/logs/doctor*.log (doctor runs on a temp home; no wingman log slice exists).

## Part 1b cloud KB proof (.build/kb-r17c, src restored byte-clean)
| flag | mapped leg(s) that FAILED under the flag | note |
|---|---|---|
| KB_HIDDEN_SIBLING | page-scripts hidden-controls names; page-scripts verify re-find; chain-e2e E19 | OK |
| KB_CDP_PRESS_NONE | conformance-ops O19 (cdp); chain-e2e E17 | OK |
| KB_CDP_DIALOG | conformance-ops O20 (cdp); adapter-cdp answerDialog-no-dialog; chain-e2e E14, E15 | OK |
| KB_CDP_CHECK_TOGGLE | chain-e2e E19 | OK (expected) |
| KB_PW_PRESS_NONE | conformance-ops O19 (playwright) | OK; adapter-playwright passes (not a discriminator) |
| KB_PW_DIALOG | conformance-ops O20 (playwright) | OK; adapter-playwright answerDialog leg PASSES under the flag (non-discriminating) |

## Part 2 per-cell table (A = playwright x2; B = forced x3; B aborted after 14 cells on a harness `cdp timeout: Page.navigate`; the missing t14 rep3 was re-run as a 1-cell supplement S, same flags/caps)
| cell | task | route | ok | wall s | usd | handoffs | picks | wingman_acts | end_state |
|---|---|---|---|---|---|---|---|---|---|
| A1/A2 | t10 | playwright | T/T | 27.1/19.0 | .276/.162 | 0 | 0 | 0 | |
| A1/A2 | t11 | playwright | T/T | 15.4/14.6 | .256/.148 | 0 | 0 | 0 | |
| A1/A2 | t12 | playwright | T/T | 10.1/55.9 | .202/.112 | 0 | 0 | 0 | "You clicked: Ok \| focus=button" |
| A1/A2 | t13 | playwright | T/T | 15.2/15.4 | .185/.087 | 0 | 0 | 0 | "10 items \| scrollY=3148" / "10 items \| scrollY=3164" |
| A1/A2 | t14 | playwright | F/F | 11.3/10.0 | .202/.080 | 0 | 0 | 0 | " \| focus=body" x2 |
| B1-3 | t10 | forced | T/T/T | 26.2/23.9/25.4 | .276/.136/.163 | 4/4/3 | 0 | 12/12/11 | |
| B1-3 | t11 | forced | T/T/T | 24.9/21.1/20.3 | .309/.159/.131 | 4/3/4 | 2/2/3 | 8/7/7 | |
| B1-3 | t12 | forced | T/T/T | 14.3/13.7/42.9 | .226/.116/.182 | 1/1/3 | 0/0/1 | 1/1/1 | "You clicked: Ok \| focus=button" x3 |
| B1-3 | t13 | forced | T/T/F | 37.8/38.1/34.1 | .597/.398/.189 | 8/6/4 | 1/3/3 | 8/9/3 | "10 items \| scrollY=3180" / "11 items \| scrollY=3548" / "0 items \| scrollY=0" |
| B1-2,S | t14 | forced | F/F/F | 9.4/11.2/9.6 | .165/.076/.055 | 1/2/0 | 0/1/0 | 2/2/0 | " \| focus=body" x3 |
Spend: A 1.709, B 3.124, S 0.055. Forced-verdict not run (bars are t9-tuned, as in r16b).

## r16 vs r17 (forced unless stated)
| task | r16 | r17 | note |
|---|---|---|---|
| t10 | 3/3, 5 handoffs/cell, 12 login ends | 3/3, 4/4/3 handoffs, 3 login ends (1 per cell) | login ends 12 -> 3 as predicted |
| t11 | 0/3 (press + hidden checkbox failed) | 3/3 | press + check both executed, keyEvidence on 8 rounds |
| t12 | 0/3 (deadlock, ~100 s) | 3/3, 13.7-42.9 s | 3 dialogs answered "accept" |
| t13 | 2/3 | 2/3 | **not** via count evidence (see below) |
| t14 | 0/3 forced, 0/2 playwright | 0/3 forced (incl. supplement), 0/2 playwright | oracle still false on both routes |

## The five r16 defects
1. **t10 login ends: mostly closed.** 12 -> 3. All 3 occur on the final "click Login" round (no named binding in that step text); `loginSuppressed` was true on 15 rounds, all on "type the value named ..." steps. The expect-0 on named-binding steps holds (0); one residual `login/login-page` end per cell remains.
2. **t11 press / hidden checkbox: closed.** 3/3 oracle true; the check ran as a single `check` act in 2 of 3 cells.
3. **t12 dialog: closed.** 3/3. See dialog telemetry. Two `error/act-failed` ends (0 steps, no round data) preceded the successful call in rep 3 (cell wall 42.9 s); cause not diagnosed.
4. **t13 count evidence: NOT closed.** Zero `countEvidence`/count-met stops anywhere: every wingman t13 call ended `fallback/no-progress` (23 of 24 calls; 1 `ambiguous/target-uncertain`), the scroll act reading `historyResult: "no visible change"`, `countMetP` 0.28-0.32 each time. 2/3 oracle passes came from the caller's repeated delegation (6-8 handoffs), not from the wingman stopping at >=10. Rep 3: "0 items | scrollY=0" (page not scrolled/loaded) and the harness then died on `Page.navigate`.

5. **t14 oracle: NOT closed, still unexplained.** <redacted4>man pressed Enter (`press`, `keyEvidence: true`, historyResult "page changed") and ended `done/goal-met` 3 times; `end_state` is `" | focus=body"` on all 3 forced cells and both playwright cells: `#result` empty and focus lost from the input. Consistent hypothesis, not proven: Enter submits the page's form, the page reloads, #result clears. The playwright control (click + press_key) behaves identically (0/2), so the oracle fails independent of route; in this reading the `done` ends are not premature, but I did not probe it.

## Telemetry (50 forced-round log records, evidence/telemetry-r17-log-slice.jsonl)
- Statuses: done/goal-met 11, fallback/no-progress 26, fallback/step-uncertain 7, login/login-page 3, error/act-failed 2, ambiguous/target-uncertain 1.
- Expect-0: login on named-binding steps 0 (see item 1); `focus` / `repeatedGroups` literals in log.jsonl 0; no-match stalls on hidden-controls 0 (no `no-match` end at all).
- Dialogs: 3 `rounds[].dialog = "accept"`, each in round 0 of a `click the button for a JS Confirm` call whose only act was the click (acts_by_op {click:1}); 0 dialogs without a preceding wingman act. Oracle text "You clicked: Ok" in all 3.
- Safety set: re-submits 0, `repeat`/`post-action` ends 0, reloads after effective clicks 0 observed (t14's "page changed" follows a press, not a click), `act_error` fields 0 (but 2 `error/act-failed` ends, above), stuck/recover rounds 0, premature advances 0 in t10-t13 by oracle (t14 unresolved), `loginSuppressed` 15, keyEvidence 8, clickEvidence 26.
- Not measured: tier-level post-action behaviour beyond the statuses above.

## Caveats
Live third-party sites (saucedemo, todomvc); the doctor failure is intermittent; invocation B's abort was a harness navigate timeout (the cell that preceded it, t13 rep 3, already showed an unloaded page); cell counts are small.
