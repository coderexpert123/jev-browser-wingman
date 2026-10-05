# jev-browser-wingman — execution notes

Build spec: `pa/plans/2026-09-19-jev-browser-wingman-SPEC.md` in the PA repo
(dispatch authority; builders execute verbatim; the absolute host path is
withheld — this file rides a public-bound repository). Gates:
`node scripts/build.mjs`, `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`,
`scripts/gates/{import-boundary,notices,lazy-chrome,readme-bench}.mjs`.
Per-round build specs live in `.build-r*-spec.md` (untracked) with their
execution notes; this file holds only durable knowledge. Loop/evidence
internals: `src/core/CLAUDE.md`.

## Consolidation discipline

Budget: ~46,000 chars (`wc -c` gate <= 46,000). One rule, two halves:
claims are never dropped — anecdotes and evidence-color numbers are the
only drop classes — and per-pass gotchas merge into their TOPIC section at
landing, never as a new dated section.

## Campaign summary (r10-r23b, 2026-09-29 -> 2026-10-05; v0.3.0 RELEASED)

~20 validation rounds hardened the forced-verdict/optional-mode loop:
r15 post-action ends -> r17 press/dialogs/login suppression -> r19 upload
evidence, enumeration coverage, byte-slice fix -> r20 optional-mode
post-action note + reset-nav retry -> r21 scoped captcha, cursor-pointer
(REJECTED by the D12 live bar), nav-settled clicks, grader-replay harness ->
r22/r23b t9 recovery fixes (nav-shaped act retry, resume-skips-post-action,
engagement/post-action line reconciliation) -> r23 THE HEROKUAPP DEPENDENCY
ENDED: 15 of 17 gauntlet shapes run on byte-faithful LOCAL fixtures
(fixtures/pages/, served by src/fixture-server.ts incl. nested paths);
t10 saucedemo + t11 todomvc stay LIVE as real-web canaries. v0.3.0 tagged;
GitHub release live; the README publish table comes from the r23b
deterministic 68-cell run (forced 34/34; history: the r19 6da6108 run was
the last live-site table). Round narrative: `.build-r*-spec.md` files;
bench evidence: `bench/results/` (second-stamped, never overwrites);
history: results branches + PA memory. Known live-site residue: the-internet
stalled ~30 s on ~1-in-3 requests for two days (r22/r22b probes) — keep the
observational probe if it returns.

## Loop & evidence rules (harness-visible)

- **The escalation bounce note is bounce-only by design**: bounces are exactly
  `fallback`/`step-uncertain` and `fallback`/`target-covered`; the per-goal
  counter (module-level `Map` in loop.ts, keyed on goal text) counts only
  those; tiers 2/3 REPLACE the note, tier 1 appends. Never on post-action
  ends — not target refusals; tiers 1-3 steer back into repeating the action
  (the r20 post-action branch is FIRST in `finish()`'s § 3.17 else-arm,
  before the escalation `if`). `takeover-offered`, `budget-*` and
  continuation `target-uncertain` ends keep the static § 3.17 table. Test
  consequence: takeover note-table and covered-target tests need fresh goal
  texts — earlier bounce tests share the process-level counter (per-file,
  not per-test).
- **The takeover continuation bar was never the takeover threshold** — until
  2026-09-21g (2960760) it rode § 3.7 rule 6's fixed `THRESHOLDS.target`
  (0.5) with NO candidate-set check; multi-candidate 0.55 rounds acted
  mid-takeover. The two-part rule now lives in rule 6 behind the `takeover`
  flag; `wingman_do` keeps the fixed bar. Threshold narratives are intent,
  not code — read `decideTarget` and the constants first.
- **The pre-2026-09-22 entry commit never checked the floor on the CHOSEN
  element** — `set.size === 1` committed any lone candidate at ANY grade
  (the floor gated only rivals). Cite the margin rule, not the old candidate
  set, in any "entry floor is 0.5" narrative.
