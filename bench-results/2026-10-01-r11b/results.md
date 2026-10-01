# r11b validation — jev-browser-wingman 0.3.0 "forced handoff" (HEAD 3a12d32)

Code under test: `forced-handoff-0.3.0` @ 3a12d32 (r11 commits fc70aba, 1c5105d, 4788e02 + ceiling lift 408bd54 + bench-cap test fix 3a12d32).
Environment: cloud Linux container, Xvfb :99, bench/cloud/chromium-wrapper.sh as /usr/bin/chromium and /opt/google/chrome/chrome, REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome. Caller model: Sonnet (cloud) — like-for-like with r8/r9, NOT with r10.
No src/, tests/, bench thresholds, profiles/ or fixtures were edited (only the sanctioned temporary KB flip, restored; `git status` clean of tracked changes).
Total new spend: Part 2 USD 2.7525 (cap 15) + Part 3 ~USD 0.19 (cap 4).

## Part 1 — full suite: GREEN
`npm ci && npm run build` ok (107 files); `tsc --noEmit` exit 0. 51/51 files, one per invocation, sequential: **709 tests, 708 pass, 0 fail, 1 skip** (chrome-cmd win32-only, the permitted one). bench-cap now green (3a12d32 fix). chain-e2e 8/8 on Linux. No file needed a rerun. No live Chrome after any file. Per-file counts: part1/logs/runner-summary.txt.

| file | result | file | result | file | result |
|---|---|---|---|---|---|
| acquire | 6/6 | doctor | 26/26 | policy | 21/21 |
| adapter-cdp | 8/8 | egress | 6/6 | profiles | 16/16 |
| adapter-playwright | 7/7 | ephemeral-sweep | 7/7 | questions | 25/25 |
| bench-browse | 26/26 | gate | 9/9 | readme-bench | 4/4 |
| bench-cap | 8/8 | jev-client | 6/6 | registrations | 9/9 |
| bench-oracle | 2/2 | log | 3/3 | runner-sweep | 2/2 |
| bounce-escalation | 8/8 | loop | 36/36 | runner-sweep-leak | 1/1 |
| boundary | 19/19 | mcp-server | 14/14 | scaffold | 16/16 |
| browse-step-surface | 7/7 | outcome-evidence | all pass | settle | 4/4 |
| cdp-connection | 3/3 | page-scripts | 15/15 | setup-plan | 5/5 |
| chain | 52/52 | pick / pick-e2e | 20/20, 2/2 | takeover / takeover-config | 37/37, 10/10 |
| chain-e2e | 8/8 | plugin | 4/4 | tokens / typesafe-stub | 5/5, 2/2 |
| chrome | 28/28 | conformance / -ops | 28/28, 39/39 | with-chrome / -forced | 32/32, 3/3 |
| chrome-cmd | 7/8 + 1 skip | contract / config / cli / classify-tools / doc-safety | all pass | withhold | 8/8 |

Gates: `lazy-chrome` → `LAZY-CHROME: ok listed=24 chrome=0 answered=false`; `--known-bad tool-call` → `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`.

**KB proof (splitCompoundClause → [clause])**: used the documented flag form (`const KB_M1: boolean = Boolean(process.env.KB_M1_OFF === undefined); if (KB_M1) return [clause];`), built to .build/kb-m1, chain run: 52 tests, 45 pass, **7 FAIL — exactly the expected set**: splitCompoundClause boundary table, expandClauses cap test, T-decompose-order / -progress / -resume / -twice / -premature. Restored via `git checkout -- src/core/loop.ts`, `git status` clean.

## Part 2 — forced-handoff benchmark (t9-long-chain): forced-verdict **FAIL (3 bars missed)**
Ledger before: 5.814594 USD → `--phase-cap-usd 20.814594` (history + 15), `--cap-usd 3.00`.
Note: `--purpose` accepts only cap-proof|measure|experiment; Phase S was run with `--purpose measure` (the first attempt with `smoke` was refused before any spend).

### Phase V (playwright x3, gate off, policy off): 3/3, total USD 0.7377
V1 ok 34.9 s, V2 ok 22.6 s, V3 ok 21.3 s. Control >= 2/3 → proceed.

