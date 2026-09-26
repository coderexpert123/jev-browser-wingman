# t9-long-chain A/B rerun — 2026-09-26 (r2)

This rerun follows up on `bench/ab-2026-09-26` (all 6 cells failed the oracle,
including both playwright-route controls). Part 1 below diagnoses and fixes
the environment cause; Part 2 reruns the A/B once the harness can actually
reach the target site.

## Part 1 — root cause and fix

**Root cause:** this container's outbound HTTPS goes through an
egress/agent proxy that re-terminates TLS with its own CA. That CA is
installed into the system trust store (curl, Node's default CA handling,
etc. all trust it — `curl https://the-internet.herokuapp.com/...` returns
200 with no `--cacert` needed). Chrome/Chromium on Linux, however, verifies
certificates against its own bundled **Chrome Root Store** and ignores the
OS/NSS trust anchors for this purpose. Every HTTPS navigation to
`https://the-internet.herokuapp.com` therefore hit
`chrome-error://chromewebdata/` ("Your connection is not private" /
`NET::ERR_CERT_AUTHORITY_INVALID`) instead of the real page — for **both**
the playwright route and the browse route, which is exactly why all 6 cells
of the original run failed the oracle regardless of mechanism.

Reproduced directly with a bare CDP navigation:
- Without the fix: `document.title` → `"Privacy error"`, `location.href` →
  `chrome-error://chromewebdata/`.
- With the fix: `document.title` → `"The Internet"`,
  `location.href` → `https://the-internet.herokuapp.com/checkboxes`, real
  page content.

A second, independent problem: this container runs as `uid=0` (root), and
Chrome refuses to start at all as root without `--no-sandbox`
(`Running as root without --no-sandbox is not supported`). Passing
`--no-sandbox` was avoided as an unnecessary weakening of the browser
sandbox for an automated bench harness.