- **The two-stage decision map is stage-2's alone**: `{...primary,
  ...secondary}` takes request 2's target answer wholesale and stage 2
  re-grades from scratch — a dominating stage-1 grade never enters the
  decision; the margin rule fires only when ONE answer map holds both the
  dominating element and the beaten meta-answer.
- **browse_step entry on two-stage pages used to ALWAYS bounce
  `step-uncertain`/`no-match`**: `entryUncertainty` read `answers['action']`
  from request 2, which never carries `action` (plain `wingman_do`
  unaffected — decideTarget gets both maps). Fix (2026-09-21h): entry gets
  `{...primary, ...secondary}`; the covered-target gate sits between entry
  commit and `decideTarget` — before any value ask, after the retry decision
  — so a covered target costs one ask, zero acts, no self-retry. The
  two-stage test only covered non-entry rounds.
- **`BUDGET_LIMITS` caps caller overrides only**: `loadConfig` seeds
  `DEFAULT_BUDGETS` without validating against the limits — default
  `max_steps: 24` with cap `[1, 8]` is coherent; a user value above 8 is
  still REJECTED. `runDoRounds` takes `min(caller max_steps, config 24)`;
  schema allows 1-24.
- **Raising the step budget does NOT stop caller call fragmentation**: the
  bottleneck is the calling model's planning; wingman machinery is
  ~1 s/round, noise at wall scale.
- **The `budgets` validation pattern silently accepts `NaN`** —
  `typeof v !== 'number' || v < min || v > max` passes NaN. `budgets.*` is
  saved by `Number.isInteger`; any future plain-number config key needs an
  explicit `Number.isFinite`.
- **Jev's grades are bimodal and honest about element choice, never
  actability**: 0.83-1.00 well-labeled, 0.37-0.38 genuinely ambiguous — yet
  7/9 executed high grades hit `CoveredTargetError` (overlay-class covers),
  and the question set has no "is it covered" probe (`blocked` asks only
  captcha/paywall/etc). Jev over-refused t9 form steps that execute
  fine — the routing criterion needed recalibration, not the element table.
  Re-asks are bimodal too: a sub-floor re-ask bouncing under the margin
  rule is correct, NOT a regression — validate grading-shape fixes by
  measured-map replay (`.calib/probe6b-replay.mjs` pattern), never one
  natural re-ask.
- **`buildRoutingRequest`'s `elements` parameter is deliberately not
  consumed**: the § 3.18 element table rides in the request's `state` object
  (caller builds redacted `elementCriterion` strings); the builder passes
  `state` through unchanged. Do not inject `elements` into the state — that
  double-redacts and desyncs from § 3.19.
- **`observeTimed(pageId, history)` takes the round's history array** (the
  round-top call in runDoRounds passes it; runCheck passes nothing, so a
  wedge there still throws immediately). r21b gate: a SLOW first-observe
  failure (>= 2 s) retries (same two inner retries) only when NAV-SHAPED —
  message matches `NAV_SHAPED_OBS_ERROR_RE`
  (`/evaluation timed out|Execution context/i`, both adapters'
  evaluate-timeout/context-destroyed shapes) AND the last history entry is
  click-family (`CLICK_FAMILY_OPS`, read BEFORE `annotateLastOutcome` —
  the previous round's act). The nav-shaped slow path's first settle is
  `PRE_CLICK_SETTLE_MS` (4000); everything else keeps `OBS_RETRY_SETTLE_MS`
  (500). `KB_OBS_RETRY` disables all of it. loop.test.ts pins (beside the
  r21 pins): retried-after-click (fail-first red pre-amendment),
  no-prior-act throw green both sides, KB flip kills both.

## Tool text, delegation & policy

- **A tool description that leads with WHAT then lists prohibitions gets
  skipped.** Fix (203cf67): first sentence = WHEN (one bounded goal), then a
  prefer-over-driving line WITH the benefit, then a do-NOT-use line; example
  verbs must cover the target task shapes. Schema friction ruled out (only
  `goal` required).
- **Exact-string pins must inline the SPEC's text as the expected value** —
  a pin importing the same constant the code uses compares code to code and
  never sees spec drift. Add the spec-inline comparison, not a same-constant
  mirror.
- **Policy-neutral tool text (2026-09-25)**: descriptions no longer name a
  policy or a browser tool (`WINGMAN_DO_DESCRIPTION`,
  `WINGMAN_CHECK_DESCRIPTION`, `BROWSE_STEP_DESCRIPTION` in
  `src/surfaces/tool-text.ts`) — the server (`policy.mode`, re-read every
  call) is the sole enforcer; `loop.ts`'s `finish()` sets a fallback's
  `note` to `SENSITIVE_LINE` for any `sensitive-*`/`unsupported-page`
  reason, all three tools, bypassing `CONTINUE_LINE`, the browse_step note
  table and the bounce counter — where the caller learns to hand a step
  back to its own browser tools. Descriptions are served once per session,
  so this is the only way a policy change reaches caller behaviour. The
  wingman attaches over CDP; it acts on the one visible tab or the tab
  `url_match` names. Spec:
  `pa/plans/2026-09-25-wingman-policy-neutral-tool-text-SPEC.md`.
- **Tool text alone does not win delegation — withholding does.**
  Route-neutral prompts dropped `wingman_do` on the long chain; with
  `browse_step` beside raw tools the caller never chose it; browse-only
  tool lists alone gave give-up-early "wins". Forced handoff (raw page
  tools withheld) made delegation stick. `BROWSE_ENGAGEMENT_LINE` is
  single-line ASCII (em-dashes fold in win32 cmd).
- **The caller's forward-vs-re-send recovery choice is not determined by the
  note branch**: r20 cell 1 forwarded under the new post-action note; r21b
  re-sent the full chain under the old-equivalent tier-1 note (its first
  call ended `multi-match`, so S-1a never fired). FORCED_ENGAGEMENT_LINE's
  "call it again with the same arguments" conflicts with
  FORCED_POST_ACTION_LINE's "only the steps after this one"; the small
  caller resolves that conflict unpredictably.

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
  `S({ ..., action: undefined })`, or the fail-first test passes pre-fix.
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
  `browse_step` call) must answer both 0.95 — check first for any NEW
  chain-mode stub.
- **`FakeDriver.dialogOnNextAct` is a CASCADE, not a per-act drain**: every
  event in the array delivers, in order, during the ONE act (a second dialog
  in the same act is otherwise unscriptable). **FakeDriver repeats the last
  scripted observation** when a script is exhausted — a two-observation
  script with a changed second entry shows a page change or a late landing.
- **`evaluateOracle`'s false-only fallback**: a false-only test cannot prove
  the oracle — keep at least one assert-true expression.
- **`el()` (outcome-evidence helper) defaults `editable: true`** — a "plain
  button" fixture must override `editable: false` (and tag/role) explicitly,
  or the focus-promotion rule fires and the negative pin reads
  `focus changed`.
- **Two consecutive rounds acting the same (verb, element) over a single
  static observation is a no-progress/repeat-guard trip by construction** —
  audit the WHOLE suite on any change to `isNoProgress`/
  `annotateLastOutcome`. A count-clause test needs every click's observation to change (or the
  count met before any repeat) — `isNoProgress` fires before any
  count/repeat semantics. Alternation must be strict (`round % 2`): an
  e1/e2 alternation yields two consecutive e2 clicks by round 3 and passes
  for the wrong reason.
- **Optional telemetry fields on `PhaseRound` / `WingmanLogRecord`** must
  never be assigned when the source value is undefined:
  `assert.deepStrictEqual` treats `{k: undefined}` as different from `{}`,
  and `tests/loop.test.ts` pins the exact round shape. Guard with
  `!== undefined`.
- **dist freshness — `run-tests.mjs` does NOT rebuild**: it runs whatever
  `dist/` holds. A KB-proof run poisons the scoped `.build` until build.mjs
  re-runs (`--dist .build/<pkg>` executes the COMPILED copy: a green-looking
  re-run after a source restore still runs mutated JS — re-run the scoped
  build after the last restore). Diagnostic `console.error` patches applied
  to dist directly (for instrumenting adapter internals) survive into
  run-tests runs and are wiped by the next `scripts/build.mjs`. Verify
  which build a run executed before interpreting its output.
- **`run-tests.mjs` output is pipe-buffered to the END**: an empty interim
  output file does NOT mean a stalled run — TAP lines appear only at
  completion when piped. `... | tail -40` shows only the last screen (a
  2-fail summary loses the first failure). Redirect to a file, read the
  file; check process liveness before killing anything.
- **Runner invocations**: basenames EXCLUDE the `.test.js` suffix (`chrome`
  -> `chrome.test.js`; `chrome.test` matches nothing). The env scrub
  removes `TYPESAFE_API_KEY` — inject through `BenchDeps.env`, never the
  process env.
- **A scoped `build.mjs --out <dir> tests/cli.test.ts` compiles only the
  test's import graph, and `cli.test.ts` spawns `src/cli/main.js` by path
  without importing it** — every spawn test fails ("Cannot find module").
  Pass the CLI as a second entry:
  `node scripts/build.mjs --out <dir> tests/cli.test.ts src/cli/main.ts`.
- **`guide.js` only exports `guideCommand`** — the CLI path under test is
  `main.js guide`; a temp package root needs the whole compiled dist plus a
  `node_modules` junction and `"type": "module"`.
- **`chromeCommand` tolerates a missing `config.json`** (defaults apply), so
  an empty-`WINGMAN_HOME` dispatch test reaches the port probe and must
  assert chrome-cmd's `no-browser` JSON line (exit 1); unwired, `chrome
  show` exits 2 with usage — the 2-vs-1 delta is the test's teeth.
  `chrome show` no-browser also fails when the shared bench Chrome is up
  (port 9222, exit 0): stop the shared-profile Chrome first — not a
  defect.
- **A live headed Chrome in a unit test works off-screen**: direct-spawn
  with the anti-throttling flags plus `--window-position=-32000,-32000` on a
  `wingman-ephemeral-` temp profile; measure via the PowerShell
  EnumWindows/GetWindowRect pattern in `scripts/gates/window-mode.mjs`;
  assert the off-screen PRECONDITION first. It also needs the three
  `HEADED_ARGS` anti-backgrounding flags plus exactly ONE page target, or
  `pages()` shows `visible:false` and the loop refuses (`tab-ambiguous` —
  zero candidates means zero visible).
- **`if (false && <cond>)` is not a valid KB-mutation shape**: the dead
  branch loses TS narrowing and the build fails, silently testing the
  PREVIOUS dist. Mutate via a `const KB_X = true` flag composed with the
  condition (KB-mutant methodology below).
- **Adding a dimension to `bench/config.json` silently invalidates the count
  assertions in `tests/bench-cap.test.ts`** — any route/config-shape change
  must re-run `bench-cap` alongside the owning package's gate.
- **`waitForPage`'s first-match URL find returns STALE pages**: `rig.close()`
  detaches the driver but never closes the page target, so a retry loop
  that reopens the same fixture URL gets the OLD page and silently measures
  the wrong document. Close the page target (`Target.closeTarget` over a
  raw session) when discarding a rig a retry will replace by URL.
- **Pinning "failure after an act" in a stub**: the harness's observe
  override fires per DRIVER CALL and round 1's observe comes FIRST — a
  "fail the first observe" stub makes round 1 (no prior act) the failure,
  which the wedge gate correctly refuses, so the pin reds for the wrong
  reason. Count calls and fail the SECOND.
- **A fail-first test asserting a derived label can red for the wrong
  reason**: the F1 no-ask-round pin expected a global round counter and red
  on the label, not the shift — the discriminating assertions (line count,
  paired probabilities) must carry the pre/post contrast; derive expected
  labels from the code's own semantics.
- **Diagnose a "slow but succeeding" CDP act by patching dist, not by
  reading src**: the 5 s stall looked like EVAL_TIMEOUT_MS (5000) firing,
  the guard settling, or the dialog race — all disproven once per-substep
  timestamps existed. `node --test --test-name-pattern="<test name>"
  dist/tests/<file>.test.js` reproduces single tests cheaply, but bypasses
  run-tests' token sweep — sweep `wingman-ephemeral-` chromes after.

## Bench harness

- **The bench wingman-route prompt lives in `bench/run.ts` `buildPrompt`**
  (`bench/claude-run.ts` is the spawn layer). The task goal rides verbatim
  in every route's prompt — before that fix the goal was in no prompt
  (t9's oracle endpoint unreachable by instruction; "oracle false" cells
  partly measured wandering). Fail-first proof:
  `tests/bench-browse.test.ts` ("both routes carry the task goal verbatim").
- **`max_turns` is often the binding ceiling, not knowledge**: the 7-page t9
  chain needs ~2 calls/page; definitive cells burned 25 calls at
  `max_turns: 25`. Raise it or the wall measures the turn cap.
- **`detached: true` on the win32 cmd spawn in `bench/claude-run.ts`
  swallowed ALL stream-json output** (A/B proven, 90ad51d). Never spawn
  through `cmd /c` detached.
- **A "wingman" route cell is only a wingman measurement if
  `typesafe.calls > 0`** — read `bench/results/*.json` before interpreting
  any wingman-route row.
- **A spawned bench caller can come up with NO MCP servers despite a correct
  `--mcp-config` absolute path** (contradicting `--strict-mcp-config`).
  Before charging a zero-tool-call cell to a mechanism, re-probe the spawn
  flags with a trivial prompt.
- **`claude --model sonnet` resolves through the local GLM proxy**
  (`glm-5.3-flash[1m]`): `usd` prices tokens at Sonnet list rates;
  `cli_reported_usd` is the proxy's synthetic number; route-vs-route
  stays valid.
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
  any spend. One clean immediate retry fixes it; a fresh profile may need
  a hand warm-up first. The same window can make the lazy-chrome
  known-bad `eager-ensure` print `ok` spuriously — rerun before diagnosing.
- **`stopChrome` skips a Chrome it did not start** (`startedByUs: false`) —
  sweep diagnostic/bench-profile chromes afterwards, including the surviving
  `--type=crashpad-handler` orphan (parent dead, `stopChrome` never sees
  it). The harness guard blocks deleting top-level `D:\` dirs.
- **Results files are second-stamped** `YYYY-MM-DD-HHMMSS.json`, `_N` on a
  clash, never overwrite. `--repeats N` (integer 1-5) is a CLI flag of
  `dist/bench/run.js`.
- **`wingman_phases.jev_ms` is a rounds-MEDIAN and per-round jev is
  bimodal** (cold vs warm rounds differ ~2x): the run median tracks
  delegation mix, never "Jev got slower". Scroll rounds' `act_ms` includes
  the r17c growth wait (up to `SCROLL_GROWTH_WAIT_MS` = 1500 ms) — never
  read it as Jev latency; a "should have caught this scroll loop"
  diagnosis checks `scrollY` movement first.
- **Bench walls are load-sensitive at the caller-fragmentation margin** —
  the same cells varied >2x under agent load vs clean. Never compare cells
  measured under different load; treat cross-pass wall ratios >2x as
  suspect until load is accounted for.
- **Escalation tiers must be reconstructed from log clustering, not read**:
  `bench/.home/log.jsonl` records `status`/`reason` per call but never the
  goal text, so a bounce's tier is only known when bounces are CONSECUTIVE.
  **Read `log.jsonl` twice before trusting a fresh read** (one came back
  short; D: write-back/AV suspected); `wc -l` repeat or mtime check first.
- **A leaked scratch Chrome holding the probe port silently poisons every
  later probe**: the port-answering fetch hits the zombie, whose
  backgrounded window reports `visibilityState: 'hidden'`, so every
  `wingman_do` returns `tab-ambiguous` with `jev_calls=0`. Kill scratch
  chromes by temp-profile cmdline marker (`taskkill /T /F` does not reliably
  take the tree from a plain launcher PID), poll the port CLOSED after
  teardown, fresh port per run.
- **Browse-only is config, not env**: `handoff.tools` (`"browse-only"`
  default in forced mode, `"all"` in optional) hides wingman_do/wingman_check
  from tools/list AND refuses them at call time. The old
  `WINGMAN_BROWSE_ONLY` env var is gone from src (tests/mcp-server.test.ts
  asserts it is ignored; `bench/.home/mcp-browse.json` still carries it as
  stale config). With top-level `mode` off the server lists NO tools. Probe a spawned server's tool list with SDK
  `StdioClientTransport` against `dist/src/cli/main.js mcp` and a temp home
  — from inside the repo tree (scratch-dir node cannot see node_modules).
- **`wingman_do` fill probes must carry the value in `values`**: `values: {}`
  never asks the value question and ends `no-value` — a probe artifact, not
  an execution failure.
- **Any future `harness_version` bump must `grep -rn harness_version tests/`
  itself** — the r18 spec's "no external consumer pins HARNESS_VERSION 2"
  claim was FALSE (`tests/bench-browse.test.ts` pinned 2). Never trust a
  spec's verification note for this.
- **`runBench` starts a real localhost fixture server whenever any selected
  task is `local: true` (t15-t17)** — including fake-deps test invocations,
  which therefore bind an ephemeral 127.0.0.1 port. Two close sites,
  disjoint windows (the finally, plus a catch-rethrow over the
  prepare/wiring window) — do not merge them or move the start after
  `prepareBrowser`. URL resolution lives in pure `resolveStartUrl`; the
  local branch beats the absolute branch by design.
- **The fixture server's `.html` suffix is OPTIONAL in BOTH segment rules**
  (`src/fixture-server.ts`) — the r23 spec D1's literal regexes require
  `\.html`, contradicting its own D6/WP-B pins (extension-less task paths
  must serve). Trust D6, not the D1 literal. So `/cookie` (extension-less)
  serving + Set-Cookie is NEW behavior (fail-first red pre-change); the
  stay-green test comment and the unchanged-behavior spec label are both
  wrong.
- **The parity recon's `failed` flag is dead code** —
  `fixture-parity-recon.mjs` sets it on a local page-load failure but
  never reads it; `/`,
  `/dynamic_controls`, `/status_codes/404` and `/key_presses` carry no
  required name and no count check, so a failed or empty dump on those four
  exits 0. The other 12 pages gate correctly.
- **Fixture-server hostile-path surface**: all `..` encodings
  (raw/encoded/mixed/backslash), drive-letter, null-byte and depth-cap
  cases 404; the one quirk is win32 backslash aliasing — `/status_codes\404`
  serves the nested page WITHIN pagesDir (`[^/]+` admits `\`; no escape is
  possible while `..` stays substring-rejected). Fine for 127.0.0.1;
  revisit if the server ever binds wider.
- **Grader-replay capture lines carry `stage`; rounds consume N asks** (F1):
  a two-stage round makes TWO askWithCost calls, a native-select resolution
  one per chunk plus a final — a one-ask-per-round merge shifts every later
  pairing by one, silently (unmatched rounds only mark `mirrored:false`;
  capture exits 0). The merge is the exported pure
  `mergeCapture(records, asks, thresholds)` in `bench/grader-replay.mjs`;
  `askStage(request)` classifies `group`/`target`/`option`/`recover`/`round`
  (recover counts only when the SOLE question — buildRoundRequest carries
  recover as an EXTRA question next to done). A round whose
  `phases.rounds[].jevMs` never moved ended BEFORE its ask and consumes
  zero asks. Old capture files (no `stage`) still replay: the stage is
  re-derived from the request's question keys. The line's `round` field is
  the per-RECORD round index (what mirrorDecision's error-gate needs),
  never a global counter.
- The readme-bench gate picks the newest `measure` results file by name; its
  old-file fallback renders exactly the pre-r19 four-column block — context
  line + spread column appear only when EVERY summary row carries
  `wall_min_ms`/`wall_max_ms`, so a harness-2 file never gets a false
  provenance claim. The gate EOL-normalizes (a red is real); its source
  `bench/results/*.json` is gitignored, so it reds on a fresh clone.
- **The MCP server never launches Chrome** (only the `with-browser` wrap or
  `chrome ensure` does): unwrapped fresh installs fail `adapter-attach`.
  Doctor passes with top-level `mode` off; `doctor --plan` O1 checks mode.
- **Re-derive every public number from the results JSON, never from
  narrative**: r19 figures drifted into r23b copy and none reproduced.
  r23b per-shape: cheaper 13/17, wall faster 5/17, >=4 s slower on
  t6/t9/t11/t12/t10; 17/34 forced cells had a fallback; raw_acts 0.
- **The byte-vs-string slice trap (bench log slicing, r19)**: slicing a
  decoded string by a byte offset is silent data loss —
  `statSync().size` (bytes) + `readFileSync(path, 'utf8').slice(before)`
  (chars) corrupts the first fresh line whenever the prefix holds any
  multi-byte UTF-8 (one ellipsis sufficed). Slice Buffers
  (`subarray(before).toString`); `tool_use_counts` (caller-side) is the
  cross-check that catches a log-slice under-count; shape correlations on
  under-counts deserve a byte-level look before a mechanism story.
- **Bench round HEADs in round-labeled dispatches can be wrong — read each
  results.md header**; timing arguments built from round labels are void.
- **Diagnose t9 fragmentation from the post-fallback RECOVERY calls, never
  the first call** — the forced first call is INVARIANT across healthy and
  regressed runs (the loop drives the forgot-password submit into the
  site's flaky 500/result state every time); the +70% wall lived entirely
  in recovery calls.
- **Error-end presence is the healthy/regressed discriminator**: healthy
  slices carry zero `error/*`/`ambiguous/*` ends; regressed rounds show
  `act-failed` (locator.click 3000 ms timeout during a scheduled
  navigation) and `page-error` on the same transitions. Live-site
  navigation timing crossing the loop's fixed 3 s act cliff was the
  remaining variable — the flat playwright control does NOT exonerate it
  (auto-waiting clicks have no 3 s cliff).
- **A resumed-cursor re-send can bounce `ambiguous/target-uncertain` with
  jev_calls=0 and a round record carrying NO probabilities** (an ask ran
  uncounted or the round record merged wrong — telemetry inconsistency);
  scoped repro in chain.test.ts needed before trusting jev_calls on
  resumed calls.

## Chrome lifecycle & teardown

- **The runner token sweep is the leak guarantee; per-test finally-blocks
  are best-effort only.** Every `run-tests.mjs` invocation mints a unique
  `WINGMAN_RUN_TOKEN`, passes it to each spawned test's env, and — on every
  exit path (plus a sync `process.on('exit')` fallback) — kills any
  chrome.exe whose command line carries `--wingman-run-token=<token>` (PID
  tree, logged `RUN-TESTS: chrome sweep (...)`). `launchEphemeralChrome`
  copies the token onto each chrome's command line; production and bench
  (token unset) unchanged. A sync exit-registry backstop in
  `tests/helpers/chrome.ts` tree-kills any browser still registered.
  Fail-first proofs: `tests/runner-sweep.test.ts`; the leak fixture
  `tests/runner-sweep-leak.test.ts` is the drill target — never "fix" it.
- **The token sweep cannot cover a hard-killed runner** (SIGKILL/taskkill of
  run-tests.mjs itself): sweep manually by the `wingman-ephemeral-` cmdline
  marker — never a Chrome whose profile is the shared browser profile.
- **Never tag a test Chrome with an extra unknown switch**: headless chrome
  writes `DevToolsActivePort` but its HTTP endpoint never answers, so the
  endpoint reads dead (A/B proven). Tagging must ride `--user-data-dir` (as
  the token does) or another blessed argument.
- **Ephemeral-Chrome leak defence (src/browser/ephemeral.ts), three
  layers**: profile dirs embed the launching pid
  (`wingman-ephemeral-<token?>-p<pid>-...`, token before pid so the
  substring match still hits); a `process.on('exit')` guard tree-kills
  anything this process launched and never closed; `sweepOrphanedEphemeralChromes`
  (memoized, every launch) kills tagged root chromes whose owner pid
  is dead and removes their profile dirs, aging untagged legacy dirs out
  after 24h (never kills a legacy chrome — untagged can't prove orphanhood).
  Launch failures (e.g. the `DevToolsActivePort` 15s timeout) kill the tree
  and remove the profile dir before rethrowing.
  `tests/ephemeral-sweep.test.ts` uses injected fakes only; any test
  launching a real Chrome runs alone in the foreground.
- **Chrome's own child processes carry `--user-data-dir` but never the
  debug port** (`--type=gpu-process`, `--type=crashpad-handler`, ...); the
  main browser process never carries `--type=`. Holder detection counting
  every chrome.exe on the profile marker FAILs preflight G4 / verify V4 /
  doctor `profile-safe` while the managed Chrome is up. Fix b9f3b14:
  `profileHolders` skips cmdlines containing `--type=`. **Gate semantics
  are "FOREIGN holder", not "any holder"**: a chrome on ANOTHER profile is
  never a holder of this profile; a foreign chrome on THIS profile without
  a port still fails the gates (fixture matrix in `tests/chrome.test.ts`).
- **A minimized Chrome window rejects a position-only
  `Browser.setWindowBounds`** — restore (`windowState: 'normal'`) before
  moving; `chrome hide` restores first, `chrome show` restores by
  definition (the restore takes the foreground — that IS show, RO-7).
  **`Browser.getWindowForTarget` is per-page**: collect distinct
  `windowId`s over page targets or you move one window N times.

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
  every other CDP round-trip.
- **The cdp adapter's `act()` must propagate `actRaced`'s return** — the op
  switch lives inside `private actRaced(...)`, and a bare
  `await this.actRaced(...)` on the element-targeted path silently discards
  any act-returned value (playwright's switch is inline; same edit there).
  A new act-returned value needs BOTH the switch-case
  `return` AND `return this.actRaced(...)` at the targeted call site; the
  targetless path discards deliberately.
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
  write NEVER lands (never observed anywhere). The E16 check
  therefore passes only on a RESOLVED prompt (`#log === ''`); don't
  "simplify" that back to `assert.equal(log, 'dismissed')` — unreachable
  here.

## Enumeration & page-scripts

- **"Jev said `none`" is an enumeration-candidacy question first**:
  `isCandidate`/`isCandidateTag` (`src/core/page-scripts.ts`) are the single
  choke point — no matching attribute/tag/role means the target NEVER
  enumerates, and no grader change can fix it (DataTables-style headers bind
  via JS listeners, no inline `onclick`). Signature: the log's
  `target1: "none"` at high confidence. Check enumeration before grader
  text or thresholds.
- **Cursor-pointer candidacy is a REJECTED, REMOVED heuristic (r21 P-5 ->
  D12, 2026-10-04)** — do not re-propose it. The D12 live bar measured
  +88% to +298% candidate inflation against the +30% cap (the failure was
  candidate quality, not time). Shipped `page-scripts.ts` carries zero
  cursor arms (grep `cursor` = 0); the rejection is final, not a flag
  default. `fixtures/pages/pointer-interactive.html` stays as the boundary
  fixture: delegation-only pointer-styled divs (framework menu items with
  no onclick/role/own listener) do NOT enumerate, pinned zero-records in
  `tests/pointer-enum.test.ts` beside the iframe/shadow boundary pins.
- **`el.className` on an SVG element is an SVGAnimatedString object**
  stringifying to `'[object SVGAnimatedString]'` (F3): any RE match over
  className silently misses every SVG-carried class. Read
  `el.getAttribute('class')` instead (works for HTML and SVG). The captcha
  id/class arm in page-scripts.ts now does; the repeatedGroups signature
  build (`String(gn.className)`, r17 C8) keeps className by design — SVG
  groups there read as one `[object...]` bucket, harmless for tallies, but
  any future CONSUMER of that signature must know.
- **`CAPTCHA_RE` false-positives on whole real pages** (bbc.com, npr.org
  embed /captcha/i in login/ad widgets): every browse_step returns
  `blocked/captcha` BEFORE any ask (zero spend, zero grades). News sites
  stay off-limits until the signal is scoped to real challenge widgets.
- **A label with `for` — or a wrapped control — is OWNED**: `siblingLabel`
  must skip owned labels or a hidden input adjacent to `label[for=x]`
  steals x's name.
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
  executes Jev's own top candidate, verification is outcome-based
  main-world evals. The spy's `twoStage`/`groupCount`
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
  instead of killing it). Lesson: derive polarity from the mutant
  convention FIRST, then check the spec literal.
- **The mutants runner's anchor is `= false;` -> `= true`**; a source-shape
  tripwire (line replacement) needs the runner's optional 4th tuple
  element: anchor = the literal good source line, 4th element = the bad
  line substituted in. A pure one-array append would produce a no-op
  mutation the pin passes against. Any "revert-detection" mutant uses that
  form, never a fake flag.
- **A guard like "never on the final clause" (`cursor < N - 1`) makes any
  mutant test whose target clause is the last clause vacuous** — give such
  tests a trailing clause.
- **Pin a timing bound from the LOCAL measured pair, never the cloud pair**
  — the KB_CDP_PRECLICK cloud pair does not reproduce on this box (local
  active ~4 s — the PRE_CLICK_SETTLE_MS 4000 floor dominates — vs 28 ms
  skipped), so a cloud-derived `>= 7000` bound would be permanently red
  here. A pin
  that cannot fail on the flip AND cannot pass locally is doubly wrong;
  measure both sides on the box that runs the gate.
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
  kills Claude's own background shells; `python -u` streams per-flag OK
  lines.
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
  (`adapter-cdp.test.ts` with leaked chromes; alone ~65-77 s). **Prefer foreground runs with an explicit tool-level timeout
  (this harness's Bash `timeout_ms`, not a shell `timeout` prefix)** over
  backgrounding+polling — a background run cannot distinguish "buffered"
  from "wedged", and a Monitor on the completion line has the same blind
  spot.
- **The memory-pressure reaper kills idle-session background shells and
  the Chrome they spawned** — including a RUNNING bench cell mid-flight
  (no results file, no ledger entries) and backgrounded scoped gates (one
  reap orphaned 100+ test chromes). Chrome-backed adapter files go
  foreground, split per-basename (adapter-cdp ~3 min, adapter-playwright
  ~2.5 min, alone) instead of one invocation that outlives the 10-min
  foreground cap and gets backgrounded. Restart only after memory recovers.
- **The leaked-Chrome wedge is self-compounding**: past ~440 chrome.exe,
  WMI, `tasklist` AND `Get-Process` all stall — the sweep itself cannot
  enumerate. Sweep by the `wingman-ephemeral-` marker IMMEDIATELY after
  each chunk. At ~2.3 GB free, even a SERIAL adapter-cdp full-file run can
  wedge — prefer a single-chrome probe for shape-refresh work.
- **This box stalls `Input.dispatchMouseEvent` type `mouseMoved` by exactly
  ~5.0 s under memory pressure while `mousePressed`/`mouseReleased` answer
  in 1-3 ms** (per-send instrumentation). Any wall-clock
  pin over a CDP click act must anchor its delta on the mouseReleased
  response — the moment the page's own click handler (and therefore any
  setTimeout chain) starts — not on act entry; a delta so anchored is
  immune to the stall, while click-act totals and raw elapsed windows are
  not.
- **Chrome lives at `C:\Program Files (x86)\...` on this machine**, not
  `Program Files`. And **`Start-Process -ArgumentList` joins array items
  with bare spaces**: embed the quotes in the argument string or an
  unquoted `--user-data-dir=<path with spaces>` splits, Chrome starts on a
  bogus profile that `ensureChrome` refuses.
- **An `Edit` whose `new_string` re-includes a block adjacent to the
  deleted one duplicates it.** Read the whole file after any edit that
  deletes a block next to a structurally identical one.

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

- **One pre-existing, diff-unrelated scoped-gate failure (as of 2026-09-25)**:
  `tests/cli.test.ts` "chrome show dispatches into chrome-cmd" fails with
  exit 0 vs expected 1. Do not attribute a future red to a new diff without
  checking. An adapter-cdp form.html-table red is real.
