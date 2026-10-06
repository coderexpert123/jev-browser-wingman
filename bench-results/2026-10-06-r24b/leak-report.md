# r24b leak characterization (names, ids, indices and field paths only; no values)

Held slice records: 65. Leak-scan hits (field-level): 17.

## Hits per field path

- rounds[].cands[].label: 9
- rounds[].step_text: 3
- rounds[].act.label: 3
- step_texts[]: 1
- rounds[].pickArgs.name: 1

## Hits per binding

- t11-todomvc-spa.item1: 15
- t11-todomvc-spa.item2: 2

## Each hit

- t11-todomvc-spa#1/call3 rec=25 round=- bind=t11-todomvc-spa.item1 path=step_texts[1] marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=3 bind=t11-todomvc-spa.item1 path=phases.rounds[2].step_text marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=3 bind=t11-todomvc-spa.item1 path=phases.rounds[2].cands[0].label marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=3 bind=t11-todomvc-spa.item1 path=phases.rounds[2].act.label marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=4 bind=t11-todomvc-spa.item1 path=phases.rounds[3].step_text marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=4 bind=t11-todomvc-spa.item1 path=phases.rounds[3].cands[0].label marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=4 bind=t11-todomvc-spa.item1 path=phases.rounds[3].act.label marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=5 bind=t11-todomvc-spa.item1 path=phases.rounds[4].step_text marker_in_field=false
- t11-todomvc-spa#1/call3 rec=25 round=5 bind=t11-todomvc-spa.item1 path=phases.rounds[4].cands[0].label marker_in_field=false
- t11-todomvc-spa#2/call3 rec=57 round=3 bind=t11-todomvc-spa.item1 path=phases.rounds[2].cands[1].label marker_in_field=false
- t11-todomvc-spa#2/call3 rec=57 round=4 bind=t11-todomvc-spa.item1 path=phases.rounds[3].cands[1].label marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=1 bind=t11-todomvc-spa.item1 path=phases.rounds[0].pickArgs.name marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=1 bind=t11-todomvc-spa.item1 path=phases.rounds[0].act.label marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=2 bind=t11-todomvc-spa.item1 path=phases.rounds[1].cands[1].label marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=2 bind=t11-todomvc-spa.item2 path=phases.rounds[1].cands[2].label marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=3 bind=t11-todomvc-spa.item1 path=phases.rounds[2].cands[1].label marker_in_field=false
- t11-todomvc-spa#2/call4 rec=58 round=3 bind=t11-todomvc-spa.item2 path=phases.rounds[2].cands[2].label marker_in_field=false

## Redaction context (names only)

- Every field path above is a field the loop meant to redact (step_text, step_texts, cands[].label, act.label, pickArgs.name are logged through the bound-value redactor; labels only under the label switch).
- All hits are t11-todomvc-spa, bindings item1 (15) and item2 (2); no other task or binding hit.
- rec=25 (t11#1/call3) carries `<value:...>` markers for another binding (so redaction ran) yet the item1 binding was unredacted: consistent with redaction using only the values bound on that call.
- rec=57 and rec=58 (t11#2/call3, call4) carry zero `<value:` markers: no values were bound on those calls, so nothing was redacted.
- Slice-wide `<value:` marker count: 69 (redaction works where a value is bound on the call).
