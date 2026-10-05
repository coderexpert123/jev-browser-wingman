# r22b progress (HEAD ccdb003 on main = r22 tree + the E12 pin fix; npm ci skipped - lock unchanged)

## STEP 1 - site health probe (zero spend): STILL STALLING -> STOP
the-internet.herokuapp.com/infinite_scroll, 10 sequential curl requests, time to first byte (s):
28.60, 0.39, 0.19, 30.16, 25.98, 0.38, 0.14, 0.16, 0.18, 0.17  -> **3 of 10 over 5 s (26.0 / 28.6 / 30.2 s)**, 7 of 10 healthy (0.14-0.39 s). Rule: any TTFB > 5 s = STOP; 3 of 10 is not marginal (marginal = 1-2 of 10), so no second probe was needed.
Controls (same box, same egress proxy, run immediately after):
- A: example.com x10 -> 10 of 10 fast (0.12-0.34 s, max 0.34 s) - the proxy path and this box are fine.
- B: the-internet.herokuapp.com/ (root page) x10 -> 1 of 10 stalled (25.0 s), 9 healthy (0.14-0.44 s).
Reading: the stall is the site's (intermittent ~25-30 s first-byte, now about 1 in 3 on /infinite_scroll and 1 in 10 on /), not this machine and not the egress path. It matches r22's measurement (3 of 14 stalled at 29-30 s, the evening before), so the condition persisted overnight and got no better.
Decision (per the dispatch): **round BLOCKED on the external site.** No Part 1 sanity, no gauntlet, no doctor, no spend (ledger untouched). A doomed 68-cell run would reproduce r22's t13/t9 failures for reasons unrelated to the code under test.
Probe log: probe/site-probe.txt.

## Final: results.md written. Round blocked-on-external-site at STEP 1; no cells, no tests, no spend. README refresh: NO (nothing to refresh from; r21b stays the best source).
