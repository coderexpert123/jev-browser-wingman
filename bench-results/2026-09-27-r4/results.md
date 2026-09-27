# forced-handoff-0.3.0 release-candidate QA — round 4 (2026-09-27)

Branch under test: `forced-handoff-0.3.0` @ `3e14098` ("fix: third cloud-run
round on forced-handoff-0.3.0" — the commit that claims to fix the four r3
findings: F1 adapter-cdp geometry drift, F2 chain-e2e E3 tab-ambiguity leak,
F3 conformance many.html scroll regression, F4 pick-e2e P1 stub bug).
Linux cloud container (root, Node 22.22.2, Chromium 141.0.7390.37 at
`/opt/pw-browsers/chromium-1194`, playwright-core), Xvfb `:99`.
`git merge-base --is-ancestor 3e14098 HEAD` confirmed true (HEAD == 3e14098
exactly).

**Outcome: Part 1 still NOT green.** 1 of 647 tests fails, in 1 file
(`adapter-cdp`). Three of r3's four findings are now **fully fixed**
(`chain-e2e` 8/8, `conformance` 28/28, `pick-e2e` 2/2 — all green, both on
first run). `adapter-cdp` still fails, but on a **different element and a
much larger, root-caused geometry mismatch** than r3's F1 — diagnosed live
with a direct CDP geometry probe (not a hypothesis): at this container's
1280x800 window size, `fixtures/pages/form.html`'s entire control row
(`Full name` .. `Place order`) fits on ONE line with no wrap at all, while
the pinned fixture data assumes a wrap between `Country` and `Continue`.
Per the QA plan's stop rule, **Part 2 (forced-handoff bench) and Part 3
(fresh-install check) were NOT run** — both require Part 1 green.

## Environment setup

Followed the SPEC's recipe unchanged, all steps confirmed working:

- `bench/cloud/chromium-wrapper.sh` installed at `/usr/local/bin/chromium-wrapper.sh`
  (chmod +x); `/usr/bin/chromium` and `/opt/google/chrome/chrome` symlinked to it.
  `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` exported
  for every chrome-launching command.
- Xvfb `:99` started in the background (1280x1024x24) and `DISPLAY=:99`
  exported for every subsequent command via a sourced `/root/env-wingman.sh`.
- Verification: `DISPLAY=:99 /usr/bin/chromium --headless=new --dump-dom
  https://example.com` returned the real "Example Domain" DOM (dbus/GPU/NSS
  warnings present but harmless, page content loaded).
- `node dist/src/cli/main.js chrome ensure` answered with both a temp
  `WINGMAN_HOME` (`{"ok":true,"endpoint":"http://127.0.0.1:9222",...}`) and
  the default home under `/root`; `chrome stop` cleaned up both (the killed
  chrome briefly shows as `<defunct>` zombies until reaped — harmless, not a
  leak: confirmed clear on the next `ps aux` check).
- `claude -p 'say ok'` -> `ok` (the only real spend this pass — trivial).
  `TYPESAFE_API_KEY` present (presence-checked only via `test -n`, never
  echoed or logged, per the non-negotiable rule).
- `npm ci` exit 0; `npm run build` -> `BUILD: ok out=dist files=106`;
  `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` exit 0.

**Note on package version**: `package.json` reads `"version": "0.2.1"` on
this branch/commit even though `src/core/CLAUDE.md` and the QA plan both
refer to "0.3.0" behavior (gate default, forced handoff). Not investigated
further (out of scope for a REPORT-only pass); flagged as an environment/
naming quirk for the operator.

## Part 1 — per-file results (one file per invocation, strictly sequential;
chrome leftovers checked after every file via `ps aux | grep -i chrome | grep
-v grep`, filtered for non-defunct entries — **stayed empty after all 50
files**, zero `LEFTOVER CHROME` lines logged by the driver script)

Totals: **50 files, 647 tests, 645 pass, 1 fail, 1 skip (win32-only,
chrome-cmd)**.

Full per-file counts: `logs/summary.tsv`. Every file passed fully except:

| file | tests | pass | fail | status vs r3 | notes |
|---|---|---|---|---|---|
| adapter-cdp | 8 | 7 | 1 | **still fails, different element, larger delta, root-caused** | see F1 below |
| chain-e2e | 8 | 8 | 0 | **FIXED** (was 7/8 in r3, F2) | E3 fully green, both the good-case leg and the bad-`none` leg |
| conformance | 28 | 28 | 0 | **FIXED** (was 26/28 in r3, F3) | scroll-moves-many.html now passes |
| pick-e2e | 2 | 2 | 0 | **FIXED** (was 1/2 in r3, F4) | P1 fully green: bounce, pick, and the post-pick `done` leg |

`adapter-cdp` was re-run once, alone, after confirming zero leftover chrome:
identical failure both times (stable, not a flake — `logs/adapter-cdp.log`,
`logs/adapter-cdp.rerun.log`).

### F1' — `adapter-cdp` "observe matches the pinned form.html table": the
window-size fix now over-corrects — the whole row no longer wraps at all,
one element downstream of r3's finding

