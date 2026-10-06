# jev-browser-wingman — execution notes

Build spec: `pa/plans/2026-09-19-jev-browser-wingman-SPEC.md` in the PA repo
(dispatch authority; builders execute verbatim; the absolute host path is
withheld — this file rides a public-bound repository). Gates:
`node scripts/build.mjs`, `node scripts/run-tests.mjs [--dist <dir>] [basename ...]`,
`scripts/gates/{import-boundary,notices,lazy-chrome,readme-bench,doc-safety,window-mode}.mjs`.
Per-round build specs live in `.build-r*-spec.md` with their
execution notes (r17c-r23 specs and the r17/r19 mutants runners are tracked; the
earlier specs and `.build-r*-intake.md` files stay untracked); this file holds only durable knowledge. Loop/evidence
internals: `src/core/CLAUDE.md`. Launch texts (thread, posts,
`blog-draft.md`, `blog-assets/make_visuals.py` — regenerates the blog PNGs
and audits every drawn number) live in untracked `.launch/`.

## Brain files (read the one that matches your work BEFORE touching it)

- **Read `bench/CLAUDE.md` § Bench harness before touching `bench/` or interpreting results** — bench prompt/spawn layer, spend ledger and caps, results-file semantics, fixture server, grader-replay, public-number provenance, the t9 fragmentation diagnosis.
- **Read `tests/CLAUDE.md` § Test infrastructure & stubs before writing, running or debugging any test in `tests/`** — stub/FakeDriver traps, runner invocation and dist freshness, off-screen headed Chrome tests.
- **Read `tests/CLAUDE.md` § KB-mutant methodology before adding, flipping or proving a KB flag, or running the mutants pass** — flag polarity, runner anchors, hard-kill cleanup.
- **Read `bench/CLAUDE.md` § Spike & cloud harness before touching `spike/` or `bench/cloud/`** — the spike's dist-adapter mode and byte-deterministic results, the cloud chromium wrapper's ancestor-chmod rule.
- **Read `src/core/CLAUDE.md` before touching the loop, evidence, chain or page-scripts internals** — per-round mechanisms (r17, r20-r23), decision rules, pinned-by-grep contracts.
- Root (this file) keeps what must fire anywhere: loop/evidence rules, tool-text and delegation policy, Chrome lifecycle & teardown and Machine traps (both fire on EVERY test or bench run: the token sweep, the leak defences, the 16 GB wedge, the reaper), adapters/CDP, enumeration, PA tooling, known failures.

## Consolidation discipline

Budget: root `CLAUDE.md` <= 40,000 chars soft, 46,000 hard (`wc -c`); leave
headroom for additions. Move, never drop: when over budget, relocate a topic
to its folder-level `CLAUDE.md` (it auto-loads where the work happens) or to a
sub-file behind an active pointer ("**Read X § Heading before touching Y**",
X in backticks; the pointer token must prefix-match the destination
`## § Heading`). Deletion is for content that is STALE (evidence: a commit or a src file:line),
DUPLICATED on another loaded surface (name it) or trivially recoverable (name
the grep) — never to hit a size target. New gotchas merge into their TOPIC
section in the file where they fire, never a new dated section. Before
landing a restructure, run the preservation gate (`.calib/brain-check.py`,
untracked): every old line's distinctive tokens must appear in one
destination paragraph or be a listed exemption in `.calib/brain-exemptions.md`.

## Campaign summary (r10-r23b, 2026-09-29 -> 2026-10-05; v0.3.0 RELEASED)

