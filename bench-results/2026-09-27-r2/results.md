# forced-handoff-0.3.0 release-candidate QA — round 2 (2026-09-27)

Branch under test: `forced-handoff-0.3.0` @ `b8769b0f5fdfde2fb4fd8e9bc975a627b2289419`
("fix: cloud-run failures on forced-handoff-0.3.0" — the commit that claims to fix
F1-F7/E1-E3 from `bench/forced-0.3.0-results:bench-results/2026-09-27/results.md`).
Linux cloud container (root, Node 22.22.2, Chromium 141.0.7390.37 at
`/opt/pw-browsers/chromium-1194`, playwright-core), Xvfb `:99`.

**Outcome: Part 1 NOT green.** 5 of 647 tests fail, across 4 files, all reproduced
twice (stable, not flaky). Per the QA plan's stop rule, Part 2 (forced-handoff bench)
and Part 3 (fresh install) were **not run**. Total spend: TypeSafe API calls made by
the real-Chrome e2e test files in Part 1 (chain, chain-e2e, mcp-server,
browse-step-surface, with-chrome-forced, conformance-ops, etc.) plus one
`claude -p 'say ok'` prereq check; no bench cell was run, so no `bench/results/*.json`
ledger entry was added. Exact USD not separately metered for Part 1 (TypeSafe key
billing, not tracked per-call by the test harness); nothing in Part 2/3's $15/$4 caps
was touched since neither part ran.

Of the 9 F1-F7 findings and 3 E1-E3 findings from the prior (`bench/forced-0.3.0-results`)
report, b8769b0 fixed all of them **except** it left one CLAUDE.md-documented pre-existing
issue (win32 process-list test, previously F6) actually genuinely fixed too (made
Linux-testable). Two genuinely NEW issues surfaced (not present, or not exercisable, in
the prior report): the adapter-cdp geometry test now fails for a different, more serious
reason than the "Linux font metrics" note in CLAUDE.md describes, and one of the two
`typesafe-stub.ts`-based e2e files (pick-e2e) has a stub-authoring bug of its own that the
prior report's blanket "F1: every stub-backed e2e test gets jev-error" finding papered
over. See per-failure root-cause sections below.

## Environment setup

Followed the SPEC's recipe unchanged:

- Installed `bench/cloud/chromium-wrapper.sh` as `/usr/local/bin/chromium-wrapper.sh`,
  symlinked `/usr/bin/chromium` and `/opt/google/chrome/chrome` to it.
  `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` exported for every
  chrome-launching command.
- Verification: `DISPLAY=:99 /usr/bin/chromium --headless=new --dump-dom
  https://example.com` returned the real "Example Domain" DOM. PASS.
- `DISPLAY=:99 node dist/src/cli/main.js chrome ensure` answered with both a temp
  `WINGMAN_HOME` and the default `~/.jev-browser-wingman` home under `/root`; `chrome stop`
  cleaned up both. No `chmod` workaround needed this time — matches the branch's own
  documented E3 fix (walk every ancestor up to `/`, not just the immediate parent).
- `claude -p 'say ok'` -> `ok`. `TYPESAFE_API_KEY` present (presence-checked only, never
  printed or logged).
- **No `.build/` pre-creation was needed** — `npm run build` created it as part of the
  normal build, and `scaffold.test.ts` passed 15/15 from a state where `.build/` did not
  exist beforehand (E1 from the prior report is fixed).
- **No `channel: 'chrome'` workaround was needed beyond the standard symlink** —
  `page-scripts.test.ts` passed 15/15 cleanly with no hang (E2 from the prior report
  reproduces only if the `/opt/google/chrome/chrome` symlink step from the recipe is
  skipped; it is not a code defect and did not need working around this run since the
  recipe was followed from the start).

## Part 1 — build and typecheck

