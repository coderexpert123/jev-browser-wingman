Agents installing this package: read [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) first and follow it alone.

# jev-browser-wingman

jev-browser-wingman (wingman for short) hands your AI agent's browser clicks and typing to TypeSafe's Jev. Jev chooses which element each step acts on, handing the step back when unsure, and wingman carries out the action. The agent keeps planning and sends its page work to one tool. It attaches to a real, logged-in Chromium-family browser (Chrome, Edge, Brave and similar).

## Headline numbers

We ran 17 small browser tasks, such as ticking a checkbox or checking out in a demo shop. Each ran twice with wingman and twice with Playwright alone, in alternating order: 68 runs. "Playwright alone" means the same agent using the regular Playwright MCP browser tools directly. Playwright is a browser-automation library, and MCP (Model Context Protocol) is how agents talk to tool servers.

- **Completion:** wingman completed all 34 runs. Playwright alone completed 32 of 34 (94%). Both misses were the file-upload task, which Playwright alone missed in both runs.
- **Cost:** total spend over all 34 runs was $3.75 with wingman and $5.35 with Playwright alone, 30% lower. Wingman was cheaper on 16 of the 17 tasks. Costs are the agent's and wingman's token use at list prices, not billing. Per-run costs cluster by whether the agent's prompt cache was already warm, so the total is the steadier figure (see Results by task).
- **Speed:** the median run took 16.0 s with wingman and 15.5 s with Playwright alone, so wingman was 0.5 s slower on the median. Wingman was faster on 8 tasks, slower by 4 s or more on 3, and slower by less on the rest. The task table below shows where.

With two runs per task, read the differences as indicative, not statistically established.

## How it works

Wingman sits in front of your existing browser tool, which is an MCP server such as Playwright MCP. It hides that tool's page-action tools from the agent and keeps its reading, tab, dialog and a few other tools. The agent sends wingman its goal and its steps through one tool, `browse_step`.

For each step that needs an element, wingman looks at the page and asks Jev which one to act on. Jev grades how well each element on the page fits the step. Wingman then acts, checks the result and returns. If it is unsure, it hands that step back to the agent.

```
agent -> MCP client
           |-- [jev-browser-wingman with-browser -- <your browsing MCP server>]
           |      hides click / type / select / key / hover / upload / navigate / back / scroll / script
           |      keeps tabs, read, dialogs, screen-position clicks, drag, wait, session
           |-- [jev-browser-wingman mcp]  ->  browse_step
                              |
                              v
          one shared, debuggable Chromium-family browser
```

This is hand-off mode: wingman hides the agent's own click, type and other page-action tools, so those actions go through wingman. Dragging and clicks at screen positions stay with the agent. Hand-off mode is the default. In the config it is the `handoff.mode` setting with the value `"forced"`. It applies only while the top-level `mode` setting is `on` (see Install).

The `with-browser` command reads a profile for your browsing server. The profile sorts each of the server's tools into a category, called a capability class. These classes always stay with the agent: `pointer-xy`, `drag`, `tabs`, `dialog`, `read`, `wait` and `session`. In hand-off mode the other classes are hidden, including the agent's own `script` tool.

Set `"handoff": {"mode": "optional"}` and nothing is hidden. Set `"handoff": {"retain": ["script"]}` to keep the named classes with the agent.

## Results by task

Wingman was faster on checkboxes, the todo app, file upload, start loading (wait for hidden text), the table sort, the 404 page, the endless scroll and adding elements. It was slower by up to 3.6 s on enabling a field, text input, key press, the confirm dialog, hover and double-click.

It was 4 s or more slower on three tasks: the seven-page task (a chain of pages described under Benchmark, +12.6 s), the demo-shop checkout (+7.7 s) and the dropdown (+4.4 s). On the seven-page task the two wingman runs took 39.9 s and 51.8 s, a wide spread.

Wingman cost more on one task only: the confirm dialog (+2%). Times are median seconds per run and costs are median dollars per run, from two runs each.

