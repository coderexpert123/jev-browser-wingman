# src/core — page-scripts gotchas

- **The irreversible gate is config-switchable** (2026-09-20; Q6 flip
  2026-09-26): `config.json` `gate.mode` accepts `"off"` (default since 0.3.0)
  and `"confirm"` (opt-in). Read it only through `gateModeOf()`, which returns
  `'confirm'` iff the config says so explicitly — a hand-built config without a
  `gate` key now runs off, and every test that wants a token writes
  `gate: { mode: 'confirm' }` itself.

- **The sensitive-surface policy is config-switchable, and OFF by default**
  (2026-09-21, flipped 2026-09-22 by operator decision): `config.json`
  `policy.mode` accepts `"off"` (the shipped default — page content goes to
  TypeSafe on every page, including sensitive ones) and `"enforce"` (opt-in
  fail-closed: `classifyUrl`/`classifySignals` report sensitive and the
  host/page-signal fallback to Playwright fires). Read it via `policyModeOf()`
  (config.ts), which returns `'off'` unless the config explicitly says
  `'enforce'` — a pre-key config object therefore runs off. The classifier
  defaults (`DEFAULT_POLICY_MODE` in constants.ts) flipped with it, so
  `classifyUrl(url)` with no mode arg is non-sensitive; tests that pin
  enforce semantics must pass `'enforce'` explicitly. The irreversible gate,
  value withholding and confirm tokens are unaffected by this switch.

- **The proxy rule lives twice, on purpose.** `enumerate` (buildRecord) and
  `verify` each contain an inline copy of the styled-control proxy detection
  (hidden checkbox/radio + visible label). This duplication is required by the
  purity contract: every `build*Expression` is stringified via
  `Function.toString()` and must be self-contained — no shared module helpers.
  If you change proxy detection on one side, mirror the change in the other or
  the enumerate/verify contract silently breaks (wave-4 incident: verify
  compared an input's fingerprint against the label at the record's path and
  always returned `mismatch`, so every adapter threw StaleElementError on
  styled checkboxes/radios).
- **verify()'s position check stays on the label.** For proxied controls the
  fingerprint's x/y come from the LABEL's rect (enumerate records
  `rectOf(pathEl)` where pathEl is the label), even though tag/role/name come
  from the hidden input. Only tag/role/name resolve through the pair.

- **The log record's `phases` is wall-time capture, not a contract field**
  (2026-09-20): `WingmanLogRecord.phases` ({attachMs, firstObserveMs,
  rounds:[{observeMs, jevMs, actMs, settleMs}]}) is instrumented in
  `loop.ts` around the existing seams (`driver.attach/observe/act/settle`,
  `askWithCost`). `runCheck` pushes one pseudo-round (observe+jev only). The
  shape test in `tests/loop.test.ts` is fail-first — keep it failing if the
  instrumentation is removed. Bench reads the same field into
  `wingman_phases`; do not add page text to either.

- **Result-text steering (`note`) did NOT stop interleaving** (2026-09-21):
  every non-done `wingman_do` result now carries the static `CONTINUE_LINE`
  (appended at the single `finish()` return path; `wingman_check` never gets
  it, and it serializes last so `confirm_token` stays primary on
  needs_confirmation). Re-measure on t9-long-chain (results 2026-09-21-0122,
  cap-proof) after DESCRIPTION v3 + note: wingman.calls went UP (2 → 6 and 2 →
  3) while raw browser tool calls stayed flat (20 → 24, 25 → 25) vs the
  2026-09-20-1709/1716 baseline. The calling model fragments into MORE
  wingman_do calls rather than fewer; the bench prompt's own "finish the task
  with the Playwright tools" clause on fallback is a candidate co-cause but
  fallback never fired. Numeric-opinionated tool text alone does not fix
  fragmentation — the next lever is the bench prompt or the loop's own
  continuation semantics, not more description text.

