# jev-browser-wingman 0.3.0 ("forced handoff") — Round 5 re-validation

Branch under test: `forced-handoff-0.3.0` @ `c50d955` (descendant confirmed: `c50d955`
is HEAD, the commit that replaces pinned geometry with a live
`getBoundingClientRect` check). Round 4 (`3e14098`) passed 645/647 with one skip;
the only failure was `adapter-cdp` "observe matches the pinned form.html table".

Environment: cloud Linux container, no bundled Chrome binary — used the
Playwright-bundled Chromium (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`)
via `bench/cloud/chromium-wrapper.sh` (installed at `/usr/local/bin/chromium-wrapper.sh`,
symlinked from `/usr/bin/chromium` and `/opt/google/chrome/chrome`), which drops
privileges to `nobody` and adds `--ignore-certificate-errors` for the container's
TLS-reterminating egress proxy. Xvfb on `:99`. This is a **Linux-only** validation;
no Windows-specific behavior (win32 cmd-spawn quoting, `chrome-cmd`'s
`Browser.setWindowBounds` restore-then-move dance, etc.) was exercised.

Total real spend this round: **$8.560461** (Part 2) + Part 3's three `claude -p`
calls (~$0.52 combined, from their own `total_cost_usd` fields) + trivial `npm`/`tsc`/test costs
(no LLM/TypeSafe usage). Well under the $15 (Part 2) and $4 (Part 3) caps.

---

## Part 1 — full test suite

`npm ci && npm run build`: OK, `dist/` 106 files. `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: **exit 0**.

Every `tests/*.test.ts` file was run one at a time (`node scripts/run-tests.mjs <basename>`),
strictly sequential, with a Chrome sweep after each. All 50 files exited 0 on the
first try — no re-runs were needed.

| # | file | rc | duration | # | file | rc | duration |
|---|------|----|----------|---|------|----|----------|
| 1 | acquire | 0 | 0s | 26 | jev-client | 0 | 2s |
| 2 | adapter-cdp | 0 | 20s | 27 | log | 0 | 0s |
| 3 | adapter-playwright | 0 | 27s | 28 | loop | 0 | 1s |
| 4 | bench-browse | 0 | 0s | 29 | mcp-server | 0 | 48s |
| 5 | bench-cap | 0 | 0s | 30 | page-scripts | 0 | 3s |
| 6 | bench-oracle | 0 | 2s | 31 | pick | 0 | 0s |
| 7 | bounce-escalation | 0 | 1s | 32 | pick-e2e | 0 | 5s |
| 8 | boundary | 0 | 0s | 33 | plugin | 0 | 0s |
| 9 | browse-step-surface | 0 | 8s | 34 | policy | 0 | 0s |
| 10 | cdp-connection | 0 | 2s | 35 | profiles | 0 | 0s |
| 11 | chain | 0 | 1s | 36 | questions | 0 | 0s |
| 12 | chain-e2e | 0 | 35s | 37 | readme-bench | 0 | 1s |
| 13 | chrome | 0 | 11s | 38 | registrations | 0 | 0s |
| 14 | chrome-cmd | 0 | 0s | 39 | runner-sweep | 0 | 1s |
| 15 | classify-tools | 0 | 1s | 40 | runner-sweep-leak | 0 | 1s |
| 16 | cli | 0 | 4s | 41 | scaffold | 0 | 3s |
| 17 | config | 0 | 0s | 42 | settle | 0 | 3s |
| 18 | conformance | 0 | 36s | 43 | setup-plan | 0 | 1s |
| 19 | conformance-ops | 0 | 23s | 44 | takeover | 0 | 1s |
| 20 | contract | 0 | 1s | 45 | takeover-config | 0 | 0s |
| 21 | doc-safety | 0 | 0s | 46 | tokens | 0 | 0s |
| 22 | doctor | 0 | 8s | 47 | typesafe-stub | 0 | 0s |
| 23 | egress | 0 | 0s | 48 | with-chrome | 0 | 3s |
| 24 | ephemeral-sweep | 0 | 1s | 49 | with-chrome-forced | 0 | 9s |
| 25 | gate | 0 | 0s | 50 | withhold | 0 | 1s |

Full raw summary (per-file exit code, duration, chrome-sweep counts, tail of
each log): `logs/part1-test-suite-summary.tsv`.

**Aggregate `node --test` TAP totals across all 50 files: `tests 647, pass 646,
fail 0, skipped 1`.** The one skip is `chrome-cmd`'s "show and hide move the
real window on-screen and back off-screen (GetWindowRect)" — explicitly marked
`# SKIP win32 only`, the one acceptable non-pass per the task brief.

This is **one more pass than Round 4** (645→646, 0 fail both rounds, same skip
count) — consistent with `c50d955` actually fixing the previously-failing
`adapter-cdp` "observe matches the pinned form.html table" test (Round 4's sole
failure). No other regressions.

### Gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` → `LAZY-CHROME: ok listed=24
  chrome=0 answered=false` (exit 0), as expected.
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` →
  `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (exit 1), as expected —
  the known-bad injection is correctly caught.

### Known-bad proof for this round (rectOf geometry)

Mutated `src/core/page-scripts.ts` `rectOf`'s enumerate-copy `x` value (`+1`),
built into a scoped `.build/kb-proof` (via `node scripts/build.mjs --out
.build/kb-proof tests/adapter-cdp.test.ts`, since a scoped build only compiles
the entry's import graph), and ran adapter-cdp against the mutated build:

```
not ok 2 - observe matches the pinned form.html table
  error: |-
    element 0 (Full name) rect.x=73 does not equal live x=72
    73 !== 72
# tests 8, pass 7, fail 1
```

This proves `c50d955`'s live-geometry check actually discriminates a real
regression (the pinned-viewport failure mode Round 4 hit is exactly this kind
of x-offset drift, now caught against the live page instead of a stale pin).
Restored via `git checkout -- src/core/page-scripts.ts`; `git status` clean
afterward. `.build/kb-proof` was a separate scoped dir, never `dist/`, so the
main test run's dist was never poisoned by this mutation (consistent with the
CLAUDE.md "poisons scoped `.build`" gotcha — it doesn't touch `dist/`).

**Part 1 verdict: fully green.** Proceeded to Part 2.

---

## Part 2 — forced-handoff benchmark (task: t9-long-chain)

Ledger note: `bench/run.ts`'s `phaseSpentFrom` sums every `.json` in
`bench/results/` at process start. Pre-existing committed history was
**$5.814594** (7 files). `--phase-cap-usd` was set fresh before each phase as
history + intended headroom; actual new spend below.

### Phase V — validity control (playwright × 3, gate off + policy off)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 4
--phase-cap-usd 8.814594 --tasks t9-long-chain --routes playwright --repeats 3
--purpose experiment`

| task | route | ok | wall | usd |
|---|---|---|---|---|
| t9-long-chain | playwright | **true** | 81.8s | 0.890482 |
| t9-long-chain | playwright | **true** | 77.7s | 0.760394 |
| t9-long-chain | playwright | **true** | 72.2s | 0.720500 |

`FORCED-VERDICT: validity playwright=3/3` — **≥ 2/3 bar met, measurement is
valid.** Total: $2.371376.

### Phase M — measure (forced × 3 AND playwright × 3, interleaved, gate off +
policy off, `--purpose measure`)

`BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1 node dist/bench/run.js --cap-usd 4
--phase-cap-usd 18.18597 --tasks t9-long-chain --routes forced,playwright
--repeats 3 --purpose measure` (repeats × [forced, playwright] naturally
interleaves the two routes run-by-run.)

| # | route | ok | wall | usd | handoffs | picks | wingman_acts | raw_acts | raw_script |
|---|---|---|---|---|---|---|---|---|---|
| 1 | forced | false | 223.9s | 1.077129 | 15 | 11 | 95 | 0 | 0 |
| 2 | playwright | true | 76.2s | 0.719115 | 0 | 0 | 0 | 17 | 0 |
| 3 | forced | false | 222.0s | 0.970382 | 11 | 7 | 80 | 0 | 2 |
| 4 | playwright | true | 70.9s | 0.715294 | 0 | 0 | 0 | 17 | 0 |
| 5 | forced | **true** | 238.1s | 1.038691 | 16 | 8 | 109 | 0 | 0 |
| 6 | playwright | true | 72.4s | 0.714443 | 0 | 0 | 0 | 17 | 0 |

Total: $5.235054. Full per-handoff status/reason/steps records:
`results/phase-m-measure.json` (`handoff_records` per run) and the raw
per-call transcripts in `logs/phase-m-forced-run{1,2,3}-transcript.ndjson`.

**Every `FORCED-VERDICT` line, verbatim** (`node dist/bench/forced-verdict.js
bench-results/2026-09-27-r5/results/phase-m-measure.json`):

```
FORCED-VERDICT: completion forced=1/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=16
FORCED-VERDICT: picks 26/42
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 2.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 2
FORCED-VERDICT: overall FAIL
```

