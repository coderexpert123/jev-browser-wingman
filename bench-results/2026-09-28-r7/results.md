# jev-browser-wingman 0.3.0 ("forced handoff") — Round 7 validation

Branch under test: `forced-handoff-0.3.0` @ `2a05d34` (HEAD exactly; a descendant
of `main` confirmed via `git fetch origin && git checkout forced-handoff-0.3.0`,
`git rev-parse HEAD` = `2a05d344305e972751fd5bc7d170d9b54fed7a73`).

Round 6 reference: `231256b`, `bench-results/2026-09-28-r6/results.md` (branch
`bench/forced-0.3.0-results-r6`). Round 6 had a green test suite but the forced
benchmark FAILED: forced 2/3 vs playwright 3/3, median 1 step/handoff, handoffs
max 17, picks 31/50, why-breakdown not-ready=22 no-match=7 no-progress=4
low-confidence=3 multi-match=2.

Environment: cloud Linux container, Xvfb `:99`, `bench/cloud/chromium-wrapper.sh`
installed at `/usr/local/bin/chromium-wrapper.sh`, symlinked from
`/usr/bin/chromium` and `/opt/google/chrome/chrome`, `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**No `src/`, `tests/`, `bench/forced-verdict.ts` thresholds, `profiles/` or
fixtures were edited outside the three sanctioned, temporary KB-proof flips in
Part 1.** Each was restored via `git checkout` and `git status --short` confirmed
clean immediately after, before moving on. Final `git status --short` for the
whole repo at the end of Part 1: empty.

**Operator note on 2a05d34's own commit metadata:** the commit under test is
authored/co-authored under the same GitHub identity and email
(`hrishi1990@gmail.com`, `coderexpert123`) that this validation session's user
context also carries. This is disclosed for transparency; it did not change how
this validation was run — every gate, test and KB-proof below was executed and
judged the same as any other candidate commit, and no result was softened or
skipped on that basis.

---

## Part 1 — full test suite: PASS

`npm ci && npm run build` → `BUILD: ok out=dist files=107`. `npx tsc --noEmit`
→ exit 0.

All 51 `tests/*.test.ts` files run individually via
`node scripts/run-tests.mjs <basename>`, strictly sequential, one
Chrome-launching run at a time. After every run, `ps aux | grep -i chrome` was
checked; the only residue ever seen was self-reaping `<defunct>` zombie chrome
processes (confirmed gone on the very next check, consistent with the CLAUDE.md
note that this is expected and not a leak) — no live leaked chrome process was
ever left running between files.

| # | file | result | # | file | result |
|---|------|--------|---|------|--------|
| 1 | acquire | pass 6/6 | 27 | log | pass 3/3 |
| 2 | adapter-cdp | pass 8/8 | 28 | loop | pass 36/36 |
| 3 | adapter-playwright | pass 7/7 | 29 | mcp-server | pass 14/14 |
| 4 | bench-browse | pass 26/26 | 30 | outcome-evidence | pass 11/11 |
| 5 | bench-cap | pass 8/8 | 31 | page-scripts | pass 15/15 |
| 6 | bench-oracle | pass 2/2 | 32 | pick | pass 20/20 |
| 7 | bounce-escalation | pass 8/8 | 33 | pick-e2e | pass 2/2 |
| 8 | boundary | pass 19/19 | 34 | plugin | pass 4/4 |
| 9 | browse-step-surface | pass 7/7 | 35 | policy | pass 21/21 |
| 10 | cdp-connection | pass 3/3 | 36 | profiles | pass 16/16 |
| 11 | chain | pass 44/44 | 37 | questions | pass 25/25 |
| 12 | chain-e2e | pass 8/8 | 38 | readme-bench | pass 4/4 |
| 13 | chrome | pass 28/28 | 39 | registrations | pass 9/9 |
| 14 | chrome-cmd | pass 7/8, skip 1 | 40 | runner-sweep | pass 2/2 |
| 15 | classify-tools | pass 7/7 | 41 | runner-sweep-leak | pass 1/1 |
| 16 | cli | pass 6/6 | 42 | scaffold | pass 16/16 |
| 17 | config | pass 30/30 | 43 | settle | pass 4/4 |
| 18 | conformance | pass 28/28 | 44 | setup-plan | pass 5/5 |
| 19 | conformance-ops | pass 39/39 | 45 | takeover | pass 37/37 |
| 20 | contract | pass 15/15 | 46 | takeover-config | pass 10/10 |
| 21 | doc-safety | pass 4/4 | 47 | tokens | pass 5/5 |
| 22 | doctor | pass 26/26 | 48 | typesafe-stub | pass 2/2 |
| 23 | egress | pass 6/6 | 49 | with-chrome | pass 29/29 |
| 24 | ephemeral-sweep | pass 7/7 | 50 | with-chrome-forced | pass 3/3 |
| 25 | gate | pass 9/9 | 51 | withhold | pass 8/8 |
| 26 | jev-client | pass 6/6 | | | |

**Aggregate: 51/51 files fully green. Individual tests: 667 total, 666 pass, 0
fail, 1 skip.** The one skip is `chrome-cmd`'s "show and hide move the real
window on-screen and back off-screen (GetWindowRect)" — `# SKIP win32 only`,
the one acceptable non-pass per the task brief. No file needed a re-run; no
failures were observed on the first pass of any file, so the "re-run failing
files once" step did not apply.

`cli.test.ts`'s "chrome show dispatches into chrome-cmd (no-browser JSON, not
the usage exit)" passed cleanly (no shared bench Chrome was up on port 9222 at
that point in the sequence).

### Gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` → `LAZY-CHROME: ok listed=24
  chrome=0 answered=false` (exit 0) — as expected.
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` →
  `LAZY-CHROME: FAIL listed=24 chrome=11 answered=true` (exit 1) — the
  known-bad injection is correctly caught (the `chrome=11` count differs
  trivially from r6's `chrome=10`; the gate's pass/fail discrimination is what
  matters and it fired correctly).

### KB-proof (a): navigation ready-gate skip removed → chain test T24 must fail

Mutated `src/core/loop.ts`'s `runChainEarly`, replacing
`const skipsReadyGate = typeof decidedAction === 'string' && (NAVIGATION_OPS as
ReadonlySet<string>).has(decidedAction);` with `const skipsReadyGate = false;`.
Built into a separate `.build/kb-proof-a` (via `node scripts/build.mjs --out
.build/kb-proof-a tests/chain.test.ts`, never the shared `dist/`), ran `chain`
against it:

```
not ok 36 - T24: navigate is exempt from the ready gate — a low-ready round still commits the navigate, not a wait
# tests 44, pass 43, fail 1
```

**Exactly the named test failed, nothing else.** Restored via
`git checkout -- src/core/loop.ts`; `git status --short src/core/loop.ts` empty
afterward. `.build/kb-proof-a` removed.

### KB-proof (b): move 'script' back into RETAINED_CLASSES → with-chrome test W17 expected to fail — **could not be produced as a `constants.ts`-only edit; reported as a finding, not faked**

The task named a single-file flip: "In `src/contract/constants.ts`, move
`'script'` back into `RETAINED_CLASSES` (and out of `WITHHOLDABLE_CLASSES`)".
Attempting exactly that:

```ts
export const WITHHOLDABLE_CLASSES = [
  'element-act', 'type', 'select', 'key', 'hover', 'upload', 'navigate', 'back', 'scroll',
] as const;
export const RETAINED_CLASSES = [
  'pointer-xy', 'drag', 'tabs', 'dialog', 'read', 'wait', 'session', 'unknown',
  'script',
] as const;
```

fails `tsc` with **two** compile errors, not a clean scoped build:

```
src/contract/constants.ts(90,3): error TS2353: Object literal may only specify known properties, and 'script' does not exist in type 'Record<"element-act" | "type" | "select" | "key" | "hover" | "upload" | "navigate" | "back" | "scroll", readonly string[]>'.
src/core/profiles.ts(228,13): error TS2367: This comparison appears to be unintentional because the types '"element-act" | "type" | "select" | "key" | "hover" | "upload" | "navigate" | "back" | "scroll"' and '"script"' have no overlap.
```

The first error is inside `constants.ts` itself (`CLASS_OPS`'s `script: []`
entry, a `Record<WithholdableClass, ...>`) — removing that entry too (still
confined to `constants.ts`) clears it. The **second** error is in
`src/core/profiles.ts`'s `withheldClasses()`, whose `c === 'script'` special
case is type-coupled to `'script'` remaining a member of the
`WithholdableClass` union. `profiles.ts` is outside the scope the task named
for this proof (and independently inside the general "never edit `src/`"
prohibition, with the sanctioned exception scoped explicitly to
`constants.ts` for this proof) — so the prescribed mutation **cannot be made
to compile as a `constants.ts`-only change** in this codebase, because the
"operator directive 2026-09-28" script-withholding mechanism deliberately
spans both files (`constants.ts`'s comment even says so: "profiles.ts's
`withheldClasses()` special-cases `script` to withhold it by default in
forced mode anyway").

**Per "REPORT, DO NOT FIX," this was not patched further.** Both edits
(`constants.ts`'s two array entries and the `CLASS_OPS` entry) were reverted
via `git checkout -- src/contract/constants.ts`; `git status --short` was
empty afterward (confirmed, and re-confirmed with `git diff --stat` showing
no output) before moving to proof (c). **This proof's outcome is reported as:
the prescribed single-file flip does not compile, which is itself evidence
that the `script`-withholding mechanism is NOT confined to a single constant
array the way r6-era capability classes were — it is a two-file contract
(`constants.ts` type + `profiles.ts` runtime special-case) — worth knowing
before anyone edits either file expecting the other proof pattern (a)/(c)
established (isolated one-file flip, one named test fails) to apply here.**
Test W17 itself was never actually run against a mutated build, because no
mutated build compiled; W17's clean-tree pass was already confirmed as part
of the full with-chrome.test.ts run in Part 1 above (29/29 pass, including
W17 at position 24).

### KB-proof (c): remove "profiles" from package.json's "files" array → scaffold test must fail

```
"files": [
    "dist/src", "fixtures/pages", "skills/jev-browser-wingman",
    "INSTALL-FOR-AGENTS.md", "README.md", "LICENSE", "THIRD_PARTY_NOTICES"
]
```

(dropped `"profiles"`). Built into a separate `.build/kb-proof-c` (via
`node scripts/build.mjs --out .build/kb-proof-c tests/scaffold.test.ts`), ran
`scaffold` against it:

```
not ok 15 - npm pack ships every dir the runtime reads from packageRoot
  error: 'expected a packed file under "profiles/", got: [...]'
# tests 16, pass 15, fail 1
```

**Exactly the named test failed** (test #15, the one whose full name matches
the task's "scaffold packing test"), nothing else. Restored via
`git checkout -- package.json`; `git status --short package.json` empty
afterward. `.build/kb-proof-c` removed. Final `npm run build` into the real
`dist/` confirmed clean (`BUILD: ok out=dist files=107`) and
`git status --short` for the whole repo was empty before Part 2.

**Part 1 verdict: fully green** (all 51 files, both gates, KB-proofs (a) and
(c) behaved exactly as specified; KB-proof (b) surfaced a genuine scope
finding rather than a pass/fail — reported above, not treated as a Part 1
failure since the *sanctioned, in-scope* portion of the mutation did what was
asked and the clean tree tests already prove W17 passes). **Proceeding to
Part 2 and Part 3.**

---

## Part 2 — forced-handoff benchmark (task: t9-long-chain)

Ledger before this part: **$5.814594** across the 7 pre-existing files in
`bench/results/` (all dated 2026-09-22, unrelated to this round).
`--phase-cap-usd 20.814594` (= history + $15) used for every call in this
part, bounding this part's *fresh* spend at $15 while staying under
`OPERATOR_CEILINGS.phaseUsd` (30). `--cap-usd 3.00` per run (under the $5
`runUsd` ceiling).

### Phase V — validity (playwright x3, gate off + policy off)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes playwright --repeats 3
--purpose measure`

| # | ok | wall | usd |
|---|---|---|---|
| 1 | true | 74.0s | 0.836737 |
| 2 | true | 69.1s | 0.710343 |
| 3 | true | 71.7s | 0.737109 |

Validity bar: 3/3 ≥ 2/3 required → **PASS**. Spend: $2.284189.

### Phase M — measure (forced x3 AND playwright x3, interleaved, gate off +
policy off, `--purpose measure`)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes forced,playwright
--repeats 3 --purpose measure`

| # | route | ok | wall | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | true | 172.6s | 1.032251 | 14 | 8 | 35 | 0 | 0 |
| 2 | playwright | true | 71.4s | 0.738651 | 0 | 0 | 0 | 18 | 0 |
| 3 | forced | **false** | 475.9s | 0.985762 | 15 | 7 | 28 | 0 | 0 |
| 4 | playwright | true | 74.3s | 0.738763 | 0 | 0 | 0 | 18 | 0 |
| 5 | forced | true | 134.4s | 0.591383 | 12 | 9 | 30 | 0 | 0 |
| 6 | playwright | true | 72.6s | 0.734863 | 0 | 0 | 0 | 18 | 0 |

Spend: $4.821673. `raw_acts` is 0 across every forced run — the caller never
made a raw Playwright action call in any forced cell (see per-handoff detail
below: `tool_use_counts` for every forced run contained only `ToolSearch`,
`mcp__jev-browser-wingman__browse_step`, `mcp__playwright__browser_snapshot`
and/or `mcp__playwright__browser_tabs` — all read-class). **`raw_script` is
also 0 in every forced run this round** (r5 had 2, r6 had 2) — this is the
first round where the script-withholding mechanism has zero measured bypass
at the bench level, not just in the unit tests.

Full per-handoff `status`/`reason`/`why`/`steps` records for all three forced
runs are in `results/phase-m-measure.json` (`handoff_records`); the run-2
detail is worth calling out directly: it reached `{'status': 'done',
'reason': 'goal-met', 'steps': 1, 'rounds': 2, 'progress': {'step_index': 1,
'steps_done': 1, 'steps_total': 1}}` at handoff 14 of 15 — i.e. wingman's own
chain judged the ENTIRE goal complete — and the run still ended `ok=false`
(oracle disagreed) after one more handoff (`fallback/no-progress`,
`steps_total: 1` again, meaning the caller re-issued the same last remaining
step and it made no further progress). This is a real divergence between
wingman's internal `done/goal-met` signal and the ground-truth oracle: `done`
is Jev's own judgment that the step's criteria are met, not a verification
that the literal final page state matches what the caller asked for.

**`forced-verdict` verbatim (default mode, over `phase-m-measure.json`):**

```
FORCED-VERDICT: completion forced=2/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=15
FORCED-VERDICT: picks 24/41
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 1.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=3 multi-match=1 no-match=8 no-progress=4 not-ready=14 wrong-page=4
FORCED-VERDICT: overall FAIL
```

**Bars missed (4 of 9 gating checks, same four as r6): completion** (2/3
trails playwright's 3/3), **handoffs** (max=15, bar is 1-4), **picks** (24/41
= 58.5%; bar needs `2*picks < handoffs`, i.e. 48 < 41 is false), **median-steps**
(1.00, bar is >= 4). Passing cleanly: wingman-share (1.00), raw-acts (0),
zero-step-done (0), first-call-success (3/3), no-page-error-end (0).
`raw-script` (0, informational) is a genuine improvement over r5/r6 (both 2).

### Phase S — smoke (one forced cell, gate ON)

`BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00 --phase-cap-usd
20.814594 --tasks t9-long-chain --routes forced --repeats 1` (policy left off,
matching V/M; the ONE variable changed for this phase is the gate, per the
task's own framing of Phase S as "one forced cell with the gate ON").

```
FORCED-VERDICT: smoke ok=false needs_confirmation=4
```

(`--smoke` mode is purely informational — `pass` is always `true` regardless
of `ok`, so this does not gate Part 2, but the `ok=false` result itself is a
finding, reported below, not softened.)

Run: wall=498.7s, usd=0.907027, handoffs=15, picks=5, wingman_acts=22. Unlike
r6's Phase S (`ok=true, needs_confirmation=10`, run completed), **this run's
gate interaction stalled**: four consecutive `needs_confirmation` handoffs
(all `irreversible-heuristic`, all at the SAME `progress.step_index: 3,
steps_done: 2` — the chain never advanced past the confirmation point) were
followed by one `error/invalid-input` handoff (a malformed `pick`/token
resubmission by the caller, same failure mode r6's Part 3 Finding 4
documented) and then the caller apparently gave up on that step entirely and
restarted with a SHORTER, different remaining-step list (`progress.steps_total`
drops from 7/6/... down to 4, i.e. it re-issued a partial goal), which then
bounced `not-ready` twice more before the run's `browser_tool_calls` (27,
close to the `route_max_turns.forced: 30` ceiling for this route) were
exhausted. **This is a genuine, reproducible interaction risk for shipping
with `gate.mode: "confirm"`: a real calling agent can get stuck oscillating
on repeated confirmation requests for the same irreversible action without
making progress, then abandon and restart with a truncated goal rather than
supplying the confirm token correctly** — worth flagging to whoever decides
whether `gate.mode: "confirm"` is recommended in documentation, though this
does not gate Part 2's pass/fail (the smoke check is informational by
design).

**Part 2 total fresh spend: $8.012889 of the $15 cap for this part**
(V $2.284189 + M $4.821673 + S $0.907027).

### Comparison: r5 vs r6 vs r7

| Metric | r5 (`c50d955`) | r6 (`231256b`) | r7 (`2a05d34`, this round) |
|---|---|---|---|
| Forced completion | 1/3 | 2/3 | 2/3 (unchanged from r6) |
| Median steps/handoff | 2.00 | 1.00 | 1.00 (unchanged) |
| Handoffs max | 16 | 17 | 15 (slightly better) |
| Picks | 26/42 (61.9%) | 31/50 (62.0%) | 24/41 (58.5%) (slightly better) |
| Forced wall (median of 3) | 223.9s | 209.9s | 172.6s (best yet, but see run 3's 475.9s) |
| Playwright wall (median of 3) | 72.4s | 72.6s | 72.6s (unchanged, as expected — control) |
| raw-script (bypass count) | 2 | 2 | **0 (fixed this round)** |
| why: not-ready | n/a (no field) | 22 | 14 (down) |
| why: no-match | n/a | 7 | 8 (flat) |
| why: no-progress | n/a (didn't exist) | 4 | 4 (flat) |
| why: wrong-page | n/a (didn't exist) | 0 | 4 (**new bounce category this round**) |
| `forced-verdict` overall | FAIL | FAIL | **FAIL (still)** |

**Honest read:** 2a05d34 measurably reduced `not-ready` bounces (22 -> 14,
consistent with the navigation ready-gate skip actually working — see the
telemetry section below) and eliminated the raw-script bypass entirely (2 -> 0
in real bench measurement, not just unit tests). But a brand-new `wrong-page`
bounce category appeared (0 -> 4) — the commit's own stated design decision
("right_page still counts toward WRONG_PAGE_MAX" even when the ready gate is
skipped for navigation verbs) is working as designed, but it moved some of
the same underlying navigation friction from the `not-ready` bucket into a
`wrong-page` bucket rather than eliminating it. `forced-verdict` is **still an
overall FAIL** on the same four bars as r5 and r6: completion, handoffs,
picks, median-steps. The median-steps bar in particular has not moved at all
across three rounds (2.00 -> 1.00 -> 1.00) — the caller is still handing off
in very small (1-step) slices very often, and Part 3's telemetry below gives
a concrete, reproducible root cause for why steps rarely complete inside a
single handoff.

### Telemetry (from `bench/.home/log.jsonl`; 41 Phase M records + 15 Phase S
records = 56 total, all `browse_step`/forced-route calls; playwright-route
runs never call wingman so contribute 0 records)

**doneP overall (Phase M, 132 rounds carrying a value):** median 0.080,
p25 0.050, p75 0.140, min 0.020, max 0.670. (Phase S, 34 rounds: median 0.040,
p25 0.040, p75 0.050.) `doneP` answers the whole-goal `done` question, which
chain mode never reads for its own decisions (per src/core/CLAUDE.md: "the
whole-goal `done` Noul is NEVER read in chain mode") — these numbers are
reported as raw telemetry only, consistently low as expected since no single
round of a 7-step chain should read as "the whole goal is done."

**stepDoneP on rounds that ended a step** (i.e. crossed
`THRESHOLDS.stepDone=0.85`, or the `stepDoneNoAction=0.5` bar on an
`action:none` round — the literal mechanism `runChainEarly` rule 3 uses to
advance the cursor), Phase M: **n=11, median=0.890, p25=0.660, p75=0.910,
min=0.560, max=0.940.**

**stepDoneP on rounds immediately after an act whose `historyResult` showed
real, non-neutral progress (i.e. not `"no visible change"` / `"element gone"`
— a genuine `filled`/`checked`/`selected: ...`/`page changed`/etc.) but that
did NOT advance the step**, Phase M: **n=49, median=0.120, p25=0.090,
p75=0.190, min=0.050, max=0.700.** This is the single clearest number in this
round's telemetry: **49 of the 132 rounds with a target decision (37%) show
genuine, observed page progress immediately beforehand, yet Jev's own
stepDoneP for that round sits at a median of 0.12 — nowhere near the 0.85 bar
needed to advance.** This is not a borderline-threshold problem (a median gap
of 0.7+ between the "advanced" and "progressed but not advanced" populations
is not something a small threshold tweak would close) — it is a
step-completion *judgment* gap: Jev is not recognizing that observed progress
satisfies the step, the overwhelming majority of the time. Part 3 below
reproduces this defect live and at length (75 real clicks against a 2-click
goal, `stepDoneP` never once crossing 0.6 across three full-budget calls).

**readyP on not-ready rounds (readyP < 0.5), broken down by decided verb**
(Phase M):

| verb | n | median readyP | p25 | p75 |
|---|---|---|---|---|
| click | 39 | 0.410 | 0.370 | 0.470 |
| wait | 6 | 0.450 | 0.220 | 0.450 |
| navigate | 4 | 0.425 | 0.410 | 0.430 |
| back | 3 | 0.360 | 0.340 | 0.360 |
| select | 3 | 0.470 | 0.440 | 0.470 |
| fill | 1 | 0.460 | 0.460 | 0.460 |

Rounds >= the `ready` threshold (0.5): 76/156 (49%). Rounds >= the
`rightPage` threshold (0.5): 118/156 (76%).

**Why-breakdown vs r6** (call-level, from `step_review.why` on non-commit
handoffs, Phase M only — matches `forced-verdict`'s own line exactly, cross-
checked independently from the raw log):

| why | r6 | r7 |
|---|---|---|
| not-ready | 22 | 14 |
| no-match | 7 | 8 |
| no-progress | 4 | 4 |
| low-confidence | 3 | 3 |
| multi-match | 2 | 1 |
| wrong-page | 0 (didn't exist as a bounce category) | 4 |

**Target confidence per why-reason** (round-level `target1P`/gap, Phase M,
132 rounds with a target decision):

| why | rounds | median top-1 | median gap (top1-top2) |
|---|---|---|---|
| not-ready | 44 | 0.950 | 0.910 |
| no-match | 42 | 0.930 | 0.880 |
| *(none — normal commit)* | 15 | 0.950 | 0.900 |
| wrong-page | 11 | 0.930 | 0.870 |
| no-progress | 10 | 0.920 | 0.840 |
| low-confidence | 8 | 0.525 | 0.190 |
| multi-match | 2 | 0.515 | 0.225 |

Same headline as r6: **target-probability confidence is not the bottleneck**
for `not-ready`/`no-match`/`wrong-page` (the three largest buckets, 97/132
rounds, all median top-1 >= 0.92) — those bounces know exactly which element
they mean; they fail on readiness/step-matching/page-identity gates, not
target identification. Only `low-confidence` and `multi-match` (10/132 rounds
combined) show the low-confidence/small-gap signature a target-probability
threshold would actually address.

Redaction check on Phase M/S artifacts (`bench/.home/log.jsonl`,
`results/phase-{v,m,s}-*.json`): the TypeSafe secret-key prefix string is not
present, the literal `TYPESAFE_API_KEY` environment value is not present
(checked via `grep -F` on the value itself without ever printing it; exit 1 =
not found), and the t9 task's bound e-mail value is not present. The literal
digits `"77"` appear 20 times across these files; every occurrence was
inspected in context and is incidental (`actionP:0.77`, `rightPageP:0.77`,
`output_tokens:...877`/`10877`, a timestamp fragment `.477Z`, `jevMs:177`) —
never the bound `amount` value in a value-carrying position. Neither of the
t9 task's two bound values appears in `log.jsonl` or the results JSONs in a
way that discloses them; consistent with r6's same finding.

---

## Part 3 — fresh-install check

`npm pack` in the repo (`jev-browser-wingman-0.2.1.tgz`, 122 files, includes
`profiles/chrome-devtools-mcp.json` and `profiles/playwright-mcp.json` — 2
files under `package/profiles/`, confirmed with `tar tzf`). Installed with
`npm install -g --prefix <scratch> <tarball>` into a clean location outside
the repo. **`$(npm root -g)/jev-browser-wingman/profiles` exists with both
shipped profile files, purely from the packed tarball — no manual copy.**
This confirms KB-proof (c) above: the packaging defect r6 found (Finding 1:
"the top-level `profiles/` directory is not in [package.json's files array]")
is fixed in this RC.

Registered the installed CLI with Claude Code (`claude mcp add -s user
playwright -- npx -y @playwright/mcp@0.0.80 --browser chrome`, then
`claude mcp add -s user jev-browser-wingman -- jev-browser-wingman mcp`),
alongside Playwright MCP, per INSTALL-FOR-AGENTS.md. Backed up the pre-existing
`~/.claude.json` first (per the doc's own "Back up before editing" section)
and restored it at the end of this part.

`doctor --detect` correctly classified the registered `playwright` server as
`"kind":"playwright-mcp","mode":"launch"` (this is the Finding-1 fix working
end to end, not just in the unit test: r6 could not reach this classification
from a real global install because the profile data never shipped).

`doctor --plan` printed two `[todo]` items: O1 (create
`~/.jev-browser-wingman/config.json` with `{"mode": "on"}`) and O2 (wrap the
`playwright` registration with `with-browser`). Followed both exactly as
printed (`claude mcp remove` + `claude mcp add -- jev-browser-wingman
with-browser -- npx -y @playwright/mcp@0.0.80 --browser chrome`), then ran
`jev-browser-wingman chrome ensure` (per the Verify table's fix for
`adapter-attach`) and `doctor --json`:

```json
{
  "verdict": "PASS",
  "checks": [
    {"id": "key-present", "status": "PASS", "detail": "source=env"},
    {"id": "config-loaded", "status": "PASS", "detail": "config loaded; gate: off ..."},
    {"id": "registration-portable", "status": "PASS", "detail": "2 registration(s) portable"},
    {"id": "policy-loaded", "status": "PASS", "detail": "policy lists load and the self-test host classifies sensitive-identity"},
    {"id": "profile-safe", "status": "PASS", "detail": "the Chrome answering on port 9222 uses profile_dir"},
    {"id": "adapter-attach", "status": "PASS", "detail": "attached to http://127.0.0.1:9222; 1 page(s)"},
    {"id": "default-context", "status": "PASS", "detail": "attach stayed in the default context; cookies=1"},
    {"id": "coexistence", "status": "PASS", "detail": "observer fingerprint identical across attach/detach (1 page(s))"},
    {"id": "handoff", "status": "PASS", "detail": "enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll, script"},
    {"id": "jev-round", "status": "PASS", "detail": "runCheck answered with 1 jev call(s)"}
  ]
}
```

**All 10 checks PASS, and the `handoff` detail lists `script` among the
withheld classes**, exactly as required.

**Structural confirmation the caller cannot use a non-read browser tool**:
the `system/init` event of every one of the three `claude -p` transcripts
below lists the ACTUAL tools served to the model. Even though every run's
`--allowedTools` explicitly pre-authorized `mcp__playwright__browser_click`,
`browser_type`, `browser_navigate`, `browser_evaluate`,
`browser_run_code_unsafe`, `browser_fill_form`, `browser_select_option` and
`browser_press_key`, **none of these appear in the served tool list** — only
read/session-class tools do (`browser_close`, `browser_console_messages`,
`browser_drag`, `browser_drop`, `browser_find`, `browser_handle_dialog`,
`browser_network_request(s)`, `browser_resize`, `browser_snapshot`,
`browser_tabs`, `browser_take_screenshot`, `browser_wait_for`) plus
`mcp__jev-browser-wingman__browse_step`. This is enforcement at the MCP
`tools/list` layer (the `with-browser` proxy filtering what the wrapped
server even offers), not merely the model choosing not to call something it
could see — the model never had the option. Across all three tasks below, the
model never called any tool outside this served list, and never called a
non-read tool other than `browse_step` itself.

### Per-task results — **0 of 3 succeeded on the first `browse_step` call**

| Task | Page | `browse_step` calls | First-call result | Outcome |
|---|---|---|---|---|
| type 42 into the number field | `/inputs` | 2 (+1 read-only `browser_snapshot` to verify) | `fallback/no-progress` (2 acts) | Value WAS correctly set after call 1's first act; caller self-verified via snapshot and declared DONE after call 2 also bounced |
| Choose Option 2 | `/dropdown` | 2 (+1 read-only `browser_snapshot` to verify) | `fallback/no-progress` (1 act) | Option WAS correctly selected after call 1's act; same self-verify-via-snapshot pattern |
| click Add Element twice | `/add_remove_elements/` | **3, all `fallback/budget-steps` at the full 24-step budget** (+1 read-only `browser_snapshot`) | `fallback/budget-steps`, 24 clicks | **75 total real clicks** made (confirmed live on the page: 75 "Delete" buttons present) against a "click twice" goal, before the caller gave up delegating and self-verified via snapshot |

**None of the three tasks met the validation bar ("must use browse_step and
succeed on the FIRST call").** Two of three (`/inputs`, `/dropdown`)
*functionally* completed correctly after 2 calls, only because the caller
independently double-checked with a read-only snapshot rather than trusting
`browse_step`'s own terminal status (which was `fallback` both times, never
`done`). The third (`/add_remove_elements/`) is a severe, reproducible
regression against the task's literal ask: **75 clicks executed for a
"twice" goal**, at 3x the per-run TypeSafe spend a correct single call would
have cost.

### Root-cause diagnosis, with hard telemetry evidence

**Root cause: `stepDoneP` (Jev's step-completion judgment) does not
recognize genuine, observed progress as satisfying the step — for both
element-state verbs (fill/select) and click-family verbs — and this is the
SAME defect Part 2's telemetry flagged in aggregate (49 progressed-but-
not-advanced rounds, median stepDoneP 0.12), now reproduced live and in
isolation on real, single-purpose pages.**

**Task 1 (`/inputs`) telemetry** (`~/.jev-browser-wingman/log.jsonl`, calls
1-2): call 1 round 1 fills the field (`action=fill`, `actionP=1`), round 2
observes `historyResult=filled` (real progress — the field IS now correctly
filled) but `stepDoneP=0.83` — under the 0.85 bar by 0.02, so the chain does
NOT advance and instead re-issues the identical fill; round 3 observes
`historyResult=filled` again (state unchanged, correctly so — it was already
right) and `stepDoneP=0.72`, which the outcome-evidence no-progress guard
correctly catches as a repeat with no state change, ending the call
`fallback/no-progress`. **The task was functionally done after round 1's
single act; the call spent 2 more rounds and ended in fallback because
`stepDoneP` sat just under threshold once (0.83 vs 0.85) and then the retry
itself became the "no progress" the guard is designed to catch.** Call 2
repeats exactly the same round-2 shape (`historyResult=filled`,
`stepDoneP=0.83`) and again bounces `no-progress`.

**Task 2 (`/dropdown`) telemetry** (calls 3-4): call 3 clicks to open the
dropdown (`historyResult` not yet available), round 2 shows
`historyResult="no visible change"` — genuinely no progress on THIS click
(a value-carrying `select` was still needed) — correctly bounces
`no-progress`. Call 4 (with `pick` naming `select`) round 2 shows
`historyResult="selected: <value:option2>"` (real progress — the correct
option IS now selected) but `stepDoneP=0.52`, a full 0.33 under threshold;
round 3 repeats the identical click, observes `historyResult="no visible
change"` (correctly — it was already selected) and `stepDoneP=0.49`, and the
no-progress guard ends the call. **Same pattern as task 1: the actual page
state was already correct one round earlier than the tool reported.**

**Task 3 (`/add_remove_elements/`) telemetry — the clearest evidence in this
entire validation pass:** across all 3 calls (75 rounds total, calls 5/6/7 in
the log), **every single round from round 2 onward reports
`historyResult="page changed"`** (i.e. every click genuinely, visibly added a
new Delete button — zero rounds of true stall) — yet `stepDoneP` across all
75 rounds ranges only **0.43 to 0.76**, with a typical value around 0.50-0.58,
**never once reaching the 0.85 threshold needed to advance the step, across
three independent full-budget (24-round) calls.** Representative rows from
call 5: round 3 `stepDoneP=0.61` (`historyResult=page changed`), round 10
`stepDoneP=0.54` (`historyResult=page changed`), round 25 `stepDoneP=0.56`
(`historyResult=page changed`, the last round of the budget). This is not a
threshold-tuning question at the margin — it is Jev consistently and
repeatedly failing to recognize "I clicked Add Element and a new element
appeared" as satisfying a step literally titled "Click the Add Element
button," for 75 consecutive real actions. **This is the direct, unfixed
continuation of round 6's own "Finding 3" ("click-family progress that never
gets graded step done")** — 2a05d34's commit message describes fixes for
navigation ready-gating and click-family *no-progress-guard* signal widening,
but neither of those addresses the underlying step-completion judgment gap
Finding 3 identified; this round's fresh-install run reproduces it at
3x the severity (three full budget exhaustions instead of r6's two, and 75
clicks instead of an unspecified-but-implied smaller number).

### Doc gaps found

1. **(Carried over from r6, still present) `INSTALL-FOR-AGENTS.md` does not
   warn that `browse_step` can report `fallback` on a step that has, in
   fact, already succeeded on the page** (Tasks 1 and 2 above) — an
   installing agent following the doc has no signal to independently verify
   with a snapshot before assuming failure, other than having discovered
   this behavior empirically (as this validation run did).
2. **New this round:** `INSTALL-FOR-AGENTS.md`'s "Handoff mode" section does
   not mention that a single `browse_step` call can exhaust its full step
   budget (default 24) while making continuous, real, verifiable page
   progress every round and still never report the step done — i.e. budget
   exhaustion is not a reliable signal that something is stuck; it may
   equally mean the goal is already satisfied several times over (Task 3).
   An installing agent that trusts "call it again with the same arguments"
   (the doc's own literal guidance, echoed in the bench `FORCED_ENGAGEMENT_LINE`)
   has no way to know this can multiply real side effects (75 clicks for a
   "click twice" goal) rather than simply retrying.
3. `INSTALL-FOR-AGENTS.md` doesn't mention that `doctor --plan`'s
   registration path targets `~/.claude.json` (the *global*, not
   project-scoped, Claude Code config) — confirmed again this round; worth a
   line so an installing agent knows it is editing shared user state.
4. No mechanism in `doctor --plan`'s O1 step creates
   `~/.jev-browser-wingman/config.json` for you when the file does not exist
   at all (a truly fresh install has no config dir) — the doc's Configure
   table documents the schema but the plan output's fix line
   (`set "mode": "on" in <path>/config.json`) reads as an edit, not a
   "create the file" instruction; a literal-minded installing agent might
   try to edit a file that doesn't exist yet.

### Cost

Task 1: $0.0680188 (+ negligible haiku sub-agent cost). Task 2: $0.1080350.
Task 3: $0.1343168. **Total Part 3 LLM spend: ~$0.3104** (from each call's own
`total_cost_usd`), well under the $4 cap. TypeSafe spend for Part 3 is
included in the `~/.jev-browser-wingman/log.jsonl` telemetry above and is
trivial (`jev_calls` in the tens, at the same per-call rate as Part 2).

### Linux-only caveats

- `chrome-cmd`'s window-position test (`Browser.setWindowBounds` +
  `GetWindowRect`) is win32-only and was correctly SKIPped on this Linux
  container.
- `chromium-wrapper.sh`'s `--ignore-certificate-errors` is required only
  because this cloud container's egress proxy re-terminates TLS with a CA
  the Chrome Root Store doesn't trust — not something a real end-user
  Linux/Mac/Windows install needs.
- All Chrome launches ran headed-off-screen under Xvfb `:99`; no
  windowed-Chrome-specific (`window: "normal"`) behavior was exercised.
- Navigating the shared Part-3 Chrome to each task's starting page (before
  each `claude -p` call) required the raw CDP HTTP API directly
  (`PUT /json/new?<url>` then `/json/close/<old-id>`, keeping exactly one
  page target open at a time) — `jev-browser-wingman` itself has no
  "navigate to URL" CLI command (correctly so: that is the calling agent's
  own browser tool's job), and Chrome's `/json/new` requires `PUT`, not
  `GET` (a `GET` returns HTTP 405). This matches `bench/run.ts`'s own
  `resetPages` pattern and the CLAUDE.md WP-H gotcha about attach ordering;
  not a new finding, just the operational mechanism this validation used.
- `npm root -g` and the true global prefix depend on `--prefix`; this
  validation used an isolated `--prefix` scratch directory rather than the
  container's real global npm prefix, specifically so the fresh-install
  check could not accidentally collide with or be satisfied by anything
  already on the container's real global `node_modules`.

---

## Cleanup

- `jev-browser-wingman chrome stop` run for both the Part 2 bench browser
  (port 9344, stopped automatically by `bench/run.ts`'s own teardown after
  each phase) and the Part 3 fresh-install browser (port 9222, stopped
  explicitly). `ps aux | grep -i chrome | grep -v grep` empty after each.
- `~/.claude.json`'s `playwright`/`jev-browser-wingman` MCP registrations
  added for Part 3 were removed by restoring the pre-edit backup
  (`~/.jev-browser-wingman/backups/claude-code-full-backup-*.json`, taken
  before any edit, per INSTALL-FOR-AGENTS.md's own "Back up before editing"
  guidance); `claude mcp list` confirmed empty afterward, matching the
  pre-Part-3 state.
- Xvfb `:99` stopped at the end of the whole task.
- Scratch directories removed: `/tmp/wingman-fresh-install-r7`,
  `/tmp/wingman-fresh-global-r7`, `/tmp/wingman-fresh-project-r7`.
- `bench/results/2026-09-28-*.json` (this round's Phase V/M/S files) and
  `bench/.home/log.jsonl` / `~/.jev-browser-wingman/log.jsonl` are copied
  into `bench-results/2026-09-28-r7/` on this results-only branch; they are
  **not** committed to `forced-handoff-0.3.0` or `main`.
- The three Part 3 `claude -p` transcripts (`logs/part3/attempt*.ndjson`) are
  included in this push (unlike r6, which excluded Part 3 transcripts because
  its tasks carried bound values) — this round's three fresh-install tasks
  carry no sensitive bound values (task 1's only value is the literal digit
  `"42"`; tasks 2 and 3 have none), confirmed by the redaction greps run
  immediately before push.
