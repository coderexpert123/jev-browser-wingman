# jev-browser-wingman — execution notes

Build spec: `<private PA repo>/plans/2026-09-19-jev-browser-wingman-SPEC.md` (dispatch
authority; builders execute verbatim). Gates: `node scripts/build.mjs`,
`node scripts/run-tests.mjs [--dist <dir>] [basename ...]`,
`scripts/gates/{import-boundary,notices,lazy-chrome}.mjs`.

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
