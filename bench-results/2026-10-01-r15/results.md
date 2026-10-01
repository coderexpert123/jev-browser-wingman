# r15 validation — jev-browser-wingman 0.3.0 "forced handoff" (HEAD e2b72f0)

Code under test: `forced-handoff-0.3.0` @ e2b72f0 (r15: post-action ends, error gate on weak advances, no repeated submit, act recorded before dialog return — on top of r11-r14). Environment: cloud Linux, Xvfb :99, chromium-wrapper as /usr/bin/chromium and /opt/google/chrome/chrome, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller: cloud Sonnet (like-for-like with r12/r13/r14).
No src/, tests/, thresholds, profiles/ or fixtures edited (only the sanctioned KB flip, restored; tracked tree clean).
New spend: Part 2 USD 2.6201 (cap 15) + Part 3 about USD 0.185 (cap 4).

## Headline
**forced-verdict overall PASS on Phase M — the first PASS of any round** (completion 3/3, handoffs max 4, picks 1/11, median-steps 4.00, no-page-error-end 0). n=3 forced cells; the margin on the two bars that failed in r14 is exactly at the bar (handoffs max 4 against a 1..4 bar, median-steps 4.00 against >= 4), so one more handoff in one cell would flip the verdict again.

## Part 1 — full suite: GREEN
`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0. 51/51 files, one per invocation, sequential: **781 tests, 779 pass, 1 skip (chrome-cmd win32-only), 1 todo, 0 fail**; no re-runs needed. chain 110/110, **chain-e2e 13/13 including E9, E10, E11, E12 and E13**, pick-e2e 2/2, browse-step-surface 7/7, conformance 28/28, conformance-ops 40 pass + 1 todo, bench-cap 10/10, doctor 26/26. Per-file counts: part1/logs/runner-summary.txt. `runner-sweep-leak` leaves its designed drill chrome, swept; no other leftovers.
- **E12** (same-address error-page submit -> call 1 post-action, call 2 repeat, submits=1 loads=1) and **E13** (error variant -> page-error post-action, reload refused) pass.
- **conformance-ops O18:** cdp pass; playwright ran as the OPEN-1 todo and **passed** (`ok 18 ... # TODO OPEN-1`, no error, no skip) — same as r13/r14; skip count in the file: 0 (not blind to bfcache).
- Gates: `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` -> `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.
- **KB-r15 proof** (`const KB_R15 = true;` after `KB_PICK_OBSCURED`, the three specified replacements; built to .build/kb-r15 with entries tests/chain.test.ts, tests/chain-e2e.test.ts, src/cli/main.ts): chain 110 tests, 103 pass, **7 FAIL: `T-post-notready`, `T-post-reload`, `T-repeat-resume` (required) plus `T-repeat-pick`, `T-repeat-dialog`, `T-late-landing-notready`, `T-late-landing-reload`**; chain-e2e 13 tests, 11 pass, **`E12` and `E13` FAIL**. Restored via `git checkout -- src/core/loop.ts`; `git status` clean.

## Part 2 — forced-handoff benchmark (t9-long-chain): forced-verdict **PASS**
Ledger 5.814594 -> `--phase-cap-usd 20.814594`, `--cap-usd 3.00`. Result files second-stamped, no collisions.

**Phase V** (playwright x3, gate/policy off): 3/3, USD 0.9811 — V1 42.7 s / 0.4654, V2 23.1 s / 0.1389, V3 40.3 s / 0.3768.

**Phase M** (forced x3 + playwright x3 interleaved, gate/policy off, `--purpose measure`), total USD 1.5749:
| # | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 50.3 | 0.275102 | 3 | 0 | 30 | 0 | 0 |
| 2 | playwright | true | 29.3 | 0.251189 | 0 | 0 | 0 | 16 | 0 |
| 3 | forced | true | 45.4 | 0.175035 | 4 | 1 | 26 | 0 | 0 |
| 4 | playwright | true | 39.8 | 0.361125 | 0 | 0 | 0 | 16 | 1 |
| 5 | forced | true | 43.9 | 0.212276 | 4 | 0 | 25 | 0 | 0 |
| 6 | playwright | true | 33.2 | 0.300210 | 0 | 0 | 0 | 16 | 1 |
(The `raw_script=1` on playwright cells 4 and 6 is the control route's own tool use and is not counted by the verdict, which reads forced cells only: `raw-script 0`.)

FORCED-VERDICT (verbatim, Phase M):
```
FORCED-VERDICT: completion forced=3/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=4
FORCED-VERDICT: picks 1/11
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 4.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=1 no-match=2 post-action=4 wrong-page=3
FORCED-VERDICT: overall PASS
```
**Phase S** (forced x1, gate ON, policy off): ok=false, 17.5 s, USD 0.0640, 1 handoff, 0 picks, 6 wingman acts, 0 raw. `FORCED-VERDICT: smoke ok=false needs_confirmation=1` — the first handoff ended `needs_confirmation`/`irreversible-heuristic` after 15 rounds (6 steps, 2 of 7 clauses done) and the cell stopped there; same shape as r13/r14. The gate-on path converts the irreversible action to a confirmation instead of acting; the smoke run does not continue past it.

### Per-handoff detail, Phase M forced cells (M1 = cell 1, M3 = cell 3, M5 = cell 5)
| cell.call | status/reason | why | steps | progress done/total (caller numbering) | acts_by_op | navEv rounds | stuck | expansion |
|---|---|---|---|---|---|---|---|---|
| M1.1 | fallback/step-uncertain | post-action | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 4 | back,back,back | 7->16 |
| M1.2 | fallback/step-uncertain | no-match | 6 | 2/3 | {'navigate': 2, 'click': 4} | 1 | open_start_url,give-up | 3->6 |
| M1.3 | fallback/step-uncertain | post-action | 2 | 1/2 | {'navigate': 1, 'click': 1, 'wait': 4} | 0 | - | 2->2 |
| M3.1 | fallback/step-uncertain | post-action | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 3 | back,back,back,back | 7->16 |
| M3.2 | fallback/step-uncertain | wrong-page | 1 | 0/2 | {'back': 1} | 0 | - | 2->5 |
| M3.3 | fallback/step-uncertain | wrong-page | 0 | 0/5 | None | 0 | - | 5->7 |
| M3.4 | done/goal-met | - | 7 | 5/5 | {'navigate': 2, 'click': 5} | 0 | open_start_url | 5->7 |
| M5.1 | fallback/step-uncertain | post-action | 16 | 4/7 | {'click': 8, 'check': 1, 'back': 4, 'select': 1, 'fill': 2, 'wait': 2} | 3 | back,back,back | 7->16 |
| M5.2 | fallback/step-uncertain | wrong-page | 1 | 0/2 | {'back': 1} | 0 | - | 2->5 |
| M5.3 | fallback/step-uncertain | no-match | 4 | 2/3 | {'navigate': 1, 'click': 3} | 0 | give-up | 3->6 |
| M5.4 | fallback/step-uncertain | low-confidence | 2 | 1/2 | {'navigate': 1, 'click': 1} | 0 | - | 2->2 |
(`progress.steps_total` is in the caller's numbering by design; "expansion" is the shipped `expandClauses` run on each call's recorded `steps`. M1.3 and M5.4 have no compound clause because the caller issued single-action steps.)

### Telemetry (11 forced handoffs; per-round detail in evidence/telemetry-per-round.txt, evidence/post-action-notes-and-next-calls.txt)
- **Decomposition:** 9 of 11 calls decomposed (7 caller steps -> 16 sub-clauses, 5 -> 7, 3 -> 6, 2 -> 5), 2 had no compound clause, **0 over the cap**.
- **why-breakdown vs r14:** not-ready **0** (r14: 6), **post-action 4 (new)**, repeat 0, low-confidence 1 (4), wrong-page 3 (1), no-match 2 (2), no-progress 0. Total handoffs 11 (r14: 14; r13: 23; r12: 37); all fallbacks `step-uncertain`; no `error` ends, **0 act_error records, 0 `jev-error`**, **0 rounds carry a `recover` field**.
- **Post-action ends (D1): 4** — 3 are the first call of each cell at `click the Retrieve password button` (the r14 not-ready clause: the submit executed, the same-URL Internal Server Error page followed, stepDoneP 0.46-0.49, errorP 0.41-0.46, readyP ~0.2, leftPage False, 4 of 7 clauses done) and 1 is M1.3's final clause `open the 404 link` (6 clicks, stepDoneP 0.2, errorP 0.34, 1 of 2 clauses). The note the caller received in all four is the new FORCED_POST_ACTION_LINE verbatim (transcripts): "This step's action already ran, then the page did not become usable for the step and may show an error. Look at it with your own snapshot and do not repeat that action or reload the page. To go on, call browse_step again with only the steps after this one; if the page shows a failure the user needs to know about, tell the user."
- **What the caller did next (the real test of the note):** in **all 3 Retrieve-password cases the caller skipped the executed clause exactly as told** — its next call began with the clauses after the submit (`open Dynamic Loading ...`, `open Status Codes ...`; M1's next call prefixed `go back to the start page`), never re-submitted, and never reloaded. M1.3's post-action was the cell's last call (the caller stopped; the cell oracle was ok). **Re-executed click on a remembered target: 0** (no `repeat` why anywhere, and no Retrieve-password clause appears in any later call); **reload executed after an effective click: 0** (`acts_by_op` has no `reload` in any call). The D3 `repeat` bounce itself was therefore never exercised live (the caller followed the note), so its live behaviour is covered only by E12/T-repeat-*.
- **`late` flag / no-visible-change clicks:** 0 clicks read `no visible change` in any round, so no late-landing reclassification occurred; the `late` flag itself is not in the log.
- **D2 (error gate on weak advances):** max errorP over every round was **0.47**; **0 rounds had errorP >= 0.5**, so the new gate had nothing to block in this run (the 10 rounds at errorP 0.30-0.47 with stepDoneP 0.25-0.49 did not advance, but all were below the 0.5 error threshold and below the step-done evidence bars, i.e. not blocked by D2 specifically). Not shown to be exercised live; covered by unit tests only.
- **navEvidence advances: 11** (all `open <Page>` clauses: Checkboxes, Dropdown, Inputs, Forgot Password, Dynamic Loading; stepDoneP 0.28-0.48, errorP 0.04-0.09, leftPage True). **Next-clause check: 11/11 committed an element act within 2 rounds** (next-clause first round rightPageP 0.70-0.91, readyP 0.56-0.82, errorP 0.05-0.09); **premature-advance screen: 0 hits**.
- **Final-clause advance:** exactly 1 — M3.4 `open the 404 link`, done/goal-met 5/5 at stepDoneP 0.77 via click evidence (navEvidence unset; hist `element gone`; the cell oracle was ok). No navEvidence on any final clause, so no false goal-met.
- **Acting-ahead (executed fill/select/check under an `open <X>` clause): 0.**
- **Stuck rounds: 14** = `back` x10, `open_start_url` x2, `give-up` x2 (the url-typed binding was offered and chosen twice this round). Of the 12 recoveries: 11 committed an act and 12 advanced (r14: 90%/90%; r13: 82%/64%). The 2 `give-up` rounds (`open Status Codes`) ended `no-match`. **Violations: 0** (the two `open_start_url` navigates were on clauses that name the start-page address, `go back to the start page` / `go to the web address in start_url`).
- **clickEvidence 26, countEvidence 3** (value 2, in the first call of each cell). **'Click the Add Element button twice': exactly 2 executed clicks in each of the 3 forced cells.** **Wait storms (3+ consecutive waits): 3 calls** — the first call of each cell, at the Retrieve-password step, which now ends post-action instead of not-ready (the 3 waits happen first, then the end).

**What still produces handoffs (hypotheses from per-round traces):**
1. **The first call of every cell still ends at the Retrieve-password submit** (post-action, 3 of 11 handoffs): the site's same-URL error page keeps stepDoneP just under 0.5 and readyP ~0.2, so the clause cannot advance; the r15 change turns that from a not-ready bounce that re-clicked the submit into an honest post-action end with a note the caller follows, and the next call continues the chain. One handoff per cell remains structurally.
2. **`open Status Codes` / `open the 404 link` tail:** no-match x2 (give-up), wrong-page x3 (`open Dynamic Loading` after a stuck `back`, `open the web address in start_url`), low-confidence x1 (M5.4 final clause `open the 404 link`, leftPage True, stepDoneP 0.36 — the 404 page reached but the final clause keeps its stricter bar), post-action x1 (M1.3, same final clause).
3. The caller's own phrasing varies per cell (single-step vs compound chains), so the tail handoffs differ cell to cell; n=3.

**Why-bucket occurrences (step_text of last round -> decided action), all in evidence/telemetry-per-round.txt section N:**
- post-action (4): `click the Retrieve password button` -> wait x3 (M1.1, M3.1, M5.1), `open the 404 link` -> click (M1.3).
- no-match (2): `open Status Codes` -> stuck give-up then bounce (M1.2, M5.3).
- wrong-page (3): `open Dynamic Loading` -> click x2 (M3.2, M5.2), `open the web address in start_url` -> navigate (M3.3).
- low-confidence (1): `open the 404 link` -> click (M5.4).
- not-ready (0), repeat (0), no-progress (0).
Largest target for the next fix: **post-action (4)** — and within it the unavoidable Retrieve-password submit that ends its call by design; the next-largest is the `open Dynamic Loading` / `open Status Codes` wrong-page + no-match tail (5).

### r12 / r13 / r14 / r15 comparison (all cloud Sonnet caller)
| Metric | r12 (f39aa12) | r13 (64cbbdb) | r14 (68b66eb) | r15 (e2b72f0) |
|---|---|---|---|---|
| Forced completion | 3/3 | 2/3 | 3/3 | **3/3** |
| Median steps/handoff | 2.00 | 1.00 | 3.00 | **4.00** |
| Handoffs max (total) | 15 (37) | 10 (23) | 5 (14) | **4 (11)** |
| Picks | 26/37 | 9/23 | 5/14 | **1/11** |
| Forced wall (median of 3) | 75.7 s | 62.9 s | 47.0 s | **45.4 s** |
| Playwright wall (median of 3) | 34.6 s | 25.0 s | 32.0 s | **33.2 s** |
| Forced cost per cell (avg) | 0.43 | 0.33 | 0.24 | **0.22** |
| no-match / low-conf / not-ready / post-action | 13 / 11 / 0 / - | 2 / 4 / 10 / - | 2 / 4 / 6 / - | **2 / 1 / 0 / 4** |
| Bars missed | handoffs, picks, median-steps | completion, handoffs, median-steps, no-page-error-end | handoffs, median-steps | **none (PASS)** |
Reading: each round of the series moved a different part of the handoff chain; r15's D1/D3 turn the Retrieve-password not-ready/re-submit pair into one post-action end that the caller follows (3/3), which was the entire remaining shortfall in r14 (5 -> 4 handoffs, 3.00 -> 4.00 median steps). The result is at the bar rather than past it on those two bars, n=3, and playwright control wall is flat versus r14 (32-33 s), so the forced wall/cost drop is real but modest.

## Part 3 — fresh-install check: PASS (3/3 first-call success), about USD 0.185
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
| Page | browse_step calls | First call | acts_by_op | Rounds (stepDoneP / historyResult / countEvidence) | act_error / stuck / recover / navEvidence | Independent check | Non-read browser tool use |
|---|---|---|---|---|---|---|---|
| /inputs | 1 | done/goal-met, steps 1 | fill:1 | r1 0.10 / - ; r2 0.67 / filled | none / none / none / none | field value = the typed number | none (ToolSearch + browse_step only) |
| /dropdown | 1 | done/goal-met, steps 1 | select:1 | r1 0.06 / - ; r2 0.95 / selected: Option 2 | none / none / none / none | selected = Option 2 | none |
| /add_remove_elements/ | 1 | done/goal-met, steps 2 | click:2 | r1 0.07 ; r2 0.13 / page changed ; r3 0.92 / page changed / **countEvidence=2** | none / none / none / none | **Delete buttons = 2** (raw CDP) | none |

### Doc gaps (unchanged since r11b; INSTALL-FOR-AGENTS.md and package.json unchanged)
1. RC package and `--version` report **0.2.1**, not 0.3.0 (tarball is jev-browser-wingman-0.2.1.tgz).
2. `~/.jev-browser-wingman/backups/` does not exist on a fresh install; the doc says to save backups there.
3. `doctor --plan` prints the wrapped entry as bare JSON (no `type`/`env`) and does not say how to apply it with the client's own command (`claude mcp remove` then `claude mcp add -s user NAME -- jev-browser-wingman with-browser -- <C> <A...>`).
4. `doctor --plan` marks O3 [met] but `adapter-attach` only passed after `chrome ensure` (run before the first `doctor`; whether plain `doctor` launches the browser itself was not tested).
5. No instructions for installing from a packed tarball ("After publish" only).
6. The caller needs an extra `ToolSearch` call to load `browse_step` under `claude -p` (deferred tools).
7. New in r15 (suggestion, not a defect): the install doc's "Step phrasing and recovery" section does not mention the new post-action note; callers that ignore it will still re-run the executed step.

## Linux-only caveats
Cloud Linux/Xvfb; Chromium behind the wrapper (`--ignore-certificate-errors`, unprivileged uid, root container). The Retrieve-password POST (same URL path, Internal Server Error page) is a property of this site as served to this browser and is what makes the post-action clause arise; on a site whose submit changes the URL the r14 nav rule would apply instead. O18's playwright pass is specific to this Chromium build. win32-only skip in chrome-cmd; Windows-only chain-e2e flake N/A. **n=3 forced cells; the PASS is at the bar on two of its bars (handoffs max 4, median-steps 4.00) and should be re-measured before it is treated as stable.**

## Push-scan notes
The key-prefix string, the key value and every bound value of length >= 3 never matched in any pushed file. The 2-character bound values (digit strings) can coincide with numeric telemetry; the bare-token scan therefore excludes logs/, evidence/ and results/, and every file is scanned for them as quoted JSON strings. Raw caller transcripts (which contain bound values) were NOT pushed; evidence/post-action-notes-and-next-calls.txt contains only status/note text and clause texts, not values.
