# Installing jev-browser-wingman (for agents)

## Audience

Any installing agent, on any client, beside whatever browser tooling the user already has. Read this whole file before running anything. Run only `jev-browser-wingman` commands and the client's own `mcp` command. Stop and ask whenever a step would modify existing browser-tool config.

## Invariants

These must not be broken under any circumstance:

- One browser process per profile dir.
- Never close or relaunch a browser it did not start.
- The existing browser tool stays the default.
- The TypeSafe key goes in the client's secret or env store, never in committed or synced config, and is never echoed.
- No absolute machine paths in config that is synced across machines.
- Show a diff and get the user's approval before editing any existing MCP or client config.
- `profile_dir` is never Chrome's default user-data dir.
- Attach reuses the browser's default context and never creates one.

## Install the command

After publish, run `npm install -g jev-browser-wingman`.

From a source checkout, run `npm ci`, then `npm run build`, then `npm link` in the package directory.

Verify with `jev-browser-wingman --version`. It must print a version and exit 0.

## Detect

Run `jev-browser-wingman doctor --detect`. It is read-only and prints one report per client.

Read each server's `kind` and `mode`:

- `kind`: `playwright-mcp`, `chrome-devtools-mcp`, `jev-browser-wingman`, or `other`.
- `mode`: `launch`, `cdp-endpoint`, `extension`, `wrapped`, or `n/a`.

## Decide

Map each detected setup to an action. Every row keeps the existing tool as the default.

| Detected setup | Action |
|---|---|
| Playwright MCP, mode `launch` | Wrap its registration with `with-chrome` after approval; if the user declines edits, run jev-browser-wingman on its own separate profile. |
| Playwright MCP, mode `cdp-endpoint` | Attach to that endpoint; never launch. |
| Chrome DevTools MCP with `--browserUrl` | Attach to that endpoint; never launch. |
| A running debuggable Chrome (its `/json/version` answers) | Attach to that endpoint; never launch. |
| Playwright `--extension` or the Claude in Chrome extension | No endpoint exists; use the package's own profile. The extension bridge is a later adapter. |
| A cloud CDP endpoint | Use the raw CDP adapter via `WINGMAN_CDP_ENDPOINT`. |
| Nothing detected | jev-browser-wingman launches its own Chrome. |

## Ask the user

Ask before configuring; never guess these:

- Where the TypeSafe key lives: an env var, or a KEY=VALUE file. Never echo its value.
- Whether a host application provides a wingman plugin, and its path.
- Which clients to change now.

## Configure

Config lives at `<wingmanHome>/config.json`, by default `~/.jev-browser-wingman/config.json`.

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

Unknown top-level keys fail.

When the user approves the Playwright wrap, set `profile_dir` to the existing Playwright `--user-data-dir`, so logged-in state carries over. Paths under the user's home are written with `~/`.

## Back up before editing

Save the exact existing entry to `~/.jev-browser-wingman/backups/<client>-<server>-<UTC timestamp>.json`.

Show the user the before and after entries. Edit only after approval. Use the client's own `mcp` command where it has one.

## Register

Add the wingman server entry per client:

Claude Code:

```json
{"type":"stdio","command":"jev-browser-wingman","args":["mcp"],"env":{}}
```

opencode:

```json
{"type":"local","command":["jev-browser-wingman","mcp"],"enabled":true}
```

agy:

```json
{"command":"jev-browser-wingman","args":["mcp"],"disabled":false}
```

devin:

```json
{"command":"jev-browser-wingman","args":["mcp"],"transport":"stdio"}
```

codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.jev-browser-wingman]
command = "jev-browser-wingman"
args = ["mcp"]
tool_timeout_sec = 90
```

## Wrap Playwright MCP

Given an entry with `command` C and `args` A, the wrapped entry has `command: "jev-browser-wingman"` and `args: ["with-chrome", "--", C, ...A']`. A' is A with every `--user-data-dir <v>` pair and every `--user-data-dir=<v>` token removed. Every other key of the entry is kept, and keys keep their original order. opencode's array form `[C, ...A]` becomes `["jev-browser-wingman", "with-chrome", "--", C, ...A']`.

For a typical Claude Code Playwright entry the output is exactly:

```json
{"type":"stdio","command":"jev-browser-wingman","args":["with-chrome","--","npx","-y","@playwright/mcp@0.0.80","--browser","chrome"],"env":{}}
```

The shared Chrome then starts at the first browser tool call, not at session start, in the `window` mode of the config. Codex's wrapped table also adds `startup_timeout_sec = 60`.

## Verify

`jev-browser-wingman doctor --json` must print `"verdict":"PASS"` and exit 0.

Each check id maps to a fix:

| Check id | Fix on FAIL |
|---|---|
| `key-present` | Ask where the TypeSafe key lives; set the env var or point `secrets_file` at a KEY=VALUE file. |
| `config-loaded` | Fix `config.json`: repair the JSON, remove unknown keys, or point `plugin` at a module exporting `wingmanPlugin`. |
| `registration-portable` | Remove absolute paths from the registration and move secret-shaped env values to the client's env or secret store. |
| `policy-loaded` | Restore a non-empty host list for every `sensitive_hosts` category present in config. |
| `profile-safe` | Set `profile_dir` to a dedicated directory away from Chrome's default user-data dir; stop the holder without a debug port or pick another port. |
| `adapter-attach` | Run `jev-browser-wingman chrome ensure`, or set the endpoint env var if an endpoint already exists. |
| `default-context` | Use an attach path that reuses the browser's default context; never create one. |
| `coexistence` | Stop the interfering tool around attach, or switch to the other adapter. |
| `jev-round` | Check `TYPESAFE_API_KEY` and the network, then rerun. |

## Roll back

Restore the backed-up entry with the client's own command. Then run `jev-browser-wingman doctor` again and confirm the affected checks pass.
