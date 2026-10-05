# r22b - the probe-gated publish re-run: BLOCKED on the external site (HEAD ccdb003)

**Verdict: STOP at STEP 1. Zero spend. No publish run was attempted. README refresh from this round: NO (there is no run to refresh from).**

## STEP 1 - site health probe
`the-internet.herokuapp.com/infinite_scroll`, 10 sequential requests, time to first byte in seconds:

| # | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| TTFB | 28.60 | 0.39 | 0.19 | 30.16 | 25.98 | 0.38 | 0.14 | 0.16 | 0.18 | 0.17 |

**3 of 10 requests exceeded 5 s (26.0 s, 28.6 s, 30.2 s)** against the HEALTHY bar of "all 10 under 2 s" and the STOP trigger of "any over 5 s". Three is not the "marginal 1-2 of 10" case that earns a second probe an hour later, so the round stops here.

Controls, run immediately after on the same box and egress path:
- **example.com x10:** 10 of 10 fast (0.12 - 0.34 s). The box and the proxy path are healthy.
- **the-internet.herokuapp.com root page x10:** 1 of 10 stalled (25.0 s); the other nine took 0.14 - 0.44 s.

The stall is therefore the site's: an intermittent first-byte delay of roughly 25-30 s, hitting about 1 in 3 requests to `/infinite_scroll` and about 1 in 10 to `/` in this sample. It matches r22's measurement (3 of 14 requests stalled at 29-30 s the previous evening), so the condition has persisted overnight rather than clearing.

## What was not run, and why
- **STEP 2 (Part 1 sanity), STEP 3 (the 68-cell gauntlet), STEP 4 (doctor x3):** not run, per the dispatch's STOP rule. A gauntlet launched into a site that stalls ~30 s on a third of its requests would reproduce r22's failures (t13 forced: scroll-block appends that never land inside the growth wait; t9: navigation timeouts on both routes) for reasons unrelated to the code under test, and would burn ~10 USD doing it. The ledger is untouched.
- **ccdb003 itself:** confirmed as `main`'s HEAD (descendant check passed); the lockfile is unchanged since r22, so `npm ci` was skipped. No build or test was run this round.

## What would unblock this
1. Re-run the identical probe (10 requests, all must be under 2 s) when the site recovers; if it only intermittently recovers, the dispatch's "two marginal probes = stop" rule applies.
2. If the site does not stabilize, the 17-task gauntlet's 15 `the-internet` shapes (t1-t9 plus t13, t14 plus the fixtures that sit behind it) cannot be measured reliably on it; the options are an operator decision, outside this round: mirror the-internet locally (the three fixture-served tasks t15-t17 already run against a local server and are immune), or pin a probe-gated retry window. I did not build either.
3. The r21b run (forced 34/34, one clean 68-cell invocation, taken before the stalls began) remains the best-available README source.

## Spend
0.00 USD (curl probes only).
