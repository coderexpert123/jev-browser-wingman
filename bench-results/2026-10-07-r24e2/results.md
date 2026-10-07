# r24e2 t11 forced x4 (HEAD e0172ef6382e007133b88b2a70d33c18ee286573)

BUILD: ok; tree clean; chain 214/214 pass 0 fail; Jev probe exit 0 (status 200).

## BENCH-BASELINE
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="e0172ef6382e007133b88b2a70d33c18ee286573"
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=4
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedem
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.292"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: expected-diff fixture_server baseline=true run=false
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,fixture_server
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats,fixture_server
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
## Per rep (3 browse_step calls each: step-uncertain, step-uncertain, done/goal-met)

| rep | oracle ok | wall | handbacks | press acts landed | fill acts | pick acts (kind, cursor, step) |
|---|---|---|---|---|---|---|
| 1 | true | 22.2 s | 2 | 2 | 3 | act c1 press Enter; act c1 press Enter |
| 2 | true | 22.3 s | 2 | 2 | 3 | act c1 press Enter; act c3 press Enter |
| 3 | true | 18.0 s | 2 | 2 | 3 | act c1 press Enter; act c1 press Enter |
| 4 | true | 20.1 s | 2 | 2 | 3 | act c1 press Enter; act c3 press Enter |

Triage: handbacks=8 total (press-split 4, landed-not-advanced 4); no_wingman_done_cells 0; r24_flags 0; suspects 0.
Duplicate check: 2 landed press acts per rep for 2 todos typed; no duplicate press in any rep.
Alignment marker: the align path writes no dedicated telemetry key; indirect evidence only (pick acts book under the 'press Enter' clause: cursor 1, and 3 for the second pick in reps 2 and 4; reps 1 and 3 show cursor 1 for both).
Versus the previous revision (d60940d): same pass rate, same handback and call counts; the cursor pattern differs only in which reps show cursor 3.

## Spend: 0.432318. LEDGER before=129.714692 after=130.147010
Log slice bytes: 47473
```
leaks=0 files=2 hits=0
exit=0
```
