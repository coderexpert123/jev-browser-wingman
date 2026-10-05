Agents installing this package: read [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) first and follow it alone.

# jev-browser-wingman

jev-browser-wingman lets an AI agent hand its browser work to a separate decision loop. It attaches to a real, logged-in Chromium-family browser (Chrome, Edge, Brave and similar). For each step, Jev picks the page element and the action from what is on the page. Jev is a decision model hosted by TypeSafe: it grades how well each page element fits the step.

The agent that calls the tool is the caller. In forced handoff, a proxy around the caller's browsing MCP server (a Model Context Protocol tool server the agent talks to, such as Playwright MCP) withholds the caller's in-page action tools: click, type, select and similar. Page work goes through `browse_step`. One `browse_step` call looks at the page, decides, acts and recovers across several steps. The calling agent keeps planning, values, tabs and sign-in.

## Results

The benchmark is called the publish gauntlet. It runs 17 tasks, and each task runs on two routes. A route is one way of running the agent. One route is the agent using only Playwright's browser tools (Playwright is a browser-automation library). The other is forced handoff, which the rest of this page calls forced.

Forced handoff completed 34 of 34 runs (100%). The Playwright route completed 32 of 34 (94%). Both Playwright failures were the same file-upload task, and the cause is undiagnosed.

In 17 of the 34 forced runs (50%), at least one `browse_step` call handed the step back to the caller. The tool reports this as status `fallback`. In 7 of those runs the caller then used its own read or dialog tools (snapshot, find, handle dialog). Its click, type and script tools stay withheld.

Median wall-clock time per run was 13.1 s for forced against 11.7 s for Playwright. Forced was faster on 5 of the 17 tasks and slower on 12. The median cost per run is about 9% lower for forced than for Playwright ($0.162 against $0.177). That cost is a token count priced at list prices, not billing. It was lower for forced on 13 of the 17 tasks.

