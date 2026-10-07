# r24d: STOPPED after the smoke (Jev decision service returning HTTP 402); no gauntlet ran

HEAD 0b59cc76e097ed59a9c3be233e218d318848b2d3; BUILD: ok; tracked tree clean; base-commit=ok; files-outside-allowlist=0.

## Stop reason
Smoke a-j hold on their letter, but every Jev call ended fallback/jev-error on round 1 (6 of 6 records, 1 round each, ~130-350 ms): both smoke cells failed and no round reached a decision. A single diagnostic capture call (written outside the results tree) returned status=402 error=http and exited 3 ('1 of 1 Jev responses were not ok (first: http status 402)'). Per the run note a capture exit 3 is the decision service failing, not the code, so the gauntlet (about USD 10) and the real capture probe were NOT run. The bench's own self-stop (exit 5, aborted jev-down) did not trigger on the smoke: the smoke exited 0 with aborted null after 6 consecutive jev-errors. The account that the operator reported working is still refused with 402.

## leak-teeth
```
LEAK /tmp/r24b-known-bad/log-slice.jsonl t11-todomvc-spa.item1 hits=15
LEAK /tmp/r24b-known-bad/log-slice.jsonl t11-todomvc-spa.item2 hits=2
leaks=1 files=1 hits=17
exit=1
```
## Part 1 (23 files green, no timeouts, leaks 0)
```
withhold rc=0 wall=1s leaked=0 # tests 29 # pass 29 # fail 0 # skipped 0 # todo 0 
questions rc=0 wall=0s leaked=0 # tests 33 # pass 33 # fail 0 # skipped 0 # todo 0 
pick rc=0 wall=0s leaked=0 # tests 23 # pass 23 # fail 0 # skipped 0 # todo 0 
egress rc=0 wall=0s leaked=0 # tests 6 # pass 6 # fail 0 # skipped 0 # todo 0 
lib rc=0 wall=1s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
cli rc=0 wall=5s leaked=0 # tests 6 # pass 6 # fail 0 # skipped 0 # todo 0 
leak-scan rc=0 wall=0s leaked=0 # tests 4 # pass 4 # fail 0 # skipped 0 # todo 0 
chain rc=0 wall=2s leaked=0 # tests 209 # pass 209 # fail 0 # skipped 0 # todo 0 
outcome-evidence rc=0 wall=0s leaked=0 # tests 49 # pass 49 # fail 0 # skipped 0 # todo 0 
loop rc=0 wall=5s leaked=0 # tests 56 # pass 56 # fail 0 # skipped 0 # todo 0 
takeover rc=0 wall=0s leaked=0 # tests 38 # pass 38 # fail 0 # skipped 0 # todo 0 
boundary rc=0 wall=1s leaked=0 # tests 19 # pass 19 # fail 0 # skipped 0 # todo 0 
bounce-escalation rc=0 wall=0s leaked=0 # tests 8 # pass 8 # fail 0 # skipped 0 # todo 0 
handback-triage rc=0 wall=1s leaked=0 # tests 12 # pass 12 # fail 0 # skipped 0 # todo 0 
grader-replay rc=0 wall=16s leaked=0 # tests 16 # pass 16 # fail 0 # skipped 0 # todo 0 
bench-browse rc=0 wall=1s leaked=0 # tests 31 # pass 31 # fail 0 # skipped 0 # todo 0 
bench-cap rc=0 wall=0s leaked=0 # tests 11 # pass 11 # fail 0 # skipped 0 # todo 0 
bench-run-config rc=0 wall=3s leaked=0 # tests 17 # pass 17 # fail 0 # skipped 0 # todo 0 
chain-e2e rc=0 wall=118s leaked=0 # tests 20 # pass 20 # fail 0 # skipped 0 # todo 0 
pick-e2e rc=0 wall=6s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
redaction-e2e rc=0 wall=4s leaked=0 # tests 1 # pass 1 # fail 0 # skipped 0 # todo 0 
act-nav rc=0 wall=44s leaked=0 # tests 7 # pass 7 # fail 0 # skipped 0 # todo 0 
adapter-playwright rc=0 wall=31s leaked=0 # tests 10 # pass 10 # fail 0 # skipped 0 # todo 0 
P1DONE
```
## Preflight
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="0b59cc76e097ed59a9c3be233e218d318848b2d3"
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.292"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version
BENCH-OBSERVED: warnings=0 (preflight sees the Node version only; warnings never block)
BENCH-PREFLIGHT: ok nothing ran config={"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"0b59cc76e097ed59a9c3be233e218d318848b2d3","git_dirty":false,"routes":["playwright","forced"],"repeats
exit=0
```
typesafe-base-url-set=0; caller_cli_version=2.1.292 (operator-accepted); 7b hash line count=1
```
CLAUDE.md now=210634c00a0f r24b=210634c00a0f
bench/CLAUDE.md now=5d6701666878 r24b=5d6701666878
2.1.292 (Claude Code)
```
## Smoke verdicts
```
a PASS
b PASS
c PASS
g PASS
i PASS
h titles=6 PASS
d PASS
e PASS (log_stance off/off=6, handoff_records sum 6)
f PASS (with_url=6)
j PASS (leaks=0 files=2 hits=0, exit=0)
```
Smoke: t4 ok=false, t11 ok=false (both fallback/jev-error), spend 0.419656, slice 5087 bytes, 6 rounds, no <value:...> markers (no decisions reached the point of binding values). Smoke leak scan: leaks=0 files=2 hits=0 exit=0.
```
BENCH-BASELINE: expected-diff git_head baseline="922617fd037d7d5a18f6a370d8392f312f8a1011" run="0b59cc76e097ed59a9c3be233e218d318848b2d3"
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=1
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t1
BENCH-BASELINE: expected-diff caller_cli_version baseline="2.1.291" run="2.1.292"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897" run="4ce7f785dfac0c4ec22e1441408486dd9ad56b05adb99b8a863a3b0750004513"
BENCH-BASELINE: ok baseline=r24b.json keys=25 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats
BENCH-BASELINE-POST: ok baseline=r24b.json keys=1 expected_diffs=git_head,tool_text_sha256,caller_cli_version,tasks,routes,repeats
BENCH-OBSERVED: warnings=0 (warn-only; nothing was blocked)
exit=0
```
## Not run: gauntlet, metrics, step-18 checks, invariant, real capture probe.
## Spend: smoke 0.419656; LEDGER0=118.951482 ledger after=119.371138 (the diagnostic call is Jev-token only, outside the ledger, and was refused with 402)
