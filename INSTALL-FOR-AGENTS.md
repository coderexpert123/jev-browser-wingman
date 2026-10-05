# Installing jev-browser-wingman (for agents)

## Audience

Any installing agent or human, on any client, beside whatever browser tooling the user already has. Read this whole file before running anything. Run only `npm install -g jev-browser-wingman`, `jev-browser-wingman` commands and the client's own `mcp` command. Stop and ask whenever a step would modify existing browser-tool config.

After installing the command (below), start with `jev-browser-wingman doctor --plan`: it prints, per outcome, the exact steps this setup still needs. Finish with `jev-browser-wingman doctor`: green means done.

## Install the command

Run `npm install -g jev-browser-wingman`.

To install from a packed tarball (release candidates, offline installs), run
`npm pack` in a checkout and then `npm install -g ./jev-browser-wingman-<version>.tgz`.

From a source checkout, run `npm ci`, then `npm run build`, then `npm link` in the package directory.

Verify with `jev-browser-wingman --version`. It must print a version and exit 0.

## Invariants

These must not be broken under any circumstance:

- One browser process per profile dir.
- Never close or relaunch a browser it did not start.
- The existing browser tool stays registered and owns tabs, reading, dialogs and screen-position clicks; page actions and navigation go through wingman in forced mode.
- The TypeSafe key goes in the client's secret or env store, never in committed or synced config, and is never echoed.
- No absolute machine paths in config that is synced across machines.
- Show a diff and get the user's approval before editing any existing MCP or client config.
- `profile_dir` is never Chrome's default user-data dir.
- Attach reuses the browser's default context and never creates one.

## Outcomes

| Outcome | Why it matters | How doctor checks it | Known ways to reach it |
|---|---|---|---|
| O1 wingman is registered with the agent's MCP client and its config sets `"mode": "on"` | Forced handoff applies only while the top-level mode is `on` | `registration-portable`, `config-loaded` | Add the wingman server entry (Register per client) and set `"mode": "on"` in `<wingmanHome>/config.json` |
| O2 the caller's in-page action tools are withheld | Without withholding, forced handoff is instruction-only and the caller keeps acting on the page directly | `handoff` | Proxy wrap, deny config, or instruction-only with the reason stated |
| O3 the caller's browsing tool and wingman share one debuggable Chromium-family browser | One shared browser keeps the logged-in session and avoids a second browser process | `adapter-attach`, `default-context`, `coexistence` | Let wingman launch the shared browser, or attach to the browsing tool's own debugging endpoint |
| O4 a TypeSafe key is available | Every Jev decision needs it | `key-present` | Set the env var in the client's secret or env store, or point `secrets_file` at a KEY=VALUE file |
| O5 `doctor` passes | Green means done | all checks | Run `jev-browser-wingman doctor` and fix each FAIL with the table in Verify |

Any environment not covered by `doctor --plan` is supported by reaching these outcomes by whatever route fits; doctor green means done.

## Detect and plan

Run `jev-browser-wingman doctor --detect`. It is read-only and prints one report per client.

Read each server's `kind` and `mode`:

- `kind`: `playwright-mcp`, `chrome-devtools-mcp`, `jev-browser-wingman`, or `other`.
- `mode`: `launch`, `cdp-endpoint`, `extension`, `wrapped`, or `n/a`.

Run `jev-browser-wingman doctor --plan [--client <id>]` to print the same setup as concrete steps, one block per outcome. `--plan` never launches a browser and never sends data anywhere; an unrecognised client id prints a generic plan, not an error.

`--plan` is read-only: it prints the wrapped entry as bare JSON — an object, or an
array for clients like opencode that use array-form entries. Apply it with the
client's own command. For Claude Code that is
`claude mcp remove <old-name>` then `claude mcp add -s user <name> -- jev-browser-wingman with-browser -- <C> <A...>`
where C and A are the old entry's command and args. A `[met]` outcome reflects
configuration only; `doctor`'s live checks can still fail (for example
`adapter-attach` fails until a debuggable browser answers — run
`jev-browser-wingman chrome ensure` first).

Wingman maps each browsing tool's calls to capability classes through profile files. Shipped profiles cover the common browsing servers; a user profile at `<wingmanHome>/profiles/<id>.json` with the same `id` replaces a shipped one, and `<wingmanHome>/profiles-auto/` holds profiles wingman writes itself after classifying an unknown tool's descriptions on its first session. To cover a new tool, copy a shipped profile, change `id`, `detect.args_contain` and the `tools` map, and drop it in the user profiles directory.

Map each detected setup to an action. Every row keeps the existing tool registered.

