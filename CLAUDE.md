# jev-browser-wingman — execution notes

Build spec: `pa/plans/2026-09-19-jev-browser-wingman-SPEC.md` in the PA repo
(dispatch authority; builders execute verbatim; the absolute host path is
withheld — this file rides a public-bound repository). Gates:
`node scripts/build.mjs`, `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`,
`scripts/gates/{import-boundary,notices,lazy-chrome,readme-bench}.mjs`.
Per-round build specs live in `.build-r*-spec.md` (untracked) with their
execution notes; this file holds only durable knowledge. Loop/evidence
internals: `src/core/CLAUDE.md`.

## Campaign summary (r10-r20, 2026-09-29 -> 2026-10-03)

Fourteen validation rounds hardened the forced-verdict/optional-mode loop:
r15 post-action ends -> r17 press/dialogs/login suppression -> r18 harness-3
bench reporting + local fixtures -> r19 upload evidence, enumeration
coverage, byte-slice fix -> r20 optional-mode post-action note + reset-nav
retry, ending in the 0.3.0 release state. The 17-shape known-bad gauntlet
runs 34/34 forced-verdict checks; the README publish table comes from the
r19 68-cell gauntlet run (6da6108). Round narrative: `.build-r*-spec.md`
files; bench evidence: `bench/results/` (second-stamped, never overwrites);
history: results branches + PA memory.

## Loop & evidence rules (harness-visible)

