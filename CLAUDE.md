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

## Gotchas from OG-6 HEAVY (2026-09-20)

- **Chrome lives at `C:\Program Files (x86)\...` on this machine**, not
  `Program Files` — a manual warm-up launch from the default path fails with
  "cannot find the file". And `Start-Process -ArgumentList` joins array items
  with bare spaces: an unquoted `--user-data-dir=<unquoted path with spaces>` splits at the
  space, Chrome starts on a bogus profile, and `ensureChrome` refuses it
  ("uses a different profile"). Embed the quotes in the argument string.
- **The memory-pressure reaper kills idle-session background shells and the
  Chrome they spawned** (reaped a warm-up mid-launch; free RAM was ~1.3 GB).
  Run timed bench cells foreground, and after killing a bench Chrome sweep the
  surviving `--type=crashpad-handler` orphan by its bench-profile marker — its
  parent is dead and `stopChrome` never sees it. The harness guard blocks
  deleting top-level `D:\` dirs, so a mis-launch's stray `D:\My` (empty) stays.
- **A "wingman" route cell is only a wingman measurement if `typesafe.calls`
  > 0.** In the heavy pass the t3 wingman cell never called `wingman_do` (the
  model drove the Playwright tools directly) — route label alone does not tell
  you which mechanism ran; read `bench/results/*.json` `typesafe.calls` before
  interpreting any wingman-route row.


## Gotchas from the tool-routing fix (2026-09-20)

- **A tool description that leads with WHAT and then lists prohibitions gets skipped.**
  The t3 wingman cell bypassed `wingman_do` because the old `WINGMAN_DO_DESCRIPTION`'s
  second sentence was almost all "never …" clauses, it gave no benefit statement, and its
  three example verbs (row/form/wizard) excluded t3's enable-then-type shape — the agent
  read it as narrow and risky and picked the familiar Playwright tools, outweighing the
  bench prompt's "prefer wingman_do". Fix shape (203cf67): first sentence = WHEN (one
  bounded goal, public non-sensitive page), then a prefer-over-driving line with the
  benefit (loop runs internally, one compact result, saves a snapshot per step), then a
  do-NOT-use line. Schema friction was ruled out: only `goal` is required.
- **The "exact-string test" in mcp-server.test.ts compared code to code** — both sides
  imported the same constants, so spec drift was invisible. The pin must inline the SPEC's
  text as the expected value (now does); when adding a pinned-text export, add the
  spec-inline comparison, not a same-constant mirror.
- **Two concurrent bench phases on the shared port-9344 Chrome poison each other's
  results**: the second phase's `resetPages`/navigation collides with the first's, its
  claude run times out, and the killed_run_charge_usd (1.5) trips any per-run cap under
  1.5 before the wingman cell executes. Serialize bench phases; a phase-abort also burns
  the aborted phase's cap authority. Historical `phaseSpentFrom` sums ALL results files,
  so a "cap USD X for this check" translates to `--phase-cap-usd` = history + X.



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
  profile is the shared browser profile. (2026-09-22: runners that EXIT —
  normal, fail, or signal — now sweep their own token-tagged chromes at exit;
  the manual marker sweep is only for hard-killed runners and bench chromes.)
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

## Gotchas from the max_steps/delegation pass (2026-09-20)

- **Raising the step budget does NOT stop call fragmentation.** With
  `DEFAULT_BUDGETS.max_steps = 24` (fits t9's 19 steps) AND an explicit
  single-call instruction in the bench wingman prompt, the calling model still
  split t9 into 2 `wingman_do` calls plus ~20 raw Playwright calls in both
  passes (results 2026-09-20-1709/1716: wingman.calls=2, rounds=3,
  wingman wall 138 s / 174 s vs playwright 151 s / 167 s). The long-chain
  bottleneck is the calling model's planning, not the budget; wingman
  machinery remains ~1 s/round (observe+jev+act+settle) and is noise at this
  wall scale.
- **`BUDGET_LIMITS` caps caller overrides only**: `loadConfig` seeds
  `DEFAULT_BUDGETS` without validating against the limits (it validates keys
  present in the user's config), so default `max_steps: 24` with cap `[1, 8]`
  is coherent. The contract invariant test now exempts max_steps and pins 24
  explicitly (both pins proven to fail against 8). A user config value of
  `max_steps > 8` is still REJECTED — raising that cap is a separate decision.
- **The bench wingman-route prompt lives in `bench/run.ts` `buildPrompt`**,
  not `bench/claude-run.ts` (spawn layer only, passes `prompt` through).

## Gotchas from the route-neutral prompt pass (2026-09-21)

- **Fully route-neutral prompts (no steering clauses at all, e3d47bd) drop
  wingman_do entirely on the long chain**: t9 wingman cell ran 25 raw
  Playwright calls, `typesafe.calls = 0`, oracle false (results
  2026-09-21-0158). With the earlier soft steering the model at least
  fragmented into 2 `wingman_do` calls; with none it never delegates. The
  tool description alone does not win the route for multi-page chains —
  the "tool descriptions do the marketing" premise is not yet earned for
  t9-shaped tasks.
- **The phase-ceiling arithmetic is history-coupled**: results history
  stood at 10.3669, so ceiling 11 left only ~0.63 fresh authority, and two
  t9 cells cost ~1.04 — the run aborts at the ceiling even though each
  cell individually fits the 5/run cap. Any "raise ceiling to X + fresh
  authorization Y" pairing must be checked against `phaseSpentFrom` over
  `bench/results/*.json` first; aborted-after-N-runs still burns the whole
  phase's authority and both completed cells stay in the results file.

## Gotchas from the delegation-wall pass (2026-09-21)

- **`wingman_phases.jev_ms` is a rounds-median, and per-round jev is bimodal**
  (cold ~926 ms first round of each `wingman_do` delegation vs ~404 ms warm
  continuation rounds, stable across days). So the run-level median tracks the
  delegation mix, not machine load: the 360 s run's 880 ms was 4-of-5
  delegations returning `ambiguous` after one round (5 cold / 4 warm rounds),
  while the 395 ms run had 12 mostly-warm rounds. An 880 vs 395 comparison says
  "different delegation shape", never "Jev got slower". Round phases carry no
  state-size fields, so state-size effects are unmeasurable from results alone.
- **The t9 wingman delegation falls back on the sensitive-auth path and the
  wall is then lost to raw tools.** Even with the prioritizing prompt and a
  600 s ceiling (results 2026-09-21-0329): 1 `wingman_do` call, `fallback`
  reason `sensitive-auth-path` after 3 jev rounds, then the calling model
  ground 5 raw calls until the 600 s kill. A mostly-delegated t9 run does not
  complete by delegation; the fallback lane IS the run.

## Gotchas from WP-T1a (2026-09-21)

- **`buildRoutingRequest`'s `elements` parameter is deliberately not consumed
  inside the builder.** The § 3.18 element table rides in the request's `state`
  object, which the caller (T1b) builds as redacted `elementCriterion` strings;
  the builder passes `state` through unchanged and uses `steps`/`bindings` only
  for the `handle<k>`/`exec<k>` instructions. Do not "fix" it by injecting
  `elements` into the state here — that would double-redact and desync from the
  § 3.19 flow.
- **The `budgets` validation pattern silently accepts `NaN` thresholds.**
  `typeof v !== 'number' || v < min || v > max` passes NaN (both comparisons
  false); `budgets.*` is saved by `Number.isInteger`, but `takeover.threshold`
  needed an explicit `Number.isFinite`. Any future config key with a plain
  number range needs the same guard.

## Gotchas from the wave-6 deep-recheck (2026-09-21)

- **Adding a dimension to `bench/config.json` (e.g. a route) silently
  invalidates the count assertions in `tests/bench-cap.test.ts`.** WP-T3's
  scoped gate only ran `bench-browse`, and no wave-6 package owns
  `bench-cap.test.ts`, so the 9×2=18 / 1×2=2 totals went stale until the
  recheck (fixed in `910bc15`). Any future route/config-shape change must
  re-run `bench-cap` alongside the owning package's gate.
- **`if (false && <cond>)` is not a valid KB-mutation shape here**: the
  dead branch loses TS discriminated-union narrowing and the build fails,
  which silently tests the PREVIOUS dist. Mutate via a `const KB_X = true`
  flag composed with the condition instead (proven: gate bypass flips test
  7, pre-pass skip flips test 15, `>` flips test 1).

## Gotchas from OG-9 (2026-09-21)

- **Given the route-neutral prompt with BOTH `browse_step` and the legacy
  `wingman_do` visible, the caller never called `browse_step`** (valid cell
  2026-09-21-0727: 0 browse_step calls, 6 `wingman_do` + 2 `wingman_check`
  + 6 raw Playwright calls, wall 223.5 s, oracle false — the caller declared
  DONE after 2 of t9's 7 sub-steps). The front door does not win tool choice
  by default; takeover (a browse_step-only concept) never engaged, so OG-9's
  mechanism question is unanswered, not failed — the router was never
  invoked. Only two statuses appeared: `ambiguous target-uncertain` (4),
  `no-value`, `budget-steps` fallback (24 steps), `page-error`.
- **A spawned bench caller can come up with NO MCP servers despite a correct
  `--mcp-config` absolute path** (first cell, 2026-09-21-0713: the caller
  saw only user-scope servers, contradicting `--strict-mcp-config`, answered
  in text with zero tool calls, and cost 0.13 USD). Same CLI version,
  same command shape attached fine minutes later and in a zero-spend probe.
  Before charging a zero-tool-call cell to a mechanism, re-probe the exact
  spawn flags with a trivial prompt.

## Gotchas from the OG-9 isolation pass (2026-09-21)

- **Hiding the legacy tools fixes tool selection, not delegation** (results
  2026-09-21-0748, `WINGMAN_BROWSE_ONLY=1`, t9 browse cell): the caller DID
  delegate — 3 `browse_step` calls, 0 raw Playwright calls (unlike the mixed
  OG-9 cell's 0 browse_step) — but Jev bounced all 3 delegations back
  (`route-caller` x3, 0 takeovers, 0 takeover rounds, act_ms 0 across every
  round) and the caller answered DONE at 89.8 s with oracle false. Wall
  "beating" the 151-167 s baseline is give-up-early, not speed; the failure
  mode moved from "caller won't delegate" to "router won't take over".
- The isolation mechanism: `WINGMAN_BROWSE_ONLY=1` in `mcp-server.ts` hides
  wingman_do/wingman_check from tools/list AND refuses them at call time;
  `bench/run.ts` `mcpConfigFor` forwards the env (418a5d2). Unset = product
  default. Probe shape for verifying a spawned server's tool list: SDK
  StdioClientTransport against `dist/src/cli/main.js mcp` with a temp home —
  run the probe script from inside the repo tree or the SDK import fails to
  resolve (scratch-dir node cannot see the repo's node_modules).

## Gotchas from the OG-9 calibration audit (2026-09-21)

- **A leaked scratch Chrome holding the probe port silently poisons every
  later probe**: the port-answering fetch hits the zombie, whose backgrounded
  window reports `visibilityState: 'hidden'`, so every `wingman_do` returns
  `tab-ambiguous` with `jev_calls=0` and no ask is ever made. Always kill
  scratch chromes by their temp-profile cmdline marker (taskkill /T /F does
  not reliably take the tree from a plain launcher PID), poll the debug port
  CLOSED after teardown, and use a fresh port per run.
- **An off-screen headed Chrome needs the three `HEADED_ARGS` anti-
  backgrounding flags plus exactly ONE page target**, or `pages()` shows
  `visible:false` and the loop refuses before asking (`tab-ambiguous`,
  zero candidates = zero visible, not two tabs).
- **Ground-truth `wingman_do` fill probes must carry the value in `values`**:
  with `values: {}` the value question is never asked (bindings-only, § 3.6)
  and the step ends `no-value` — a probe artifact, not an execution failure.
- **Calibration result (OG-9 follow-up, 2026-09-21)**: the t9 form steps the
  router graded 0.05-0.1 and refused (threshold 0.5) EXECUTE fine — amount
  fill on `/inputs` (target listed as `spinbutton (no label)`, faithfully —
  the page has no accessible name), email fill and submit click on
  `/forgot_password` all act on the right element. Verdict: Jev over-refuses
  on low-state pages; the routing criterion needs recalibration, not the
  element table.

## Gotchas from the definitive t9 cycle (2026-09-21)

- **The bench task goal was never in any prompt until this fix**:
  `buildPrompt` sent base context + values + DONE only, so t9's oracle
  endpoint (`/status_codes/404`, the 7th of 7 chain steps) was unreachable
  by instruction. The goal now rides verbatim in every route's prompt;
  fail-first proof in `tests/bench-browse.test.ts` ("both routes carry the
  task goal verbatim"). Pre-fix "oracle false" results partly measure
  wandering, not tool failure.
- **With the goal in the prompt, `max_turns: 25` is the binding ceiling,
  not knowledge**: 6/6 definitive cells (playwright and browse, n=3 each)
  burned exactly 25 calls and never reached the 404 page. The 7-page chain
  needs ~2 calls/page minimum; 25 turns cannot fit it even with perfect
  routing. Any future t9 comparison must raise `max_turns` or the wall
  number measures the turn cap, not the route.
- **The browse route still gets zero delegation even with the goal
  verbatim** (3/3 repeats: 0 `browse_step` calls, 25 raw Playwright calls,
  no fallback/confirmation). Tool description alone still does not win the
  route; the browse-front-door premise remains unearned for t9-shaped
  chains. Median wall browse 144.4 s vs playwright 125.5 s — delegation
  overhead with no delegation.
- **max-turns-40 rerun (2026-09-21, c0e4daf + 3a0ec9c)**: with `max_turns: 40`
  and a one-line browse engagement prompt, engagement is solved but delegation
  is not — browse called `browse_step` 3 and 2 times per cell, yet **4/5 calls
  fell back** (3x `jev-error`, 1x `route-caller`, 1x ambiguous
  `target-uncertain`) and takeover engaged 0 times. Playwright went 2/2 oracle
  at 40 turns (median 159.0 s; the 25-cap bound is gone), browse 1/2 (rep2 hit
  the 600 s wall with only 5 raw calls). `jev-error` fallbacks, not the caller,
  are now the binding defect on the browse route: one prompt line flipped
  engagement 0->5 but the tool refused the work.
- **`repeats` has no CLI flag** — an n>1 run means temporarily editing
  `bench/config.json` `repeats` and reverting after; the results commit is
  pathspec'd to the results file only.

## Gotchas from the continuation-floor pass (2026-09-21)

- **The takeover continuation bar was never the takeover threshold** — until
  amendment 2026-09-21g (2960760) continuation rounds rode § 3.7 rule 6's fixed
  `THRESHOLDS.target` (0.5) with NO candidate-set check, so multi-candidate
  0.55 rounds acted mid-takeover. Briefs that say "continuation requires
  ≥ 0.7" describe the intent, not the code: read `decideTarget` and the
  constants before trusting a threshold narrative. The two-part rule now lives
  in rule 6 behind the `takeover` flag; `wingman_do` keeps the fixed bar.
- **The bench phase ledger is saturated**: `phaseSpentFrom` sums ALL of
  `bench/results/*.json` forever (30.11 as of 2026-09-21) against the hard
  `OPERATOR_CEILINGS.phaseUsd` of 30 — any `run.js` invocation now dies
  `BENCH-REFUSED: phase cap reached` before spending anything, and no CLI flag
  can raise the ceiling. The `--phase-cap-usd = history + X` practice is dead
  until the operator archives the results files or raises the ceiling; that
  rotation is a spend-authority decision, not a builder step.
- **`pa run commit` from a subdirectory still lands in the PA repo root** —
  wingman paths must be passed absolute; repo-relative paths resolve against
  `D:/Personal Assistant` and abort with `pathspec did not match`.
- **Active claims are foreign to the commit worker**: claims held by this
  session's CLI address are still "foreign" to the `pa run commit` zclaude
  worker (COMMIT-DEFERRED). Release claims (renew `--ttl 1`, let lapse) before
  committing, or the commit defers.

## Results from the takeover-tightening bench pass (2026-09-21)

- **First browse-route t9 oracle TRUE** (results 2026-09-21-1947,
  `BENCH_GATE_OFF=1 BENCH_POLICY_OFF=1`, cap 2.00): 9 `browse_step` calls,
  28 rounds (deep continuation real — one call ran 8 steps before a
  `budget-steps` fallback), 4 fallbacks (3x `step-uncertain` at entry,
  1x `budget-steps`), 3 mid-takeover `target-uncertain` bounces — the new
  rule-6 candidate-set bar bouncing exactly the multi-candidate rounds the
  old fixed 0.5 bar would have acted on. Wall 239.2 s (best browse wall yet;
  prior definitive cells killed at 600 s), typesafe spend 0.0013.
- **Same-shape playwright control** (2026-09-21-1950): oracle TRUE,
  158.4 s wall, 30 raw Playwright calls, 0.638 USD, 0 wingman involvement.
  Browse won USD (~16% cheaper), playwright won wall (~34% faster);
  n=1 per route — no statistical weight, direction only.
- **The phase-ledger saturation gotcha no longer reproduces**: `run.js`
  accepted `--phase-cap-usd 2.00` and both cells ran to completion —
  `bench/results/` now holds only the 2026-09-21 files, so the ledger was
  rotated since the 30.11 note. The `history + X` cap arithmetic works again
  against the fresh ledger.

## Gotchas from the real-page calibration (2026-09-21, calibration probe)

- **browse_step entry on two-stage pages ALWAYS bounces `step-uncertain`/`no-match`** (proven
  live on Amazon, Guardian and Wikipedia: 13/13 entry bounces with concrete target grades
  0.37–1.00, incl. 1.00 twice): `entryUncertainty` (src/core/loop.ts, § 3.19 item 3) reads
  `answers['action']` from `decisionAnswers`, which is request 2 in the two-stage shape — and
  request 2 never carries `action` (pinned by loop.test.ts's two-stage test). Plain `wingman_do`
  rounds are unaffected (decideTarget gets both maps). Fix shape: pass the request-1 answers
  into the entry decision too. The two-stage test only covers non-entry rounds, which is why
  the suite stays green.
- **Jev's entry grades on real pages are bimodal and mostly honest about element choice**:
  0.83–1.00 when the step's target was a well-labeled listed element, 0.37–0.38 when genuinely
  ambiguous — but grades measure element choice only, never actability. 7/9 high grades that
  were actually executed failed on `CoveredTargetError` (sticky header/consent overlay covers
  the target on Guardian and NPR; Amazon's native sort select is covered by its styled control).
  The question set has no "is it covered" probe; `blocked` asks only about captcha/paywall/etc.
- **CAPTCHA_RE (page-scripts.ts) false-positives on whole real pages**: bbc.com and npr.org
  both embed an iframe/element matching /captcha/i (login/ad widgets), so every browse_step
  returns `blocked/captcha` BEFORE any ask (zero spend, zero grades). News sites are effectively
  off-limits to the loop until the signal is scoped to real challenge widgets.
- **Headless GitHub serves the loop a reduced repo page**: only 154 elements enumerated, no
  Issues/Star/Watch/search targets in the table — Jev's `none` answers (0.86–0.99) were honest
  given the table; the table, not the grader, was the bottleneck. GitHub steps then degrade to
  a committed `scroll` (single-candidate rule) and `budget-steps`.
- Probe artifacts (untracked `.calib/`, keeper of results-*.json): the ask-spy wrapper records
  per-ask target probabilities, the direct-Driver phase executes Jev's own top candidate to get
  would-succeed evidence, and verification is outcome-based main-world evals. Note: the
  `twoStage`/`groupCount` fields in results-*.json under-report (detection bug in the spy), the
  reliable two-stage markers are per-ask `count` ≈ 90 (top-3-groups subset) and askCount = 4
  for 2 rounds.

## Gotchas from the amendment 2026-09-21h implementation pass (2026-09-21)

- **The scripted ask echoes `S()` defaults into EVERY request** — a two-stage
  test whose request 2 should carry no `action` answer must say
  `S({ ..., action: undefined })`, or the fake smuggles the verb in and the
  fail-first test passes against the un-fixed code (proven: the carry test
  passed pre-fix until the key was dropped, then failed `no-match`).
- **Fix shape that satisfies the two-stage + obstruction pins**: the entry
  decision gets `{ ...primary, ...secondary }` (request 2 never repeats the
  verb question); the covered-target gate sits between entry commit and
  `decideTarget` — before any value ask, after the retry decision, so a
  covered target costs one ask, zero acts, and no self-retry.
- **Enumerate probe semantics**: `elementFromPoint` at the rect center; a
  point off-viewport answers null and is NOT evidence of a cover (`obscured`
  stays false), and a `pointer-events: none` cover is skipped by the browser
  so it never reports covered — act-time `CoveredTargetError` remains the
  backstop for both.
- **The leaked-Chrome wedge is self-compounding**: the one-invocation full
  suite held 160-225 Chromes, leaked ones pushed the box to 440 chrome.exe,
  and at that point WMI, `tasklist` AND `Get-Process` all stall — the sweep
  itself cannot enumerate. Sweep by the `wingman-ephemeral-` cmdline marker
  IMMEDIATELY after each chunk (scoped runs leak a few per launch failure),
  and never run the suite as one invocation on this 16 GB machine.
- **`run-tests.mjs` output piped through `tail` loses everything but the
  tail**: the runner buffers until the end, so `... | tail -40` in a gated
  shell shows only the last screen — a 2-fail summary with the first failure
  discarded. Redirect to a file, then read the file.

## Gotchas from the teardown-hardening pass (2026-09-22)

- **The runner token sweep is now the leak guarantee; per-test finally-blocks
  are best-effort only.** Every `run-tests.mjs` invocation mints a unique
  `WINGMAN_RUN_TOKEN`, passes it to each spawned test's env, and — before exit
  on normal, fail, and delivered-signal paths (plus a sync `process.on('exit')`
  fallback) — kills any chrome.exe whose command line carries
  `--wingman-run-token=<token>` (PID tree; every kill logged as
  `RUN-TESTS: chrome sweep (...)`). `launchEphemeralChrome` copies the env
  token onto each chrome's command line, so every test chrome is tagged;
  production and bench (token unset) are unchanged. A sync exit-registry
  backstop in `tests/helpers/chrome.ts` tree-kills any browser still
  registered when a test process dies without closing it. Fail-first proofs:
  `tests/runner-sweep.test.ts`, both driving real code over a real leaked
  chrome (the leak fixture is `tests/runner-sweep-leak.test.ts` — never
  "fix" it; it is the drill target, and its chrome is killed by the sweep at
  each run's exit).
- **The token sweep cannot cover a hard-killed runner** (SIGKILL / taskkill of
  `run-tests.mjs` itself): nothing survives that knows the token. Sweep run
  leftovers manually by the `wingman-ephemeral-` cmdline marker as before —
  and never kill a Chrome whose profile is the shared browser profile.
- **Never tag a test Chrome with an extra unknown switch** (`--wingman-run-
  token=...`): headless chrome writes `DevToolsActivePort` but its HTTP
  endpoint never answers, so `launchEphemeralChrome` returns an endpoint
  `chromeStatus` calls dead (A/B proven 2026-09-22, chrome.test
  `launchEphemeralChrome returns an answering endpoint`). Chrome tolerates
  unknown switches in general but not on this startup path — any future
  tagging must ride `--user-data-dir` (as the token now does) or another
  blessed argument.
- **`cli.test.ts`'s `chrome show` no-browser test fails whenever the shared
  bench Chrome is up** (it answers on default port 9222, so `chrome show`
  succeeds with exit 0). Not a code defect: stop the shared-profile Chrome
  (owner session's call) or run the test when it is down. Observed 2026-09-22
  during the teardown-hardening gates.

## Gotchas from the OG-1 profileHolders fix (2026-09-22)

- **Chrome's own child processes carry `--user-data-dir` but never the debug
  port** (`--type=gpu-process`, `--type=crashpad-handler`, `--type=utility`,
  …), and the main browser process never carries `--type=`. Any holder
  detection that counts every chrome.exe matching the profile marker puts the
  running managed Chrome's own children in `withoutPort` and FAILs preflight
  G4 / verify V4 / doctor `profile-safe` while the managed Chrome itself is
  up — the OG-1 cutover halt (shared Chrome 58260, children flagged). Fix
  b9f3b14: `profileHolders` skips cmdlines containing `--type=`. Parent-pid
  attribution was considered and rejected as less robust on Windows cmdlines.
- **The gate semantics are "FOREIGN holder"**, not "any holder": a foreign
  chrome on ANOTHER profile is never a holder of this profile at all
  (`profileHolders(profile)` only matches that profile's marker), and a
  foreign chrome on THIS profile without a port still must fail the gates —
  both pinned by the fixture matrix in `tests/chrome.test.ts`.
- **`run-tests.mjs` basenames EXCLUDE the `.test.js` suffix** — the runner
  appends it (`chrome` → `chrome.test.js`); passing `chrome.test` matches
  nothing (`No test files matched`).

## Gotchas from the margin-rule pass (2026-09-22, amendment 2026-09-22)

- **The two-stage decision map is stage-2's alone**: a dominating stage-1 target grade (the measured 0.66) never enters the entry/continuation decision — `{...primary, ...secondary}` takes request 2's target answer wholesale, and stage 2 re-grades from scratch. The margin rule therefore fires only when ONE answer map holds both the dominating element and the beaten meta-answer; on two-stage pages a big stage-1 grade followed by an `ambiguous` stage-2 choice still bounces, by design. The `budget-steps`-at-8 mystery was simpler: the caller passed `max_steps: 8` in that `browse_step` call (schema allows 1–24; `runDoRounds` takes `min(caller, config 24)` — loop.ts's `maxSteps` line). Config default 24 applied in every other recorded call.
- **The pre-2026-09-22 entry commit never checked the floor on the CHOSEN element** — `set.size === 1` committed any lone candidate at ANY grade below the threshold (the floor gated only rivals). Found by the KB-margin run: takeover test 35's 0.45-lone-candidate round acted pre-amendment. Any future "the entry floor is 0.5" narrative must cite the margin rule, not the old candidate set.
- **A stub `ask` must return `usage` in the result** (`{inputTokens, outputTokens}`), or `askWithCost` throws inside the loop and the call ends `error/tool-fault` with no visible stack — the scripted fakes in tests carry it, hand-written probes don't by default. Also: wrapping `createDriver(...)` by iterating `Object.keys(base)` produces an EMPTY driver (methods live on the prototype) — same silent `tool-fault`. Diagnose either with a direct `runStep` call (unmasked exception) instead of `createWingman`.
- **Jev's live grades are bimodal across re-asks of the SAME step**: the measured searchbox entry graded 0.66 (2026-09-21) and 0.48 (2026-09-22 re-ask) — a sub-floor re-ask bounces correctly under the margin rule and is NOT a regression. Validation of a grading-shape fix needs a measured-map replay through the real pipeline (`.calib/probe6b-replay.mjs` pattern), not one natural re-ask.

## Gotchas from the escalating-bounce pass (2026-09-22, amendment 2026-09-22)

- **`ensureChrome` waits only 10 s for the debug port** (`src/browser/chrome.ts`): a cold
  Chrome start can exceed it and the bench dies `ensureChrome failed: Chrome did not answer
  on port 9344 within 10 s` BEFORE any spend, leaving no results file. Verified: port free,
  zero leaked chromes, immediate clean retry succeeds. One retry is the fix; do not diagnose
  deeper on the first failure.
- **The Claude Code background-shell memory-pressure reaper kills a RUNNING bench cell**:
  with the box low on free memory, an idle-time reap stopped a mid-flight cell's wrapper
  (system message, not the command failing). The run.js death orphans the bench Chrome tree
  on port 9344 — sweep by the `wingman-ephemeral` cmdline marker IMMEDIATELY (7 processes
  after one reap). A reaped cell writes no results file and no ledger entries; the phase
  ledger stays where it was. Restart only after memory recovers, or the next cell is reaped
  too (and a low-memory Chrome workload risks the 440-chrome wedge).
- **The escalating bounce note is bounce-only by design**: bounces are exactly
  `fallback`/`step-uncertain` and `fallback`/`target-covered`; the per-goal counter
  (module-level `Map` in loop.ts, keyed on goal text) increments only on those, tiers 2/3
  REPLACE the note while tier 1 appends. `takeover-offered`, `budget-*` and continuation
  `target-uncertain` ends keep the static § 3.17 table — the takeover note-table test and
  the covered-target test needed fresh goal texts because earlier bounce tests share the
  process-level counter (each test file is its own process, but tests within one file are not).
- **`BROWSE_ENGAGEMENT_LINE` stays single-line ASCII**: the 2026-09-22 operator text's
  em-dash is folded to a hyphen for the win32 cmd spawn; keep any future wording change folded.

## Results from the margin-rule validation bench pass (2026-09-22, 5 cells)

- **Browse completed 3/3 for the first time** (results 2026-09-22-1059/1111/1125, all
  t9-long-chain, gates off): walls 355.0 s (clean), 600.4 s (killed at the per-run
  ceiling, oracle TRUE after the kill — the 1.5 killed-run charge booked and llm
  telemetry lost), 580.9 s (clean). The bounce-stall failure mode that killed 4/6
  cells in the 2026-09-21 final campaign is gone — 4 bounces total across the pass
  (2+2+0), no tier-3 storm, no jev-error fallback storm.
- **Playwright controls** (2026-09-22-1129/1131): oracle TRUE 2/2, 199.8 s and
  161.0 s. Browse median 580.9 s vs playwright median 180.4 s — browse ~3.2x slower
  (the 2026-09-21 pair was 239.2 vs 158.4, ~1.5x). Quality parity is now real;
  wall parity regressed because the caller fragmented harder: 25 `browse_step`
  delegations / 37 rounds in the best-telemetry cell vs 9 calls in the 239.2 s
  cell. The binding constraint is caller turn-per-delegation overhead, unchanged.
- **Escalation tiers must be reconstructed from log clustering, not read**:
  `bench/.home/log.jsonl` records `status`/`reason` per call but never the goal
  text (by design), so the tier of a bounce is only known if bounces are
  CONSECUTIVE in the log — a non-bounce end between two bounces means either
  tier 1→2 (same goal) or 1→1 (different step goals), indistinguishable. Cell
  2's two bounces are that ambiguous shape.
- **Read `log.jsonl` twice before trusting a fresh read**: minutes after a cell
  finished, a read saw 147 lines; the same file then read 171 with the missing
  24 calls backfilled (mechanism unproven — D: write-back/AV filter suspected).
  A `wc -l` repeat or an mtime check is cheap insurance before tier analysis.
- **Bench walls are load-sensitive at the caller-fragmentation margin**: the same
  browse t9 cells run with background agent load present measured 355.0 s and a
  600 s ceiling-kill (8 delegations); re-run clean they measured 341.3 s and
  277.4 s (13 and 5 delegations). Route-vs-route gaps narrowed from ~3.2x to
  ~1.7x vs the same-session playwright controls — never compare cells measured
  under different machine load, and treat cross-pass wall ratios >2x as suspect
  until load is accounted for.