r3's symptom (round 3, same fix already in place): `element 3 (Country)
rect.x=677 not within 20px of pinned 647` — a 30px residual drift, described
as "the row no longer wraps ... elements land ~30px right of pinned",
flagged as a hypothesis pending a `Page.getLayoutMetrics` probe r3 did not
have time to run.

Round 4, same commit, same container class, both runs identical:

```
element 4 (Continue) rect.x=780 not within 20px of pinned 8
```

This is a genuinely different failure: element 3 (Country) now passes (its
own tolerance-relative check — see below — is satisfied); the test now fails
on element 4 (`Continue`), which the pin says wraps to a NEW LINE after
Country (pinned `Continue` is at x=8, a full row below `Country`'s x=647..750
— the test's own comment states the pinned gap Country->Continue is -742,
i.e. a genuine row break). The commit under test (3e14098) already rewrote
the geometry-tolerance helper to check row-break elements absolutely and
same-line elements via a gap-from-previous relative check specifically to
stop compounding font-drift errors (its own comment cites a 24px compounding
example) — that rewrite is correct as far as it goes, but it still assumes
the row-break itself reliably reproduces, which it does not in this
container.

**Root cause, directly measured, not inferred** — ran the product's own
`launchEphemeralChrome` + a raw CDP session against `fixtures/pages/form.html`
(`logs/geom-probe.mjs`, output in `logs/geom-probe-form-html.log`):

```
layoutMetrics.cssVisualViewport: clientWidth=1280 clientHeight=660
page eval: bodyMarginLeft="8px"
rects: fullname x=72.4  w=185
       email    x=257.4 w=185
       notes    x=442.4 w=182  (textarea, taller, same visual row)
       country  x=676.9 w=103
       continue x=779.9 w=69.4   <-- SAME ROW as country (y=100.9 for all of them)
       place    x=849.3 w=84.2   <-- also same row
