# r24 gauntlet results (HEAD b2137a3)

## Part 1 (13 files, one per invocation, all green)
```
chain rc=0 wall=1s leaked=1 # tests 181 # pass 181 # fail 0 # skipped 0 # todo 0 
outcome-evidence rc=0 wall=0s leaked=0 # tests 49 # pass 49 # fail 0 # skipped 0 # todo 0 
loop rc=0 wall=5s leaked=0 # tests 56 # pass 56 # fail 0 # skipped 0 # todo 0 
takeover rc=0 wall=0s leaked=0 # tests 37 # pass 37 # fail 0 # skipped 0 # todo 0 
questions rc=0 wall=0s leaked=0 # tests 32 # pass 32 # fail 0 # skipped 0 # todo 0 
bounce-escalation rc=0 wall=1s leaked=0 # tests 8 # pass 8 # fail 0 # skipped 0 # todo 0 
handback-triage rc=0 wall=0s leaked=0 # tests 5 # pass 5 # fail 0 # skipped 0 # todo 0 
grader-replay rc=0 wall=0s leaked=0 # tests 13 # pass 13 # fail 0 # skipped 0 # todo 0 
bench-browse rc=0 wall=0s leaked=0 # tests 31 # pass 31 # fail 0 # skipped 0 # todo 0 
chain-e2e rc=0 wall=117s leaked=0 # tests 20 # pass 20 # fail 0 # skipped 0 # todo 0 
pick-e2e rc=0 wall=6s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
act-nav rc=0 wall=68s leaked=0 # tests 7 # pass 7 # fail 0 # skipped 0 # todo 0 
adapter-playwright rc=0 wall=29s leaked=0 # tests 10 # pass 10 # fail 0 # skipped 0 # todo 0 
P1DONE
```

## Bench
BENCH REPORT 2026-10-06-083333.json purpose=measure model=sonnet harness=3 aborted=null total_usd=10.076124 runs=68
route playwright n=34 ok=32/34 wall_s min=8.7 med=13.2 max=31.5 usd min=0.068436 med=0.1671815 max=0.255646
route forced n=34 ok=30/34 wall_s min=8.5 med=13.6 max=107.1 usd min=0.052157 med=0.152883 max=0.419673

Forced failures: t10-saucedemo-checkout (both reps), t16-hover-reveal (both reps). Playwright failures: t15-file-upload (both reps).
Note: this invocation was run with the dispatch's command only (no BENCH_GATE_OFF / BENCH_POLICY_OFF env, which r23b had set).

## triage-r24 (first 13 lines)
```
HANDBACK-TRIAGE results=bench/results/2026-10-06-083333.json offset=0 handbacks=50
class error-page 2
class landed-not-advanced 15
class other 21
class press-split 1
class stuck-exhausted 2
class target-uncertain 9
no_wingman_done_cells 7 t4-add-elements#1 t6-dynamic-loading#1 t10-saucedemo-checkout#1 t16-hover-reveal#1 t6-dynamic-loading#2 t10-saucedemo-checkout#2 t16-hover-reveal#2
route playwright runs=34 ok=32 usd_total=4.979342 usd_median=0.167182 tool_calls_total=167 tool_calls_median=4 tool_calls_mean=4.911765 wall_median_ms=13208
route forced runs=34 ok=30 usd_total=5.096782 usd_median=0.152883 tool_calls_total=133 tool_calls_median=2 tool_calls_mean=3.911765 wall_median_ms=13618
r24_flags 15 hoverEvidence=2 pressFocusSum=4 readySkipped=2 sameDocEvidence=6 stuckSecond=1
r24_flag_suspects 7 t4-add-elements#1/call2/r2/sameDocEvidence t6-dynamic-loading#1/call1/r1/readySkipped t4-add-elements#2/call2/r2/sameDocEvidence t4-add-elements#2/call3/r2/sameDocEvidence t6-dynamic-loading#2/call1/r1/readySkipped t9-long-chain#2/call11/r7/stuckSecond t11-todomvc-spa#2/call1/r4/pressFocusSum
handback t4-add-elements#1 call1 needs_confirmation/irreversible-heuristic why=null class=other
```

## triage-r23b (first 13 lines)
```
HANDBACK-TRIAGE results=/tmp/r23b.json offset=5 handbacks=32
class error-page 1
class landed-not-advanced 10
class not-ready 4
class other 2
class press-split 4
class stuck-exhausted 1
class target-uncertain 10
no_wingman_done_cells 6 t6-dynamic-loading#1 t12-js-confirm-dialog#1 t6-dynamic-loading#2 t9-long-chain#2 t11-todomvc-spa#2 t12-js-confirm-dialog#2
route playwright runs=34 ok=32 usd_total=5.396889 usd_median=0.176974 tool_calls_total=181 tool_calls_median=4 tool_calls_mean=5.323529 wall_median_ms=11702
route forced runs=34 ok=34 usd_total=4.855623 usd_median=0.161893 tool_calls_total=118 tool_calls_median=2.5 tool_calls_mean=3.470588 wall_median_ms=13135
r24_flags 0
r24_flag_suspects 0
```

## Invariant
forced=34 matches=34 mismatches=0

## Suspects: 7 (see suspects.md)

## Spend
run total_usd=10.076124; LEDGER before=88.304416 after=98.380540 (phase cap 104.304416)
