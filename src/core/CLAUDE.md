# src/core — loop, evidence & questions internals

## Round kinds & telemetry

- **`PhaseRound.kind` (r18 D3) is explicit-site-first; `mk()`'s `??=` is only
  the default.** The shared act tail and `runTokenAction` set `'act'`/`'wait'`
  by the executed verb, `applyChainEarly`'s advance branch sets
  `bucket.kind = 'advance'` (so the final-clause advance round reads
  `'advance'`, not the `'done'` its `mk()` would derive), the round-top
  dialog answer sets `'act'`, and the four entry goal-met/no-action retry
  continues set `'bounce'` — those rounds `continue` and never reach `mk()`,
  so without the explicit write they would be kindless forever.
  `kindForResult(status)` (exported, pinned exactly in loop.test.ts) maps
  done->`'done'`, error/login->`'error'`, everything else ->`'bounce'`.
  Rounds that exit no named way (settleOnly, entry-uncertainty retries,
  stuck deferrals) legitimately LACK the key — bench buckets them `'other'`;
  do not "fix" that by widening `mk()` or inventing a kind at those sites.
- **The log record's `phases` is wall-time capture, not a contract field**:
  `WingmanLogRecord.phases` ({attachMs, firstObserveMs,
  rounds:[{observeMs, jevMs, actMs, settleMs}]}) instruments the existing
  seams (`driver.attach/observe/act/settle`, `askWithCost`); `runCheck`
  pushes one pseudo-round (observe+jev only). The shape test in
  `tests/loop.test.ts` is fail-first. Bench reads the same field into
  `wingman_phases`; do not add page text to either, except the r24b
  label/title fields under `deps.logLabels`, which `bench/run.ts`'s
  `mcpConfigFor` switches on via `WINGMAN_LOG_LABELS=1`.
- **Optional telemetry fields must never be assigned when the source value
  is undefined**: `assert.deepStrictEqual` treats `{k: undefined}` as
  different from `{}` (Node keeps the key), and loop.test.ts pins the exact
  round shape — guard with `!== undefined`.
- **Any future `PhaseRound`/`WingmanLogRecord` field that can carry
  page-derived text needs explicit redaction** — the per-round telemetry
  object is NOT auto-redacted the way `buildState`'s `raw` object is.
  Proven leak (fixed): `cur.historyResult` was assigned straight from the
  raw history signal, so a `select`'s `'selected: <raw option text>'`
  reached `log.jsonl` un-redacted whenever the option text equaled a bound
  value (every other `result` shape is a fixed string with nothing to
  leak). Fixed by wrapping the assignment in `redactValues(lastResult,
  values)`. The r24b label/title fields use `cut40`/`capLabel` over
  `redactValues`, in that order (redact first, then cut).
- **`WingmanLogRecord.step_review: {why, candidates: count}`** (labels/
  values never logged, only the count; the round `cands[].label` exists
  only under the flag) exists so bench's
  `handoffRecordsFromLog` can parse a why-breakdown — the parser only ever
  reads log lines, so the log record is the actual wire.

## Config switches

- **The irreversible gate is config-switchable** (Q6 flip 2026-09-26):
  `config.json` `gate.mode` accepts `"off"` (default since 0.3.0) and
  `"confirm"` (opt-in). Read it only through `gateModeOf()` — `'confirm'`
  iff the config says so explicitly; a config without a `gate` key runs
  off, and every test that wants a token writes `gate: { mode: 'confirm' }`
  itself.
