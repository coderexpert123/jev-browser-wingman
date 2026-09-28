# jev-browser-wingman 0.3.0 ("forced handoff") — Round 9 validation

Branch under test: `forced-handoff-0.3.0` @ `3a82301` (HEAD exactly; a descendant
of `main` confirmed via `git fetch origin && git checkout forced-handoff-0.3.0`,
`git rev-parse HEAD` = `3a82301355bfd328c790417c6acfa46c1c0de25`).

Round 8 reference: `ca73e9a`, `bench-results/2026-09-28-r8/results.md` (branch
`bench/forced-0.3.0-results-r8`). Round 8 was the best round so far on the
forced-verdict gating checks: suite green, forced 3/3, picks pass, but
forced-verdict still FAIL (handoffs and median-steps missed). Commit `3a82301`
(this round's subject) adds deterministic repeat-count evidence for explicit
"once/twice/thrice/N times" click-family steps, and wraps with-chrome's
W1–W19 cleanup in `finally` (to fix r8's KB-proof (b) hang).

Environment: cloud Linux container, Xvfb `:99`,
`bench/cloud/chromium-wrapper.sh` installed at
`/usr/local/bin/chromium-wrapper.sh`, symlinked from `/usr/bin/chromium` and
`/opt/google/chrome/chrome`, `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**No `src/`, `tests/`, `bench/forced-verdict.ts` thresholds, `profiles/` or
fixtures were edited outside the two sanctioned, temporary KB-proof flips in
Part 1.** Each was restored via `git checkout` and `git status --short`
confirmed clean immediately after. Final `git status --short` for the tracked
source tree at the end of Part 1: empty (the only untracked artifacts for the
remainder of the session were bench result JSONs, which this report pushes
separately and never commits to `forced-handoff-0.3.0`).

---

## Part 1 — full test suite: PASS

`npm ci && npm run build` → `BUILD: ok out=dist files=107`. `npx tsc --noEmit`
→ exit 0.

All 51 `tests/*.test.ts` files run individually via
`node scripts/run-tests.mjs <basename>`, strictly sequential, one
Chrome-launching run at a time. After every run, live (non-defunct) Chrome
processes were checked; none were ever left running between files (the
detection script's first pass had a false-positive pattern that matched its
own shell scripts rather than real Chrome — corrected mid-run, and a
retroactive check against the corrected pattern showed all prior runs had
been clean too).

| # | file | result | # | file | result |
|---|------|--------|---|------|--------|
| 1 | acquire | pass 6/6 | 27 | log | pass 3/3 |
| 2 | adapter-cdp | pass 8/8 | 28 | loop | pass 36/36 |
| 3 | adapter-playwright | pass 7/7 | 29 | mcp-server | pass 14/14 |
| 4 | bench-browse | pass 26/26 | 30 | outcome-evidence | pass 26/26 |
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

**Aggregate: 51/51 files fully green. Individual tests: 685 total, 684 pass, 0
fail, 1 skip.** The one skip is `chrome-cmd`'s window-position test, `# SKIP
win32 only` — the one acceptable non-pass per the task brief. No file needed
a re-run; no failures were observed on the first pass of any file.
`outcome-evidence.test.ts` grew from r8's 19 tests to 26 (this commit's own
new WP-count-* repeat-evidence tests).

### Gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` → `LAZY-CHROME: ok
  listed=24 chrome=0 answered=false` (exit 0).
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` →
  `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (exit 1) — caught
  correctly.

### KB-proof (a): `hasRepeatCountEvidence` forced to always return `false` → outcome-evidence WP-count-a/b/f must fail

Mutated `src/core/loop.ts`'s `hasRepeatCountEvidence` to `return false;` as
its first statement (dead code below; the build raised no TS error —
`allowUnreachableCode` is not tightened in this project's `tsconfig.json`).
Built into a separate `.build/kb-proof-a` (`node scripts/build.mjs --out
.build/kb-proof-a tests/outcome-evidence.test.ts`), ran `outcome-evidence`
against it:

```
not ok 20 - WP-count-a: chain step "click the Add button twice" advances after exactly 2 clicks (count evidence, no threshold)
not ok 21 - WP-count-b: chain step "click the Add button 3 times" advances after exactly 3 clicks
not ok 25 - WP-count-f: legacy/single browse_step "click the Add button twice" ends done/goal-met after exactly 2 clicks
# tests 26, pass 23, fail 3
```

**Exactly the three named tests fail, all 23 others (including the
pre-existing evidence-bar tests from r8, which don't depend on this
function) still pass.** Restored via `git checkout -- src/core/loop.ts`;
`git status --short` empty afterward. `.build/kb-proof-a` removed.

### KB-proof (b): with-chrome.ts batch arrays skip `tools/list` filtering → W7b must fail — **confirmed, and r8's hang is fixed**

Mutated `handleChildLine` in `src/cli/with-chrome.ts` so the
`Array.isArray(parsed)` branch forwards every batch line unchanged
(`stdout.write(rawLine); return;`), removing the per-element `tools/list`
filtering loop, matching the exact recipe r8 used. Built into
`.build/kb-proof-b` (`node scripts/build.mjs --out .build/kb-proof-b
tests/with-chrome.test.ts`), ran `with-chrome` against it through
`node scripts/run-tests.mjs --dist .build/kb-proof-b with-chrome` — **unlike
r8, this completed cleanly in ~4 seconds through the normal buffered runner,
with no hang.**

```
not ok 19 - W7b: forced — a batched tools/list response is filtered (withheld tools absent)
not ok 20 - W7c: forced — activeProfile populated from a batched tools/list lets a later plain tools/call classify correctly
# tests 32, pass 30, fail 2
```

**Exactly the two batch-dependent tests fail; the other 30 subtests in the
file are unaffected**, matching r8's finding of what fails. **The
process-hang side effect r8 reported (the same mutated build never printing
a final TAP summary or exiting, requiring a `--test-reporter=tap` +
`timeout 90` workaround) did NOT reproduce this round.** This is direct,
positive evidence that this round's stated `finally`-wrap fix to
with-chrome's W1–W19 cleanup (part of commit `3a82301`'s scope per the task
brief) resolved the hang r8 diagnosed as a leaked resource/open handle from
an assertion thrown before cleanup ran. Restored via `git checkout --
src/cli/with-chrome.ts`; `git status --short` empty afterward.
`.build/kb-proof-b` removed. Final `npm run build` into the real `dist/`
confirmed clean (`BUILD: ok out=dist files=107`) and `git status --short`
was empty before Part 2.

**Part 1 verdict: fully green.** All 51 files, both gates, and both
KB-proofs behaved as specified, and one r8 finding (the KB-proof (b) hang)
is confirmed fixed.

---

## Part 2 — forced-handoff benchmark (task: t9-long-chain)

Ledger before this part: **$5.814594** across the 7 pre-existing files in
`bench/results/` (identical to r8's starting ledger — the same 7
2026-09-22-dated files, no rotation since r8).
`--phase-cap-usd 20.814594` (= history + $15) used for every call in this
part. `--cap-usd 3.00` per run.

### Phase V — validity (playwright x3, gate off + policy off)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes playwright --repeats
3 --purpose measure`

| # | ok | wall | usd |
|---|---|---|---|
| 1 | true | 50.8s | 0.826491 |
| 2 | true | 43.3s | 0.710922 |
| 3 | true | 49.7s | 0.766748 |

Validity bar: 3/3 ≥ 2/3 required → **PASS**. Spend: $2.304161.

*(Note: `dist/bench/run.js`'s stdout is fully buffered when piped rather than
line-buffered, so no interim output streamed while the command ran; the
process itself completed cleanly and the results file was inspected
directly afterward. This affected observability only, not correctness —
noted here since it cost debugging time and isn't in the CLAUDE.md gotchas
list yet.)*

### Phase M — measure (forced x3 AND playwright x3, interleaved, gate off + policy off, `--purpose measure`)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00
--phase-cap-usd 20.814594 --tasks t9-long-chain --routes forced,playwright
--repeats 3 --purpose measure`

| # | route | ok | wall | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | **false** | 223.8s | 1.223608 | 16 | 13 | 39 | 0 | 0 |
| 2 | playwright | true | 45.1s | 0.717384 | 0 | 0 | 0 | 17 | 0 |
| 3 | forced | true | 191.4s | 0.931477 | 21 | 11 | 43 | 0 | 0 |
| 4 | playwright | true | 46.6s | 0.740678 | 0 | 0 | 0 | 17 | 0 |
| 5 | forced | true | 125.1s | 0.734288 | 14 | 10 | 30 | 0 | 0 |
| 6 | playwright | true | 48.3s | 0.936487 | 0 | 0 | 0 | 18 | 0 |

Spend: $5.283922. **Forced went 2/3 this round — a regression from r8's
3/3.** `raw_acts` is 0 across every forced run and `raw_script` is 0 across
every run — no bypass, unchanged from r8.

**forced run 1 (`ok=false`) diagnosis:** its last 3 of 16 handoffs are
IDENTICAL — same `status: fallback/step-uncertain`, `why: not-ready`,
`candidates: 0`, `progress: {step_index:1, steps_done:0, steps_total:2}` —
meaning the calling agent kept re-issuing `browse_step` on the SAME final
chain step (the last two clauses: Dynamic Loading → Start button, and Status
Codes → 404 link) and Jev found **zero candidates** every time, never
advancing. The run's `tool_use_counts` show exactly 16 `browse_step` + 12
`browser_snapshot` + 2 `ToolSearch` = 30 tool calls, matching
`bench/config.json`'s `route_max_turns.forced: 30` exactly — the calling
model hit its own turn cap while stuck oscillating, which is what made the
run end without reaching the oracle. This is a genuine stuck-oscillation
failure inside Phase M itself (not just the smoke-only pattern r7's Phase S
showed), and is new this round.

**`forced-verdict` verbatim (default mode, over `phase-m-measure.json`):**

```
FORCED-VERDICT: completion forced=2/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=21
FORCED-VERDICT: picks 34/51
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 1.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=7 no-match=10 no-progress=3 not-ready=17 wrong-page=5
FORCED-VERDICT: overall FAIL
```

**Bars missed (4 of 9 gating checks — a regression from r8's 2/9, back to
the r5/r6/r7 pattern): completion** (2/3 < playwright's 3/3),
**handoffs** (max=21, every run's count must be in [1,4]; all three forced
runs — 16, 21, 14 — are far outside the range), **picks** (34/51 = 66.7%;
the `2*picks < handoffs` bar requires 68 < 51, which fails), and
**median-steps** (1.00, bar needs >= 4). Passing cleanly: wingman-share
(1.00), raw-acts (0), zero-step-done (0), first-call-success (3/3),
no-page-error-end (0). `raw-script` (0, informational) stays fixed.

**A missed bar is the finding, per the task brief — this round's numbers are
worse on 3 of the 4 previously-improving-or-mixed metrics (completion,
picks, median-steps) than r8, and roughly back to the r5/r6/r7 shape.** With
n=1 per route this could be cell-level variance (as documented throughout
this project's history — e.g. the 2026-09-22 load-sensitivity gotcha), but
it is a real regression on the data actually measured this round, not an
artifact of a broken measurement.

### Phase S — smoke (one forced cell, gate ON)

`BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 3.00 --phase-cap-usd
20.814594 --tasks t9-long-chain --routes forced --repeats 1`

```
FORCED-VERDICT: smoke ok=true needs_confirmation=7
```

Run: wall=178.5s, usd=1.020644, handoffs=17, picks=1, wingman_acts=31.
**`ok=true`, same as r8 (not r7's stall).** The handoff sequence shows a
partial reproduction of r7's oscillation pattern that r8 didn't show: 4
consecutive `needs_confirmation/irreversible-heuristic` handoffs (#2–#5) all
at the identical `{step_index:2, steps_done:1, steps_total:6}`, and 2 more
consecutive repeats at the same point later (#10–#11: `irreversible-jev`
then `irreversible-heuristic`), interleaved with `fallback/step-uncertain`
bounces (`wrong-page`, `no-match`, `not-ready`). Unlike r7 this **self-
resolved** — the run continued past that point and ended
`done/goal-met` at handoff 17. `progress.steps_total` also grew from 6 to 8
partway through (handoffs #7–#8), the same "caller restarts with a
different-sized remaining-step list" pattern r7/r8 both documented.

**Part 2 total fresh spend: $8.608727 of the $15 cap for this part**
(V $2.304161 + M $5.283922 + S $1.020644).

### Comparison: r5 vs r6 vs r7 vs r8 vs r9

| Metric | r5 (`c50d955`) | r6 (`231256b`) | r7 (`2a05d34`) | r8 (`ca73e9a`) | r9 (`3a82301`, this round) |
|---|---|---|---|---|---|
| Forced completion | 1/3 | 2/3 | 2/3 | 3/3 | **2/3** |
| Median steps/handoff | 2.00 | 1.00 | 1.00 | 2.00 | **1.00** |
| Handoffs max | 16 | 17 | 15 | 14 | **21** |
| Picks | 26/42 (61.9%) | 31/50 (62.0%) | 24/41 (58.5%) | 18/37 (48.6%) | **34/51 (66.7%)** |
| Forced wall (median of 3) | 223.9s | 209.9s | 172.6s | 161.3s | **191.4s** |
| Playwright wall (median of 3) | 72.4s | 72.6s | 72.6s | 76.5s | **46.6s** |
| `raw-script` (bypass count) | 2 | 2 | 0 | 0 | **0** |
| `forced-verdict` overall | FAIL | FAIL | FAIL | FAIL (2/9 missed) | **FAIL (4/9 missed)** |
| Bars missed | (not itemized) | completion, handoffs, picks, median-steps | completion, handoffs, picks, median-steps | handoffs, median-steps only | **completion, handoffs, picks, median-steps** |
| Part 2 total spend | $8.560461 | $8.531863 | $8.012889 | $8.332370 | **$8.608727** |

**Honest read: this round is a regression on the forced-verdict gating
checks relative to r8**, reverting from 2 missed bars back to 4 — the same
count as r5/r6/r7. Completion, picks and median-steps all moved the wrong
direction versus r8; only playwright's own wall time improved noticeably
(76.5s → 46.6s), which is route-independent (playwright never touches
wingman) and most likely reflects normal cell-level/host-load variance
rather than anything this round's commit changed. The one clear win this
round is the with-chrome hang fix (Part 1, KB-proof (b)) and — per the
Part 2 telemetry below — the countEvidence mechanism did fire cleanly twice
within Phase M's own chain-mode calls, but that was not enough to prevent
the stuck-oscillation failure that sank forced run 1's completion.

### Telemetry (from `bench/.home/log.jsonl`; 51 records, all Phase M
`browse_step`/forced-route calls — playwright-route runs never call
wingman and contribute 0 records; Phase S's log was captured separately)

**Call-start step-count split:** 1 of the 51 Phase M calls started with
`steps_total == 1` (a single-step ask); 49 started with `steps_total > 1`;
1 call (`error/invalid-input`) carried no `progress` field at all.

**stepDoneP on rounds that crossed an advance bar** (any round — not just a
call's last round, since chain mode can advance multiple clauses within one
call — where `stepDoneP >= 0.85`, OR `action === 'none'` with `stepDoneP >=
0.5`, OR the fill/select/check/uncheck evidence bar (`0.5 <= stepDoneP <
0.85` with confirming `historyResult`), OR `countEvidence` fired): **n=23,
median=0.75, p25=0.62, p75=0.90, min=0.54, max=0.94.**

**stepDoneP on rounds with real, non-neutral observed progress
(`historyResult` not `undefined`/`'no visible change'`/`'element gone'`)
that did NOT cross an advance bar: n=44, median=0.10, p25=0.06, p75=0.21,
min=0.05, max=0.84.** The gap between the two populations (median 0.75 vs
0.10, ~7.5x) is comparable to r8's 0.87 vs 0.11 gap (~8x) — the underlying
judgment gap for non-advancing rounds is essentially unchanged.

**Advance paths, of the 23 advancing rounds: 0.85-bar=8 (35%), no-action-bar
(`action:'none'` @ >=0.5)=4 (17%), evidence-bar (fill/select/check/uncheck
@ 0.5–0.85)=9 (39%), countEvidence=2 (9%).** The evidence-bar mechanism
(r8's own fix) is doing proportionally MORE work this round than in r8
(39% vs r8's 24%), and the new countEvidence mechanism fired cleanly twice.

**countEvidence firings in Phase M (n=2), both clean, both for the "click
the Add Element button twice" clause specifically:**

| ts | call `steps` field | round | countEvidence | stepDoneP | context |
|---|---|---|---|---|---|
| 06:14:31.322Z | 2 | 3rd round | 2 | 0.92 | call ended `fallback/wrong-page` on ITS NEXT clause, but the "click twice" clause itself advanced cleanly (steps_done went 2→3) before the call bounced on the following step |
| 06:17:46.332Z | 3 | 4th round | 2 | 0.90 | same shape: `acts_by_op: {navigate:1, click:2}`, steps_done advanced 0→1 via exactly 2 clicks, call then bounced `wrong-page` on the step after |

**In both cases the click-family evidence mechanism worked exactly as
designed: exactly 2 clicks satisfied "twice" and the chain advanced past
that clause with no over-click storm — the call's overall `why:wrong-page`
reflects a LATER, unrelated clause the same call also attempted, not a
recurrence of the click-count defect.** This is a genuine positive result
for the new mechanism *when the calling model embeds the count word inside
a single chain clause*, as the bench prompt does. See Part 3 below for a
contrasting real-world case where the calling model split the same
instruction differently and the old defect reappeared in full.

**Premature-advance check:** none found in Phase M. Both successful forced
runs (2, 3 — 0-indexed 2 and 4 in the results file) ended `done/goal-met` as
their last handoff with no further handoffs needed, and both finished
`ok=true`. Run 1 never reached `done` at all (see diagnosis above), so
there is no premature-advance case to report for it either.

### Why-breakdown detail (Phase M, call-level; step text is not logged by
design — `step_review` carries only `why`/`candidates`, and per-round
history entries never carry label/value text — so the columns below use
`progress.step_index`/`steps_total` and the LAST round's decided action as
the closest directly-observable proxy for "which clause, doing what";
mapping `step_index` to the 7-clause English goal text is an inference, not
a logged fact)

| why | n (r8) | n (r9) |
|---|---|---|
| not-ready | 12 | **17** |
| no-match | 9 | **10** |
| wrong-page | 5 | 5 |
| low-confidence | 2 | **7** |
| no-progress | 1 | **3** |

All five buckets grew or held flat versus r8; `not-ready` and
`low-confidence` grew the most in absolute terms. Full per-occurrence detail
(`step_index`/`steps_done`/`steps_total`/last round's `action`/`stepDoneP`)
is in `log-phase-m.jsonl` alongside this file; representative samples:

- **not-ready (n=17, largest bucket):** almost entirely `step_index:1` calls
  with `last_action: click` and `last_stepDoneP` in the 0.05–0.22 range —
  i.e. calls that never got past deciding whether to act at all on the
  chain's current clause. Two outliers reached stepDoneP 0.70/0.75 with
  `check`/`wait` actions before still bouncing not-ready.
- **no-match (n=10):** `last_action` is `click`/`check`/`wait`, `target1:
  none` in 8/10 — Jev could not resolve a target this round, consistent
  with "no-match" meaning "couldn't identify the element," distinct from
  wrong-page's "identified nothing because we're on the wrong screen."
- **wrong-page (n=5):** `last_action` is `navigate` in 3/5, `click` in 2/5 —
  the chain had progressed (`steps_done` 1–3) then found itself needing a
  page transition it couldn't complete cleanly.
- **low-confidence (n=7, up sharply from r8's 2):** a mix of `navigate`,
  `back`, `click`, `wait`, `check` as the last action, `stepDoneP` spanning
  0.06 to 0.73 — no single action type dominates.
- **no-progress (n=3):** all three are `fill` actions with `stepDoneP` 0.38,
  0.54, 0.65 — the no-progress guard correctly caught a repeated identical
  fill act, consistent with its documented design.

Redaction check on Phase M/S artifacts (`log-phase-m.jsonl`,
`log-phase-s.jsonl`, `phase-{v,m,s}.json`): the TypeSafe secret-key prefix
string is not present, the literal `TYPESAFE_API_KEY` environment value is
not present. The t9 task's two bound values (from `bench/tasks.json`, an
amount and an email address — not restated here, per the same grep-abort
discipline used before pushing) were each checked with `grep -F`: the email
value does not appear anywhere; the amount's digits appear only as
incidental substrings of `usd`/`per_step_ms`/token-count fields, never as
the bound value itself in a fill/type/select result field.

---

## Part 3 — fresh-install check

`npm pack` in the repo (`jev-browser-wingman-0.2.1.tgz`, 122 files, confirmed
via `tar tzf` to include `profiles/chrome-devtools-mcp.json` and
`profiles/playwright-mcp.json`). Installed with `npm install -g --prefix
<scratch> <tarball>` into an isolated scratch prefix outside the repo and
outside the container's real global npm prefix.
`<prefix>/lib/node_modules/jev-browser-wingman/profiles/` exists with both
shipped profile files, purely from the packed tarball.

Registered the installed CLI with Claude Code (`claude mcp add -s user
playwright -- npx -y @playwright/mcp@0.0.80 --browser chrome`, then
`claude mcp add -s user jev-browser-wingman -- jev-browser-wingman mcp`).
Backed up the pre-existing `~/.claude.json` first (no MCP servers had been
configured in this container — `mcpServers` key absent) and restored it
byte-for-byte at the end of this part (verified `mcpServers` key absent
again after restore).

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
    {"id": "config-loaded", "status": "PASS"},
    {"id": "registration-portable", "status": "PASS", "detail": "2 registration(s) portable"},
    {"id": "policy-loaded", "status": "PASS"},
    {"id": "profile-safe", "status": "PASS"},
    {"id": "adapter-attach", "status": "PASS", "detail": "attached to http://127.0.0.1:9222; 1 page(s)"},
    {"id": "default-context", "status": "PASS", "detail": "attach stayed in the default context; cookies=0"},
    {"id": "coexistence", "status": "PASS"},
    {"id": "handoff", "status": "PASS", "detail": "enforced by proxy: playwright (playwright-mcp); withheld classes: element-act, type, select, key, hover, upload, navigate, back, scroll, script"},
    {"id": "jev-round", "status": "PASS", "detail": "runCheck answered with 1 jev call(s)"}
  ]
}
```

**All 10 checks PASS, `script` is among the withheld classes.**

**Structural confirmation the caller cannot use a non-read browser tool:**
ran a dedicated probe (`claude -p` with `--allowedTools ToolSearch` only,
asking the model to `ToolSearch select:`-look-up each of 8 withheld tool
names by exact name). **"Not found" for 7 of 8**
(`browser_click`, `browser_type`, `browser_navigate`, `browser_evaluate`,
`browser_fill_form`, `browser_select_option`, `browser_press_key`); the 8th,
`browser_drag`, WAS found — correctly, since `drag` is one of the classes
that "always stay with the caller" per `INSTALL-FOR-AGENTS.md`'s Handoff
Mode section (never withheld, so this is not a leak). A fuzzy query for
"click type evaluate javascript form" surfaced only
`mcp__jev-browser-wingman__browse_step` and an unrelated tool, never a raw
playwright mutating tool. A full listing (surfaced once `browser_drag`
loaded the rest of that server's tool set) showed only the retained
read/tabs/dialog-class names (`browser_close`, `browser_console_messages`,
`browser_drop`, `browser_find`, `browser_handle_dialog`,
`browser_network_request(s)`, `browser_resize`, `browser_snapshot`,
`browser_tabs`, `browser_take_screenshot`, `browser_wait_for`) — this
matches r8's structural conclusion (enforcement at the `tools/list` layer,
not merely low ranking) via the same `ToolSearch`-mediated deferred-tool
mechanism this validation session itself runs under.

**Independent verification (not just the calling agent's self-report):** for
task 3 below, the final "Delete" button count was checked directly via a raw
CDP `Runtime.evaluate` call against the live page
(`document.querySelectorAll('.added-manually').length`) — returned `2`,
confirmed correct.

### Per-task results

Each task was preceded by navigating the shared Chrome (port 9222) to its
starting page using the raw CDP HTTP API (`PUT /json/new?<url>`, verify the
new page target exists, then `/json/close/<old-id>` — creating the new
target BEFORE closing the old one; closing the browser's only target first
crashes the whole Chrome process, which happened once during setup and was
corrected).

| Task | Page | `browse_step` calls | First-call result | Outcome |
|---|---|---|---|---|
| type 42 into the number field | `/inputs` | 1 | **`done`/`goal-met`** | Succeeded on the first call |
| Choose Option 2 from the dropdown | `/dropdown` | 1 | **`done`/`goal-met`** | Succeeded on the first call |
| Click the Add Element button twice | `/add_remove_elements/` | 1 initial + 23 self-correction calls = 24 | `fallback/budget-steps` (24 clicks) | **Did not succeed on the first call; severe over-action, same defect class as r6/r7/r8** |

**Task 1 (`/inputs`):** 1 `browse_step` call, 2 rounds. Round 2:
`action: fill`, `historyResult: "filled"`, `stepDoneP: 0.71` — the
evidence bar (0.5–0.85 with confirming `historyResult`) fired, ending
`done/goal-met`. `countEvidence`: not applicable (no repeat count named).
Cost: $0.180258.

**Task 2 (`/dropdown`):** 1 `browse_step` call, 2 rounds. Round 2:
`action: select`, `historyResult: "selected: Option 2"`, `stepDoneP: 0.96`
— the plain 0.85-bar fired. `countEvidence`: not applicable. Cost:
$0.313087. (No discarded/ambiguous first attempt was needed this round —
the unambiguous prompt succeeded cleanly on the first try, unlike r8 which
needed a prompt rewrite after an initial no-tool-call clarifying question.)

**Task 3 (`/add_remove_elements/`, click-family) reproduces the r6/r7/r8
defect, with a specific, evidenced root cause for why `3a82301`'s
countEvidence fix did not prevent it here.** The caller's FIRST
`browse_step` call used `steps` (chain mode, `progress.steps_total: 2`
at call start — a 2-clause plan). All 25 rounds targeted the identical
element (`target1: "e1"` every round, `historyResult: "page changed"`
every round after the first) yet `stepDoneP` oscillated 0.47–0.68,
never reaching 0.85, and **`countEvidence` never appeared in any of the
24 click rounds** — the call ended `fallback/budget-steps` having made
24 real "Add Element" clicks against a "click twice" goal.

**Root-cause hypothesis (evidenced, not proven — step text itself is never
logged by design, so this is inferred from the call's own narration plus
the telemetry shape):** the calling agent's own summary states *"my first
browse_step call gave it a 2-step plan without a step budget"* — i.e. the
model split "click the Add Element button twice" into **two separate
chain-step entries** (`progress.steps_total: 2` at call start) rather than
keeping the count phrase inside a single clause. `hasRepeatCountEvidence`'s
design (per `src/core/CLAUDE.md`) requires the CURRENT clause's own text to
contain a parseable count word ("twice"/"3 times"/etc.); if each of the two
split clauses reads as a bare single click ("click Add Element") with no
count word in either one individually, `parseRepeatCount` returns
`undefined` for both and the count-evidence bar can never fire for either
clause — leaving only the pre-existing, still-unreliable
`stepDoneP`-crosses-0.85 judgment to decide when a bare repeated click is
"done," which is exactly the r6/r7/r8 defect. **This contrasts directly
with Part 2's Phase M, where the bench's own fixed, scripted prompt keeps
the count phrase inside one clause and `countEvidence` fired cleanly twice**
(see Part 2 Telemetry above) — the mechanism's reliability in this round
appears to depend on how the CALLING MODEL phrases its own `steps` array
when translating free-form natural language, which is exactly the kind of
variation a real installing/using agent introduces and a fixed bench
prompt does not.

**Self-correction, using only sanctioned tools:** after the 24-click
over-action, the caller took a `browser_snapshot`, saw the page state, and
issued 23 further single-click `browse_step` calls (1 investigative
zero-act call + 22 delete-clicks) — every one of the 22 delete-clicks
independently bounced `fallback/step-uncertain/multi-match` (3 visually-
identical "Delete" candidates, once `low-confidence`) after committing
exactly one click each, the same safe-failure signature r8 documented.
**None bypassed handoff enforcement** — the raw `browser_click` tool is not
even discoverable (per the structural proof above). Final state,
independently verified via CDP: **exactly 2 "Delete" buttons**, matching
the goal. Total cost for this one natural-language task: **$1.111422**
across 24 `browse_step` calls (vs. task 1's $0.180258 and task 2's
$0.313087 for one-call tasks).

### Doc gaps found

1. **(Carried over from r6/r7/r8, still present)** `INSTALL-FOR-AGENTS.md`
   does not warn that `browse_step` can report `fallback`/`budget-steps`
   while making continuous, real, observably-progressing acts on a
   click-family step, and that retrying blindly compounds real side
   effects. This round's numbers (24 clicks in one call) are close to r8's
   scale (48 across 2 calls) and worse in a single-call sense.
2. **New this round, more specific than the carried-over gap above:**
   nothing in `INSTALL-FOR-AGENTS.md` or `browse_step`'s own tool
   description tells a calling agent HOW to phrase a step naming an
   explicit repeat count so the deterministic `countEvidence` mechanism can
   engage — specifically, that the count word ("twice"/"3 times") must
   stay inside a SINGLE chain-step entry in the `steps` array, not be
   split across two entries (e.g. two bare "click Add Element" steps).
   This round's own telemetry shows the mechanism working perfectly when
   the count stays in one clause (Part 2, Phase M) and failing completely
   when a calling model — with no guidance either way — splits it (Part 3,
   Task 3). Without this guidance in the tool description or install docs,
   a real installing/using agent has no way to know its own phrasing choice
   determines whether this defect class reproduces.
3. **(Carried over)** `INSTALL-FOR-AGENTS.md`'s "Handoff mode" section still
   does not mention that self-correcting an over-executed click-family step
   via more `browse_step` calls (never a raw click, which is withheld) is
   the CORRECT and ONLY sanctioned recovery path — an installing agent
   without this validation run's hindsight could reasonably conclude the
   tool is broken or reach for `handoff.retain: ["script"]` instead.
4. **(Carried over)** `doctor --plan`'s registration path targets
   `~/.claude.json` (the global, not project-scoped, Claude Code config) —
   not called out in `INSTALL-FOR-AGENTS.md`.
5. **(Carried over)** No mechanism in `doctor --plan`'s O1 step creates
   `~/.jev-browser-wingman/config.json` for you when the file does not exist
   at all.

### Cost

Task 1: $0.180258. Task 2: $0.313087. Task 3: $1.111422. Withheld-tools
structural probe: $0.170451. **Total Part 3 LLM spend: $1.775218**
(includes the probe), well under the $4 cap. TypeSafe spend for Part 3 is
included in the wingman log telemetry above and is trivial (tens of
`jev_calls` at the same per-call rate as Part 2).

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
- `dist/bench/run.js`'s stdout is fully buffered (not line-buffered) when
  its parent process's stdout is a pipe rather than a TTY — every phase in
  this round had to be run to completion and its results file read
  afterward, with no interim progress visible; this is a debuggability
  note, not a correctness finding, and is environment-general (would apply
  to any non-TTY invocation, cloud or local).
- Navigating the shared Part-3 Chrome to each task's starting page required
  the raw CDP HTTP API directly, matching `bench/run.ts`'s own
  `resetPages` pattern. **One operational mistake during setup**: creating
  a new page target via `GET /json/new?<url>` (the wrong HTTP verb — CDP's
  HTTP endpoint requires `PUT`) silently failed to create a page, and the
  subsequent close of the browser's only remaining target then killed the
  entire Chrome process (not just the tab). Recovered by re-running
  `chrome ensure` and redoing the navigation with the correct `PUT` verb
  and an existence check before closing the old target. Not a product
  defect — a CDP HTTP API usage error on this validator's part — but noted
  since it is a sharp edge in the exact recipe this doc's own Part 3
  section prescribes.
- Independent Delete-button-count verification used Node 22's built-in
  `WebSocket` global (no `ws` package is a project dependency) over a raw
  CDP `Runtime.evaluate` call.
