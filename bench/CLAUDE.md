# bench/ — benchmark harness notes

Auto-loads when working in `bench/`. Root `CLAUDE.md` still holds Machine traps (the shared port-9344 Chrome, reaper, wedge) and Chrome lifecycle & teardown; test-side material: `tests/CLAUDE.md`; loop/evidence internals: `src/core/CLAUDE.md`.

## § Bench harness

- **Adding a dimension to `bench/config.json` silently invalidates the count
  assertions in `tests/bench-cap.test.ts`** — any route/config-shape change
  must re-run `bench-cap` alongside the owning package's gate.
- **The bench wingman-route prompt lives in `bench/run.ts` `buildPrompt`**
  (`bench/claude-run.ts` is the spawn layer). The task goal rides verbatim
  in every route's prompt — before that fix the goal was in no prompt
  (t9's oracle endpoint was unreachable by instruction; pre-fix "oracle
  false" cells partly measured wandering). Fail-first proof:
  `tests/bench-browse.test.ts` ("both routes carry the task goal verbatim").
- **`max_turns` is often the binding ceiling, not knowledge**: the 7-page t9
  chain needs ~2 calls/page, so a low cap is hit first (every definitive cell
  burned exactly 25 calls at the then-`max_turns: 25`). Raise it or the wall
  measures the turn cap (config now 40; forced 30).
- **`detached: true` on the win32 cmd spawn in `bench/claude-run.ts`
  swallowed ALL stream-json output** (A/B proven: 0 vs 1954 events; fixed
  90ad51d). Never spawn
  through `cmd /c` detached.
- **A "wingman" route cell is only a wingman measurement if
  `typesafe.calls > 0`** — read `bench/results/*.json` before interpreting
  any wingman-route row.
- **A spawned bench caller can come up with NO MCP servers despite a correct
  `--mcp-config` absolute path** (contradicting `--strict-mcp-config`; the
  same shape attached fine minutes later).
  Before charging a zero-tool-call cell to a mechanism, re-probe the spawn
  flags with a trivial prompt.
- **`claude --model sonnet` resolves through the local GLM proxy**
  (`glm-5.3-flash[1m]`): `usd` prices tokens at Sonnet list rates;
  `cli_reported_usd` is the proxy's synthetic number (~1.7x higher);
  route-vs-route stays valid. Run-level `usd` INCLUDES the Jev (typesafe) cost, `llm.usd`
  excludes it: totals use run-level `usd`.
- **`phaseSpentFrom` sums ALL `bench/results/*.json` forever** against the
  hard `OPERATOR_CEILINGS.phaseUsd` — "cap USD X for this check" means
  `--phase-cap-usd = history + X`; check the history sum first. An aborted
  run still burns the whole phase authority; a phase-abort also trips any
  per-run cap under `killed_run_charge_usd` (1.5). Ledger rotation is a
  spend-authority decision, not a builder step.
- **Two concurrent bench phases on the shared port-9344 Chrome poison each
  other's results** (navigation collisions -> timeouts -> killed-run
  charges). Serialize bench phases.
- **`ensureChrome` waits only 10 s for the debug port**: a cold start can
  exceed it and the cell dies `Chrome did not answer on port 9344` BEFORE
  any spend. One clean immediate retry fixes it; a fresh profile may need a hand warm-up launch first. The same window can make the lazy-chrome
  known-bad `eager-ensure` print `ok` spuriously — rerun before diagnosing.
- **`stopChrome` skips a Chrome it did not start** (`startedByUs: false`) —
  sweep diagnostic/bench-profile chromes afterwards, including the surviving
  `--type=crashpad-handler` orphan (parent dead, `stopChrome` never sees
  it). The harness guard blocks deleting top-level drive-root dirs.
- **Results files are second-stamped** `YYYY-MM-DD-HHMMSS.json`, `_N` on a
  clash, never overwrite. `--repeats N` (integer 1-5) is a CLI flag of
  `dist/bench/run.js`.
