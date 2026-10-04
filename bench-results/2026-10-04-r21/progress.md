# r21 progress (HEAD c8c4aff on main; npm ci skipped - lock unchanged; build ok, 113 files; no `= true` KB flags in src before)

## Part 1 chrome-only (19 invocations incl. act-nav, pointer-enum, doctor x2; one file per invocation; failing file re-run once)
acquire 6/6 | chrome 28/28 | conformance 28/28 | **conformance-ops forty-two pass + 2 FAIL + 1 todo (red on first run AND re-run)** | chain-e2e 20/20 | pick-e2e 2/2 | adapter-cdp 10/10 (22 s) | adapter-playwright 10/10 | page-scripts 30/30 | act-nav 6/6 (44 s) | pointer-enum 2/2 | doctor 37/37 x2 | with-chrome 32/32 | with-chrome-forced 3/3 | runner-sweep 2/2 | runner-sweep-leak 1/1 | ephemeral-sweep 7/7 | scaffold 16/16.
- FINDING (deterministic, 2 of 2 runs, both adapters): conformance-ops `O8 wait sleeps about one second` fails on playwright AND cdp: `wait took 3005 ms (3006 ms), expected 900-3000`. P-2 (growth-poll waits, bound WAIT_GROWTH_MS = 3000) makes a wait act on a never-changing page take the full ~3 s; the spec's own T-wait-static pins [2900, 3800] ms for exactly that. O8's 900-3000 window predates P-2 and the 3000 edge is crossed by 5-6 ms. This is a stale pin, not a defect in P-2 (the WP-4 gate ran act-nav/adapter-playwright/adapter-cdp but not conformance-ops). Not fixed (report-only). Logs: part1/logs/conformance-ops.log (+ .first.log). conformance-ops uses a temp home, so there is no wingman log.jsonl slice.
- Both doctor runs 37/37; act-nav 6/6 and pointer-enum 2/2 are the new r21 live pins.

## Part 1b - r21 mutants pass (8 flags, .build/kb-r21, one build per flip, mapped files run per flag; grep for `= true` in src before AND after: clean; every restore byte-identical (sha256))
| flag | mapped pin(s) | red under flip | extras | verdict |
|---|---|---|---|---|
| KB_CAPTCHA_SCOPED | page-scripts "captcha-decoys.html does not set the captcha signal" | 1/1 | 1 (page-scripts "svg-carried captcha class ... still gated by visibility" - a consequence: that pin also pins the scoped rule) | PROVEN |
| KB_CURSOR_POINTER | pointer-enum "click Save ... ends done and logs saved"; "enumerate lists the decoy divs" | 2/2 | 0 | PROVEN |
| KB_PW_NOWAIT | act-nav T-nav-nowait | 1/1 | 0 | PROVEN |
| KB_PW_PRECLICK | act-nav T-preclick-guard | 1/1 | 0 | PROVEN |
| KB_CDP_PRECLICK | act-nav T-cdp-preclick | **0/1** | 0 | **NOT PROVEN** - the flip does move the pin's measured duration (9117 ms unflipped -> 5124 ms flipped) but its assertion is `>= 3500`, so it passes either way (the CDP click path holds ~5 s on guard-loading.html on its own); a bound near 8000-9000 would discriminate |
| KB_OBS_RETRY | loop "a fast mid-navigation observe failure retries ..." | 1/1 | 0 | PROVEN |
| KB_PW_WAIT_GROWTH | act-nav T-wait-growth, T-wait-static | 2/2 | 0 | PROVEN |
| KB_CDP_WAIT_GROWTH | (spec names none; T-wait-* run on the playwright driver) | **0 red** | 0 (act-nav, adapter-cdp, chain-e2e 20/20, conformance-ops: only the playwright O8 leg red, which is the pre-existing stale pin) | **NOT PROVEN** - no pin goes red; the only observable effect is conformance-ops O8 on the CDP adapter flipping from red (3006 ms) to green (flag restores the ~1 s sleep) |
- Totals: 6 of 8 flags proven, 2 unproven (both CDP-adapter flags: a loose bound on one pin, no pin at all on the other). 1 extra failure across all 8 flips (the svg-carried consequence).
- The extra-pass evidence for KB_CDP_WAIT_GROWTH: part1b/logs/KB_CDP_WAIT_GROWTH.extra.*.log. Runner: part1b/mut21.py, raw output and per-file TAP in part1b/logs/.
