# r14 validation — jev-browser-wingman 0.3.0 "forced handoff" (HEAD 68b66eb)

Code under test: `forced-handoff-0.3.0` @ 68b66eb (r14 landed-navigation evidence + second-stamped bench result files, on top of r11-r13). Environment: cloud Linux, Xvfb :99, chromium-wrapper as /usr/bin/chromium and /opt/google/chrome/chrome, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller: cloud Sonnet (like-for-like with r11b/r12/r13).
No src/, tests/, thresholds, profiles/ or fixtures edited (only the sanctioned KB flip, restored; tracked tree clean).
New spend: Part 2 USD 2.5225 (cap 15) + Part 3 about USD 0.193 (cap 4).

## Part 1 — full suite: GREEN
`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0. 51/51 files, one per invocation, sequential: **766 tests, 764 pass, 1 skip (chrome-cmd win32-only), 1 todo (see O18), 0 fail**; no re-runs needed. chain 97/97, **chain-e2e 11/11 including E9, E10 and the new E11**, bench-cap 10/10, outcome-evidence 45/45, doctor 26/26. Per-file counts: part1/logs/runner-summary.txt. `runner-sweep-leak` leaves its designed drill chrome, swept; no other leftovers.
- **E11** (open Form -> fill -> Send in one call) passes; the test asserts exactly one `navEvidence` round, exactly one executed act under `open Form` (the link click) and exactly one executed fill whose step_text is `type the value named email into Email` (so the fill runs under the email clause, not under `open Form`).
- **conformance-ops O18** (back-then-click): **cdp pass**; **playwright ran as the OPEN-1 todo and passed** (`ok 18 ... # TODO OPEN-1 (r13) ...`, no error block, no skip; as verified in r13 a failing todo prints `not ok ... # TODO` plus the error). Same result as r13; skip count in the file: 0 (not blind to bfcache).
- Gates: `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` -> `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.
- **KB-nav proof** (`const KB_NAV_OFF = Boolean(process.env.KB_NAV_ON === undefined)`, condition prefixed with `!KB_NAV_OFF &&`, built to .build/kb-nav with entries tests/chain.test.ts, tests/chain-e2e.test.ts, src/cli/main.ts): chain 97 tests, 92 pass, **5 FAIL: `T-nav-advance`, `T-nav-floor`, `T-nav-token` (the three required) plus `T-nav-expanded`, `T-nav-query`**; chain-e2e 11 tests, 10 pass, **`E11` FAILS** against that build. Restored via `git checkout -- src/core/loop.ts`; `git status` clean.

## Part 2 — forced-handoff benchmark (t9-long-chain): forced-verdict **FAIL, but only 2 bars and by one step each**
Ledger 5.814594 -> `--phase-cap-usd 20.814594`, `--cap-usd 3.00`. Result files were second-stamped (`2026-10-01-HHMMSS.json`) and none collided (the r13 overwrite is fixed).

**Phase V** (playwright x3, gate/policy off): 3/3, USD 0.9386 — V1 25.4 s / 0.2954, V2 32.4 s / 0.3123, V3 34.0 s / 0.3309.

**Phase M** (forced x3 + playwright x3 interleaved, gate/policy off, `--purpose measure`), total USD 1.5201:
| # | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 50.4 | 0.326876 | 5 | 2 | 27 | 0 | 0 |
| 2 | playwright | true | 32.5 | 0.308576 | 0 | 0 | 0 | 17 | 0 |
| 3 | forced | true | 43.7 | 0.179197 | 4 | 1 | 27 | 0 | 0 |
| 4 | playwright | true | 32.0 | 0.328171 | 0 | 0 | 0 | 17 | 1 |
| 5 | forced | true | 47.0 | 0.200646 | 5 | 2 | 28 | 0 | 0 |
| 6 | playwright | true | 22.7 | 0.176632 | 0 | 0 | 0 | 16 | 0 |
(Cell 4 is a playwright control; its `raw_script=1` is the control's own tool use and is not counted by the verdict, which reads forced cells only: `raw-script 0`.)

FORCED-VERDICT (verbatim, Phase M):
```
FORCED-VERDICT: completion forced=3/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=5
FORCED-VERDICT: picks 5/14
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 3.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=4 no-match=2 not-ready=6 wrong-page=1
FORCED-VERDICT: overall FAIL
```
Bars missed (thresholds untouched): **handoffs** (needs 1..4 per run: 5 / 4 / 5 — cells 1 and 5 are one over) and **median-steps** (3.00 < 4). **Passed: completion 3/3 (first 3/3 since r12), wingman-share, raw-acts, picks (5/14), zero-step-done, first-call-success, no-page-error-end (0), raw-script.**

**Phase S** (forced x1, gate ON, policy off): ok=false, 15.0 s, USD 0.0637, 1 handoff, 0 picks, 6 wingman acts, 0 raw. `FORCED-VERDICT: smoke ok=false needs_confirmation=1` — the first handoff ended `needs_confirmation`/`irreversible-heuristic` after 15 rounds (6 steps, 2 of 7 clauses done) and the cell stopped there; same shape as r13. Gate-on: the irreversible action returns a confirmation instead of acting.

### Per-handoff detail, Phase M forced cells (M1 = cell 1, M3 = cell 3, M5 = cell 5)
| cell.call | status/reason | why | steps | progress done/total (caller numbering) | acts_by_op | navEv rounds | stuck | expansion |
|---|---|---|---|---|---|---|---|---|
| M1.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 4 | back,back,back | 7->16 |
| M1.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | 0 | - | 7->16 |
| M1.3 | fallback/step-uncertain | wrong-page | 0 | 0/3 | None | 0 | give-up | 3->6 |
| M1.4 | fallback/step-uncertain | low-confidence | 4 | 2/3 | {'navigate': 1, 'click': 3} | 0 | give-up | 3->6 |
| M1.5 | fallback/step-uncertain | low-confidence | 3 | 1/2 | {'navigate': 1, 'click': 2} | 1 | - | 2->3 |
| M3.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 4 | back,back,back | 7->16 |
| M3.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | 0 | - | 7->16 |
| M3.3 | fallback/step-uncertain | low-confidence | 4 | 4/7 | {'navigate': 1, 'click': 3} | 0 | - | 7->7 |
| M3.4 | done/goal-met | - | 3 | 7/7 | {'navigate': 1, 'click': 2} | 0 | - | 7->7 |
| M5.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 4 | back,back,back | 7->16 |
| M5.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | 0 | - | 7->16 |
| M5.3 | fallback/step-uncertain | no-match | 1 | 0/2 | {'back': 1} | 0 | back | 2->5 |
| M5.4 | fallback/step-uncertain | no-match | 4 | 1/2 | {'navigate': 1, 'click': 3} | 0 | give-up | 2->5 |
| M5.5 | fallback/step-uncertain | low-confidence | 3 | 1/2 | {'navigate': 1, 'click': 2} | 1 | - | 2->2 |
(`progress.steps_total` is in the caller's numbering by design; "expansion" is the shipped `expandClauses` run on each call's recorded `steps`. M3.3/M3.4/M5.5 have no compound clause because the caller issued URL-named single steps.)

### Telemetry (14 forced handoffs; per-round detail in evidence/telemetry-per-round.txt, evidence/why-buckets-and-advances.txt)
- **Decomposition:** 11 of 14 calls decomposed (7 caller steps -> 16 sub-clauses, 3 -> 6, 2 -> 5, 2 -> 3), 3 had no compound clause, **0 over the cap**.
- **why-breakdown vs r13:** not-ready **6** (r13: 10), low-confidence 4 (4), wrong-page 1 (3), no-match 2 (2), no-progress 0 (1), repeat 0. Total handoffs 14 (r13: 23), all fallbacks `step-uncertain`; no `error` ends, no `jev-error`, **0 act_error records, 0 act-failed endings**.
- **navEvidence advances: 14** (3 cells x 4 `open <Page>` advances in each first call: Checkboxes, Dropdown, Inputs, Forgot Password; plus `open Status Codes` in M1.5 and M5.5). Firing-round values: stepDoneP 0.27-0.48 (all below the old 0.5 bar), errorP 0.04-0.16, rightPageP 0.58-0.86, leftPage=True on every one, history `element gone`. **Real premature-advance test: in all 14 the NEXT clause's first round had rightPageP 0.52-0.91, readyP 0.30-0.83, errorP 0.05-0.25, and the next clause committed an element act within 2 rounds (14/14: `check`, `select`, `fill`, `fill`, or `click`); 0 went stuck or bounced afterwards.** The premature-advance screen (next clause rightPageP < 0.45 or readyP < 0.3) found **0 hits** (the lowest was M5.5's `open the 404 link` first round, rdy 0.30 / err 0.25, which then clicked).
- **Acting-ahead (executed fill/select/check under an `open <X>` clause): 0** (r13: 12 over 3 cells). The fixed mechanism works as described.
- **Final-clause advance:** exactly 1 (M3.4: `open the 404 link`, done/goal-met 7/7 at stepDoneP 0.70 via the 0.5-with-click-evidence bar, navEvidence unset, leftPage True; the cell's oracle was ok). No navEvidence on any final clause (0 by construction), so no false goal-met.
- **Stuck rounds: 13** = `back` x10, `give-up` x3, `open_*` x0. Of the 10 recoveries: 9 committed an act and 9 advanced (90%; r13: 82% / 64%); the 3 `give-up` rounds all ended in the normal bounce (M1.3 wrong-page, M1.4 and M5.4 low-confidence/no-match). The 1 recovery that did not commit (M5.3, `open Dynamic Loading`) ended no-match. **Violations: 0** (no stuck navigate, hence no advance after one).
- **Navigate-evidence (r12 rule) advances: 2** (M1.5, M3.4 `open the web address named home` / `go to the start page`, sdP 0.79 / 0.74); both next clauses were on the right page (rp 0.87-0.88).
- **clickEvidence 28, countEvidence 3** (value 2, first call of each cell). **Add Element twice: exactly 2 executed clicks in each of the 3 forced cells.** **Wait storms (3+ consecutive waits): 3 calls**, the first call of each cell (M1.1, M3.1, M5.1), each at the Retrieve-password step.
- **leftPage after the Retrieve password click: False.** In M1.1/M3.1/M5.1 the click (history `filled` -> `element gone`) leaves leftPage=False on every later round (the POST returns the same URL path), so the new navigation rule cannot fire for it; stepDoneP stays 0.38-0.49 (just under the 0.5 bar) and readyP 0.18-0.22.

**What still produces handoffs (hypotheses from per-round traces):**
1. **not-ready 6 = the Retrieve-password clause, 3 cells x 2 calls.** The first call of each cell (35-36 rounds, 4 of 7 clauses done) ends `not-ready` after three waits on the post-submit page (rdy ~0.2, `element gone`, leftPage False, sdP 0.38-0.49). The caller's next call restarts at `click the Retrieve password button` against that same page (rdy ~0.1) and also ends `not-ready` after 2 waits (M1.2, M3.2, M5.2). The caller's third call then navigates away and the cell finishes. Since `leftPage` is False, the bare-click evidence bar (stepDoneP >= 0.5) is the only way out and sdP was 0.49 at best (M1.1).
2. **Final clause `open the 404 link`:** M1.5 and M5.5 end `low-confidence` after 6 clicks on the same target (leftPage True, sdP 0.38-0.46, `element gone`); the 404 page was reached (the cell oracle was ok) but the final clause correctly keeps the 0.5/0.85 bars, so it bounces instead of reporting goal-met. M3.4 shows the same clause completing at sdP 0.70.
3. M5.3 `open Dynamic Loading` (no-match after a `back`) and M5.4/M1.4 `open Status Codes` (give-up) are the residual stuck cases.

**Why-bucket occurrences (step_text of last round -> decided action), all in evidence/why-buckets-and-advances.txt:**
- not-ready (6): `click the Retrieve password button` -> wait x6 (M1.1, M1.2, M3.1, M3.2, M5.1, M5.2).
- no-match (2): `open Dynamic Loading` -> click (target none 0.95), `open Status Codes` -> stuck give-up then bounce.
- wrong-page (1): `open the web address named home` (stuck give-up).
- low-confidence (4): `open Status Codes` (after give-up), `open the 404 link` -> click x2 (M1.5, M5.5), `go to the start page` -> wait (M3.3).
- repeat (0), no-progress (0). Largest target for the next fix: **not-ready (6): the post-submit Retrieve-password page** (click whose page does not change URL and whose clause never reaches stepDoneP 0.5).

### r11b / r12 / r13 / r14 comparison (all cloud Sonnet caller)
| Metric | r11b (3a12d32) | r12 (f39aa12) | r13 (64cbbdb) | r14 (68b66eb) |
|---|---|---|---|---|
| Forced completion | 3/3 | 3/3 | 2/3 | **3/3** |
| Median steps/handoff | 2.00 | 2.00 | 1.00 | **3.00** |
| Handoffs max (total) | 12 (24) | 15 (37) | 10 (23) | **5 (14)** |
| Picks | 13/24 | 26/37 | 9/23 | **5/14** |
| Forced wall (median of 3) | 46.8 s | 75.7 s | 62.9 s | **47.0 s** |
| Playwright wall (median of 3) | 23.7 s | 34.6 s | 25.0 s | **32.0 s** |
| Forced cost per cell (avg) | 0.35 | 0.43 | 0.33 | **0.24** |
| no-match / low-conf / not-ready | 8 / 3 / 0 | 13 / 11 / 0 | 2 / 4 / 10 | **2 / 4 / 6** |
| Bars missed | handoffs, picks, median-steps | handoffs, picks, median-steps | completion, handoffs, median-steps, no-page-error-end | **handoffs, median-steps** |
Reading: r14 is the best round so far on every measured axis (fewest handoffs, highest median steps, lowest cost, completion back to 3/3, no page-error ends, picks passing) and the stated target of the change — `open <Page>` clauses advancing on their landing instead of Jev acting ahead — is confirmed (14/14 clean advances, 0 acting-ahead). Two bars still miss: handoffs max 5 (bar 4) and median-steps 3.00 (bar 4), both by one, driven by the Retrieve-password not-ready pair per cell. n=3 forced cells; the playwright control wall is 32 s here vs 25 s in r13, so cross-round wall comparisons are noisy.

## Part 3 — fresh-install check: PASS (3/3 first-call success), about USD 0.193
- `npm pack` (jev-browser-wingman-0.2.1.tgz) + `npm install -g --prefix <scratch>`; installed package has `profiles/{playwright-mcp,chrome-devtools-mcp}.json`. Registered with Claude Code (`claude mcp add -s user`) playwright (`@playwright/mcp@0.0.80 --browser chrome`) + `jev-browser-wingman mcp`; `doctor --detect` -> playwright `playwright-mcp`/`launch`; `doctor --plan` printed O1 todo, O2 todo, O3/O4 met; followed exactly (backup, `{"mode":"on"}`, wrapped entry via `claude mcp remove`/`add`), then `chrome ensure`. ~/.claude.json restored byte-for-byte (cmp identical); ~/.jev-browser-wingman (absent at start) removed.
- Final `doctor` output (verdict PASS, exit 0):
```
PASS key-present  source=env
PASS config-loaded  config loaded; gate: off (optional toggle; set gate.mode "confirm" to require confirmation of irreversible actions)
PASS registration-portable  2 registration(s) portable
PASS policy-loaded  policy lists load and the self-test host classifies sensitive-identity
PASS profile-safe  the Chrome answering on port 9222 uses profile_dir
PASS adapter-attach  attached to http://127.0.0.1:9222; 1 page(s)
PASS default-context  attach stayed in the default context; cookies=6
PASS coexistence  observer fingerprint identical across attach/detach (1 page(s))
PASS handoff  enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll, script
PASS jev-round  runCheck answered with 1 jev call(s)
verdict: PASS
```
| Page | browse_step calls | First call | acts_by_op | Rounds (stepDoneP / historyResult / countEvidence) | act_error / stuck / navEvidence | Independent check | Non-read browser tool use |
|---|---|---|---|---|---|---|---|
| /inputs | 1 | done/goal-met, steps 1 | fill:1 | r1 0.06 / - ; r2 0.75 / filled | none / none / none | field value = the typed number | none (ToolSearch + browse_step only) |
| /dropdown | 1 | done/goal-met, steps 1 | select:1 | r1 0.07 / - ; r2 0.96 / selected: Option 2 | none / none / none | selected = Option 2 | none |
| /add_remove_elements/ | 1 | done/goal-met, steps 2 | click:2 | r1 0.07 ; r2 0.13 / page changed ; r3 0.92 / page changed / **countEvidence=2** | none / none / none | **Delete buttons = 2** (raw CDP) | none |
(leftPage was False on every landed round of these single-page tasks, as expected.)

### Doc gaps (unchanged since r11b; INSTALL-FOR-AGENTS.md and package.json unchanged)
1. RC package and `--version` report **0.2.1**, not 0.3.0 (tarball is jev-browser-wingman-0.2.1.tgz).
2. `~/.jev-browser-wingman/backups/` does not exist on a fresh install; the doc says to save backups there.
3. `doctor --plan` prints the wrapped entry as bare JSON (no `type`/`env`) and does not say how to apply it with the client's own command (`claude mcp remove` then `claude mcp add -s user NAME -- jev-browser-wingman with-browser -- <C> <A...>`).
4. `doctor --plan` marks O3 [met] but `adapter-attach` only passed after `chrome ensure` (run before the first `doctor`; whether plain `doctor` launches the browser itself was not tested).
5. No instructions for installing from a packed tarball ("After publish" only).
6. The caller needs an extra `ToolSearch` call to load `browse_step` under `claude -p` (deferred tools).

## Linux-only caveats
Cloud Linux/Xvfb; Chromium behind the wrapper (`--ignore-certificate-errors`, unprivileged uid, root container). The Retrieve-password POST behaviour (same URL path after submit, which keeps leftPage False) and the post-submit error page are properties of this site/fixture as served to this browser and may differ elsewhere. O18's playwright pass is specific to this Chromium build. win32-only skip in chrome-cmd; Windows-only chain-e2e flake N/A. n=3 forced cells.

## Push-scan notes
The key-prefix string, the key value and every bound value of length >= 3 never matched in any pushed file. The 2-character bound values (digit strings) can coincide with numeric telemetry; the bare-token scan therefore excludes logs/, evidence/ and results/, and every file is scanned for them as quoted JSON strings. Raw caller transcripts (which contain bound values) were NOT pushed.