~20 validation rounds hardened the forced-verdict/optional-mode loop: r15
post-action ends -> r17 press/dialogs/login suppression -> r18 harness-3
bench reporting + local fixtures -> r19 upload evidence, enumeration
coverage, byte-slice fix -> r20 optional-mode
post-action note + reset-nav retry -> r21 scoped captcha, cursor-pointer
(REJECTED by the D12 live bar, see Enumeration), nav-settled clicks,
grader-replay harness -> r22/r23b t9 recovery fixes (nav-shaped act retry,
resume-skips-post-action, engagement/post-action line reconciliation) ->
r23. Per-round mechanisms: `src/core/CLAUDE.md` r17/r20-r23 sections.
r23 ENDED THE HEROKUAPP DEPENDENCY: 15 of 17 gauntlet shapes run on
byte-faithful LOCAL fixtures (fixtures/pages/, served by src/fixture-server.ts
incl. nested paths); t10 saucedemo + t11 todomvc stay LIVE as real-web canaries. v0.3.0 tagged;
GitHub release live; the README publish table comes from the r23b
deterministic 68-cell run (forced 34/34; r19 6da6108 was the last
live-site table). Round narrative: `.build-r*-spec.md` files; bench evidence:
`bench/results/` (second-stamped, never overwrites); history: results
branches + PA memory. Known live-site residue: the-internet stalled ~30 s on
~1-in-3 requests for two days (r22/r22b probes) — keep the observational
probe if it returns.

## Loop & evidence rules (harness-visible)

- **The escalation bounce note is bounce-only by design**: bounces are exactly
  `fallback`/`step-uncertain` and `fallback`/`target-covered`; the per-goal
  counter (module-level `Map` in loop.ts, keyed on goal text; optional mode only — forced mode never touches it) counts only
  those; tiers 2/3 REPLACE the note, tier 1 appends. Never on post-action
  ends — not target refusals; tiers 1-3 steer back into repeating the action
  (the r20 post-action branch is FIRST in `finish()`'s § 3.17 else-arm,
  before the escalation `if`). `takeover-offered`, `budget-*` and
  continuation `target-uncertain` ends keep the static § 3.17 table. Test
  consequence: takeover note-table and covered-target tests need fresh goal
  texts — earlier bounce tests share the process-level counter (per-file,
  not per-test).
- **The takeover continuation bar was never the takeover threshold** — until
  2026-09-21g (2960760) it rode § 3.7 rule 6's fixed `THRESHOLDS.target`
  (0.5) with NO candidate-set check; multi-candidate 0.55 rounds acted
  mid-takeover. The two-part rule now lives in rule 6 behind the `takeover`
  flag; `wingman_do` keeps the fixed bar. Threshold narratives are intent,
  not code — read `decideTarget` and the constants first.
- **The pre-2026-09-22 entry commit never checked the floor on the CHOSEN
  element** — `set.size === 1` committed any lone candidate at ANY grade
  (the floor gated only rivals). Cite the margin rule, not the old candidate
  set, in any "entry floor is 0.5" narrative.
