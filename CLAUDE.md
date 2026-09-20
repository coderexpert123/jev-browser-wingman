# jev-browser-wingman — execution notes

Build spec: `pa/plans/2026-09-19-jev-browser-wingman-SPEC.md` in the PA repo
(dispatch authority; builders execute verbatim; the absolute host path is
withheld — this file rides a public-bound repository). Gates:
`node scripts/build.mjs`, `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`,
`scripts/gates/{import-boundary,notices,lazy-chrome,readme-bench}.mjs`.

## Gotchas learned while building WP-F1 (2026-09-20)

- **Config rejects an explicit `"mode": "off"`** (`invalid mode: "off"`): `off` is the
  key-absent default (`src/core/config.ts`). Any test or fixture writing a config must omit
  the key, not write it.
- **The loop returns `fallback no-key` BEFORE it attaches** (`src/core/loop.ts`):
  `if (!deps.ask)` fires before driver attach. A test asserting browser contact on the first
  tool call must set a key/stub, or it records zero contact and the assertion is vacuous.
- **Round 2 acts again unless told not to**: the round request always carries `action` and
  `target`; a scripted stub that answers `done` but leaves `action` defaulted will click a
  second element before the loop reads `done`. Script `verb: 'none'` on terminal rounds.
- **`public_separation_check.py --mode contents` reads only COMMITTED trees**: uncommitted
  files print `SKIPPED CONTENT` and are never scanned (proven against a sentinel repo).
  Pre-commit, grep the owned files against `~/.pa/operator-identifiers.txt` directly;
  post-commit, run the official contents + paths scans (two `violations=0` lines).
- **`run-tests.mjs` output is pipe-buffered**: an empty interim output file does NOT mean a
  stalled run — TAP lines appear only at completion when piped. Check process liveness
  (command lines matching `build.f1` / `mcp-server.test`) before killing anything.
- **`guide.js` only exports `guideCommand`** — spawning it directly exits 0 without running.
  The CLI path under test is `main.js guide`; a temp package root for the missing-file test
  needs the whole compiled dist copied plus a `node_modules` junction and `"type": "module"`
  in the temp package.json.
- **`chrome ensure` under cold conditions can exceed its 10 s answer window** (observed once
  on an idle machine, succeeded on retry) — the lazy-chrome known-bad `eager-ensure` can
  then print `ok` spuriously; rerun before diagnosing.

## Gotchas learned while building WP-H (2026-09-20)

- **A CDP session attached AFTER `Target.createTarget` has navigated evaluates against the
  page's pre-navigation context** — `location.href` comes back `about:blank` even though
  `Target.getTargets` shows the new URL. Attach to a page target first, then `Page.navigate`
  over that session (the order `bench/run.ts` `resetPages` uses).
- **A failed `launchEphemeralChrome` leaks the spawned Chrome** (and its temp
  `wingman-ephemeral-` profile): `close()` is never reached when the DevToolsActivePort wait
  throws. Sweep `chrome.exe` processes whose cmdline carries `wingman-ephemeral-` after a
  failed launch, and rerun — one cold start took >15 s once and then passed on retry.
- **`evaluateOracle`'s false-only fallback means a false-only test cannot prove the oracle
  works**: a test that only asserts `false` outcomes (throws, `1 === 2`) passes for a
  permanently-false oracle. Keep at least one assert-true expression in any oracle test.
- **`run-tests.mjs` env scrub removes `TYPESAFE_API_KEY`** — bench-cap tests must inject the
  key through `BenchDeps.env`, never the process env.

## Gotchas learned while building WP-X (2026-09-20)

- **`pa run commit` refuses paths under your OWN active reservation** — claims are matched
  against the caller's session, so a builder cannot commit what it claimed. `pa release <id>`
  first, then commit; the release-then-commit pair is the pattern, not a tool bug.