```

At `CHROME_WINDOW_SIZE_ARG = '--window-size=1280,800'` (`src/browser/chrome.ts`),
the usable content width in this container (1280px window, 8px body margin
each side, no scrollbar taken since headless) is roughly 1264px — comfortably
wide enough for form.html's entire six-control row (ending at `place`'s right
edge, ~933px) to sit on ONE line. The pinned fixture data was captured on a
narrower viewport — narrow enough that `Country` (ending ~750px) fit on line
1 but `Continue` (needing another ~70-100px) did not, forcing exactly the one
row break the test's row-break detection logic depends on. At 1280px that
row break simply does not occur in this container: **the fixture's pinned
row-wrap assumption and this container's 1280px window width are mutually
incompatible**, independent of font-metric drift. This is the same
underlying trade-off r3's F3 flagged for `many.html` (the window-size fix
that stops `many.html`'s content from overflowing enough to scroll) showing
up a second time, in a different fixture, one element further into the row
than r3 observed. Not a flake, not a test-authoring bug, not something a
retry or a larger tolerance constant fixes — the fixed 1280px width and the
pinned wrap point are simply incompatible on this class of container.
Evidence: `logs/adapter-cdp.log`, `logs/adapter-cdp.rerun.log`,
`logs/geom-probe-form-html.log`, `logs/geom-probe.mjs`.

## Part 1 — gates

- `DISPLAY=:99 node scripts/gates/lazy-chrome.mjs --dist dist` ->
  `LAZY-CHROME: ok listed=24 chrome=0 answered=false` (`logs/lazy-chrome-ok.log`).
- `DISPLAY=:99 node scripts/gates/lazy-chrome.mjs --dist dist --known-bad
  tool-call` -> exit 1, `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true`
  (`logs/lazy-chrome-known-bad.log`). Both as expected.

## Part 1 — known-bad proofs (all four, this round)

Per the runbook, r1/r2/r3's own known-bad proofs already stand as PROVEN and
were not redone. All four of THIS round's proofs cover commit 3e14098 and
were each: flipped, built into their own scoped `.build/kb-*` dir (proof (a)
needed no rebuild — fixtures are read live from the repo tree via
`packageRoot()`, confirmed by reading `src/fixture-server.ts` before
assuming otherwise), run, confirmed to fail, then restored with
`git checkout --` and `git status --short` confirmed clean before the next
proof. `tsc --noEmit` re-confirmed exit 0 after the last restore.

| # | flip | result | evidence |
|---|---|---|---|
| (a) | `fixtures/pages/many.html`: remove `style="padding-bottom:2000px"` | **PROVEN** | `conformance` "scroll moves many.html down" fails on BOTH adapters: `expected a positive scrollY, got 0` (`logs/kb-a-many-html-padding.log`). No rebuild needed — the fixture server reads `fixtures/pages/*.html` straight from the repo tree at request time. |
| (b) | `tests/adapter-cdp.test.ts`: pinned Country `rect.x` 647 -> 687 (+40px) | **PROVEN**, via a different assertion than a literal absolute-x message — Country is a same-line (non-row-break) element under the commit's own row-break/relative-check split, so the failure surfaces as the gap-from-previous check: `element 3 (Country) x-gap from the previous element=53 not within 20px of pinned gap 93` (`logs/kb-b-country-x40.log`). The +40px pin shift shows up as a +40 shift in the PINNED gap (53->93) while the actual measured gap is unaffected — still a clean, deterministic fail caused exactly by the flip. |
| (c) | `tests/pick-e2e.test.ts`: `startPickStub`'s content-keyed `phaseB` reverted to a raw request-count `reqNo >= 4` | **PROVEN** | P1 fails: `call 2 contacted the stub exactly once` — `2 !== 1` (`logs/kb-c-phaseB-reqno.log`). The count-based phase switch answers call 2's first request as phase A (not yet switched), forcing an extra round trip — the exact defect class the content-keyed fix (2026-09-27, documented in `src/core/CLAUDE.md`) replaces. Needed a 2-entry scoped build (`tests/pick-e2e.test.ts` + `src/cli/main.ts`) — the test spawns the CLI by path without importing it, so a test-only scoped build leaves the binary missing and every call fails with `MCP error -32000: Connection closed` (first attempt hit exactly this; caught, diagnosed, and rebuilt correctly per the CLAUDE.md gotcha for `cli.test.ts`). |
| (d) | `tests/chain-e2e.test.ts`: removed the `gotoFixture('chain-index')` call before E3's bad-urlAnswer (`'none'`) loop | **PROVEN** | E3 fails: `urlAnswer none` expected `'fallback'`, got `'ambiguous'` (`logs/kb-d-e3-no-gotofixture.log`) — exactly the tab-ambiguity leak `src/core/CLAUDE.md`'s 2026-09-27 note describes (the shared tab is left on `chain-form.html` after the good-case leg navigated it away, so `url_match: 'chain-index.html'` matches zero visible pages and `runDoRounds` returns `ambiguous`/`tab-ambiguous`, which reads exactly like a leaked `decideTarget` ambiguous unless the `reason` field is checked). Also needed the 2-entry scoped build (test + `src/cli/main.ts`), same reason as (c). |

## Part 2 — FORCED-HANDOFF BENCHMARK

**Not run.** Part 1 is not green (`adapter-cdp`, 1/8, reproduced on an
isolated re-run and root-caused live). Per the QA plan's explicit stop rule,
neither `bench/run.ts` nor `bench/forced-verdict.ts` was exercised. No new
`bench/results/*.json` entry was written; the phase ledger (measured at
**$5.814594** across the 7 existing files in `bench/results/`, computed the
same way `phaseSpentFrom` does) is unchanged by this pass.

## Part 3 — FRESH-INSTALL CHECK

**Not run.** The Part 3 header in the runbook gates it on "Part 1 is green"
(independently of Part 2's outcome) — Part 1 did not reach green, so Part 3
was not attempted either.

## Linux-only coverage

Same caveat as rounds 1-3: all results are Linux-only. The win32
PowerShell process-listing/sweep path (beyond the `'win32'`-forced unit
test), Windows candidate discovery beyond the path-list logic, `taskkill`
paths, and Windows window show/hide all remain unverified by this pass.

## A correction to r1-r3's spend narrative

r3 (and, by the same wording, r1/r2) states: "Part 1's real-Chrome e2e test
files ... made real TypeSafe API calls; ... the harness does not meter
TypeSafe spend per test run, so no dollar figure is available." This pass
checked that claim directly: `scripts/run-tests.mjs` unconditionally
`delete childEnv.TYPESAFE_API_KEY`s before spawning every test file (line
245), and every test file that references `TYPESAFE_API_KEY` (`chain-e2e`,
`pick-e2e`, `mcp-server`, `cli`, `config`, `doctor`, `registrations`,
`scaffold`, `setup-plan`, `bench-browse`, `bench-cap`,
`browse-step-surface`) sets a literal `'dummy-key'` (or similar placeholder)
into its own spawned-process env and points the server at a local
`startTypeSafeStub` HTTP server, never the real TypeSafe endpoint. **Part 1
makes zero real TypeSafe API calls, in this round or (by the same
mechanism) presumably in r1-r3 as well** — the "no dollar figure available"
framing undersells it: the correct statement is "$0, not merely
unmeasured." This is stated as directly observed fact (the grep and the
deletion line), not a hypothesis.

## Total spend

Part 2 (cap $15) and Part 3 (cap $4) were not run — $0 against both caps.
Part 1 made $0 in real TypeSafe spend (see correction above, confirmed by
reading the runner's env-scrub code and every test file that references the
key). The only real spend this entire pass was the prereq `claude -p 'say
ok'` check — one trivial real Claude API call. Total spend across this pass
is a small fraction of a cent, well under the $19 stated cap.

## What could not be completed and why

- **Part 2 and Part 3**: blocked by the stop rule — Part 1 is not green.
  Not a spend-cap or environment block; purely the adapter-cdp failure.
- Nothing else was left incomplete: all 50 test files ran (including both
  required re-runs of the one failing file), both lazy-chrome gate modes
  ran, and all four known-bad proofs for this round were completed and
  restored cleanly.
