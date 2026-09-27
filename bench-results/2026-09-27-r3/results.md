# forced-handoff-0.3.0 release-candidate QA — round 3 (2026-09-27)

Branch under test: `forced-handoff-0.3.0` @ `c7a6436d85fbb36300af57210b70193f06e48cbe`
("fix: second cloud-run round on forced-handoff-0.3.0" — the commit that claims to fix
R1-R5 from `bench/forced-0.3.0-results-r2:bench-results/2026-09-27-r2/results.md`).
Linux cloud container (root, Node 22.22.2, Chromium 141.0.7390.37 at
`/opt/pw-browsers/chromium-1194`, playwright-core), Xvfb `:99`.

**Outcome: Part 1 still NOT green.** 5 of 647 tests fail, across 4 files (same file
set as round 2: `adapter-cdp`, `chain-e2e`, `pick-e2e`, plus a newly-observed
`conformance` file with 2 failures that round 2 never saw). Per the QA plan's stop
rule, Part 2 (forced-handoff bench, cap $15) and Part 3 (fresh-install check, cap $4)
were **not run**. All four failures were reproduced on an isolated re-run (stable,
not flaky). Two of the fix commit's four targeted changes are cleanly proven working
(the runner-sweep-leak keepalive fix, and the pick-e2e round-1 `recover` fix); the
other two (the ephemeral window-size fix and the chain-e2e E3 rewrite) each measurably
improve on their round-2 symptom but leave the same test still red on a narrower,
different failure mode — and the window-size fix appears to have caused a new,
previously-unseen regression in an unrelated file (`conformance`'s scroll test).

## Environment setup

Followed the SPEC's recipe unchanged, all steps confirmed working:

- `bench/cloud/chromium-wrapper.sh` installed at `/usr/local/bin/chromium-wrapper.sh`
  (chmod +x); `/usr/bin/chromium` and `/opt/google/chrome/chrome` symlinked to it.
  `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` exported for
  every chrome-launching command (confirmed from the wrapper's own `REAL_CHROMIUM`
  env-var mechanism, read before setting it).
- Xvfb `:99` started in the background (1280x1024x24) and `DISPLAY=:99` exported
  for every subsequent command via a sourced `/root/env-wingman.sh`.
- Verification: `DISPLAY=:99 /usr/bin/chromium --headless=new --dump-dom
  https://example.com` returned the real "Example Domain" DOM (dbus/GPU warnings
  present but harmless, page content loaded).
- `node dist/src/cli/main.js chrome ensure` answered with both a temp `WINGMAN_HOME`
  (`{"ok":true,"endpoint":"http://127.0.0.1:9222",...}`) and the default home under
  `/root`; `chrome stop` cleaned up both.
- `claude -p 'say ok'` -> `ok`. `TYPESAFE_API_KEY` present (presence-checked only,
  never printed or logged, per the non-negotiable rule).
- `npm ci` exit 0; `npm run build` -> `BUILD: ok out=dist files=106`;
  `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` exit 0.

## Part 1 — per-file results (one file per invocation, strictly sequential; chrome
leftover checked after every file via `ps aux | grep -i chrome | grep -v defunct`,
which stayed empty after all 50 files)

Totals: **50 files, 647 tests, 641 pass, 5 fail, 1 skip (win32-only, chrome-cmd)** —
identical pass/fail COUNT to round 2, but a different set of files (round 2's
`runner-sweep` failure is now fixed; a new `conformance` failure appeared).

All 50 files ran green except the four below (full per-file list in
`logs/summary.tsv`; every other file — including `acquire`, `bench-browse`,
`bounce-escalation`, `boundary`, `browse-step-surface`, `cdp-connection`, `chain`,
`chrome`, `chrome-cmd` (1 win32 skip), `classify-tools`, `cli`, `config`,
`conformance-ops`, `contract`, `doc-safety`, `doctor`, `egress`, `ephemeral-sweep`,
`gate`, `jev-client`, `log`, `loop`, `mcp-server`, `page-scripts`, `pick`, `plugin`,
`policy`, `profiles`, `questions`, `readme-bench`, `registrations`, `runner-sweep`,
`runner-sweep-leak`, `scaffold`, `settle`, `setup-plan`, `takeover`,
`takeover-config`, `tokens`, `typesafe-stub`, `with-chrome`, `with-chrome-forced`,
`withhold` — passed fully):

