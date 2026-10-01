---
name: jev-browser-wingman
description: Hand a browsing goal to the wingman via browse_step: ordered steps, pick when it returns a step, resume from progress, what stays with you, and what each status means.
---

# Handing browser work to jev-browser-wingman

jev-browser-wingman runs the in-page part of a browsing goal for you. One `browse_step` call observes the page,
decides each action, acts, and moves through your ordered steps until they are done or a limit is hit. It returns
one compact result instead of a snapshot and a decision per action.

## How to call browse_step

Pass the goal and the ordered remaining steps, with every web address, file path and text in `values`:

    browse_step({ goal: "Finish the order", steps: ["open Shipping", "type the value named zip into ZIP", "go back to the cart", "click Checkout"], values: { zip: "..." } })

Keep secrets out of `goal` and `steps`. Bindings are typed locally and never sent to the decision service.
Name a binding in the step that types it; a missing binding is reported by name.

## When it returns a step to you

A `step_review` result names the part of your step the wingman was working on when it handed back (a sub-part of a
compound step, so not always your exact text), up to three candidate elements with their `role` and `name`, and why
it did not act. `progress.step_index` tells you which of your own steps it was in. Look at the page with your own snapshot or screenshot if you need to. Then call again with the same
goal, steps and values plus `pick`:

    pick: { role: "textbox", name: "ZIP", action: "fill", value: "zip" }

Add `nth` when several elements share the role and name. The wingman acts on exactly that element, then continues.

## What stays with you

You plan the goal and steps and supply every value. You read the page with your own tools when you need to see it.
Sign-in and two-factor steps need the user.

Tabs, pop-ups, dialogs, dragging and clicks at screen positions stay with your own browser tools. A page too large
for one decision comes back for a snapshot and a `pick`. Right-clicks, modifier-held clicks and keys outside the
wingman's set need your own browser tools' script tool — in `forced` mode that tool is withheld too by default, so
these need `handoff.retain: ["script"]` in config, or `pick` the element yourself another way.

## Handoff mode

In `forced` mode, the default, your browser tools keep reading, tabs, waits, dialogs and screen-position actions.
Their page actions and navigation are withheld when the wingman can do them, so those go through `browse_step`.
In `optional` mode both paths stay open, and a result's note may tell you to do a step with your own browser tools.

## What each status means

| Status | Meaning | What to do |
| --- | --- | --- |
| done | Every step is done | Report the result; do not re-verify with raw tools |
| fallback | Returned early: a step it could not decide (`step_review`), a budget limit, an action this setup cannot do, or no browser or key | With `step_review`, re-call with `pick`; otherwise follow the note, or re-call with the same arguments to resume from `progress` |
| blocked | Captcha, open dialog or covering overlay | Clear it (answer a dialog with your own tools, or `pick` the overlay's dismiss button), then call again |
| ambiguous | An element or value was unclear | Re-call with `pick`, a more specific step, the missing value, or `url_match` |
| login | A sign-in wall | Ask the user to sign in, then call again |
| error | Tool or decision fault; `invalid-input` names the argument to fix | Fix what the note names, or retry once |
| needs_confirmation | An irreversible action is pending (only when the optional gate is on) | Ask the user, then re-call with the same arguments and the confirm_token |

## wingman_do and wingman_check

In `optional` mode two more tools are listed. `wingman_do` runs one bounded goal on the open page and never
navigates. `wingman_check` answers one yes/no question about the open page as a probability.
