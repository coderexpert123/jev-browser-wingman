# src/core — page-scripts gotchas

- **The irreversible gate is config-switchable** (2026-09-20): `config.json`
  `gate.mode` accepts `"confirm"` (default, today's behaviour) and `"off"` (the
  heuristic and Jev p(irreversible) never mint a token; the act proceeds). The
  operator's own machine runs `"off"`; the public default stays `"confirm"`.

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

