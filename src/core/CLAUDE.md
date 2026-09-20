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
