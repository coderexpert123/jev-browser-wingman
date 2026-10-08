# r26 t6/t8/t10/t11 forced x4: STOPPED at step 6 (harness refusal, exit 2, zero spend)

HEAD 10ac0cb7a2a0c6605de6653b2aa64908818665aa; BUILD: ok; tracked tree clean; chain 221/221 pass 0 fail; Jev probe exit 0 (status 200); baseline fetched; ledger before: 130.502824.

## Stop reason
Step 6 exited 2: BENCH-BASELINE: EXPECTED-DIFF-ABSENT fixture_server value=true; BENCH-REFUSED: baseline mismatch: 1 of 25 keys; nothing ran.
fixture_server is in the --expect-diff list but does not differ: this task selection includes t6 and t8, which are local fixture tasks, so the fixture server starts (value true, same as the r24b baseline). In the earlier t11-only runs (all live) it was false, which is why it was needed there. The brief forbids changing the expect-diff list to get past a refusal, so nothing was retried. Re-dispatching without fixture_server in the list should clear it.

## run.txt BENCH lines
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="10ac0cb7a2a0c6605de6653b2aa64908818665aa"
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=4
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedem
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.294"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: expected-diff prompts_sha256 baseline="7c9dcc33b4a65dffd9439f100d065dd0f771429667b200276cf007b6de9b46f6" run="027f31908de892a62378d8f48d351ec91f213cd69d1e3ec5fd1c98a3affeb0a2"
BENCH-BASELINE: EXPECTED-DIFF-ABSENT fixture_server value=true
BENCH-REFUSED: baseline mismatch: 1 of 25 keys; nothing ran
exit=2
```
Spend 0.000000; ledger unchanged (130.502824).
