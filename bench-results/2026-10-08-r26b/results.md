# r26b t6/t8/t10/t11 forced x4 (HEAD 10ac0cb7a2a0c6605de6653b2aa64908818665aa)
(retry 1 of r26; the first attempt stopped on the fixture_server expected-diff refusal)

BUILD: ok; tree clean; chain 221/221 pass 0 fail; Jev probe exit 0 (status 200). The first launch of this retry died pre-spend with 'Chrome did not answer on port 9344 within 10 s' (exit 1, no cell, no results file; kept as run-attempt0-chrome-cold-start.txt); the identical command re-run once cleanly (exit 0).

## BENCH-BASELINE
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="10ac0cb7a2a0c6605de6653b2aa64908818665aa"
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=4
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedem
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.294"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: expected-diff prompts_sha256 baseline="7c9dcc33b4a65dffd9439f100d065dd0f771429667b200276cf007b6de9b46f6" run="027f31908de892a62378d8f48d351ec91f213cd69d1e3ec5fd1c98a3affeb0a2"
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,prompts_sha256
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,prompts_sha256
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
## Per task and rep: 16 of 16 cells ok, 0 hand-backs, 0 error ends, 20 browse_step calls

| task | reps ok | calls per rep | hand-backs | wall (s) per rep | rule evidence |
|---|---|---|---|---|---|
| t6-dynamic-loading | 4/4 | 1,1,1,1 | 0 | 38.2, 17.4, 21.4, 17.2 | 5 rounds each (act, advance, wait, wait, advance); wait-already-satisfied did not fire (waitSatisfied absent): the wait clause was never re-sent alone |
| t8-status-404 | 4/4 | 1,1,1,1 | 0 | 14.5, 12.8, 17.0, 12.7 | caller sent ONE step, 'click the 404 link' (no 'open the Status Codes page' step) in the reps inspected (1,2) |
| t10-saucedemo-checkout | 4/4 | 2,2,2,2 | 0 | 28.5, 25.8, 30.6, 23.6 | call 1 ends login/login-page (a normal login end, not a hand-back); call 2 is the trimmed 9-step re-send starting at 'click the Login button' and ends done/goal-met; loginSuppressed:true on every round record in the slice (20) |
| t11-todomvc-spa | 4/4 | 1,1,1,1 | 0 | 15.7, 15.6, 16.2, 14.2 | pressAfterFill:true x2 per rep (8 total), 2 press acts per rep, no duplicates |

Triage: handbacks=0, no_wingman_done_cells 0, r24_flags 15 (readySkipped 4, sameDocEvidence 7, waitEvidence 4), suspects 0, policy_ends 0, log_stance off/off=20 (equals the 20 records), telemetry rounds=160 with_url=160.
Versus r24d: t8 hand-backs 2 -> 0, t11 hand-backs 5 -> 0 (single call each).

## Spend: 1.567302 (16 cells; phase cap LEDGER+2). LEDGER before=130.502824 after=132.070126
Log slice bytes: 118414
Leak scan: the flat explain-*.txt files sit outside the scanner's explain/ pattern, so a copy of them plus triage.txt was scanned in a temp explain/ dir: leaks=0 files=17 hits=0.
