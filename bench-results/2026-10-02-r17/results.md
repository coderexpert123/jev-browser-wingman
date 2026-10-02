# r17 — generalization-fix round: Part 1 NOT GREEN (4 deterministic failures, 2 are product defects); Part 2 (bench) not run

HEAD f9b21b9 (descendant check OK). Environment: cloud Linux, Chrome 141.0.7390.37 headless via the chromium-wrapper, Xvfb :99, TYPESAFE_API_KEY present, `claude -p` works. Spend: USD 0 (no bench ran).
Missing inputs: `.build-r17-spec.md` and `.build-r17-mutants.py` named in the instructions are NOT in the repo or on this machine; the five KB flags exist in `src` as `const|var KB_... = false` and the leg mapping was inferred from test names and `src/core/CLAUDE.md` (r17 notes). The "8 telemetry items" list is therefore not available; no telemetry was collected (no bench).

## Part 1 — full suite (5 serial chunks, one file per invocation; `npm ci && npm run build` ok, `tsc --noEmit` exit 0)
| chunk | files | result |
|---|---|---|
| 1 | acquire, adapter-cdp, adapter-playwright, bench-browse, bench-cap, bench-oracle, bounce-escalation, boundary, browse-step-surface, cdp-connection, chain-e2e | **browse-step-surface 6/7, chain-e2e 17/19**; rest pass |
| 2 | next 10 files (alphabetical through the second chunk) | all pass |
| 3 | ... through page-scripts | **page-scripts 19/20**; rest pass |
| 4 | next 10 files | all pass |
| 5 | remaining files | all pass |
Totals (first run): **51 files, 849 tests, 843 pass, 4 FAIL, 1 skip (chrome-cmd win32), 1 todo (conformance-ops playwright O18)**. After every chunk: 0 live chromes. Gates: `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` -> `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.
**Re-run of each failing file alone: identical failures (deterministic, not load flakes).** Per-file counts: part1/logs/runner-summary.txt; failing-test logs: part1/logs/{browse-step-surface,chain-e2e,page-scripts}.log and rerun-*.log.

### The 4 failures — diagnosis (hypotheses labelled; probes in evidence/diagnosis/)
1. **browse-step-surface #3 "browse_step schema matches the pinned schema" — stale test pin.** The live schema now has `pick.key` (enum Enter/Tab/ShiftTab/Escape/Space/Backspace/SelectAll/ArrowUp/ArrowDown/ArrowLeft/ArrowRight, added by D-A) which the pinned expectation lacks; the test was last touched before r17. Product behaviour as designed.
2. **page-scripts #16 "hidden-controls.html names hidden inputs through sibling labels..." — PRODUCT DEFECT in D-D.** The fixture has `<input t6 hidden><label for="t6" id="l-t6">Fine print</label><input t7 hidden>`. `siblingLabel` (src/core/page-scripts.ts) accepts the adjacent previous `<label>` without checking its `for` target, so the unnamed hidden `#t7` is enumerated as a SECOND proxy record named "Fine print" with `path '#l-t6'` (a duplicate of #t6's record); the test says it must not enumerate. Reproduced with plain DOM semantics in a probe (evidence/diagnosis/hidden-label-probe-output.txt) — nothing browser-specific.
3. **chain-e2e E19 "a hidden checkbox is checked through its sibling label" — PRODUCT DEFECT in D-D (same area).** `check Alpha task` ends `fallback/no-progress`. Probe: for the sibling-label arm the label is not associated with the input (no `for`, not wrapping), so the adapter's `check` click on the proxy `path` (the label) does NOT toggle the input (`#t1.checked` stays false; it becomes true only when the input itself is clicked, and for the `label[for]` arm clicking the label works). The adapters comment says `path` "is the visible wrapping label that toggles it", which is true for wrap/`for` arms but not for the sibling arm — the check act is a no-op, the state signal does not change, and the no-progress guard bounces. This is also the TodoMVC shape D-D was written for (r16b t11), so I would expect t11 to hit it live. The user-stated local result (462/462) differs from this; I cannot explain why from here.
4. **chain-e2e E16 "a prompt is never answered; the clause ends blocked/dialog-open" — test artifact on Chrome 141, not a product failure.** The test's own post-call `Page.handleJavaScriptDialog` throws `{"code":-32602,"message":"No dialog is showing"}`. Probe (evidence/diagnosis/chrome141-cross-session-dialog-probe.txt): with a prompt opened from a CDP session that has Page enabled, a SECOND CDP client attaches fine but `Page.handleJavaScriptDialog` returns "No dialog is showing" although the page is still blocked (the first session's own next Runtime.evaluate times out at 6 s). So on this Chrome a dialog can only be answered by the session that holds it; the test's assumption that an independent observer connection can dismiss it fails. The assertions before that line passed (`blocked/dialog-open`, so the loop's behaviour was correct). This matches the r16 t12 deadlock (the caller's separately attached Playwright MCP could not answer the dialog) and supports D-G's design (wingman answers dialogs from its own session) over "answer it with your own tools".

## Part 1b — KB-r17 cloud proof (one build each, `src/` restored with `git checkout -- src`, `git status` clean after each; baseline failures present in every run: page-scripts #16, chain-e2e E16 and E19)
| flag | mapped legs | observed FAIL under the flag | verdict |
|---|---|---|---|
| KB_CDP_PRESS_NONE | conformance-ops O19 (cdp), chain-e2e E17 | **O19 cdp FAIL, E17 FAIL** | proven |
| KB_CDP_DIALOG | conformance-ops O20 (cdp), adapter-cdp answerDialog leg, chain-e2e E14/E15 | **O20 cdp FAIL, adapter-cdp "answerDialog with no open dialog rejects" FAIL, E14 FAIL, E15 FAIL** | proven |
| KB_PW_PRESS_NONE | conformance-ops O19 (playwright) | **O19 playwright FAIL** | proven |
| KB_PW_DIALOG | conformance-ops O20 (playwright), adapter-playwright answerDialog leg | **O20 playwright FAIL**; adapter-playwright 8/8 still pass | **partial MISS: the adapter-playwright answerDialog leg does not fail under its flag** (non-discriminating; only O20 covers it) |
| KB_HIDDEN_SIBLING | page-scripts hidden-controls pins, chain-e2e E19 | page-scripts "verify re-finds hidden-control records..." (#20) newly FAILS; #16 and E19 already fail unflipped | proven only by #20; #16 and E19 cannot discriminate (they fail without the flip) |
(The spec-mapped legs are my inference — the mutants file was not available.)

## Part 2 — NOT RUN
Rule: bench only if Part 1 and 1b are green. They are not (4 deterministic Part 1 failures; one KB MISS). Nothing was spent. Per-cell tables, the r16-vs-r17 comparison, the 8 telemetry items, dialog telemetry, end_state quotes and the safety set were therefore not collected.

## Recommendation / is each r16 defect closed?
Not provable this round. By code and tests: press (D-A/B) and dialog answering (D-G) are covered by passing O19/O20/E14/E15/E17 and proven KB flags; D-E (scroll count) and D-C (login suppression) have passing tests but no live bench; **D-D (hidden checkboxes) has two reproduced product defects** (duplicate/stolen sibling label; sibling-label click does not toggle), so r16b's t11 would likely still fail at the checkbox step. Suggested next steps for the owner (not applied): update the pinned `browse_step` schema; make `siblingLabel` skip labels that carry a `for` pointing elsewhere (or already claimed) and make the sibling-arm check/uncheck act on the input (or `controlPath`) instead of the label; change E16's cleanup to answer the dialog from the wingman's own session or via a path that works on Chrome 141; add an adapter-playwright answerDialog leg that fails under KB_PW_DIALOG. If you want the bench anyway (e.g. to measure t10/t12/t13/t14 independently of D-D), say so and I will run Invocations A/B within the USD 25 cap.

## Caveats
Cloud Linux/Chrome 141 headless behind the proxy wrapper; E16's failure is specific to how Chrome 141 scopes dialog handling; the user-stated local gates (462/462, wave verifier PASS) were not reproducible here for the four tests above.