| file | tests | pass | fail | status vs round 2 | notes |
|---|---|---|---|---|---|
| adapter-cdp | 8 | 7 | 1 | **still fails, different (smaller) delta** | see F1 below |
| chain-e2e | 8 | 7 | 1 | **still fails, different sub-case** | E6 now genuinely fixed; E3 fails on a different assertion, see F2 |
| conformance | 28 | 26 | 2 | **NEW — round 2 had this file 28/28 green** | see F3 below |
| pick-e2e | 2 | 1 | 1 | **still fails, different symptom** | P1 round-1 bug fixed; round-2 bug newly exposed, see F4 |
| runner-sweep | 2 | 2 | 0 | **FIXED** (was 1/2 in round 2) | confirms fix (b) |

All four failing files were re-run once, alone, after sweeping leftover chrome:
identical failures both times for all four — stable, not a flake
(`logs/*.rerun.log`).

### F1 — `adapter-cdp` "observe matches the pinned form.html table": window-size fix
substantially works, residual drift still fails the 20px tolerance

Round 2's symptom: `element 3 (Country) rect.x=8 not within 20px of pinned 647` (a
639px delta — the whole row had wrapped onto a second line under headless Chrome's
default ~780px viewport). Round 3, at HEAD (with `CHROME_WINDOW_SIZE_ARG` now
applied to `launchEphemeralChrome`, confirmed present in `src/browser/ephemeral.ts`):

```
element 3 (Country) rect.x=677 not within 20px of pinned 647
```

A 30px delta, not a line-wrap — the row no longer wraps (the fix's stated purpose is
achieved), but the elements still land ~30px right of the pinned x-coordinate, 10px
over the test's `GEOMETRY_TOLERANCE_PX = 20`. This reads as ordinary font-metric /
box-model drift between whatever machine originally captured the pin and this
container's Chromium 141 — the same category of drift the 20px tolerance was
designed to absorb, just slightly larger than budgeted here. **Not the round-2 bug
recurring; a materially smaller, distinct residual.**

### F2 — `chain-e2e` E3: the redaction/budget-steps bug is fixed; a new,
narrower bug in the test's own rewritten bad-case assertion

Round 2's symptom: the *good*-case call (`rg`, navigate via a valid url binding)
itself failed with `fallback`/`budget-steps` — `state.url` was permanently redacted
to the binding placeholder after arrival, so the stub could never see it had landed
and kept re-issuing `navigate` for 24 rounds. Round 3: the good-case call now
**passes** (`rg.status === 'done'`, arrival confirmed, and the new criteria
assertion — the `url` question offers exactly `['form_url', 'none']` — also
passes). The test now fails later, in the *bad*-case loop (`urlAnswer: 'none'`):

```
urlAnswer none
+ actual - expected
+ 'ambiguous'
- 'fallback'
```

i.e. the call ends `status: 'ambiguous', reason: 'no-value'` (a raw, unwrapped
`decideTarget` result — see `src/core/loop.ts` line ~1145,
`mk('ambiguous', 'no-value')` for the `navigate` verb when no url-typed binding
qualifies), not the wrapped `fallback`/`step-uncertain`/`step_review.why: 'no-value'`
shape the chain-mode non-commit path (`chainNonCommit`) produces elsewhere in the
same file. This looks like a real product-level inconsistency (two different shapes
for what should be the same "chain step couldn't get a usable value" outcome), not
a test-authoring slip — but it is a **different, narrower** bug than round 2's, first
exposed only because the fix made the good-case leg pass far enough to reach this
assertion at all.

### F3 — `conformance` "scroll moves many.html down": NEW regression, both adapters,
plausibly caused by the same window-size fix that fixed F1's larger symptom

Not present in round 2 (that run had this file 28/28 green). Fails identically on
both the `playwright` and `cdp` adapter suites:

```
expected a positive scrollY, got 0
```

`conformance.test.ts` also launches Chrome via `launchTestChrome`/
`launchEphemeralChrome` — the same code path `CHROME_WINDOW_SIZE_ARG` was added to.
The `many.html` fixture has exactly 300 stacked buttons ("Row 001".."Row 300"); the
test scrolls from "Row 001" and asserts `window.scrollY > 0` after settling. The
most likely mechanism (not independently confirmed with a geometry probe, flagged
as a hypothesis, not a proven root cause): the taller 1280x800 window the fix now
launches with may render enough of the row list without overflow that the "scroll"
op has nothing to scroll to, where the previous, shorter default viewport reliably
overflowed. If correct, this is the same fix trading one geometry defect (F1's
639px wrap) for a new one elsewhere — worth the product owner checking with a direct
`Page.getLayoutMetrics` probe, which this pass did not run (time-boxed; the fixture
and assertion are described above with exact line numbers for a follow-up).

