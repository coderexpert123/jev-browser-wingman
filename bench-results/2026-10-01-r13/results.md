# r13 validation — jev-browser-wingman 0.3.0 "forced handoff" (HEAD 64cbbdb)

Code under test: `forced-handoff-0.3.0` @ 64cbbdb (r13 stuck-clause recovery + NoHistoryError + act_error telemetry on top of r11/r12). Environment: cloud Linux, Xvfb :99, chromium-wrapper as /usr/bin/chromium and /opt/google/chrome/chrome, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller: cloud Sonnet (like-for-like with r9/r11b/r12).
No src/, tests/, thresholds, profiles/ or fixtures edited (only the sanctioned KB flip, restored; tracked tree clean).
New spend: Part 2 USD 2.5087 (cap 15) + Part 3 about USD 0.187 (cap 4).

## Part 1 — full suite: GREEN
`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0. 51/51 files, one per invocation, sequential: **751 tests, 749 pass, 1 skip (chrome-cmd win32-only), 1 todo (see O18), 0 fail**; no re-runs needed (doctor, which flaked once in r12, passed). chain 85/85, chain-e2e 10/10, bench-cap 8/8, outcome-evidence 45/45. Per-file counts: part1/logs/runner-summary.txt. `runner-sweep-leak` left 2 chromes (its designed drill leaf); swept; no other leftovers.
- **chain-e2e E9** (stuck recovery via open_home) **ok** and **E10** (stuck recovery via back) **ok**. Each test asserts `stuckRequests(stub).length === 1` (stub requests whose question set is exactly `recover`), so both observed **exactly 1** recover-only request; E9 also asserts acts navigate:1 / back:none and E10 back:1 / navigate:none and a round carrying `stuck`.
- **conformance-ops O18** (back-then-click): **cdp: pass**. **playwright: ran as the OPEN-1 todo and PASSED** — TAP shows `ok 18 - O18 ... # TODO OPEN-1 (r13): ...` with no error block and no `# SKIP` (I verified with a probe that a failing todo prints `not ok ... # TODO` plus the error, so `ok` means the click after the bfcache back landed), and it was not skipped, so the run was not blind to bfcache (the test's own precondition `sessionStorage bfcache === '1'` held). So in this harness the post-back click timeout did NOT reproduce on the playwright adapter; no failure text exists. Skip count in conformance-ops: 0.
- Gates: `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` -> `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.
- **KB-stuck proof** (flag form at the top of the `stuckEligible` closure, built to .build/kb-stuck): chain 85 tests, 64 pass, **21 FAIL, including the required `T-stuck-url`, `T-stuck-back`, `T-stuck-giveup`** (also T-stuck-d7/-once/-none-bar/-wrong-page/-evidence/-named-evidence/-same-url/-no-history/-two-stage/-lowconf-bounce/-two-bindings/-noprogress-exempt/-no-back-op/-telemetry-giveup/-memory-used/-reset-on-advance/-shares-recover-budget/-query-hub). Restored via `git checkout -- src/core/loop.ts`; `git status` clean.

## Part 2 — forced-handoff benchmark (t9-long-chain): forced-verdict **FAIL — a different shape than r12**
Ledger 5.814594 -> `--phase-cap-usd 20.814594`, `--cap-usd 3.00`.
Note: Phase S's bench/results file got the same minute-stamped name as Phase M's (`2026-10-01-0953.json`) and overwrote it locally. Phase M's JSON had already been copied (results/phase-m.json, 6 runs) and is intact in the pushed history.

**Phase V** (playwright x3, gate/policy off): 3/3, USD 0.7923 — V1 28.7 s / 0.3122, V2 29.9 s / 0.3068, V3 24.1 s / 0.1733.

**Phase M** (forced x3 + playwright x3 interleaved, gate/policy off, `--purpose measure`), total USD 1.6520:
| # | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 77.6 | 0.450311 | 10 | 5 | 36 | 0 | 0 |
| 2 | playwright | true | 21.7 | 0.161337 | 0 | 0 | 0 | 16 | 0 |
| 3 | forced | **false** | 55.5 | 0.227267 | 5 | 2 | 30 | 0 | 0 |
| 4 | playwright | true | 25.0 | 0.195613 | 0 | 0 | 0 | 16 | 0 |
| 5 | forced | true | 62.9 | 0.310409 | 8 | 2 | 33 | 0 | 0 |
| 6 | playwright | true | 32.6 | 0.307103 | 0 | 0 | 0 | 16 | 0 |

FORCED-VERDICT (verbatim, Phase M):
```
FORCED-VERDICT: completion forced=2/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=10
FORCED-VERDICT: picks 9/23
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 1.00
FORCED-VERDICT: no-page-error-end 1
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=4 no-match=2 no-progress=1 not-ready=10 wrong-page=3
FORCED-VERDICT: overall FAIL
```
Bars missed (thresholds untouched): **completion** (forced 2/3 < playwright 3/3; cell M3 failed), **handoffs** (needs 1..4 per run: 10 / 5 / 8), **median-steps** (1.00 < 4), **no-page-error-end** (1: M3's last call ended `error/page-error`). **Picks passed for the first time (9/23, under half).** Passed: wingman-share, raw-acts, zero-step-done, first-call-success, raw-script.

**Phase S** (forced x1, gate ON, policy off): ok=false, 16.5 s, USD 0.0644, 1 handoff, 0 picks, 6 wingman acts, 0 raw. `FORCED-VERDICT: smoke ok=false needs_confirmation=1` — the first handoff ended `needs_confirmation`/`irreversible-heuristic` after 15 rounds (6 steps, 2 of 7 clauses done) and the cell stopped there (the caller did not continue past the confirmation). Gate-on shape: the irreversible action returns a confirmation instead of acting; no bypass.

### Per-handoff detail, Phase M forced cells (M1 = cell 1, M3 = cell 3, M5 = cell 5)
| cell.call | status/reason | why | steps | progress done/total (caller numbering) | acts_by_op | stuck ids | expansion |
|---|---|---|---|---|---|---|---|
| M1.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | back,back,back | 7->16 |
| M1.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | - | 7->16 |
| M1.3 | fallback/step-uncertain | not-ready | 0 | 0/3 | {'wait': 2} | - | 3->8 |
| M1.4 | fallback/step-uncertain | wrong-page | 0 | 0/2 | None | give-up | 2->5 |
| M1.5 | fallback/step-uncertain | wrong-page | 0 | 0/3 | None | give-up | 3->6 |
| M1.6 | fallback/step-uncertain | no-match | 5 | 2/3 | {'navigate': 1, 'click': 3, 'back': 1} | back | 3->6 |
| M1.7 | fallback/step-uncertain | no-match | 4 | 1/2 | {'navigate': 1, 'click': 3} | - | 2->3 |
| M1.8 | fallback/step-uncertain | low-confidence | 2 | 0/2 | {'back': 2} | - | 2->2 |
| M1.9 | fallback/step-uncertain | low-confidence | 2 | 0/2 | {'click': 1, 'back': 1} | - | 2->2 |
| M1.10 | done/goal-met | - | 1 | 1/1 | {'click': 1} | - | 1->1 |
| M3.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | back,back,back | 7->16 |
| M3.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | - | 7->16 |
| M3.3 | fallback/step-uncertain | not-ready | 0 | 0/4 | {'wait': 2} | - | 4->8 |
| M3.4 | fallback/step-uncertain | not-ready | 1 | 0/4 | {'reload': 1, 'wait': 2} | - | 4->8 |
| M3.5 | error/page-error | - | 5 | 1/2 | {'navigate': 1, 'click': 2, 'fill': 1, 'reload': 1} | - | 2->4 |
| M5.1 | fallback/step-uncertain | not-ready | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | back,back,back | 7->16 |
| M5.2 | fallback/step-uncertain | not-ready | 0 | 4/7 | {'wait': 2} | - | 7->16 |
| M5.3 | fallback/step-uncertain | not-ready | 1 | 0/4 | {'reload': 1, 'wait': 2} | - | 4->8 |
| M5.4 | done/goal-met | - | 1 | 1/1 | {'navigate': 1} | - | 1->1 |
| M5.5 | fallback/no-progress | no-progress | 3 | 0/3 | {'fill': 1, 'click': 1, 'reload': 1} | - | 3->7 |
| M5.6 | fallback/step-uncertain | low-confidence | 4 | 2/3 | {'navigate': 1, 'click': 3} | open_home,give-up | 3->6 |
| M5.7 | fallback/step-uncertain | wrong-page | 0 | 0/2 | None | give-up | 2->2 |
| M5.8 | fallback/step-uncertain | low-confidence | 2 | 1/2 | {'navigate': 1, 'click': 1} | - | 2->2 |
(`progress.steps_total` is in the caller's numbering by design; the "expansion" column is the shipped `expandClauses` run on each call's recorded `steps`.)

### Telemetry (23 forced handoffs; per-round detail in evidence/telemetry-per-round.txt, evidence/why-buckets-and-advances.txt)
- **Decomposition: 17 of 23 calls decomposed** (e.g. 7 caller steps -> 16 sub-clauses, 4 -> 8, 3 -> 6, 2 -> 4/5); 6 had no compound clause; **0 over the cap**.
- **no-match 2** (r12: 13) and **low-confidence 4** (r12: 11): the `open <Page>` handbacks r12 diagnosed are essentially gone. wrong-page 3 (r12 2), no-progress 1 (r12 2). **not-ready 10 (r12: 0, r11b: 0)** — a new, now-largest bucket.
- **Stuck rounds (rounds[].stuck): 15** = `back` x10, `open_home` x1, `give-up` x4. Of the **11 recoveries** (back/open_home): the retried clause **committed an act in 9 (82%)** and **advanced to the next clause in 7 (64%)**; 4 recoveries ended in a bounce on the same clause (3 x M1/M3/M5 call 1 at `open Forgot Password` -> not-ready, 1 x M1.6 `open Status Codes` -> no-match after the back-click did not execute). All 10 `back` picks were by Jev with no url binding offered except in the `home`/`url`/`sc` cases: the url-typed bindings (`open_home`) were chosen once; the 4 `give-up` rounds all ended in the normal bounce (wrong-page x3 after 3 rounds, low-confidence x1). **No jev-error fallback followed any stuck ask** (no why/reason `jev-error` anywhere).
- **Recovery-navigate evidence rule:** the single stuck navigate (`open_home`, M5.6 round 3) was followed by an advance on the clause `open the web address named home`, which literally names that binding, so it is allowed; **0 violations** (no advance after a stuck navigate on a clause that does not name the binding).
- **act_error records: 0** in all 23 records, and **0 handoffs ended `error/act-failed`** (r12: 5, all right after a `back`). With the 10 stuck `back` acts all succeeding and the following clicks landing (e.g. `back` then `click` 220-420 ms, `page changed`), the data **do not support the post-back click timeout (H3') on this run** — the 5 act-failed endings did not recur and conformance-ops O18 playwright passed. Caveat: I cannot tell whether r13 prevented the failure or whether it was run-specific; a NoHistoryError path (`back` with nothing to go back to) never occurred in the logs (M1.8/M1.9 `go back` ends are low-confidence with `back` repeated 3x, not NoHistoryError).
- **Navigate-evidence advances: 5** (stepDoneP 0.52-0.72); premature-advance screen (next clause's first round rightPageP < 0.45 or readyP < 0.3): **0 hits**. URL/title before and after are still not in the log (host only), so proxies are the next clause's rightPageP/readyP and the end state.
- **clickEvidence / countEvidence:** see telemetry-per-round.txt section D; Add Element twice = see section E (the cell oracles were ok for M1 and M5; M3 failed later).
- **Wait storms (3 consecutive wait rounds): 10**, one per not-ready bounce (and M1.2/M1.3/M3.2/M3.3/M5.2/M5.3 each are exactly `wait, wait, wait` from round 1).

**Why the not-ready bucket exists (hypothesis, from per-round traces).** In all 3 forced cells the first call now runs ~33 rounds (r12: ≤10), completes 4 of 7 clauses, and then dies at the Forgot-Password clause: its first rounds (after a stuck `back`) land the page, but the clause text stays `open Forgot Password` while Jev, because stepDoneP for an `open <Page>` clause stays 0.09-0.48 (< 0.5, no navigate evidence since the open was done by a click), acts AHEAD on later sub-goals under it — `fill` the email field, then `click` Retrieve password (acts executed under the `open Forgot Password` text; the `click the Retrieve password button` sub-clause never gets to apply its click evidence). After that click the page is not ready (readyP 0.08-0.2, element gone), Jev answers `wait`, and 3 waits end in a `not-ready` bounce; every later call restarts from the stored cursor at `open Forgot Password` and hits the same not-ready page at once (M1.2/M1.3, M3.2/M3.3/M3.4, M5.2/M5.3). That is the 10 not-ready handoffs and, for M3, the cell failure (final call `error/page-error` on `click the Retrieve password button`). Acting-ahead rounds under an `open <X>` clause were: `check`/`select`/`fill` once each for Checkboxes/Dropdown/Inputs/Forgot Password in M1.1, M3.1 and M5.1. I did not isolate this against the caller's phrasing, n=3.

**Why-bucket occurrences (step_text of last round -> decided action), full detail in evidence/why-buckets-and-advances.txt:**
- not-ready (10): `open Forgot Password` -> wait x8 (M1.1, M1.2, M1.3, M3.1, M3.2, M5.1, M5.2 + M1.3), `reload the page` -> wait x3 (M3.3, M3.4, M5.3). (8 are on `open Forgot Password` incl. the 3 first calls; 3 on `reload the page`; the 10 listed in the file.)
- no-match (2): `open Status Codes` -> click (target none 0.98), `open the 404 link` -> click (target none 0.90).
- wrong-page (3): `open Dynamic Loading`, `open the web address named url`, `open the web address named sc` — each a `give-up` stuck round (give-up -> wrong-page bounce, no act).
- low-confidence (4): `go back` -> back x2 (M1.8, M1.9), `open Status Codes` (after give-up), `open the 404 link` -> click.
- no-progress (1): `click the Retrieve password button` -> wait (hist `no visible change`).
- repeat (0).
Largest target for the next fix: **not-ready (10)** — the Forgot-Password clause that never advances, with Jev acting ahead under an `open <Page>` clause, followed by a wait storm on the post-submit page.

### r9 / r11b / r12 / r13 comparison (all cloud Sonnet caller)
| Metric | r9 (3a82301) | r11b (3a12d32) | r12 (f39aa12) | r13 (64cbbdb) |
|---|---|---|---|---|
| Forced completion | 2/3 | 3/3 | 3/3 | **2/3** |
| Median steps/handoff | 1.00 | 2.00 | 2.00 | **1.00** |
| Handoffs max | 21 | 12 | 15 | **10** |
| Picks | 34/51 | 13/24 | 26/37 | **9/23** |
| Forced wall (median of 3) | 191.4 s | 46.8 s | 75.7 s | **62.9 s** |
| Playwright wall (median of 3) | 46.6 s | 23.7 s | 34.6 s | **25.0 s** |
| Forced cost per cell (avg) | ~0.96 | 0.35 | 0.43 | **0.33** |
| no-match / low-confidence / not-ready | 10 / 7 / 17 | 8 / 3 / 0 | 13 / 11 / 0 | **2 / 4 / 10** |
| Bars missed | completion, handoffs, picks, median-steps | handoffs, picks, median-steps | handoffs, picks, median-steps | **completion, handoffs, median-steps, no-page-error-end** |
Reading: the r13 stuck recovery did what it targeted: no-match 13 -> 2, low-confidence 11 -> 4, picks 26/37 -> 9/23 (picks bar now passes), handoffs max 15 -> 10, handoff total 37 -> 23, forced cost down. But the headline did not pass and two bars regressed: completion 3/3 -> 2/3 (cell M3 ended `error/page-error`) and no-page-error-end 0 -> 1, with median-steps 2.00 -> 1.00, because the deeper first call exposes the not-ready Forgot-Password failure above. n=3 forced cells is noisy; M3's failure is the same call-1/call-2 pattern as M1/M5 but its later calls did not recover. Both routes' walls are near r11b's, so wall/cost movement is mostly noise.

## Part 3 — fresh-install check: PASS (3/3 first-call success), about USD 0.187
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
| Page | browse_step calls | First call | acts_by_op | Rounds (stepDoneP / historyResult / countEvidence) | act_error / stuck | Independent check | Non-read browser tool use |
|---|---|---|---|---|---|---|---|
| /inputs | 1 | done/goal-met, steps 1 | fill:1 | r1 0.07 / - ; r2 0.73 / filled | none / none | field value = the typed number | none (ToolSearch + browse_step only) |
| /dropdown | 1 | done/goal-met, steps 1 | select:1 | r1 0.06 / - ; r2 0.96 / selected: Option 2 | none / none | selected = Option 2 | none |
| /add_remove_elements/ | 1 | done/goal-met, steps 2 | click:2 | r1 0.06 ; r2 0.12 / page changed ; r3 0.92 / page changed / **countEvidence=2** | none / none | **Delete buttons = 2** (raw CDP) | none |

### Doc gaps (unchanged since r11b; INSTALL-FOR-AGENTS.md and package.json unchanged)
1. RC package and `--version` report **0.2.1**, not 0.3.0 (tarball is jev-browser-wingman-0.2.1.tgz).
2. `~/.jev-browser-wingman/backups/` does not exist on a fresh install; the doc says to save backups there.
3. `doctor --plan` prints the wrapped entry as bare JSON (no `type`/`env`) and does not say how to apply it with the client's own command (`claude mcp remove` then `claude mcp add -s user NAME -- jev-browser-wingman with-browser -- <C> <A...>`).
4. `doctor --plan` marks O3 [met] but `adapter-attach` only passed after `chrome ensure` (run before the first `doctor`; whether plain `doctor` launches the browser itself was not tested).
5. No instructions for installing from a packed tarball ("After publish" only).
6. The caller needs an extra `ToolSearch` call to load `browse_step` under `claude -p` (deferred tools).

## Linux-only caveats
Cloud Linux/Xvfb; Chromium behind the wrapper (`--ignore-certificate-errors`, unprivileged uid, root container). The bfcache/back behaviour that r12 hypothesised (H3') is browser- and adapter-specific; O18's playwright pass here is for this Chromium build and fixture, so it neither proves nor rules out the original failure on other platforms (e.g. Windows). win32-only skip in chrome-cmd; Windows-only chain-e2e flake N/A. n=3 forced cells.

## Push-scan notes
The key-prefix string, the key value and every bound value of length >= 3 never matched in any pushed file. The 2-character bound values (digit strings) can coincide with numeric telemetry; the bare-token scan therefore excludes logs/, evidence/ and results/, and every file is scanned for them as quoted JSON strings. Raw caller transcripts (which contain bound values) were NOT pushed.
