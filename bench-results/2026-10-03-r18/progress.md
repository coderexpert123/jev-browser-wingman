# r18 progress (HEAD b2a3037; npm ci ran once - package-lock changed; build ok, 109 files)

## Part 1 chrome-only (16 files, serial, one per invocation)
acquire 6/6 | chrome 28/28 | conformance 28/28 | conformance-ops 44 pass + 1 todo (O18) | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (21 s) | adapter-playwright 10/10 | page-scripts 23/23 (gained 2) | doctor 28/28 on RE-RUN | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.
- doctor FIRST run failed: "all ten checks pass on a clean ephemeral setup" -> `coexistence: observer fingerprint changed across attach/detach` (log part1/logs/doctor.first.log); re-run passed. So the coexistence flake survives the de78ea2 fix in the cloud (1 fail in 2 runs this round; r17c's 3 CLI doctor runs and Part-1 doctor run were all green). doctor uses a temp home - no wingman log.jsonl slice exists.