| Detected setup | Action |
|---|---|
| Playwright MCP, mode `launch` | Wrap its registration with `with-browser` after approval; if the user declines edits, run jev-browser-wingman on its own separate profile. |
| Playwright MCP, mode `cdp-endpoint` | Attach to that endpoint; never launch. |
| Chrome DevTools MCP with `--browserUrl` | Attach to that endpoint; never launch. |
| A running debuggable Chrome (its `/json/version` answers) | Attach to that endpoint; never launch. |
| Playwright `--extension` or the Claude in Chrome extension | No endpoint exists; use the package's own profile. The extension bridge is a later adapter. |
| A cloud CDP endpoint | Use the raw CDP adapter via `WINGMAN_CDP_ENDPOINT`. |
| Nothing detected | Run `jev-browser-wingman chrome ensure`; wingman starts its own Chrome. |

## Ask the user

Ask before configuring; never guess these:

- Where the TypeSafe key lives: an env var, or a KEY=VALUE file. Never echo its value.
- Whether a host application provides a wingman plugin, and its path.
- Which clients to change now.

## Shared browser

By default the `with-browser` wrap launches the shared browser on `profile_dir` and `port` at the first call to the wrapped tool; the wingman server itself never launches a browser, so without a wrap run `jev-browser-wingman chrome ensure`. Alternatively it attaches to the browsing tool's own browser through that tool's debugging endpoint.

Extension case: the browsing tool drives the browser through an extension and exposes no endpoint. Start a Chromium-family browser on a dedicated profile dir with `--remote-debugging-port=<port>` (Chrome 136+ ignores that flag on the default profile), install the extension in that profile, and set `port` and `profile_dir` in wingman's config to match.

Supported browsers: Chrome, Edge, Brave, Chromium, Opera and Vivaldi, found automatically in that order.

## Handoff mode

Wingman classes every call to the caller's browsing tools into capability classes. In `forced` mode (the default) the classes the active adapter can do are withheld from the caller, minus any classes listed in `handoff.retain`. The caller's own script tool (arbitrary JavaScript or code in the page or browser) is also withheld by default in forced mode, even though no adapter can run it: a calling agent given a script tool used it to perform page actions directly, bypassing forced handoff entirely. In `optional` mode nothing is withheld.

Which classes are withheld is derived from the adapter, plus `script` (withheld regardless of adapter; see above). The classes that always stay with the caller: `pointer-xy`, `drag`, `tabs`, `dialog`, `read`, `wait`, `session`.

Right-clicks, modifier-held clicks and keys outside the wingman key set (Enter, Tab, Shift+Tab, Escape, Space, Backspace, Ctrl/Cmd+A, arrows) have no wingman path; they need the caller's own script tool, which forced mode withholds by default. A user who needs them sets `"handoff": {"retain": ["script"]}` in config to keep that tool available.

With `policy.mode: "enforce"` in forced mode, a sensitive page comes back to the caller, who drives it with `pick` (a pick sends nothing to the decision service) or asks the user. `doctor` warns about the pairing. Forced handoff applies only while the top-level `mode` is `on`.

Opt out with `"handoff": {"mode": "optional"}` in config.

## Step phrasing and recovery

`browse_step` decides each action from the step text you pass. Two phrasing rules prevent the most common failure:

- **Repeat counts stay inside one step.** When a step repeats an action a fixed number of times (e.g. "click the Add button twice"), keep the count word inside that single step entry. Splitting it into separate bare "click the Add button" steps loses the count — the decision service cannot tell when to stop and may over-act, producing real side effects on the page (e.g. dozens of extra clicks).
- **Fallback while progressing.** `browse_step` can report `fallback`/`budget-steps` while making continuous, real, observable progress on a click-family step. Each retry compounds real side effects. When a result reports fallback after making progress, take a snapshot with your own browser tools to see the current page state before calling `browse_step` again.

Self-correcting an over-executed step is done with another `browse_step` call (e.g. "delete the extra elements"), never with the raw click tool — it is withheld in forced mode. Using `script` to bypass handoff defeats the purpose of the wrap.

A `post-action` note means the step's action already ran and the page then failed
to become usable. Do not repeat that action and do not reload the page: take a
snapshot with your own tools, then call `browse_step` again with only the steps
after that one.

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
| `sensitive_hosts` | object | `{}` | keys from `banking`, `payments`, `webmail`, `identity`, `government`, `tax`, `health`; values are arrays of host suffixes |
| `budgets` | object | see rule | integer keys, each optional, defaults in parentheses: `max_steps` 1–24 (24), `max_ms` 5000–120000 (90000), `jev_timeout_ms` 1000–10000 (10000), `max_elements` 20–240 (240), `max_text_chars` 0–3000 (3000), `max_state_chars` 2000–24000 (24000) |
| `gate` | object | `{ mode: "off" }` | only key `mode`: `"off"` (default) or `"confirm"`; `confirm` turns on the irreversible-action gate |
| `policy` | object | `{ mode: "off" }` | only key `mode`: `"off"` (default) or `"enforce"`; `enforce` fails closed on sensitive pages |
| `takeover` | object | `{ threshold: 0.7, mode: "auto", retry: true }` | keys `threshold`: number 0.5–0.95, `mode`: `"auto"` (act on a lower-confidence pick itself) or `"offer"` (return an offer the caller accepts with `takeover: true`), `retry`: boolean; tunes `browse_step`, leave at the defaults unless you are tuning |
| `handoff` | object | `{ mode: "forced" }` | keys `mode`: `"forced"` (default) or `"optional"`; `tools`: `"browse-only"` or `"all"`; `retain`: array of capability class names kept with the caller |