- **browse_step routing rides the ENTRY result too** (2026-09-21, WP-T1b):
  `runBrowse` (the routing pre-pass inside `runTool`) must attach its
  `routing` array onto whatever `runDoRounds` returns on the takeover-entry
  path — the round machinery builds fresh results and knows nothing of
  routing. § 3.17's rule is "every browse_step result that completed the
  routing ask carries `routing`", which includes done/needs_confirmation/
  budget-* ends of a takeover, and excludes only token continuations and
  results that return before the ask. The first gate run failed exactly here
  (done came back with no routing).

- **A KB-proof run poisons the scoped .build until you re-run build.mjs**
  (2026-09-21, WP-T1b): the known-bad proofs mutate `src/core/loop.ts`, build
  into `.build/<pkg>`, and restore the source — but `run-tests.mjs --dist
  .build/<pkg>` executes the COMPILED copy, so a green-looking re-run right
  after a restore still runs the mutated JS. Re-run
  `node scripts/build.mjs --out <dir> <entries>` after the last restore,
  before trusting the final gate line.


- **Chain mode, its memory, and its early-rule order** (forced-handoff spec
  § 5.5, 2026-09-26): `browse_step` with `steps` (after the § 5.5.1
  normalisation, goal-only included) runs chain mode; `step` alone runs the
  legacy takeover entry. The chain carries ONE clause per round
  (`clauseText(cursor)`), advances on `step_done`, and resumes from a
  module-level `chainMemory` keyed `[goal, clauses]` (values never in the key,
  key never logged) — a done call deletes its entry, every other end stores
  `{cursor, acts}`; this is why every chain test needs a unique goal text.
  The early rules run advance → error+recover → ready → right_page →
  action-none, and the whole-goal `done` Noul is NEVER read in chain mode. The
  `recover`/`ready` mechanical decisions (`back`/`reload`/`wait`) and the
  `scroll_to` → `scroll` fallback go straight to the single shared act site —
  no gate, no participation check. `finish()` is the single write-back point
  for the memory and for `progress`, so a result built anywhere still carries
  both.

- **The zero-step done guard is a defence, not a feature** (C4): a legacy
  entry round whose early `done` fires with `steps === 0` non-commits (retry
  once, then bounce `already-done`). The chain analogue is end-of-chain with
  zero acts. Round-1-done test harnesses must act first (`[S(), {done: .9}]`),
  or they hit this guard — the 2026-09-26 bounce-escalation edits did exactly
  that.

- **Capability negotiation is at two layers** (§ 5.5.6): the offered op set is
  `offeredOps(...) ∩ driverOps` (`driver.ops ?? LEGACY_OPS`), so an undeclared
  op is never ASKED; and a pick/token/Jev verb still not declared after the
  file-input conversion returns typed `fallback/unsupported-op` with zero
  acts, never a throw. Tests simulate a legacy driver by setting
  `driver.ops = LEGACY_OPS` on the FakeDriver.

- **Loop act/gate/policy/act call sites are pinned by grep** (§ 6 WP-B2 DONE):
  `grep -c "gateHeuristic(" src/core/loop.ts` = 2 (shadow + shared tail, both
  guarded `el ? gateHeuristic(…) : {hit:false}`), `evaluatePolicy(` = 2
  (runCheck + the round line guarded `pickRound ?`), `driver.act(` = 2
  (runTokenAction + the shared tail). A third call site of any of these is a
  fork of a pinned mechanism — extend the shared site instead.