### Phase M (forced x3 + playwright x3 interleaved, gate off, policy off, measure): total USD 1.8017
| # | route | ok | wall s | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 42.9 | 0.344571 | 6 | 1 | 18 | 0 | 0 |
| 2 | playwright | true | 23.6 | 0.177938 | 0 | 0 | 0 | 16 | 0 |
| 3 | forced | true | 46.8 | 0.270415 | 6 | 3 | 18 | 0 | 0 |
| 4 | playwright | true | 38.5 | 0.397811 | 0 | 0 | 0 | 17 | 0 |
| 5 | forced | true | 78.9 | 0.440795 | 12 | 9 | 26 | 0 | 0 |
| 6 | playwright | true | 23.7 | 0.170159 | 0 | 0 | 0 | 16 | 0 |

FORCED-VERDICT (verbatim, Phase M):
```
FORCED-VERDICT: completion forced=3/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=12
FORCED-VERDICT: picks 13/24
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 2.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=3 no-match=8 no-progress=2 wrong-page=4
FORCED-VERDICT: overall FAIL
```
Bars missed (from bench/forced-verdict.ts, thresholds untouched): **handoffs** (every forced run must hand off 1..4 times; max=12, runs had 6/6/12), **picks** (needs 2*picks < handoffs; 13/24), **median-steps** (needs >= 4; 2.00). Passed: completion, wingman-share, raw-acts, zero-step-done, first-call-success, no-page-error-end, raw-script.

### Phase S (forced x1, gate ON, policy off): ok=false, USD 0.2131
wall 36.1 s, 5 handoffs, 2 picks, 6 wingman acts, 0 raw. `FORCED-VERDICT: smoke ok=false needs_confirmation=1` — the run ended on `needs_confirmation`/`irreversible-heuristic` (gate converts the action to a confirmation, no silent bypass).

### Per-handoff detail, Phase M forced runs (run.call; run1 = cell 1, run2 = cell 3, run3 = cell 5)
| run.call | status/reason | why | steps | progress done/total | acts_by_op | split? |
|---|---|---|---|---|---|---|
| 1.1 | fallback/step-uncertain | no-match | 2 | 1/7 | {'click': 1, 'check': 1} | over-cap, UNSPLIT |
| 1.2 | fallback/step-uncertain | no-match | 1 | 0/7 | {'navigate': 1} | over-cap, UNSPLIT |
| 1.3 | fallback/step-uncertain | wrong-page | 1 | 1/6 | {'select': 1} | over-cap, UNSPLIT |
| 1.4 | fallback/no-progress | no-progress | 6 | 3/7 | {'navigate': 2, 'click': 2, 'fill': 2} | decomposed 7->8 |
| 1.5 | error/page-error | - | 3 | 2/7 | {'navigate': 1, 'fill': 1, 'click': 1} | decomposed 7->8 |
| 1.6 | done/goal-met | - | 5 | 5/5 | {'navigate': 2, 'click': 3} | no compound |
| 2.1 | fallback/step-uncertain | low-confidence | 2 | 1/7 | {'click': 1, 'check': 1} | over-cap, UNSPLIT |
| 2.2 | fallback/step-uncertain | wrong-page | 0 | 0/6 | None | over-cap, UNSPLIT |
| 2.3 | fallback/step-uncertain | wrong-page | 0 | 0/6 | None | over-cap, UNSPLIT |
| 2.4 | fallback/no-progress | no-progress | 8 | 2/6 | {'navigate': 3, 'select': 1, 'click': 2, 'fill': 2} | over-cap, UNSPLIT |
| 2.5 | error/page-error | - | 3 | 1/3 | {'navigate': 1, 'fill': 1, 'click': 1} | decomposed 3->8 |
| 2.6 | done/goal-met | - | 5 | 2/2 | {'navigate': 2, 'click': 3} | decomposed 2->5 |
| 3.1 | fallback/step-uncertain | no-match | 2 | 1/7 | {'click': 1, 'check': 1} | over-cap, UNSPLIT |
| 3.2 | fallback/step-uncertain | no-match | 0 | 0/7 | None | over-cap, UNSPLIT |
| 3.3 | error/act-failed | - | 1 | 0/7 | {'back': 1} | over-cap, UNSPLIT |
| 3.4 | fallback/step-uncertain | no-match | 2 | 1/6 | {'click': 1, 'select': 1} | over-cap, UNSPLIT |
| 3.5 | fallback/step-uncertain | no-match | 4 | 1/5 | {'navigate': 1, 'click': 3} | decomposed 5->12 |
| 3.6 | fallback/step-uncertain | low-confidence | 2 | 0/4 | {'navigate': 1, 'click': 1} | decomposed 4->10 |
| 3.7 | fallback/step-uncertain | no-match | 1 | 1/4 | {'fill': 1} | decomposed 4->9 |
| 3.8 | fallback/step-uncertain | no-match | 3 | 0/3 | {'navigate': 1, 'click': 1, 'fill': 1} | decomposed 3->8 |
| 3.9 | error/page-error | - | 1 | 0/3 | {'click': 1} | decomposed 3->6 |
| 3.10 | fallback/step-uncertain | low-confidence | 4 | 1/2 | {'navigate': 1, 'click': 3} | decomposed 2->5 |
| 3.11 | fallback/step-uncertain | wrong-page | 4 | 0/1 | {'navigate': 1, 'click': 3} | decomposed 1->2 |
| 3.12 | done/goal-met | - | 2 | 1/1 | {'navigate': 1, 'click': 1} | no compound |
(`progress.steps_total` is in the CALLER's clause numbering by design, so it cannot show decomposition; the "split?" column was computed by running the shipped `expandClauses` on each call's recorded `steps`.)

