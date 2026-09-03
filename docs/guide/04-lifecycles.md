# Lifecycles

A lifecycle lists every state, names one initial state, and declares action transitions. Every reachable nonterminal state must have a bounded exit or be explicitly parked for a caller action. Actions hold the money moves and other typed clauses that occur on a transition.

```hsx
program approvals "Approvals"
instrument approval {
  title: "Approval"
  summary: "A bounded approval decision"
  fields {}
  lifecycle {
    states pending approved rejected;
    initial pending;
    on approve: pending -> approved;
    on reject: pending -> rejected;
  }
  action create { steps: []; moves: []; }
  action approve { steps: []; moves: []; }
  action reject { steps: []; moves: []; }
}
```

Standard-library instruments bind ports to caller decisions. A deadline appears as stored date data and a `due` clause on the action that may run at that date. An unwind states how a failed or cancelled path drains held value. The compiler refuses a reachable exit that strands money.

Keep lifecycle changes additive after composition. Add a new action or state when old instances can still obey the previous contract. Do not rename a state or tighten an active transition in place.