- **The escalation bounce note is bounce-only by design**: bounces are exactly
  `fallback`/`step-uncertain` and `fallback`/`target-covered`; the per-goal
  counter (module-level `Map` in loop.ts, keyed on goal text) increments only
  on those; tiers 2/3 REPLACE the note while tier 1 appends. It must not
  increment on post-action ends because those are not target refusals — tiers
  1-3 all steer back into repeating the action (the r20 post-action branch is
  the FIRST in `finish()`'s § 3.17 else-arm, before the escalation `if`).
  `takeover-offered`, `budget-*` and continuation `target-uncertain` ends
  keep the static § 3.17 table. Test consequence: the takeover note-table
  and covered-target tests need fresh goal texts — earlier bounce tests
  share the process-level counter (per-file processes, not per-test).
- **The takeover continuation bar was never the takeover threshold** — until
  amendment 2026-09-21g (2960760) continuation rounds rode § 3.7 rule 6's
  fixed `THRESHOLDS.target` (0.5) with NO candidate-set check, so
  multi-candidate 0.55 rounds acted mid-takeover. The two-part rule now
  lives in rule 6 behind the `takeover` flag; `wingman_do` keeps the fixed
  bar. General lesson: threshold narratives describe intent, not code — read
  `decideTarget` and the constants first.
- **The pre-2026-09-22 entry commit never checked the floor on the CHOSEN
  element** — `set.size === 1` committed any lone candidate at ANY grade (the
  floor gated only rivals). Any "the entry floor is 0.5" narrative must cite
  the margin rule, not the old candidate set.
- **The two-stage decision map is stage-2's alone**: `{...primary,
  ...secondary}` takes request 2's target answer wholesale and stage 2
  re-grades from scratch, so a dominating stage-1 grade never enters the
  decision; the margin rule fires only when ONE answer map holds both the
  dominating element and the beaten meta-answer.
- **browse_step entry on two-stage pages used to ALWAYS bounce
  `step-uncertain`/`no-match`**: `entryUncertainty` read `answers['action']`
  from request 2, which never carries `action` (plain `wingman_do` rounds
  were unaffected — decideTarget gets both maps). Fix shape (2026-09-21h):
  the entry decision gets `{...primary, ...secondary}`; the covered-target
  gate sits between entry commit and `decideTarget` — before any value ask,
  after the retry decision — so a covered target costs one ask, zero acts,
  no self-retry. The two-stage test only covered non-entry rounds, which is
  why the suite stayed green.
- **`BUDGET_LIMITS` caps caller overrides only**: `loadConfig` seeds
  `DEFAULT_BUDGETS` without validating against the limits, so default
  `max_steps: 24` with cap `[1, 8]` is coherent; a user config value above 8
  is still REJECTED. `runDoRounds` takes `min(caller max_steps, config 24)`;
  the schema allows 1-24.
- **Raising the step budget does NOT stop caller call fragmentation**: the
  long-chain bottleneck is the calling model's planning, not the budget;
  wingman machinery is ~1 s/round and noise at wall scale.
- **The `budgets` validation pattern silently accepts `NaN` thresholds** —
  `typeof v !== 'number' || v < min || v > max` passes NaN. `budgets.*` is
  saved by `Number.isInteger`; any future plain-number config key needs an
  explicit `Number.isFinite`.
- **Jev's grades are bimodal and honest about element choice, never
  actability**: 0.83-1.00 well-labeled, 0.37-0.38 genuinely ambiguous — but
  7/9 high grades that were executed failed on `CoveredTargetError` (sticky
  header/consent overlay; a styled select covered by its control); the
  question set has no "is it covered" probe (`blocked` asks only
  captcha/paywall/etc). Jev also over-refused t9 form steps that execute
  fine — the routing criterion needed recalibration, not the element table.
  Grades are bimodal across RE-ASKS of the same step too (0.66 then 0.48):
  a sub-floor re-ask bouncing under the margin rule is correct, NOT a
  regression — validate grading-shape fixes by measured-map replay
  (`.calib/probe6b-replay.mjs` pattern), never one natural re-ask.
- **`buildRoutingRequest`'s `elements` parameter is deliberately not
  consumed** inside the builder: the § 3.18 element table rides in the
  request's `state` object (caller builds redacted `elementCriterion`
  strings); the builder passes `state` through unchanged. Do not inject
  `elements` into the state — that double-redacts and desyncs from § 3.19.

## Tool text, delegation & policy

- **A tool description that leads with WHAT and then lists prohibitions gets
  skipped.** Fix shape (203cf67): first sentence = WHEN (one bounded goal),
  then a prefer-over-driving line WITH the benefit, then a do-NOT-use line;
  example verbs must cover the target task shapes. Schema friction was ruled
  out (only `goal` required).
- **Exact-string pins must inline the SPEC's text as the expected value** —
  a pin that imports the same constant the code uses compares code to code
  and never sees spec drift. Add the spec-inline comparison, not a
  same-constant mirror.
- **Policy-neutral tool text (amendment 2026-09-25)**: descriptions no longer
  name a policy or a browser tool (`WINGMAN_DO_DESCRIPTION`,
  `WINGMAN_CHECK_DESCRIPTION`, `BROWSE_STEP_DESCRIPTION` in
  `src/surfaces/tool-text.ts`) — the server (`policy.mode`, re-read every
  call) is the sole enforcer, and `loop.ts`'s `finish()` sets a fallback
  result's `note` to `SENSITIVE_LINE` for any `sensitive-*`/
  `unsupported-page` reason, on all three tools, bypassing `CONTINUE_LINE`,
  the browse_step note table and the bounce counter — that is where the
  caller learns to hand a step back to its own browser tools. Descriptions
  are served once per session, so this is the only way a policy change
  reaches caller behaviour. The wingman attaches over CDP and acts on the
  one visible tab or the tab `url_match` names. Spec:
  `pa/plans/2026-09-25-wingman-policy-neutral-tool-text-SPEC.md`.
- **Tool text alone does not win delegation.** Route-neutral prompts dropped
  `wingman_do` entirely on the long chain (`typesafe.calls = 0`); with both
  `browse_step` and legacy tools visible the caller never called
  `browse_step`; `WINGMAN_BROWSE_ONLY=1` fixed tool selection but Jev
  bounced all delegations back (`route-caller`, zero takeovers) and the
  caller declared DONE early — wall "wins" were give-up-early. An engagement
  line flipped calls 0->5 but the calls fell back (`jev-error` was then the
  binding defect). The t9-shaped chain does not complete by delegation; the
  fallback lane IS the run (`fallback` reason `sensitive-auth-path`).
  `BROWSE_ENGAGEMENT_LINE` stays single-line ASCII (em-dashes fold for the
  win32 cmd spawn).

## Test infrastructure & stubs

- **Config rejects an explicit `"mode": "off"`** (`invalid mode: "off"`):
  `off` is the key-absent default (`src/core/config.ts`). Tests/fixtures
  omit the key, never write it.
- **The loop returns `fallback no-key` BEFORE it attaches** (`src/core/loop.ts`):
  `if (!deps.ask)` fires before driver attach — a test asserting browser
  contact on the first tool call must set a key/stub or records zero
  contact.
- **Round 2 acts again unless told not to**: the round request always
  carries `action` and `target`; a stub answering `done` with `action`
  defaulted clicks a second element first. Script `verb: 'none'` on
  terminal rounds.
- **The scripted ask echoes `S()` defaults into EVERY request** — a two-stage
  test whose request 2 must carry no `action` needs
  `S({ ..., action: undefined })`, or the fail-first test passes pre-fix
  (proven: the carry test passed until the key was dropped).
- **The scripted ask's entry index is shared across calls on one harness**:
  script call 2's rounds explicitly (a login-resume test passes vacuously
  otherwise; only the `loginSuppressed` telemetry assert catches it).
- **A stub `ask` must return `usage`** (`{inputTokens, outputTokens}`) or
  `askWithCost` throws and the call ends `error/tool-fault` with no visible
  stack. Wrapping `createDriver(...)` by iterating `Object.keys(base)`
  yields an EMPTY driver (methods live on the prototype) — same silent
  fault. Diagnose either with a direct `runStep` call.
- **`fillDefaultAnswers` (tests/helpers/typesafe-stub.ts) defaults every noul
  to LOW (0.05)** — safe only where low is the no-op reading (done, blocked,
  login, error, irreversible, step_done). `right_page` and `ready` are
  INVERTED: low means "not yet"/"wrong page", which chain mode reads as a
  real problem (mechanical `wait`, then `not-ready` after `READY_MAX_WAITS`).
  Any chain-mode stub (any request carrying `steps`, i.e. every
  `browse_step` call) must answer both 0.95 explicitly. Check this first
  for any NEW chain-mode stub.
- **`FakeDriver.dialogOnNextAct` is a CASCADE, not a per-act drain**: every
  event in the array delivers, in order, during the ONE act (a second dialog
  in the same act is otherwise unscriptable).
- **FakeDriver repeats the last scripted observation** when a script is
  exhausted — a two-observation script with a changed second entry is how a
  test shows a page change or a late landing.
- **`evaluateOracle`'s false-only fallback**: a false-only test cannot prove
  the oracle — keep at least one assert-true expression.
- **`el()` (outcome-evidence helper) defaults `editable: true`** — a "plain
  button" fixture must override `editable: false` (and tag/role) explicitly,
  or the focus-promotion rule fires and the negative pin reads
  `focus changed`.
- **Two consecutive rounds acting the same (verb, element) over a single
  static observation is a no-progress/repeat-guard trip by construction** —
  audit the WHOLE suite for this pattern on any change to
  `isNoProgress`/`annotateLastOutcome`, not just the file a diff names
  (three pre-existing green tests in takeover.test.ts flipped this way).
  A count-clause test needs every click's observation to change (or the
  count already met before any repeat) — `isNoProgress` fires before any
  count/repeat semantics. Alternation must be strict (`round % 2`), not
  "first round differs" — an e1/e2 alternation produces two consecutive e2
  clicks by round 3 and passes for the wrong reason.
- **Optional telemetry fields on `PhaseRound` / `WingmanLogRecord`** must
  never be assigned when the source value is undefined:
  `assert.deepStrictEqual` treats `{k: undefined}` as different from `{}`,
  and `tests/loop.test.ts` pins the exact round shape. Guard with
  `!== undefined`.
- **`run-tests.mjs` output is pipe-buffered and buffered to the END**: an
  empty interim output file does NOT mean a stalled run — TAP lines appear
  only at completion when piped. `... | tail -40` shows only the last screen
  (a 2-fail summary loses the first failure). Redirect to a file, read the
  file; check process liveness before killing anything.
- **Basenames EXCLUDE the `.test.js` suffix** (`chrome` -> `chrome.test.js`);
  `chrome.test` matches nothing.
- **The env scrub removes `TYPESAFE_API_KEY`** — inject through
  `BenchDeps.env`, never the process env.
- **A scoped `build.mjs --out <dir> tests/cli.test.ts` compiles only the
  test's import graph, and `cli.test.ts` spawns `src/cli/main.js` by path
  without importing it** — every spawn test fails ("Cannot find module").
  Pass the CLI as a second entry:
  `node scripts/build.mjs --out <dir> tests/cli.test.ts src/cli/main.ts`.
- **A KB-proof run poisons the scoped .build until you re-run build.mjs**:
  `run-tests.mjs --dist .build/<pkg>` executes the COMPILED copy, so a
  green-looking re-run after a source restore still runs mutated JS.
  Re-run the scoped build after the last restore.
- **`guide.js` only exports `guideCommand`** — the CLI path under test is
  `main.js guide`; a temp package root needs the whole compiled dist plus a
  `node_modules` junction and `"type": "module"`.
- **`chromeCommand` tolerates a missing `config.json`** (defaults apply), so
  an empty-`WINGMAN_HOME` dispatch test reaches the port probe and must
  assert chrome-cmd's `no-browser` JSON line (exit 1); unwired, `chrome
  show` exits 2 with usage — the 2-vs-1 delta is the test's teeth.
- **`cli.test.ts`'s `chrome show` no-browser test fails whenever the shared
  bench Chrome is up** (answers on default port 9222, exit 0). Stop the
  shared-profile Chrome first — not a code defect.
- **A live headed Chrome in a unit test works off-screen**: direct-spawn
  with the anti-throttling flags plus `--window-position=-32000,-32000` on a
  `wingman-ephemeral-` temp profile; measure via the PowerShell
  EnumWindows/GetWindowRect pattern in `scripts/gates/window-mode.mjs`.
  Assert the off-screen PRECONDITION first. Off-screen headed Chrome also
  needs the three `HEADED_ARGS` anti-backgrounding flags plus exactly ONE
  page target, or `pages()` shows `visible:false` and the loop refuses
  (`tab-ambiguous` — zero candidates means zero visible).
- **`if (false && <cond>)` is not a valid KB-mutation shape**: the dead
  branch loses TS narrowing and the build fails, silently testing the
  PREVIOUS dist. Mutate via a `const KB_X = true` flag composed with the
  condition (KB-mutant methodology below).
- **Adding a dimension to `bench/config.json` silently invalidates the count
  assertions in `tests/bench-cap.test.ts`** — any route/config-shape change
  must re-run `bench-cap` alongside the owning package's gate.

## Bench harness

- **The bench wingman-route prompt lives in `bench/run.ts` `buildPrompt`**
  (`bench/claude-run.ts` is the spawn layer). The task goal rides verbatim
  in every route's prompt — before that fix the goal was never in any
  prompt, so t9's oracle endpoint was unreachable by instruction and
  pre-fix "oracle false" cells partly measured wandering. Fail-first proof:
  `tests/bench-browse.test.ts` ("both routes carry the task goal verbatim").
- **`max_turns` is often the binding ceiling, not knowledge**: the 7-page t9
  chain needs ~2 calls/page; every definitive cell burned exactly 25 calls
  at `max_turns: 25`. Raise it or the wall measures the turn cap.
- **`detached: true` on the win32 cmd spawn in `bench/claude-run.ts`
  swallowed ALL stream-json output** (A/B proven: 0 vs 1954 events; fixed
  90ad51d). Never spawn through `cmd /c` detached.
- **A "wingman" route cell is only a wingman measurement if
  `typesafe.calls > 0`** — read `bench/results/*.json` before interpreting
  any wingman-route row.
- **A spawned bench caller can come up with NO MCP servers despite a correct
  `--mcp-config` absolute path** (contradicting `--strict-mcp-config`; same
  shape attached fine minutes later). Before charging a zero-tool-call cell
  to a mechanism, re-probe the spawn flags with a trivial prompt.
- **`claude --model sonnet` resolves through the local GLM proxy**
  (`glm-5.3-flash[1m]`): results `usd` is tokens priced at Sonnet list
  rates; `cli_reported_usd` is the proxy's synthetic number (~1.7x higher).
  Route-vs-route comparison stays valid.
- **`phaseSpentFrom` sums ALL `bench/results/*.json` forever** against the
  hard `OPERATOR_CEILINGS.phaseUsd` — "cap USD X for this check" means
  `--phase-cap-usd = history + X`; check the history sum first. An aborted
  run still burns the whole phase authority; a phase-abort also trips any
  per-run cap under `killed_run_charge_usd` (1.5). Ledger rotation is a
  spend-authority decision, not a builder step.
- **Two concurrent bench phases on the shared port-9344 Chrome poison each
  other's results** (navigation collisions -> timeouts -> killed-run
  charges). Serialize bench phases.
- **`ensureChrome` waits only 10 s for the debug port**: a cold start can
  exceed it and the cell dies `Chrome did not answer on port 9344` BEFORE
  any spend. One clean immediate retry is the fix; a fresh profile may need
  a hand warm-up launch first. The same window can make the lazy-chrome
  known-bad `eager-ensure` print `ok` spuriously — rerun before diagnosing.
- **`stopChrome` skips a Chrome it did not start** (`startedByUs: false`) —
  sweep diagnostic/bench-profile chromes afterwards, including the surviving
  `--type=crashpad-handler` orphan (parent dead, `stopChrome` never sees
  it). The harness guard blocks deleting top-level `D:\` dirs.
- **Results files are second-stamped** `YYYY-MM-DD-HHMMSS.json`, `_N` on a
  clash, never overwrite. `--repeats N` (integer 1-5) is a CLI flag of
  `dist/bench/run.js`.
- **`wingman_phases.jev_ms` is a rounds-MEDIAN and per-round jev is
  bimodal** (cold ~926 ms first round of each delegation vs ~404 ms warm):
  the run median tracks delegation mix, never "Jev got slower". Scroll
  rounds' `act_ms` includes the r17c growth wait (up to
  `SCROLL_GROWTH_WAIT_MS` = 1500 ms) — never read it as Jev latency; a
  "should have caught this scroll loop" diagnosis checks `scrollY` movement
  first.
- **Bench walls are load-sensitive at the caller-fragmentation margin** —
  same cells 355 s/600 s under agent load vs 341 s/277 s clean. Never
  compare cells measured under different load; treat cross-pass wall ratios
  >2x as suspect until load is accounted for.
- **Escalation tiers must be reconstructed from log clustering, not read**:
  `bench/.home/log.jsonl` records `status`/`reason` per call but never the
  goal text, so a bounce's tier is only known when bounces are CONSECUTIVE.
  And **read `log.jsonl` twice before trusting a fresh read**: a fresh read
  has come back short by 24 calls with the rest backfilled minutes later
  (D: write-back/AV suspected); `wc -l` repeat or mtime check first.
- **A leaked scratch Chrome holding the probe port silently poisons every
  later probe**: the port-answering fetch hits the zombie, whose
  backgrounded window reports `visibilityState: 'hidden'`, so every
  `wingman_do` returns `tab-ambiguous` with `jev_calls=0`. Kill scratch
  chromes by temp-profile cmdline marker (`taskkill /T /F` does not reliably
  take the tree from a plain launcher PID), poll the port CLOSED after
  teardown, fresh port per run.
- **`WINGMAN_BROWSE_ONLY=1`** (mcp-server.ts) hides wingman_do/wingman_check
  from tools/list AND refuses them at call time; `bench/run.ts` forwards the
  env; unset = product default. Probe a spawned server's tool list with SDK
  `StdioClientTransport` against `dist/src/cli/main.js mcp` and a temp home —
  from inside the repo tree (scratch-dir node cannot see node_modules).
- **`wingman_do` fill probes must carry the value in `values`**: `values: {}`
  never asks the value question and ends `no-value` — a probe artifact, not
  an execution failure.
- **The spike's `--adapter dist-playwright|dist-cdp` mode** drives the
  shipped `createDriver` through `attach/pages/observe/act/detach` only
  (act ids by accessible name). The known-bad injections the Driver contract
  cannot express (`Target.closeTarget`, `Emulation.setDeviceMetricsOverride`,
  main-world eval, `Target.createBrowserContext`, dialog answering) ride a
  harness-held raw side connection; P7's cookie read uses `Network.getCookies`
  from that client. Gate I-11 PROVEN (867edab): side-channel injections
  discriminate identically. Fixture mapping: `driver.pages()` is the page-id
  source; `count(selector)` becomes an observation filter.
- **The spike's result JSON is deterministic** — a re-run reproducing wave-0
  verdicts rewrites `spike/results/*.json` byte-identically.
- **r18 harness-3 bench reporting**: the reporter tolerates pre-r18
  `wingman_phases` records — missing numerics read 0 and an absent
  `round_kinds` puts the whole round count in `other` (preserving
  `rounds == sum(round_kinds)`); old phases lines read `other=<rounds>` —
  legacy shape, not a bug. **`@REPO@` expansion is forward-slash by
  construction** (`expandTaskValuePlaceholders`) so values survive the win32
  cmd spawn; it happens once in `runBench` after `readTasks()`. **Any future
  `harness_version` bump must `grep -rn harness_version tests/` itself** —
  the r18 spec's "no external consumer pins HARNESS_VERSION 2" claim was
  FALSE (`tests/bench-browse.test.ts` pinned 2). Never trust a spec's
  verification note for this.
- **`runBench` starts a real localhost fixture server whenever any selected
  task is `local: true` (t15-t17)** — including fake-deps test invocations,
  which therefore bind an ephemeral 127.0.0.1 port. Two close sites,
  disjoint windows (the finally, plus a catch-rethrow over the
  prepare/wiring window) — do not merge them or move the start after
  `prepareBrowser`. URL resolution lives in pure `resolveStartUrl`; the
  local branch beats the absolute branch by design.
- The readme-bench gate picks the newest `measure` results file by name; its
  old-file fallback renders exactly the pre-r19 four-column block — context
  line + spread column appear only when EVERY summary row carries
  `wall_min_ms`/`wall_max_ms`, so a harness-2 file never gets a false
  provenance claim.
- **`bench/cloud/chromium-wrapper.sh`**: `chmod o+x` on ONLY the immediate
  parent of `--user-data-dir` is not enough once the profile lives more than
  one level under a directory `nobody` can't traverse (the default profile
  under `/root` — 0700 — needs `/root` itself traversable). Fix: walk every
  ancestor up to (not including) `/`, granting `o+x` only (never `o+r`).
- **Doctor coexistence fingerprint must contain only state whose change
  proves a WRITE into the page**: a 500 ms sentinel-eval timeout was read
  as `dialogOpen` (a starved renderer is not a modal dialog — the sentinel
  now retries once with a 4 s budget), and `visibility` is ambient state no
  known-bad driver pins (dropped from `ProbePage`; the key-set pin in
  doctor.test.ts keeps it out). **`fingerprintsReconcile`'s guarantee is
  "healthy-before teeth", not "all writes"**: a degraded before-read proves
  nothing, so the one-shot before re-read (post-attach) accepts a persistent
  attach-time write coinciding with an unrelated degraded before;
  both-healthy and both-degraded mismatches still fail with zero probes.
  When a retry is guarded by a predicate, check the predicate fires in the
  failure mode the retry exists for (`onlyUrlsChanged` was false on a
  nulls-vs-values pair, so the retry never fired).
- **Timeout flakes need real renderer starvation, not node-side CPU load**:
  8 CPU-burner processes kept every probe eval under budget — the cloud
  failure mode is the 160-chrome wedge starving Chrome itself.
- **The byte-vs-string slice trap (bench log slicing, r19)**: slicing a
  decoded string by a byte offset is silent data loss —
  `statSync().size` (bytes) + `readFileSync(path, 'utf8').slice(before)`
  (chars) corrupts the first fresh line whenever the prefix holds any
  multi-byte UTF-8 (one ellipsis sufficed; it under-counted t16/t12/t13 AND
  produced a fake "single-call cells under-count" correlation that was a red
  herring). Slice Buffers (`subarray(before).toString`).
  `tool_use_counts` (caller-side) is the cross-check that catches a
  log-slice under-count; shape correlations on under-counts deserve a
  byte-level look before a mechanism story.

## Chrome lifecycle & teardown

- **The runner token sweep is the leak guarantee; per-test finally-blocks
  are best-effort only.** Every `run-tests.mjs` invocation mints a unique
  `WINGMAN_RUN_TOKEN`, passes it to each spawned test's env, and — on every
  exit path (plus a sync `process.on('exit')` fallback) — kills any
  chrome.exe whose command line carries `--wingman-run-token=<token>` (PID
  tree, logged `RUN-TESTS: chrome sweep (...)`). `launchEphemeralChrome`
  copies the token onto each chrome's command line; production and bench
  (token unset) are unchanged. A sync exit-registry backstop in
  `tests/helpers/chrome.ts` tree-kills any browser still registered.
  Fail-first proofs: `tests/runner-sweep.test.ts`; the leak fixture
  `tests/runner-sweep-leak.test.ts` is the drill target — never "fix" it.
- **The token sweep cannot cover a hard-killed runner** (SIGKILL/taskkill of
  run-tests.mjs itself): sweep manually by the `wingman-ephemeral-` cmdline
  marker — and never kill a Chrome whose profile is the shared browser
  profile.
- **Never tag a test Chrome with an extra unknown switch**: headless chrome
  writes `DevToolsActivePort` but its HTTP endpoint never answers, so the
  endpoint reads dead (A/B proven). Tagging must ride `--user-data-dir` (as
  the token now does) or another blessed argument.
- **Ephemeral-Chrome leak defence (src/browser/ephemeral.ts), three
  layers**: profile dirs embed the launching pid
  (`wingman-ephemeral-<token?>-p<pid>-...`, token before pid so the
  substring match still hits); a `process.on('exit')` guard tree-kills
  anything this process launched and never closed; `sweepOrphanedEphemeralChromes`
  (memoized, top of every launch) kills tagged root chromes whose owner pid
  is dead and removes their profile dirs, aging untagged legacy dirs out
  after 24h (never kills a legacy chrome — untagged can't prove orphanhood).
  Launch failures (e.g. the `DevToolsActivePort` 15s timeout) kill the tree
  and remove the profile dir before rethrowing.
  `tests/ephemeral-sweep.test.ts` uses injected fakes only; any test
  launching a real Chrome runs alone in the foreground.
- **Chrome's own child processes carry `--user-data-dir` but never the
  debug port** (`--type=gpu-process`, `--type=crashpad-handler`, ...); the
  main browser process never carries `--type=`. Holder detection that counts
  every chrome.exe matching the profile marker FAILs preflight G4 / verify
  V4 / doctor `profile-safe` while the managed Chrome is up. Fix b9f3b14:
  `profileHolders` skips cmdlines containing `--type=`. **The gate semantics
  are "FOREIGN holder", not "any holder"**: a chrome on ANOTHER profile is
  never a holder of this profile; a foreign chrome on THIS profile without
  a port still fails the gates (fixture matrix in `tests/chrome.test.ts`).
- **A minimized Chrome window rejects a position-only
  `Browser.setWindowBounds`** — restore (`windowState: 'normal'`) before
  moving; `chrome hide` restores first, `chrome show` restores by definition
  (the restore takes the foreground — that IS show's purpose, RO-7).
  **`Browser.getWindowForTarget` is per-page**: collect distinct `windowId`s
  over page targets or you move one window N times.

## Adapters & CDP

- **A CDP session attached AFTER `Target.createTarget` has navigated
  evaluates against the pre-navigation context** (`location.href` =
  `about:blank` while `Target.getTargets` shows the new URL). Attach first,
  then `Page.navigate` over that session (`bench/run.ts` `resetPages`).
- **`/json/new`'s target shows the new URL in `/json/list` BEFORE the
  document swaps** — an attach in between enumerates the pre-navigation
  document (`state.url` = `'nullblank'`, zero elements; the intermittent
  `no-match` flakes). Wait for the target's `<title>`, not its URL
  (`openFixturePage` does).
- **`src/adapters/playwright.ts`'s `back` op**: `goBack()` resolving null is
  NOT a reliable "no previous page" signal (bfcache AND same-document
  navigations both resolve null), and URL before/after comparison fails for
  repeated `pushState(state, '', location.href)`. The robust check is the
  real stack: `rec.session.send('Page.getNavigationHistory')`, throw when
  `currentIndex <= 0` (mirrors cdp.ts). Bound it with a plain timeout like
  every other CDP round-trip in the file.
- **The cdp adapter's `act()` must propagate `actRaced`'s return** — the op
  switch lives inside `private actRaced(...)`, and a bare
  `await this.actRaced(...)` on the element-targeted path silently discards
  any act-returned value as undefined (the playwright adapter's switch is
  inline, so the same edit works there directly). A new act-returned value
  needs BOTH the switch-case `return` AND `return this.actRaced(...)` at the
  targeted call site; the targetless path discards deliberately.
- **`Driver.act` returns `Promise<void | string>`** — a check/uncheck that
  flipped returns `'checked'`/`'unchecked'`, stored as the history entry's
  `result` at act time behind `KB_CHECK_FLIP`; `annotateLastOutcome` leaves
  pre-annotated entries alone. FakeDriver scripts it via `nextActResult`.
- **`driver.attach`/`detach` (cdp.ts) provably sends no page-touching CDP**
  — connect + `Target.getBrowserContexts` + `conn.on(...)` subscriptions;
  `CdpConnection.on` is a pure listener registry. Any coexistence
  fingerprint flip is ambient Chrome state or a probe-eval timeout, never
  the attach; diagnose there first.
- **`prompt()` never resolves after the driver detaches on this machine's
  headless Chrome** — the detach clears the browser-side dialog
  (`Page.handleJavaScriptDialog` from a second session then answers `No
  dialog is showing`) but the renderer stays WEDGED forever: every later
  `Runtime.evaluate` on that tab times out, and dialog.html's `'dismissed'`
  write NEVER lands (never observed anywhere, local or cloud). The E16
  check therefore passes only on a RESOLVED prompt (`#log === ''`).
  Don't "simplify" that back to `assert.equal(log, 'dismissed')` — it is
  unreachable here (4 repro runs).

## Enumeration & page-scripts

- **"Jev said `none`" is an enumeration-candidacy question first**:
  `isCandidate`/`isCandidateTag` (`src/core/page-scripts.ts`) are the single
  choke point — no matching attribute/tag/role means the target NEVER
  enumerates, and no grader change can fix it (DataTables-style headers bind
  via JS listeners, no inline `onclick`). Signature: the log's
  `target1: "none"` at high confidence. Check enumeration before touching
  grader text or thresholds.
- **`CAPTCHA_RE` false-positives on whole real pages** (bbc.com, npr.org
  embed /captcha/i in login/ad widgets): every browse_step returns
  `blocked/captcha` BEFORE any ask (zero spend, zero grades). News sites
  stay off-limits until the signal is scoped to real challenge widgets.
- **Headless GitHub serves the loop a reduced repo page** (154 elements, no
  Issues/Star/search targets) — Jev's `none` answers were honest; the
  table, not the grader, was the bottleneck.
- **A label with `for` — or a wrapped control — is OWNED**: `siblingLabel`
  must skip owned labels or a hidden input adjacent to `label[for=x]`
  steals x's name (the #16 cloud failure: `#t7` next to `label[for=t6]`
  enumerated as "Fine print" with `controlPath: '#t7'`).
- **Clicking a bare sibling `<label>` does NOT toggle the hidden control**
  (no wrap, no `for` -> click is inert). The adapters activate the control
  itself when the label click did not flip (`KB_CDP_CHECK_TOGGLE` /
  `KB_PW_CHECK_TOGGLE`; composed `!KB_X`, default `false` — the
  direct-control toggle runs in shipped builds and the live check needs NO
  flag flip; flipping a flag must make the check fail, and that failure is
  the mutant proof, not a regression). `KB_PW_CHECK_TOGGLE`'s local proof
  lives in `tests/adapter-playwright.test.ts` ("sibling-label hidden
  checkbox"), asserting the checkbox state over a SECOND connectOverCDP
  (not the adapter's own observe); mapped as the flag's expected-fail leg
  in `.build-r17-mutants.py` (UNIT, not CLOUD). E19 maps only
  `KB_CDP_CHECK_TOGGLE`.
- **Enumerate probe semantics**: `elementFromPoint` at the rect center; a
  point off-viewport answers null and is NOT evidence of a cover
  (`obscured` stays false), and a `pointer-events: none` cover is skipped
  by the browser — act-time `CoveredTargetError` remains the backstop.
- **`pathEl.closest('table')` must run on pathEl, not el** (r19 D2): for a
  proxied hidden control the record's path is the label, and the table
  context must agree with the path the verifier re-finds (defensive — no
  fixture exercises a proxied control inside a table yet).
- Calibration probe artifacts live in untracked `.calib/`: the ask-spy
  wrapper records per-ask target probabilities, the direct-Driver phase
  executes Jev's own top candidate for would-succeed evidence, verification
  is outcome-based main-world evals. The spy's `twoStage`/`groupCount`
  fields under-report — the reliable two-stage markers are per-ask `count`
  ~ 90 and askCount = 4 for 2 rounds.

## KB-mutant methodology

- **KB flags compose as `!KB_X && <new>`, never `KB_X && <new>`**: flip =
  restore PRE-fix behaviour, so the new path must be ACTIVE while the flag
  is `false`. Writing `if (KB_TABLE_HEADERS && tag === 'th')` ships pre-fix
  behaviour with every pin red at the gate — and the failure looks like
  "fix didn't work", not like an inversion. Ternary precedent:
  `KB_X ? <old> : <new>` (`KB_HIDDEN_SIBLING`). **Two documented
  spec-polarity failures**: (1) the committed r19 spec's D6 item 3 block
  still carries the inverted polarity (`.build-r19-spec.md` line 175 shows
  `!KB_UPLOAD_EVIDENCE && ...` where the code ships `KB_UPLOAD_EVIDENCE &&
  ...`; no amendment marker — re-deriving WP-2 from the spec literal
  reintroduces the bug); (2) the r19 upload-evidence spec's literal
  `checkFlipResult` body was self-contradictory (it stripped the evidence
  when the flag was FALSE, so flipping the mutant would ENACT the fix
  instead of killing it; proven by instrumentation). Lesson: derive
  polarity from the mutant convention FIRST, then check the spec literal.
- **The mutants runner's anchor is `= false;` -> `= true`**; a source-shape
  tripwire (line replacement, e.g. D-11's run.ts slice tripwire) needs the
  runner's optional 4th tuple element: anchor = the literal good source
  line, 4th element = the bad line substituted in. A pure one-array append
  would produce a no-op mutation the pin passes against. Any
  "revert-detection" mutant uses that form, never a fake flag.
- **A guard like "never on the final clause" (`cursor < N - 1`) makes any
  mutant test whose target clause is the last clause vacuous** — give such
  tests a trailing clause.
- **page-scripts' KB flags ride `var` inside the stringified function
  body**, not module-level `const` — the anchor matches both declarations
  (`const|var KB_X = false;`).
- **`dialogOutcome`'s alert arm returns BEFORE the `KB_DIALOG_ANSWER` gate**
  (loop.ts): `T-alert is always accepted` cannot fail under that flag — the
  flag owns the confirm-parse arms only. A mutant-table row mapping the
  alert test to that flag is unsatisfiable without reordering src; the
  runner maps it as a pin.
- **A hard-killed mutants runner leaves KB flags flipped in src** (the
  byte-identical restore lives in a `finally`, which taskkill/reap skips;
  a pre-poisoned flag makes the anchor check and its flip vacuous). Before
  AND after every mutants pass: `grep -n 'const KB_\w* = true' src` must
  return nothing; restore `= false` immediately. The full pass is ~25+ min,
  past the 10-min foreground cap — run it DETACHED (`Start-Process python
  -u`, output redirected, PID saved) and poll the log; the reaper only
  kills Claude's own background shells, and `python -u` streams per-flag OK
  lines so liveness is visible.
- **`chain-e2e` runs `adapter: 'cdp'`** — e2e results discriminate CDP-side
  flags; a playwright-adapter e2e claim needs the adapter-playwright rig.
  Adapter-level waits are invisible to FakeDriver unit tests.

## Machine traps (this box)

- **The full suite cannot complete as ONE `node --test` invocation** (16 GB
  box): parallel fan-out holds 160-225 Chrome processes, the machine
  wedges, the runner hangs past an hour buffering. Work in scoped serial
  chunks of 3-12 basenames against built `dist/`; expect one parallel-load
  flake (a `Page.navigate` cdp timeout) per heavy chunk — rerun the
  basename alone before calling it a defect. Even a scoped run can take
  40+ min under load, and a single file can ACTUALLY HANG
  (`adapter-cdp.test.ts`: ~50 min with 48 leaked chromes; alone in the
  foreground it finished in ~65-77 s). **Prefer foreground runs with an
  explicit tool-level timeout (this harness's Bash `timeout_ms`, not a
  shell `timeout` prefix)** over backgrounding+polling — a background run
  cannot distinguish "buffered" from "wedged", and a Monitor on the
  completion line has the same blind spot.
- **The memory-pressure reaper kills idle-session background shells and
  the Chrome they spawned** — including a RUNNING bench cell mid-flight
  (no results file, no ledger entries) and backgrounded scoped gates (one
  reap orphaned ~100+ test chromes; 111 swept). Chrome-backed adapter files
  go foreground, split per-basename (adapter-cdp ~3 min, adapter-playwright
  ~2.5 min, alone) instead of one invocation that outlives the 10-min
  foreground cap and gets backgrounded. Restart only after memory recovers.
- **The leaked-Chrome wedge is self-compounding**: past ~440 chrome.exe,
  WMI, `tasklist` AND `Get-Process` all stall — the sweep itself cannot
  enumerate. Sweep by the `wingman-ephemeral-` marker IMMEDIATELY after
  each chunk. At ~2.3 GB free, even a SERIAL adapter-cdp full-file run can
  wedge (103 chromes once) — prefer a single-chrome diagnostic probe for
  shape-refresh work.
- **Chrome lives at `C:\Program Files (x86)\...` on this machine**, not
  `Program Files`. And **`Start-Process -ArgumentList` joins array items
  with bare spaces**: embed the quotes in the argument string or an
  unquoted `--user-data-dir=<path with spaces>` splits, Chrome starts on a
  bogus profile that `ensureChrome` refuses.
- **An `Edit` whose `new_string` re-includes a block adjacent to the
  deleted one duplicates it** (the removed `visibility` read sat right
  before an identical `viewport` block; tsc catches it only when it is a
  redeclaration). Read the whole file after any edit that deletes a block
  next to a structurally identical one.

## PA repo tooling

- **`pa run commit` refuses paths under your OWN active reservation** —
  `pa release <id>` first, then commit. From a subdirectory it still lands
  in the PA repo root: pass wingman paths ABSOLUTE (repo-relative resolves
  against `D:/Personal Assistant` -> `pathspec did not match`). Active
  claims are foreign to the commit worker (COMMIT-DEFERRED): release claims
  (renew `--ttl 1`, let lapse) before committing.
- **`pa_claim` cannot reserve jev-browser-wingman paths** (they resolve
  against the PA repo); fall back to checking `pa_claims` for conflicts
  plus a clean `git diff HEAD` on the files.
- **2026-10-03: the `pa` CLI is broken on this machine** (`Cannot find
  module '../lib/routing-policy.js'` from the PA repo dist) — the
  claim/release and `pa run commit` workflow is unavailable until the PA
  repo is rebuilt.
- **`public_separation_check.py --mode contents` reads only COMMITTED
  trees** (uncommitted files print `SKIPPED CONTENT`): pre-commit, grep the
  owned files against `~/.pa/operator-identifiers.txt` directly;
  post-commit, run the official contents + paths scans (two
  `violations=0` lines).

## Known pre-existing failures

- **Two pre-existing, diff-unrelated scoped-gate failures (as of
  2026-09-25; unrelated to later diffs — neither test file nor anything it
  imports touches loop.ts/tool-text.ts)**:
  `tests/adapter-cdp.test.ts` "observe matches the pinned form.html table"
  fails twice in a row (not a flake) — the live `ElementRecord` now carries
  `htmlId`/`obscured`/`placeholder` fields the pinned expectation predates.
  `tests/cli.test.ts` "chrome show dispatches into chrome-cmd" fails with
  exit 0 vs expected 1. Do not attribute a future red on these two to a new
  diff without checking.

## Gotchas from the r21 verifier-fix pass (2026-10-04)

- **Grader-replay capture lines carry `stage` and rounds consume N asks**
  (F1): a two-stage round makes TWO askWithCost calls and a native-select
  resolution one per chunk plus a final, so a one-ask-per-round merge shifts
  every later pairing by one — silently, since unmatched rounds only mark
  `mirrored:false` and capture exits 0. The merge is now the exported pure
  `mergeCapture(records, asks, thresholds)` in `bench/grader-replay.mjs`;
  `askStage(request)` classifies `group`/`target`/`option`/`recover`/`round`
  (recover only counts when it is the SOLE question — buildRoundRequest
  carries recover as an EXTRA question next to done). A round whose
  `phases.rounds[].jevMs` never moved ended BEFORE its ask and consumes
  zero asks. Old capture files (no `stage`) still replay: the stage is
  re-derived from the request's question keys when absent. The line's
  `round` field is the per-RECORD round index (what mirrorDecision's
  error-gate needs), never a global counter.
- **`el.className` on an SVG element is an SVGAnimatedString object** that
  stringifies to `'[object SVGAnimatedString]'` (F3): any RE match over
  className silently misses every SVG-carried class. Read
  `el.getAttribute('class')` instead (works for HTML and SVG). The captcha
  id/class arm in page-scripts.ts now does; the repeatedGroups signature
  build (`String(gn.className)`, r17 C8) still uses className by design —
  SVG groups there read as one `[object...]` bucket, harmless for tallies,
  but any future CONSUMER of that signature must know.
- **A fail-first test that asserts a derived label can red for the wrong
  reason**: the F1 no-ask-round pin was written expecting a global round
  counter and red on the label, not the shift — the discriminating
  assertions (line count, paired probabilities) are what must carry the
  pre/post contrast; derive expected labels from the code's own semantics
  before writing them.