- **The two-stage decision map is stage-2's alone**: `{...primary,
  ...secondary}` takes request 2's target answer wholesale and stage 2
  re-grades from scratch — a dominating stage-1 grade never enters the
  decision; the margin rule fires only when ONE answer map holds both the
  dominating element and the beaten meta-answer.
- **browse_step entry on two-stage pages used to ALWAYS bounce
  `step-uncertain`/`no-match`**: `entryUncertainty` read `answers['action']`
  from request 2, which never carries `action` (plain `wingman_do`
  unaffected — decideTarget gets both maps). Fix (2026-09-21h): entry gets
  `{...primary, ...secondary}`; the covered-target gate sits between entry
  commit and `decideTarget` — before any value ask, after the retry decision
  — so a covered target costs one ask, zero acts, no self-retry. The
  two-stage test only covered non-entry rounds, which is why the suite stayed green.
- **`BUDGET_LIMITS` validates config `budgets.*` only** (`max_steps` [1, 24], dea43b5); caller overrides are checked inline in loop.ts: `wingman_do` 1-8, `browse_step` 1-24. `runDoRounds` takes `min(caller max_steps, config 24)`.
- **Raising the step budget does NOT stop caller call fragmentation**: the long-chain bottleneck is the calling model's planning; wingman machinery is
  ~1 s/round, noise at wall scale.
- **The `budgets` validation pattern silently accepts `NaN` thresholds** —
  `typeof v !== 'number' || v < min || v > max` passes NaN. `budgets.*` is
  saved by `Number.isInteger`; any future plain-number config key needs an
  explicit `Number.isFinite`.
- **Jev's grades are bimodal and honest about element choice, never
  actability**: 0.83-1.00 when well-labeled, 0.37-0.38 when genuinely ambiguous — yet 7/9 executed high grades hit `CoveredTargetError` (overlay-class covers: sticky header/consent overlay; a styled select covered by its control),
  and the question set has no "is it covered" probe (`blocked` asks only
  captcha/paywall/etc). Jev over-refused t9 form steps that execute
  fine — the routing criterion needed recalibration (pre-pass since removed), not the element table.
  Re-asks are bimodal too (0.66 then 0.48 on the same step): a sub-floor re-ask bouncing under the margin
  rule is correct, NOT a regression — validate grading-shape fixes by
  measured-map replay (`.calib/probe6b-replay.mjs` pattern), never one
  natural re-ask.
- **The § 3.18 routing pre-pass and `buildRoutingRequest` are gone** (16081ef, 2026-09-21): browse_step entry is first-round-decides (§ 3.19).
- **`observeTimed(pageId, history)` takes the round's history array** (the
  round-top call in runDoRounds passes it; runCheck passes nothing, so a
  wedge there still throws immediately). r21b gate: a SLOW first-observe
  failure (>= 2 s) retries (same two inner retries) only when NAV-SHAPED —
  message matches `NAV_SHAPED_OBS_ERROR_RE`
  (`/evaluation timed out|Execution context/i`, both adapters'
  evaluate-timeout/context-destroyed shapes) AND the last history entry is
  click-family (`CLICK_FAMILY_OPS`, read BEFORE `annotateLastOutcome` —
  the previous round's act). The nav-shaped slow path's first settle is
  `PRE_CLICK_SETTLE_MS` (4000); everything else keeps `OBS_RETRY_SETTLE_MS`
  (500). `KB_OBS_RETRY` disables all of it. loop.test.ts pins (beside the
  r21 pins): slow-nav-shaped-after-click retried (fail-first red against a dist-patched
  pre-amendment gate), the old wedge pin covers the no-prior-act slow throw
  (green both sides), KB flip kills both retry pins.
- **Hand-back triage**: a `fallback/step-uncertain` hand-back AFTER a landed
  act (`element gone` / `page changed`) is usually an under-graded stepDone
  (0.2-0.5 vs the evidence bars: `stepDoneWithEvidence` 0.5 for fill/select/check, `stepDoneWithNavEvidence` 0.25 for a landed own click that left the document), not target uncertainty — check whether
  acts ran (`historyResult`) before blaming target thresholds. Ranked
  fixes are in untracked `.build-r24-intake.md` — read it before any
  hand-back or ready-gate change.
- **Ready-gate hypothesis (UNTESTED)**: the goal text rides in the ready
  question's state (`chainRoundState` -> `buildState(... doInput.goal ...)`),
  so a goal like "wait until the hidden text appears" can depress readyP on
  the start page.
  Confirm by replay before acting.

## Tool text, delegation & policy

- **A tool description that leads with WHAT then lists prohibitions gets
  skipped.** Fix (39bb27e): first sentence = WHEN (one bounded goal), then a
  prefer-over-driving line WITH the benefit, then a do-NOT-use line; example
  verbs must cover the target task shapes. Schema friction ruled out (only `goal` required). `wingman_do` has since moved to DESCRIPTION v3 (3b44106: '>3 clicks' DEFAULT opener, anti-interleave rule last); only the check text keeps this shape.
- **Exact-string pins must inline the SPEC's text as the expected value** —
  a pin importing the same constant the code uses compares code to code and
  never sees spec drift. Add the spec-inline comparison, not a same-constant
  mirror.
- **Policy-neutral tool text (2026-09-25)**: descriptions no longer name a
  policy or a browser tool (`WINGMAN_DO_DESCRIPTION`,
  `WINGMAN_CHECK_DESCRIPTION`, `BROWSE_STEP_DESCRIPTION` in
  `src/surfaces/tool-text.ts`) — the server (`policy.mode`, re-read every
  call) is the sole enforcer; `loop.ts`'s `finish()` sets a fallback's
  `note` for any `sensitive-*`/`unsupported-page` reason to
  `SENSITIVE_LINE`, or `FORCED_SENSITIVE_LINE` for browse_step/wingman_do
  when `handoff.mode` is forced (loaded-config default; 3ac2c7f);
  `wingman_check` always `SENSITIVE_LINE`; bypassing `CONTINUE_LINE`, the browse_step note
  table and the bounce counter — where the caller learns to hand a step
  back to its own browser tools. Descriptions are served once per session,
  so this is the only way a policy change reaches caller behaviour. The
  wingman attaches over CDP; it acts on the one visible tab or the tab
  `url_match` names. Spec:
  `pa/plans/2026-09-25-wingman-policy-neutral-tool-text-SPEC.md`.
- **Tool text alone does not win delegation — withholding does.**
  Route-neutral prompts dropped `wingman_do` on the long chain (`typesafe.calls = 0`); with
  `browse_step` beside raw tools the caller never chose it; browse-only
  tool lists alone gave give-up-early "wins". Forced handoff (raw page tools withheld) made delegation stick. Pre-forced
  history: `WINGMAN_BROWSE_ONLY=1` (env since removed) fixed tool selection
  but Jev bounced all delegations back (`route-caller`, zero takeovers) and
  the caller declared DONE early — wall "wins" were give-up-early; an
  engagement line raised calls 0->5 but they fell back (`jev-error` then the
  binding defect), and the t9-shaped chain did not complete by delegation
  (the fallback lane WAS the run: `fallback` reason `sensitive-auth-path`). `BROWSE_ENGAGEMENT_LINE` is
  single-line ASCII (em-dashes fold in win32 cmd).
- **The caller's forward-vs-re-send recovery choice is not determined by the
  note branch**: r20 cell 1 forwarded under the new post-action note; r21b
  re-sent the full chain under the old-equivalent tier-1 note (its first call
  ended `multi-match`, so S-1a never fired). FORCED_ENGAGEMENT_LINE's
  "call it again with the same arguments" conflicted with
  FORCED_POST_ACTION_LINE's "only the steps after this one"; the small
  caller resolved that conflict unpredictably. r22 F-3 (5c13fa0) added the
  post-action exception to FORCED_ENGAGEMENT_LINE (bench/run.ts);
  BROWSE_STEP_DESCRIPTION's 'same arguments' sentence is unchanged; not
  re-measured since.

## Chrome lifecycle & teardown

- **The runner token sweep is the leak guarantee; per-test finally-blocks
  are best-effort only.** Every `run-tests.mjs` invocation mints a unique
  `WINGMAN_RUN_TOKEN`, passes it to each spawned test's env, and — on every
  exit path (plus a sync `process.on('exit')` fallback) — kills any
  chrome.exe whose command line carries `wingman-ephemeral-<token>` (the token rides the `--user-data-dir` profile name; PID tree, logged `RUN-TESTS: chrome
  sweep (...)`). `launchEphemeralChrome`
  puts the token in the profile dir name; production and bench
  (token unset) unchanged. A sync exit-registry backstop in `tests/helpers/chrome.ts` tree-kills any browser still registered. Fail-first proofs: `tests/runner-sweep.test.ts`; the leak fixture
  `tests/runner-sweep-leak.test.ts` is the drill target — never "fix" it.
- **The token sweep cannot cover a hard-killed runner** (SIGKILL/taskkill of
  run-tests.mjs itself): sweep manually by the `wingman-ephemeral-` cmdline
  marker — never a Chrome whose profile is the shared browser profile.
- **Never tag a test Chrome with an extra unknown switch**: headless chrome
  writes `DevToolsActivePort` but its HTTP endpoint never answers, so the
  endpoint reads dead (A/B proven). Tagging must ride `--user-data-dir` (as
  the token does) or another blessed argument.
- **Ephemeral-Chrome leak defence (src/browser/ephemeral.ts), three
  layers**: profile dirs embed the launching pid
  (`wingman-ephemeral-<token?>-p<pid>-...`, token before pid so the
  substring match still hits); a `process.on('exit')` guard tree-kills
  anything this process launched and never closed; `sweepOrphanedEphemeralChromes` (memoized, top of every launch) kills tagged root chromes whose owner pid
  is dead and removes their profile dirs, aging untagged legacy dirs out
  after 24h (never kills a legacy chrome — untagged can't prove orphanhood).
  Launch failures (e.g. the `DevToolsActivePort` 30s timeout) kill the tree
  and remove the profile dir before rethrowing.
  `tests/ephemeral-sweep.test.ts` uses injected fakes only; any test
  launching a real Chrome runs alone in the foreground.
- **Chrome's own child processes carry `--user-data-dir` but never the
  debug port** (`--type=gpu-process`, `--type=crashpad-handler`, ...); the
  main browser process never carries `--type=`. Holder detection counting
  every chrome.exe on the profile marker FAILs preflight G4 / verify V4 /
  doctor `profile-safe` while the managed Chrome is up. Fix b9f3b14:
  `profileHolders` skips cmdlines containing `--type=`. **Gate semantics
  are "FOREIGN holder", not "any holder"**: a chrome on ANOTHER profile is
  never a holder of this profile; a foreign chrome on THIS profile without
  a port still fails the gates (fixture matrix in `tests/chrome.test.ts`).
- **A minimized Chrome window rejects a position-only
  `Browser.setWindowBounds`** — restore (`windowState: 'normal'`) before
  moving; `chrome hide` restores first, `chrome show` restores by
  definition (the restore takes the foreground — that IS show, RO-7).
  **`Browser.getWindowForTarget` is per-page**: collect distinct
  `windowId`s over page targets or you move one window N times.

## Adapters & CDP

- **A CDP session attached AFTER `Target.createTarget` has navigated
  evaluates against the pre-navigation context** (`location.href` =
  `about:blank` while `Target.getTargets` shows the new URL). Attach first,
  then `Page.navigate` over that session (`bench/run.ts` `resetPages`).
- **`/json/new`'s target shows the new URL in `/json/list` BEFORE the
  document swaps** — an attach in between enumerates the pre-navigation
  document (`state.url` = `'nullblank'`, zero elements; the intermittent
  `no-match` flakes). Wait for the target's `<title>`, not its URL
  (`openFixturePage` does).
- **`src/adapters/playwright.ts`'s `back` op**: `goBack()` resolving null is
  NOT a reliable "no previous page" signal (bfcache AND same-document
  navigations both resolve null), and URL before/after comparison fails for
  repeated `pushState(state, '', location.href)`. The robust check is the
  real stack: `rec.session.send('Page.getNavigationHistory')`, throw when
  `currentIndex <= 0` (mirrors cdp.ts). Bound it with a plain timeout like
  every other CDP round-trip.
- **The cdp adapter's `act()` must propagate `actRaced`'s return** — the op
  switch lives inside `private actRaced(...)`, and a bare
  `await this.actRaced(...)` on the element-targeted path silently discards
  any act-returned value (playwright's switch is inline; same edit there).
  A new act-returned value needs BOTH the switch-case
  `return` AND `return this.actRaced(...)` at the targeted call site; the
  targetless path discards deliberately.
- **`Driver.act` returns `Promise<void | string>`** — a check/uncheck that
  flipped returns `'checked'`/`'unchecked'`, stored as the history entry's
  `result` at act time behind `KB_CHECK_FLIP`; `annotateLastOutcome` leaves
  pre-annotated entries alone. FakeDriver scripts it via `nextActResult`.
- **`driver.attach`/`detach` (cdp.ts) provably sends no page-touching CDP**
  — connect + `Target.getBrowserContexts` + `conn.on(...)` subscriptions;
  `CdpConnection.on` is a pure listener registry. Any coexistence
  fingerprint flip is ambient Chrome state or a probe-eval timeout, never
  the attach; diagnose there first.
- **`prompt()` never resolves after the driver detaches on this machine's
  headless Chrome** — the detach clears the browser-side dialog
  (`Page.handleJavaScriptDialog` from a second session then answers `No
  dialog is showing`) but the renderer stays WEDGED forever: every later
  `Runtime.evaluate` on that tab times out, and dialog.html's `'dismissed'`
  write NEVER lands (never observed anywhere, local or cloud; 4 repro runs). The E16 check passes on `log === null` (unreadable page) or `'dismissed'`; a RESOLVED prompt (`#log === ''`) is the only failing shape (tests/chain-e2e.test.ts). Don't tighten it to `assert.equal(log, 'dismissed')` — unreachable here.
