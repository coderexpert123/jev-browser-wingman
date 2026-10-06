# tests/ — test infrastructure and KB-mutant notes

Auto-loads when working in `tests/`. Root `CLAUDE.md` still holds Machine traps (16 GB box: how to run tests/bench at all) and Chrome lifecycle & teardown (the token sweep and leak defences every test run depends on); bench specifics: `bench/CLAUDE.md`; loop/evidence internals: `src/core/CLAUDE.md`.

## § Test infrastructure & stubs

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
  audit the WHOLE suite for this pattern on any change to
  `isNoProgress`/`annotateLastOutcome`, not just the file a diff names
  (three pre-existing green tests in takeover.test.ts flipped this way).
  A count-clause test needs every click's observation to change (or the
  count met before any repeat) — `isNoProgress` fires before any
  count/repeat semantics. Alternation must be strict (`round % 2`), not "first round differs": an
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
  to dist directly (the only way to instrument adapter internals the tests import opaquely) survive into
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
- **`bench-browse` git-greps `WINGMAN_BROWSE_ONLY` over `bench/`**, so no brain
  file under `bench/` may name that variable literally (08661af broke this).
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
  The test pins a free `port` in config (233e92a), so a live Chrome on 9222
  cannot change it.
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
- **`waitForPage`'s first-match URL find returns STALE pages**: `rig.close()`
  detaches the driver but never closes the page target, so a retry loop
  that reopens the same fixture URL gets the OLD page (already clicked, extra content — the growth signature
  grew 8:9 -> 9:20 -> 10:26 across attempts) and silently measures
  the wrong document. Close the page target (`Target.closeTarget` over a
  raw session) when discarding a rig a retry will replace by URL.
- **Pinning "failure after an act" in a stub**: the harness's observe
  override fires per DRIVER CALL and round 1's observe comes FIRST — a
  "fail the first observe" stub makes round 1 (no prior act) the failure,
  which the wedge gate correctly refuses, so the pin reds for the wrong reason and looks like a code defect. Count
  calls and fail the SECOND.
- **A fail-first test asserting a derived label can red for the wrong
  reason**: the F1 no-ask-round pin expected a global round counter and red
  on the label, not the shift — the discriminating assertions (line count,
  paired probabilities) must carry the pre/post contrast; derive expected
  labels from the code's own semantics.
- **Diagnose a "slow but succeeding" CDP act by patching dist, not by
  reading src**: the 5 s stall looked like `EVAL_TIMEOUT_MS` (5000) firing,
  the guard settling or the dialog race — all disproven once per-substep
  timestamps existed (cause: the `mouseMoved` stall, root `CLAUDE.md`
  § Machine traps). `node --test --test-name-pattern="<test name>"
  dist/tests/<file>.test.js` reproduces single tests cheaply, but bypasses
  run-tests' token sweep — sweep `wingman-ephemeral-` chromes after.
- **Timeout flakes need real renderer starvation, not node-side CPU load**:
  8 CPU-burner processes kept every probe eval under budget — the cloud
  failure mode is the 160-chrome wedge starving Chrome itself.

## § KB-mutant methodology

- **KB flags compose as `!KB_X && <new>`, never `KB_X && <new>`**: flip =
  restore PRE-fix behaviour, so the new path must be ACTIVE while the flag
  is `false`. Writing `if (KB_TABLE_HEADERS && tag === 'th')` ships pre-fix
  behaviour with every pin red at the gate — and the failure looks like
  "fix didn't work", not like an inversion. Ternary precedent:
  `KB_X ? <old> : <new>` (`KB_HIDDEN_SIBLING`). **One documented spec-polarity failure**: the r19 spec's draft `checkFlipResult` used `!KB_UPLOAD_EVIDENCE &&` (inverted — flipping the mutant would ENACT the fix); amended 2026-10-03 (61df9bb, spec lines 121-129). Lesson: derive polarity from the mutant
  convention FIRST, then check the spec literal.
- **The mutants runner's anchor is `= false;` -> `= true`**; a source-shape tripwire (line replacement, e.g. D-11's run.ts slice
  tripwire) needs the runner's optional 4th tuple
  element: anchor = the literal good source line, 4th element = the bad
  line substituted in. A pure one-array append would produce a no-op
  mutation the pin passes against. Any "revert-detection" mutant uses that
  form, never a fake flag.
- **A guard like "never on the final clause" (`cursor < N - 1`) makes any
  mutant test whose target clause is the last clause vacuous** — give such
  tests a trailing clause.
- **Pin a timing bound from the LOCAL measured pair, never the cloud pair**
  — the KB_CDP_PRECLICK cloud pair (9117 ms guard active vs 5124 skipped)
  does not reproduce on this box (local: 4075/4220 ms active — the
  PRE_CLICK_SETTLE_MS 4000 floor dominates — vs 28 ms skipped), so the
  dispatch-suggested `>= 7000` bound would be permanently red here. A pin
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
  AND after every mutants pass: `grep -rnE '(const|var) KB_\w+ = true' src` must
  return nothing; restore `= false` immediately. The full pass is ~25+ min,
  past the 10-min foreground cap — run it DETACHED (`Start-Process python
  -u`, output redirected, PID saved) and poll the log; the reaper only
  kills Claude's own background shells; `python -u` streams per-flag OK lines so liveness is visible.
- **`chain-e2e` runs `adapter: 'cdp'`** — e2e results discriminate CDP-side
  flags; a playwright-adapter e2e claim needs the adapter-playwright rig.
  Adapter-level waits are invisible to FakeDriver unit tests.
