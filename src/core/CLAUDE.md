# src/core — page-scripts gotchas

- **The irreversible gate is config-switchable** (2026-09-20): `config.json`
  `gate.mode` accepts `"confirm"` (default, today's behaviour) and `"off"` (the
  heuristic and Jev p(irreversible) never mint a token; the act proceeds). The
  operator's own machine runs `"off"`; the public default stays `"confirm"`.

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