- **Doctor coexistence fingerprint must contain only state whose change
  proves a WRITE into the page** (`src/cli/coexistence-probe.ts`): a 500 ms
  sentinel-eval timeout was read as `dialogOpen` (a starved renderer is not a
  modal dialog — the sentinel now retries once with a 4 s budget), and
  `visibility` is ambient state no known-bad driver pins (dropped from
  `ProbePage`; the key-set pin in doctor.test.ts keeps it out).
  **`fingerprintsReconcile`'s guarantee is "healthy-before teeth", not "all
  writes"**: a degraded before-read proves nothing, so the one-shot before
  re-read (post-attach) accepts a persistent attach-time write coinciding
  with an unrelated degraded before; both-healthy and both-degraded
  mismatches still fail with zero probes. When a retry is guarded by a
  predicate, check the predicate fires in the failure mode the retry exists
  for (`onlyUrlsChanged` was false on a nulls-vs-values pair, so the retry
  never fired).

## Enumeration & page-scripts

- **"Jev said `none`" is an enumeration-candidacy question first**:
  `isCandidate`/`isCandidateTag` (`src/core/page-scripts.ts`) are the single
  choke point — no matching attribute/tag/role means the target NEVER
  enumerates, and no grader change can fix it (delegation-only divs bind
  via JS listeners, no inline `onclick`; `th` enumerates since r19). Signature: the log's
  `target1: "none"` at high confidence. Check enumeration before grader
  text or thresholds.