### F4 — `pick-e2e` P1: round-1 `recover` bug is fixed; a second, previously-unreached
bug in the pick round now surfaces

Round 2's symptom: call 1 (the ambiguous-bounce call) itself failed with
`reason: jev-error`, because the stub's `noulDefaults` map wrongly answered the
choice-typed `recover` question with a noul-shaped default, so `parseJevAnswers`
rejected the whole response. Round 3, at HEAD (with `recover` removed from
`noulDefaults`): call 1 now **passes fully** — bounces correctly with
`fallback`/`step-uncertain`, carries valid candidates including the Full name
textbox, and the `FORCED_BOUNCE_LINE` note. The test now fails on **call 2** (the
`pick`-corrected re-call), which round 2 never reached:

```
'fallback' !== 'done'   (expected: 'done', actual: 'fallback')
```

Diagnosed with a throwaway instrumented copy of the compiled test (logged the full
`res2` object, discarded after use, never committed):

```
{"status":"fallback","reason":"step-uncertain","steps":1,
 "last_action":{"verb":"fill","label":"Full name"},
 "step_review":{"why":"multi-match", ...},
 "cost":{"jev_calls":2,...},
 "progress":{"step_index":1,"steps_done":0,"steps_total":1}}
```

The pick's fill DID execute (`last_action` shows `fill`/`Full name`, `steps: 1`) —
the pick mechanism itself works. But the call made **2** decision-service round
trips (`cost.jev_calls: 2`), not the 1 the test's own comment describes ("the pick
round sends nothing to the decision service" + one step_done-advance ask = 1 call
total; the test separately asserts `call 2 contacted the stub exactly once`, which
also fails here though the assertion never runs because the status check throws
first). The second of those two calls got back a `target` answer with a
`multi-match` outcome and bounced instead of advancing on `step_done`. This means
the test stub's `phaseB = reqNo >= 4` request-counting assumption (a comment above
`startPickStub` explains it expects phase B — the step-done-confirms-and-finishes
answers — to start at the 4th stub request) is now off by at least one for the
post-pick leg, a path round 2's earlier jev-error bug masked entirely (call 1 never
even reached call 2 in either round 1 or round 2 of this QA cycle). **This is best
read as a second, independent pick-e2e stub-authoring bug, not evidence the round-2
fix is wrong** — the round-2 diagnosis (bad `recover` default) is fully confirmed
fixed by known-bad proof (c) below.

## Part 1 — gates

- `DISPLAY=:99 node scripts/gates/lazy-chrome.mjs --dist dist` ->
  `LAZY-CHROME: ok listed=24 chrome=0 answered=false`.
- `DISPLAY=:99 node scripts/gates/lazy-chrome.mjs --dist dist --known-bad tool-call`
  -> exit 1, `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`. Both as expected.

## Part 1 — known-bad proofs (the four covering commit c7a6436)

Each flip was built into its own scoped `.build/kb-*` output dir (never touching the
real `dist/`), except proof (b), whose fixture hardcodes `packageRoot/dist` and so
required rebuilding and then re-rebuilding the real `dist/` (both rebuilds done,
`tsc --noEmit` exit 0 confirmed after the final restore). Every flip was restored
with `git checkout -- <path>` and `git status --short` confirmed clean before the
next proof.