- **Chain mode's obscured check was missing outside pick/entry rounds**
  (verifier fix, 2026-09-27): § 5.5.2 step 8 bullet 4 requires a committed
  element the enumerate-time probe already flags `obscured` to bounce
  `fallback/target-covered` (`why: 'target-covered'`, evidence, no retry)
  BEFORE any act is attempted. The original WP-B2 landing applied this only
  to the pick round and the legacy takeover-entry round; an ordinary
  (non-pick) chain-mode commit fell straight through to `decideTarget` and
  the shared act site, relying solely on the adapter's own live act-time
  `CoveredTargetError` check (status `blocked`/reason `covered-target`,
  which the § 5.5.5 table does correctly map to `FORCED_BLOCKED_LINE` — that
  part was fine) — but that check can miss elements the enumerate-time probe
  already knows are covered (different heuristics, different timing) and
  never returns the candidate evidence the caller needs to retry with
  `pick`. Fixed in the chain merge-decide block right after `decideTarget`
  returns a non-bounds result, before the offer/first-commit check (§ 5.5.2
  step 8 precedes step 10). Regression test: `T6b` in `chain.test.ts` (proven
  to fail with the check disabled via a temporary flag flip, per the
  KB-proof discipline).
- **`applyChainEarly`'s not-ready `settleOnly` branch used to fire-and-forget
  `driver.settle`** (verifier fix, 2026-09-27): `void driver.settle(...)` let
  the loop start the next round's observe before settle actually finished —
  the only unaWaited settle call site in the file. `applyChainEarly` is now
  `async` and both its call sites `await` it; the settle call itself is
  `await`ed like every other settle site.
- **§ 5.5.7 state-size sizing measures `JSON.stringify(state).length` PLUS the
  serialized length of the single longest question in the built request**
  (orchestrator decision, 2026-09-27, resolving the earlier flagged
  deviation): TypeSafe documents Jev's real limit as "32k tokens for `state`
  plus the longest question" (docs.typesafe.ai/models.md), so that is what
  `withStateSize`/`requestSize` in `loop.ts` measure against
  `budgets.max_state_chars` — not bare `state` alone (misses the element list
  riding in the target question's criteria) and not the whole request (whose
  ~4900 chars of fixed per-round question overhead made the documented 2000
  floor dead for chain mode). `tests/chain.test.ts` T22's cut leg now pins the
  spec's `max_state_chars: 2000` with the exact arithmetic in a comment; T22b
  pins the regression both ways (fixed overhead alone never flags; state +
  longest question over the limit still does).
