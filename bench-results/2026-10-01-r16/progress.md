# r16 progress log (HEAD 62cbd27) — cross-domain task-shape expansion
- Part 1 DONE (sanity only): HEAD 62cbd27 (descendant check OK); `npm ci && npm run build` ok (107 files); `npx tsc --noEmit` exit 0. Domains reachable through the egress proxy: saucedemo.com 200, todomvc.com 200, the-internet.herokuapp.com 200.
- Invocation A ATTEMPT 1 FAILED before any cell: `jev-browser-<bench-prefix>: {"code":-32603,"message":"Internal error"}` (aborted: error, 0 runs, USD 0). ROOT CAUSE (reproduced with an independent probe, evidence/defect-resetstorage/): bench/run.ts line 462 sends `Storage.clearDataForOrigin` on the BROWSER-level CDP connection (`ctx.observer`, no sessionId) for tasks with resetStorage:true; on Chrome 141.0.7390.37 that always returns -32603 Internal error, while the identical call over an attached PAGE session succeeds. The first task in the list (t10) has resetStorage, so the whole invocation dies at cell 1. t10 and t11 (both resetStorage) therefore CANNOT run through the unmodified harness; t12-t14 have no flag. REPORT-DO-NOT-FIX: bench/run.ts and bench/tasks.json untouched; continuing with --tasks t12,t13,t14 only (the sanctioned narrower-list resume), t10/t11 reported as blocked by this defect.
- Invocation A' DONE (narrowed: t12,t13,t14 only; playwright x2; invA2-playwright.json) total_usd=0.812743
  - A1 t12-js-confirm-dialog playwright ok=True wall=12.7s usd=0.190819 raw_acts=1 raw_script=0
  - A2 t13-infinite-scroll playwright ok=True wall=14.1s usd=0.173608 raw_acts=0 raw_script=1
  - A3 t14-key-press playwright ok=False wall=10.6s usd=0.189818 raw_acts=2 raw_script=0
  - A4 t12-js-confirm-dialog playwright ok=True wall=9.3s usd=0.089782 raw_acts=1 raw_script=0
  - A5 t13-infinite-scroll playwright ok=True wall=15.4s usd=0.079825 raw_acts=0 raw_script=1
  - A6 t14-key-press playwright ok=False wall=10.3s usd=0.088891 raw_acts=2 raw_script=0