- **A minimized Chrome window rejects a position-only `Browser.setWindowBounds`** — the
  left/top change errors until the window is restored (`windowState: 'normal'`) first.
  `chrome hide` therefore restores before moving off-screen; `chrome show` restores by
  definition (and the restore takes the foreground — that is show's purpose, RO-7).
- **`Browser.getWindowForTarget` is per-page**: collect distinct `windowId`s over the page
  targets or you will move one window N times and miss the others (same shape as § 3.15's
  minimise loop, which is the model for show/hide).
- **The spike's result JSON is deterministic** — a re-run that reproduces the wave-0 verdicts
  rewrites the `spike/results/*.json` files byte-identically and leaves git clean; no
  re-commit of evidence is needed (or possible) after a P4-semantics-only change.
- **A live headed Chrome in a unit test works off-screen**: direct-spawn with the anti-
  throttling flags plus `--window-position=-32000,-32000` on a `wingman-ephemeral-` temp
  profile, then measure via the PowerShell EnumWindows/GetWindowRect pattern from
  `scripts/gates/window-mode.mjs`. Assert the off-screen PRECONDITION before the show, or
  the both-ways assertion cannot discriminate.

## Gotchas learned while wiring show|hide into main.ts (2026-09-20)

- **A scoped `build.mjs --out <dir> tests/cli.test.ts` compiles only the test's import
  graph, and `cli.test.ts` spawns `src/cli/main.js` by path without importing it** — the
  scoped build leaves the CLI binary missing and EVERY spawn test fails (exit 1,
  empty stdout, "Cannot find module ... main.js"). Pass the CLI as a second entry:
  `node scripts/build.mjs --out <dir> tests/cli.test.ts src/cli/main.ts`.
- **`chromeCommand` tolerates a missing `config.json`** — defaults apply (`src/core/config.ts`),
  so a dispatch-level `chrome show` test with an empty `WINGMAN_HOME` reaches the port probe
  and must assert chrome-cmd's own `no-browser` JSON line (exit 1), not a `config:` error.
  Unwired, `chrome show` exits 2 with usage on stderr — that 2-vs-1 delta is the test's teeth.

## Gotchas learned while running OG-6 LIGHT (2026-09-20)

- **`detached: true` on the win32 cmd spawn in `bench/claude-run.ts` swallowed ALL
  stream-json output** — the child ran the full task (oracle true) but stdout was
  0 bytes, so `usage` stayed null and `browser_tool_calls` stayed 0 on every real
  run. Proven by A/B (identical spawn, only the flag flipped: 0 vs 1954 events).
  Fixed in 90ad51d; any future spawn through `cmd /c` must not be detached.
- **A fresh bench profile's first launch can miss `ensureChrome`'s 10 s window
  twice in a row** (first-run initialization on D:); a warm-up launch answered in
  ~3 s and the harness then reused it via the port-answering path. If
  `ensureChrome failed: Chrome did not answer`, warm the profile once by hand
  before blaming the port.
- **`claude --model sonnet` on the operator's machine resolves through the local
  GLM proxy** (`modelUsage: glm-5.3-flash[1m]`), so results `usd` is token counts
  priced at Sonnet list rates and `cli_reported_usd` is the proxy's own synthetic
  number (about 1.7x higher here). Route-vs-route wall-clock comparison is still
  valid — both routes used the same backend.
- **`stopChrome` skips a Chrome it did not start in that run** (`startedByUs:
  false`), so a manually launched diagnostic Chrome on the bench port survives the
  harness — sweep `chrome.exe` matching the bench profile afterwards.
- The readme-bench gate picks the newest `measure` results file by name; a
  cap-proof file never leaks into the README block (spec WP-H item 8 holds).


## Gotchas from the wave-5 final verification (2026-09-20)

- **The full suite cannot complete as ONE `node --test` invocation on a loaded
  16 GB machine.** The runner fans every file out in parallel; browser files
  then hold 160-225 Chrome processes at once, the machine wedges, and the
  runner hangs past an hour with no output (it buffers until the end). Working
  form: scoped runs in 4-6 chunks of 3-12 basenames against the built `dist/`,
  serially — same runner, same dist, sum the totals. Expect one
  parallel-load flake (a `Page.navigate` cdp timeout) per heavy chunk; it
  passes twice in isolation, so re-run the failing basename alone before
  treating it as a defect.
- **Killed test runners orphan their detached Chromes** on `wingman-ephemeral-*`
  temp profiles and they survive the parent; they must be swept (kill by that
  cmdline marker only) before any other suite can run, and the stale profile
  dirs under the OS temp dir need deleting too. Never kill a Chrome whose
  profile is the shared browser profile.
- **The spike's `--adapter dist-playwright|dist-cdp` mode (implemented 5839256,
  2026-09-20)** drives the shipped `createDriver` through `attach/pages/observe/
  act/detach` only, with act element ids found by matching the accessible name in
  the observation (`Continue` / `Full name` / `Show alert` — the fixture names the
  conformance tests already pin). The known-bad injections the Driver contract
  deliberately cannot express (`Target.closeTarget`, `Emulation.
  setDeviceMetricsOverride`, a main-world eval, `Target.createBrowserContext`,
  dialog answering) ride a harness-held raw side connection; P7's cookie read
  uses `Network.getCookies` from that same side client because the Driver has no
  cookie method. Gate I-11 PROVEN 2026-09-20 (867edab): both plain runs PASS,
  all ten known-bad runs flip exactly their target check on both adapters, and
  the close-page collateral cascade matches the wave-0 results — the side-
  channel injections discriminate identically to the in-actor ones.
- **Driver-actor fixture mapping**: `driver.pages()` is the page-id source (first
  page), and `count(selector)` becomes an observation filter — the Driver exposes
  no evaluate-by-selector, so the phase-R element-count read can only be expressed
  as `observe()` output (its value is never asserted).
