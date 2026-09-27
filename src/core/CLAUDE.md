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
  not a src gap): the chain merge-decide block (`loop.ts` ~2190-2206) checks
  `decide.bounds` / `decide.keyMissing` / `decide.result.reason === 'no-value'`
  on every `decideTarget` result before falling through to `no-match` — this
  already covers `fill`'s (~1091/1097), `select`'s (~1122), `navigate`'s
  (~1145) and `upload`'s (~1162) no-value returns uniformly. `tests/chain.test.ts`
  T9 already exercises navigate's `urlAnswer: 'none'` case and passes today,
  confirming this. If a chain e2e test reports status `ambiguous` where
  `fallback/step-uncertain/no-value` was expected, suspect the TEST first —
  in particular a shared browser tab left on the wrong page: `runDoRounds`
  filters `visiblePages` by `url_match` (loop.ts ~1372-1387) and returns
  `ambiguous`/`tab-ambiguous` on zero matches, which looks exactly like a
  leaked `ambiguous` from `decideTarget` unless you check the `reason` field.
  This is what `chain-e2e.test.ts` E3 hit: its bad-urlAnswer loop reused the
  same tab and `url_match` after a preceding `good` run had navigated that tab
  away — fixed by navigating the tab back before the loop (see
  `chain-e2e.test.ts`'s `gotoFixture` helper).
- **`jev-error` is a catch-all — timeouts read like API defects** (2026-09-21,
  diagnosis of 2026-09-21-1311 browse fallbacks): `askFailReason`
  (src/core/loop.ts:274) maps every ask error except `no-key`/`circuit-open`
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
