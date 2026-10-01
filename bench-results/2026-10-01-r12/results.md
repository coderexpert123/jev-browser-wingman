# r12 validation — jev-browser-wingman 0.3.0 "forced handoff" (HEAD f39aa12)

Code under test: `forced-handoff-0.3.0` @ f39aa12 (r12: 1cd5ab0 expansion cap 36 + navigate-as-evidence; f39aa12 pins). Environment: cloud Linux, Xvfb :99, chromium-wrapper installed as /usr/bin/chromium and /opt/google/chrome/chrome, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller: cloud Sonnet (like-for-like with r8/r9/r11b).
No src/, tests/, thresholds, profiles/ or fixtures edited (only the sanctioned KB flip, restored; `git status` clean of tracked changes).
New spend: Part 2 USD 3.6822 (cap 15) + Part 3 about USD 0.185 (cap 4).

## Part 1 — full suite: GREEN after one re-run (one first-run flake)
`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0. 51/51 files, sequential: **713 tests, 712 pass, 1 skip (chrome-cmd win32-only), 0 fail after re-run.**
- **First run, tests/doctor.test.ts #12 "all ten checks pass on a clean ephemeral setup" FAILED**: `coexistence did not pass: observer fingerprint changed across attach/detach` (`'FAIL' !== 'PASS'`). **Re-run: doctor 26/26 pass.** Both logs: part1/logs/doctor.log, doctor-rerun.log. It passed in r11b and in the rerun; diagnosis (hypothesis only): a timing-sensitive live-Chrome fingerprint comparison, run immediately after the previous file's Chrome teardown; no code in this diff touches doctor/coexistence (the diff is src/core/loop.ts + tests). Treated as a flake, not a stop; flagged here because the instructions said any failure on Linux is a finding.
- bench-cap 8/8 (fixed in 3a12d32), chain 53/53, outcome-evidence 45/45, chain-e2e 8/8, all others pass; per-file counts in part1/logs/runner-summary.txt.
- Gates: `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` -> `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.
- **KB-nav proof** (flag form on hasStepEvidence's navigate line, built to .build/kb-nav): outcome-evidence 45 tests, 44 pass, **1 FAIL = `T-navigate-evidence: step_done 0.6 after a page-changing navigate advances on navigate evidence`** (exactly the expected test). Restored via `git checkout -- src/core/loop.ts`, `git status` clean.

## Part 2 — forced-handoff benchmark (t9-long-chain): forced-verdict **FAIL (same 3 bars as r11b, numerically worse)**
Ledger 5.814594 -> `--phase-cap-usd 20.814594`, `--cap-usd 3.00`.

**Phase V** (playwright x3, gate off, policy off): 3/3, USD 0.9173 — V1 35.8 s / 0.3091, V2 35.3 s / 0.3362, V3 32.3 s / 0.2720.

**Phase M** (forced x3 + playwright x3 interleaved, gate/policy off, `--purpose measure`), total USD 2.2281:
| # | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 99.5 | 0.533276 | 15 | 9 | 30 | 0 | 0 |
| 2 | playwright | true | 34.6 | 0.305122 | 0 | 0 | 0 | 17 | 0 |
| 3 | forced | true | 61.1 | 0.348754 | 10 | 8 | 24 | 0 | 0 |
| 4 | playwright | true | 41.2 | 0.338569 | 0 | 0 | 0 | 16 | 0 |
| 5 | forced | true | 75.7 | 0.418393 | 12 | 9 | 26 | 0 | 0 |
| 6 | playwright | true | 32.5 | 0.283970 | 0 | 0 | 0 | 16 | 0 |

FORCED-VERDICT (verbatim, Phase M):
```
FORCED-VERDICT: completion forced=3/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=15
FORCED-VERDICT: picks 26/37
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 2.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=11 no-match=13 no-progress=2 wrong-page=2
FORCED-VERDICT: overall FAIL
```
Bars missed (thresholds untouched): **handoffs** (needs 1..4 per run; 15/10/12), **picks** (needs < 50%; 26/37 = 70%), **median-steps** (needs >= 4; 2.00). Passed: completion, wingman-share, raw-acts, zero-step-done, first-call-success, no-page-error-end, raw-script.

**Phase S** (forced x1, gate ON, policy off): ok=true, 92.5 s, USD 0.5368, 15 handoffs, 8 picks, 28 wingman acts, 0 raw. `FORCED-VERDICT: smoke ok=true needs_confirmation=6` (6 handoffs ended `needs_confirmation`/`irreversible-heuristic`; the run still completed after confirmations/picks).

### Per-handoff detail, Phase M forced cells (M1 = cell 1, M3 = cell 3, M5 = cell 5; call numbers in order)
| cell.call | status/reason | why | steps | progress done/total (caller numbering) | acts_by_op | expansion |
|---|---|---|---|---|---|---|
| M1.1 | fallback/step-uncertain | no-match | 2 | 1/7 | {'click': 1, 'check': 1} | 7->16 |
| M1.2 | error/act-failed | - | 1 | 0/6 | {'back': 1} | 6->14 |
| M1.3 | fallback/step-uncertain | no-match | 2 | 1/6 | {'click': 1, 'select': 1} | 6->14 |
| M1.4 | error/act-failed | - | 1 | 0/5 | {'back': 1} | 5->12 |
| M1.5 | fallback/step-uncertain | no-match | 3 | 1/5 | {'click': 3} | 5->12 |
| M1.6 | error/act-failed | - | 1 | 0/4 | {'back': 1} | 4->10 |
| M1.7 | fallback/step-uncertain | low-confidence | 1 | 0/4 | {'click': 1} | 4->10 |
| M1.8 | fallback/step-uncertain | no-match | 1 | 1/4 | {'fill': 1} | 4->10 |
| M1.9 | error/act-failed | - | 1 | 0/3 | {'back': 1} | 3->8 |
| M1.10 | fallback/no-progress | no-progress | 4 | 0/3 | {'click': 2, 'fill': 1, 'reload': 1} | 3->8 |
| M1.11 | fallback/step-uncertain | wrong-page | 1 | 0/2 | {'back': 1, 'wait': 1} | 2->5 |
| M1.12 | fallback/step-uncertain | wrong-page | 0 | 0/3 | None | 3->6 |
| M1.13 | fallback/step-uncertain | low-confidence | 4 | 1/2 | {'navigate': 1, 'click': 3} | 2->5 |
| M1.14 | fallback/step-uncertain | no-match | 5 | 0/1 | {'navigate': 1, 'click': 4} | 1->2 |
| M1.15 | done/goal-met | - | 2 | 2/2 | {'navigate': 1, 'click': 1} | 2->2 |
| M3.1 | fallback/step-uncertain | no-match | 2 | 1/7 | {'click': 1, 'check': 1} | 7->16 |
| M3.2 | fallback/step-uncertain | low-confidence | 0 | 0/7 | None | 7->15 |
| M3.3 | fallback/step-uncertain | no-match | 3 | 2/7 | {'navigate': 1, 'click': 1, 'select': 1} | 7->15 |
| M3.4 | fallback/step-uncertain | no-match | 4 | 2/6 | {'navigate': 1, 'click': 3} | 6->13 |
| M3.5 | fallback/step-uncertain | low-confidence | 2 | 1/5 | {'navigate': 1, 'click': 1} | 5->11 |
| M3.6 | fallback/step-uncertain | low-confidence | 2 | 1/5 | {'fill': 2} | 5->10 |
| M3.7 | error/page-error | - | 4 | 1/4 | {'navigate': 1, 'click': 2, 'fill': 1} | 4->9 |
| M3.8 | fallback/step-uncertain | low-confidence | 4 | 2/3 | {'navigate': 1, 'click': 3} | 3->6 |
| M3.9 | fallback/step-uncertain | low-confidence | 2 | 1/2 | {'navigate': 1, 'click': 1} | 2->3 |
| M3.10 | fallback/step-uncertain | low-confidence | 1 | 0/1 | {'click': 1} | 1->1 |
| M5.1 | fallback/step-uncertain | no-match | 2 | 1/7 | {'click': 1, 'check': 1} | 7->16 |
| M5.2 | fallback/step-uncertain | low-confidence | 0 | 0/6 | None | 6->15 |
| M5.3 | error/act-failed | - | 1 | 0/6 | {'back': 1} | 6->15 |
| M5.4 | fallback/step-uncertain | no-match | 2 | 1/6 | {'click': 1, 'select': 1} | 6->14 |
| M5.5 | fallback/step-uncertain | no-match | 4 | 1/5 | {'navigate': 1, 'click': 3} | 5->12 |
| M5.6 | fallback/no-progress | no-progress | 3 | 0/4 | {'navigate': 1, 'click': 2} | 4->10 |
| M5.7 | fallback/step-uncertain | no-match | 1 | 1/4 | {'fill': 1} | 4->9 |
| M5.8 | fallback/step-uncertain | low-confidence | 3 | 0/3 | {'navigate': 1, 'click': 1, 'fill': 1} | 3->8 |
| M5.9 | error/page-error | - | 1 | 0/3 | {'click': 1} | 3->6 |
| M5.10 | fallback/step-uncertain | no-match | 4 | 1/2 | {'navigate': 1, 'click': 3} | 2->5 |
| M5.11 | fallback/step-uncertain | low-confidence | 4 | 0/1 | {'navigate': 1, 'click': 3} | 1->2 |
| M5.12 | done/goal-met | - | 1 | 1/1 | {'navigate': 1} | 1->1 |
(`progress.steps_total` is in the caller's numbering by design; the "expansion" column was computed by running the shipped `expandClauses` on each call's recorded `steps`.)

### Telemetry (37 forced handoffs; per-round detail in evidence/telemetry-per-round.txt)
- **Expansion cap hits: 0** (largest expansion 16 against the new cap 36; r11b: 11 of 24 hit the old 12-cap). **Decomposition: 34 of 37 calls decomposed** (e.g. 7 caller steps -> 16 sub-clauses, 6 -> 14, 3 -> 8, 1 -> 2); 3 had no compound clause. So change (1) works mechanically.
- **no-match 13** (r11b: 8; r10: 20 of 38). low-confidence **11** (r11b 3), no-progress 2, wrong-page 2 (r11b 4), **not-ready 0**, **repeat 0**. all 26 why-labelled handoffs came from decomposed calls. The count of no-match went UP although the cap no longer defeats decomposition.
- **Largest-bucket diagnosis.** 8 of the 13 no-match, and 9 of the 24 no-match+low-confidence, end on a **stranded `open <Page>` sub-clause** (`open Dropdown` x3, `open Add/Remove Elements` x3, `open Inputs` x3, `open Forgot Password` x2, `open Status Codes` x1; plus `open the 404 link` x1): Jev answers target1=`none` at 0.92-0.99 (no such element on the current page) while the decided action is `click` (aP 0.5-0.93). The caller's compound steps like "open Dropdown and choose Option 1" (link-text navigation, no URL named) are split at `and` into `open Dropdown` + `choose Option 1`; the first sub-clause is asked while the browser is still on the previous page (e.g. history `checked` / `selected: Option 1` / `filled`), where the link text does not exist. Hypothesis: after the previous clause's act the page was not the index page the link lives on, so an `open <link>` clause has no target — the clause was previously satisfiable only because the caller (r11b) often named a URL; in r12 the caller phrased most steps as link text. This also depends on caller phrasing variance (n=3), which I cannot separate from the code effect with this data.
- **Other why-buckets, every occurrence** (step_text of last round -> decided action) are in evidence/why-buckets.txt. low-confidence: `open Status Codes`/`open Inputs`/`open the 404 link` -> back/wait/click/navigate (7), `open the web address named home` -> navigate (3, with a start-page `home` value), `enter the value named email...` -> fill (1). no-progress: `click the Retrieve password button` -> wait, `open Inputs` -> click. wrong-page: `open Dynamic Loading` -> click, `open the web address named home` -> navigate.
- **New observation:** 5 handoffs ended `error/act-failed` with `back` as the only act (run1 calls 2, 4, 6, 9 and run3 call 3 — a caller `pick` of `back` that failed) vs 1 in r11b; they consume a handoff each and add to the handoff total.
- **Navigate-evidence advances: 3** (run1 call 15, run2 call 9, run3 call 12; stepDoneP 0.73 / 0.82 / 0.81, all below the old 0.85 bar), **0 premature**. Two of those calls then ended `done/goal-met`; run2.9 advanced onto `open Status Codes` with next-clause first-round rightPageP 0.85. Caveat: **page URL/title before/after are not in the wingman log** (only host), so the requested before/after listing is not reconstructible; the proxies used are the next clause's rightPageP/readyP and the call's end state. A premature-advance screen (next clause's first round rightPageP < 0.45 or readyP < 0.3) found 0 hits. The caller used `navigate` rarely this round (the clause mix shifted to link clicks), so change (2) was exercised only 3 times — it is not shown to fix the r11b navigate stall at scale, nor shown harmful.
- **clickEvidence fired 19 times, countEvidence 3 times.** 'Click the Add Element button twice': exactly **2** executed clicks in each of the 3 forced runs (countEvidence=2 in run1.5, run2.4, run3.5). Final states verified by each cell's oracle (ok=true in all three).
- **Wait storms (3+ consecutive waits): none** (longest run: 2 in run1.7, run1.10, run2.5). **Premature advance: none confirmed.**

### r8 / r9 / r11b / r12 comparison (all cloud Sonnet caller, like-for-like)
| Metric | r8 (ca73e9a) | r9 (3a82301) | r11b (3a12d32) | r12 (f39aa12) |
|---|---|---|---|---|
| Forced completion | 3/3 | 2/3 | 3/3 | **3/3** |
| Median steps/handoff | 2.00 | 1.00 | 2.00 | **2.00** |
| Handoffs max | 14 | 21 | 12 | **15** |
| Picks | 18/37 | 34/51 | 13/24 | **26/37** |
| Forced wall (median of 3) | 161.3 s | 191.4 s | 46.8 s | **75.7 s** |
| Playwright wall (median of 3) | 76.5 s | 46.6 s | 23.7 s | **34.6 s** |
| Forced cost per cell (avg) | ~0.93 | ~0.96 | 0.35 | **0.43** (phase M total 2.23) |
| no-match / low-confidence | 9 / 2 | 10 / 7 | 8 / 3 | **13 / 11** |
| Bars missed | handoffs, median-steps | completion, handoffs, picks, median-steps | handoffs, picks, median-steps | **handoffs, picks, median-steps** |
Reading: r12 fixed the mechanism it targeted (0 cap hits, 34/37 decomposed, navigate evidence exercised and benign) but the headline did not improve: handoffs 12 -> 15, picks 54% -> 70%, no-match 8 -> 13, low-confidence 3 -> 11, forced wall 46.8 -> 75.7 s. Both routes were slower this run (playwright 23.7 -> 34.6 s), so part of the wall/cost rise is environment/model-serving variance; n=3 forced cells is noisy. The shift in the dominant why-bucket (stranded `open <Page>` sub-clauses) suggests the decomposition now exposes a different failure rather than removing no-match.

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
| Page | browse_step calls | First call | acts_by_op | Rounds (stepDoneP / historyResult / countEvidence) | Independent check | Non-read browser tool use |
|---|---|---|---|---|---|---|
| /inputs | 1 | done/goal-met, steps 1 | fill:1 | r1 0.07 / - ; r2 0.76 / filled | field value = typed number | none (ToolSearch + browse_step only) |
| /dropdown | 1 | done/goal-met, steps 1 | select:1 | r1 0.06 / - ; r2 0.96 / selected: Option 2 | selected = Option 2 | none |
| /add_remove_elements/ | 1 | done/goal-met, steps 2 | click:2 | r1 0.07 ; r2 0.13 / page changed ; r3 0.92 / page changed / **countEvidence=2** | **Delete buttons = 2** (raw CDP) | none |

### Doc gaps (unchanged from r11b; INSTALL-FOR-AGENTS.md and package.json not touched since 3a12d32)
1. RC package and `--version` report **0.2.1**, not 0.3.0 (tarball is jev-browser-wingman-0.2.1.tgz).
2. `~/.jev-browser-wingman/backups/` does not exist on a fresh install; the doc says to save backups there.
3. `doctor --plan` prints the wrapped entry as bare JSON (no `type`/`env`) and does not say how to apply it with the client's own command (`claude mcp remove` then `claude mcp add -s user NAME -- jev-browser-wingman with-browser -- <C> <A...>`).
4. `doctor --plan` marks O3 [met] but `adapter-attach` only passed after `chrome ensure` (I ran it before the first `doctor`; whether plain `doctor` launches the browser itself was not tested).
5. No instructions for installing from a packed tarball ("After publish" only).
6. The caller needs an extra `ToolSearch` call to load `browse_step` under `claude -p` (deferred tools); call overhead the doc does not mention.

## Linux-only caveats
Cloud Linux/Xvfb; Chromium behind the wrapper (`--ignore-certificate-errors`, unprivileged uid, root container); win32-only skip in chrome-cmd; the Windows-only chain-e2e flake is N/A. The doctor first-run flake occurred on Linux. n=3 forced cells; both routes slower than r11b this run, so absolute wall/cost comparisons across rounds mix environment speed with code changes.

## Push-scan notes
The key-prefix string, the key value and every bound value of length >= 3 never matched in any pushed file. The 2-character bound values (digit strings) can coincide with numeric telemetry (a token count in results JSON matched once); the bare-token scan therefore excludes logs/, evidence/ and results/, and every file is scanned for them as quoted JSON strings. Raw caller transcripts (which contain bound values) were NOT pushed.