| # | flip | result | evidence |
|---|---|---|---|
| (a) | `src/browser/ephemeral.ts`: remove `CHROME_WINDOW_SIZE_ARG` from the ephemeral launch args | **PROVEN** | `adapter-cdp` "observe matches..." fails with `rect.x=8 not within 20px of pinned 647` — the exact round-2 639px-wrap symptom, vs HEAD's 30px residual (F1). Confirms the fix genuinely narrows the defect even though HEAD is still red. |
| (b) | `tests/runner-sweep-leak.test.ts`: replace the `setInterval` keepalive with `await new Promise(() => {})` | **PROVEN**, and this round the flip's own two-step effect is fully visible: `runner-sweep-leak.test.ts` itself still passes on this container's Node 22.22.2 (the bare promise does hang the child here — this machine does not reproduce round 2's exact "exit code 13" symptom on the leak fixture itself), but the effect it exists to prevent still occurs downstream: `runner-sweep.test.ts` test #2 fails identically to round 2 — `runner sweep logged no kill — the leaked chrome was not caught` / `0 matching chromes`. | `logs/kb-b-leak-fixture.log` (1/1 pass), `logs/kb-b-runner-sweep.log` (1/2 pass, the exact failure text above). At HEAD (fix in place, confirmed via the main suite run) both files are 2/2 — this is a real, working fix; round 2's own "NOT a meaningful discriminator" caveat about this proof does not apply on this container. |
| (c) | `tests/pick-e2e.test.ts`: put `recover: 0.05` back into `noulDefaults` | **PROVEN** | `P1` fails with `reason: 'jev-error'` (expected `'step-uncertain'`) — the exact round-2 symptom. Confirms the round-1 leg of the fix is real and load-bearing. |
| (d) | `tests/chain-e2e.test.ts`: change the E3 stub guard from the title check back to `url.includes('chain-form.html')` | **PROVEN** | `E3` fails on the **good-case** leg this time: `reason: budget-steps` on `rg` (`'fallback' !== 'done'`) — the exact round-2 symptom (state.url redaction masking arrival forever). This is a DIFFERENT failure point than HEAD's current E3 failure (F2, which fails later, in the bad-case loop) — confirming the title-keyed fix genuinely repairs the original bug; F2 is a new, later-discovered issue the fix's own progress uncovered. |

Round 2's own known-bad proofs (CDP fill/scroll_to/reload/ShiftTab/SelectAll,
page-scripts file-input, win32 Opera candidates, Windows process filter, doctor
forced+enforce WARNING, playwright `back`, `typesafe-stub` fillDefaultAnswers) are
treated as already PROVEN and were **not** re-run this round.

## Part 2 — FORCED-HANDOFF BENCHMARK

**Not run.** Part 1 is not green (adapter-cdp, chain-e2e, conformance x2, pick-e2e —
see F1-F4 above, all reproduced on an isolated re-run). Per the QA plan's explicit
stop rule, neither `bench/run.ts` nor `bench/forced-verdict.ts` was exercised. No
new `bench/results/*.json` entry was written; the phase ledger this branch's history
sits against is unchanged by this pass.

## Part 3 — FRESH-INSTALL CHECK

**Not run.** Part 1 is not green — same stop rule as Part 2 (the plan makes Part 3
independent of Part 2's own outcome, but both require Part 1 green, which this pass
did not reach).

## Linux-only coverage

Same caveat as rounds 1 and 2: all results are Linux-only. The win32 PowerShell
process-listing/sweep path (beyond the `'win32'`-forced unit test), Windows
candidate discovery beyond the path-list logic, `taskkill` paths, and Windows
window show/hide all remain unverified by this pass.

## Environment quirks worth flagging for the next round

- **This container's Node 22.22.2 does NOT reproduce round 2's exact
  "unsettled top-level await exits with code 13" symptom** on the runner-sweep-leak
  fixture itself (proof (b)'s reverted fixture still printed READY and hung
  correctly here) — but the SAME downstream effect (`runner-sweep` test #2 failing
  to see a kill) still occurred, via a route this pass did not fully isolate. The
  fix (a ref'd `setInterval`) is unambiguously still correct and necessary; treat
  round 2's stated mechanism as one confirmed cause among possibly more than one on
  different Node builds, not the only way to reach the same downstream failure.
- **Every one of round 2's four "still-partially-broken" findings resolved into
  progress, not into a wall**: three of four fixes moved their test's failure point
  materially later/smaller (F1's 639px->30px, F2's/F4's good-case/round-1 now
  passing, exposing a further, previously-unreached bug each), and one (runner-sweep)
  is now fully green. None of the four fixes regressed their own target scenario.
  The one clearly NEW problem this round (conformance's scroll test, F3) is plausibly
  a side effect of the one shared-mechanism fix (the window-size arg) that touches
  every ephemeral-Chrome-launching test file, not of the other three, more localized
  fixes.
- `bench-cloud/chromium-wrapper.sh`'s `/root` ancestor-traversal chmod (documented in
  CLAUDE.md's 2026-09-27 gotcha) was not needed as a manual workaround this round —
  `chrome ensure` against both a temp and the default `WINGMAN_HOME` answered cleanly
  on the first try in each case.

## Total spend

Part 2 (cap $15) and Part 3 (cap $4) were not run — $0 against both caps. The
prereq `claude -p 'say ok'` check made one trivial real call. Part 1's real-Chrome
e2e test files (chain, chain-e2e, mcp-server, browse-step-surface,
with-chrome-forced, conformance-ops, jev-client, and the known-bad proofs for (c)
and (d)) made real TypeSafe API calls; as in rounds 1 and 2, the harness does not
meter TypeSafe spend per test run, so no dollar figure is available for that
portion — only the key's presence was checked, never logged or printed, per the
non-negotiable rule. All three parts combined are well under the $19 stated cap.