Each task ran twice per route. The success and cost gaps are therefore indicative, not statistically established. The calling model is a fast model served through a proxy and reached through the Claude command-line tool's `sonnet` alias. This is not a direct measurement of Anthropic's Sonnet model. See [Benchmark](#benchmark).

## How it works

```
agent -> MCP client
           |-- [jev-browser-wingman with-browser -- <your browsing MCP server>]
           |      withholds click / type / select / key / hover / upload / navigate / back / scroll / script
           |      keeps tabs, read, dialogs, screen-position clicks, drag, wait, session
           |-- [jev-browser-wingman mcp]  ->  browse_step
                              |
                              v
          one shared, debuggable Chromium-family browser
```

The proxy reads a capability profile for your browsing server. The profile sorts each of the server's tools into a capability class, which is a category of browser action. These classes always stay with the caller: `pointer-xy`, `drag`, `tabs`, `dialog`, `read`, `wait` and `session`. Forced mode is the default value of the `handoff.mode` setting. In forced mode the other classes are withheld, including the caller's own `script` tool.

Set `"handoff": {"mode": "optional"}` and nothing is withheld. Set `"handoff": {"retain": ["script"]}` to keep the named classes with the caller. Forced handoff applies only while the top-level `mode` setting is `on` (see Install).

## Install

You need the following:

- Node.js 22 or newer (`engines.node` is `>=22`).
- A Chromium-family browser: Chrome, Edge, Brave, Chromium, Opera or Vivaldi, found automatically in that order.
- A TypeSafe API key in the `TYPESAFE_API_KEY` environment variable. Alternatively, point `secrets_file` in the config at a `KEY=VALUE` file.

The top-level `mode` is off when it is absent from the config, so you must set `"mode": "on"` yourself. Only `handoff.mode` defaults to forced.

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
| Claude Code + Playwright MCP (tested) | Wrap the Playwright entry with `with-browser`, register wingman, set `"mode": "on"`. Recipe below. |
| A debuggable Chrome already running, Chrome DevTools MCP with `--browserUrl`, or Playwright MCP with `--cdp-endpoint` | Wingman attaches to that endpoint and never launches. Set `port` in the config to the endpoint's port, register wingman, set `"mode": "on"`, and wrap the browsing entry with `with-browser` as in the recipe below so its action tools are withheld. |
| Extension-based tools (Playwright `--extension`, browser extensions) | They expose no endpoint. Start a browser on a dedicated profile with `--remote-debugging-port`, install the extension in that profile, and set `port` and `profile_dir` to match. Chrome 136+ ignores that flag on the default profile. `doctor --plan` prints the deny entries that withhold the tool's actions where the client supports them (Claude Code, opencode). |
| Cloud or remote CDP browser | Set `"adapter": "cdp"` and the `WINGMAN_CDP_ENDPOINT` environment variable for the wingman server. |
| No browser tooling installed | Register wingman and set `"mode": "on"`. Run `jev-browser-wingman chrome ensure` before use; it starts a Chrome on `profile_dir` and `port`, shown per the `window` setting. |
| Other MCP clients (codex, opencode, agy, devin, cursor) | Run `doctor --plan --client <id>`. Registration snippets are in [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md#register-per-client). |
| Any other browsing MCP server | Add a capability profile. Recipe below. |
| Library use | `main` is `dist/src/lib.js`; `createWingman()` returns `do`, `check` and `step`. |

### Recipe: Claude Code + Playwright MCP

Save your existing entry first (`claude mcp get playwright`), then replace it with the wrapped one. Use the name, scope and arguments of your own entry; this example uses `playwright` and `@playwright/mcp@0.0.80`.

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

The wrapped entry starts the shared browser only when the caller first uses one of the Playwright tools that stay with it, such as a snapshot. Run `jev-browser-wingman chrome ensure` once before you start, or the first `browse_step` can hand the step back with status `fallback` and reason `no-browser`.

### Recipe: any other browsing MCP server

Wingman maps a browsing server's tools to capability classes through profile files. Copy `profiles/playwright-mcp.json` from the installed package to `<wingmanHome>/profiles/<id>.json` (`<wingmanHome>` is the config folder, `~/.jev-browser-wingman` by default), then change `id`, `detect.args_contain`, `match_tools` (tool names the server always lists) and the `tools` map. Set `launch.endpoint_env` (an environment variable the server reads) or `launch.endpoint_arg` (a flag template such as `--cdp-endpoint={endpoint}`) so the wrapped server attaches to the shared browser; with both null it keeps its own browser, which does not share the session. A user profile with the same `id` as a shipped one replaces it. A trimmed example of the shape:

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

`browse_step` is the default tool in forced mode. It takes the goal and its ordered remaining steps and runs them across pages: clicks, typing, selects, keys, hovers, scrolling, waits, going back, file attachments and opening supplied web addresses. When it cannot decide which element a step means, it returns the step with candidate elements.

The caller then calls again and names the element by role and name in the `pick` argument. Unfinished results carry `progress`. A call with the same arguments resumes from there.

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
- **Look before retrying a fallback.** A `fallback` result can follow real progress, and each retry compounds side effects. Take a snapshot with your own tools first.

Some results carry a `post-action` note, which means the step's action already ran. In that case do not repeat the action or reload. Call again with only the later steps.

Fix an over-executed step with another `browse_step` call, never with a raw click or script tool.

## Security model

Values typed into the page never leave the machine. By default, wingman sends page content to TypeSafe on all pages, including sensitive ones (banking, mail). Set `policy.mode: 'enforce'` to fail closed on sensitive pages: a policy hit (host categories, login paths, password and OTP page signals) returns `fallback` before any data leaves. The result carries a note telling the calling agent to take that step with its own browser tools. A policy change therefore reaches caller behavior without a session restart.

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
| `handoff` | object | `{ mode: "forced" }` | keys `mode`: `"forced"` (default) or `"optional"`; `tools`: `"browse-only"` or `"all"`; `retain`: array of capability class names kept with the caller |

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
- The benchmark results file is not committed, because `bench/results` is gitignored. The table below cites a local file.

## Benchmark

The publish gauntlet runs 17 tasks. Each is a small browser job, such as ticking a checkbox, sorting a table, answering a confirm dialog, uploading a file or checking out in a demo shop. Fifteen run on local copies of the pages that mirror the-internet byte for byte. The-internet is a public practice site for browser automation. These local copies include the long chain, the hardest task: seven pages in a fixed order (checkboxes, dropdown, add and remove elements, inputs, forgot-password form, dynamic loading, status codes).

Two tasks run on live sites as a check on real-web behavior: saucedemo and todomvc. Each task runs on two routes, Playwright alone and forced handoff, twice each. That makes 68 runs, with the routes interleaved.

The local long chain reproduces the chain's pages and the error banner the live site shows, on the same URL, after the Retrieve password form is submitted. It therefore exercises the recovery machinery without a live site's flakiness. The `/status_codes/404` local page serves the 404 page body at HTTP 200, and the check that decides pass or fail reads the URL path. A separate health probe of the live the-internet site runs outside the measurements and never enters the table.

Forced handoff hands control back to the caller when it is uncertain. The three tasks with the widest wall-clock gaps between the two routes are dynamic loading, the long chain and todomvc. In every forced run of those three tasks, at least one step was handed back. The data do not isolate the cause.

How to read the table: a route is one way of running the agent. Success is the share of runs completed (1 means all). Wall-clock is in seconds. Cost is the token index in US dollars at list prices. Fallback rate is the share of forced runs where the wingman handed at least one step back.

In the header line, `model=sonnet` is the alias described under Results, `harness=3` is the version number of the benchmark script, and `r23b` is the project's internal label for this run. The `scripts/gates/readme-bench.mjs` gate keeps the newest medians below in sync:

<!-- bench:begin -->
Benchmark: publish-merged-r23b.json · model=sonnet · harness=3 · 2026-10-05-060625.json · medians over interleaved cells; cost is the normalized token index at bench/prices.json list prices, not billing.

| route | success | median wall-clock | wall spread (min-max) | median cost (USD) | fallback rate |
|---|---|---|---|---|---|
| playwright | 0.941176 | 11.7 | 8.7-36.8 | 0.176974 | 0 |
| forced | 1 | 13.1 | 9.0-70.1 | 0.161893 | 0.5 |

Source: bench/results/publish-merged-r23b.json
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
