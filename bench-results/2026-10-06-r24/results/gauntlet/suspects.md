# r24 flag suspects (raw, no judgment)

Count: 7

## t4-add-elements#1 call2 round2 flag=sameDocEvidence
end: needs_confirmation/irreversible-heuristic

- {"r":1,"step_text":"click the Add Element button","kind":"act"}
- {"r":2,"step_text":"click the Add Element button","kind":"advance","stepDoneP":0.49,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.65,"sameDocEvidence":true}
- {"r":3,"step_text":"click the Add Element button","kind":"bounce","stepDoneP":0.3,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.65}

## t6-dynamic-loading#1 call1 round1 flag=readySkipped
end: needs_confirmation/irreversible-heuristic

- {"r":1,"step_text":"click the Start button","kind":"bounce","stepDoneP":0.16,"readyP":0.22,"readySkipped":true}

## t4-add-elements#2 call2 round2 flag=sameDocEvidence
end: needs_confirmation/irreversible-heuristic

- {"r":1,"step_text":"click the Add Element button","kind":"act"}
- {"r":2,"step_text":"click the Add Element button","kind":"advance","stepDoneP":0.48,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.62,"sameDocEvidence":true}
- {"r":3,"step_text":"click the Add Element button","kind":"bounce","stepDoneP":0.36,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.65}

## t4-add-elements#2 call3 round2 flag=sameDocEvidence
end: needs_confirmation/irreversible-heuristic

- {"r":1,"step_text":"click the Add Element button","kind":"act"}
- {"r":2,"step_text":"click the Add Element button","kind":"advance","stepDoneP":0.47,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.65,"sameDocEvidence":true}
- {"r":3,"step_text":"click the Add Element button","kind":"bounce","stepDoneP":0.29,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.61}

## t6-dynamic-loading#2 call1 round1 flag=readySkipped
end: needs_confirmation/irreversible-heuristic

- {"r":1,"step_text":"click the Start button","kind":"bounce","stepDoneP":0.16,"readyP":0.23,"readySkipped":true}

## t9-long-chain#2 call11 round7 flag=stuckSecond
end: error/act-failed

- {"r":1,"step_text":"click the Start button","kind":"act"}
- {"r":2,"step_text":"click the Start button","kind":"advance","stepDoneP":0.65,"errorP":0.08,"historyResult":"element gone","leftPage":false,"readyP":0.48}
- {"r":3,"step_text":"open Status Codes","stepDoneP":0.12,"errorP":0.08,"historyResult":"element gone","leftPage":false,"readyP":0.34}
- {"r":4,"step_text":"open Status Codes","stepDoneP":0.11,"errorP":0.08,"historyResult":"element gone","leftPage":false,"readyP":0.38}
- {"r":5,"step_text":"open Status Codes","kind":"act","historyResult":"element gone","leftPage":false,"stuck":"back"}
- {"r":6,"step_text":"open Status Codes","stepDoneP":0.13,"errorP":0.09,"historyResult":"page changed","leftPage":true,"readyP":0.55}
- {"r":7,"step_text":"open Status Codes","kind":"act","historyResult":"page changed","leftPage":true,"stuckSecond":true,"stuck":"back"}
- {"r":8,"step_text":"open Status Codes","kind":"error","stepDoneP":0.12,"errorP":0.09,"historyResult":"page changed","leftPage":true,"readyP":0.53}

## t11-todomvc-spa#2 call1 round4 flag=pressFocusSum
end: fallback/no-progress

- {"r":1,"step_text":"type the value named item1 into the new-todo field","kind":"act","stepDoneP":0.06,"readyP":0.49}
- {"r":2,"step_text":"type the value named item1 into the new-todo field","kind":"advance","stepDoneP":0.67,"errorP":0.04,"historyResult":"filled","leftPage":false,"readyP":0.51}
- {"r":3,"step_text":"press Enter to confirm it","kind":"bounce","stepDoneP":0.2,"errorP":0.04,"historyResult":"filled","leftPage":false,"readyP":0.52}
- {"r":4,"step_text":"press Enter to confirm it","kind":"act","stepDoneP":0.2,"errorP":0.05,"historyResult":"filled","leftPage":false,"readyP":0.51,"pressFocusSum":true}
- {"r":5,"step_text":"press Enter to confirm it","kind":"advance","stepDoneP":0.65,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.61}
- {"r":6,"step_text":"type the value named item2 into the new-todo field","kind":"act","stepDoneP":0.12,"errorP":0.04,"historyResult":"page changed","leftPage":false,"readyP":0.69}
- {"r":7,"step_text":"type the value named item2 into the new-todo field","kind":"act","stepDoneP":0.43,"errorP":0.05,"historyResult":"filled","leftPage":false,"readyP":0.69}
- {"r":8,"step_text":"type the value named item2 into the new-todo field","kind":"bounce","stepDoneP":0.27,"errorP":0.05,"historyResult":"filled","leftPage":false,"readyP":0.67}

