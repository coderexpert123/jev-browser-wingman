Agents installing this package: read [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) first and follow it alone.

# jev-browser-wingman

## What it does

jev-browser-wingman carries out ONE bounded step on the browser page that is already open and visible. A TypeSafe Jev decision picks the element and the op; the calling agent keeps planning and all text generation. It attaches to a real, logged-in Chrome beside Playwright MCP and never navigates, opens tabs, or signs in.

## How it differs

Positioning, from the design evaluation:

- Safe attach to a real logged-in Chrome beside Playwright MCP.
- Values are never sent to TypeSafe.
- A code-enforced irreversible gate with confirmation tokens.

Added by this design:

- A sensitive-surface policy evaluated before any data leaves the machine.
- A pluggable driver layer with a shared conformance suite.
- Numbers measured against the LLM-plus-Playwright baseline.

## Not affiliated

jev-browser-wingman is not affiliated with TypeSafe.

## Quick start

Installing agents follow [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md) alone. It covers detection, approval, registration, and the doctor checks that verify the install.

## Tools

`wingman_do` carries out one bounded goal on the already-open page: pick the right row, fill a form from values you pass, or click through a short wizard. It never navigates to URLs, opens or closes tabs, signs in, or reads pages for you. Pass text in `values`; values are typed locally and never sent to the decision service.

`wingman_check` answers one yes/no question about the visible page as a probability in `answer`. It is read-only and never clicks or types.

Both tools return these statuses:

| status | meaning |
|---|---|
| done | goal judged achieved (done ≥ 0.85, or ≥ 0.5 with no further action) |
| needs_confirmation | next action tripped the irreversible gate; nothing executed |
| blocked | captcha, access denied, dialog open, or covered target |
| login | page asks for sign-in; tool stops before any credential surface |
| ambiguous | target probability below threshold; candidates returned |
| error | page shows an error after an action, or a tool fault |
| fallback | use the regular route: no browser, no key, breaker open, sensitive surface, shadow mode, budget exhausted |

Labels in results are untrusted page text. Confirm tokens flow through MCP or the library; the CLI has no confirm-token flag.

## Security model

Values typed into the page never leave the machine. A sensitive-surface policy (host categories, login paths, password and OTP page signals) returns `fallback` before any data leaves. An irreversible gate requires a single-use `confirm_token` bound to page URL, element fingerprint and verb before submit-like actions execute.

What leaves the machine: origin and path (no query or fragment), title, element roles and labels (≤80 chars), the text excerpt, the goal, binding names and type hints, and a verb-plus-label history. Never leaves: values, hidden or prefilled input values, cookies, storage, screenshots, password fields. Page text is data, never instructions, and Jev emits no text, so injection can only bias a bounded selection.

## Configuration

Machine-local config at `<wingmanHome>/config.json` (default `~/.jev-browser-wingman/config.json`):

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
| `sensitive_hosts` | object | `{}` | keys from `SENSITIVE_HOST_CATEGORIES`; values are arrays of host suffixes |
| `budgets` | object | `DEFAULT_BUDGETS` | each key optional; each value within `BUDGET_LIMITS` |
| `gate` | object | `{ mode: "confirm" }` | only key `mode`: `"confirm"` (default) or `"off"`; `off` disables the irreversible gate |

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
| `chrome show` | move the shared Chrome window on-screen over CDP, for when the operator must act (e.g. a login code) |
| `chrome hide` | move the shared Chrome window back off-screen |
| `with-chrome -- <command> [args...]` | proxy that ensures Chrome just before the first `tools/call`, then forwards |
| `doctor [--json] [--detect] [--client <claude\|codex\|opencode\|agy\|devin\|cursor>]` | nine read-only checks and a verdict |
| `guide` | print INSTALL-FOR-AGENTS.md |
| `--version`, `--help` | version and usage |

## Adapters and extension points

v1 ships two adapters: `playwright` (playwright-core, the default) and `cdp` (raw CDP over Node's built-in WebSocket, no extra dependency; also serves cloud CDP endpoints). Every adapter passes the same conformance suite over the same fixture pages.

Documented extension points for later adapters: Puppeteer; WebDriver BiDi via Selenium 4 or WebdriverIO; the browser-use Browser Harness; and an extension bridge in the style of Playwright MCP's `--extension`. Core imports no driver package; adapters implement the contract and cannot reach the security boundary.

## Design references

Design-only ports; no code was copied:

- tontoko/jev-browser
- jasonduncan/jev-browser
- Ying-Kai-Liao/jev-browser
- jkudish/jev-browser
- browser-use/jev-ultrafast

## Benchmark

<!-- bench:begin -->
No benchmark results yet.
<!-- bench:end -->

## License

MIT.
