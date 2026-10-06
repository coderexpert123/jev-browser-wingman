# r24b like-for-like gauntlet (HEAD 922617fd037d7d5a18f6a370d8392f312f8a1011)

## Part 1 (16 files, all green, no timeouts, leaks 0)
```
chain rc=0 wall=1s leaked=0 # tests 192 # pass 192 # fail 0 # skipped 0 # todo 0 
lib rc=0 wall=1s leaked=0 # tests 1 # pass 1 # fail 0 # skipped 0 # todo 0 
outcome-evidence rc=0 wall=0s leaked=0 # tests 49 # pass 49 # fail 0 # skipped 0 # todo 0 
loop rc=0 wall=5s leaked=0 # tests 56 # pass 56 # fail 0 # skipped 0 # todo 0 
takeover rc=0 wall=0s leaked=0 # tests 37 # pass 37 # fail 0 # skipped 0 # todo 0 
questions rc=0 wall=0s leaked=0 # tests 32 # pass 32 # fail 0 # skipped 0 # todo 0 
bounce-escalation rc=0 wall=0s leaked=0 # tests 8 # pass 8 # fail 0 # skipped 0 # todo 0 
handback-triage rc=0 wall=1s leaked=0 # tests 12 # pass 12 # fail 0 # skipped 0 # todo 0 
grader-replay rc=0 wall=0s leaked=0 # tests 13 # pass 13 # fail 0 # skipped 0 # todo 0 
bench-browse rc=0 wall=1s leaked=0 # tests 31 # pass 31 # fail 0 # skipped 0 # todo 0 
bench-cap rc=0 wall=0s leaked=0 # tests 11 # pass 11 # fail 0 # skipped 0 # todo 0 
bench-run-config rc=0 wall=4s leaked=0 # tests 17 # pass 17 # fail 0 # skipped 0 # todo 0 
chain-e2e rc=0 wall=137s leaked=0 # tests 20 # pass 20 # fail 0 # skipped 0 # todo 0 
pick-e2e rc=0 wall=7s leaked=0 # tests 2 # pass 2 # fail 0 # skipped 0 # todo 0 
act-nav rc=0 wall=64s leaked=0 # tests 7 # pass 7 # fail 0 # skipped 0 # todo 0 
adapter-playwright rc=0 wall=33s leaked=0 # tests 10 # pass 10 # fail 0 # skipped 0 # todo 0 
P1DONE
```

## Preflight
```
BENCH-BASELINE: expected-diff git_head baseline="b3b9cd2f7e2e967a3d056f5ced37de0502395f79" run="922617fd037d7d5a18f6a370d8392f312f8a1011"
BENCH-BASELINE: expected-diff git_dirty baseline=null run=false
BENCH-BASELINE: expected-diff log_labels baseline=false run=true
BENCH-BASELINE: expected-diff caller_cli_version baseline=null run="2.1.291"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="df87a87fdfc42fd6628996cee7423425e563d5f404bfa65cf3c653ad13ad7929" run="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897"
BENCH-BASELINE: ok baseline=r23b.json keys=25 expected_diffs=git_head,git_dirty,tool_text_sha256,caller_cli_version,log_labels,caller_model
BENCH-OBSERVED-WARN: observed node_version baseline=<unrecorded> run="v22.22.0"
BENCH-OBSERVED: warnings=1 (preflight sees the Node version only; warnings never block)
BENCH-PREFLIGHT: ok nothing ran config={"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"922617fd037d7d5a18f6a370d8392f312f8a1011","git_dirty":false,"routes":["playwright","forced"
exit=0
```
files-outside-allowlist=0; typesafe-base-url-set=0; 7b hash line count=1