**Fix (environment/harness only — no changes to `src/` or to
`bench/tasks.json`'s oracle):**

- `/opt/pw-browsers/chromium` (the pre-installed Chromium) is symlinked at
  `/usr/bin/chromium`, which is the first Linux candidate
  `findChrome()`/`chromeCandidatesForPlatform()` in `src/browser/chrome.ts`
  resolves to when Chrome/Edge/Brave are absent (they are, in this image) —
  no code change needed there, only that the binary now exists at that path.
- `/usr/bin/chromium` is actually a wrapper script
  (`/usr/local/bin/chromium-wrapper.sh`) that:
  - drops privileges to the unprivileged `nobody` uid via `setpriv` before
    exec'ing the real Chromium binary, so the real Chrome sandbox stays
    enabled (no `--no-sandbox`);
  - chowns the `--user-data-dir` (parsed out of the forwarded argv) to
    `nobody` first, since `ensureChrome()` creates that directory as root;
  - appends `--ignore-certificate-errors` so navigation through the
    TLS-reterminating proxy succeeds;
  - sets `HOME`/`XDG_CACHE_HOME`/`XDG_CONFIG_HOME` to a writable scratch dir
    for `nobody` (fontconfig cache, crashpad database).
- `Xvfb :99` provides the real X11 display the harness's headed/offscreen
  Chrome launch (`window: 'offscreen'` in `bench/config.json`) needs;
  `DISPLAY=:99` is exported for every bench invocation.

None of this touches `src/browser/chrome.ts`'s `CHROME_ARGS`/`modeArgs`, the
product's own Chrome-launch logic, or the task/oracle definitions in
`bench/tasks.json` — it is purely how this one sandboxed container finds and
runs a Chrome binary.

**Verification (success gate):** one playwright-route
`t9-long-chain` cell (`--cap-usd 5 --phase-cap-usd 10 --routes playwright`)
now completes `ok: true` (wall 64.3 s, $0.815), where the same command
without the fix reproducibly hits the privacy-error interstitial and the
oracle (`location.pathname === '/status_codes/404'`) never becomes true.
Diagnosis spend: ~$0.81 of the $4 budget.

## Part 2 — A/B rerun

BEFORE = commit `153f2d3` (a `git worktree` checkout), AFTER = current
`main` (`9008c39` + the two harness-only instrumentation commits described
below). Both worktrees ran with `bench/config.json`'s `gate_off: true` and
`policy_off: true` set as an **uncommitted local edit** (the operator's real
configuration), never committed. 6 cells, strictly sequential, one Chrome
launch/teardown per cell, `wingman-ephemeral` processes swept clean between
cells (confirmed empty after every cell). Total Part-2 spend: **$4.87** of
the $12 hard cap.

### Per-cell results

| # | Side | Route | Rep | OK | Wall (s) | USD | Browser tool calls | Wingman/browse calls | Fallback-status calls | Internal rounds |
|---|--------|------------|-----|----|---------:|------:|------:|------:|------:|------:|
| 1 | before | browse     | 1 | ✅ true | 112.4 | 0.8654 | 23 | 11 | 1 | 20 |
| 2 | after  | browse     | 1 | ✅ true | 111.0 | 0.8749 | 23 |  9 | 0 | 19 |
| 3 | after  | playwright | 1 | ✅ true |  64.9 | 0.8992 | 27 |  0 | — | — |
| 4 | before | browse     | 2 | ✅ true | 130.0 | 0.7969 | 23 |  8 | 1 | 60 |
| 5 | after  | browse     | 2 | ✅ true |  95.8 | 0.6052 | 21 |  9 | 0 | 18 |
| 6 | after  | playwright | 2 | ✅ true |  71.7 | 0.8291 | 30 |  0 | — | — |

**All 6 cells passed the oracle** (`location.pathname === '/status_codes/404'`),
confirming the Part 1 fix holds across both routes and both sides.

"Fallback-status calls" is the harness's literal count of calls whose
`status === 'fallback'` (`bench/run.ts`'s `wingman.fallback` field). It
under-counts how often control actually returned to the calling agent — see
the per-handoff table below, where `error`/`ambiguous` statuses also hand
the step back but aren't tallied there.

"Browser tool calls" counts every `mcp__playwright__*` and
`mcp__jev-browser-wingman__*` tool_use block combined, so for browse cells
it is wingman/browse calls **plus** the raw Playwright calls the caller made
itself after a bounce:

| Cell | Wingman/browse calls | Raw Playwright calls (derived) | Wingman share of calls |
|---|---:|---:|---:|
| 1 (before) | 11 |  12 | 48% |
| 2 (after)  |  9 |  14 | 39% |
| 4 (before) |  8 |  15 | 35% |
| 5 (after)  |  9 |  12 | 43% |

(This is a call-count share, not an action-count share — one `browse_step`
call can itself execute several internal rounds, so it is not directly
comparable to one raw Playwright click/type call.)

### Per-handoff breakdown (browse-route cells)

Extracted by joining each `mcp__jev-browser-wingman__browse_step`
`tool_use`/`tool_result` pair in the captured transcript (harness-only
instrumentation added for this rerun, see below) — the `note` field is
truncated to save space; it is one of the product's static handoff strings.

**Cell 1 (before-browse-1)** — 11 calls:

| # | status | reason | steps |
|---|---|---|---:|
| 1 | error | invalid-input | 0 |
| 2 | error | invalid-input | 0 |
| 3 | error | invalid-input | 0 |
| 4 | ambiguous | target-uncertain | 2 |
| 5 | fallback | step-uncertain | 0 |
| 6 | ambiguous | target-uncertain | 1 |
| 7 | ambiguous | target-uncertain | 2 |
| 8 | ambiguous | target-uncertain | 1 |
| 9 | error | page-error | 2 |
| 10 | ambiguous | target-uncertain | 2 |
| 11 | error | page-error | 1 |

**Cell 2 (after-browse-1)** — 9 calls:

| # | status | reason | steps |
|---|---|---|---:|
| 1 | error | invalid-input | 0 |
| 2 | error | invalid-input | 0 |
| 3 | ambiguous | target-uncertain | 2 |
| 4 | ambiguous | target-uncertain | 2 |
| 5 | ambiguous | target-uncertain | 2 |
| 6 | ambiguous | target-uncertain | 1 |
| 7 | error | page-error | 2 |
| 8 | ambiguous | target-uncertain | 2 |
| 9 | error | page-error | 1 |

**Cell 4 (before-browse-2)** — 8 calls:

| # | status | reason | steps |
|---|---|---|---:|
| 1 | error | invalid-input | 0 |
| 2 | error | invalid-input | 0 |
| 3 | ambiguous | target-uncertain | 2 |
| 4 | ambiguous | target-uncertain | 23 |
| 5 | fallback | budget-steps | 24 |
| 6 | error | page-error | 2 |
| 7 | ambiguous | target-uncertain | 2 |
| 8 | error | page-error | 1 |

**Cell 5 (after-browse-2)** — 9 calls:

| # | status | reason | steps |
|---|---|---|---:|
| 1 | error | invalid-input | 0 |
| 2 | error | invalid-input | 0 |
| 3 | ambiguous | target-uncertain | 2 |
| 4 | ambiguous | target-uncertain | 1 |
| 5 | ambiguous | target-uncertain | 2 |
| 6 | ambiguous | target-uncertain | 1 |
| 7 | error | page-error | 2 |
| 8 | ambiguous | target-uncertain | 2 |
| 9 | error | page-error | 1 |

Two consistent patterns across **all four** browse cells, before and after
alike:

- The caller's **first 2–3 `browse_step` calls fail with
  `error`/`invalid-input`** (0 steps) before it constructs a valid call —
  this is a caller-side friction cost, not something that changed between
  the two code versions.
- The **last chain step (`Status Codes → open the 404 link`) always ends
  `error`/`page-error`**, most likely because the harness attaches
  Playwright/CDP against a page that itself returns an HTTP 404 for
  `/status_codes/404` (that is the whole point of the task step) and
  something downstream treats that as a page error. Since the *oracle*
  checks `location.pathname`, not the HTTP status, the calling agent still
  reached the right URL itself with raw tools after the bounce and every
  cell still passed.

### Medians and before→after deltas (n=2 per route/side)

| Route | Side | Wall median (s) | USD median | Fallback-status rate |
|---|---|---:|---:|---:|
| browse | before | 121.2 | 0.8312 | 2/2 (100%) |
| browse | after  | 103.4 | 0.7400 | 0/2 (0%) |
| playwright | after | 68.3 | 0.8642 | — |

Deltas (after vs. before, browse route only — no before-playwright cells
were in scope for this rerun):

- Wall: after ~17.8 s faster (≈ 15% lower median).
- USD: after ≈ $0.091 cheaper (≈ 11% lower median).
- Fallback-status rate: before 2/2, after 0/2.

### Honest verdict (n=2 per cell type)

**Nothing here exceeds plausible run-to-run noise.** With only two samples
per side/route:

- The wall-time and cost deltas are well inside the swing this repo's own
  history already documents for this exact task — the 2026-09-22
  clean-machine rerun notes in `CLAUDE.md` record the *same* browse/t9 cells
  varying ~1.7x–3.2x across passes purely from machine load, with no code
  change at all. A ~15% median difference from n=2 is not distinguishable
  from that noise.
- The "fallback-status rate" delta (2/2 → 0/2) looks like the more
  interesting signal, but the per-handoff tables above show the *substance*
  is nearly identical on both sides: both before-browse cells and both
  after-browse cells bounce back to the calling agent 7-10 times out of
  8-11 calls, mostly via `error`/`ambiguous`, not the literal `fallback`
  status. The metric the harness tallies as "fallback" happens to have
  landed on 1-of-N in both before cells and 0-of-N in both after cells, but
  that is one specific reason code (`step-uncertain` in cell 1,
  `budget-steps` in cell 4) out of many equally-disruptive bounce reasons
  that occurred on both sides. Calling this a real before→after effect from
  n=2, on a metric this coarse, would not be supportable.
- Both routes' `ok` rate is 6/6 (all cells), so the only thing this rerun
  can say with confidence is: **the environment fix restores both routes to
  a completable state**, and the two code versions did not diverge in
  success rate on this small sample.

A real before/after comparison of the 0.2.x tool-text change would need a
larger n run under controlled (single-session, no background load)
conditions, per the project's own load-sensitivity gotchas.

## Harness changes made for this rerun

- `bench/claude-run.ts` / `bench/run.ts`: added an optional
  `transcriptPath` capture (browse-route cells only) so the raw
  `stream-json` output could be joined into the per-handoff breakdown above.
  Purely additive (new optional field), no behavior change for existing
  callers/tests.
- Environment only (not part of this repo, so not committed):
  `/usr/local/bin/chromium-wrapper.sh` symlinked at `/usr/bin/chromium`, and
  `Xvfb :99` — see Part 1.
- `bench/config.json`'s `gate_off`/`policy_off` flip to `true` was made and
  used for every cell in both worktrees, but stays an uncommitted local
  change per the task's instructions — it is not part of this branch's
  commit.