- **Chain mode's `decideTarget` no-value already wraps through `chainNonCommit`
  for every verb, including `navigate`** (checked 2026-09-27, cloud-run
  finding on `tests/chain-e2e.test.ts` E3 that turned out to be a test bug,
  not a src gap): the chain merge-decide block (`loop.ts`, the
  `decide.result` branch after `decideTarget(` in runDoRounds' chain step 8;
  ~2960-2976 at f39aa12 — the old ~2190-2206 cite drifted) checks
  `decide.bounds` / `decide.keyMissing` / `decide.result.reason === 'no-value'`
  on every `decideTarget` result before falling through to `no-match` — this
  already covers `fill`'s (~1091/1097), `select`'s (~1122), `navigate`'s
  (~1145) and `upload`'s (~1162) no-value returns uniformly. `tests/chain.test.ts`
  T9 already exercises navigate's `urlAnswer: 'none'` case and passes today,
  confirming this. If a chain e2e test reports status `ambiguous` where
  `fallback/step-uncertain/no-value` was expected, suspect the TEST first —
  in particular a shared browser tab left on the wrong page: `runTool`
  (not runDoRounds — corrected 2026-10-01) filters `visiblePages` by
  `url_match` (loop.ts ~1992-2008 at f39aa12) before any mode runs, and returns
  `ambiguous`/`tab-ambiguous` on zero matches, which looks exactly like a
  leaked `ambiguous` from `decideTarget` unless you check the `reason` field.
  This is what `chain-e2e.test.ts` E3 hit: its bad-urlAnswer loop reused the
  same tab and `url_match` after a preceding `good` run had navigated that tab
  away — fixed by navigating the tab back before the loop (see
  `chain-e2e.test.ts`'s `gotoFixture` helper).
- **`jev-error` is a catch-all — timeouts read like API defects** (2026-09-21,
  diagnosis of 2026-09-21-1311 browse fallbacks): `askFailReason`
  (src/core/loop.ts, module-level; ~:830 at f39aa12, the old :274 cite drifted) maps every ask error except `no-key`/`circuit-open`
  to `jev-error`, so a client timeout and an HTTP 422 log identically.
  Discriminate via `phases.rounds[].jevMs`: a timeout sits at the full
  `jev_timeout_ms` budget (default 10_000, src/contract/constants.ts) with
  `input_tokens: 0`; an HTTP failure returns fast. The 13:11 run's 3×
  jev-error were exactly this — 10,006–10,022 ms each, then ~1 s successes on
  the same batched routing ask 7 minutes later: transient API latency, not
  payload size or budget. Also: no circuit breaker is wired in the server
  (`lib.ts` uses `createDefaultAsk`, which has none; nothing produces
  `circuit-open`), and all three ask paths share one `askWithCost` timeout
  pin — browse_step and wingman_do never differ.
- **Outcome evidence + no-progress guard (2026-09-27/28, WP-outcome-evidence):**
  `buildState`'s `history` entries are now `HistoryEntry` (`loop.ts` ~228-241:
  `verb, label, path?, fingerprint?, before?, result?`), not the old
  `{verb,label}` pair. `before` is a verb-specific signal captured from the
  round's obs BEFORE the act (`outcomeSignal`, ~248-256): element-state verbs
  (`fill`/`select`/`check`/`uncheck`) read `el.state` directly; every other
  el-targeted verb (click-family) falls back to a page-level `url\u0000title`
  signal — zero new driver calls either way. `annotateLastOutcome` (~265-295)
  is the ONE choke point: called right after `observeTimed` at the top of the
  main round loop (~1927), it fills the LAST history entry's `result` from
  THIS round's fresh obs, by re-finding the same `path`/`fingerprint`
  (`'element gone'` if it can't). It only ever touches the last entry — each
  gets annotated exactly once, on the round right after its act — so it's
  safe to call unconditionally every round including round 1 (no-op on empty
  history). `isNoProgress` (~299-311) is the literal spec check: this round's
  `decision` repeats the last act's exact `(verb, path)` AND `result ===
  before` (no observed change) — checked at the ONE shared decision site
  (`if (decision !== null) {` ~2486, before the gate), so it covers chain,
  legacy and pick decisions alike without duplicating logic per mode.
  `buildState` maps history to `{verb, label, result?}` only — `path`,
  `fingerprint` and `before` never reach Jev, and `result` (which can equal a
  bound value, e.g. a select's chosen option text) passes through the
  existing whole-`raw`-object `redactDeep`, so no separate redaction call was
  needed. **Gotcha for round-shape tests:** never assign a `PhaseRound`
  telemetry field (`historyResult`, `actionP`, …) unconditionally when the
  source value might be `undefined` — `{k: undefined}` is NOT deep-equal to
  `{}` under `assert.deepStrictEqual` (Node keeps the key), and
  `tests/loop.test.ts`'s "log record carries the phases breakdown" test pins
  the exact round shape; guard every optional-telemetry assignment with an
  explicit `!== undefined` check first. New `Reason` value `no-progress`
  (`contract/types.ts` REASONS.fallback) reuses `FORCED_BOUNCE_LINE` /
  `BROWSE_STEP_CALLER_LINE` in `forcedNote`/`finish` rather than a new note
  string (judgment call, flagged in the build report — no note text was
  specified for it). `WingmanLogRecord` gained a top-level `step_review:
  {why, candidates: count}` (labels/values never logged, only the count) so
  bench's `handoffRecordsFromLog` can parse a why-breakdown from log.jsonl —
  `bench/run.ts`'s spec text said "from each browse_step result," but the
  parser only ever reads log lines, so the log record is the actual wire.
  **Click-family signal widened (2026-09-28, operator: a same-url/title click
  that visibly changes the page — e.g. the-internet.herokuapp.com's "click
  Add Element twice," which appends a Delete button each time — must not read
  as unchanged):** `pageSignal` (~275-279) is url+title+`shortHash(obs.text)`
  +`elements.length`+(el's own `state`+`obscured` when present), not just
  url+title. **`isNoProgress` has two branches, not one comparison** (~327+):
  element-state verbs (`fill`/`select`/`check`/`uncheck`) compare
  `result === before` directly (both are `elementStateSignal` output, so
  'empty'==='empty' is meaningful); click-family verbs compare `result ===
  'no visible change'` — `annotateLastOutcome` already reduces their raw
  `pageSignal` diff to a verdict word before storing it, so comparing that
  word against the RAW `before` signal would never match (a word never
  equals a hash string) and silently disabled the guard for every click.
  **The guard's placement matters, not just its condition:** it sits AFTER
  the budget-steps/budget-time checks, not before — a `max_steps: 1` call
  that repeats the same act is a REAL pre-existing pattern in
  `tests/loop.test.ts` and `tests/bounce-escalation.test.ts` (deliberately
  exhausting a tiny explicit budget), and if no-progress is checked first it
  wins over budget-steps on the round that would exhaust it, breaking those
  pinned reasons. Checking budgets first makes budget-steps win when the call
  would end anyway either way, and lets no-progress only catch a repeat that
  would otherwise run indefinitely. **Scope rules (orchestrator decision,
  2026-09-28), both implemented:** (1) the guard resets on a clause/step
  advance — `HistoryEntry.stepKey` (`c<cursor>` in chain mode, else
  `'single'` for a legacy browse_step entry or a wingman_do call, which have
  no clause structure) must match between the last act and the current
  decision, checked in `isNoProgress`'s third parameter, computed once per
  round as `currentStepKey` right before the guard call (~2602) and reused
  at the history push a few lines later. (2) a round whose decision fell
  through from an error+recover `'continue'` is exempt outright — the
  per-round `recoveredThisRound` flag (reset to `false` at the top of every
  round, ~2016), set at BOTH `decideEarly`'s and `runChainEarly`'s
  `'continue'`-fallthrough sites. `decideEarly` and `runTokenAction` are NOT
  in the same nested-function scope as `chain`/`recoveredThisRound` (they're
  siblings inside `runTool`, not nested inside the round-loop closure) — you
  cannot just reach in and mutate the flag from inside them; `decideEarly`
  instead returns a new `{ recovered: true }` variant (added to its return
  union) that both of its call sites translate into `recoveredThisRound =
  true` themselves, and `runTokenAction` takes `stepKey` as an explicit
  parameter rather than computing `chain ? ... : 'single'` internally. This
  fixed `tests/chain.test.ts` T2, T25 and part of T23 (its `h2` sub-case).
  **T23's `h` sub-case (orchestrator-approved test fix, 2026-09-28 —
  no third scope rule):** it scripted `[CS({right_page:0.2}),
  CS({right_page:0.9}), ADV()]` for ONE clause — round 1's low `right_page`
  (below `WRONG_PAGE_MAX`) does not block the act, so both rounds committed
  the identical click on an identical static fixture within the SAME step,
  no recover involved — a genuine no-progress match by both rules above, not
  a bug in either. It was a test artifact (`CS()`'s default click fixture
  reused across rounds to test the wrong-page COUNTER, not meant as a
  deliberate repeat): fixed by giving round 2's observation different `text`
  (as if the page settled after round 1's click), so the repeat is no longer
  a literal zero-change one; the right_page-counter assertions are
  untouched.
- **Verifier findings, 2026-09-28 (both fixed, both confirmed by a before/
  after repro — see `bench/forced-verdict.ts` review notes for method):**
  (1) **Secrecy gap, `cur.historyResult` (loop.ts, top of the round loop):**
  the WingmanLogRecord telemetry field was assigned straight from
  `history[...].result` — the SAME raw signal `buildState` redacts before it
  reaches Jev — but this telemetry write bypassed `buildState`/`redactDeep`
  entirely, so a `select`'s `'selected: <raw option text>'` reached
  `log.jsonl` un-redacted whenever the option text equaled a bound value.
  Every other `result` shape (`filled`/`empty`/`checked`/`unchecked`/`page
  changed`/`no visible change`/`element gone`) is a fixed string with
  nothing to leak — `select` was the one path with page-derived text in the
  signal. Fixed by wrapping the assignment in `redactValues(lastResult,
  values)` (already imported in loop.ts). Repro'd with a standalone
  `.build/` script before and after the fix (not covered by any existing
  test — nothing asserts on `WingmanLogRecord.phases.rounds[].historyResult`
  today). **Any future field added to `PhaseRound`/`WingmanLogRecord` that
  can carry page-derived text needs the same explicit redaction — the
  per-round telemetry object is NOT auto-redacted the way `buildState`'s
  `raw` object is.** (2) **The T23 `h`-sub-case fixture-collision class
  above is not unique to `tests/chain.test.ts`:** `tests/takeover.test.ts`
  had three PRE-EXISTING, previously-green tests (`#27`/`#29`/`#36` — the
  continuation two-part-rule and top-candidate-margin tests) that reuse a
  single static observation across two rounds while the script intentionally
  repeats the same click on `e1` in round 2 to exercise unrelated
  threshold/margin logic — the same shape as T23's `h` case, just in a
  different file the original build didn't re-run. All three now correctly
  read as no-progress under the new guard and were fixed the same way (a
  second observation entry with different `text`, so FakeDriver's "repeat
  the last entry when exhausted" stops making round 2 a literal zero-change
  repeat). **Any test that scripts two consecutive rounds acting on the same
  (verb, element) with a single static observation is now a no-progress
  guard trip by construction** — auditing for this pattern across the whole
  suite (not just the file a change set names) is required work for any
  future change to `isNoProgress`/`annotateLastOutcome`, not optional
  follow-up.

- **A `select` option's `value` and its `elementStateSignal` LABEL are two
  different strings — never compare one against the other** (verifier,
  2026-09-28, outcome-evidence stepDoneWithEvidence bar). `ElementRecord.options`
  is `Array<{value, label}>`; the decision/act path (`decideVerbAndValue`,
  `resolveOption`) resolves and acts on the option's `value` attribute
  (`decision.optionValue` / `PendingAction.optionValue`), but
  `elementStateSignal('select', el)` reads back `el.state.selected`, which the
  driver reports as the option's raw LABEL text (see the redaction bullet
  above: `'selected: <raw option text>'`). On any `<option value="v">label</option>`
  where `v !== label`, `result === \`selected: ${optionValue}\`` would never
  match even for a fully correct selection. `hasStepEvidence`'s select branch
  (loop.ts) instead resolves the intended LABEL at the act site —
  `el.options?.find(o => o.value === optionValue)?.label` — and stores it as
  `HistoryEntry.intendedLabel` for later comparison against `result`. Any
  future code that wants to verify "did the act land on what was asked" for a
  `select` must go through this same label lookup, never compare `optionValue`
  directly against `result`.

