---
name: jev-browser-wingman
description: When to delegate a whole browser goal to wingman_do instead of driving raw browser tools, how to phrase the goal, and what each result status means.
---

# Delegating browser goals to jev-browser-wingman

jev-browser-wingman adds two MCP tools, `wingman_do` and `wingman_check`, that
run a browser loop for you. One call observes the page, picks the next element,
acts, and repeats until the goal is met or a limit is hit. One call returns one
compact result instead of a snapshot and a decision per step.

## When to delegate

DEFAULT: delegate any browsing goal that will take more than 3 clicks or page
loads. Call `wingman_do` once with the whole goal instead of paging through
the site with raw browser tools.

Drive the raw browser tools directly when the goal needs navigation to a new
URL or tab, needs credentials typed, or spans several unrelated goals.
`wingman_do` never navigates and never opens or closes tabs. The server
enforces the active sensitive-page policy itself; when a result's note tells
you to do a step with your own browser tools, do that.

Use `wingman_check` for a single yes/no question about the open page when one
probability answers it. Do not use it to read or extract content.

## Phrasing the goal

State one outcome, and pass variable text as bindings:

    wingman_do({ goal: "Add the cheapest flight Rome to Oslo in June to the cart", values: { last_name: "..." } })

Bindings are typed locally and never sent to the decision service. Keep
secrets out of `goal`; put text the page must receive into `values`.

The same applies to `browse_step`: propose the whole remaining outcome as the
goal (e.g. `complete the form and submit`), not single actions (`click
Continue`) — the tool continues autonomously across pages until the outcome is
done, which is several times faster than one action per call.

## What each status means

| Status | Meaning | What to do |
| --- | --- | --- |
| done | Goal met | Report the result; do not re-verify with raw tools |
| fallback | Loop ended early (budget, no browser, no key) | Call `wingman_do` again with the same goal to continue |
| blocked | Page refused the loop (captcha, dialog, overlay) | Clear the obstruction, then call again |
| ambiguous | The choice was unclear | Narrow the goal, pass `url_match`, or take one raw snapshot |
| login | A sign-in wall | Ask the user to sign in, then call again |
| error | Tool or decision fault | Retry once; if it repeats, drive the raw tools |
| needs_confirmation | An irreversible action is pending | Ask the user, then re-call with the same goal, values and confirm_token |

A `fallback` or `blocked` result means the goal is not finished. Call
`wingman_do` again with the same goal (and the same values) to continue from
where it stopped.

## Do not interleave

After calling `wingman_do`, do not perform the remaining steps with raw browser
tools. Continue via `wingman_do` until it returns done. Interleaving defeats
the point of delegation and multiplies snapshots.
