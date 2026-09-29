# r10 forced-handoff validation — local bench (1925183 + b04da41)

Code under test: `b04da41` (ready 0.3, bare-click evidence + repeat guard,
redacted step_text telemetry) plus `1925183` (browse_step/install-doc
repeat-count and fallback-recovery wording). Run locally on Windows against
headless Chrome on CDP 9344; `claude -p` children routed through the local
cognition proxy (SWE-2 as `sonnet`).

## Phase V — playwright baseline ×3 (gate off, policy off)

`bench/results/2026-09-29-0859.json` — 3/3 ok, total $5.4918.
Per-cell: $0.5428 / $2.6811 / $2.2679.

## Phase M — forced ×3 + playwright ×3 (gate off, policy off)

`bench/results/2026-09-29-0932.json` — 6 cells, total $9.6350.
Run ended with `BENCH-ABORTED: cap reached after 6 runs` (post-run ledger
gate; all cells had already landed).

FORCED-VERDICT (verbatim):

```
FORCED-VERDICT: completion forced=2/3 playwright=3/3
FORCED-VERDICT: wingman-share 1.00
FORCED-VERDICT: raw-acts 0
FORCED-VERDICT: handoffs max=25
FORCED-VERDICT: picks 33/47
FORCED-VERDICT: zero-step-done 0
FORCED-VERDICT: first-call-success 3/3
FORCED-VERDICT: median-steps 2.00
FORCED-VERDICT: no-page-error-end 0
FORCED-VERDICT: raw-script 0
FORCED-VERDICT: why-breakdown low-confidence=3 no-match=20 no-progress=5 no-value=1 not-ready=5 wrong-page=4
FORCED-VERDICT: overall FAIL
```

Per-cell: forced ok/$1.0120 (10 handoffs), playwright ok/$1.8726,
forced FAIL/$1.5127 (25 handoffs), playwright ok/$1.5000,
forced ok/$1.0944 (12 handoffs), playwright ok/$2.6434.

Telemetry (from `log.jsonl`, 47 Phase-M records, 206 rounds):
- clickEvidence firings: **0** — the bare-click evidence path never engaged
  in these cells (callers did not emit count-less same-target click steps).
- readyP: median 0.54, 36% under 0.5, min 0.05 — the 0.3 floor passes most
  bounces; readiness is not the constraint.
- why-breakdown dominated by `no-match` (20/38) — Jev could not locate the
  named element; `not-ready` 5, `no-progress` 5, `wrong-page` 4,
  `low-confidence` 3, `no-value` 1.

## Phase S — forced ×1 smoke (gate ON, policy off)

`bench/results/2026-09-29-0958.json` — 1 cell, $3.1631, ok=false.
Cell hit the $3 cap while blocked on gate confirmations.

FORCED-VERDICT smoke (verbatim):

```
FORCED-VERDICT: smoke ok=false needs_confirmation=20
```

Gate-on shape confirmed: actions convert to `needs_confirmation`
(`irreversible-heuristic`) instead of executing — no silent bypass.

## Comparison to r9

r9 (3a82301, cloud): 4/9 bars missed — completion 2/3, handoffs max 21,
picks 34/51, median-steps 1.00. r10 (1925183, local SWE-2): the same four —
completion 2/3, handoffs max 25, picks 33/47, median-steps 2.00. The round
did not move the verdict; n=3 cells remain noisy. What changed: `no-match`
became the dominant handback (20 vs a more mixed r9 split), and the
fresh-install over-action is fixed — r9 clicked Add Element 24× per call,
r10 clicks exactly 2 (repeat guard, `why=repeat`, fires after the click
lands).

## Part 3 — fresh install check

`npm pack` → `npm install -g --prefix <scratch> jev-browser-wingman-0.2.1.tgz`
(98 packages). `doctor` on a forced-handoff home pointed at CDP 9344:
**10/10 PASS** (key-present, config-loaded, registration-portable,
policy-loaded, profile-safe, adapter-attach, default-context, coexistence,
handoff, jev-round).

First attempt used an optional-handoff home and the caller drove playwright
directly (all 3 tasks DONE but through raw acts — not a forced-mode test).
Re-run with `handoff.mode=forced` + playwright under the `with-browser`
proxy — results below.

| Task | Result | wingman path |
|---|---|---|
| type 4242 into /inputs | DONE — field verified "4242" | navigate + fill via browse_step (Jev `fill` act) |
| choose Option 2 in /dropdown | DONE — Option 2 selected | `select` act via browse_step |
| click Add Element twice | DONE — exactly 2 clicks | **key r10 question answered** |

Task-3 detail (`log-part3.jsonl`): the caller split "twice" into two
count-less clauses (`click the Add Element button`, then `click ... one more
time`) — the same pattern that produced r9's 24-click storm. This time each
clause landed **one** click, then the repeat guard handed back `why=repeat`.
Two `click` acts total; CDP `Runtime.evaluate` on the live page confirms
`#elements button` count = **2** (two Delete buttons). The r9→r10
over-action is closed.

Caveat: `clickEvidence` logged 0 firings across all forced cells — the
bare-click evidence path never engaged, so the no-count advance/done rule
is still unexercised in the wild. The repeat guard alone carried this fix.