- **The results-branch leak scan must run at the server's floor, and it has a
  known-bad case.** The r24b scan (cloud prompt Part 6, O8) checked task
  values of >= 6 chars while `REDACT_MIN_LEN` is 4, so a 4-5 char value
  (t10 `first: "Wing"`, `zip: "12345"`) passes it unchecked; run it at the
  floor AND bounded by non-letters/non-digits: a plain substring scan at 4
  false-positives (`Wing` is inside `wingman`: 277 hits in the r24b results
  JSON, more in results.md/triage), while the bounded scan reads 0 there and
  17 on the slice (r24c `bench/leak-scan.mjs`, spec
  `.build-r24c-redaction-spec.md`). It proves only `log.jsonl` — the Jev wire is never logged; the
  typesafe stub (`tests/helpers/typesafe-stub.ts`) and `grader-replay.mjs
  capture` are the only wire evidence. The held-out r24b slice with raw
  values is `.calib/r24/r24bres/log-slice.jsonl` (untracked; bench fixture
  strings, not secrets): a scan that reports zero hits on it is inert. The
  17 hits were cross-call (values bound on an earlier call of the same
  cell); r24c plan: `.build-r24c-redaction-plan.md`.
- **`grader-replay.mjs capture --call <url> <json>` (r24c)** runs `wingman.step(json)` on the url;
  consecutive calls on one url share the page and the run's single value memory, so a two-call capture is the live
  wire check for cross-call redaction.
- **A measured launch names its baseline, and the stance defaults OFF (r24b).** `bench/config.json` ships `gate_off: true` and `policy_off: true`, so a bare launch runs gate off and policy off, the stance of every publish run. `BENCH_GATE_ON=1` / `BENCH_POLICY_ON=1` opt in to confirm / enforce; the old `BENCH_GATE_OFF=1` / `BENCH_POLICY_OFF=1` are accepted no-ops, and any other value of any of the four is refused loudly (exit 2), as is ON together with OFF. `--purpose measure` (the default purpose) REFUSES to start without `--baseline <file>` (`cap-proof`, `experiment` and `--preflight-only` are exempt). r24 (2026-10-06, 10.08 USD) launched without the old off-flags and is not comparable to r23b: 34 of 50 hand-backs were gate/policy ends. Every results file records the effective run config (top-level `config`, 26 keys: stance, HEAD + tracked-dirty, routes/repeats/tasks, the model alias, the `claude --version`, the resolved model from the stream's init event, and hashes of the per-route bench-home config, the per-route MCP registration, the per-route caller argv, the served tool text, tasks.json, the prompts, fixtures/ and the playwright-mcp profile). `--baseline <file> --expect-diff <keys>` refuses (exit 2, nothing spent, no results file) on any difference outside the list AND on a listed key that does not differ; the resolved model is compared right after the first cell (exit 4 on a mismatch, one cell spent); `--preflight-only` stops after the check. r23b recorded no config: its reconstruction is `bench/baselines/r23b.json` (per-key sources inside; caller version and model are null there, so every run against it also lists `caller_cli_version,caller_model`). NOT in the config: `package-lock.json`, `bench/prices.json` and the rest of `src`/`bench` outside an allow-list (the cloud prompt checks the allow-list against the baseline commit), the caller's CLAUDE.md and auto-memory content, `TYPESAFE_BASE_URL` (a stop in the prompt) and the OS. `app.cli` is never read (`runClaude` spawns the literal `claude`); the stream-json `system`/`init` event carries `claude_code_version` and `model`, which is where the caller version and resolved model come from. The bench caller loads ambient user config (CLAUDE.md, skills, hooks), so the caller's environment is not isolated. An expected-diff key hides every change inside it: isolate an intended difference into its own key. The bench sets `WINGMAN_LOG_LABELS=1` for the wingman server only (labels and page titles in the log, redacted and capped); the flag is recorded as `log_labels` (stripped from `mcp_config_sha256`). Node and Chrome versions and hashes of the caller's init-event lists (tools, skills, plugins, agents, MCP servers with status, SessionStart hooks) are recorded under `observed` and compared to the baseline's `observed` as WARNINGS only (`BENCH-OBSERVED-WARN` lines, never a refusal; r23b.json holds all `null`, so every run against it warns). In the results JSON `observed_lists` is `{route: {tools|skills|plugins|agents|mcp_servers|hooks: {sha256, count}}}` or `null`: hashes and counts only. The name lists go to a local-only sibling file, `<resultsDir>/<results-stamp>.observed-lists.json`, which the cloud prompt does NOT `git add` (they name the caller's skills, plugins and agents). The sibling still ends `.json` and sorts AFTER its own results file (`.o` > `.j`), so any newest-file pick (`ls bench/results/20*.json | sort | tail -1`) returns the names file unless it filters `.observed-lists.json` out (the cloud prompt does; `phaseSpentFrom`, the ledger sum and readme-bench skip it because it has no `total_usd` or `purpose`). The zero-spend `--preflight-only` cannot see a stale `dist/`: git HEAD comes from git and the tool text is identical across r24 and r24b, so a dist built before the label reader (303a12a) passes it; only a smoke's title count (a prompt check) catches that, so rebuild from a deleted `dist/` before any paid launch. The caller's cwd is `bench/.home`, so `claude -p` also loads the repo's root and `bench/` CLAUDE.md files; they are in neither `config` nor `observed`. `runBench` reads git, the CLI version, Node and Chrome through the `BenchDeps.gitInfo` / `callerVersion` / `nodeVersion` / `chromeVersion` seams: inject all four in tests.
- **`wingman_phases.jev_ms` is a rounds-MEDIAN and per-round jev is
  bimodal** (cold ~926 ms first round of each delegation vs ~404 ms warm; cold
  vs warm differ ~2x): the run median tracks delegation mix, never "Jev got slower". Scroll rounds' `act_ms` includes
  the r17c growth wait (up to `SCROLL_GROWTH_WAIT_MS` = 1500 ms) — never
  read it as Jev latency; a "should have caught this scroll loop"
  diagnosis checks `scrollY` movement first.