### env-names
```
ANTHROPIC_BASE_URL
CLAUDE_CODE_ACCOUNT_UUID
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
CLAUDE_CODE_ARTIFACT_ASSETS
CLAUDE_CODE_ARTIFACT_DB
CLAUDE_CODE_ARTIFACT_MULTI_FILE
CLAUDE_CODE_ARTIFACT_TYPES
CLAUDE_CODE_ARTIFACT_TYPE_CATALOG
CLAUDE_CODE_ARTIFACT_TYPE_CLOUD_CREATE
CLAUDE_CODE_BASE_REF
CLAUDE_CODE_BG_TASKS_REPORT_RUNNING
CLAUDE_CODE_CHILD_SESSION
CLAUDE_CODE_CONTAINER_ID
CLAUDE_CODE_DEBUG
CLAUDE_CODE_DIAGNOSTICS_FILE
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
CLAUDE_CODE_DISABLE_BUILTIN_ANTMCP
CLAUDE_CODE_DISABLE_TERMINAL_TITLE
CLAUDE_CODE_ENTRYPOINT
CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
CLAUDE_CODE_EXECPATH
CLAUDE_CODE_GZIP_REQUEST_BODIES
CLAUDE_CODE_HOLD_UNANSWERED_PARKED_PERMISSION
CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
CLAUDE_CODE_MESSAGING_SOCKET
CLAUDE_CODE_MESSAGING_TOKEN
CLAUDE_CODE_MODEL_CAPABILITIES
CLAUDE_CODE_ORGANIZATION_UUID
CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
CLAUDE_CODE_PROXY_RESOLVES_HOSTS
CLAUDE_CODE_REMOTE
CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE
CLAUDE_CODE_REMOTE_HERMETIC_MODE
CLAUDE_CODE_REMOTE_SDK_URL
CLAUDE_CODE_REMOTE_SEND_KEEPALIVES
CLAUDE_CODE_REMOTE_SESSION_ID
CLAUDE_CODE_REMOTE_TOOLS_FORWARD
CLAUDE_CODE_SESSION_ATTENDED
CLAUDE_CODE_SESSION_ID
CLAUDE_CODE_SYNC_SESSION_REFS
CLAUDE_CODE_SYNC_SKILLS
CLAUDE_CODE_TEE_SDK_STDOUT
CLAUDE_CODE_USER_EMAIL
CLAUDE_CODE_USE_CCR_V2
CLAUDE_CODE_VERSION
CLAUDE_CODE_WORKER_EPOCH
PLAYWRIGHT_BROWSERS_PATH
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
```
claude: 2.1.291 (Claude Code)
### ambient-context
```
CLAUDE.md now=210634c00a0f r23b=8af3e302c6f9
bench/CLAUDE.md now=5d6701666878 r23b=e3b0c44298fc
```
unexpected-diff.txt: empty