### Telemetry (from the forced runs' wingman log; per-round detail in evidence/telemetry-per-round.txt)

**Decomposition.** 24 forced-run `browse_step` calls: **11 decomposed** (caller steps -> sub-clauses: 7->8, 7->8, 3->8, 2->5, 5->12, 4->10, 4->9, 3->8, 3->6, 2->5, 1->2; step_text then shows the single operative sub-clause, e.g. `open Add/Remove Elements` then `click the Add Element button twice`), **11 hit the >12-expanded-steps cap and fell back to the UNSPLIT list** (every first call of each run — 7 caller steps with 16 expanded — plus run1.2/1.3, run2.2-2.4, run3.2-3.4; step_text there is still the whole compound clause, e.g. `open the web address named dropdown_url, then choose Option 1 in the dropdown`, where the unconditional `then` split never ran), 2 had no compound clause.
This is the main finding of the round: the **12-step cap defeats decomposition on exactly the long first-pass chains** the decomposition was meant to help. Confirmed arithmetically with the shipped function (evidence/expandClauses-per-call.json); the causal link to the outcomes below is a hypothesis.

**no-match.** 8 of 17 why-labelled handoffs (47%) vs r10 20/38 (53%), r9 10 (24% of its buckets), r8 9 (31%). By split state: **5 of 8 in over-cap/unsplit calls**, 3 in decomposed calls. The unsplit ones show Jev asked a whole compound clause with `target1=none` (0.89-0.96) — e.g. `open Dropdown and choose Option 1` -> click, target none (run1.1, run3.1); `open Add/Remove Elements and click the Add Element button twice` -> click, target none (run3.4). In decomposed calls the no-matches are `open Inputs` (click, target none 1.0), `open Forgot Password` (click, target none 0.95) and `enter the value named email into the E-mail field` (fill e2 0.67).
**not-ready: 0** (r9: 17, r8: 12) — the not-ready bucket disappeared.

**Evidence firings.** clickEvidence fired 16 times across 8 calls (each time on a landed click-family step; 7 of them on an `element gone` result, confirming change (2)); countEvidence fired 2 times (run2.4 and run3.5, each value 2; see telemetry-per-round.txt section C).
**'Click the Add Element button twice' clicks per run:** run1: 2 (acts_by_op click:2 in call 1.4; the first of the two landed during the preceding `open the web address named add_url` clause — Jev acted on the click before the clause advanced, so the click was executed under the wrong clause but the count was right; no countEvidence needed since the caller had split it as count-less + twice clauses), run2: exactly 2 (countEvidence=2), run3: exactly 2 (countEvidence=2). The final end state was verified by each cell's oracle (ok=true for all three forced cells).
**Premature advance:** none confirmed. One suspect (hypothesis, not proven): run3.11 `open Status Codes` advanced on clickEvidence (hist `element gone`) and the call then ended `wrong-page` on `open the 404 link`.
**Wait storms (3+ consecutive wait rounds):** none; the longest run is 2 (run3.6 `open Inputs`: wait, wait -> ended `low-confidence`). The r10 click-Start -> element gone -> wait storm did not recur: `click the Start button` -> one wait round with clickEvidence=True, then advance (runs 1, 2, 3).