A run's cost depends heavily on whether the agent's prompt cache was already warm when it started. The first run of each task mostly started cold and the second always warm, but four first wingman runs happened to start warm. Playwright alone therefore started cold in 17 of its 34 runs and wingman in 13, so the four tasks where wingman never started cold (start loading, the 404 page, the checkout and the todo app) owe part of their gap to warm starts. Pricing every cache write at the cache-read rate removes that effect: wingman stays cheaper on 16 of 17 tasks and 31% cheaper in total, with per-task savings of 23% to 50%.

| Task | Wingman s | Playwright alone s | Wingman cost $ | Playwright alone cost $ |
|---|---|---|---|---|
| Tick a checkbox | 13.8 | 16.4 | 0.113 | 0.150 |
| Choose from a dropdown | 16.2 | 11.8 | 0.113 | 0.130 |
| Enable a field, then type in it | 18.7 | 17.1 | 0.114 | 0.162 |
| Click "Add element" three times | 15.4 | 16.0 | 0.113 | 0.134 |
| Type a number into a field | 16.5 | 13.4 | 0.114 | 0.133 |
| Start loading, wait for hidden text | 16.8 | 22.1 | 0.057 | 0.136 |
| Sort a table | 12.3 | 14.5 | 0.113 | 0.163 |
| Open the 404 status page | 11.7 | 13.4 | 0.057 | 0.131 |
| Seven-page multi-step task | 45.9 | 33.2 | 0.208 | 0.299 |
| Demo-shop checkout (live site) | 29.3 | 21.6 | 0.092 | 0.193 |
| Todo app (live site) | 15.6 | 18.8 | 0.059 | 0.187 |
| Accept a confirm dialog | 16.4 | 13.6 | 0.154 | 0.151 |
| Scroll an endless page | 18.7 | 19.3 | 0.114 | 0.136 |
| Press the Escape key | 16.5 | 12.9 | 0.114 | 0.135 |
| Upload a file | 14.5 | 16.5 | 0.115 | 0.155 |
| Hover, then click the revealed button | 14.9 | 13.9 | 0.113 | 0.150 |
| Double-click a box | 13.1 | 12.0 | 0.113 | 0.130 |

## Install

You need the following:

- Node.js 22 or newer (`engines.node` is `>=22`).
- A Chromium-family browser: Chrome, Edge, Brave, Chromium, Opera or Vivaldi, found automatically in that order.
- A TypeSafe API key in the `TYPESAFE_API_KEY` environment variable. Alternatively, point `secrets_file` in the config at a `KEY=VALUE` file.

The top-level `mode` is off when it is absent from the config, so you must set `"mode": "on"` yourself. Only `handoff.mode` has a default: `"forced"`, which is the hand-off mode described under How it works.

**Step 1. Install the command.**

```
npm install -g jev-browser-wingman
jev-browser-wingman --version
```

The version check must print a version and exit 0.

**Step 2. Detect your stack and print the plan.**

```
jev-browser-wingman doctor --detect
jev-browser-wingman doctor --plan [--client <claude|codex|opencode|agy|devin|cursor>]
```

`--detect` is read-only and reports each registered browsing server by kind and mode. `--plan` prints the exact entries and config this setup still needs, one block per outcome. It never launches a browser and never contacts TypeSafe.

**Step 3. Apply the recipe for your stack.**