- **Deterministic repeat-count evidence, WP-count (2026-09-28, r8 click-count
  fix):** a step naming an explicit count ("click the Add button twice") now
  has its OWN evidence bar, independent of `hasStepEvidence`/stepDoneP —
  click-family is deliberately excluded from `hasStepEvidence` (see above),
  and Jev's `stepDoneP`/`done` Noul never crosses threshold reliably on a
  repeated click (r8 evidence: 24 clicks/call, stepDoneP stuck 0.11-0.71,
  `historyResult` always 'page changed'). `parseRepeatCount` (loop.ts, exported
  for unit testing only) parses once/twice/thrice/"N times" (digit 1-50 or
  word two..ten), returning `undefined` on zero or MORE THAN ONE count
  expression in the text (ambiguous) — no general number parsing.
  `hasRepeatCountEvidence` walks the trailing CONTIGUOUS run of history
  entries backward from the last act: same `stepKey`, click-family verb
  (`click`/`dblclick`/`press`, `CLICK_FAMILY_OPS`), `result === 'page
  changed'`, and the SAME target (`path`, else `label`) as the last entry —
  any break ends the run, so an intervening different act or target resets
  the count to zero, never partial credit. Wired as an extra OR branch in
  chain mode's rule 3 (`runChainEarly`, no threshold at all on this branch —
  the observed count IS the evidence) and as a new rule 3b in legacy/
  wingman_do's `decideEarly`, which needed two new parameters (`history`,
  `stepText`) since it is a SIBLING of `runDoRounds` inside `runTool`, not
  nested inside it, so it has no closure access to either — `stepText` is
  `entry.step` for legacy browse_step ONLY, and `undefined` for wingman_do
  (verifier fix, 2026-09-28: `doInput.goal` is a whole-task description that
  may legitimately name several actions in sequence — bench t9-long-chain's
  goal embeds "...click the Add Element button twice; open Inputs and type
  the amount..." and is run via a single wingman_do call per the wingman_do
  route prompt, "call it ONCE with the full goal". Reading a count word
  anywhere in that whole-goal text and checking it against
  `HistoryEntry.stepKey`'s `'single'` — the entire call's history — ended the
  WHOLE goal done/goal-met the moment the embedded "twice" clause's two
  clicks landed, abandoning every clause after it, even though Jev's own
  `done` noul never crossed threshold. A legacy browse_step `step` has no
  such multi-clause risk: it is documented as one atomic instruction, and
  chain mode already scopes the same rule correctly per clause via
  `steps`/`clauses`.). Telemetry:
  `PhaseRound.countEvidence`/`WingmanLogRecord.phases.rounds[].countEvidence`
  (optional, set only on the firing round, to the count) — mirrored in both
  `loop.ts` and `contract/types.ts`; `phaseAcc.rounds` is passed straight
  through into the log record, so no separate log-record field mapping was
  needed. **Test-fixture trap found while proving WP-count-e** (two clicks on
  different targets must NOT satisfy a count): an ask that clicks e1 on round
  1 and e2 on every later round still produces two CONSECUTIVE e2 clicks by
  round 3, trivially satisfying `hasRepeatCountEvidence` for the wrong reason
  — the alternation must be strict (`round % 2`), not "first round differs
  from the rest," or the test passes for a reason unrelated to what it claims
  to prove.