**Why buckets — every occurrence (step_text of the last round -> decided action):** full table in evidence/why-buckets.txt. Summary:
- **no-match (8)** — largest bucket, 5 in over-cap calls; actions: click (6), fill (1), check (1).
- **wrong-page (4)** — navigate x3 (`open the web address named add_url and click…`, `…dropdown_url, then choose…`, `open the 404 link`), select x1 (`open Dropdown and choose Option 1`).
- **low-confidence (3)** — back x2, wait x1 (`open Dropdown and choose Option 1`, `open Status Codes`, `open Inputs`).
- **no-progress (2)** — fill x2 on the inputs step (stepDoneP 0.64/0.70).
- **not-ready (0)**, **repeat (0)**.
Largest target for the next fix: no-match, and the unsplit over-cap calls that cause most of it.

### r8 – r11 comparison
| Metric | r8 (ca73e9a) | r9 (3a82301) | r10 (1925183) — **different caller model (SWE-2 via local proxy, Windows), not like-for-like** | r11 (3a12d32, this run) |
|---|---|---|---|---|
| Forced completion | 3/3 | 2/3 | 2/3 | **3/3** |
| Median steps/handoff | 2.00 | 1.00 | 2.00 | **2.00** |
| Handoffs max | 14 | 21 | 25 | **12** |
| Picks | 18/37 | 34/51 | 33/47 | **13/24** |
| Forced wall (median of 3) | 161.3 s | 191.4 s | n/a (not recorded in r10 notes) | **46.8 s** |
| Playwright wall (median of 3) | 76.5 s | 46.6 s | n/a | **23.7 s** |
| Forced cost per cell | ~0.9 USD avg (phase M total 8.33) | ~0.96 avg (8.61) | 1.01 / 1.51 / 1.09 (phase 9.64 incl. playwright) | **0.34 avg (phase M total 1.80)** |
| no-match share of why | 9 (31%) | 10 (24%) | 20/38 (53%) | **8/17** |
| Bars missed | handoffs, median-steps | completion, handoffs, picks, median-steps | completion, handoffs, picks, median-steps | **handoffs, picks, median-steps** |

Caveats on the comparison: this run is much cheaper/faster than r8/r9 across BOTH routes (playwright 23.7 s vs 46.6-76.5 s), so a good part of the wall/cost change is the environment/model-serving speed that day, not r11 code. Forced completion 3/3, handoffs max 12 and picks 13/24 are the best of the four, but still fail the bars.

## Part 3 — fresh-install check: PASS (3/3 first-call success), USD ~0.19
- `npm pack` (jev-browser-wingman-0.2.1.tgz, 122 files) + `npm install -g --prefix <scratch>`; installed package contains `profiles/{playwright-mcp,chrome-devtools-mcp}.json`.
- Registered with Claude Code (`claude mcp add -s user`) playwright (`@playwright/mcp@0.0.80 --browser chrome`) + `jev-browser-wingman mcp`; `doctor --detect` classified playwright as `playwright-mcp`/`launch`; `doctor --plan` showed O1 todo (mode on), O2 todo (wrap with with-browser), O3/O4 met. Followed exactly (backup of the entry, `{"mode":"on"}`, `claude mcp remove`/`add` wrapped entry `jev-browser-wingman with-browser -- npx -y @playwright/mcp@0.0.80 --browser chrome`), then `chrome ensure`.
- Final `doctor` output (verdict PASS, exit 0; evidence/part3/doctor-final.txt, doctor-json.json):
```
PASS key-present  source=env
PASS config-loaded  config loaded; gate: off (optional toggle; set gate.mode "confirm" to require confirmation of irreversible actions)
PASS registration-portable  2 registration(s) portable
PASS policy-loaded  policy lists load and the self-test host classifies sensitive-identity
PASS profile-safe  the Chrome answering on port 9222 uses profile_dir
PASS adapter-attach  attached to http://127.0.0.1:9222; 1 page(s)
PASS default-context  attach stayed in the default context; cookies=5
PASS coexistence  observer fingerprint identical across attach/detach (1 page(s))
PASS handoff  enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll, script
PASS jev-round  runCheck answered with 1 jev call(s)
verdict: PASS
```
- ~/.claude.json backed up before and restored byte-for-byte (cmp identical); ~/.jev-browser-wingman (absent at start) removed.

