# jev-browser-wingman 0.3.0 ("forced handoff") — Round 6 validation

Branch under test: `forced-handoff-0.3.0` @ `231256b` (descendant confirmed: `git merge-base --is-ancestor 231256b HEAD` — yes, HEAD *is* `231256b`).
Round 5 reference: `c50d955`, `bench-results/2026-09-27-r5/results.md` (branch `bench/forced-0.3.0-results-r5`).
Environment: Linux cloud container, Xvfb `:99`, `chromium-wrapper.sh` (drops to `nobody`, `--ignore-certificate-errors` for the egress-proxy TLS re-terminator) symlinked at `/usr/bin/chromium` and `/opt/google/chrome/chrome`, `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**No `src/`, `tests/`, `bench/forced-verdict.ts`, `profiles/` or fixtures were edited.** The one required temporary mutation (KB-proof) was restored via `git checkout` and the working tree confirmed clean before Part 2/3.

---

## Part 1 — full test suite: PASS

`npm ci && npm run build` → `BUILD: ok out=dist files=107`. `tsc --noEmit` → exit 0.

All 51 `tests/*.test.ts` files run individually via `node scripts/run-tests.mjs <basename>`, strictly sequential, one Chrome-launching run at a time, `ps aux | grep chrome` swept (only ever zombie/defunct residue, self-reaping within seconds — never a live leaked process) after each run.

| Result | Count |
|---|---|
| Files run | 51 |
| Files fully green | 51 |
| Individual tests | 657 |
| Passed | 656 |
| Failed | 0 |
| Skipped | 1 (`chrome-cmd` "show and hide move the real window on-screen..." — win32-only, the one acceptable non-pass) |

No file needed a re-run (no flake observed). `cli.test.ts`'s "chrome show dispatches into chrome-cmd (no-browser JSON, not the usage exit)" passed cleanly — no shared bench Chrome was up on port 9222 at that point in the sequence.

### Gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` → `LAZY-CHROME: ok listed=24 chrome=0 answered=false` (exit 0).
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` → `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (exit 1) — the known-bad correctly flips to FAIL, proving the gate discriminates.

### KB-proof (outcome-evidence, this round's required proof)

Mutated `src/core/loop.ts`'s `buildState` to map history to `{verb, label}` only (dropped `result`), built into a separate `.build/kb-proof` (never the shared scoped dist), ran `outcome-evidence` against it:

```
not ok 1 - T-repeat: fill takes effect and the chain call ends done, filling exactly once
not ok 2 - T-select: select takes effect and the chain call ends done, selecting exactly once
not ok 3 - T-check: check takes effect and the chain call ends done, checking exactly once
not ok 6 - redaction: a select result carrying a bound value is tokenized before it reaches the request
# pass 6, fail 4 (of 10)
```

**T-repeat FAILS on the mutant** (`expected done, got fallback/no-progress`) exactly as required — the mutation removes the signal the no-progress guard depends on, and the outcome-evidence tests catch it. Restored via `git checkout -- src/core/loop.ts`, `git status --short` empty, `.build/kb-proof` removed, and `dist/` rebuilt clean from the restored source before Part 2.

**Part 1 is fully green — proceeding to Part 2 and Part 3.**

---

## Part 2 — forced-handoff benchmark

Ledger before this part (7 files already in `bench/results/`, r5's own results were archived elsewhere as the task note anticipated): **$5.814594** total `total_usd` across existing files. `--phase-cap-usd 20.814594` (= history + $15) used for every call in this part, so `checkStart`'s `phaseSpentUsd >= phaseCapUsd` refusal bounds this part's *fresh* spend at exactly $15, while staying under `OPERATOR_CEILINGS.phaseUsd` (30). `--cap-usd 3.00` per run (under the $5 `runUsd` ceiling).

### Phase V — validity (playwright x3, gate off + policy off)

| # | ok | wall | usd |
|---|---|---|---|
| 1 | true | 72.2s | 0.836716 |
| 2 | true | 64.5s | 0.733361 |
| 3 | true | 69.1s | 0.716208 |

`FORCED-VERDICT` validity bar: 3/3 ≥ 2/3 required → **PASS**. Control is sound; median wall 69.1s. Spend: $2.286285.

### Phase M — measure (forced x3 + playwright x3, interleaved, gate off + policy off)

| task | route | ok | wall | usd | handoffs | picks | wingman_acts | raw_acts |
|---|---|---|---|---|---|---|---|---|
| t9 | forced | **false** | 209.9s | 1.067612 | 17 | 6 | 35 | 0 |
| t9 | playwright | true | 72.6s | 0.765401 | 0 | 0 | 0 | 17 |
| t9 | forced | true | 199.0s | 0.929623 | 17 | 14 | 49 | 0 |
| t9 | playwright | true | 72.8s | 0.760611 | 0 | 0 | 0 | 17 |
| t9 | forced | true | 220.6s | 1.030539 | 16 | 11 | 45 | 0 |
| t9 | playwright | true | 69.7s | 0.716618 | 0 | 0 | 0 | 17 |

Summary: playwright success_rate 1.00 (median wall 72.6s), forced success_rate 0.667 (median wall 209.9s, **fallback_rate 1.00** — every forced run had at least one bounce along the way). Spend: $5.270404.

**`forced-verdict` verbatim (default mode, over this Phase M file):**

```
FORCED-VERDICT: completion forced=2/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=17
FORCED-VERDICT: picks 31/50
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 1.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 2
FORCED-VERDICT: why-breakdown low-confidence=3 multi-match=2 no-match=7 no-progress=4 not-ready=22
FORCED-VERDICT: overall FAIL
```

Bars missed (4 of 9 gating checks): **completion** (2/3 trails playwright's 3/3), **handoffs** (max=17, bar is 1–4), **picks** (31/50 — bar needs `2*picks < handoffs`, i.e. picks must be a minority; 62 ≥ 50), **median-steps** (1.00, bar is ≥4). `raw-acts`, `zero-step-done`, `first-call-success`, `no-page-error-end`, `wingman-share` all pass.

### Phase S — smoke (one forced cell, gate ON)

```
FORCED-VERDICT: smoke ok=true needs_confirmation=10
```

Run: ok=true, wall=184.5s, usd=0.975174. The irreversible-action gate fired 10 times (6 `irreversible-heuristic` + 4 `irreversible-jev` in the log) and the run still completed — the gate/handoff pairing itself did not break the chain.

**Part 2 total spend: $8.531863 of the $15 cap for this part** (Phase V 2.286285 + Phase M 5.270404 + Phase S 0.975174).

### Comparison with r5

| Metric | r5 | r6 (this round) |
|---|---|---|
| Forced completion | 1/3 | **2/3** (improved) |
| Median steps/handoff | 2.00 | **1.00** (worse — further from the ≥4 bar) |
| Handoffs max | 16 | 17 (essentially unchanged) |
| Picks | 26/42 (62%) | 31/50 (62%) — unchanged rate |
| step-uncertain fraction | 30/42 (71%) | 34/50 (68%) — unchanged |
| budget-steps handoffs | 6 | **0** (fixed — this is the no-progress guard doing its job in the harness) |
| no-progress handoffs | n/a (didn't exist) | 4 |
| Forced wall | ~210–224s | 199–221s (unchanged) |
| Playwright wall (control) | ~72–82s | 69–73s (unchanged) |
| `forced-verdict` overall | FAIL | **FAIL** (still) |

**Honest read:** commit 231256b measurably fixed the *budget-steps-via-silent-repeat* failure mode inside the bench harness (0 budget-steps handoffs this round vs 6 in r5, and completion went up 1/3→2/3), which is a real improvement. But `forced-verdict` is **still an overall FAIL**, and on the metric that most directly describes "is chain mode doing multi-step work per handoff," it got *worse*, not better (median steps 1.00 vs r5's 2.00, both far under the ≥4 bar). The remaining bars that FAIL (handoffs, picks, median-steps, completion) all point at the same underlying shape: the caller is still handing off very small (median 1-step) slices very often (16–17 times per run) and needing `pick` correction on the majority of them (62%). Whatever 231256b fixed, it did not touch the size/frequency of handoffs.

### Telemetry analysis (from `bench/.home/log.jsonl`, 69 records = 50 Phase M + 19 Phase S calls; confirmed clean of the phase's own prior sessions by record count)

Round-level (`phases.rounds[]`) `action`/`actionP`/`target1`/`target1P`/`target2`/`target2P`, 209 rounds carried a target decision. Grouped by the call's `step_review.why`:

| why | rounds | median top-1 | median gap (top1−top2) |
|---|---|---|---|
| `not-ready` | 89 | 0.95 | 0.90 |
| `no-match` | 58 | 0.94 | 0.90 |
| *(none — normal commit rounds)* | 39 | 0.97 | 0.94 |
| `no-progress` | 13 | 0.92 | 0.84 |
| `low-confidence` | 6 | 0.905 | 0.85 |
| `multi-match` | 4 | 0.685 | 0.46 |

Multi-match bounces specifically (the ones you'd expect target ambiguity to explain): top-1 ≥ 0.5 in **4/4**, top-1 ≥ 0.4 in **4/4**, median gap 0.46. Across *all* 209 rounds: top-1 ≥ 0.5 in 206/209, top-1 ≥ 0.4 in 209/209, median gap 0.90.

**The headline finding for tuning:** target-probability confidence is *not* the bottleneck for the two largest bounce buckets. `not-ready` (89/209 rounds, and 22/50 handoffs at the call level) and `no-match` (58/209 rounds, 7/50 handoffs) both carry very high top-1 target confidence (median 0.94–0.95) — essentially indistinguishable from normal commit rounds (median 0.97). Only the tiny `multi-match` bucket (4 rounds total) shows the low-confidence/small-gap signature you'd tune a target-probability threshold against. This means: **raising or lowering the target-probability margin floor will not move the `not-ready`/`no-match` bounce rate**, because those bounces aren't failing on target identification at all — they're failing on a different gate (readiness / step-matching), and the router already knows exactly which element it means when it bounces for those reasons.

Handoff endings: **0 budget-steps**, **5 no-progress** (4 in Phase M, 1 in Phase S) — down from r5's 6 budget-steps / 0 no-progress. The reclassification is real, but see Part 3 below for a case where it did *not* fire and 24x-repeat still happened.

Redaction/secret checks on this phase's artifacts: `apikey_` and the literal `TYPESAFE_API_KEY` value: absent from `log.jsonl` and every `bench/results/*.json` (checked by grep, key never printed). The t9 bound values (`77`, `wingman@example.com`) are **absent from `log.jsonl` and the results JSONs** — they appear only in the bench harness's own `bench/.home/transcript-*.ndjson` files (the calling LLM's own tool-call arguments, expected since the caller must supply them to invoke `browse_step`), which are **excluded from this push**.

---

## Part 3 — fresh-install check

**Result: 0 of 3 tasks used `browse_step` and succeeded on the first call.** This is the bar the task set, and it was missed on every single page. Below is what actually happened, with root causes identified in the source (report only — nothing was changed).

### Finding 1 (root cause, most important): the published npm package cannot enforce forced handoff at all

`package.json`'s `files` allow-list is:

```json
["dist/src", "fixtures/pages", "skills/jev-browser-wingman", "INSTALL-FOR-AGENTS.md", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"]
```

**The top-level `profiles/` directory is not in it.** `loadProfiles()` (`src/core/profiles.ts`) reads shipped profiles from `<packageRoot>/profiles`; a real `npm pack` + `npm install -g` (exactly what INSTALL-FOR-AGENTS.md's first install path, and what this task specified, produces) ships **zero shipped profiles**. Reproduced directly:

```
$ npm pack --pack-destination ... && npm install -g ./jev-browser-wingman-0.2.1.tgz
$ ls $(npm root -g)/jev-browser-wingman/profiles
ls: cannot access '.../profiles': No such file or directory
```

Consequence, live: registering the exact command INSTALL-FOR-AGENTS.md itself gives as the canonical Playwright MCP example (`npx -y @playwright/mcp@0.0.80 --browser chrome`) and running `doctor --detect` classifies it `"kind":"other"` (should be `"playwright-mcp"`), and `doctor --plan`'s O2 step then says `hint: no browsing-tool registration was found to wrap or deny` instead of offering the wrap. **An installing agent following INSTALL-FOR-AGENTS.md verbatim via the documented `npm install -g` path cannot reach forced handoff at all** — `doctor` never tells it what to do, because the profile data it needs to recognize *any* browsing tool never shipped. (`npm link` from a source checkout does not hit this, because the whole repo — profiles included — is symlinked; that is presumably why INSTALL-FOR-AGENTS.md's own "What was tested" row for this scenario passed before.)

I copied `profiles/` into the globally-installed package by hand (not into the repo) purely so the rest of Part 3 could proceed; this is **not a fix**, it's a workaround for testing, and it does not exist for a real user.

With the workaround in place, `doctor --detect` correctly reports `"kind":"playwright-mcp"`, `doctor --plan` correctly offers the wrap step, and after applying O1 (register wingman) + O2 (wrap playwright) + `chrome ensure`, `doctor --json` returns:

```json
{"verdict":"PASS", ..., "checks":[..., {"id":"handoff","status":"PASS","detail":"enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll"}, ...]}
```

— confirming the wrap/withhold mechanism itself is sound once the profile data exists; the packaging list is the actual defect.

### Finding 2 (root cause, code-cited): the no-progress guard has no signal for `navigate`, so a stuck navigate can still repeat 24x — reproducing r5's headline defect

`outcomeSignal()` (`src/core/loop.ts`):

```ts
function outcomeSignal(verb: Op, el: ElementRecord | undefined, obs: Observation): string | undefined {
  if (ELEMENT_STATE_VERBS.has(verb) && el) return elementStateSignal(verb, el);
  if (el) return pageSignal(obs, el); // click-family: cheap page-level signal
  return undefined; // targetless / binding-only verb: no signal, no guard, no result
}
```

`navigate` is targetless (no `el` — it acts on a URL binding, not an enumerated element), so it falls straight to the `undefined` branch: **no `before`/`result` pair is ever recorded for a navigate act, so `isNoProgress` can never fire on a repeated navigate.** This reproduces live, on task 3 (`/add_remove_elements/`):

```
{'tool': 'browse_step', 'status': 'fallback', 'reason': 'step-uncertain', 'steps': 0, 'acts_by_op': {'wait': 2}}
{'tool': 'browse_step', 'status': 'fallback', 'reason': 'budget-steps', 'steps': 24, 'acts_by_op': {'navigate': 24}}
```

24 identical `navigate` acts, `budget-steps` — not `no-progress` — exactly r5's "single-element pages repeating the same act 24x without done," and exactly the shape the no-progress guard was built to catch, except this verb was never wired into it. All **three** fresh-install tasks' *first* `browse_step` call bounced at the same place — `"step": "Navigate to <value:url>"`, `why: "not-ready"` — before ever reaching the task's actual verb (type/select/click).

### Finding 3: a second, distinct stall — click-family progress that never gets graded "step done"

Task 3's second `browse_step` call, after re-establishing the page, clicked "Add Element" 24 times (`acts_by_op: {click: 24}`) and still ended `budget-steps` with `steps_done: 0` of 2. This is *not* the no-progress guard failing to fire — the 2026-09-28 click-family signal widening (url+title+text-hash+element-count) is designed to *not* flag this case as no-progress, because each click genuinely changes the page (adds a Delete button) — and it didn't. The defect here is different: the chain's step-completion grading never marked the "click Add Element" clause as done despite repeated real clicks, so the cursor stayed at `step_index: 1` of 2 for the full 24-round budget. Distinguishing this from Finding 2 matters for the operator: Finding 2 needs a `navigate` outcome signal; this one needs a look at why a genuinely-progressing click-family step never grades `step_done`.

### Finding 4: the "script" capability class is always retained by the caller, and it becomes the actual bypass

Per INSTALL-FOR-AGENTS.md's own "Handoff mode" section, the classes always left with the caller (never withheld, in forced or optional mode) include `script`. On tasks 1 and 3, once `browse_step` bounced/exhausted budget, the calling model used `mcp__playwright__browser_run_code_unsafe` / `mcp__playwright__browser_evaluate` — both mapped to the `script` class — to directly `page.fill()` / `element.click()` past the withheld tools and complete the goal without wingman:

- Task 1 (`/inputs`, "type 42"): `browse_step` bounced once (`fallback/step-uncertain`, `why: not-ready`, 2 waits), then the caller ran `browser_run_code_unsafe` with `page.goto(...); page.fill('input[type="number"]', '42')` — goal achieved, **entirely outside forced handoff**.
- Task 3 (`/add_remove_elements/`): after both budget-exhausted `browse_step` calls above, the caller ran `browser_evaluate` to click the buttons via `document.querySelectorAll(...)` directly.
- Task 2 (`/dropdown`, "Choose Option 2") is the one case that *didn't* escape: `browse_step` bounced once (`step-uncertain`/`not-ready`, 5 navigate + 5 wait acts), the caller checked with `browser_snapshot` (a `read`-class tool, harmless), retried `browse_step` once with a malformed `pick` (`error/invalid-input`, no spend), then a third, correctly-shaped call succeeded (`done/goal-met`, 1 step). So task 2 needed **3** `browse_step` calls, not the required 1, but never left forced handoff.

**Taken together, this is the real story of "forced" handoff under real-world conditions**: it bounces on the very first step (navigation) far more often than not (3/3 in this sample), and when it does, the caller has a standing, documented, always-available escape hatch (`script`) that lets it finish the task with zero further wingman involvement whenever it's motivated to use it — which, empirically, is exactly when wingman is struggling most (budget exhausted, repeated bounces). "Forced" handoff's actual guarantee is only as strong as the caller's willingness not to reach for `browser_evaluate`.

### Per-task detail

| Task | First `browse_step` result | Total `browse_step` calls | Bypassed via script? | Goal achieved? |
|---|---|---|---|---|
| `/inputs` — type 42 | `fallback/step-uncertain` (`not-ready`) | 1 | **yes** | yes (via script) |
| `/dropdown` — Choose Option 2 | `fallback/step-uncertain` (`not-ready`) | 3 | no | yes (via wingman, 3rd call) |
| `/add_remove_elements/` — click Add Element x2 | `fallback/step-uncertain` (`not-ready`) | 2 (both `budget-steps`, 24 acts each) | **yes** | yes (via script) |

Final `doctor --json` (after the manual profiles workaround, `chrome ensure`, and the full O1/O2 setup): `"verdict":"PASS"`, all 10 checks PASS including `handoff` (enforced by proxy) and `jev-round`.

Cost: $0.1791812 + $0.1813980 + $0.3643340 (Claude Code CLI `total_cost_usd`) = **$0.725** LLM spend, plus negligible TypeSafe spend (well under the $4 cap for this part).

### Doc gaps found

1. **`INSTALL-FOR-AGENTS.md`'s own canonical Playwright MCP example (`npx -y @playwright/mcp@0.0.80 --browser chrome`) is not recognized by `doctor --detect` on a real `npm install -g`** because the shipped `profiles/` directory that would recognize it isn't packaged (Finding 1). This is the single highest-priority fix for this release: forced handoff is unreachable from the documented install path.
2. `INSTALL-FOR-AGENTS.md` doesn't mention that `doctor --plan`'s registration path targets `~/.claude.json` (the *global*, not project-scoped, Claude Code config) — worth a line so an installing agent knows it's editing shared user state, not a project file.
3. No guidance in INSTALL-FOR-AGENTS.md warns that `browse_step`'s first clause commonly being "Navigate to `<url>`" is a known-fragile step (Findings 2/3) — an installing agent has no way to anticipate that its first-ever call is disproportionately likely to bounce.

### Linux-only caveats

- `chrome-cmd`'s window-position test (`show`/`hide` via `Browser.setWindowBounds` + `GetWindowRect`) is win32-only and was correctly SKIPped, not run, on this Linux container.
- The `--ignore-certificate-errors` flag added by `chromium-wrapper.sh` is required only because this cloud container's egress proxy re-terminates TLS with a CA the Chrome Root Store doesn't trust (documented in the wrapper's own header comment) — not something a real end-user Linux/Mac/Windows install needs.
- All Chrome launches in this container ran headed-off-screen/headless under Xvfb `:99`; no windowed-Chrome-specific behavior (`window: "normal"`) was exercised.

---

## Cleanup

- `jev-browser-wingman chrome stop` run for both the bench browser (port 9344) and the Part 3 fresh-install browser (port 9222); `ps aux | grep chrome` empty after each.
- Xvfb `:99` stopped.
- `/tmp/wingman-fresh-install-r6`, `/tmp/wingman-fresh-project` scratch directories removed after this report was written.
- `bench/results/2026-09-27-*.json` (this round's Phase V/M/S files) are **not** committed to `forced-handoff-0.3.0` or `main` — copied into `bench-results/2026-09-28-r6/results/` on this results-only branch instead, per the task's branch-isolation rule.
