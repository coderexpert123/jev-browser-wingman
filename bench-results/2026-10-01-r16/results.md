# r16 — cross-domain task-shape expansion (HEAD 62cbd27) — PARTIAL: t12/t13/t14 measured, t10/t11 blocked by a harness defect

Part 1 sanity: HEAD 62cbd27 (descendant check OK), `npm ci && npm run build` ok, `tsc --noEmit` exit 0.
Spend: invocation A' USD 0.8127 + B' USD 1.7273 = USD 2.54 (cap 15); the first attempt of invocation A spent USD 0 (died before any cell).
Caller: cloud Sonnet. Environment: cloud Linux, Chrome 141.0.7390.37 headless via the chromium-wrapper, Xvfb :99, policy/gate off, `--purpose measure`. r16b (t10/t11 after the harness fix) is reported in bench-results/2026-10-01-r16b/.

## Harness defect that blocked t10/t11 (reported, not fixed)
Invocation A (all five tasks) died at cell 1 with CDP `-32603 Internal error`, 0 runs, USD 0. Root cause, reproduced with an independent probe (evidence/defect-resetstorage/): `bench/run.ts` sent `Storage.clearDataForOrigin` on the browser-level CDP connection for tasks with `resetStorage: true`; on Chrome 141 that call always fails with -32603 there, while the identical call over an attached page session succeeds. t10 (first in the list) and t11 both set the flag, so they could not run through the unmodified harness. The operator fixed this (HEAD 64b51c8); r16b re-ran them. I narrowed to `--tasks t12,t13,t14` (sanctioned narrower resume).

## Per-cell table (t12-t14; playwright x2 control, forced x3)
| cell | task | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | t12-js-confirm-dialog | playwright | True | 12.7 | 0.1908 | 0 | 0 | 0 | 1 | 0 |
| A2 | t13-infinite-scroll | playwright | True | 14.1 | 0.1736 | 0 | 0 | 0 | 0 | 1 |
| A3 | t14-key-press | playwright | False | 10.6 | 0.1898 | 0 | 0 | 0 | 2 | 0 |
| A4 | t12-js-confirm-dialog | playwright | True | 9.3 | 0.0898 | 0 | 0 | 0 | 1 | 0 |
| A5 | t13-infinite-scroll | playwright | True | 15.4 | 0.0798 | 0 | 0 | 0 | 0 | 1 |
| A6 | t14-key-press | playwright | False | 10.3 | 0.0889 | 0 | 0 | 0 | 2 | 0 |
| B1 | t12-js-confirm-dialog | forced | False | 102.1 | 0.2186 | 2 | 0 | 1 | 0 | 0 |
| B2 | t13-infinite-scroll | forced | False | 31.0 | 0.2702 | 4 | 1 | 9 | 0 | 0 |
| B3 | t14-key-press | forced | False | 19.2 | 0.2418 | 5 | 2 | 4 | 0 | 0 |
| B4 | t12-js-confirm-dialog | forced | False | 99.8 | 0.1139 | 2 | 0 | 1 | 0 | 0 |
| B5 | t13-infinite-scroll | forced | True | 47.1 | 0.2286 | 4 | 1 | 31 | 0 | 0 |
| B6 | t14-key-press | forced | False | 21.9 | 0.1645 | 6 | 2 | 4 | 0 | 0 |
| B7 | t12-js-confirm-dialog | forced | False | 99.9 | 0.1146 | 2 | 0 | 1 | 0 | 0 |
| B8 | t13-infinite-scroll | forced | True | 43.8 | 0.1889 | 3 | 0 | 29 | 0 | 0 |
| B9 | t14-key-press | forced | False | 24.7 | 0.1861 | 7 | 3 | 5 | 0 | 0 |

| task | forced ok | playwright ok | forced median wall | playwright median wall | forced median usd | playwright median usd |
|---|---|---|---|---|---|---|
| t12-js-confirm-dialog | 0/3 | 2/2 | 99.9 s | 11.0 s | 0.115 | 0.140 |
| t13-infinite-scroll | 2/3 | 2/2 | 43.8 s | 14.7 s | 0.229 | 0.127 |
| t14-key-press | 0/3 | 0/2 | 21.9 s | 10.5 s | 0.186 | 0.139 |
(forced-verdict was NOT run as binding: its bars are tuned to the 7-page t9 chain. Per-handoff status/reason/why/steps/progress for every forced call: evidence/telemetry-invB2.txt and results/invB2-forced.json.)

