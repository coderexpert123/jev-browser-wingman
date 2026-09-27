# forced-handoff-0.3.0 release-candidate QA (2026-09-27)

Branch under test: `forced-handoff-0.3.0` @ `6daa964`. Linux cloud container (root, Node 22.22.2,
Chromium 141.0.7390.37 at `/opt/pw-browsers/chromium-1194`, playwright-core 1.63.0), Xvfb `:99`.

**Outcome: Part 1 NOT green. Part 2 (forced-handoff bench) and Part 3 (fresh install) were NOT run**
(per the QA plan's stop rule: unexplained, not-previously-known failures in Part 1). Spend: USD 0
(one `claude -p 'say ok'` prereq check only; no bench cell, no TypeSafe call).

## Environment setup

- Installed `bench/cloud/chromium-wrapper.sh` as `/usr/local/bin/chromium-wrapper.sh` with
  `REAL_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; `/usr/bin/chromium` -> wrapper.
- Verification: `DISPLAY=:99 /usr/bin/chromium --headless=new --dump-dom https://example.com` returned the
  real "Example Domain" DOM (not `chrome-error://`). PASS.
- `claude -p 'say ok'` -> `Ok`. `TYPESAFE_API_KEY` present (presence-checked only).
- Also needed (environment only, see findings E1-E3): `mkdir .build/`; symlink
  `/opt/google/chrome/chrome` -> wrapper.

## Part 1 — build and typecheck

- `npm ci` 0, `npm run build` -> `BUILD: ok out=dist files=105`, `tsc -p tsconfig.json --noEmit` exit 0.
- Note: `package.json` version is still `0.2.1` on the 0.3.0 branch.

## Part 1 — per-file results (one file per invocation, sequential; 0 leftover `wingman-ephemeral` chromes after every file)

Totals: 49 files, 645 tests, 624 pass, 20 fail, 1 skip (win32-only).

| file | tests | pass | fail | notes |
|---|---|---|---|---|
| acquire | 6 | 6 | 0 | |
| adapter-cdp | 8 | 7 | 1 | KNOWN (CLAUDE.md 2026-09-25): pinned form.html observe; rect x/w differ (Linux font metrics) |
| adapter-playwright | 7 | 7 | 0 | |
| bench-browse | 26 | 26 | 0 | |
| bench-cap | 8 | 8 | 0 | |
| bench-oracle | 2 | 2 | 0 | |
| bounce-escalation | 8 | 8 | 0 | |
| boundary | 19 | 19 | 0 | |
| browse-step-surface | 7 | 5 | 2 | NEW: #5, #6 (F2, F3) |
| cdp-connection | 3 | 3 | 0 | |
| chain | 43 | 43 | 0 | |
| chain-e2e | 8 | 1 | 7 | NEW: E1-E4, E6-E8 (F1) |
| chrome | 28 | 27 | 1 | NEW: #24 (F6) |
| chrome-cmd | 8 | 7 | 0 | 1 skip (win32 only) |
| classify-tools | 7 | 7 | 0 | |
| cli | 6 | 6 | 0 | the known chrome-show failure did NOT reproduce (fixed by merge 6daa964) |
| config | 30 | 30 | 0 | |
| conformance | 28 | 28 | 0 | |
| conformance-ops | 39 | 38 | 1 | NEW: playwright O6 (F5), 3/3 runs |
| contract | 15 | 15 | 0 | |
| doc-safety | 4 | 4 | 0 | |
| doctor | 26 | 26 | 0 | |
| egress | 6 | 6 | 0 | |
| ephemeral-sweep | 7 | 7 | 0 | |
| gate | 9 | 9 | 0 | |
| jev-client | 6 | 6 | 0 | |
| log | 3 | 3 | 0 | |
| loop | 34 | 34 | 0 | |
| mcp-server | 14 | 11 | 3 | NEW: #9, #10, #11 (F1) |
| page-scripts | 15 | 15 | 0 | first run HUNG (E2); passes 15/15 once `channel: 'chrome'` resolves |
| pick | 20 | 20 | 0 | |
| pick-e2e | 2 | 0 | 2 | NEW: P1 (F1), P2 (F4) |
| plugin | 4 | 4 | 0 | |
| policy | 21 | 21 | 0 | |
| profiles | 14 | 14 | 0 | |
| questions | 25 | 25 | 0 | |
| readme-bench | 4 | 4 | 0 | |
| registrations | 9 | 9 | 0 | |
| runner-sweep | 2 | 1 | 1 | NEW: #2 (F7) |
| runner-sweep-leak | 1 | 1 | 0 | |
| scaffold | 15 | 13 | 2 | #1, #3 fresh-clone only (E1); 15/15 once `.build/` exists |
| settle | 4 | 4 | 0 | |
| setup-plan | 5 | 5 | 0 | |
| takeover | 37 | 37 | 0 | |
| takeover-config | 10 | 10 | 0 | |
| tokens | 5 | 5 | 0 | |
| with-chrome | 26 | 26 | 0 | |
| with-chrome-forced | 3 | 3 | 0 | |
| withhold | 8 | 8 | 0 | |

### New failures (not in CLAUDE.md's known list)

**F1 — every stub-backed e2e test gets `jev-error` (12 tests: chain-e2e E1,E2,E3,E4,E6,E7,E8;
mcp-server #9,#10,#11; browse-step-surface #6; pick-e2e P1).**
Assertions: `reason: jev-error / 'fallback' !== 'done'` (E1), `'jev-error' !== 'budget-steps'` (E2),
`'fallback' !== 'done'` / `'fallback' !== 'needs_confirmation'` (mcp-server),
`'jev-error' !== 'step-uncertain'` (P1).
Root cause (by instrumenting a throwaway copy of the compiled `jev-client.js`): the requests
carry a `key` question (plus `value` on chain rounds), and the test stubs never answer it.
`parseJevAnswers` needs an answer for every question, so each response is `invalid-response` -> `jev-error`.
Logged example: `Q=done,blocked,login,irreversible,action,target,value,key,step_done,right_page,ready`
`A=done,blocked,login,irreversible,step_done,right_page,ready,action,target`; mcp-server:
`Q=...,action,target,key A=...,action,target`.
chain-e2e fails the same way (1 pass / 7 fail) at `3ac2c7f`, the commit that introduced it, and at
`fcac04b` and `671fd47`. The suite has never been green on this code. It has probably never run
before (it needs Chrome). Open question for the owner: should the stubs answer `key`/`value`, or should
the loop stop offering the `key`/`value` questions on rounds where no key/fill verb applies?

**F2 — browse-step-surface #5 "a first call with the verbatim t9 goal, seven steps and a numeric value
is not invalid-input".** The server returns `error/invalid-input` with the note "the steps name the value
email, which is missing from values; add values.email." The test sends only `values: { amount: 77 }`, while
`T9_STEPS` names `email`. The test and the input validation disagree.

**F3** — the #6 failure is F1 (`'fallback' !== 'done'`).

**F4 — pick-e2e P2 "a pick onto an obscured element returns target-covered with no act and no ask".**
The status, reason and `step_review.why` assertions all pass. The failing assertion is
`assert.equal(log, null, 'the covered button was not clicked; the log is unchanged')`, with actual `''`.
`fixtures/pages/overlay.html` contains `<output id="log"></output>`, so the unclicked textContent is `''`,
never `null`. The product behavior is correct; the assertion is wrong.

**F5 — conformance-ops `playwright` > O6 "navigate to form.html then back to ops.html": `error: 'no previous
page'`** (thrown by `src/adapters/playwright.ts` when `page.goBack()` resolves `null`). It fails 3/3, so it is
not a flake. The CDP adapter's O6 passes. A standalone Playwright script with the same fixtures, the same
chromium and `goBack({waitUntil:'commit'})` returned a non-null response, so the cause is unconfirmed.
Treat it as a possible real Playwright-adapter `back` defect on Chromium 141/Linux.

**F6 — chrome #24 "listChromeProcesses Windows command covers the five family executables": `missing
Name='chrome.exe' in: ps -ax -o pid=,command=`.** The test calls `listChromeProcesses(exec)` without passing
`'win32'`, so on Linux it runs the POSIX branch. This is a test portability defect: it can only pass on Windows.

**F7 — runner-sweep #2 "run-tests sweep kills a chrome a test file leaks (token match)": `runner sweep
logged no kill — the leaked chrome was not caught`** (inner run: `chrome sweep (post-run): 0 matching
chromes`). The 2026-09-25 `process.on('exit')` guard in `src/browser/ephemeral.ts` SIGKILLs the fixture's
deliberately leaked Chrome when the test process exits, so nothing is left for the runner sweep to kill.
The leak guarantee holds (0 leftovers after every file), but the test's premise no longer does.

### Environment findings (cloud recipe / fresh clone)

- **E1** — scaffold #1, #3: `ENOENT ... mkdtemp '<repo>/.build/tmp-scaffold-XXXXXX'`. `.build/` is gitignored and
  absent in a fresh clone. Passes 15/15 after `mkdir .build`.
- **E2** — `page-scripts.test.ts` launches Playwright with `channel: 'chrome'`, which needs
  `/opt/google/chrome/chrome`. Without it the `before` hook fails and the process hung for over 10 min, because
  the fixture server stays open. Killed; passes 15/15 after symlinking that path to the wrapper. The cloud
  recipe does not cover this path.
- **E3** — the wrapper chowns only the `--user-data-dir` itself. When that dir's parent is a root-owned 0700
  dir (a `mkdtemp` home in the lazy-chrome gate, or the default `~/.jev-browser-wingman/profile` under
  `/root`), Chrome running as `nobody` cannot traverse it and never starts. The result is
  `Chrome did not answer on port N within 10 s` (reproduced with `chrome ensure`). The bench profile
  (`bench/.home/profile` under 755 dirs) is unaffected. This also matters for Part 3: a fresh install as root
  with the default `profile_dir` would hit it.

## Part 1 — gates

- `lazy-chrome.mjs --dist dist` -> `LAZY-CHROME: ok listed=24 chrome=0 answered=false`.
- `lazy-chrome.mjs --dist dist --known-bad tool-call` -> rc=3 `lazy-chrome: browser_snapshot returned an error
  result` (twice). The error content was `with-chrome: Chrome did not answer on port 41989 within 10 s.` (E3).
  With a one-line diagnostic `chmod o+x <parent>` in the installed wrapper copy only (later reverted to the
  reviewed version): `LAZY-CHROME: FAIL listed=24 chrome=10 answered=true` (known-bad PROVEN, with that
  environment help). The plain gate also stays `ok` with that change.

## Part 1 — known-bad proofs

Each flip was built into its own `dist-kb-<id>` (scoped build of the test and `src/cli/main.ts`). The source
was restored with `git checkout -- <file>` and the tracked tree confirmed clean each time. Baselines before
the flips: conformance-ops fails only playwright O6, chrome fails only #24, page-scripts and doctor are green.

| flip | result | evidence |
|---|---|---|
| CDP contenteditable select branch removed (`cdp.ts` fill) | PROVEN | `cdp` > `not ok 4 - O4 fill replaces the contenteditable text` (only new failure) |
| CDP `scroll_to` no-op | PROVEN | `cdp` > `not ok 14 - O13 scroll_to brings Far away into view and clicks it` |
| CDP `reload` no-op | PROVEN | `cdp` > `not ok 15 - O14 reload resets the page` |
| CDP ShiftTab modifiers dropped | PROVEN | `cdp` > `not ok 16 - O15 press ShiftTab in Second moves focus back to First` |
| CDP SelectAll modifiers/commands dropped | PROVEN | `cdp` > `not ok 18 - O17 press SelectAll then Backspace empties the field` |
| page-scripts file-input implicitRole reverted (verify copy, line 445) | PROVEN | `not ok 15 - a labelled file input enumerates as button and verifies (A1)` |
| win32 Opera candidates dropped (`chrome.ts`) | PROVEN | `not ok 19 - win32 candidates: ...` (+ `not ok 22 - findChrome falls through to Opera...`) |
| Windows process filter -> `chrome.exe` only (`process-list.ts`) | NOT PROVEN (cannot discriminate on Linux) | #24 fails before and after the flip with the same `missing Name='chrome.exe' in: ps -ax ...` (F6) |
| doctor forced+enforce WARNING omitted | PROVEN | `not ok 23 - handoff Q4: forced + policy.mode enforce appends the WARNING, status unchanged` |

## Part 2 / Part 3

Not run: Part 1 is not green (F1, F2, F4-F7 are new and unexplained by CLAUDE.md). Nothing was run
against `bench/run.ts`, so no results JSON was produced. The bench phase ledger (`bench/results/*.json`) holds
USD 5.814594 of history; `--phase-cap-usd` would have needed that plus the new authority.

## Linux-only coverage

All results are Linux-only. Not covered: the win32 PowerShell process listing/sweep (`chrome-cmd` #8
skipped; chrome #24 cannot pass here), Windows candidate *discovery* (the tests exercise only the path-list
logic), `taskkill` paths in `ephemeral.ts`/`run-tests.mjs`, and the Windows window show/hide behavior.