| Page | Prompt | browse_step calls | First call | acts_by_op | Rounds (stepDoneP / historyResult / countEvidence) | Independent check | Non-read browser tool use |
|---|---|---|---|---|---|---|---|
| /inputs | type the number into the number field | 1 | done/goal-met, steps 1 | fill:1 | r1 0.06 / - ; r2 0.79 / filled | input value = typed number | none (only ToolSearch + browse_step) |
| /dropdown | choose Option 2 | 1 | done/goal-met, steps 1 | select:1 | r1 0.06 / - ; r2 0.94 / selected: Option 2 | selected = Option 2 | none |
| /add_remove_elements/ | open nothing else; click Add Element twice | 1 | done/goal-met, steps 2 | click:2 | r1 0.06 / - ; r2 0.11 / page changed ; r3 0.93 / page changed / **countEvidence=2** | **Delete buttons = 2** | none |
The caller passed the count inside one step ("click the Add Element button twice"), as the install doc instructs; the over-action defect of r6-r9 did not recur and the repeat/count evidence ended it after exactly 2 clicks.

### Doc gaps / findings (Part 3)
1. **Version string:** the RC package and `jev-browser-wingman --version` report **0.2.1**, not 0.3.0 — the release candidate has not had its version bumped (tarball name `jev-browser-wingman-0.2.1.tgz`).
2. INSTALL-FOR-AGENTS.md says to save backups to `~/.jev-browser-wingman/backups/` but the directory does not exist on a fresh install; the agent has to create it.
3. `doctor --plan` prints the replacement entry as a bare JSON object (no `type`/`env`) and never says how to apply it with the client's own command (`claude mcp remove` then `claude mcp add -s user NAME -- jev-browser-wingman with-browser -- <C> <A...>`); the agent had to infer that, and the `--` quoting is easy to get wrong.
4. `doctor --plan` marks O3 as [met] ("no separate step needed") but `adapter-attach` only passes after the browser is running (`chrome ensure`); the doc mentions this only in the Verify table, not in the plan. (I ran `chrome ensure` before the first `doctor`; I did not test whether plain `doctor` would launch the browser itself.)
5. The doc's "Install the command" section says "After publish" — no instructions for installing from a packed tarball (what was actually done here).
6. The caller needed an extra `ToolSearch` call to load `browse_step` (deferred-tool behaviour of `claude -p`); not a defect, but it is call overhead the doc does not mention.
7. Cloud-container specifics (not product docs): root + egress-proxy CA required the bench chromium-wrapper; the `/opt/google/chrome/chrome` symlink is needed for Playwright's `--browser chrome`.

## Linux-only caveats
Cloud Linux/Xvfb, Chromium behind the wrapper (`--ignore-certificate-errors`, unprivileged uid); r10 was Windows + a different caller model, so r10 is not like-for-like; win32-only skip in chrome-cmd; Windows-only chain-e2e about:blank flake not applicable. Playwright wall times in this environment (21-39 s) are well below earlier rounds, so absolute wall/cost comparisons across rounds mix environment speed with code changes. n=3 forced cells — noisy.

## Notes on the push scans
The TypeSafe key prefix string and the TYPESAFE_API_KEY value never matched. Bound values from bench/tasks.json: values of length >= 3 never matched in any pushed file; the two 2-character values (digit strings) cannot be scanned meaningfully in numeric telemetry (e.g. `actMs`, element ids `e<n>`), so the bare-token scan excluded evidence/ and part1/logs (unit-test TAP output), while every file was scanned for them as quoted JSON strings. Raw caller transcripts (which contain the bound values) were NOT pushed; only wingman log records (already value-redacted by the product), results JSONs and analysis text were.
Local, unpushed: bench/results/2026-10-01-07{27,32,33}.json remain untracked in the working tree (ledger inputs; copies pushed as results/phase-{v,m,s}.json).