- **Bare-click evidence + same-target repeat guard, WP-click (2026-09-28,
  r10):** a click step with NO count word (where `parseRepeatCount` returns
  `undefined`, so `hasRepeatCountEvidence` can't fire) now has its own
  evidence bar. `hasBareClickEvidence(history, currentStepKey)` is true when
  the last SIGNAL-CARRYING history entry (`lastEvidenceEntry`, r11 Q3: reads
  through waits/scrolls) is on the current step, has a click-family verb
  (`CLICK_FAMILY_OPS`), and `result` is `'page changed'` OR `'element gone'`
  (r11 Q3 — a link click that navigates almost always reads `element gone`,
  since the link is absent on the new page; corrected 2026-10-01, r14
  deep-plan) — one observed change is enough. Advance bar: chain mode's `runChainEarly` rule 3 gets an extra
  OR branch, `stepDoneP >= THRESHOLDS.stepDoneWithEvidence (0.5) &&
  bareClickEvidence`. Legacy browse_step: `decideEarly` rule 3b gets a
  sibling branch on the `done` noul `>= THRESHOLDS.stepDoneWithEvidence`
  (0.5; NOT `THRESHOLDS.done`, which is 0.85 and already rule 3). Repeat
  guard (act site, right after the no-progress guard): on a count-less step
  that already has bare-click evidence, a decision to click the SAME target
  again (`path`, else `label`) hands back `fallback`/`step-uncertain` with
  `step_review.why: 'repeat'` instead of acting — exempt on a
  recovered-this-round round like the no-progress guard. Scope: chain clause
  and legacy browse_step `step` only, never the wingman_do goal (same
  multi-clause reason as WP-count's rule 3b scoping). Telemetry:
  `PhaseRound.clickEvidence` (firing round only), `PhaseRound.step_text`
  (every browse_step round, redacted via `redactValues`, capped 300), and
  `WingmanLogRecord.step_texts_start` (chain mode, redacted first clause) —
  mirrored in `contract/types.ts`; chain.test T17's log-key allowlist
  includes `step_texts_start`. Same ready-gate change in this batch:
  `THRESHOLDS.ready` 0.5 -> 0.3 (r9 distribution, see constants.ts). **Test
  trap:** any test that clicks the same target on two consecutive rounds of
  a count-less browse_step with a page-changing observation now trips the
  repeat guard by construction (chain.test T23 was moved to a second target
  for this reason).

- **Stuck recover (r13, 2026-10-01):** a chain clause's would-be BOUNCE
  (`chainNonCommit`'s bounce branch and `applyChainEarly`'s `bounceWrongPage`)
  first tries `stuckEligible(why)` (loop.ts, D1 rules 1-9): `why` in
  no-match/low-confidence/wrong-page, execute participation, a FRESH clause
  (`chain.cursorActed === false` - set by any element-targeted act or token
  act, never by navigate/wait/scroll), once per clause (`stuckUsed`/`stuckPending`),
  `recoverActs < RECOVER_MAX_PER_CLAUSE`, steps and time left, the merged
  answers' action in `STUCK_VERBS` (click/navigate/back) and target `none` >=
  `STUCK_NONE_MIN` (0.8), and a destination (`back` offered, or `navigate`
  with a url binding). When eligible it sets `chain.stuckPending` and
  continues; the NEXT round is a deferred stuck round (after the pick block)
  that asks ONE `buildRecoverRequest` question (same id `recover`, stuck
  wording, criteria `back` / `open_<name>` / `give-up`) and yields a
  mechanical back/navigate decision for the shared act tail, or the deferred
  bounce (`stuckBounce`, identical to the original bounce). A stuck navigate
  gets `HistoryEntry.stuckRecover` so `hasStepEvidence` ignores it unless the
  clause names that binding; `cursorActed`/`stuckTried` persist in chain
  memory. `NoHistoryError` (a typed `ActFailedError`) from a stuck `back`
  is the deferred bounce; every other act error logs `act_error`
  (`describeActError`: first/last message line, cut at `<`, quotes stripped,
  values redacted; non-Wingman errors carry only the class name). Test trap:
  a fresh chain clause scripted action click/navigate/back with target `none`
  >= 0.8 now takes one extra (stuck) ask before bouncing.
  **Verifier-wave amendments (2026-10-01):** (1) `sameDocument` (the "already on
  this page" filter for `open_<name>`) compares origin + pathname + query and
  IGNORES only the hash — the spec's pathname-only cut hid query-routed hubs
  (`/?view=home`), full-href equality offered the current page after an
  `href="#"` click; both pinned by T-stuck-query-hub. (2) D1 guard 1 is now
  enforced, not just described: `chain.retryNone` records that the look which
  consumed the clause's retry was itself a confident none, and `stuckEligible`
  requires it (retry on), so an ambiguous first look + a none never recovers.
  (3) A failed stuck ask returns `fallback/jev-error` (spec-literal), which
  forced mode maps to the RESUME line, not the bounce line — one extra hop on
  a transient Jev failure; `stuckUsed` is already stored so the resume call
  will not re-ask. (4) `bindingsInStep` is a substring match, so D6's
  "clause names the binding" test treats any clause containing the binding
  name (e.g. "open the homepage" with binding `home`) as naming it.
