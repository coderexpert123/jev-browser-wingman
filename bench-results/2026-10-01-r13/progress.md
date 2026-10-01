# r13 progress log (HEAD 64cbbdb)
- Part 1 DONE: 51/51 files; tsc 0; 751 tests, 749 pass, 1 skip (chrome-cmd win32), 1 todo (conformance-ops playwright O18, which PASSED as a todo), 0 fail, no re-runs needed. chain 85/85, chain-e2e 10/10 (E9 and E10 each assert exactly 1 recover-only stub request: both pass). conformance-ops O18: cdp pass; playwright todo ran and PASSED (`ok ... # TODO`, no error, not skipped => not blind, back was a real bfcache restore). lazy-chrome ok; known-bad tool-call FAIL answered=true. KB-stuck proof: 21 T-stuck-* tests failed incl. T-stuck-url/-back/-giveup (64 pass/21 fail); restored clean. runner-sweep-leak left 2 chromes (designed drill leaf), swept.
- Phase V DONE (phase-v.json) total_usd=0.792267: V1 playwright ok 28.7s 0.312151 | V2 ok 29.9s 0.30679 | V3 ok 24.1s 0.173326 -> 3/3 control OK
- Phase M DONE (phase-m.json) total_usd=1.65204; forced-verdict overall FAIL (completion 2/3, median-steps 1.00, no-page-error-end 1)
  - M1 forced ok=True wall=77.6s usd=0.450311 handoffs=10 picks=5 wingman_acts=36 raw_acts=0 raw_script=0
  - M2 playwright ok=True wall=21.7s usd=0.161337 handoffs=0 picks=0 wingman_acts=0 raw_acts=16 raw_script=0
  - M3 forced ok=False wall=55.5s usd=0.227267 handoffs=5 picks=2 wingman_acts=30 raw_acts=0 raw_script=0
  - M4 playwright ok=True wall=25.0s usd=0.195613 handoffs=0 picks=0 wingman_acts=0 raw_acts=16 raw_script=0
  - M5 forced ok=True wall=62.9s usd=0.310409 handoffs=8 picks=2 wingman_acts=33 raw_acts=0 raw_script=0
  - M6 playwright ok=True wall=32.6s usd=0.307103 handoffs=0 picks=0 wingman_acts=0 raw_acts=16 raw_script=0
