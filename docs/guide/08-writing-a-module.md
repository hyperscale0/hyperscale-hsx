# Writing a module

A module is ordinary HSX source. It declares a dotted module name and exports templates, types, constants, subjects, or applications. The compiler does not branch on a standard-library module name.

```hsx
program approval_example "Approval example"
instrument approval() {
  title: "Approval"
  summary: "A reusable approval lifecycle"
  fields {}
  lifecycle {
    states pending approved;
    initial pending;
    on approve: pending -> approved;
  }
  action create { steps: []; moves: []; }
  action approve { steps: []; moves: []; }
}
instrument review = approval()
```

A parameter list makes an instrument a template, including an empty list. A concrete instrument without a parameter list emits directly when its file compiles. Export only the declarations that callers need.

Imported exports carry the local declarations they reference. Identical declarations unify. Conflicting declarations report `HSX1009`. Keep module parameters typed, keep loops finite, and use UDL clause vocabulary for instrument and action mechanics.

Publish a module only after compiling it directly and through an importing program. Compare the canonical UDL bytes from both paths when the exported application should be identical.