- **The sensitive-surface policy is config-switchable, OFF by default**
  (flipped 2026-09-22 by operator decision): `policy.mode` accepts `"off"`
  (the shipped default — page content goes to TypeSafe on every page,
  including sensitive ones) and `"enforce"` (opt-in fail-closed:
  `classifyUrl`/`classifySignals` report sensitive and the host/page-signal
  fallback to the caller's browser tools fires). Read via `policyModeOf()`
  (config.ts), which returns `'off'` unless the config explicitly says
  `'enforce'` — a pre-key config runs off. The classifier defaults
  (`DEFAULT_POLICY_MODE` in constants.ts) flipped with it, so
  `classifyUrl(url)` with no mode arg is non-sensitive; tests pinning
  enforce semantics must pass `'enforce'` explicitly. The irreversible
  gate, value withholding and confirm tokens are unaffected.

## page-scripts: enumerate & verify

- **The proxy rule lives twice, on purpose.** `enumerate` (buildRecord) and
  `verify` each contain an inline copy of the styled-control proxy
  detection (hidden checkbox/radio + visible label). This duplication is
  required by the purity contract: every `build*Expression` is stringified
  via `Function.toString()` and must be self-contained — no shared module
  helpers. Change proxy detection on one side and mirror it in the other,
  or the enumerate/verify contract silently breaks (wave-4 incident: verify
  compared an input's fingerprint against the label at the record's path
  and always returned `mismatch`, so every adapter threw StaleElementError
  on styled checkboxes/radios).
- **verify()'s position check stays on the label.** For proxied controls
  the fingerprint's x/y come from the LABEL's rect (enumerate records
  `rectOf(pathEl)` where pathEl is the label), even though tag/role/name
  come from the hidden input. Only tag/role/name resolve through the pair.
- **KB flags ride `var` inside the stringified function body**, not
  module-level `const` — the mutant runner's anchor matches both
  declarations (`const|var KB_X = false;`). `KB_HIDDEN_SIBLING` lives
  INSIDE `enumerate`'s function body so it stringifies along.

## Notes & routing

- **Result-text steering (`note`) did NOT stop interleaving**: every
  non-done `wingman_do` result except sensitive-*/unsupported-page fallbacks (SENSITIVE_LINE / FORCED_SENSITIVE_LINE) and invalid-input carries the static `CONTINUE_LINE`
  (appended at the single `finish()` return path; `wingman_check` never
  gets it, and it serializes last so `confirm_token` stays primary on
  needs_confirmation). Re-measure after DESCRIPTION v3 + note showed
  wingman.calls going UP while raw browser tool calls stayed flat —
  numeric-opinionated tool text alone does not fix fragmentation.
- **browse_step has no routing pre-pass** (removed 2026-09-21, 16081ef): entry is first-round-decides via runDoRounds (§ 3.19); `WingmanResult.routing` and `buildRoutingRequest` are gone; bounce evidence rides `step_review`.

## Chain mode

- **Chain mode, its memory, and its early-rule order** (forced-handoff spec
  § 5.5): `browse_step` with `steps` (after the § 5.5.1 normalisation,
  goal-only included) runs chain mode; `step` alone runs the legacy
  takeover entry. The chain carries ONE clause per round
  (`clauseText(cursor)`), advances on `step_done`, and resumes from a
  module-level `chainMemory` keyed `[goal, clauses]` (values never in the
  key, key never logged) — a done call deletes its entry, every other end
  stores `{cursor, acts, ...}` (plus cursorActed/stuckTried/clicks/loginSeen/postAction/responsePage); this is why every chain test needs a unique
  goal text. The early rules run advance -> error+recover -> ready ->
  right_page -> action-none, and the whole-goal `done` Noul is NEVER read
  in chain mode. The `recover`/`ready` mechanical decisions
  (`back`/`reload`/`wait`) and the `scroll_to` -> `scroll` fallback go
  straight to the single shared act site — no gate, no participation
  check. `finish()` is the single write-back point for the memory and for
  `progress`, so a result built anywhere still carries both.
- **The zero-step done guard is a defence, not a feature** (C4): a legacy
  entry round whose early `done` fires with `steps === 0` non-commits
  (retry once, then bounce `already-done`). The chain analogue is
  end-of-chain with zero acts. Round-1-done test harnesses must act first
  (`[S(), {done: .9}]`).
- **Capability negotiation is at two layers** (§ 5.5.6): the offered op
  set is `offeredOps(...) ∩ driverOps` (`driver.ops ?? LEGACY_OPS`), so an
  undeclared op is never ASKED; and a pick/token/Jev verb still not
  declared after the file-input conversion returns typed
  `fallback/unsupported-op` with zero acts, never a throw. Tests simulate
  a legacy driver by setting `driver.ops = LEGACY_OPS`.
- **Loop act/gate/policy call sites are pinned by grep** (§ 6 WP-B2):
  `grep -c "gateHeuristic(" src/core/loop.ts` = 2 (shadow + shared tail,
  both guarded `el ? gateHeuristic(…) : {hit:false}`), `evaluatePolicy(` =
  2 (runCheck + the round line guarded `pickRound ?`), `driver.act(` = 3
  (runTokenAction + the shared tail + that tail's r22 F-1 nav-shaped retry). A third call site of any of these is
  a fork of a pinned mechanism — extend the shared site instead.
- **Chain mode's obscured check applies to EVERY commit, not just
  pick/entry rounds**: § 5.5.2 step 8 bullet 4 requires a committed element
  the enumerate-time probe already flags `obscured` to bounce
  `fallback/target-covered` (`why: 'target-covered'`, evidence, no retry)
  BEFORE any act. The original landing applied it only to the pick round
  and the legacy takeover-entry round; an ordinary chain-mode commit fell
  through to the shared act site, relying solely on the adapter's live
  act-time `CoveredTargetError` — which can miss elements the
  enumerate-time probe already knows are covered (different heuristics,
  different timing) and never returns the candidate evidence the caller
  needs to retry with `pick`. Fixed in the chain merge-decide block right
  after `decideTarget` returns a non-bounds result, before the
  offer/first-commit check. Regression test: `T6b` in `chain.test.ts`.
- **`applyChainEarly`'s not-ready `settleOnly` branch must NOT
  fire-and-forget `driver.settle`**: `void driver.settle(...)` let the
  loop start the next round's observe before settle finished — the only
  unaWaited settle call site in the file. `applyChainEarly` is `async` and
  both its call sites `await` it.
- **§ 5.5.7 state-size sizing measures `JSON.stringify(state).length` PLUS
  the serialized length of the single longest question in the built
  request**: TypeSafe documents Jev's real limit as "32k tokens for
  `state` plus the longest question" (docs.typesafe.ai/models.md), so that
  is what `withStateSize`/`requestSize` in `loop.ts` measure against
  `budgets.max_state_chars` — not bare `state` alone (misses the element
  list riding in the target question's criteria) and not the whole request
  (whose ~4900 chars of fixed per-round question overhead made the
  documented 2000 floor dead for chain mode). T22's cut leg pins the spec
  arithmetic; T22b pins the regression both ways.
- **Chain mode's `decideTarget` no-value already wraps through
  `chainNonCommit` for every verb, including `navigate`** (a cloud-run
  finding that turned out to be a test bug, not a src gap): the chain
  merge-decide block checks `decide.bounds` / `decide.keyMissing` /
  `decide.result.reason === 'no-value'` on every `decideTarget` result
  before falling through to `no-match` — covering `fill`/`select`/
  `navigate`/`upload` no-value returns uniformly. If a chain e2e test
  reports status `ambiguous` where `fallback/step-uncertain/no-value` was
  expected, suspect the TEST first — in particular a shared browser tab
  left on the wrong page: `runTool` (not runDoRounds) filters
  `visiblePages` by `url_match` before any mode runs and returns
  `ambiguous`/`tab-ambiguous` on zero matches, which looks exactly like a
  leaked `ambiguous` from `decideTarget` unless you check the `reason`
  field (chain-e2e E3 hit this; fixed by navigating the tab back first —
  see its `gotoFixture` helper).
- **`jev-error` is a catch-all — timeouts read like API defects**:
  `askFailReason` (loop.ts, module-level) maps every ask error except
  `no-key`/`circuit-open` to `jev-error`, so a client timeout and an HTTP
  422 log identically. Discriminate via `phases.rounds[].jevMs`: a timeout
  sits at the full `jev_timeout_ms` budget (default 10_000,
  src/contract/constants.ts) with `input_tokens: 0`; an HTTP failure
  returns fast. No circuit breaker is wired in the server (`lib.ts` uses
  `createDefaultAsk`; nothing produces `circuit-open`), and all three ask
  paths share one `askWithCost` timeout pin — browse_step and wingman_do
  never differ.

## r23: the locator-wait nav-shaped family + the go-back lottery (2026-10-05)

- **Since noWaitAfter (r21 P-1a) removed Playwright's post-click navigation
  wait, the live nav-shaped act failure text is the LOCATOR wait:
  `locator.click: Timeout 3000ms exceeded.` — the pointer never dispatched.**
  `NAV_SHAPED_ACT_ERROR_RE` now matches `locator\.<op>: Timeout <n>ms
  exceeded` (composes into `KB_ACT_NAV_RETRY`, no new flag; the r23 pins in
  loop.test.ts are the flip tooth). Every recorded occurrence (r22 record 11
  live, r23 records 13/16 local — local fixture server, so never "site
  latency") sat on the round immediately after a back/navigate act. Bounds:
  one retry behind `PRE_CLICK_SETTLE_MS`, exactly 2 sends; a genuinely stale
  element then surfaces StaleElementError (error/stale-element), so the
  retry recovers the transient flavor and RECLASSIFIES the stale one — it
  never swallows. Corollary: **the r13 sanitize fixtures V1/V2 messages ARE
  this family** — `T-act-error-log` (chain.test.ts) must fail BOTH sends
  (persistent act override, not one-shot `failNextAct`) to keep testing the
  error path; a one-shot fail now yields a fallback end and the pin reds.
- **The t9 go-back transition rides a stuck-arm lottery (diagnosed r23,
  NOT fixed — threshold design, pinned deliberately).** The t9 goal text
  carries no go-back clauses, so every page-to-page transition back to the
  index depends on the stuck mechanism, which arms only when Jev's
  target-`none` grade >= `STUCK_NONE_MIN` (0.8) on BOTH looks (`retryNone`
  + rule 7-8). That grade is bimodal across runs on the IDENTICAL page and
  state: 0.89-0.96 in every healthy trace (r19 live x2, r22 local x2) vs
  0.76/0.76 in both r23 t9 forced runs — a sub-0.8 roll bounces the call,
  the caller restructures the chain (7 -> 5 -> 4 steps), and the 8-call
  fragmentation follows. Loop code is identical between the healthy and
  regressed runs at this site. `T-stuck-none-bar` ("0.79 does not") pins
  the bar on purpose, so relaxing it (e.g. arm on two consecutive
  none-CHOICE looks below the bar, keeping the ambiguous-exclusion) is a
  threshold-design decision for the orchestrator, not a builder edit.
  Related non-fixes, for the record: F-2's resume-skip does not apply to
  these restructures (they follow no-match bounces on an UNACTED cursor
  clause, `cursorActed: false` — `resumeSkippedPostAction` correctly never
  fired); and the post-back observe is NOT stale (probe: driver back +
  settle + observe returns the fresh document every time), so the
  locator-timeout was never a pre-swap observation in the recorded runs.
- **Fail-first proof pattern for a regex-widening with no KB flag**: build
  the scoped dist, run the new pins green, patch the ONE compiled line in
  the scoped dist back to the pre-fix expression (the documented
  dist-patch diagnostic pattern), re-run the pins (red = fail-first), then
  re-run the scoped build to un-poison. Proven for the RE extension above:
  2/2 red pre-fix, 2/2 green after restore.

## Evidence & guards

- **Outcome evidence + no-progress guard (WP-outcome-evidence):**
  `buildState`'s `history` entries are `HistoryEntry` (`verb, label, path?,
  fingerprint?, before?, result?`). `before` is a verb-specific signal
  captured from the round's obs BEFORE the act (`outcomeSignal`):
  element-state verbs (`fill`/`select`/`check`/`uncheck`) read `el.state`
  directly; every other el-targeted verb (click-family) falls back to a
  page-level signal — zero new driver calls either way.
  `annotateLastOutcome` is the ONE choke point: called right after
  `observeTimed` at the top of the main round loop, it fills the LAST
  history entry's `result` from THIS round's fresh obs, by re-finding the
  same `path`/`fingerprint` (`'element gone'` if it can't). It only ever
  touches the last entry — each annotated exactly once, on the round right
  after its act — so it's safe to call unconditionally every round
  including round 1. `isNoProgress` is the literal spec check: this
  round's `decision` repeats the last act's exact `(verb, path)` AND
  `result === before` — checked at the ONE shared decision site, so it
  covers chain, legacy and pick decisions alike without duplicating logic
  per mode. `buildState` maps history to `{verb, label, result?}` only —
  `path`, `fingerprint` and `before` never reach Jev, and `result` (which
  can equal a bound value, e.g. a select's chosen option text) passes
  through the existing whole-`raw`-object `redactDeep`. New `Reason` value
  `no-progress` reuses `FORCED_BOUNCE_LINE`/`BROWSE_STEP_CALLER_LINE` in
  `forcedNote`/`finish` (no note text was specified for it).
  **Click-family signal is widened, not just url+title**: `pageSignal` is
  url+title+`shortHash(obs.text)`+`elements.length`+(el's own
  `state`+`obscured` when present) — a same-url/title click that visibly
  changes the page must not read as unchanged.
  **`isNoProgress` has two branches, not one comparison**: element-state
  verbs compare `result === before` directly (both are
  `elementStateSignal` output, so 'empty'==='empty' is meaningful);
  click-family verbs compare `result === 'no visible change'` —
  `annotateLastOutcome` already reduces their raw `pageSignal` diff to a
  verdict word, so comparing that word against the RAW `before` signal
  would never match and silently disabled the guard for every click.
  **The guard's placement matters, not just its condition**: it sits AFTER
  the budget-steps/budget-time checks — a `max_steps: 1` call that repeats
  the same act is a REAL pre-existing pattern (deliberately exhausting a
  tiny explicit budget), and if no-progress is checked first it wins over
  budget-steps, breaking those pinned reasons. **Scope rules (both
  implemented)**: (1) the guard resets on a clause/step advance —
  `HistoryEntry.stepKey` (`c<cursor>` in chain mode, else `'single'` for a
  legacy browse_step entry or a wingman_do call) must match between the
  last act and the current decision, computed once per round as
  `currentStepKey`. (2) a round whose decision fell through from an
  error+recover `'continue'` is exempt outright — the per-round
  `recoveredThisRound` flag, set at BOTH `decideEarly`'s and
  `runChainEarly`'s `'continue'`-fallthrough sites. `decideEarly` and
  `runTokenAction` are NOT in the same nested-function scope as
  `chain`/`recoveredThisRound` (siblings inside `runTool`) — `decideEarly`
  returns a `{ recovered: true }` variant that its call sites translate
  into `recoveredThisRound = true` themselves, and `runTokenAction` takes
  `stepKey` as an explicit parameter. **Any test that scripts two
  consecutive rounds acting on the same (verb, element) with a single
  static observation is now a no-progress guard trip by construction** —
  auditing for this pattern across the whole suite is required work for
  any future change to `isNoProgress`/`annotateLastOutcome` (three
  pre-existing tests in takeover.test.ts flipped this way; fix shape: a
  second observation entry with different `text`).
- **A `select` option's `value` and its `elementStateSignal` LABEL are two
  different strings — never compare one against the other.**
  `ElementRecord.options` is `Array<{value, label}>`; the decision/act
  path (`decideTarget`, `resolveOption`) acts on the option's
  `value` attribute, but `elementStateSignal('select', el)` reads back
  `el.state.selected`, which the driver reports as the option's raw LABEL
  text (`'selected: <raw option text>'`). On any
  `<option value="v">label</option>` where `v !== label`,
  ``result === `selected: ${optionValue}` `` would never match even for a
  fully correct selection. `hasStepEvidence`'s select branch resolves the
  intended LABEL at the act site —
  `el.options?.find(o => o.value === optionValue)?.label` — and stores it
  as `HistoryEntry.intendedLabel` for later comparison against `result`.
  Any future "did the act land on what was asked" check for a `select`
  must go through this same label lookup.
- **Deterministic repeat-count evidence (WP-count):** a step naming an
  explicit count ("click the Add button twice") has its OWN evidence bar,
  independent of `hasStepEvidence`/stepDoneP — click-family is
  deliberately excluded from `hasStepEvidence`, and Jev's
  `stepDoneP`/`done` Noul never crosses threshold reliably on a repeated
  click (measured: stuck 0.11-0.71 over 24 clicks). `parseRepeatCount`
  (loop.ts, exported for unit testing only) parses once/twice/thrice/"N
  times" (digit 1-50 or word two..ten), returning `undefined` on zero or
  MORE THAN ONE count expression (ambiguous) — no general number parsing.
  `hasRepeatCountEvidence` walks the trailing CONTIGUOUS run of history
  entries backward from the last act: same `stepKey`, click-family verb
  (`CLICK_FAMILY_OPS`), `result === 'page changed'` or `'element gone'`, and the SAME target
  (`path`, else `label`) as the last entry — an intervening signal-carrying different act or target resets the count (signal-less acts such as waits, and all scrolls, are skipped), never partial credit. Wired as an extra OR branch in chain mode's rule 3
  (`runChainEarly`, no threshold — the observed count IS the evidence) and
  as rule 3b in legacy/wingman_do's `decideEarly`, which needed two new
  parameters (`history`, `stepText`) since it is a SIBLING of
  `runDoRounds` inside `runTool` with no closure access to either —
  **`stepText` is `entry.step` for legacy browse_step ONLY, and
  `undefined` for wingman_do**: `doInput.goal` is a whole-task
  description that may legitimately name several actions in sequence
  (t9's goal embeds "...click the Add Element button twice; open Inputs
  and type the amount..."), and reading a count word anywhere in that
  whole-goal text ended the WHOLE goal done/goal-met the moment the
  embedded clause's clicks landed, abandoning every clause after it. A
  legacy browse_step `step` has no such multi-clause risk: it is
  documented as one atomic instruction, and chain mode scopes the rule
  per clause via `steps`/`clauses`. Telemetry: `PhaseRound.countEvidence`
  (optional, firing round only, mirrored in `contract/types.ts`;
  `phaseAcc.rounds` passes straight through into the log record).
  **Test-fixture trap**: two clicks on different targets must NOT satisfy
  a count — an e1-then-e2-every-round ask still produces two CONSECUTIVE
  e2 clicks by round 3, trivially satisfying the check for the wrong
  reason; the alternation must be strict (`round % 2`).
- **Bare-click evidence + same-target repeat guard (WP-click, r10/r11):**
  a click step with NO count word has its own evidence bar.
  `hasBareClickEvidence(history, currentStepKey)` is true when the last
  SIGNAL-CARRYING history entry (`lastEvidenceEntry`, r11 Q3: reads
  through waits/scrolls) is on the current step, has a click-family verb,
  and `result` is `'page changed'` OR `'element gone'` (r11 Q3 — a link
  click that navigates almost always reads `element gone`, since the link
  is absent on the new page) — one observed change is enough. Advance
  bar: chain rule 3 gets an extra OR branch, `stepDoneP >=
  THRESHOLDS.stepDoneWithEvidence (0.5) && bareClickEvidence`; legacy
  `decideEarly` rule 3b gets a sibling branch on the `done` noul `>=
  THRESHOLDS.stepDoneWithEvidence` (0.5; NOT `THRESHOLDS.done`, 0.85,
  which is already rule 3). Repeat guard (act site, right after the
  no-progress guard): on a count-less step that already has bare-click
  evidence, a decision to click the SAME target again (`path`, else
  `label`) hands back `fallback`/`step-uncertain` with
  `step_review.why: 'repeat'` — exempt on a recovered-this-round round (legacy only since r15).
  Scope: chain clause and legacy browse_step `step` only, never the
  wingman_do goal (same multi-clause reason as WP-count's rule 3b
  scoping). Telemetry: `PhaseRound.clickEvidence` (firing round only),
  `PhaseRound.step_text` (every browse_step round, redacted via
  `redactValues`, capped 300), `WingmanLogRecord.step_texts_start`
  (chain mode, redacted first clause; chain.test T17's log-key allowlist
  includes it). Same batch: `THRESHOLDS.ready` 0.5 -> 0.3 (r9
  distribution). **Test trap**: any test that clicks the same target on
  two consecutive rounds of a count-less browse_step with a page-changing
  observation now trips the repeat guard by construction.
- **Stuck recover (r13, D1 rules 1-9):** a chain clause's would-be BOUNCE
  (`chainNonCommit`'s bounce branch and `applyChainEarly`'s
  `bounceWrongPage`) first tries `stuckEligible(why)`: `why` in
  no-match/low-confidence/wrong-page, execute participation, a FRESH
  clause (`chain.cursorActed === false` — set by any element-targeted act
  or token act, never by navigate/wait/scroll), once per clause
  (`stuckUsed`/`stuckPending`), `recoverActs < RECOVER_MAX_PER_CLAUSE`,
  steps and time left, the merged answers' action in `STUCK_VERBS`
  (click/navigate/back) and target `none` >= `STUCK_NONE_MIN` (0.8), and
  a destination (`back` offered, or `navigate` with a url binding). When
  eligible it sets `chain.stuckPending` and continues; the NEXT round is
  a deferred stuck round (after the pick block) that asks ONE
  `buildRecoverRequest` question (same id `recover`, stuck wording,
  criteria `back` / `open_<name>` / `give-up`) and yields a mechanical
  back/navigate decision for the shared act tail, or the deferred bounce
  (`stuckBounce`, identical to the original bounce). A stuck navigate
  gets `HistoryEntry.stuckRecover` so `hasStepEvidence` ignores it unless
  the clause names that binding; `cursorActed`/`stuckTried` persist in
  chain memory. `NoHistoryError` (a typed `ActFailedError`) from a stuck
  `back` is the deferred bounce; every other act error logs `act_error`
  (`describeActError`: first/last message line, cut at `<`, quotes
  stripped, values redacted; non-Wingman errors carry only the class
  name). Test trap: a fresh chain clause scripted action
  click/navigate/back with target `none` >= 0.8 now takes one extra
  (stuck) ask before bouncing. **Amendments**: (1) `sameDocument` (the
  "already on this page" filter for `open_<name>`) compares origin +
  pathname + query and IGNORES only the hash — a pathname-only cut hid
  query-routed hubs (`/?view=home`), and full-href equality offered the
  current page after an `href="#"` click (both pinned by
  T-stuck-query-hub). (2) D1 guard 1 is enforced, not just described:
  `chain.retryNone` records that the look which consumed the clause's
  retry was itself a confident none, and `stuckEligible` requires it, so
  an ambiguous first look + a none never recovers. (3) A failed stuck ask
  returns `fallback/jev-error` (spec-literal), which forced mode maps to
  the RESUME line, not the bounce line — one extra hop on a transient
  Jev failure; `stuckUsed` is already stored so the resume call will not
  re-ask. (4) `bindingsInStep` is a substring match, so D6's "clause
  names the binding" treats any clause containing the binding name as
  naming it.
- **Landed-navigation evidence (r14):** `runChainEarly` rule 3 has one
  more advance branch, `navAdvance`, taken only when no prior branch
  fired. Gates: (1) `bareClickEvidence` (no count word; the clause's own
  last signal-carrying act is click-family, `page changed` or
  `element gone`); (2) that entry's `beforeUrl` and this round's
  `obs.url` are different documents (`leftDocument`: origin+path+query
  differ, hash ignored); (3) `stepBindingCount <= 1`; (4) `stepDone >=
  THRESHOLDS.stepDoneWithNavEvidence` (0.25); (5) `noulOf('error') <
  THRESHOLDS.error` — rule 3 precedes rule 4, so without this gate a
  click that landed on an error page would advance and hide the failure;
  (6) NOT the final expanded clause (`chain.cursor < chain.N - 1`), since
  an advance there ends the call done/goal-met on a weak landing. Why:
  the error question's open-page carve-out suppresses errorP under an
  `open X` clause, so Jev acted ahead under the open clause. [r15
  refutation pass: under the click clause that page does not reliably
  read above 0.5 — it read 0.32-0.72 across every post-Retrieve-click
  round in r10-r14, neither chain length nor clause text predicts it, and
  the low end sits under `open Forgot Password` where the carve-out
  applies. Never design against it crossing 0.5.] Telemetry:
  `HistoryEntry.beforeUrl` (internal, set by both history pushes, never
  in buildState), `PhaseRound.navEvidence` (only on an advance that ONLY
  this branch allowed; `clickEvidence` still sets too) and
  `PhaseRound.leftPage` (every chain round whose last entry has
  `beforeUrl`). Test traps: a chain test whose clause click changes the
  observation URL, then answers step_done in [0.25, 0.5) with error <
  0.5 on a non-final clause, now advances instead of acting. Gate 6
  reads `chain.N`, the EXPANDED sub-clause count (`callerN` would treat
  sub-clause 0 of one comma-split caller clause as final;
  `T-nav-expanded` pins it, `T-nav-query` pins that a query-only change
  is a left document). Known residual (reproduced once, not pinned): a
  stuck `back` fired on the clause AFTER a nav advance (wrong landing)
  returns to the page before the click while the cursor stays past the
  open clause, so the retry runs on the hub and bounces (stuckUsed
  already spent) — same class as a 0.5-bar click-evidence advance, not
  new in kind.
- **Post-action ends, the weak-advance error gate and no repeated submit
  (r15, D2-D4):** an EFFECTIVE click is a click-family act
  (click/dblclick/press) whose observed result is not `no visible
  change` (a never-observed result counts, and so does a `no visible
  change` click whose page changed at a LATER round: `result` is read
  once, at the observation right after the act, so a slow submit
  response reads unchanged for good; `noteLateChange` flags such an
  entry `late` on any later observation whose page signal differs from
  the pre-act baseline, and `result` itself is never rewritten, so no
  evidence rule moves; a page that never changes after a no-op click
  stays unflagged, which T25 relies on); identity is element path +
  accessible name (`effectiveClicks`). `clauseClicks()` = the clicks
  chain memory carried for a resumed cursor (`ChainMemoryEntry.clicks`,
  restored to `chain.priorClicks`, reset to [] on an advance) plus this
  call's; `finish()` stores it on EVERY non-done end, `error` and
  `blocked` included, so a resumed call after an error end also refuses
  reload and re-click. When non-empty, rule 5's not-ready bounce returns
  `fallback`/`step-uncertain` and every rule-4 page-error end returns
  `error`/`page-error`, both with `step_review.why 'post-action'`;
  `forcedNote` checks that first and returns `FORCED_POST_ACTION_LINE`
  (it replaces the "call again with the same arguments" default that
  made r14's resumes dead hops). D2: `errorClear` (errorP < 0.5) gates
  the action-none, step-evidence, repeat-count, click-evidence and
  nav-evidence advances (and legacy rule 3b's count/click-evidence
  `done`); the `stepDone >= 0.85` branch stays ungated
  (done-before-error, T21). Reload refusal: rule 4's `reload` answer
  after an effective click ends page-error instead, because a reload of
  a same-address form response re-sends the form (chain: via memory
  across calls; legacy: same call only). Chain repeat guard: a
  click-family decision on a target in `clauseClicks()` (same path AND
  name) bounces `repeat` whatever acts came between; a pick round is
  exempt, `recoveredThisRound` no longer exempts in chain mode, legacy
  keeps the r10 rule. D4: the executed act enters history before any
  `dialog-open` return (shared act tail and `runTokenAction`,
  `history = outcome.history` before the result return), so a submit
  that opened a dialog reaches memory. `PhaseRound.recover` holds the
  validated recover answer on rounds where the error rule fired. Two
  routes stay open by design: a caller-written `reload the page` clause
  in a rewritten step list gets a fresh `[goal, clauses]` memory key, so
  the loop cannot refuse it (the post-action note tells the caller not
  to reload); legacy browse_step keeps no memory, so it refuses a reload
  within one call only. Test traps: a chain test whose click changes
  the observation and then hits readyP < 0.3, or a page error, now ends
  `post-action`; a static observation makes a click `no visible
  change`, which T7 and T25 rely on; re-clicking the same element in
  one count-less clause after a wait or back now bounces `repeat`; an
  error answer >= 0.5 now blocks every advance below 0.85. Known
  residuals (verifier wave, r15, not fixed): the gate precedes the
  repeat guard, and a confirm-token act never consults
  `clauseClicks()`, so with `gate.mode: 'confirm'` a resumed clause
  asks the user to confirm the same irreversible click again; click
  identity is path + name, and a path without an id is an
  `nth-of-type` chain — an error banner inserted as a same-tag sibling
  before the form shifts it and the guard misses (an id-bearing button,
  like t9's `#form_submit`, is stable); a submit whose response lands
  after the call has ended (the late flag only sees later rounds of the
  same call) is not in memory, so the resume can click it again; the
  token-act dialog-open end stores the click but not `cursorActed`.
  [The optional-mode-notes residual was CLOSED by r20 — see the r20
  bullet.] Probe-test trap: `FakeDriver` repeats the last scripted
  observation, so a two-observation script with a changed second entry
  is how a test shows a late landing.

## r17 mechanism contracts

- **Optional-target press**: `OPTIONAL_TARGET_OPS` (`contract/types.ts`) =
  `['press']`: `elementId` may be null for a `press` (the focused element
  is the target). The **press-none commit** — `press` + `target` choice
  `none` at the bar (`takeoverOf().threshold` under takeover,
  `THRESHOLDS.target` off it) commits `el: null` — precedes the margin
  rule at ALL THREE sites: `decideTarget`, `targetUncertainty` (chain
  merged-decide) and the legacy entry decision (which also skips the
  obstruction gate; a margin element there would steal the key press).
  The **irreversible-press refusal**: an `el: null` press with
  `irreversible >= 0.5` returns `ambiguous/no-action` (zero tokens
  minted, no element to gate on); chain maps it through
  `chainNonCommit('no-match')`, a legacy entry round bounces `no-match`,
  wingman_do returns it as-is.
- **Focus evidence**: `Observation.focus` (evidence-only, never sent to
  Jev) + `HistoryEntry.beforeFocus` drive the `'focus changed'`
  promotion in `annotateLastOutcome` — it fires only when the result
  computed 'no visible change', the verb is click-family, focus MOVED,
  and the moved-to element is an enumerated `editable` (a Tab onto a
  non-field stays quiet).
- **Two op sets, do not merge**: `SIGNAL_TARGETLESS_OPS`
  (navigate/back/reload/press/scroll/scroll_up — outcomeSignal + the
  isNoProgress targetless branch) vs `READY_GATE_SKIP_OPS` (nav +
  scroll/scroll_up/scroll_to — runChainEarly rule 5 only). `press` is
  signal but NOT ready-skip; `scroll_to` is ready-skip but not signal.
- **Parsers**: `parseKeyPress`/`parseAtLeastCount` follow
  `parseRepeatCount`'s exactly-one-match contract; `KEY_NAME_RE`'s
  alternation is longest-first (`arrow down` before `down`) because JS
  alternation is ordered, and `delete` is deliberately absent (not a
  PRESS_KEYS member — R9).
- **count_met** rides request 1 / the single-round request ONLY when
  `countFor` is passed — chain clauses and the legacy step parse it;
  `wingman_do` never does (C9), so it costs zero tokens there. The
  advance needs `noulOf('count_met') >= stepDoneWithEvidence` AND
  (`hasScrollEvidence` OR the fresh obs's `repeatedGroups` already meet
  N) — the count N compare is the loop's own inline `obs.repeatedGroups?.some((g) => g.count >= countFor)` check,
  never instruction text. `hasScrollEvidence`/`hasKeyEvidence` walk the
  last signal-carrying entry INCLUDING scrolls (unlike
  `lastEvidenceEntry`, which now skips scroll entries so they cannot
  shadow fill/press evidence).
- **Dialogs** are answered from the STEP text only (`dialogOutcome` never
  reads `e.message` — prompt-injection surface, C3): alerts always
  accepted, prompt/beforeunload never, confirm per `DIALOG_ACCEPT_RE`/
  `DIALOG_DISMISS_RE` (both or neither -> blocked). One answer per act
  (`dialogBase` temporal scan) and per round (`answeredDialogs`); a
  second open dialog in the same act ends `blocked/dialog-open`.
  `Driver.answerDialog` is a REQUIRED method (C5): cdp sends
  `Page.handleJavaScriptDialog` on the page session (3 s, ActFailedError
  wrap), playwright calls the stashed `Dialog` object's accept()/
  dismiss() (stash before report, cleared on javascriptDialogClosed; no
  dialog -> `ActFailedError('no open dialog')`).
- **Login suppression** (`loginSuppressedNow`): three OR arms — step/goal
  names a supplied binding, the step is making progress (last
  signal-carrying result differs from its baseline), or `alreadyEnded`
  (chain memory's `loginSeen`, restored in `runBrowse`, written by
  `finish()` as `true`/absent, reset on advance). Suppression sets
  `cur.loginSuppressed` telemetry but NEVER `loginSeen`/`loginEnded` —
  those are set only where a `login/login-page` result is produced (C1),
  so a suppressed-then-still-login page loops on the round budget, not
  on the flag.
- **Hidden labels (D7)**: a visually hidden checkbox/radio resolves its
  name through an adjacent visible sibling `<label>` (next sibling, then
  previous) -> PROXY arm (`path` = the label, `controlPath` = the input,
  name = label text); failing that, a non-empty `accessibleName`
  (aria-label -> placeholder -> title here) keeps the record NON-proxy
  on its own path; else still enumerated null. `verify` mirrors the
  sibling probe inside its LABEL branch; the named-only arm needs no
  verify change (the input itself is at `path`).
- **r17 test traps**: (1) a scripted `press` with `target: none >= 0.5`
  must commit targetless — watch the takeover margin branch, which
  previously never saw `none` as a commit; (2) a `press` whose result is
  `focus changed` requires `obs.focus` on the observation AND the
  moved-to element `editable` in `obs.elements` — tests must set both;
  (3) `count_met` is asked only when `countFor` is passed; (4)
  `dialogOutcome` reads the STEP text, never `e.message` — a confirm
  dialog with no accept/dismiss word in the step still ends
  `blocked/dialog-open` (the mcp-server confirm-token test relies on
  this); (5) `FakeDriver.dialogOnNextAct` accepts `DialogEvent |
  DialogEvent[]` (array drains in order); (6) `loginSuppressed` rounds
  set the telemetry flag but never `loginSeen`; (7) the round-top dialog
  answer (r17 D5) sits BEFORE the pick-round check and consumes a
  `continue`: a dialog observed at round top of a round-1 pick call is
  answered (or blocks), and round 2 no longer matches `pickRound`
  (`round === 1`), so the caller's explicit pick silently degrades to an
  ordinary Jev round — only reachable when a page opens a dialog between
  attach and the first observe; (8) `VERB_RE` contains
  `dismiss`/`close`/`submit` but NOT `accept`/`cancel`, so a caller
  clause "click X and dismiss the dialog" SPLITS at the `and` and the
  click sub-clause ends `blocked/dialog-open` before the dismiss word is
  ever the active step text — the shipped e2e clauses deliberately say
  `cancel`/`accept` for this reason (WP-C note 1).

## KB-flag discipline (in-src)

- **KB-flag polarity: flip = restore PRE-fix behaviour**, so the new path
  is ACTIVE while the flag is `false` — compose `!KB_X && <new>` (or
  `KB_X ? <old> : <new>` for a ternary), never `KB_X && <new>`. When a
  spec pins a KB-flag expression, derive the polarity from the
  convention FIRST, then check the literal. **The r19 upload-evidence
  spec's literal `checkFlipResult` body was self-contradictory and is
  NOT what shipped**: the draft wrote `if (!KB_UPLOAD_EVIDENCE &&
  actResult === 'uploaded') return undefined;` — that strips the
  evidence when the flag is FALSE, so shipped code would never store
  'uploaded' and flipping the mutant would ENACT the fix instead of
  killing it. Shipped polarity is `if (KB_UPLOAD_EVIDENCE && actResult
  === 'uploaded') return undefined;` (flip = restore the pre-fix void).
  Proven by instrumentation during the WP-2 fail-first: with the spec's
  literal body, `actFlip` came back undefined at the act site despite
  the driver returning 'uploaded'. (`.build-r19-spec.md` carries an amendment note since 61df9bb; the shipped body matches it.)
- **A hard-killed mutants runner leaves KB flags flipped in src** (the
  byte-identical restore lives in a `finally`, which a taskkill/reap
  does not run). Before AND after every mutants pass:
  `grep -rnE '(const|var) KB_\w+ = true' src` must return nothing; restore `=
  false` immediately. The full pass runs DETACHED (`Start-Process python
  -u`, ~25+ min) — full runbook in the repo CLAUDE.md KB-mutant section.
- **settle.ts's raced-poll shape punishes a naive fake clock** (r17c
  WP-2): `waitForScrollGrowth` (and `settleByProbe`) race each probe
  against `clock.sleep(remaining)`, and the sleep's body runs
  SYNCHRONOUSLY at race construction — a fake clock whose sleep advances
  virtual time inline therefore advances the clock for sleeps the wait
  ABANDONED (the probe won the race), so `{changed: true}` reports
  `ms = budget` and the poll-interval assertions see `[remaining]`
  instead of the poll cap. The working fake (tests/settle.test.ts
  `fakeClock`) resolves sleeps via `setTimeout(0)` (so answered probes
  always win the microtask race) and records only the NEWEST pending
  sleep (a superseded raced sleep resolves silently). Any new
  settle-family test with an injected clock must copy both properties.

## r20: optional-mode post-action note

- **Optional-mode post-action ends return `FORCED_POST_ACTION_LINE`
  since r20 (spec `.build-r20-spec.md` S-1a).** The r15 residual is
  closed: a `fallback/step-uncertain` end with `step_review.why:
  'post-action'` in optional mode now carries the post-action line
  instead of the § 3.17 caller line (which invited the caller to redo
  the executed action). The constant's `FORCED_` name is historical —
  the text is mode-neutral. This end is the FIRST branch in `finish()`'s
  § 3.17 else-arm, before the escalation `if`, so it never increments
  the per-goal bounce counter (it is not a target refusal; tiers 1-3
  all steer back into repeating the action). Guarded by
  `KB_OPT_POSTACTION_NOTE` (D-11 polarity: `!KB_...` in the condition,
  flip = restore the pre-r20 note + escalation); pinned by
  `T-opt-post-note` and `T-opt-post-note-no-escalate` in
  tests/chain.test.ts. Forced mode is untouched (its table already
  returned the post-action line via `forcedNote`).

## r21: scoped captcha signal (P-3)

- **The captcha signal is scoped, not whole-page**: `computeSignals` keeps the
  CAPTCHA_RE text unchanged but (behind body-local `KB_CAPTCHA_SCOPED`, flip =
  restore the legacy any-substring match) requires the matcher to be visible,
  ≥ `CHALLENGE_MIN_AREA` (16000 px²), and not carry `size=invisible` (iframe arm only) (the
  reCAPTCHA v3 badge); the id/class arm additionally skips
  script/style/template/noscript/link/meta and reads the rect only after the
  RE hits. The true/false fixtures are `captcha-challenge.html` /
  `captcha-decoys.html`; the FP pin is the flip tooth (proven: flag `= true`
  → exactly that pin red, TP pin stays green — pre-fix matches a superset).
- **The 2026-09-21 bbc/npr `/captcha/i` match was REPRODUCED 2026-10-04** (results branch r21, 4384f0e): the pre-fix rule returned true on bbc/npr/guardian; the scoped rule returns false (raw matches 1/6/1, all 0x0 or invisible). The earlier zero-match baseline (`.calib/captcha-baseline-r21.json`) was not reproduced (cause unproven; raw counts vary per load, npr 1 vs 6). Re-run the recon every validation round; its raw dump names the arm a match came from, and `--fixtures` mode is the discriminating self-check (TP fixture → true/1 match, FP fixture → false/4 matches).

## r21: cursor-pointer candidacy — REJECTED and REMOVED (P-5/D12)

- **The cursor-pointer candidacy heuristic does NOT exist in the shipped
  tree — it was REJECTED by the D12 live bar (2026-10-04) and REMOVED, not
  flag-gated.** D12 measured +88% to +298% live-page candidate inflation
  against the +30% cap (refs/backup/r21-results,
  bench-results/2026-10-04-r21/progress.md); the earlier local wall numbers
  (`.calib/wall-probe-r21.mjs`, +1.9-7.0 ms) accepted it locally and were
  wrong about the real failure mode, which was candidate QUALITY, not wall
  time. Removed pieces: `cursorCandidacy()`, the `isCandidate` cursor arm,
  the body-local `KB_CURSOR_POINTER` flag, `implicitRole`'s cursor arm, and
  verify()'s ungated cursor mirror (mirrors mirror enumerate; once enumerate
  stops producing cursor candidates the mirror can never fire — r19 D-2
  precedent). `grep -c "cursor" src/core/page-scripts.ts` must stay 0.
- **Boundary (documented, not fixed): delegation-only pointer-styled divs
  do not enumerate.** Framework menu items wired through a root-delegated
  listener (no onclick, no role, no own listener) are invisible to
  enumerate, page-side indistinguishable from inert styled divs. The
  fixture `fixtures/pages/pointer-interactive.html` (Save/Cancel menu items
  + two decoy divs) pins zero records for all four names in
  `tests/pointer-enum.test.ts` (the iframe/shadow boundary pins are in `tests/page-scripts.test.ts`).
- **`elementCriterion` renders the ROLE, never the tag** (still true
  generally — explicit `role=` and `onclick` divs): stubs and pick regexes
  must match `button "Save"`, not `div "Save"`, or the stub finds no
  criterion, answers nothing, and the call bounces `no-match` with a
  healthy enumeration — the failure looks like "enumeration broken" but is
  the stub.

## Gotchas from r22 (2026-10-04, the t9 recovery fixes)

- **The act path has its own nav-shaped family now (F-1).**
  `NAV_SHAPED_ACT_ERROR_RE` (`/scheduled navigations|evaluation timed out|Execution context|locator\.\w+: Timeout \d+ms exceeded/i`) sits at the shared act tail: an element-targeted
  click-family act that fails NAV-SHAPED is retried ONCE behind a
  `PRE_CLICK_SETTLE_MS` settle (`KB_ACT_NAV_RETRY`, D-11 polarity, flip =
  single send). The retry settle books into `bucket.settleMs`, both sends
  into `actMs`; a second failure throws through to `error/act-failed`
  (exactly 2 sends). Deterministic failures never match the message
  predicate. Test trap: `fill` on a non-editable element ends
  `ambiguous/target-uncertain` via `opFits` BEFORE any act — a test that
  "fills a button" never reaches the act tail (use an editable input).
- **Resume-cheap (F-2): a re-sent whole chain skips a post-action cursor.**
  `ChainMemoryEntry.postAction` is written (true/absent) only when the
  stored end's `step_review.why` is `'post-action'` — BOTH flavors, the
  `fallback/step-uncertain` AND the `error/page-error` post-action ends
  carry the same `FORCED_POST_ACTION_LINE`, so both skip. The skip sits in
  `runBrowse` after `chainState` creation (`!KB_RESUME_SKIP_POSTACTION`):
  cursor+1 with the advance-branch resets, and `resumeSkipMarker` gives the
  call's FIRST round a `resumeSkippedPostAction` marker (beginRound consumes
  it once). Guarded `cursor + 1 < N`: a post-action cursor on the FINAL
  clause keeps same-clause resume (the spec defines no round-0 end for that
  case) — which is why T-post-reload Leg C, T-repeat-resume Leg A and
  T-late-landing-notready pin the carried-click/reload-refusal lanes on
  SINGLE-clause chains now, and T-repeat-resume Leg B's resume script starts
  at the clause-2 commit (rb skips clause 1). Pin-trap: an `opts.ask`
  harness never populates `harness.requests` — wrap the ask to capture.
- **`ambiguous/target-uncertain` with `jev_calls=0` is the PICK round shape,
  not an under-counted ask (F-4 disposition).** The pick block's
  resolvePick-mismatch and opFits returns end target-uncertain with zero
  asks and zero probabilities (the 2026-09-29 records in
  `bench/.home/log.jsonl` are all `pick:true`). The invariant "a round that
  carries probabilities had an ask; a zero-ask end carries no probabilities"
  is pinned both ways in loop.test.ts. The r22 spec named
  `evidence/R21-log-slice.jsonl`, which does not exist in the tree — the
  reproduction ran against the live log instead.
- **`FORCED_ENGAGEMENT_LINE` lives in `bench/run.ts`, not tool-text.ts**
  (the r22 spec's file attribution was wrong; the constant name + quoted
  text identify bench/run.ts). Its post-action exception sentence is pinned
  as INLINE spec text in tests/bench-browse.test.ts (the spec-of-record
  rule). `BROWSE_STEP_DESCRIPTION`'s parallel "call again with the same
  arguments" sentence was left unchanged — the spec named only the
  engagement line.
- **browse-step-surface SPAWNS the built CLI by path (`<build>/src/cli/main.js`
  mcp)** without importing it (like cli.test.ts) — a scoped gate build that
  omits `src/cli/main.ts` makes every StdioClientTransport test die
  `MCP error -32000: Connection closed` after ~9 s, and the file looks like a
  hang (>10 min) in a combined run. Pass the CLI as an extra entry:
  `build.mjs --out <dir> tests/... src/cli/main.ts`. With it present the file
  is ~7 tests of real transport+Chrome work and alone it still exceeds the
  10-min foreground cap on this box — run it as its own chunk.
- **The resume skip carries the reload hazard as a memory FLAG, not carried
  clicks (F-2b).** The skip's `priorClicks = []` reset left the first
  post-skip clause on the skipped clause's response page with the r15
  reload refusal disengaged (it keys on `clauseClicks().length > 0`). The
  fix composes into the existing `KB_RESUME_SKIP_POSTACTION` path (no new
  flag): the skip sets `chainState.responsePage`, rule 4 refuses
  `reload` when `clicked || chain.responsePage` (refusal flavors
  post-action ONLY on the refused reload — give-up/other error ends keep
  their old flavor), the first advance clears it, and `finish()` writes it
  to `ChainMemoryEntry.responsePage` so it survives a non-advancing end.
  Do NOT replace this with carrying `mem.clicks` into `priorClicks`:
  clauseClicks() feeds THREE sites (reload refusal, rule 5's not-ready
  post-action flavor, the repeat guard), and the not-ready/give-up flavors
  would write `postAction: true` for a clause that NEVER ACTED — the next
  resume would skip an unacted clause. Consequence to know: the refused
  reload end itself carries the post-action flavor, so memory stores
  postAction for that unacted first post-skip clause and a further
  whole-chain re-send skips it — coherent with FORCED_POST_ACTION_LINE's
  "only the steps after this one", but it IS a skip of an unacted clause.
  Test trap: a script of wait -> reload -> reload against one static
  observation dies `fallback/no-progress` (reload is a SIGNAL_TARGETLESS
  op; the second reload after a no-change first reads as no-progress) —
  end the call with a terminal script entry (give-up, or ADV to
  end-of-chain) instead.

## r24: landed-act bars, ready skip, press focus-sum, verb coercion, second stuck back (2026-10-06)

- **Landed-act bars below 0.5 (r24 WP1, spec `.build-r24-spec.md` § 2.4).** `runChainEarly` rule 3 has
  three more advance branches after `navAdvance`, each needing exactly one effective click on the clause
  (`clauseClicks().length === 1`) where it reads clicks: R1 same-document own click/dblclick (`page changed`/`element gone`,
  `!leftDocument`) at `stepDoneWithSameDocEvidence` 0.3 with errorP < `sameDocErrorMax` 0.25, a clause that does not say 'value named' (`NAMES_A_VALUE_RE`; NOT `bindingsInStep`, a substring match that counts t10's `first` binding inside 'add the first listed product'),
  no key/count clause (`sameDocEvidence`); R2 the FINAL expanded clause's own click that left the document at the
  nav bar 0.25 with errorClear (`finalNavEvidence`) — the r14 gate 6 still holds for `navAdvance` itself; R3 a
  hover clause (`HOVER_CLAUSE_RE`) whose own hover read `page changed` at 0.5 (`hoverEvidence`). The post-submit
  error page reads stepDone 0.38-0.71, so only the strict error gate keeps R1 off it; the one-click guard is what
  rejects the #48 wrong-link landing (stepDone 0.45, same as a correct landing). Test traps: a same-document
  page-changing click followed by step_done in [0.3, 0.5) with error < 0.25 now advances (re-script below 0.3);
  a final clause's landed cross-document click at step_done >= 0.25 now ends done.
- **Press focus-sum (r24 WP3).** `pressFocusSumCommits` extends the press-none commit:
  choice `none` or the focused EDITABLE element (`obs.focus`), their summed probability >= the gate → targetless
  commit at the four press-none sites (r23b sums 0.96-0.99), for browse_step (takeover) rounds only at the 0.7 takeover threshold — wingman_do keeps its own 0.5 press-none bar and never uses the focus-sum. Still targetless, so the irreversible refusal applies.
  Test trap: an observation with `focus` on an editable plus a split press now commits.
  Mutation note: `T-r24-pressfocus-guards` leg (e) kills a 0.5 wingman_do gate (sum 0.55); leg (f) (wingman_do, none 0.4 + focused field 0.35 = 0.75 >= 0.7) kills dropping the `takeover &&` guard alone. Both are needed.
- **Verb coercion (r24 WP5).** `decideTarget` turns a check/uncheck on a committed
  link/button into click before `opFits` (`verbCoerced`). Test trap: a check scripted on a role link/button acts.
  Mutation note: `T-r24-coerce-guards` kills the `uncheck` arm, the `button` role arm and the `offeredSet.has('click')` guard individually (legs a, c); leg b (hover on a link stays hover) is the verb-guard tooth. Dropping the `el !== null` guard is a TS18047 build error, so the compiler is its tooth (a mutation run whose build fails leaves the PREVIOUS dist: read "BUILD: ok" before trusting a red).
- **Second stuck back (r24 WP7).** `stuckEligible` rule 4b allows ONE more stuck round on a
  clause only when the last signal-carrying act is a stuck-recover `back` (`HistoryEntry.stuckBack`) that landed
  (`page changed`); `stuckSecondUsed` is per call (not in memory), reset on advance and on the F-2 skip
  (`stuckSecond`); `RECOVER_MAX_PER_CLAUSE` (2) already caps a clause at two stuck rounds, so `stuckSecondUsed` is belt-and-braces. A navigate first stuck keeps once-per-clause (`T-stuck-once`).
  Mutation note: dropping `c.stuckSecondUsed`, the `ev.stuckBack === true` check or the `ev.verb === 'back'` check changes no recorded shape (equivalent by design; the cap and the tag make them redundant); dropping the `stuckBack` tag push, `landedStuckBack`, its `page changed` clause or the advance-branch `stuckSecondUsed` reset each red a test (`T-r24-stuck2-reset` kills the reset: a two-clause chain whose second clause needs its own second stuck; the F-2 skip reset is redundant with the `false` initialiser).
- **Ready skip (r24 WP2).** Rule 5 skips the ready gate when the decided click/dblclick target
  commits by THRESHOLD on a clause with no element act yet (`cursorActed`, memory included) — never after any click, even one that read 'no visible change', so the r15
  post-action not-ready end and chain-e2e E7 are unchanged; request 1 of a two-stage round has no target, so the
  skip never fires there (`readySkipped`; flag `KB_READY_SKIP_COMMITTED`). Question text unchanged (W2-S branch; P0b's amended ready wording lifted readyP only 0.21 -> 0.35, under its +0.15 bar).
  O4 accepted (a): `cursorActed` is per clause, so a committed click on the very element an EARLIER clause already clicked (act-ahead) is skipped through and re-clicks; not observed in r23b.
  Mutation note: dropping `cursorActed`, the threshold check or `obscured` reds `T-r24-readyskip-guards` (threshold also reds the three T24 tests); the verb guard reds the existing `readyP 0.2 (< 0.3) still waits, then bounces not-ready`; the missing-element guard (`el !== undefined`) and the file-input guard need legs e and f (the skip would otherwise end `no-match`/`no-value` with zero acts). The `id === 'none'|'ambiguous'` arm and `!skipsReadyGate` in `readySkip` are equivalent by design (no element carries those ids; the skip verbs never include click). `readySkipped` is set only when ready was actually under the bar (leg g).
- **t12 dialog split (r24 WP6, characterization).** A confirm is answered from the CURRENT
  clause text, so a click clause naming a button labelled 'Confirm' accepts it (`DIALOG_ACCEPT_RE`); the next
  'accept the dialog' clause then has nothing to act on and bounces no-match. Pinned by `T-r24-dialog-split`; no fix ships
  (operator decision 2026-10-06, O2: pin only; a fix would advance a clause at stepDone 0.13-0.17, below the kept 0.2 floor).
  Teeth proven by dropping `confirm` from `DIALOG_ACCEPT_RE` in a throwaway worktree: the test reds.
- **r24 sub-guard pins (recheck, 2026-10-06).** `T-r24-samedoc-guards2`, `T-r24-finalnav-error`, `T-r24-finalnav-count`, `T-r24-hover-guards` and `T-r24-pressfocus-verb` pin the guards the first build left unmutation-proof: R1 key/count clause and press-act exclusion, R2 `errorClear` and its counted-clause exclusion (`bareClickEvidence` carries the `repeatCount === undefined` guard that `hasNavClickEvidence` lacks), R3 bar 0.5 / `errorClear` / `repeatCount` / `NAMES_A_VALUE_RE`, and the `verb !== 'press'` guard of `pressFocusSumCommits` (without it a split click would commit targetless with `el: null`). `CLICK_FAMILY_OPS` holds `press`, so R1's own `click`/`dblclick` verb check matters only for an ELEMENT-targeted press: a targetless press has no `path`, so `effectiveClicks` never counts it and `oneClick` already excludes it. Mutation scripts on this box's checkouts need CRLF-aware anchors (`core.autocrlf` makes `src/core/loop.ts` CRLF in a worktree): a multi-line `old` string must use `
`, and a single-line anchor hides the problem.

## r24b: adjudication telemetry (2026-10-06)

- **Read `stance` and the round `gate` field for live gate decisions, never `gate_hits` or `mode`.** Every log record carries `stance: {gate, policy}` (`gateModeOf`/`policyModeOf` in `buildLogRecord`, so it is what the server loaded). `mode` is the wingman mode (`on`), and `gate_hits` counts SHADOW gate hits only (`acc.gateHits` is set in the shadow branch; the live gate never touches it — r24's 26 needs_confirmation records all read `gate_hits: 0`).
- **Per-round adjudication fields, contract-safe set** (spec `.build-r24b-spec.md` § 5): `url` (origin+path, values redacted BEFORE the 160 cut), `cursor`, `els` (element count) and `text_h` (the `pageSignal` text fingerprint, never the text), `cands` (top-3 target ids + grades + role/tag cut to 20, NO labels; same sort as `target1`/`target2`), `pickArgs`, `dialogs` (type + outcome, never the message), `gate` (rule incl. `jev`, element id/role/tag/type, irreversibleP), `policy` (reason + true signal flags; page-level, no element), `act` (the EXECUTED verb/element/binding NAME/key, `ok` only after the driver returned, `flip`, `navRetry`, `token`); record-level `step_texts` (caller steps) and `step_parents`. Labels and page titles stay out of log.jsonl unless `deps.logLabels` (env `WINGMAN_LOG_LABELS=1`, set only by the bench): then `title` (80), `cands[].label`, `gate.label`, `act.label` (40), redacted before the cut. Telemetry reuses the verdicts already computed: the pinned `driver.act(`/`gateHeuristic(`/`evaluatePolicy(` counts stay 3/2/2.
- **Under `gate.mode: 'confirm'` every plain-button click gates**: a `<button>` without a type attribute enumerates `type: 'submit'` (IDL default, page-scripts.ts `buildRecord`), so gateHeuristic's `type-submit` rule fires — t4 Add Element, t6 Start, t12 and t16 all ended needs_confirmation in r24.
- Test trap: chain `T17`'s top-level log-key allowlist includes `stance`, `step_texts`, `step_parents`; a new top-level log key must be added there by the same package.