- **Bench walls are load-sensitive at the caller-fragmentation margin** —
  the same cells varied >2x under agent load vs clean (355 s/600 s loaded
  vs 341 s/277 s clean). Never compare cells
  measured under different load; treat cross-pass wall ratios >2x as
  suspect until load is accounted for.
- **Escalation tiers must be reconstructed from log clustering, not read**:
  `bench/.home/log.jsonl` records `status`/`reason` per call but never the
  goal text, so a bounce's tier is only known when bounces are CONSECUTIVE.
  **Read `log.jsonl` twice before trusting a fresh read** (one came back
  short by 24 calls, the rest backfilled minutes later; D: write-back/AV
  suspected); `wc -l` repeat or mtime check first.
- **A leaked scratch Chrome holding the probe port silently poisons every
  later probe**: the port-answering fetch hits the zombie, whose
  backgrounded window reports `visibilityState: 'hidden'`, so every
  `wingman_do` returns `tab-ambiguous` with `jev_calls=0`. Kill scratch
  chromes by temp-profile cmdline marker (`taskkill /T /F` does not reliably
  take the tree from a plain launcher PID), poll the port CLOSED after
  teardown, fresh port per run.
- **Browse-only is config, not env**: `handoff.tools` (`"browse-only"`
  default in forced mode, `"all"` in optional) hides wingman_do/wingman_check
  from tools/list AND refuses them at call time. The old
  browse-only environment variable (name pinned in tests/bench-browse.test.ts) is gone from src (tests/mcp-server.test.ts
  asserts it is ignored; `bench/.home/mcp-browse.json` still carries it as
  stale config). With top-level `mode` off the server lists NO tools. Probe a spawned server's tool list with SDK
  `StdioClientTransport` against `dist/src/cli/main.js mcp` and a temp home
  — from inside the repo tree (scratch-dir node cannot see node_modules).
- **`wingman_do` fill probes must carry the value in `values`**: `values: {}`
  never asks the value question and ends `no-value` — a probe artifact, not
  an execution failure.
