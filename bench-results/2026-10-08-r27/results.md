# r27 full gauntlet: STOPPED at step 6 (harness refusal, exit 2, zero spend)

HEAD 10ac0cb7a2a0c6605de6653b2aa64908818665aa; BUILD: ok; tracked tree clean; chain 221/221 pass 0 fail; Jev probe exit 0 (status 200); baseline fetched; ledger before: 132.070126.

## Stop reason
Step 6 exited 2 immediately: 'BENCH-REFUSED: --purpose must be cap-proof, measure or experiment'. The dispatch's --purpose gauntlet is not an accepted value. The refusal happened at argument parsing, before the baseline check, any Chrome start or any spend; no results file was written. The brief says a refusal is a STOP with no retry and forbids changing flags, so nothing was retried.
Earlier full-gauntlet runs (r23b, r24b, r24c, r24d) used --purpose measure; re-dispatching with --purpose measure is the likely fix.

## run.txt
```
BENCH-REFUSED: --purpose must be cap-proof, measure or experiment
exit=2
```
Spend 0.000000; ledger unchanged (132.070126).
