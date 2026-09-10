# Writing a module

A module is ordinary HSX source. It declares a dotted module name and exports templates, types, constants, subjects, or applications. The compiler does not branch on a standard-library module name.

```hsx
program approval_example "Approval example"
instrument approval() {
  agent_description: "Reusable approval lifecycle template."
  title: "Approval"
  summary: "A reusable approval lifecycle"
  fields {}
  lifecycle {
    states pending approved;
    initial pending;
    on approve: pending -> approved;
  }
  action create {
    agent_description: "Create a pending approval record."
    steps: [];
    moves: [];
  }
  action approve {
    agent_description: "Approve the pending decision."
    steps: [];
    moves: [];
  }
}
instrument review = approval()
```

Custom instruments and callable actions require `agent_description: "..."`. An agent uses these descriptions as tool instructions when invoking actions on an instance. Actions that declare a `due` clause run without an agent call and remain exempt from this requirement. Omitting `agent_description` on callable actions or their containing instruments triggers `HSX1509`.

A parameter list makes an instrument a template, including an empty list. A concrete instrument without a parameter list emits directly when its file compiles. Export only the declarations that callers need.

Imported exports carry the local declarations they reference. Identical declarations unify. Conflicting declarations report `HSX1009`. Keep module parameters typed, keep loops finite, and use UDL clause vocabulary for instrument and action mechanics.

Publish a module only after compiling it directly and through an importing program. Compare the canonical UDL bytes from both paths when the exported application should be identical.
