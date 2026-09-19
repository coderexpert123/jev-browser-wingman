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
