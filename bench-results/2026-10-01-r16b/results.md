# r16b — t10 (real-domain checkout) and t11 (SPA) after the resetStorage harness fix (HEAD 64b51c8)

Sanity: HEAD 64b51c8 (descendant OK); `npm ci && npm run build` ok; `tsc --noEmit` exit 0. Ledger before 8.354657 -> `--phase-cap-usd 16.354657` (cap USD 8), `--cap-usd 3.00`, gate/policy off, `--purpose measure`. Spend this round: proof cell 0.2763 + invocation A 0.4051 + invocation B 1.7394 = **USD 2.4208**. Caller: cloud Sonnet; Chrome 141 headless via the chromium-wrapper; cloud Linux. (r16's t12/t13/t14 results: bench-results/2026-10-01-r16/results.md.)

## resetStorage live proof
The fix works. One `t10` playwright cell (no forced) ran to completion: no `-32603`, ok=true (24.7 s, USD 0.276). It counts as t10 control cell 1. (r16's first attempt had died at cell 1 with `Storage.clearDataForOrigin` -32603 on the browser-level session.)

## Per-cell table (P1 = proof cell; A1/A2 = invocation A; B1-B6 = invocation B)
| cell | task | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | t10-saucedemo-checkout | playwright | True | 24.7 | 0.2763 | 0 | 0 | 0 | 8 | 0 |
| A1 | t10-saucedemo-checkout | playwright | True | 18.3 | 0.1603 | 0 | 0 | 0 | 8 | 0 |
| A2 | t11-todomvc-spa | playwright | True | 13.8 | 0.2448 | 0 | 0 | 0 | 3 | 0 |
| B1 | t10-saucedemo-checkout | forced | True | 30.0 | 0.2688 | 5 | 3 | 11 | 0 | 0 |
| B2 | t11-todomvc-spa | forced | False | 41.6 | 0.4496 | 10 | 4 | 4 | 0 | 0 |
| B3 | t10-saucedemo-checkout | forced | True | 28.1 | 0.1639 | 5 | 3 | 11 | 0 | 0 |
| B4 | t11-todomvc-spa | forced | False | 39.6 | 0.3692 | 10 | 4 | 4 | 0 | 0 |
| B5 | t10-saucedemo-checkout | forced | True | 28.0 | 0.1628 | 5 | 3 | 11 | 0 | 0 |
| B6 | t11-todomvc-spa | forced | False | 36.7 | 0.3252 | 10 | 4 | 4 | 0 | 0 |

| task | forced ok | playwright ok | forced median wall | playwright median wall | forced median usd | playwright median usd |
|---|---|---|---|---|---|---|
| t10-saucedemo-checkout | 3/3 | 2/2 | 28.1 s | 21.5 s | 0.164 | 0.218 |
| t11-todomvc-spa | 0/3 | 1/1 | 39.6 s | 13.8 s | 0.369 | 0.245 |
(forced-verdict not run: its bars are tuned to the t9 chain and do not apply to these tasks. Per-handoff status/reason/why/steps/progress for all 45 forced calls: evidence/telemetry-invB-forced.txt and results/invB-forced.json.)

## t10-saucedemo-checkout — forced 3/3, playwright 2/2
- **Login produced a `login` end every time.** Each forced cell had 4 handoffs ending `login / login-page` (12 across 3 cells) followed by a final `done/goal-met` call (steps 8): call 1 ended on the first round before acting (steps 0); calls 2, 3 and 4 each executed ONE act (fill username, fill password, click Login) and then ended `login` again because the page still read as a sign-in page after each act. The note on those results tells the caller to "ask the user to sign in"; **the caller ignored that and simply re-called with the same arguments (three picks per cell), which worked** — a caller that obeyed the note would have stopped at the login page even though credentials were supplied in `values`. This `login` end is not the sensitive-page policy (policy was off); it is the loop's own page-signal check.
- **Sign-in was actually exercised in every forced cell** (the act sequence fill/fill/click appears in all three, and each started on the login page): `resetStorage` works — no cell skipped it.
- **checkout-complete was reached in 3/3 forced cells and in all playwright cells** (oracle `location.pathname === '/checkout-complete.html'`).
- **No re-submit and no `repeat` bounce**: 0 `repeat`, 0 `post-action`, 0 reloads, 0 `act_error`. The final call carried 8 steps in one call (5 clicks, 3 fills) with clickEvidence firing.
- Cost of the login behaviour: 5 handoffs per cell (the t9 forced-verdict bar of 1..4 would be missed), 3 picks per cell; wall 28.1 s vs playwright 21.5 s median; forced USD 0.164 vs playwright 0.218 (median).
**t11-todomvc-spa — forced 0/3, playwright 1/1.**
- **SPA state handling (no document navigation) was not the problem**: typing into the new-todo field worked (`fill`, historyResult `filled`), and no navEvidence misfire occurred (0 navEvidence rounds across all 45 calls; `leftPage` was never true).
- **resetStorage check (t11):** no sign of a stale list. The playwright control passed an oracle that requires exactly 2 todo items (so its list started empty), and the one forced transcript snapshot I read (B2) showed the first typed item as the item in the list; I did not inspect every forced cell's initial page state, so for B4/B6 this is inferred from the identical call patterns, not observed.
- **Why 0/3 (identical in all 3 cells, 10 handoffs each):** (1) the `press Enter to confirm` clause (split off by decomposition) ends `no-match` (Jev answers target `none` ~0.55) or `low-confidence`: a key press has no natural element target; the caller's `pick` workaround for it is rejected `invalid-input` ("pick needs ... value ... for fill, select, navigate and upload" — a `press` pick has no way to name the key) in 6 calls; the Enter did land (`press` act, historyResult `page changed`; the first item appeared in the list), yet the clause never advanced (stepDoneP 0.14-0.44). (2) `mark the first todo item complete`: the per-item checkbox never appears in wingman's element table — candidates list only `Toggle All Input` plus links — so Jev answers `none` at 0.83-0.95 (`no-match` x3) and picks return `target-uncertain` (`ambiguous` x6); rewording did not help. The caller cannot fall back to raw clicks in forced mode, so the cell fails. The playwright control did it with snapshot + 2 type + 1 click (13.8 s).
- Hypothesis: the per-item checkbox is visually hidden (custom-styled TodoMVC toggle) and filtered out of the element table, like the hidden-input proxy cases noted in earlier rounds; I did not capture the enumerated table for it.
- Observation (not a defect): the t11 todo text appeared literally in 12 wingman log records' `step_text` because the caller typed the literal text into its step instead of naming the binding; the product redacts only values it is given. Redacted in the pushed evidence.

## Telemetry (45 forced calls, evidence/telemetry-invB-forced.txt)
- **Decomposition:** t10 calls expand 11-step goals (progress steps_total 11 -> 9 as acts completed); t11 calls 3 -> 2 -> 1; no cap hits.
- **why/status buckets:** t10 `login/login-page` 12, done 3; t11 `no-match` 13, `low-confidence` 5, `error/invalid-input` 6, `ambiguous/target-uncertain` 6. **post-action 0, repeat 0, not-ready 0, wrong-page 0, no-progress 0.** Re-executed clicks on remembered targets 0; reloads after effective clicks 0; act_error 0; stuck/recover rounds 0; navEvidence 0; wait storms (3+ consecutive waits) 0; clickEvidence fired 15 times (all in t10's final call). Premature-advance screen: no clause advanced onto a wrong page (nothing to screen: the only advances were within t10's final call).
- **Per-bucket step_text + decided action (every occurrence):** see evidence/telemetry-invB-forced.txt ("t11 forced: step_text of last round per call"): `press Enter ...` -> press (no-match/low-confidence), `mark the first todo item ... complete` -> check (no-match, target none 0.83-0.95); t10 login ends: fill, fill, click on the login form.

## Cross-domain bug watch
No wrong-page bounces on the correct domain, no policy/sensitive ends, no host-based failures, no orphan Chrome after any run. Defects found across r16/r16b: (1) the harness `resetStorage` call (fixed in 64b51c8); (2) `login` page-signal end fires after every act on a sign-in page even with credentials supplied and policy off; (3) `press`/key steps have no element target and no pick path (t11, t14); (4) per-item todo checkboxes missing from the element table (t11); (5) JS-dialog deadlock (r16 t12).

## Does the r15 PASS shape hold?
**Partly.** On a real third-party domain with a multi-stage form flow (t10), forced mode completes 3/3 in one resumable sequence with no re-submit/post-action problems — the r15 mechanics (decomposition, resume, repeat/post-action guards, evidence) generalize there, at the cost of an avoidable 4-handoff login sequence (5 handoffs per cell). On the SPA (t11) it does not: 0/3, because the work needs a key press (`press Enter`) and a hidden per-item checkbox, neither of which the loop can target. Together with r16 (t12 dialog deadlock, t13 over-scroll to budget, t14 press/oracle) the r15 result looks **task-shape-specific**: it holds for link-and-form chains and real-domain form flows, and fails for key presses, hidden controls, dialogs and scroll-until-condition tasks. n=3 forced cells per task; playwright controls n=1-2.

## Caveats
Cloud Linux, Chrome 141 headless behind the proxy wrapper; saucedemo/todomvc are live third-party sites (content could change); the caller's phrasing varies per cell; playwright control sample sizes are small; the t14 oracle/control failure from r16 remains unexplained.