- **r18 harness-3 bench reporting**: the reporter tolerates pre-r18
  `wingman_phases` records — missing numerics read 0 and an absent
  `round_kinds` puts the whole round count in `other` (preserving
  `rounds == sum(round_kinds)`); old phases lines read `other=<rounds>` —
  legacy shape, not a bug. **`@REPO@` expansion is forward-slash by
  construction** (`expandTaskValuePlaceholders`) so values survive the win32
  cmd spawn; it happens once in `runBench` after `readTasks()`.
- **Any future `harness_version` bump must `grep -rn harness_version tests/`
  itself** — the r18 spec's "no external consumer pins HARNESS_VERSION 2"
  claim was FALSE (`tests/bench-browse.test.ts` pinned 2). Never trust a
  spec's verification note for this.
- **`runBench` starts a real localhost fixture server whenever any selected
  task is `local: true` (15 of 17 since r23; t10/t11 live)** — including fake-deps test invocations,
  which therefore bind an ephemeral 127.0.0.1 port. Two close sites,
  disjoint windows (the finally, plus a catch-rethrow over the
  prepare/wiring window) — do not merge them or move the start after
  `prepareBrowser`. URL resolution lives in pure `resolveStartUrl`; the
  local branch beats the absolute branch by design.
- **The fixture server's `.html` suffix is OPTIONAL in BOTH segment rules**
  (`src/fixture-server.ts`) — the r23 spec D1's literal regexes require
  `\.html`, contradicting its own D6/WP-B pins (extension-less task paths
  must serve). Trust D6, not the D1 literal. `/cookie` (extension-less) serving + Set-Cookie is NEW
  behavior (fail-first red pre-change).
