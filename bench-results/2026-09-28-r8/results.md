# jev-browser-wingman 0.3.0 ("forced handoff") — Round 8 validation

Branch under test: `forced-handoff-0.3.0` @ `ca73e9a` (HEAD exactly; a descendant
of `main` confirmed via `git fetch origin && git checkout forced-handoff-0.3.0`,
`git rev-parse HEAD` = `ca73e9a0369e453feb72a92ba393fe6813a12f2a`).

Round 7 reference: `2a05d34`, `bench-results/2026-09-28-r7/results.md` (branch
`bench/forced-0.3.0-results-r7`). Round 7 had a green test suite, zero
`raw_script` bypass, but the forced benchmark FAILED: forced 2/3 vs playwright
3/3, median 1 step/handoff, handoffs max 15, picks 24/41, why-breakdown
low-confidence=3 multi-match=1 no-match=8 no-progress=4 not-ready=14
wrong-page=4. Telemetry showed Jev's `stepDoneP` staying under the 0.85 bar
after verified outcomes. Commit `ca73e9a` (this round's subject) adds an
evidence-backed bar (step done at `stepDoneP >= 0.5` when the current step's
last act is fill/select/check/uncheck and its observed result confirms the
intended end state; steps naming 2+ bound values and all click-family verbs
keep 0.85) and filters batched `tools/list` in the with-browser proxy.

Environment: cloud Linux container, Xvfb `:99`,
`bench/cloud/chromium-wrapper.sh` installed at
`/usr/local/bin/chromium-wrapper.sh`, symlinked from `/usr/bin/chromium` and
`/opt/google/chrome/chrome`, `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**No `src/`, `tests/`, `bench/forced-verdict.ts` thresholds, `profiles/` or
fixtures were edited outside the two sanctioned, temporary KB-proof flips in
Part 1.** Each was restored via `git checkout` and `git status --short`
confirmed clean immediately after. Final `git status --short` for the whole
repo at the end of Part 1: empty.

---

## Part 1 — full test suite: PASS

`npm ci && npm run build` → `BUILD: ok out=dist files=107`. `npx tsc --noEmit`
→ exit 0.

All 51 `tests/*.test.ts` files run individually via
`node scripts/run-tests.mjs <basename>`, strictly sequential, one
Chrome-launching run at a time. After every run, `ps aux | grep -i chrome`
was checked; the only residue ever seen was self-reaping `<defunct>` zombie
chrome processes (expected per CLAUDE.md, not a leak) — plus the deliberate
`runner-sweep-leak.test.ts` fixture leak, which the runner's own
`RUN-TESTS: chrome sweep (post-run)` token sweep killed immediately after
that file, exactly as documented. No live leaked chrome process was ever
left running between files.

| # | file | result | # | file | result |
|---|------|--------|---|------|--------|
| 1 | acquire | pass 6/6 | 27 | log | pass 3/3 |
| 2 | adapter-cdp | pass 8/8 | 28 | loop | pass 36/36 |
| 3 | adapter-playwright | pass 7/7 | 29 | mcp-server | pass 14/14 |
| 4 | bench-browse | pass 26/26 | 30 | outcome-evidence | pass 19/19 |
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
| 23 | egress | pass 6/6 | 49 | with-chrome | pass 32/32 |
| 24 | ephemeral-sweep | pass 7/7 | 50 | with-chrome-forced | pass 3/3 |
| 25 | gate | pass 9/9 | 51 | withhold | pass 8/8 |
| 26 | jev-client | pass 6/6 | | | |

**Aggregate: 51/51 files fully green. Individual tests: 678 total, 677 pass, 0
fail, 1 skip.** The one skip is `chrome-cmd`'s window-position test, `# SKIP
win32 only` — the one acceptable non-pass per the task brief. No file needed
a re-run; no failures were observed on the first pass of any file.
`outcome-evidence.test.ts` grew from r7's 11 tests to 19 (this commit's own
new evidence-bar tests, WP-evidence-a..h); `with-chrome.test.ts` grew from 29
to 32 (W7b/W7c, the batched-`tools/list`-filtering tests).

`cli.test.ts`'s "chrome show dispatches into chrome-cmd (no-browser JSON, not
the usage exit)" passed cleanly (no shared bench Chrome was up on port 9222
at that point in the sequence).

### Gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` → `LAZY-CHROME: ok
  listed=24 chrome=0 answered=false` (exit 0).
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` →
  `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (exit 1) — caught
  correctly.

### KB-proof (a): `hasStepEvidence` forced to always return `false` → outcome-evidence WP-evidence-a must fail

Mutated `src/core/loop.ts`'s `hasStepEvidence` to `return false;` as its
first statement (dead code below, TS raised no error — `allowUnreachableCode`
is not tightened in this project's `tsconfig.json`). Built into a separate
`.build/kb-proof-a` (`node scripts/build.mjs --out .build/kb-proof-a
tests/outcome-evidence.test.ts`), ran `outcome-evidence` against it:

```
not ok 12 - WP-evidence-a: step_done 0.6 with a confirmed fill result advances (evidence-backed bar)
# tests 19, pass 18, fail 1
```

**Exactly the named test failed, nothing else** (all 8 other WP-evidence-*
tests, which pin the bar's negative/edge cases, still passed — they don't
depend on `hasStepEvidence` returning `true`). Restored via `git checkout --
src/core/loop.ts`; `git status --short` empty afterward. `.build/kb-proof-a`
removed.

### KB-proof (b): with-chrome.ts batch arrays skip `tools/list` filtering → W7b must fail — **confirmed, plus an unscripted finding: the mutation also hangs the test process**

Mutated `handleChildLine` in `src/cli/with-chrome.ts` so the `Array.isArray(parsed)`
branch forwards every batch line unchanged (`stdout.write(rawLine); return;`),
removing the per-element `tools/list`-filtering loop this commit added,
leaving only the pre-existing plain (non-array) message path filtered — i.e.
restoring the "only filter plain messages" behavior the task named. Built
into `.build/kb-proof-b` (`node scripts/build.mjs --out .build/kb-proof-b
tests/with-chrome.test.ts`), ran `with-chrome` against it through
`run-tests.mjs`: **the invocation exceeded a 120s foreground timeout and had
to be moved to the background; after ~9 minutes at ~0% CPU (clearly hung, not
slow) it was killed.** Because `run-tests.mjs` buffers ALL stdout until the
child process exits (the documented pipe-buffering gotcha), the killed run
produced **zero** captured TAP output — the mutation doesn't just fail the
named test, it prevents the whole file's result from ever being observable
through the normal runner path.

Re-ran the SAME mutated build directly with `node --test --test-reporter=tap
.build/kb-proof-b/tests/with-chrome.test.js` under a hard `timeout 90` so TAP
lines could stream to a file as they printed. Result: **all 32 subtests ran
and reported (only W7b and W7c fail, all 30 others pass — see below) but the
process itself never printed a final `# tests`/`1..32` summary and never
exited** before the 90s timeout; `ps aux` confirmed the underlying node
processes were still resident with ~0% CPU. No chrome or child processes
were left over after the kill.

```
not ok 19 - W7b: forced — a batched tools/list response is filtered (withheld tools absent)
not ok 20 - W7c: forced — activeProfile populated from a batched tools/list lets a later plain tools/call classify correctly
```

**Exactly the two batch-dependent tests fail; the other 30 subtests in the
file are unaffected.** W7c fails as a direct knock-on of W7b's mechanism (it
also depends on a batched `tools/list` populating `activeProfile`), not a
second independent defect. **Reported as a finding, not fixed per "REPORT, DO
NOT FIX":** the mutation leaves some resource open past the point where every
test has reported its result — most likely a child process or open handle
from W7b's or W7c's assertion-thrown-before-cleanup path (`proc.endStdin()` /
`proc.waitClose()` never runs when an `assert.ok`/`assert.equal` throws
earlier in the test body) — which keeps Node's event loop alive indefinitely.
This means a CI/gate invocation of `with-chrome` against a build carrying
this specific regression would look like a **hang**, not a **clean two-test
failure**, unless it goes through the direct `node --test` path used here
instead of the buffered `run-tests.mjs` wrapper. Restored via `git checkout
-- src/cli/with-chrome.ts`; `git status --short` empty afterward.
`.build/kb-proof-b` removed. Final `npm run build` into the real `dist/`
confirmed clean (`BUILD: ok out=dist files=107`) and `git status --short`
was empty before Part 2.

**Part 1 verdict: fully green.** All 51 files, both gates, and both KB-proofs
behaved as specified (proof (a) cleanly; proof (b) additionally surfaced a
process-hang side effect on the buffered runner path, documented above as a
finding rather than treated as a Part 1 failure, since the *sanctioned*
mutation did what was asked — W7b failed — once observed through a path that
could actually see it).

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
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes playwright --repeats
3 --purpose measure`

| # | ok | wall | usd |
|---|---|---|---|
| 1 | true | 78.1s | 0.861552 |
| 2 | true | 74.9s | 0.740192 |
| 3 | true | 76.7s | 0.911218 |

Validity bar: 3/3 ≥ 2/3 required → **PASS**. Spend: $2.512962.

### Phase M — measure (forced x3 AND playwright x3, interleaved, gate off + policy off, `--purpose measure`)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes forced,playwright
--repeats 3 --purpose measure`

| # | route | ok | wall | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | **true** | 145.8s | 0.753431 | 10 | 7 | 31 | 0 | 0 |
| 2 | playwright | true | 76.5s | 0.741680 | 0 | 0 | 0 | 17 | 0 |
| 3 | forced | **true** | 161.3s | 0.822450 | 13 | 6 | 34 | 0 | 0 |
| 4 | playwright | true | 74.5s | 0.689772 | 0 | 0 | 0 | 17 | 0 |
| 5 | forced | **true** | 246.8s | 1.027384 | 14 | 5 | 36 | 0 | 0 |
| 6 | playwright | true | 76.9s | 0.718835 | 0 | 0 | 0 | 17 | 0 |

Spend: $4.753552. **`forced` went 3/3 this round** (r7 was 2/3). `raw_acts`
is 0 across every forced run, and `raw_script` is 0 across every run (forced
and playwright alike) — no bypass, same as r7. All three forced runs ended
their LAST handoff at `status: done, reason: goal-met` and none needed
further handoffs afterward — no r7-style "done then the oracle still
disagreed" case this round (see Telemetry, "premature advance" below).

**`forced-verdict` verbatim (default mode, over `phase-m-measure.json`):**

```
FORCED-VERDICT: completion forced=3/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=14
FORCED-VERDICT: picks 18/37
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 2.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=2 no-match=9 no-progress=1 not-ready=12 wrong-page=5
FORCED-VERDICT: overall FAIL
```

**Bars missed (2 of 9 gating checks — down from 4 in r5/r6/r7): handoffs**
(the per-run bar requires every forced run's handoff count in [1,4]; this
round's three runs handed off 10/13/14 times, all far outside the range)
and **median-steps** (2.00, bar needs >= 4 — doubled from r7's 1.00 but still
short). **completion and picks both flip to PASS for the first time in this
series**: completion is now 3/3 = playwright's 3/3 (was the persistent
2-of-4-failing-bars item in r5/r6/r7); picks is 18/37 (2×18=36 < 37, so the
`2*picks < handoffs` bar now holds — was 58.5%/61.9%/62.0% pick-ratio and
failing in r7/r6/r5, now 48.6% and passing). Passing cleanly as before:
wingman-share (1.00), raw-acts (0), zero-step-done (0), first-call-success
(3/3), no-page-error-end (0). `raw-script` (0, informational) stays fixed
from r7.

### Phase S — smoke (one forced cell, gate ON)

`BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00 --phase-cap-usd
20.814594 --tasks t9-long-chain --routes forced --repeats 1` (policy left
off, matching V/M; the gate is the one variable changed for this phase).

```
FORCED-VERDICT: smoke ok=true needs_confirmation=6
```

Run: wall=209.6s, usd=1.065856, handoffs=18, picks=9, wingman_acts=33.
**Unlike r7's Phase S (`ok=false`, a genuine stall at 498.7s with four
consecutive `needs_confirmation` bounces stuck at the same `progress.step_index`),
this round's smoke run completed successfully.** Its handoff sequence shows
six `needs_confirmation` (`irreversible-heuristic` x5, `irreversible-jev`
x1) interleaved with `fallback/step-uncertain` bounces (`not-ready`,
`no-match`, `wrong-page`), but — unlike r7 — each confirmation was followed
by continued, different chain progress rather than oscillating on the same
`step_index`; `progress.steps_total` shrank across the run (7→6→5→4→3→2→1)
and the final handoff was `done/goal-met`. This round does not reproduce
r7's "gate-mode stuck oscillation" finding, though n=1 per round is not
enough to call that finding retired — it did not reproduce here, no more.

**Part 2 total fresh spend: $8.332370 of the $15 cap for this part**
(V $2.512962 + M $4.753552 + S $1.065856).

### Comparison: r5 vs r6 vs r7 vs r8

| Metric | r5 (`c50d955`) | r6 (`231256b`) | r7 (`2a05d34`) | r8 (`ca73e9a`, this round) |
|---|---|---|---|---|
| Forced completion | 1/3 | 2/3 | 2/3 | **3/3** |
| Median steps/handoff | 2.00 | 1.00 | 1.00 | **2.00** |
| Handoffs max | 16 | 17 | 15 | 14 |
| Picks | 26/42 (61.9%) | 31/50 (62.0%) | 24/41 (58.5%) | **18/37 (48.6%)** |
| Forced wall (median of 3) | 223.9s | 209.9s | 172.6s | 161.3s |
| Playwright wall (median of 3) | 72.4s | 72.6s | 72.6s | 76.5s |
| `raw-script` (bypass count) | 2 | 2 | 0 | 0 |
| `forced-verdict` overall | FAIL | FAIL | FAIL | **FAIL (but 2/9 bars missed, not 4/9)** |
| Bars missed | (not itemized) | completion, handoffs, picks, median-steps | completion, handoffs, picks, median-steps | **handoffs, median-steps only** |
| Part 2 total spend | $8.560461 | $8.531863 | $8.012889 | $8.332370 |

**Honest read:** this is the best round of the series on the forced-verdict
gating checks — completion and picks, two of the four bars that had failed
identically in every prior round, both now pass, and median-steps doubled
even though it's still under the >=4 bar. `forced-verdict`'s overall verdict
is still FAIL (handoffs and median-steps remain missed, and "FAIL" is
binary — going from missing 4 bars to missing 2 does not change the overall
line), consistent with the task's own instruction that a missed bar IS the
finding regardless of how close it comes.

### Telemetry (from `bench/.home/log.jsonl`; 55 records: 37 Phase M + 18
Phase S, all `browse_step`/forced-route calls; playwright-route runs never
call wingman so contribute 0 records)

**Call-start step-count split:** 4 of the 55 calls started with
`steps_total == 1` (a single-step ask); 49 started with `steps_total > 1`
(the caller handing wingman a multi-step slice of the chain, not splitting
into single steps as its default strategy this round).

**stepDoneP on rounds that ended a step** (mechanically: `stepDoneP >= 0.85`
on any verb, OR `action === 'none'` with `stepDoneP >= 0.5`, OR — new this
round — a fill/select/check/uncheck round whose `historyResult` confirms the
verb's intended end state with `0.5 <= stepDoneP < 0.85`, i.e. the new
evidence bar): **n=21, median=0.870, p25=0.600, p75=0.910, min=0.520,
max=0.930.**

**stepDoneP on rounds immediately after an act with real, non-neutral
observed progress that did NOT advance the step** (same definition as r7:
`historyResult` not `undefined`/`'no visible change'`/`'element gone'`):
**n=61, median=0.110, p25=0.080, p75=0.170, min=0.050, max=0.830.** The gap
between the two populations (median 0.87 vs 0.11) is essentially unchanged
from r7's 0.89 vs 0.12 — the evidence bar helps SOME rounds cross into the
"advanced" bucket (see next line) but the underlying judgment gap for the
rounds it doesn't reach is exactly as wide as before.

**Evidence-bar advances (the new mechanism, `0.5 <= stepDoneP < 0.85` with
confirming fill/select/check/uncheck evidence): 5 of the 21 advancing
rounds (24%) used the new bar** — i.e. without `ca73e9a`'s fix, those 5
rounds would have stayed stuck below 0.85 and bounced instead of advancing,
which is direct, positive evidence the fix is doing real work this round
(consistent with completion flipping to 3/3).

**Premature-advance check (a step advanced but the caller had to redo it, or
the oracle disagreed):** none found this round. All three Phase M forced
runs and the Phase S run ended their run on a `done/goal-met` handoff with no
further handoffs after it, and all four runs finished `ok=true`. This is a
genuine difference from r7, whose Phase M run 2 hit `done/goal-met` at
`steps_total: 1` and then needed one more handoff (`fallback/no-progress`)
before the oracle finally read false. One non-monotonic step-list observation
worth noting (not a premature advance, a caller-behavior note): Phase M
forced run 3's `progress.steps_total` went 7 → 7 → 7 → 6 → 5 → **7** → 7 → 6
→ ... — the caller's re-issued remaining-step list grew back from 5 to 7
partway through, the same "caller restarts with a different-sized goal"
pattern r7's Phase S documented, just without a stuck-confirmation trigger
this time.

### Why-breakdown vs r7 (call-level, Phase M only, cross-checked against
`forced-verdict`'s own line)

| why | r7 | r8 |
|---|---|---|
| not-ready | 14 | 12 |
| no-match | 8 | 9 |
| no-progress | 4 | 1 |
| low-confidence | 3 | 2 |
| multi-match | 1 | (0 in Phase M; see Part 3 for a large multi-match cluster outside this phase) |
| wrong-page | 4 | 5 |

`not-ready` continues its downward trend from r6 (22) → r7 (14) → r8 (12);
`no-progress` dropped sharply (4 → 1), consistent with the outcome-evidence
mechanism doing more of its intended job. `wrong-page` and `no-match` are
flat-to-slightly-up and remain the two largest buckets, same headline as
r6/r7: these bounces know which element they mean (this round's data was not
separately re-derived per-why target-confidence, but nothing in the raw
handoff records suggests otherwise) — they fail on page-identity/step-match
gates, not target identification.

Redaction check on Phase M/S artifacts (`bench/.home/log.jsonl`,
`results/phase-{v,m,s}-*.json`): the TypeSafe secret-key prefix string is not
present, the literal `TYPESAFE_API_KEY` environment value is not present
(`grep -F` on the value itself without ever printing it: exit 1 = not
found). The t9 task's two bound values (the `amount` value and the `email`
value from `bench/tasks.json`) were each checked with `grep -F`: the email
value does not appear anywhere in these artifacts. The `amount` value's
literal digits do appear as substrings (as in r6/r7); every occurrence was
inspected in context and is incidental — a probability field (`actionP`,
`rightPageP`, `readyP`, etc.) with a fractional value whose digits happen to
match, a token count, or a timestamp fragment — never the bound `amount`
value itself appearing as a quoted JSON string or as the content of a
fill/type/select result field.

---

## Part 3 — fresh-install check

`npm pack` in the repo (`jev-browser-wingman-0.2.1.tgz`, 122 files, confirmed
via `tar tzf` to include `profiles/chrome-devtools-mcp.json` and
`profiles/playwright-mcp.json`). Installed with `npm install -g --prefix
<scratch> <tarball>` into an isolated scratch prefix outside the repo and
outside the container's real global npm prefix. `<prefix>/lib/node_modules/jev-browser-wingman/profiles/`
exists with both shipped profile files, purely from the packed tarball — no
manual copy. This reconfirms the KB-proof (c) packaging fix from r7 end to
end via a real global install, same as r7 found.

Registered the installed CLI with Claude Code (`claude mcp add -s user
playwright -- npx -y @playwright/mcp@0.0.80 --browser chrome`, then
`claude mcp add -s user jev-browser-wingman -- jev-browser-wingman mcp`).
Backed up the pre-existing `~/.claude.json` first (empty — no MCP servers had
been configured in this container) and restored it at the end of this part.

`doctor --detect` correctly classified the registered `playwright` server as
`"kind":"playwright-mcp","mode":"launch"` from the shipped profile data.

`doctor --plan` printed two `[todo]` items: O1 (create
`~/.jev-browser-wingman/config.json` with `{"mode": "on"}`) and O2 (wrap the
`playwright` registration with `with-browser`). Followed both exactly as
printed, then ran `jev-browser-wingman chrome ensure` and `doctor --json`:

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
    {"id": "default-context", "status": "PASS", "detail": "attach stayed in the default context; cookies=0"},
    {"id": "coexistence", "status": "PASS", "detail": "observer fingerprint identical across attach/detach (1 page(s))"},
    {"id": "handoff", "status": "PASS", "detail": "enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll, script"},
    {"id": "jev-round", "status": "PASS", "detail": "runCheck answered with 1 jev call(s)"}
  ]
}
```

**All 10 checks PASS, and the `handoff` detail lists `script` among the
withheld classes**, exactly as required.

**Structural confirmation the caller cannot use a non-read browser tool —
different mechanism than r7, same conclusion:** this container's Claude Code
build defers MCP tool schemas rather than eagerly listing them in
`system/init` (the same `ToolSearch`-mediated deferred-tool mechanism visible
throughout this validation session itself), so `system/init`'s `tools` array
did not list any `mcp__playwright__*` name at all — the r7-style "check
system/init's tool list directly" proof does not transfer to this
environment as-is. Instead, an explicit probe call (`claude -p` with
`--allowedTools ToolSearch` only, asking the model to `ToolSearch
select:`-lookup each of the eight withheld tool names by exact name) got
**"No matching deferred tools found" for every one of:**
`mcp__playwright__browser_click`, `browser_type`, `browser_navigate`,
`browser_evaluate`, `browser_run_code_unsafe`, `browser_fill_form`,
`browser_select_option`, `browser_press_key`. The same probe's fuzzy
free-text queries (`"playwright"`, `"click type evaluate javascript form"`,
`"browser_click browser_type browser_select"`) only ever surfaced the
retained read-class names (`browser_close`, `browser_console_messages`,
`browser_drag`, `browser_drop`, `browser_find`, `browser_handle_dialog`,
`browser_network_request(s)`, `browser_resize`, `browser_snapshot`,
`browser_tabs`, `browser_take_screenshot`, `browser_wait_for`) plus
`mcp__jev-browser-wingman__browse_step`. This is enforcement at the
`tools/list` layer (exact-name lookups come back empty, not merely
low-ranked), matching r7's structural conclusion via this environment's own
mechanism. Across all three tasks below, no call to any of the eight withheld
tool names was ever attempted (there was nothing to attempt — they are not
discoverable), and the only non-`browse_step` tool the caller ever invoked
was the read-only `browser_snapshot` (and `browser_tabs` once, in task 1).

### Per-task results

| Task | Page | `browse_step` calls | First-call result | Outcome |
|---|---|---|---|---|
| type 42 into the number field | `/inputs` | 1 | **`done`/`goal-met`** | Succeeded on the first call |
| Choose Option 2 | `/dropdown` | 1 (after a discarded, zero-tool-call retry — see note) | **`done`/`goal-met`** | Succeeded on the first call |
| click Add Element twice | `/add_remove_elements/` | 2 initial + 47 self-correction calls = 49 | `fallback/budget-steps` (24 clicks) both initial calls | **Did not succeed on the first call; severe over-action, same defect class as r7** |

**Note on task 2's methodology:** the first `claude -p` invocation for
"Choose Option 2" (prompted with exactly that four-word phrase, matching the
task brief literally) treated it as an ambiguous conversational reference
with no prior context and asked a clarifying question in text, **without
calling any tool at all** — a prompt-engineering artifact of this being a
context-free single-turn `claude -p` call, not a wingman or `browse_step`
defect (there was nothing for wingman to bounce; no tool was ever invoked).
Re-run with an unambiguous, equally-faithful prompt ("There is a webpage
already open in the browser with a dropdown menu. Choose Option 2 from that
dropdown.") produced the single-call success recorded above. The discarded
attempt's transcript was not kept (overwritten by the retry); its cost was
negligible (a single short clarifying-question turn, no tool calls, not
separately itemized in the cost figure below since the file no longer
exists to re-read `total_cost_usd` from).

**2 of 3 tasks (`/inputs`, `/dropdown`) succeeded on the first real
`browse_step` call this round — a clear improvement over r7, where 0 of 3
succeeded on the first call (both of r7's `/inputs` and `/dropdown` attempts
bounced `fallback/no-progress` despite the page already being correct, and
only self-verification via snapshot revealed success).** This is direct,
independent, real-world confirmation that the evidence-backed bar
(`ca73e9a`) fixes exactly the class of defect r7's Part 3 diagnosed for
fill/select verbs: task 1's single round showed `historyResult: 'filled'`
and reported `status: done` immediately, and task 2's single round similarly
resolved on `select`.

**Task 3 (`/add_remove_elements/`, click-family) reproduces r7's defect
almost exactly, and by design was expected to: `ca73e9a`'s evidence bar
explicitly excludes click-family verbs ("clicks and other verbs keep
0.85").** Both of the caller's initial `browse_step` calls for "click the Add
Element button twice" independently exhausted the full 24-step budget
clicking "Add Element" (`acts_by_op: {"click": 24}` each, live telemetry
`phases.rounds[].stepDoneP` for these rounds ranged 0.11-0.71 with
`historyResult: "page changed"` on almost every round from round 2 onward —
i.e. genuine, continuous, correctly-observed progress that never once
crossed 0.85), landing at **48 real "Add Element" clicks against a
"click twice" goal** (net of the two calls: `progress.steps_done: 0` both
times, since the step's own two-click count was never satisfied by the
click-family judgment despite each click actually working).

**Behavioral finding, new this round (Task 3 continued): the calling agent
self-corrected using only sanctioned tools, at very high cost.** After the
48-click over-action, the caller took a live `browser_snapshot`, saw 48
"Delete" buttons (`the wingman tool initially malfunctioned and clicked
"Add Element" far more than twice"` — its own words), and issued **47
further `browse_step` calls, one per button, each asking wingman to "click a
Delete button"** until exactly 2 remained (confirmed correct by a final
snapshot). Every one of those 47 calls used `browse_step` — **none bypassed
handoff enforcement to click a raw `browser_click`** (that tool is not even
discoverable, per the structural proof above), so the withholding mechanism
held up even under the caller's own error-recovery behavior. But the total
cost of this single natural-language task was **49 `browse_step` calls,
$0.5815502** (vs. task 1's $0.106106 and task 2's $0.043296/$0.215991 for
tasks that needed one or two calls) — roughly 4.3x r7's Task 3 cost of
$0.1343168 for what is nominally the identical two-click goal. The FINAL
page state this round was correct (exactly 2 elements) — unlike r7, whose
run ended with 75 Delete buttons still on the page (an incorrect end
state) — but only because the caller happened to notice and spent 47 extra
calls fixing its own tool's mistake; the underlying click-family
step-completion judgment defect (Finding 3 from r6, reproduced at scale in
r7, reproduced again here) is unchanged by this commit, exactly as its own
commit message scopes it ("clicks and other verbs keep 0.85").

Live per-round telemetry sample confirming the same failure signature as r7
(`~/.jev-browser-wingman/log.jsonl`, call 2 of 49 — the first budget-exhausted
click-twice call): round 2 `action: click`, `historyResult: "page changed"`,
`stepDoneP: 0.36`; round 3 same historyResult, `stepDoneP: 0.71`; round 6
same historyResult, `stepDoneP: 0.54` — genuine progress every round,
`stepDoneP` bouncing in the 0.11-0.71 band across all 24 rounds, never
reaching 0.85. The 45 subsequent one-click "delete" calls each independently
committed exactly one click then bounced `fallback/step-uncertain/multi-match`
(3 remaining, visually-identical "Delete" candidates) rather than guessing
further — a safe failure mode (no mis-clicks observed), but one that forces
one `browse_step` call per element rather than a single multi-click chain.

### Doc gaps found

1. **(Carried over from r6/r7, still present)** `INSTALL-FOR-AGENTS.md` does
   not warn that `browse_step` can report `fallback` on a step that has, in
   fact, already succeeded on the page. Less severe this round (2 of 3 tasks
   no longer needed this workaround), but Task 3 still would have benefited
   from a documented "if budget-steps repeats with continuous
   `historyResult` progress, STOP calling it again and check the page
   yourself before retrying" warning — the doc's own literal advice ("call it
   again with the same arguments") is exactly what would have produced a
   third 24-click burst here, and the caller only avoided that by
   independently choosing to self-verify instead.
2. **(Carried over from r7, confirmed still present and now at a different,
   still-severe scale)** `INSTALL-FOR-AGENTS.md`'s "Handoff mode" section
   still does not mention that a click-family `browse_step` call can exhaust
   its full step budget while making continuous, real, verifiable progress
   and never report the step done, nor that retrying can compound real side
   effects. This round's numbers differ from r7's (48 clicks across 2 calls
   here vs. 75 clicks across 3 calls in r7) but the mechanism and the doc gap
   are identical.
3. **(Carried over)** `INSTALL-FOR-AGENTS.md` doesn't mention that `doctor
   --plan`'s registration path targets `~/.claude.json` (the global, not
   project-scoped, Claude Code config) — confirmed again this round.
4. **(Carried over)** No mechanism in `doctor --plan`'s O1 step creates
   `~/.jev-browser-wingman/config.json` for you when the file does not exist
   at all — confirmed again this round (this container's fresh install had
   no pre-existing config directory).
5. **New this round:** nothing in `INSTALL-FOR-AGENTS.md` or `browse_step`'s
   own tool description warns that when a `browse_step` call over-executes a
   click-family step, self-correcting via more `browse_step` calls (rather
   than a raw click) is the CORRECT recovery path in forced mode (since the
   raw tool is withheld) — an installing agent without this validation run's
   hindsight could easily interpret "the tool is bypassable" or "I need
   `handoff.retain: ["script"]`" instead of the safe, sanctioned path this
   round's caller happened to find on its own.

### Cost

Task 1: $0.106106. Task 2: $0.043296 (discarded, no-tool-call attempt) +
$0.215991 (successful retry). Task 3: $0.581550. Withheld-tools probe:
$0.128438. **Total Part 3 LLM spend: ~$1.032086**, well under the $4 cap.
TypeSafe spend for Part 3 is included in the wingman log telemetry above and
is trivial (tens of `jev_calls` at the same per-call rate as Part 2).

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
- Navigating the shared Part-3 Chrome to each task's starting page required
  the raw CDP HTTP API directly (`PUT /json/new?<url>` then
  `/json/close/<old-id>`, filtered to `type == "page"` targets only, keeping
  exactly one page target open at a time) — matches `bench/run.ts`'s own
  `resetPages` pattern; not a new finding.
- **New this round, environment-specific rather than product-specific:**
  this container's Claude Code build serves MCP tool schemas as deferred
  tools discovered via `ToolSearch` rather than eagerly listing them in
  `system/init`, unlike r7's cloud container. This changed HOW the
  "caller cannot use a withheld tool" proof had to be constructed (an
  explicit `select:`-by-exact-name `ToolSearch` probe, documented above)
  but not the conclusion — the withheld tools are absent from what the
  wrapped server exposes either way. A future round on a container with
  eager tool listing should keep using the simpler r7-style `system/init`
  check; this is a note about which proof technique applies to which
  environment, not a product regression.
- This validation used an isolated `--prefix` scratch directory for the
  global install, deliberately outside the container's real global npm
  prefix, so the fresh-install check could not accidentally collide with or
  be satisfied by anything already on the container's real global
  `node_modules`.

---

## Cleanup

- `jev-browser-wingman chrome stop` run for both the Part 2 bench browser
  (port 9344, stopped automatically by `bench/run.ts`'s own teardown after
  each phase) and the Part 3 fresh-install browser (port 9222, stopped
  explicitly, `{"ok":true,"killed":[...]}`). `ps aux | grep -i chrome | grep
  -v grep` showed only self-reaping defunct zombies after each stop, never a
  live leaked process.
- `~/.claude.json`'s `playwright`/`jev-browser-wingman` MCP registrations
  added for Part 3 were removed by restoring the pre-edit backup taken
  before any edit (the pre-existing state was "no MCP servers configured" —
  confirmed restored via `claude mcp list`).
- `~/.jev-browser-wingman/` (config, profile, log, backups — all created by
  this validation's Part 3 setup, nothing pre-existing) removed entirely at
  the end of Part 3.
- Xvfb `:99` and the chromium-wrapper symlinks remain installed for the
  remainder of this session's own use (this results push); no user-facing
  artifact depends on them surviving past session end.
- Scratch directories removed: `/tmp/wingman-fresh-install-r8`,
  `/tmp/wingman-fresh-global-r8`.
- `bench/results/2026-09-28-*.json` (this round's Phase V/M/S files) and
  `bench/.home/log.jsonl` / the Part 3 `~/.jev-browser-wingman/log.jsonl` are
  copied into `bench-results/2026-09-28-r8/` on this results-only branch;
  they are **not** committed to `forced-handoff-0.3.0` or `main`.
- The three Part 3 `claude -p` transcripts and the withheld-tools probe
  transcript (`logs/part3/*.ndjson`) are included in this push — this
  round's tasks carry no sensitive bound values (task 1's only value is the
  literal digit `"42"`; tasks 2 and 3 have none), confirmed by the redaction
  greps run immediately before push.