- **Cursor-pointer candidacy is a REJECTED, REMOVED heuristic (r21 P-5 ->
  D12, 2026-10-04)** — do not re-propose it. The D12 live bar measured
  +88% to +298% candidate inflation against the +30% cap (local wall numbers
  had accepted it; the real failure was candidate quality, not time). Shipped `page-scripts.ts` carries zero
  cursor arms (grep `cursor` = 0); the rejection is final, not a flag
  default. `fixtures/pages/pointer-interactive.html` stays as the boundary
  fixture: delegation-only pointer-styled divs (framework menu items with
  no onclick/role/own listener) do NOT enumerate, pinned zero-records in
  `tests/pointer-enum.test.ts` (iframe/shadow boundary pins: `tests/page-scripts.test.ts`).
- **`el.className` on an SVG element is an SVGAnimatedString object**
  stringifying to `'[object SVGAnimatedString]'` (F3): any RE match over
  className silently misses every SVG-carried class. Read
  `el.getAttribute('class')` instead (works for HTML and SVG). The captcha
  id/class arm in page-scripts.ts now does; the repeatedGroups signature build (`String(gn.className)`, r17 C8) keeps className by design — SVG
  groups there read as one `[object...]` bucket, harmless for tallies, but
  any future CONSUMER of that signature must know.