**Missed bars (4 of 9 non-informational checks): completion, handoffs, picks,
median-steps.** Passed cleanly: wingman-share (1.00 ≥ 0.90), raw-acts (0, must
be 0 — the caller never bypassed forced handoff with a withheld-class raw
Playwright call), zero-step-done (0), first-call-success (3/3), no-page-error-end
(0). `raw-script` (2) is informational only.

Diagnosis of every non-`done` handoff, from the records:

- **`step-uncertain` (the large majority, ~29 of 42 handoffs)**: Jev's router
  reports a multi-candidate or no-match ambiguity on the target element and
  bounces the step back to the caller before acting. The caller then almost
  always re-calls with an explicit `pick` (26 picks against 42 handoffs total —
  62%, the majority, which is exactly what trips the `picks` bar: the spec
  wants pick corrections to stay a **minority**).
- **`budget-steps` (5 handoffs, each burning the full 24-step/25-jev-call
  round budget)**: e.g. run 1's 6th handoff and run 3's three `budget-steps`
  ends. These are single-step goals (`steps_total: 1` or the tail of a
  longer chain) that never converge — the loop keeps acting without ever
  emitting `done`, consistent with the Part 3 finding below (a `select`/`fill`/
  `click` retry loop that doesn't detect success).
- **`error/invalid-input` (2 handoffs)**: the caller's own malformed
  `browse_step` call (e.g. `pick` missing required fields) — caller-side, not
  a wingman defect, and correctly reported as `error` rather than silently
  retried.
- **`error/page-error` (3 handoffs, e.g. run 1's 9th and 11th, run 3's 13th)**:
  transient page-state errors mid-chain; none of these was a run's *last*
  handoff (confirmed by `no-page-error-end: 0`), so the caller always got at
  least one more chance afterward.
- **`error/act-failed` (1 handoff, run 3's 4th)**: an act that failed at
  execution time.
- Only **run 3's last handoff** reached `done/goal-met` (the one forced run
  that completed the whole 9-step chain and passed the oracle).

**Median steps per handoff is 2.00** (bar ≥ 4): most handoffs either bounce
almost immediately (0–3 steps) or blow the entire 24-step budget (24 steps) —
there is essentially no middle ground of "made solid partial progress, handed
back cleanly," which is what the bar is checking for.

### Phase S — smoke (one forced cell, gate ON/confirm)

`node dist/bench/run.js --cap-usd 4 --phase-cap-usd 15.421024 --tasks
t9-long-chain --routes forced --repeats 1 --purpose experiment` (no
`BENCH_GATE_OFF`/`BENCH_POLICY_OFF` — defaults: gate `confirm`, policy `enforce`).

| task | route | ok | wall | usd | handoffs | picks |
|---|---|---|---|---|---|---|
| t9-long-chain | forced | **true** | 209.8s | 0.954031 | 17 | 9 |

`FORCED-VERDICT: smoke ok=true needs_confirmation=6` — **the gate fired 6
times** (`irreversible-heuristic` ×5, `irreversible-jev` ×1) under forced
handoff with gate `confirm`, confirming the gate-under-forced-handoff wiring
works: irreversible-looking actions correctly come back as
`needs_confirmation` rather than being silently withheld-and-skipped or
silently executed.

### Honest verdict, n=3

The **mechanism holds structurally**: across all 4 forced runs (3 measure + 1
smoke) there was not a single withheld-class raw browser call (`raw_acts: 0`
throughout) — the caller never bypassed the forced handoff, and 100% of
executed browsing acts went through wingman (`wingman-share 1.00`). The gate
under forced handoff also fires correctly (Phase S).

But **task completion under forced handoff is poor and inconsistent**: 1 of 3
measure-phase forced runs completed the 9-step t9 chain (33%) against the
playwright control's 3/3 (100%) on the identical task in the identical
interleaved pass — a completion gap the `forced-verdict` completion bar is
specifically designed to catch, and it did. The one success (run 3, wall
238.1s) and the smoke run (wall 209.8s, also completed) both took roughly
3× the playwright control's wall time (~72–82s) and made 16–17 handoffs to
get there, the large majority of which bounced (`step-uncertain`) and needed
an explicit caller-supplied `pick` to proceed — the picks bar (26/42 = 62%,
needs <50%) and the handoffs bar (max 16, needs ≤4) both failed for exactly
this reason. n=3 is not enough to establish a stable completion rate (33%
here vs the 2026-09-22 margin-rule pass's 3/3 note in CLAUDE.md, both on the
same task), but it is enough, combined with the picks/handoffs/median-steps
pattern, to say the *shape* of the failure is consistent across this session's
runs: Jev's router frequently reports low confidence on this multi-page
chain's real DOM structure, bounces to the caller, and the caller's `pick`
corrections are doing a majority of the routing work rather than a minority —
i.e. forced handoff is currently closer to "the caller drives via `pick`
with wingman executing the click" than "wingman autonomously carries the
chain," on this task.

---

## Part 3 — fresh-install check (Linux)

Acted as an installing agent that had read only `INSTALL-FOR-AGENTS.md` from
this branch.

1. `npm pack` the local clone → `jev-browser-wingman-0.2.1.tgz` (note: package
   version is still `0.2.1` even on the `forced-handoff-0.3.0` branch — the
   version bump to 0.3.0 has apparently not been applied to `package.json` yet,
   even though `doctor`'s output and the gate/handoff-config comments all
   describe 0.3.0-era behavior, e.g. "the gate is off unless you set it, since
   0.3.0"). Installed globally in a clean scratch dir with `npm install -g
   ./jev-browser-wingman-0.2.1.tgz`. `jev-browser-wingman --version` → `jev-browser-wingman 0.2.1`, exit 0.
2. `jev-browser-wingman doctor --plan` (fresh `$HOME`, no prior config): correctly
   detected `client: claude`, printed O1 (register + set mode on) and O2 (wrap
   or deny the browsing tool) as `[todo]`, O3/O4 as `[met]`.
3. Registered per the doc's own "Register per client" § verbatim: added to
   `/root/.claude.json`'s `mcpServers` the wrapped Playwright entry (`{"type":
   "stdio","command":"jev-browser-wingman","args":["with-browser","--","npx",
   "-y","@playwright/mcp@0.0.80","--browser","chrome"],"env":{}}`, matching the
   doc's own worked example exactly) and the plain wingman entry (`{"type":
   "stdio","command":"jev-browser-wingman","args":["mcp"],"env":{}}`).
   **Backed up the original `/root/.claude.json` first** (the doc's "Back up
   before editing" rule) and restored it during cleanup, since this is the
   live Claude Code CLI config for the very container running this validation.
4. Set `{"mode": "on"}` in `~/.jev-browser-wingman/config.json`.
   `doctor --plan` then showed O1/O2/O3/O4 all `[met]`.
5. `jev-browser-wingman doctor --client claude`: **FAIL** on `adapter-attach`
   ("nothing listening on port 9222 and no endpoint env is set") — the doc's own
   fix-table entry for this ("Run `jev-browser-wingman chrome ensure`") worked
   immediately: `jev-browser-wingman chrome ensure` → `{"ok":true,"endpoint":
   "http://127.0.0.1:9222",...}`, then `doctor` went green on every check,
   **verdict PASS**, with `handoff` reporting **"enforced by proxy after
   auto-classification: playwright ... withheld classes: element-act, type,
   select, key, hover, upload, navigate, back, scroll"** — handoff enforced,
   as required. Full JSON: `logs/part3-final-doctor.json`.
6. **Real `claude -p` call using `browse_step` — did not succeed on the first
   call, on any of three attempts:**
   - Attempt 1 (`/checkboxes`, goal "tick the first checkbox"): the FIRST
     `browse_step` call bounced `fallback/step-uncertain` with `why: "multi-match"`
     — both checkboxes on the page are genuinely unlabeled and indistinguishable
     by role/name, so this is a legitimate ambiguity in the chosen page, not
     necessarily a defect. (`logs/part3-attempt1-checkboxes.jsonl`)
   - Attempt 2 (`/dropdown`, goal "Choose Option 2 in the dropdown list", a
     single unambiguous `<select>`): the FIRST call returned
     `fallback/budget-steps` after burning the full round budget — the
     wingman log shows `acts_by_op: {"click": 24}` then, on the next call,
     `{"select": 24}`: **24 identical acts in a row without ever emitting
     `done`**, even though the goal is a single `<select>` interaction.
     Four consecutive calls all returned byte-identical cost figures with
     `progress.steps_done: 0` — the caller itself noted "the wingman tool
     keeps returning the identical result across four attempts." Never
     completed. (`logs/part3-attempt2-dropdown.jsonl`, `logs/part3-wingman-log.jsonl`)
   - Attempt 3 (`/inputs`, goal "type 42 into the number field" — the single
     simplest possible page, called out in earlier calibration notes as a case
     that "acts fine"): **same failure mode**, first call `fallback/budget-steps`,
     `acts_by_op: {"fill": 24}`, never converges across 3 more identical
     retries. (`logs/part3-attempt3-inputs.jsonl`)

   **This is a real, reproducible defect, not a setup artifact**: all three
   attempts used the same registration, the same shared Chrome (verified via
   `/json/list` to hold exactly one page target matching the goal before each
   call), and the same fresh-classified `playwright` profile. The consistent
   `acts_by_op` shape (N identical acts of the single relevant verb, `N=24`
   = the default `max_steps` budget) across three different action types
   (`click`, `select`, `fill`) on three different single-element pages points
   at a hypothesis: **the post-act settle/verify step is not detecting that
   the action already succeeded, so the loop keeps re-issuing the same act
   until the step budget is exhausted, rather than confirming success after
   the first try.** This is a hypothesis from the log shape, not a confirmed
   root cause (no source-level diagnosis was done — Part 1's own test suite is
   fully green, so this is either a real-page interaction the unit/e2e tests
   don't cover, or specific to this container's Chromium build/flags).
   This corroborates Part 2's `median-steps 2.00` / `handoffs max=16` findings:
   the same retry-without-convergence shape shows up independently in both the
   bench harness and this manual fresh-install check.

7. Cleanup: `jev-browser-wingman chrome stop`, restored the original
   `/root/.claude.json` from backup (confirmed `mcpServers` key absent again
   afterward), `npm uninstall -g jev-browser-wingman`.

### Doc gaps / unclear points found while following INSTALL-FOR-AGENTS.md

- The doc never states which exact file/key path `doctor --plan`'s registration
  instructions target beyond printing the raw JSON to add — an agent has to
  infer (or discover via `doctor --plan`'s own output, which does name
  `/root/.claude.json`) that it's the top-level `mcpServers` key of that file,
  not a project-scoped `.mcp.json` or a `projects.<cwd>` sub-object. Worked
  fine here because `doctor --plan` names the exact path, but nothing in the
  doc itself confirms this ahead of time.
- The doc doesn't mention that `doctor --plan`/`doctor` operate on the
  **real, live** client config file (e.g. the actual `~/.claude.json` of
  whatever Claude Code CLI installation is running doctor) — for an agent
  running inside the same environment as its own Claude Code session, this
  means the install step edits the live session's own MCP registration.
  The doc's "Back up before editing" rule covers the mechanics but doesn't
  flag this specific self-referential risk.
- The "Verify" table's fix for `adapter-attach` (`jev-browser-wingman chrome
  ensure`) worked exactly as documented — no gap there, called out as a
  positive: doc and behavior matched precisely.
- Nothing in the doc's "What was tested" section flags that after
  auto-classification, `doctor`'s `handoff` detail line's wording changes
  (from "not yet classified" to nothing, i.e. no trailing clause) — a minor
  cosmetic observation while comparing two doctor runs, not a functional gap.
- The doc's Part-3-relevant claim — implicit in shipping `browse_step` as the
  primary forced-handoff tool and the "What was tested" line naming this exact
  scenario ("cloud Linux fresh install with Claude Code and a Playwright-family
  MCP server") — is that a real session using it on a simple page should work.
  That did not hold in 3/3 attempts here (see above); this is the most
  significant doc-vs-behavior gap found.

---

## Linux-only caveats

- This entire round ran on Linux; none of the following (all called out in
  `CLAUDE.md`/`src/core/CLAUDE.md` as Windows-specific) were exercised or
  re-verified: win32 `cmd /c` quoting for the bench prompt's ASCII/single-line
  constraints, `chrome show`/`chrome hide`'s restore-then-move
  `Browser.setWindowBounds` sequence, `chrome-cmd`'s win32-only GetWindowRect
  test (correctly skipped here), Devin's Windows `%APPDATA%` config path, or
  the win32-specific `runClaude` spawn path in `bench/claude-run.ts` (this
  round used the plain `spawn('claude', argv, ...)` branch throughout).
- The container has no native Chrome binary; every Chrome-launching test and
  bench run went through the `chromium-wrapper.sh` privilege-drop-to-`nobody`
  + `--ignore-certificate-errors` shim described above. This is a bench-image
  concern per the wrapper's own header comment ("Cloud bench container ONLY —
  never product code") and doesn't reflect on product behavior, but any
  container-specific Chrome flakiness (fontconfig/dbus warnings observed in
  stderr throughout — harmless, page content loaded correctly every time) is
  an artifact of this environment, not the package.

## Cleanup performed

- All ad-hoc scratch/test Chrome processes swept by their `wingman-ephemeral`/
  `chromium-wrapper` cmdline markers after every test chunk and after every
  bench phase (verified `ps aux | grep -i chrome` empty or zombie-only after
  each sweep).
- `bench/.home/`, the packed tarball, the global npm install, and the fresh
  scratch install directory were all removed/uninstalled.
- `/root/.claude.json` restored from the pre-install backup.
- Xvfb and any remaining background processes stopped at the end of the run.