Unknown top-level keys fail.

When the user approves the wrap, set `profile_dir` to the existing browsing tool's `--user-data-dir`, so logged-in state carries over. Paths under the user's home are written with `~/`.

## Back up before editing

Save the exact existing entry to `~/.jev-browser-wingman/backups/<client>-<server>-<UTC timestamp>.json`.

On a fresh install the `backups/` directory does not exist yet — create it first
(e.g. `mkdir ~/.jev-browser-wingman/backups` on Windows).

Show the user the before and after entries. Edit only after approval. Use the client's own `mcp` command where it has one.

## Register per client

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

cursor, under `mcpServers` in `~/.cursor/mcp.json`:

```json
{"type":"stdio","command":"jev-browser-wingman","args":["mcp"],"env":{}}
```

codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.jev-browser-wingman]
command = "jev-browser-wingman"
args = ["mcp"]
tool_timeout_sec = 150
```

### Wrap the browsing tool's entry

Given an entry with `command` C and `args` A, the wrapped entry has `command: "jev-browser-wingman"` and `args: ["with-browser", "--", C, ...A']`. A' is A with every launch flag the tool's profile names (for the common cases `--user-data-dir`/`--userDataDir`) removed, in both the `--x <v>` pair form and the `--x=<v>` token form. Every other key of the entry is kept, and keys keep their original order. opencode's array form `[C, ...A]` becomes `["jev-browser-wingman", "with-browser", "--", C, ...A']`.

For a typical Claude Code entry of the common browsing server the output is exactly:

```json
{"type":"stdio","command":"jev-browser-wingman","args":["with-browser","--","npx","-y","@playwright/mcp@0.0.80","--browser","chrome"],"env":{}}
```

The shared browser then starts at the first call the caller makes to a retained browsing tool, not at session start, in the `window` mode of the config. A `browse_step` call before that returns `fallback` with reason `no-browser`, so run `jev-browser-wingman chrome ensure` once first. Codex's wrapped table also adds `startup_timeout_sec = 60`.

`with-chrome` is a deprecated alias for `with-browser` that still works; prefer `with-browser`.

## Optional toggles

`gate`, `policy` and `takeover` are optional toggles; `gate` and `policy` are off by default.

`gate.mode: "confirm"` opts in to the irreversible-action gate: a submit, delete, pay or send action returns `needs_confirmation` and a token instead of acting. Since 0.3.0 the gate is off unless you set it.

## Verify

Run `jev-browser-wingman chrome ensure` first unless you attach to the browsing tool's own endpoint: `doctor` never launches the shared browser, so `adapter-attach` fails until one answers on the port.

`jev-browser-wingman doctor --json` must print `"verdict":"PASS"` and exit 0. Doctor does not check the top-level `mode`: with mode off the `handoff` check passes as `optional`. Run `jev-browser-wingman doctor --plan` as well and confirm O1 reads `[met]`.

Each check id maps to a fix:

| Check id | Fix on FAIL |
|---|---|
| `key-present` | Ask where the TypeSafe key lives; set the env var or point `secrets_file` at a KEY=VALUE file. |
| `config-loaded` | Fix `config.json`: repair the JSON, remove unknown keys, or point `plugin` at a module exporting `wingmanPlugin`. |
| `registration-portable` | Remove absolute paths from the registration and move secret-shaped env values to the client's env or secret store. |
| `policy-loaded` | Restore a non-empty host list for every `sensitive_hosts` category present in config. |
| `profile-safe` | Set `profile_dir` to a dedicated directory away from Chrome's default user-data dir; stop the holder without a debug port or pick another port. |
| `handoff` | Wrap the browsing tool's registration with `with-browser`, or add the deny entries the check prints (`doctor --plan` prints them); set `"handoff": {"mode": "optional"}` if nothing should be withheld. |
| `adapter-attach` | Run `jev-browser-wingman chrome ensure`, or set the endpoint env var if an endpoint already exists. |
| `default-context` | Use an attach path that reuses the browser's default context; never create one. |
| `coexistence` | Stop the interfering tool around attach, or switch to the other adapter. |
| `jev-round` | Check `TYPESAFE_API_KEY` and the network, then rerun. |

## Roll back

Restore the backed-up entry with the client's own command. Then run `jev-browser-wingman doctor` again and confirm the affected checks pass.

## What was tested

- The cloud Linux fresh install with Claude Code and a Playwright-family MCP server.
- The same with a second, differently named browsing tool.
- A stub browsing tool with foreign tool names.
- The Windows registration smokes for Claude Code, opencode, agy and devin.
- A Windows `doctor --plan` dry run.
- Other environments: supported by these outcomes and `doctor`, not tested.
- Opera and Vivaldi: discovered by path, not launch-tested.