- `npm ci` exit 0.
- `npm run build` -> `BUILD: ok out=dist files=106` (105 in the prior report; the new file
  is `tests/typesafe-stub.test.ts`, added by b8769b0's fix set for known-bad proof (b)).
- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` exit 0.
- `package.json` version is still `0.2.1` on this branch (unchanged from the prior report;
  not re-flagged as a new finding, just noted for completeness).

## Part 1 — per-file results (one file per invocation, sequential; `pgrep -af
wingman-ephemeral` filtered of its own command-line self-match showed 0 real leftover
Chrome processes after every single file, confirmed via `ps aux | grep -i chrome`)

Totals: **50 files, 647 tests, 641 pass, 5 fail, 1 skip (win32-only, chrome-cmd)**.

| file | tests | pass | fail | notes |
|---|---|---|---|---|
| acquire | 6 | 6 | 0 | |
| adapter-cdp | 8 | 7 | 1 | **NEW (see below): geometry test genuinely broken, not the old font-metrics note** |
| adapter-playwright | 7 | 7 | 0 | |
| bench-browse | 26 | 26 | 0 | |
| bench-cap | 8 | 8 | 0 | |
| bench-oracle | 2 | 2 | 0 | |
| bounce-escalation | 8 | 8 | 0 | |
| boundary | 19 | 19 | 0 | |
| browse-step-surface | 7 | 7 | 0 | fixed (prior F2/F3) |
| cdp-connection | 3 | 3 | 0 | |
| chain | 43 | 43 | 0 | |
| chain-e2e | 8 | 6 | 2 | fixed 6/8 (prior F1); **2 NEW distinct bugs (E3, E6), see below** |
| chrome | 28 | 28 | 0 | fixed (prior F6, now genuinely testable on Linux — see known-bad proof 8) |
| chrome-cmd | 8 | 7 | 0 | 1 skip (win32 only) |
| classify-tools | 7 | 7 | 0 | |
| cli | 6 | 6 | 0 | |
| config | 30 | 30 | 0 | |
| conformance | 28 | 28 | 0 | |
| conformance-ops | 39 | 39 | 0 | fixed (prior F5, playwright O6) |
| contract | 15 | 15 | 0 | |
| doc-safety | 4 | 4 | 0 | |
| doctor | 26 | 26 | 0 | |
| egress | 6 | 6 | 0 | |
| ephemeral-sweep | 7 | 7 | 0 | |
| gate | 9 | 9 | 0 | |
| jev-client | 6 | 6 | 0 | |
| log | 3 | 3 | 0 | |
| loop | 34 | 34 | 0 | |
| mcp-server | 14 | 14 | 0 | fixed (prior F1) |
| page-scripts | 15 | 15 | 0 | |
| pick-e2e | 2 | 1 | 1 | fixed P2 (prior F4); **P1 NEW distinct bug, see below** |
| pick | 20 | 20 | 0 | |
| plugin | 4 | 4 | 0 | |
| policy | 21 | 21 | 0 | |
| profiles | 14 | 14 | 0 | |
| questions | 25 | 25 | 0 | |
| readme-bench | 4 | 4 | 0 | |
| registrations | 9 | 9 | 0 | |
| runner-sweep | 2 | 1 | 1 | **still fails, prior F7 — see below (environment-specific, NOT proven a regression)** |
| runner-sweep-leak | 1 | 1 | 0 | |
| scaffold | 15 | 15 | 0 | fixed (prior E1), no pre-created `.build/` needed |
| settle | 4 | 4 | 0 | |
| setup-plan | 5 | 5 | 0 | |
| takeover | 37 | 37 | 0 | |
| takeover-config | 10 | 10 | 0 | |
| tokens | 5 | 5 | 0 | |
| typesafe-stub | 2 | 2 | 0 | new file (b8769b0's own regression test for known-bad (b)) |
| with-chrome | 26 | 26 | 0 | |
| with-chrome-forced | 3 | 3 | 0 | |
| withhold | 8 | 8 | 0 | |

Both `chain-e2e` and `pick-e2e` were re-run a second time (identical failures both
times — stable, not flaky) before being treated as findings; `runner-sweep` and
`adapter-cdp` were diagnosed with instrumented throwaway copies of the compiled dist
(same technique the prior report used for F1), not re-run blind.

## Part 1 — new/still-failing findings, with root cause

### R1 — `adapter-cdp` "observe matches the pinned form.html table": genuinely broken
layout, not font metrics

`element 3 (Country) rect.x=8 not within 20px of pinned 647` (and by extension the two
buttons after it). This is **not** the CLAUDE.md-documented "Linux font metrics" issue
(a few px of drift) — it's an 639px delta, because the whole row has wrapped onto a new
line. Root cause, confirmed live with a `Page.getLayoutMetrics` probe
(`logs/adapter-cdp.log` for the failure; the probe script and its output are described
here since it was a throwaway repro, not saved as a test artifact):

- `src/browser/ephemeral.ts`'s `launchEphemeralChrome` (used by every test's
  `launchTestChrome` helper, including `adapter-cdp.test.ts`) passes **no `--window-size`
  flag** — unlike `src/browser/chrome.ts`'s `CHROME_ARGS` (`--window-size=1280,800`, used
  by the *production* `ensureChrome` path). Headless Chromium's default window comes out
  to a **780x493 CSS viewport** (measured directly via CDP `Page.getLayoutMetrics`).
- The fixture `fixtures/pages/form.html` has **no CSS at all** — it relies on the
  browser's native inline-element flow, so the row containing Full name / Email / Notes /
  Country wraps wherever the viewport happens to end. The pinned expectation (`x: 647,
  w: 103` for Country, row ending ~x:750) was captured on a viewport wide enough to fit
  it on one line. At 780px, Chromium 141's own font/box-model metrics (different from
  whatever machine/Chrome-version the pin was captured on) tip the row over into wrapping,
  landing Country (and the two buttons after it) on the next line entirely.
- The 20px geometry tolerance this fix set added is the right idea for **font-metric**
  drift, but it cannot and does not paper over a full line-wrap, which is what actually
  happens here. This is a genuinely different, unaddressed failure mode from the one the
  tolerance was built for.
- **This is a real finding for the release candidate**, not a test-environment quirk to
  route around: it means `adapter-cdp.test.ts`'s observe-table pin is only valid at a
  window width nobody currently guarantees the test gets. Either the test needs an
  explicit `--window-size` (matching what production launches with), or the fixture needs
  layout CSS that keeps the row from wrapping regardless of viewport width.

### R2 — `chain-e2e` E3 "navigate works from a url binding...": the url-binding
navigate feature and value-redaction interact so `state.url` never shows the arrival
page

`assert.equal(rg.status, 'done', ...)` -> actual `fallback`/`budget-steps` (the FIRST,
"good" sub-case of E3, not one of the three intentionally-bad ones). Root cause,
confirmed by instrumenting a throwaway copy of the compiled `chain-e2e.test.js` to log
`state.url`/`state.history` per stub request (`logs/chaine2e-diag2.log`, and see
"DIAG-ROUND" lines in that file):

- After the loop navigates via the url binding (`values.form_url`) to the real target
  page, `state.url` sent to Jev on **every subsequent round** reads literally
  `"<value:form_url>"` — never the real URL — because `src/core/loop.ts`'s `buildState`
  runs the *entire* state object (including `url: scrubUrl(obs.url)`) through
  `redactDeep(raw, values)`, and the real browser URL now literally equals the supplied
  `values.form_url` string, so the redaction pass swaps it for the placeholder token like
  any other matched value.
- The test's own stub logic detects "have we arrived" via `url.includes('chain-form.html')`
  — a reasonable check — but it can never see the real URL again once the navigate
  succeeds, because `state.url` is now permanently the redacted placeholder. The stub
  keeps re-issuing `navigate` to the same binding every round (confirmed: `history` in the
  diagnostic log grows `{"verb":"navigate","label":"form_url"}` 24 times in a row,
  exactly the default `max_steps` budget) until the call bounces `budget-steps`.
- This is **not just a test-stub problem**: the real Jev decision service gets exactly the
  same redacted `state.url` on every round after a url-binding navigate lands, so it too
  has no way to see it has arrived at the target page from `state.url` alone. This looks
  like a genuine, product-level interaction between the § 5.5.3 "navigate from a url
  binding" feature and the general value-redaction pass, worth the product owner's
  attention independent of the test.

### R3 — `chain-e2e` E6 "a broken link recovers with back...": dead code in the test's
own stub, unrelated to R2

`assert.equal(r.status, 'done', ...)` -> actual `fallback`/`step-uncertain`. Root cause,
confirmed via the same diagnostic instrumentation (`logs/chaine2e-diag2.log`):

- `fixtures/pages/chain-error.html` itself contains the "Broken link" anchor
  (`<a href="missing.html">Broken link</a>`). Clicking it navigates to `/missing.html`, a
  real 404 whose body text includes "Not found".
- The test's `startChainStub` handler nests its `text.includes('Not found')` /
  `cho('recover', 'back', ...)` case **inside** an `else if (url.includes('chain-error.html'))`
  branch. But by the time the page text says "Not found", the URL is
  `/missing.html`, which does **not** contain `chain-error.html` — so that whole branch,
  including the recover logic, is unreachable dead code. Execution instead falls to the
  final `else { clickOn(/link "Form"/); }`, which finds no "Form" link on the bare 404 page
  and answers nothing explicit for `action`/`recover` that round; `fillDefaultAnswers`'s
  neutral low-confidence defaults leave no mechanical recovery path, and the call bounces.
- This is a plain test-authoring bug (the URL-gating condition was written assuming the
  browser stays on `chain-error.html` through the whole recovery flow, which it does not),
  independent of R2 and of the prior report's F1.

### R4 — `pick-e2e` P1 "ambiguous target bounces...then pick fills...": a different
test-stub bug than the prior report's blanket F1 diagnosis

`reason: jev-error` on the very first call (`step-uncertain` expected). Root cause,
confirmed by instrumenting a throwaway copy of the compiled `jev-client.js`'s
`parseJevAnswers` to log exactly which id/shape it rejects (`logs/pick-e2e-diag2.log`):

```
DIAG-INVALID id=recover reason=bad-choice choice=undefined criteria={"back":...,
"reload":...,"wait":...,"continue":...,"give-up":...}
```

- `tests/pick-e2e.test.ts`'s own `startPickStub` helper builds a `noulDefaults` map that
  **incorrectly includes `recover`** as a noul-type key
  (`{ done:0.05, blocked:0.05, ..., recover: 0.05 }`) and answers it with
  `{ type: 'noul', noul: 0.05 }` whenever the request asks a `recover` question. But
  `recover` is a **choice**-type question in the real contract (options
  back/reload/wait/continue/give-up, no `none`) — exactly as `typesafe-stub.ts`'s own doc
  comment says ("choice with no none criterion (recover is the only one)").
- Because the test's explicit answer for `recover` is written into the `answers` map
  before `fillDefaultAnswers(q, answers)` runs, `fillDefaultAnswers`'s correct choice-shaped
  default for `recover` is skipped (`if (id in out) continue;`) — the malformed noul-shaped
  answer wins.
- `parseJevAnswers` then rejects the whole response for the round the loop happens to ask
  `recover` in (part of the chain-mode early-rule order: advance -> error+recover -> ...),
  which surfaces as `jev-error`.
- This is **not** the prior report's F1 (that was every e2e test omitting the `key`
  question entirely, now fixed via `fillDefaultAnswers`). This is a narrower, separate
  authoring mistake specific to `pick-e2e.test.ts`'s own stub, which the prior report's
  blanket "every stub-backed e2e test gets jev-error" framing did not distinguish from F1
  because P1 also failed under the old bug and nobody isolated this second cause.
  `pick-e2e`'s P2 test (which never asks `recover`) is unaffected and passes.

### R5 — `runner-sweep` #2 still fails, but is now environment-broken rather than
regressed: NOT a valid discriminator here

`runner sweep logged no kill — the leaked chrome was not caught` /
`RUN-TESTS: chrome sweep (post-run): 0 matching chromes`. b8769b0's fix (commit message:
"runner-sweep leak fixture hard-kills a child so exit hooks skip") rewrote
`tests/runner-sweep-leak.test.ts` to spawn the leaking Chrome in a **grandchild** node
process and `SIGKILL` only the immediate child, specifically so the child's own
`process.on('exit')` guard (in `src/browser/ephemeral.ts`) never runs and the leaked
Chrome survives for the runner's own sweep to catch.

Root cause, confirmed with a standalone repro (`ps -eo pid,ppid,stat,cmd` timeline,
scripts not committed, described here): on this container's Node 22.22.2, a script whose
only remaining "work" is a detached (`unref()`'d) child process and a never-resolving
`await new Promise(() => {})` **exits on its own** almost immediately, with
`Warning: Detected unsettled top-level await` — Node treats the drained event loop as a
reason to terminate the process even though the top-level await is still pending. This
means the fixture's intermediate "leak-child" process exits **normally** (not via the
outer test's `SIGKILL`), before the outer test's kill signal can win the race — so its
own `process.on('exit')` exit-hook guard runs anyway and reaps the leaked Chrome, leaving
nothing for the runner's sweep to catch. Confirmed with a minimal repro
(`spawn` a script that launches a chrome via `launchEphemeralChrome`, prints READY, then
hangs on an unresolved promise): the chrome process is **already a zombie** (`ps` shows
`<defunct>`) within ~1 second, *before* the parent ever sends `SIGKILL`.

**Discrimination check**: I reverted `tests/runner-sweep-leak.test.ts` to its `6daa964`
(pre-fix) version and reran `runner-sweep` against a full rebuild of the real `dist/`
(required — this specific test hardcodes no `--dist` and spawns the nested runner against
`packageRoot/dist`, so it cannot be proven via a scoped side-build the way every other
known-bad here was). **Both the pre-fix and the post-fix (current, unmutated) versions of
the fixture fail identically** (`0 matching chromes`, same assertion). So this known-bad
flip does not discriminate — the test was already broken by an unrelated, environment-
specific Node behavior before the flip is even applied. Logged as PROVEN (the flip does
reproduce a failure) but **NOT a meaningful regression indicator on this Node version /
container** — see the known-bad proof table below for the precise wording.

## Part 1 — gates

- `node scripts/gates/lazy-chrome.mjs --dist dist` -> `LAZY-CHROME: ok listed=24 chrome=0
  answered=false`.
- `node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call` -> exit 1,
  `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` — no environment workaround
  needed this run (unlike the prior report's E3 chmod workaround; the branch's own E3 fix
  covers it now).

## Part 1 — known-bad proofs

Every flip was built into its own separate `.build/kb<n>` output dir (never overwriting
the real `dist/`, except proof (c) below where the test itself hardcodes `dist/` — see its
row), the named test run against that scoped dist, the failure confirmed, then
`git checkout -- <file>` restored the source and `git status --short` confirmed a clean
tree before moving to the next proof. The real `dist/` was rebuilt clean
(`npm run build`, `tsc --noEmit` exit 0) after the one proof that required touching it.

| flip | result | evidence |
|---|---|---|
| CDP contenteditable select branch removed (`cdp.ts` fill) | **PROVEN** | `not ok 4 - O4 fill replaces the contenteditable text` (only new failure, 38/39 pass) |
| CDP `scroll_to` no-op | **PROVEN** | `not ok 14 - O13 scroll_to brings Far away into view and clicks it` |
| CDP `reload` no-op | **PROVEN** | `not ok 15 - O14 reload resets the page` |
| CDP ShiftTab modifiers dropped | **PROVEN** | `not ok 16 - O15 press ShiftTab in Second moves focus back to First` |
| CDP SelectAll modifiers/commands dropped | **PROVEN** | `not ok 18 - O17 press SelectAll then Backspace empties the field` |
| page-scripts file-input implicitRole reverted (verify copy, line ~445) | **PROVEN** | `not ok 15 - a labelled file input enumerates as button and verifies (A1)` |
| win32 Opera candidates dropped (`chrome.ts`) | **PROVEN** | `not ok 19 - win32 candidates...` + `not ok 22 - findChrome falls through to Opera, then Vivaldi...` |
| Windows process filter -> `chrome.exe` only (`process-list.ts`) | **PROVEN** — now discriminates on Linux | `not ok 24 - listChromeProcesses Windows command covers the five family executables`; the test now explicitly calls `listChromeProcesses(fn, 'win32')`, fixing the prior report's "cannot discriminate on Linux" (F6) gap |
| doctor forced+enforce WARNING omitted | **PROVEN** | `not ok 23 - handoff Q4: forced + policy.mode enforce appends the WARNING, status unchanged` |
| (a) playwright `back`: remove `Page.getNavigationHistory` check, restore old `goBack()===null` throw | **PROVEN** | `not ok 6 - O6 navigate to form.html then back to ops.html` — and this confirms the fix is load-bearing: the OLD behavior genuinely fails on this Chromium/environment (bfcache/same-doc `null` resolves for real here), it isn't a defensive-only change |
| (b) `typesafe-stub.ts` `fillDefaultAnswers` returns only explicit answers | **PROVEN**, both ways | `typesafe-stub.test.ts`: `not ok 1` (1/2 pass); `chain-e2e.test.ts`: **all 8** tests fail (TAP shows 8 `not ok` lines; the runner reports `RUN-TESTS: zero tests registered` because the MCP client connection itself errors out under the flood of `invalid-response` rejections) |
| (c) `runner-sweep-leak.test.ts` reverted to `6daa964` | **PROVEN (mechanically), NOT a meaningful discriminator** | Both the reverted (old) and current (fixed) fixture fail `runner-sweep` #2 identically (`0 matching chromes`) on this Node 22.22.2/container — see R5 above for the real, unrelated root cause. This flip alone cannot be used to argue the fix works or doesn't; the test needs its own fix (or a different Node runtime) to be trustworthy here. |

## Part 2 / Part 3

**Not run.** Part 1 is not green (adapter-cdp, chain-e2e x2, pick-e2e, runner-sweep — see
R1-R5 above). Per the QA plan's explicit stop rule ("Part 2 requires Part 1 fully green
... Part 3 also requires Part 1 green. So if Part 1 fails, skip both Part 2 and Part 3, go
straight to pushing results and final report."), neither `bench/run.ts` nor the
fresh-install check was exercised. No `bench/results/*.json` entry was written (no bench
cell ran), so the phase ledger this branch's history is against is unchanged by this pass.

## Linux-only coverage

All results are Linux-only, same caveat as the prior report: the win32 PowerShell process
listing/sweep beyond the `'win32'`-forced unit test (`chrome-cmd` #8 skip; the real
PowerShell command line is exercised in the process-list test now, but never actually run
against a real `powershell.exe`), Windows candidate *discovery* beyond the path-list logic,
`taskkill` paths in `ephemeral.ts`/`run-tests.mjs`, and the Windows window show/hide
behavior all remain unverified by this pass. R5's Node-22-event-loop finding is itself
worth flagging as environment-specific — it may not reproduce on a different Node minor
version or on Windows, and should be re-checked there before concluding the test file is
simply broken everywhere.

## Total spend

Part 2 (cap USD 15) and Part 3 (cap USD 4) were not run — USD 0 against both caps. Part 1
made real TypeSafe API calls through the e2e/real-Chrome test files (chain, chain-e2e,
mcp-server, browse-step-surface, with-chrome-forced, conformance-ops, jev-client, and the
known-bad proof for (b)'s chain-e2e re-run); the harness does not meter TypeSafe spend
per-test-run the way `bench/run.ts` does for bench cells, so no dollar figure is available
for this portion — only presence of the key was checked, never its value, per the
non-negotiable rules.
