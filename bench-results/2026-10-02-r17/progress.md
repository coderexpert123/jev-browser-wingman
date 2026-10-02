# r17 progress log (HEAD f9b21b9)
- Context: `.build-r17-spec.md` and `.build-r17-mutants.py` named in the instructions are NOT in the repo or on this machine (find / .build-r17* = none); the 5 KB flags exist in src as `const KB_... = false` (adapters/cdp.ts, adapters/playwright.ts, core/page-scripts.ts); leg mapping inferred from test names (O19/O20, E14-E19, adapter answerDialog, page-scripts hidden-controls) and src/core/CLAUDE.md r17 notes. The "8 telemetry items" list is not available either; I answer the items the instructions name explicitly.
- Part 1 chunk 1 (acquire .. chain-e2e) DONE: 2 files FAIL on first run: (a) tests/browse-step-surface.test.ts #3 "browse_step schema matches the pinned schema" — actual schema now has pick.key (enum Enter/Tab/ShiftTab/Escape/Space/Backspace/SelectAll/Arrow*) that the pinned expectation lacks (test file last touched before r17; stale pin, product behaviour as designed); (b) tests/chain-e2e.test.ts E16 (prompt never answered: error `{"code":-32602,"message":"No dialog is showing"}` from the test's own post-call dismiss) and E19 (hidden checkbox via sibling label: expected done, got fallback reason no-progress). Re-runs pending after the remaining chunks.
- Part 1 chunks 2-5 DONE (no further failures). FIRST-RUN totals over 51 files / 5 serial chunks: 849 tests, 843 pass, 4 FAIL, 1 skip (chrome-cmd win32), 1 todo (conformance-ops playwright O18); sweep after each chunk: 0 live chromes.
- Re-run of each failing file ALONE: identical result (deterministic): browse-step-surface 6/7 (schema pin), chain-e2e 17/19 (E16, E19), page-scripts 19/20 (hidden-controls). So Part 1 is NOT green -> per the round's rules Part 2 (bench) is not run.
- Diagnosis of the 4 first-run failures DONE (evidence/diagnosis/): (1) browse-step-surface: stale pin (pick.key added by r17 is not in the pinned schema). (2) page-scripts hidden-controls #16 + (3) chain-e2e E19: PRODUCT defects in D-D, reproduced with plain DOM semantics (probe): `siblingLabel` accepts any adjacent <label> without checking its `for` target, so the unnamed hidden input t7 adopts t6's label (duplicate record 'Fine print' path #l-t6), AND for the sibling-label arm the adapters click `path` (the label) which is not associated with the input, so the hidden checkbox is never toggled (checked stays false after clicking the proxy path; true only when clicking the input) => check act is a no-op => no-progress (E19). (4) chain-e2e E16: TEST ARTIFACT on Chrome 141: Page.handleJavaScriptDialog from a SECOND CDP client returns -32602 'No dialog is showing' even though the page is still blocked (probe: A's own evaluate times out); the loop's blocked/dialog-open result was correct.
- Part 1b DONE (5 KB flags, one build each, git status clean after each): see part1b/kb-summary.txt. CDP_PRESS_NONE -> O19(cdp)+E17 FAIL; CDP_DIALOG -> O20(cdp)+adapter-cdp answerDialog leg+E14+E15 FAIL; PW_PRESS_NONE -> O19(playwright) FAIL; PW_DIALOG -> O20(playwright) FAIL but adapter-playwright answerDialog leg does NOT fail (non-discriminating); HIDDEN_SIBLING -> page-scripts 'verify re-finds' FAIL (the pin #16 and E19 already fail unflipped, so cannot discriminate).
- Part 2 (bench) NOT RUN: Part 1 is not green (4 deterministic failures, 2 of them product defects) — rule: Part 2 only if Part 1+1b green. Spend this round: USD 0.

## Part 1 re-run at be0128c (51 files, 5 serial chunks)
- Totals: 852 tests, 849 pass, 1 fail, 1 skipped (chrome-cmd), 1 todo (conformance-ops O18).
- browse-step-surface 7/7, chain-e2e 19/19, page-scripts 20/20, adapter-playwright 9/9 (gained the r17b check test): all green.
- Only failure: doctor "all ten checks pass on a clean ephemeral setup" - `coexistence: observer fingerprint changed across attach/detach`. Isolated re-runs: run1 PASS (26/26), run2 FAIL. Intermittent (fails 2 of 3), not in any r17-touched file; reported, not fixed. Logs in part1-rerun/logs/doctor*.log (doctor uses a temp home, no wingman log.jsonl slice exists).

## Part 1b cloud KB proof at be0128c (6 CLOUD flags, build .build/kb-r17c, src restored: git status clean)
- KB_HIDDEN_SIBLING: FAIL page-scripts (hidden-controls names; verify re-find) + chain-e2e E19.
- KB_CDP_PRESS_NONE: FAIL conformance-ops O19 (cdp) + chain-e2e E17.
- KB_CDP_DIALOG: FAIL conformance-ops O20 (cdp), adapter-cdp answerDialog-no-dialog, chain-e2e E14 + E15.
- KB_CDP_CHECK_TOGGLE: FAIL chain-e2e E19 (expected).
- KB_PW_PRESS_NONE: FAIL conformance-ops O19 (playwright); adapter-playwright passes (not a mapped discriminator).
- KB_PW_DIALOG: FAIL conformance-ops O20 (playwright); adapter-playwright answerDialog leg PASSES under the flag (non-discriminating, as in the f9b21b9 pass).

## Invocation A (playwright x2, t10-t14, cap 3.00, phase cap 30.814594 = ledger 5.814594 + 25) - results/A-playwright-2026-10-02-152648.json, total 1.709121 USD
- t10 ok x2 (27.1 s/0.276, 19.0 s/0.162) | t11 ok x2 (15.4/0.256, 14.6/0.148) | t12 ok x2 (10.1/0.202, 55.9/0.112; end_state "You clicked: Ok | focus=button")
- t13 ok x2 (15.2/0.185, 15.4/0.087; end_state "10 items | scrollY=3148/3164") | t14 FALSE x2 (11.3/0.202, 10.0/0.080; end_state " | focus=body" both)

## Invocation B (forced x3) + supplement
- B (results/B-forced-2026-10-02-153309.json): 14 of 15 cells, aborted `cdp timeout: Page.navigate` (harness, before t14 rep3), total 3.124 USD. t10 3/3, t11 3/3, t12 3/3, t13 2/3 (rep3 "0 items | scrollY=0"), t14 0/2.
- Supplement (results/B2-...153338.json): t14 forced x1, false, " | focus=body", 0.055 USD.
- Analysis and verdict: results.md.
