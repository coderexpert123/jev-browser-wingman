# r25 t11 forced x4, press-after-fill (HEAD 9ef34de86e6de6568c60e62d842d9e30cebecc18)

BUILD: ok; tree clean; chain 217/217 pass 0 fail; Jev probe exit 0 (status 200). Caller CLI is now 2.1.294 (an expected diff vs the baseline's 2.1.291).

## BENCH-BASELINE
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="9ef34de86e6de6568c60e62d842d9e30cebecc18"
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=4
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedem
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.294"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: expected-diff fixture_server baseline=true run=false
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,fixture_server
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,fixture_server
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
## Per rep

| rep | oracle ok | wall | calls | handbacks | press acts | fill acts | pressAfterFill rounds | rounds |
|---|---|---|---|---|---|---|---|---|
| 1 | true | 33.7 s | 1 | 0 | 2 | 2 | 2 | 10 |
| 2 | true | 14.1 s | 1 | 0 | 2 | 2 | 2 | 10 |
| 3 | true | 15.1 s | 1 | 0 | 2 | 2 | 2 | 10 |
| 4 | true | 13.9 s | 1 | 0 | 2 | 2 | 2 | 10 |

- Every rep ended done/goal-met in ONE browse_step call (r24e: 3 calls, 2 handbacks per rep; r24d baseline: 5 handbacks over 4 reps).
- Triage: handbacks=0, no_wingman_done_cells 0, r24_flags 0, suspects 0, policy_ends 0, log_stance off/off=4.
- r25 rule fired: pressAfterFill:true on rounds 3 and 7 of every rep (8 of 8 expected fires = 2 per rep), each with jevMs 0 and kind act: the press was mechanical, no Jev ask.
- Duplicate check: exactly 2 press acts per rep, matching the 2 press clauses; no duplicates.
- Spend 0.355814 (4 cells); wall median 14.6 s.
LEDGER before=130.147010 after=130.502824
Log slice bytes: 27847
```
leaks=0 files=2 hits=0
exit=0
```