## Special per-task findings
**t12-js-confirm-dialog — forced 0/3, playwright 2/2: a DEADLOCK in the dialog-stays-with-caller boundary.**
- After the click, wingman correctly returned `blocked/dialog-open` (3/3) with the note "A dialog is open. Answer it with your own browser tools, then call browse_step again with the same arguments." wingman never tried to answer the dialog and the caller never asked it to.
- The caller then called `playwright browser_handle_dialog {accept:true}` — and it failed in all 3 cells with `TimeoutError: async initializeServer: Timeout 30000ms exceeded` while connecting to the browser's CDP endpoint (the websocket connected but initialization never finished). The caller retried the dialog tool once, then called `browse_step` again, which returned `error/tool-fault` (`act_error head: fault: TimeoutError`, 0 jev calls, ~20.7 s) because wingman's own attach also timed out. The dialog stayed open; no tool could close it; cells ended at ~100 s with ok=false.
- The playwright control succeeded (9-13 s) because the same Playwright session had already attached (snapshot first) and handled the dialog it opened itself.
- Hypothesis (not proven): with a JS dialog blocking the page, a NEW CDP client (the forced route's lazily-attached Playwright MCP, and wingman's re-attach) hangs initializing page targets, so a dialog that was opened by wingman's click cannot be answered by the caller's lazily-connected tool. The dialog boundary as documented ("answer it with your own tools") only works if the caller's tool was attached BEFORE the click.
**t13-infinite-scroll — forced 2/3, playwright 2/2.**
- The caller's `scroll down ... until at least ten result blocks` step ended `step-uncertain / not-ready` 9 times (3-4 calls per cell): Jev's readyP stayed 0.22-0.30 on this page (below the 0.3 ready bar), so the loop answered `wait` and bounced (candidates empty). Only after the caller supplied a `pick` {scroll} did the loop act, and then ran to **24 scroll acts (budget-steps, max_steps)** in both cells that got there (B5, B8), never reporting done: stepDoneP climbed 0.2 -> ~0.38, below every evidence bar. **Jev did not stop at >= 10 blocks; it over-scrolled to the step budget** (the page's oracle was true by then, cells B5/B8 ok; B2 gave up after 1 scroll act and failed). The playwright control used one `browser_evaluate` (script) per cell.
**t14-key-press — forced 0/3, playwright 0/2 (oracle false on BOTH routes).**
- Forced: `click the input field` ended `no-progress` 3 times in every cell (the click on an input changes nothing: historyResult `no visible change`, stepDoneP 0.58-0.61 < the click evidence bar, so the loop repeats then the no-progress guard bounces). The caller's pick workaround for the `press` step was rejected `invalid-input` (a `press` pick needs a binding name in `values`; the error note lists value for fill/select/navigate/upload, not press) in 5 calls. When the caller finally sent `press the Enter key` alone, the key landed (`press` act, historyResult `page changed`, done/goal-met in B3).
- The oracle was still false: B3 returned done/goal-met on a landed press yet ok=false, and BOTH playwright control cells (click + `browser_press_key`) also failed the oracle. My independent CDP probe shows the page's `#result` becomes "You entered: ENTER" after an Enter key event even without focus, so the oracle is satisfiable. **Unresolved — hypothesis only:** a harness/oracle-time page-state issue for t14 (not a wingman defect, since the control fails identically); I did not capture the end-of-run page state.
- Separate wingman findings on t14: `click` on a text input is classified no-progress (a focus-only click has no observable page change); `press` has no pick path.

## Cross-domain bug watch
No `login`/`sensitive`/policy ends appeared (t10/t11 not run in r16). The only host-related failure was the harness `Storage` call above. No orphan Chrome leftovers after any run (checked after each).

## Recommendation (r16 only)
On these three single-page shapes forced mode is NOT at parity: 0/3, 2/3, 0/3 completion vs 2/2, 2/2, 0/2 for playwright. The r15 PASS (a long link-and-form chain) does not generalize automatically to dialog, infinite-scroll and key-press shapes; these are separate defects (dialog deadlock, scroll step-evidence, focus-click/press-pick). See r16b for the real-domain and SPA shapes.