- **`CAPTCHA_RE` is scoped to real challenge widgets**: a match
  counts only on a visible, non-`size=invisible` element of area >= 16000
  px² (`CHALLENGE_MIN_AREA`); `KB_CAPTCHA_SCOPED` restores the old
  whole-page substring match (it blocked bbc/npr/guardian — reproduced 2026-10-04, results branch r21 commit 4384f0e; the scoped rule clears all three).
- **Headless GitHub serves the loop a reduced repo page** (154 elements, no
  Issues/Star/search targets) — Jev's `none` answers were honest; the table,
  not the grader, was the bottleneck.
- **A label with `for` — or a wrapped control — is OWNED**: `siblingLabel`
  must skip owned labels or a hidden input adjacent to `label[for=x]`
  steals x's name (the #16 cloud failure: `#t7` next to `label[for=t6]`
  enumerated as "Fine print" with `controlPath: '#t7'`).
- **Clicking a bare sibling `<label>` does NOT toggle the hidden control**
  (no wrap, no `for` -> click is inert). The adapters activate the control
  itself when the label click did not flip (`KB_CDP_CHECK_TOGGLE` /
  `KB_PW_CHECK_TOGGLE`; composed `!KB_X`, default `false` — the
  direct-control toggle runs in shipped builds and the live check needs NO
  flag flip; flipping a flag must make the check fail, and that failure is
  the mutant proof, not a regression). `KB_PW_CHECK_TOGGLE`'s local proof
  lives in `tests/adapter-playwright.test.ts` ("sibling-label hidden
  checkbox"), asserting the checkbox state over a SECOND connectOverCDP
  (not the adapter's own observe); mapped as the flag's expected-fail leg
  in `.build-r17-mutants.py` (UNIT, not CLOUD). E19 maps only
  `KB_CDP_CHECK_TOGGLE`.
- **Enumerate probe semantics**: `elementFromPoint` at the rect center; a
  point off-viewport answers null and is NOT evidence of a cover
  (`obscured` stays false), and a `pointer-events: none` cover is skipped
  by the browser — act-time `CoveredTargetError` remains the backstop.
- **`pathEl.closest('table')` must run on pathEl, not el** (r19 D2): for a
  proxied hidden control the record's path is the label, and the table
  context must agree with the path the verifier re-finds (defensive — no
  fixture exercises a proxied control inside a table yet).
- Calibration probe artifacts live in untracked `.calib/`: the ask-spy
  wrapper records per-ask target probabilities, the direct-Driver phase
  executes Jev's own top candidate for would-succeed evidence, verification is outcome-based
  main-world evals. The spy's `twoStage`/`groupCount`
  fields under-report — the reliable two-stage markers are per-ask `count`
  ~ 90 and askCount = 4 for 2 rounds.

## Machine traps (this box)

- **The full suite cannot complete as ONE `node --test` invocation** (16 GB
  box): parallel fan-out holds 160-225 Chrome processes, the machine wedges, the
  runner hangs past an hour buffering. Work in scoped serial
  chunks of 3-12 basenames against built `dist/`; expect one parallel-load
  flake (a `Page.navigate` cdp timeout) per heavy chunk — rerun the
  basename alone before calling it a defect. Even a scoped run can take 40+
  min under load, and a single file can ACTUALLY HANG (`adapter-cdp.test.ts`:
  ~50 min with 48 leaked chromes; alone in the foreground ~1-3 min depending
  on load, once 65-77 s). **Prefer foreground runs with an explicit tool-level timeout
  (this harness's Bash `timeout_ms`, not a shell `timeout` prefix)** over
  backgrounding+polling — a background run cannot distinguish "buffered"
  from "wedged", and a Monitor on the completion line has the same blind
  spot.
- **The memory-pressure reaper kills idle-session background shells and
  the Chrome they spawned** — including a RUNNING bench cell mid-flight
  (no results file, no ledger entries) and backgrounded scoped gates (one reap orphaned ~100+ test chromes; 111
  swept). Chrome-backed adapter files go foreground, split per-basename
  (adapter-cdp ~1-3 min depending on load, adapter-playwright ~2.5 min,
  alone) instead of one invocation that outlives the 10-min
  foreground cap and gets backgrounded. Restart only after memory recovers.
- **The leaked-Chrome wedge is self-compounding**: past ~440 chrome.exe,
  WMI, `tasklist` AND `Get-Process` all stall — the sweep itself cannot
  enumerate. Sweep by the `wingman-ephemeral-` marker IMMEDIATELY after
  each chunk. At ~2.3 GB free even a SERIAL adapter-cdp full-file run can
  wedge (103 chromes once) — prefer a single-chrome diagnostic probe for
  shape-refresh work.
- **This box stalls `Input.dispatchMouseEvent` type `mouseMoved` by exactly
  ~5.0 s under memory pressure while `mousePressed`/`mouseReleased` answer
  in 1-3 ms** (per-send instrumentation in dist, four occurrences). Any wall-clock
  pin over a CDP click act must anchor its delta on the mouseReleased
  response — the moment the page's own click handler (and therefore any
  setTimeout chain) starts — not on act entry; a delta so anchored is
  immune to the stall, while click-act totals and raw elapsed windows are
  not.
- **Chrome lives at `C:\Program Files (x86)\...` on this machine**, not
  `Program Files`. And **`Start-Process -ArgumentList` joins array items
  with bare spaces**: embed the quotes in the argument string or an
  unquoted `--user-data-dir=<path with spaces>` splits, Chrome starts on a
  bogus profile that `ensureChrome` refuses.
- **An `Edit` whose `new_string` re-includes a block adjacent to the deleted one duplicates it** (the removed `visibility` read sat right AFTER the structurally similar `viewport` block, de78ea2; tsc catches it only when it is a redeclaration). Read the whole file after any edit that
  deletes a block next to a structurally identical one.

## PA repo tooling

- **`pa run commit` refuses paths under your OWN active reservation** —
  `pa release <id>` first, then commit. From a subdirectory it still lands
  in the PA repo root: pass wingman paths ABSOLUTE (repo-relative resolves
  against the PA repo root -> `pathspec did not match`). Active
  claims are foreign to the commit worker (COMMIT-DEFERRED): release claims
  (renew `--ttl 1`, let lapse) before committing.
- **`pa_claim` cannot reserve jev-browser-wingman paths** (they resolve
  against the PA repo); fall back to checking `pa_claims` for conflicts
  plus a clean `git diff HEAD` on the files.
- **`pa` failed to load 2026-10-03 (`Cannot find module '../lib/routing-policy.js'`); dispatch works again 2026-10-06 (`pa help`, `pa bus whoami`) — re-probe `pa run commit` before relying on it.**
- **`public_separation_check.py --mode contents` reads only COMMITTED
  trees** (uncommitted files print `SKIPPED CONTENT`): pre-commit, grep the
  owned files against `~/.pa/operator-identifiers.txt` directly;
  post-commit, run the official contents + paths scans (two
  `violations=0` lines).

## Known pre-existing failures

- An adapter-cdp form.html-table red is real: the 2026-09-26 re-pin fixed
  `tests/adapter-cdp.test.ts` "observe matches the pinned form.html table"
  (it now expects `placeholder`/`htmlId`/`obscured` explicitly), and r22
  verification ran it green twice on a quiet box.