## Smoke (spend 0.404893; slice 22317 bytes, 29 rounds, 4 records)
```
a PASS
b PASS
c PASS
N=0
g PASS
i PASS
run t4-add-elements ok=true wall_ms=32070 usd=0.209118
run t10-saucedemo-checkout ok=true wall_ms=23142 usd=0.195775
total_usd 0.404893
h titles=29 PASS
d PASS
e PASS (log_stance off/off=4, handoff_records sum 4 verified above)
f PASS (with_url=29)
```
t4 ok (32.1 s), t10 ok (23.1 s).
```
BENCH-BASELINE: expected-diff git_head baseline="b3b9cd2f7e2e967a3d056f5ced37de0502395f79" run="922617fd037d7d5a18f6a370d8392f312f8a1011"
BENCH-BASELINE: expected-diff git_dirty baseline=null run=false
BENCH-BASELINE: expected-diff routes baseline=["playwright","forced"] run=["forced"]
BENCH-BASELINE: expected-diff repeats baseline=2 run=1
BENCH-BASELINE: expected-diff tasks baseline=["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t1
BENCH-BASELINE: expected-diff log_labels baseline=false run=true
BENCH-BASELINE: expected-diff caller_cli_version baseline=null run="2.1.291"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="df87a87fdfc42fd6628996cee7423425e563d5f404bfa65cf3c653ad13ad7929" run="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897"
BENCH-BASELINE: ok baseline=r23b.json keys=25 expected_diffs=git_head,git_dirty,tool_text_sha256,caller_cli_version,log_labels,caller_model,tasks,routes,repeats
BENCH-OBSERVED-WARN: observed node_version baseline=<unrecorded> run="v22.22.0"
BENCH-OBSERVED-WARN: observed chrome_version baseline=<unrecorded> run="Chrome/141.0.7390.37"
BENCH-OBSERVED-WARN: observed caller_tools_sha256[forced] baseline=<unrecorded> run="d72dfbbfcd596b3c814589988946a4ad1dc0da2dc56e3eaa6bc8949cf109ccc2"
BENCH-OBSERVED-WARN: observed caller_skills_sha256[forced] baseline=<unrecorded> run="c63abdf381ba3b8ead3567e3b54964a16572719699461ce4ceecfc2f4dc58301"
BENCH-OBSERVED-WARN: observed caller_plugins_sha256[forced] baseline=<unrecorded> run="1aa91757661dc31a707db2c2dfe082049b2bfea99bc6ef0c612ab4eb18bca9b0"
BENCH-OBSERVED-WARN: observed caller_agents_sha256[forced] baseline=<unrecorded> run="eec7d3f094f7a5f7fdd06009b5ea638630466fcf58284553c431d2756e83031d"
BENCH-OBSERVED-WARN: observed caller_mcp_servers_sha256[forced] baseline=<unrecorded> run="6f44a7ed62c2493bd71d43b8e17e493f66f71cf3756e0ea755271a0ca4da9728"
BENCH-OBSERVED-WARN: observed caller_hooks_sha256[forced] baseline=<unrecorded> run="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
BENCH-BASELINE-POST: expected-diff caller_model baseline=null run="claude-sonnet-5-5"
BENCH-BASELINE-POST: ok baseline=r23b.json keys=1 expected_diffs=git_head,git_dirty,tool_text_sha256,caller_cli_version,log_labels,caller_model,tasks,routes,repeats
BENCH-OBSERVED: warnings=8 (warn-only; nothing was blocked)
```
observed: {"node_version":"v22.22.0","chrome_version":"Chrome/141.0.7390.37","caller_tools_sha256":{"forced":"d72dfbbfcd596b3c814589988946a4ad1dc0da2dc56e3eaa6bc8949cf109ccc2"},"caller_skills_sha256":{"forced":"c63abdf381ba3b8ead3567e3b54964a16572719699461ce4ceecfc2f4dc58301"},"caller_plugins_sha256":{"forced":"1aa91757661dc31a707db2c2dfe082049b2bfea99bc6ef0c612ab4eb18bca9b0"},"caller_agents_sha256":{"forced":"eec7d3f094f7a5f7fdd06009b5ea638630466fcf58284553c431d2756e83031d"},"caller_mcp_servers_sha256":{"forced":"6f44a7ed62c2493bd71d43b8e17e493f66f71cf3756e0ea755271a0ca4da9728"},"caller_hooks
observed_lists.forced: keys=tools,skills,plugins,agents,mcp_servers,hooks counts={"tools":"object","skills":"object","plugins":"object","agents":"object","mcp_servers":"object","hooks":"object"}

## Gauntlet
```
BENCH-BASELINE: expected-diff git_head baseline="b3b9cd2f7e2e967a3d056f5ced37de0502395f79" run="922617fd037d7d5a18f6a370d8392f312f8a1011"
BENCH-BASELINE: expected-diff git_dirty baseline=null run=false
BENCH-BASELINE: expected-diff log_labels baseline=false run=true
BENCH-BASELINE: expected-diff caller_cli_version baseline=null run="2.1.291"
BENCH-BASELINE: expected-diff tool_text_sha256 baseline="df87a87fdfc42fd6628996cee7423425e563d5f404bfa65cf3c653ad13ad7929" run="a24b17c43e2afd3cd51b2ccfdf9ae8b56448b19036560bf4dabf24f0d556c897"
BENCH-BASELINE: ok baseline=r23b.json keys=25 expected_diffs=git_head,git_dirty,tool_text_sha256,caller_cli_version,log_labels,caller_model
BENCH-OBSERVED-WARN: observed node_version baseline=<unrecorded> run="v22.22.0"
BENCH-OBSERVED-WARN: observed chrome_version baseline=<unrecorded> run="Chrome/141.0.7390.37"
BENCH-OBSERVED-WARN: observed caller_tools_sha256[playwright] baseline=<unrecorded> run="eb118c362480aa65c7a91633b3418492a665483f32617faf1435bfcc67ee9161"
BENCH-OBSERVED-WARN: observed caller_skills_sha256[playwright] baseline=<unrecorded> run="c63abdf381ba3b8ead3567e3b54964a16572719699461ce4ceecfc2f4dc58301"
BENCH-OBSERVED-WARN: observed caller_plugins_sha256[playwright] baseline=<unrecorded> run="1aa91757661dc31a707db2c2dfe082049b2bfea99bc6ef0c612ab4eb18bca9b0"
BENCH-OBSERVED-WARN: observed caller_agents_sha256[playwright] baseline=<unrecorded> run="eec7d3f094f7a5f7fdd06009b5ea638630466fcf58284553c431d2756e83031d"
BENCH-OBSERVED-WARN: observed caller_mcp_servers_sha256[playwright] baseline=<unrecorded> run="9811ff690b4db4e77225c6059c9f336fa13495ca455d836a0f9da472b7ce20d6"
BENCH-OBSERVED-WARN: observed caller_hooks_sha256[playwright] baseline=<unrecorded> run="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
BENCH-BASELINE-POST: expected-diff caller_model baseline=null run="claude-sonnet-5-5"
BENCH-BASELINE-POST: ok baseline=r23b.json keys=1 expected_diffs=git_head,git_dirty,tool_text_sha256,caller_cli_version,log_labels,caller_model
BENCH-OBSERVED-WARN: observed caller_tools_sha256[forced] baseline=<unrecorded> run="d72dfbbfcd596b3c814589988946a4ad1dc0da2dc56e3eaa6bc8949cf109ccc2"
BENCH-OBSERVED-WARN: observed caller_skills_sha256[forced] baseline=<unrecorded> run="c63abdf381ba3b8ead3567e3b54964a16572719699461ce4ceecfc2f4dc58301"
BENCH-OBSERVED-WARN: observed caller_plugins_sha256[forced] baseline=<unrecorded> run="1aa91757661dc31a707db2c2dfe082049b2bfea99bc6ef0c612ab4eb18bca9b0"
BENCH-OBSERVED-WARN: observed caller_agents_sha256[forced] baseline=<unrecorded> run="eec7d3f094f7a5f7fdd06009b5ea638630466fcf58284553c431d2756e83031d"
BENCH-OBSERVED-WARN: observed caller_mcp_servers_sha256[forced] baseline=<unrecorded> run="6f44a7ed62c2493bd71d43b8e17e493f66f71cf3756e0ea755271a0ca4da9728"
BENCH-OBSERVED-WARN: observed caller_hooks_sha256[forced] baseline=<unrecorded> run="4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
BENCH-OBSERVED: warnings=14 (warn-only; nothing was blocked)
exit=0
```
BENCH REPORT 2026-10-06-140652.json purpose=measure model=sonnet harness=3 aborted=null total_usd=10.032837 runs=68
route playwright n=34 ok=32/34 wall_s min=9.8 med=13.4 max=39.8 usd min=0.070818 med=0.17630099999999999 max=0.41634
route forced n=34 ok=33/34 wall_s min=10.4 med=14.0 max=83.6 usd min=0.053943 med=0.1383475 max=0.365624

Forced 33/34: t10-saucedemo-checkout rep 1 failed (live canary; 2 calls, 6 rounds, 2 error rounds). Playwright 32/34: t15 both reps.

### triage-r24b lines 1-13
```
HANDBACK-TRIAGE results=bench/results/2026-10-06-140652.json offset=0 handbacks=27
class landed-not-advanced 12
class other 1
class press-split 2
class stuck-exhausted 1
class target-uncertain 11
no_wingman_done_cells 6 t4-add-elements#1 t6-dynamic-loading#1 t10-saucedemo-checkout#1 t4-add-elements#2 t6-dynamic-loading#2 t11-todomvc-spa#2
route playwright runs=34 ok=32 usd_total=5.422032 usd_median=0.176301 tool_calls_total=181 tool_calls_median=4 tool_calls_mean=5.323529 wall_median_ms=13448.5
route forced runs=34 ok=33 usd_total=4.610805 usd_median=0.138348 tool_calls_total=116 tool_calls_median=2 tool_calls_mean=3.411765 wall_median_ms=13984
r24_flags 12 finalNavEvidence=1 hoverEvidence=2 pressFocusSum=2 readySkipped=2 sameDocEvidence=4 stuckSecond=1
r24_flag_suspects 1 t9-long-chain#2/call8/r13/stuckSecond
handback t3-dynamic-controls#1 call1 fallback/step-uncertain why=low-confidence class=target-uncertain
handback t4-add-elements#1 call1 fallback/step-uncertain why=repeat class=landed-not-advanced
```
### triage-r23b lines 1-13
```
HANDBACK-TRIAGE results=/tmp/r23b.json offset=5 handbacks=32
class error-page 1
class landed-not-advanced 10
class not-ready 4
class other 2
class press-split 4
class stuck-exhausted 1
class target-uncertain 10
no_wingman_done_cells 6 t6-dynamic-loading#1 t12-js-confirm-dialog#1 t6-dynamic-loading#2 t9-long-chain#2 t11-todomvc-spa#2 t12-js-confirm-dialog#2
route playwright runs=34 ok=32 usd_total=5.396889 usd_median=0.176974 tool_calls_total=181 tool_calls_median=4 tool_calls_mean=5.323529 wall_median_ms=11702
route forced runs=34 ok=34 usd_total=4.855623 usd_median=0.161893 tool_calls_total=118 tool_calls_median=2.5 tool_calls_mean=3.470588 wall_median_ms=13135
r24_flags 0
r24_flag_suspects 0
```
### config/policy_ends/log_stance/telemetry r24b
```
config {"config_version":1,"gate_mode":"off","policy_mode":"off","git_head":"922617fd037d7d5a18f6a370d8392f312f8a1011","git_dirty":false,"routes":["playwright","forced"],"repeats":2,"tasks":["t1-checkboxes","t2-dropdown","t3-dynamic-controls","t4-add-elements","t5-inputs","t6-dynamic-loading","t7-sort-table","t8-status-404","t9-long-chain","t10-saucedemo-checkout","t11-todomvc-spa","t12-js-confirm-dialog","t13-infinite-scroll","t14-key-press","t15-file-upload","t16-hover-reveal","t17-double-click"],"model":"sonnet","log_labels":true,"caller_cli_version":"2.1.291","adapter":"playwright","harness_version":3,"playwright_mcp":"@playwright/mcp@0.0.80","wingman_config_sha256":{"playwright":"7db844
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
log_stance off/off=65
telemetry rounds=311 with_url=311
```
### same, r23b
```
config none
policy_ends 0 needs_confirmation=0 sensitive=0 unsupported_page=0
log_stance absent=65
telemetry rounds=328 with_url=0
```

### Step 19 like-for-like
(i) policy_ends 0 line present: YES
(ii) log_stance off/off=65 == forced handoff_records 65, only bucket: YES
(iii) BENCH-BASELINE-POST ok keys=1: YES
(iv) caller_model claude-sonnet-5-5 == smoke, not mixed; cli 2.1.291 == smoke: YES
(v) aborted null: YES
(vi) node, chrome and all list hashes (forced, playwright) equal the smoke, no mixed: YES

## Invariant: forced=34 matches=34 mismatches=0
## Suspects: 1 (t9-long-chain#2/call8/r13/stuckSecond; explain/t9-long-chain-2.txt)

## t9 forced: rep1 8 calls, 51 rounds, 55.3 s, error rounds 2; rep2 9 calls, 62 rounds, 56.1 s, error rounds 2

## Spend: smoke 0.404893 + gauntlet 10.032837 = 10.437730
LEDGER0=98.380540 LEDGER1=98.785433 after=108.818270
Log slice bytes: smoke 22317, gauntlet 228991
- gauntlet/log-slice.jsonl HELD OUT of the push (leak scan hit: a typed task value appears in it); kept at /tmp/held in the session only.