- **Fixture-server hostile-path surface** (probed 2026-10-05): all `..`
  encodings (raw/encoded/mixed/backslash), drive-letter, null-byte and
  depth-cap cases 404; the one quirk is win32 backslash aliasing — `/status_codes\404`
  serves the nested page WITHIN pagesDir (`[^/]+` admits `\`; no escape is
  possible while `..` stays substring-rejected). Fine for 127.0.0.1; revisit if it binds wider.
- **Grader-replay capture lines carry `stage`; rounds consume N asks** (F1):
  a two-stage round makes TWO askWithCost calls, a native-select resolution
  one per chunk plus a final — a one-ask-per-round merge shifts every later
  pairing by one, silently (unmatched rounds only mark `mirrored:false`;
  capture exits 0). The merge is the exported pure
  `mergeCapture(records, asks, thresholds)` in `bench/grader-replay.mjs`;
  `askStage(request)` classifies `group`/`target`/`option`/`recover`/`round`
  (recover counts only when the SOLE question — buildRoundRequest carries
  recover as an EXTRA question next to done). A round whose
  `phases.rounds[].jevMs` never moved ended BEFORE its ask and consumes
  zero asks. Old capture files (no `stage`) still replay: the stage is
  re-derived from the request's question keys. The line's `round` field is
  the per-RECORD round index (what mirrorDecision's error-gate needs),
  never a global counter.
- The readme-bench gate picks the newest `measure` results file by name; its
  old-file fallback renders exactly the pre-r19 four-column block — context
  line + spread column appear only when EVERY summary row carries
  `wall_min_ms`/`wall_max_ms`, so a harness-2 file never gets a false
  provenance claim. The gate EOL-normalizes (a red is real); its source
  `bench/results/*.json` is gitignored, so it reds on a fresh clone.
- **The MCP server never launches Chrome** (only the `with-browser` wrap or
  `chrome ensure` does): unwrapped fresh installs fail `adapter-attach`.
  Doctor passes with top-level `mode` off; `doctor --plan` O1 checks mode.
- **Re-derive every public number from the results JSON, never from narrative**: r19 figures drifted into r23b copy and none reproduced.
  r23b per-shape (re-derived from `bench/results/publish-merged-r23b.json`
  2026-10-06): cheaper 13/17, wall faster 5/17, >=4 s slower on
  t6/t9/t11/t12/t10; 17/34 forced cells had a fallback (summary
  `fallback_rate` 0.5); raw_acts 0. The
  seven-page before/after figures are r12->r15 live-site numbers, NOT r23b. "34/34
  completed" counts the wingman setup: in 7 of the 34 forced runs the caller used retained Playwright tools
  after a hand-back (t6 x2, t9, t11, t12 x2, t16: 13 snapshot, 2
  handle_dialog, 1 find calls; counted from `tool_use_counts`, 2026-10-06). The Playwright profile has no scroll tool —
  never list scroll among its hidden tools.
- **The byte-vs-string slice trap (bench log slicing, r19)**: slicing a
  decoded string by a byte offset is silent data loss —
  `statSync().size` (bytes) + `readFileSync(path, 'utf8').slice(before)`
  (chars) corrupts the first fresh line whenever the prefix holds any
  multi-byte UTF-8 (one ellipsis sufficed; it under-counted t16/t12/t13 AND
  produced a fake "single-call cells under-count" correlation that was a
  red herring). Slice Buffers
  (`subarray(before).toString`); `tool_use_counts` (caller-side) is the
  cross-check that catches a log-slice under-count; shape correlations on
  under-counts deserve a byte-level look before a mechanism story. r23b
  `log-slice.jsonl` starts with 5 part-1 test records: drop them before
  aligning with the forced runs' `handoff_records`.
- **Round-labeled dispatch HEADs can be wrong — read each results.md header.**
  The healthy r19 bench ran 61df9bb (r16+r17+r18 all ancestors), not
  "e2b72f0 = r15 code"; the regression window is 61df9bb..009d935 (r20
  landing), which touches loop.ts ONLY for the S-1a post-action note branch.
  Any "the r16/r17 wave changed X" timing argument built from round labels
  is void.
- **Diagnose t9 fragmentation from the post-fallback RECOVERY calls, never
  the first call** — the forced first call is INVARIANT across healthy and regressed
  runs (35-37 rounds, 15-16 steps, ends fallback/step-uncertain on "click
  the Retrieve password button", progress 5/4/7, in r19, r20 and r21b alike —
  the loop drives the forgot-password submit into the site's flaky 500/result
  state every time); the +70% wall lived entirely in recovery calls: r19
  needed 2 (12 rounds); r20/r21b needed 5-7.
- **Error-end presence is the healthy/regressed discriminator**: healthy slices carry zero `error/*`/`ambiguous/*` ends (all 44 calls in the
  r19 slice); regressed rounds show
  `act-failed` (locator.click 3000 ms timeout during a scheduled navigation) and
  `page-error` on the same transitions. The loop/adapter code on that path is unchanged r19->r20, so live-site
  navigation timing crossing the loop's fixed 3 s act cliff was the remaining variable — the
  flat playwright control does NOT exonerate it (auto-waiting clicks have no such cliff; they absorb latency inside one turn).
- **A resumed-cursor re-send can bounce `ambiguous/target-uncertain` with
  jev_calls=0 and a round record carrying NO probabilities** (r21b calls 10/43: the caller re-sends the full chain after a step-uncertain
  fallback; the loop resumes at the remembered cursor clause and ends in 1
  round). An ambiguous target decision requires Jev answers, so an ask ran
  uncounted or the round record merged wrong — telemetry inconsistency;
  scoped repro in chain.test.ts needed before trusting jev_calls on
  resumed calls.
- **`bench/handback-triage.mjs` is the r24 hand-back metric** — it
  aligns the forced runs' `handoff_records` to a log slice by searching for the unique offset on (status, reason,
  rounds, steps) (exit 2 when none or several match), classifies each non-done/non-login/non-error end mechanically,
  counts cells without a wingman `done`, audits r24 rule rounds (suspect = a later call re-ran the clause), and uses
  `sum(tool_use_counts)` as the turn proxy (results files carry no turn count). r23b baseline: 32 hand-backs, offset 5.
  r24b appends, after the r24 lines (so lines 1-13 keep their meaning): `config <json|none>`, `policy_ends <n> needs_confirmation= sensitive= unsupported_page=` and `observed <json|none>` (both results-only, printed even when alignment fails), `log_stance <gate>/<policy>=<n>` (what the wingman server loaded per log record; `absent` = a pre-r24b log or a stale dist), `telemetry rounds= with_url=`, then one block per suspect (every round of that call; each round line carries `els=` and `th=`, the element count and the page-text fingerprint). The suspect rule (a later call re-ran the flagged clause) is refined by `cursor`: when the same chain was re-sent (equal `step_texts`) and both rounds carry a cursor, the cursors must match too, so a repeated identical clause is not a false suspect; logs without those fields keep the pure text rule. `--explain '<task>#<rep>'` prints one cell's calls and rounds.

- **The bench stops when the decision service is dead (r24d).** `jevDownCell(freshLines)` in `bench/run.ts` marks a cell `jev_down` when every log record of the cell is `fallback` with reason `jev-error` or `breaker-open` and the records carry zero Jev tokens; the HTTP status is never logged, so that pair is the whole signal. `runBench` ends the run after `JEV_DOWN_STREAK` (3) consecutive non-playwright cells read down; playwright cells, and a wingman-route cell whose caller never called wingman (`wingman.calls === 0`), neither count nor reset the streak (3db8249). Exit 5, `aborted: 'jev-down'` (3 = cap, 4 = baseline model); the results file and ledger keep the spend. `grader-replay.mjs capture` exits 3 on any non-ok Jev response or `jev-error` call and still writes its file. Evidence: r24c, 37 `jev-error` records after HTTP 402, ~1.1 USD of caller cells on a dead service. Tests: `tests/bench-jev-down.test.ts`, the last two capture tests in `tests/grader-replay.test.ts`.
- **Smoke cells must prove Jev is answering (r24d)**: the r24d first attempt's smoke passed checks a-j while every Jev
  call had ended `fallback/jev-error` (HTTP 402) — the 3-cell `JEV_DOWN_STREAK` cannot fire on a 2-cell smoke. Cloud
  prompts since r24d run one `grader-replay capture` call before the smoke (non-zero exit = STOP) and require non-zero
  Jev tokens and at least one non-`jev-error` record in the smoke. A run limited to live tasks (t10/t11) starts no
  fixture server, so `fixture_server` is an expected diff for such a run (r24e attempt 1 refused on it, zero spend).
- **Round history r24 -> r24e (2026-10-06/07)**: forced hand-backs 32 (r23b) -> 27 (r24b) -> 7 (r24d, 0b59cc7), forced
  median cost 0.162 -> 0.138 -> 0.124 USD; r24c lost run 2 to Jev HTTP 402. Results branches
  `bench/forced-0.3.0-results-r24{,b,c,d,e,e2}`, mirrored `refs/backup/r24*-results`; local copies `.calib/r24/r24*res/`.

## § Spike & cloud harness — spike/ and bench/cloud/

- **The spike's `--adapter dist-playwright|dist-cdp` mode** drives the
  shipped `createDriver` through `attach/pages/observe/act/detach` only
  (act ids by accessible name). The known-bad injections the Driver contract
  cannot express (`Target.closeTarget`, `Emulation.setDeviceMetricsOverride`,
  main-world eval, `Target.createBrowserContext`, dialog answering) ride a
  harness-held raw side connection; P7's cookie read uses `Network.getCookies`
  from that client. Gate I-11 PROVEN (867edab): side-channel injections
  discriminate identically. Fixture mapping: `driver.pages()` is the page-id
  source; `count(selector)` becomes an observation filter.
- **The spike's result JSON is deterministic** — a re-run reproducing wave-0
  verdicts rewrites `spike/results/*.json` byte-identically.
- **`bench/cloud/chromium-wrapper.sh`**: `chmod o+x` on ONLY the immediate
  parent of `--user-data-dir` is not enough once the profile lives more than
  one level under a directory `nobody` can't traverse (the default profile
  under `/root` — 0700 — needs `/root` itself traversable). Fix: walk every
  ancestor up to (not including) `/`, granting `o+x` only (never `o+r`).