| Your stack | What to do |
|---|---|
| Claude Code + Playwright MCP (tested) | Launch the Playwright entry through `with-browser`, register wingman, set `"mode": "on"`. Recipe below. |
| A debuggable Chrome already running, Chrome DevTools MCP with `--browserUrl`, or Playwright MCP with `--cdp-endpoint` | Wingman attaches to that endpoint and never launches. Set `port` in the config to the endpoint's port, register wingman, set `"mode": "on"`, and launch the browsing entry through `with-browser` as in the recipe below so its action tools are hidden. |
| Extension-based tools (Playwright `--extension`, browser extensions) | They expose no endpoint. Start a browser on a dedicated profile with `--remote-debugging-port`, install the extension in that profile, and set `port` and `profile_dir` to match. Chrome 136+ ignores that flag on the default profile. `doctor --plan` prints the deny entries that withhold the tool's actions where the client supports them (Claude Code, opencode). |
| Cloud or remote CDP browser | Set `"adapter": "cdp"` and the `WINGMAN_CDP_ENDPOINT` environment variable for the wingman server. |
| No browser tooling installed | Register wingman and set `"mode": "on"`. Run `jev-browser-wingman chrome ensure` before use; it starts a Chrome on `profile_dir` and `port`, shown per the `window` setting. |
| Other MCP clients (codex, opencode, agy, devin, cursor) | Run `doctor --plan --client <id>`. Registration snippets are in [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md#register-per-client). |
| Any other browsing MCP server | Add a capability profile. Recipe below. |
| Library use | `main` is `dist/src/lib.js`; `createWingman()` returns `do`, `check` and `step`. |

### Recipe: Claude Code + Playwright MCP

Save your existing entry first (`claude mcp get playwright`), then replace it with the version launched through `with-browser`. Use the name, scope and arguments of your own entry; this example uses `playwright` and `@playwright/mcp@0.0.80`.

```
claude mcp remove playwright
claude mcp add -s user playwright -- jev-browser-wingman with-browser -- npx -y @playwright/mcp@0.0.80 --browser chrome
claude mcp add -s user jev-browser-wingman -- jev-browser-wingman mcp
```

Then create `~/.jev-browser-wingman/config.json` (make the directory if it does not exist):

```json
{ "mode": "on" }
```

Remove any launch flag the profile names, such as `--user-data-dir`, from your old arguments, because wingman owns the shared browser; `doctor --plan` prints your entry already stripped. If you want your logged-in state to carry over, set `profile_dir` in the config to the old `--user-data-dir` value. Export `TYPESAFE_API_KEY` in the environment your client starts from, and in the shell where you run `doctor`. Restart the client so it re-reads the tool list.

The launched entry starts the shared browser only when the caller first uses one of the Playwright tools that stay with it, such as a snapshot. Run `jev-browser-wingman chrome ensure` once before you start, or the first `browse_step` can hand the step back with status `fallback` and reason `no-browser`.

### Recipe: any other browsing MCP server

Wingman maps a browsing server's tools to capability classes (the categories described under How it works) through profile files. Copy `profiles/playwright-mcp.json` from the installed package to `<wingmanHome>/profiles/<id>.json` (`<wingmanHome>` is the config folder, `~/.jev-browser-wingman` by default), then change `id`, `detect.args_contain`, `match_tools` (tool names the server always lists) and the `tools` map. Set `launch.endpoint_env` (an environment variable the server reads) or `launch.endpoint_arg` (a flag template such as `--cdp-endpoint={endpoint}`) so the launched server attaches to the shared browser; with both null it keeps its own browser, which does not share the session. A user profile with the same `id` as a shipped one replaces it. A trimmed example of the format:

```json
{
  "id": "my-browser-mcp",
  "description": "My browsing MCP server",
  "detect": { "args_contain": ["my-browser-mcp"], "extension_flags": [], "endpoint_flags": ["--cdp-endpoint"] },
  "launch": { "endpoint_env": null, "endpoint_arg": "--cdp-endpoint={endpoint}", "strip_args": ["--user-data-dir"] },
  "match_tools": ["snapshot", "click"],
  "tools": { "click": "element-act", "type_text": "type", "snapshot": "read", "tabs": "tabs", "evaluate": "script" },
  "arg_rules": []
}
```

If you add no profile, wingman classifies an unknown server's tool descriptions on its first session and writes the result to `<wingmanHome>/profiles-auto/`. That step needs the TypeSafe key.

**Step 4. Verify.**

```
jev-browser-wingman chrome ensure
jev-browser-wingman doctor [--client <claude|codex|opencode|agy|devin|cursor>]
jev-browser-wingman doctor --plan
```

`doctor` fails `adapter-attach` until a debuggable browser answers on the port, so run `chrome ensure` first unless you attach to your own browser.

A verdict of `PASS` with exit 0 means no check failed. It does not require `"mode": "on"`. With mode off, the `handoff` line passes as `optional`.

The `--plan` run confirms the rest. It lists the setup outcomes it checks, labelled O1, O2 and so on, and marks each one `[met]` or not. O1, O2 and O4 should read `[met]`. For each failing check, use the Verify table in [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md#verify).

**Roll back.** Restore your saved entry with your client's own command, then run `doctor` again.

## Tools

`browse_step` is the default tool in hand-off mode. It takes the goal and its ordered remaining steps and runs them across pages: clicks, typing, selects, keys, hovers, scrolling, waits, going back, file attachments and opening supplied web addresses. When it cannot decide which element a step means, it returns the step with candidate elements.

The caller then calls again and names the element by role and name in the `pick` argument (an optional input that points at one candidate). Unfinished results carry `progress`. A call with the same arguments resumes from there.

`wingman_do` carries out one bounded goal on the already-open page: choose the right row, fill a form from values you pass, or click through a short wizard. It never navigates to URLs, opens or closes tabs, signs in, or reads pages for you. Values are typed locally and never sent to the decision service.

`wingman_check` answers one yes/no question about the visible page as a probability in `answer`. It is read-only and never clicks or types.

With `mode` on and the default `handoff.tools` of `"browse-only"`, the server lists and serves only `browse_step`. Set `"handoff": {"tools": "all"}` to list all three. In `optional` handoff mode the default is `"all"`. With `mode` absent or `"off"` the server lists no tools.

All three tools return these statuses:

| status | meaning |
|---|---|
| done | goal judged achieved (Jev's probability that the goal is done is at least 0.85, or at least 0.5 when Jev sees no action left to take) |
| needs_confirmation | the optional irreversible-action gate (config `gate.mode` set to `"confirm"`) stopped the next action; nothing executed |
| blocked | captcha, access denied, dialog open, or covered target |
| login | page asks for sign-in; tool stops before any credential surface |
| ambiguous | target probability below threshold; candidates returned |
| error | page shows an error after an action, or a tool fault |
| fallback | the tool handed the step back: the caller should do it with its own browser tools. Reasons: no browser, no key, circuit breaker open (a failure guard supplied by a plugin), sensitive surface, shadow mode (the wingman decides but acts on nothing), budget exhausted |

Labels in results are untrusted page text. Confirm tokens (see Security model) flow through MCP or the library; the CLI has no confirm-token flag.

## Writing good steps

`browse_step` decides each action from the step text you pass. Two rules prevent the most common failures.

- **Keep repeat counts inside one step.** Write "click the Add button twice" as one step. Splitting it into bare "click the Add button" steps loses the count and can over-act with real side effects.
- **Look before retrying a handed-back step.** A `fallback` result can follow real progress, and each retry compounds side effects. Take a snapshot with your own tools first.

Some results carry a `post-action` note, which means the step's action already ran. In that case do not repeat the action or reload. Call again with only the later steps.

Fix an over-executed step with another `browse_step` call, never with a raw click or script tool.

## Security model

Values typed into the page never leave the machine. By default, wingman sends page content to TypeSafe on all pages, including sensitive ones (banking, mail). Set `policy.mode: 'enforce'` to fail closed on sensitive pages: a policy hit (host categories, login paths, password and OTP page signals) returns `fallback` before any data leaves. The result carries a note telling the calling agent to take that step with its own browser tools. A policy change therefore reaches caller behavior without a session restart.

The server also remembers each value it is handed, in memory only, while it runs. A later call replaces that value with its binding name in page text and step text, even when the call does not bind it again. The memory keeps the 1,024 most recently bound values and starts empty when the server restarts.

An irreversible gate requires a single-use `confirm_token` bound to page URL, element fingerprint and verb before submit-like actions execute.

What leaves the machine: origin and path (no query or fragment), title, element roles and labels (≤80 chars), the text excerpt, the goal, the names of the values you pass (never the values) with their type hints, and a verb-plus-label history. Never leaves: values, hidden or prefilled input values, cookies, storage, screenshots, password fields. Page text is data, never instructions. Jev returns probabilities and no text, so an injected instruction can only bias a choice among a limited set of candidates.

## Configuration

Machine-local config at `<wingmanHome>/config.json` (default `~/.jev-browser-wingman/config.json`; set `WINGMAN_HOME` to move it):

| key | type | default | rule |
|---|---|---|---|
| `mode` | `"shadow"` or `"on"` | absent = `off` | any other value fails |
| `adapter` | `"playwright"` or `"cdp"` | `"playwright"` | |
| `window` | `"offscreen"`, `"normal"`, `"minimized"` or `"headless"` | `"offscreen"` | how a Chrome this package launches is shown |
| `profile_dir` | string | `~/.jev-browser-wingman/profile` | `~/…` or absolute; relative fails |
| `port` | integer 1024–65535 | 9222 | |
| `chrome_path` | string or null | null | as `profile_dir` |
| `secrets_file` | string or null | null | as `profile_dir`; KEY=VALUE lines; only `TYPESAFE_API_KEY` is read |
| `plugin` | string or null | null | as `profile_dir`; path to a module exporting `wingmanPlugin` |
| `sensitive_hosts` | object | `{}` | keys from `banking`, `payments`, `webmail`, `identity`, `government`, `tax`, `health`; values are arrays of host suffixes |
| `budgets` | object | see rule | integer keys, each optional, defaults in parentheses: `max_steps` 1–24 (24), `max_ms` 5000–120000 (90000), `jev_timeout_ms` 1000–10000 (10000), `max_elements` 20–240 (240), `max_text_chars` 0–3000 (3000), `max_state_chars` 2000–24000 (24000) |
| `gate` | object | `{ mode: "off" }` | only key `mode`: `"off"` (default) or `"confirm"`; `confirm` turns on the irreversible-action gate |
| `policy` | object | `{ mode: "off" }` | only key `mode`: `"off"` (default) or `"enforce"`; `enforce` fails closed on sensitive pages |
| `takeover` | object | `{ threshold: 0.7, mode: "auto", retry: true }` | keys `threshold`: number 0.5–0.95, `mode`: `"auto"` (act on a lower-confidence choice itself) or `"offer"` (return an offer the caller accepts with `takeover: true`), `retry`: boolean; tunes `browse_step`, leave at the defaults unless you are tuning |
| `handoff` | object | `{ mode: "forced" }` | keys `mode`: `"forced"` (default; hand-off mode) or `"optional"`; `tools`: `"browse-only"` or `"all"`; `retain`: array of capability class names kept with the caller |

Unknown top-level keys fail. The config is never synced across machines.

## CLI reference

| command | purpose |
|---|---|
| `mcp` | run the MCP server on stdio |
| `run --goal <text> [--values-file <json>] [--url-match <s>] [--max-steps <n>] [--max-ms <n>]` | one `wingman_do`; values come only from the values file |
| `check --question <text> [--url-match <s>]` | one `wingman_check` |
| `chrome ensure` | acquire the shared Chrome for the configured profile and port |
| `chrome status` | report the Chrome answering on the port |
| `chrome stop` | stop a Chrome this package started |
| `chrome show` | move the shared Chrome window on-screen over CDP (Chrome DevTools Protocol), for when you must act yourself (e.g. enter a login code) |
| `chrome hide` | move the shared Chrome window back off-screen |
| `with-browser -- <command> [args...]` | proxy that ensures Chrome just before the first `tools/call`, then forwards (`with-chrome` is a deprecated alias) |
| `doctor [--json] [--detect] [--plan] [--client <claude\|codex\|opencode\|agy\|devin\|cursor>]` | ten checks and a verdict; it edits nothing, but the `jev-round` check starts a temporary headless Chrome and makes one TypeSafe call. `--plan` prints an offline install plan instead, and `--detect` prints a JSON inventory |
| `guide` | print INSTALL-FOR-AGENTS.md |
| `--version`, `--help` | version and usage |

## Adapters and extension points

This package ships two adapters: `playwright` (playwright-core, the default) and `cdp` (raw CDP over Node's built-in WebSocket, no extra dependency; also serves cloud CDP endpoints). Every adapter passes the same conformance suite over the same fixture pages.

Documented extension points for later adapters: Puppeteer; WebDriver BiDi via Selenium 4 or WebdriverIO; the browser-use Browser Harness; and an extension bridge in the style of Playwright MCP's `--extension`. Core imports no driver package; adapters implement the contract and cannot reach the security boundary.

## Known limits

- Iframe content is not enumerated: the loop cannot see inside a frame.
- Shadow DOM content is not enumerated: a shadow host appears as one record and its interior stays invisible.
- Pointer-styled elements that react only through a delegated listener, with no `onclick`, role or own listener, are not enumerated.
- Right-clicks, modifier-held clicks and keys outside the wingman key set (Enter, Tab, Shift+Tab, Escape, Space, Backspace, Ctrl/Cmd+A, arrows) have no wingman path. Set `"handoff": {"retain": ["script"]}` to keep the caller's script tool for them.
- Browsing tools that drive the browser through an extension expose no endpoint to share.
- The benchmark results file is not committed, because `bench/results` is gitignored. The numbers on this page cite that local file.

## Benchmark

The benchmark has 17 small browser tasks, such as ticking a checkbox, sorting a table, accepting a confirm dialog, uploading a file or checking out in a demo shop. Fifteen run on local copies of a public practice site for browser automation. The copies mirror that site's pages byte for byte, so those runs are repeatable. The longest task is a chain of seven pages in a fixed order: checkboxes, dropdown, add and remove elements, inputs, forgot-password form, dynamic loading and status codes.

Two tasks run on live sites to check real-web behavior: the Sauce Demo shop checkout and the TodoMVC app. Each task runs twice with wingman and twice with Playwright alone, interleaved. The calling agent is the same in both setups: a fast model served through a proxy and reached through Claude Code's `sonnet` alias. This is not a direct measurement of Anthropic's Sonnet model.

In the wingman setup the agent's prompt carries three extra sentences on using `browse_step`: what to pass, how to resume after a hand-back, and to skip a step that opens the page it is already on. Playwright alone gets no tool-specific guidance. The wingman setup's turn limit is 30 against 40 for Playwright alone; no run made more than 20 tool calls.

The local seven-page chain reproduces the error banner the live site shows after the Retrieve password form is submitted. It therefore exercises recovery without a live site's flakiness. The local 404 page returns HTTP 200, so the check that scores that task reads the URL path.

In 1 of the 34 wingman runs, at least one step was handed back to the agent. That was one run of the seven-page task, which handed back two steps; the agent then made no click, type or script calls of its own beyond one page read. The other 33 wingman runs completed every step through wingman.

The block below is generated from the results file. Times are seconds and costs are US dollars at list prices. The `forced` row is wingman in hand-off mode, and the `playwright` row is Playwright alone. The `fallback rate` column is the share of wingman runs where a step was handed back. The median cost column is the raw per-run median, which falls between the warm-cache and cold-cache clusters described under Results by task; the total and the cache-neutral figures there are the steadier comparison.

In the header line, `model=sonnet` is the alias described above, `harness=3` is the version of the benchmark script, and a "cell" is one run. The `scripts/gates/readme-bench.mjs` gate keeps the block in sync with the newest results file.

<!-- bench:begin -->
Benchmark: publish-r27b.json · model=sonnet · harness=3 · 2026-10-08-110201.json · medians over interleaved cells; cost is the normalized token index at bench/prices.json list prices, not billing.

| route | success | median wall-clock | wall spread (min-max) | median cost (USD) | fallback rate |
|---|---|---|---|---|---|
| playwright | 0.941176 | 15.5 | 11.4-37.4 | 0.185321 | 0 |
| forced | 1 | 16.0 | 11.3-51.8 | 0.074557 | 0.029412 |

Source: bench/results/publish-r27b.json
<!-- bench:end -->

## Design references

Design-only ports; no code was copied:

- tontoko/jev-browser
- jasonduncan/jev-browser
- Ying-Kai-Liao/jev-browser
- jkudish/jev-browser
- browser-use/jev-ultrafast

## Not affiliated

jev-browser-wingman is not affiliated with TypeSafe.

## License

MIT.
