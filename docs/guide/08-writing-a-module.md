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

## An authored action that moves money

Declare each cash movement in `moves` with a unique `key`, an `operation`, and `bind` operands. This complete program comes from [payment.hsx](../../examples/05-authored-instrument/payment.hsx). The docs builder requires the snippet to match that file and compiles it with the packaged cost table.

```hsx source=examples/05-authored-instrument/payment.hsx
program authored_payment "Authored payment"

instrument payment {
  agent_description: "Collect a stored payment once from its payer."
  title: "Payment"
  summary: "A payment with fixed payer and payee accounts"
  fields {
    payerAccountId: account<SAR>;
    payeeAccountId: account<SAR>;
    amount: money<SAR>;
  }
  parties { payer: payerAccountId; beneficiary: payeeAccountId; }
  lifecycle {
    states pending paid;
    initial pending;
    on pay: pending -> paid;
  }
  action create {
    agent_description: "Open a pending payment without moving money."
    steps: [];
    moves: [];
  }
  action pay {
    agent_description: "Move the stored amount from payer to payee."
    steps: [];
    moves: [{
      bind: {
        amount: { from: "instance", path: "fields.amount" }
        currency: { from: "const", value: "SAR" }
        sourceAccountId: { from: "instance", path: "fields.payerAccountId" }
        destinationAccountId: { from: "instance", path: "fields.payeeAccountId" }
      }
      key: "payment_transfer"
      operation: "internal_transfer.create"
    }];
  }
}
```

`from: "instance"` reads an immutable stored field. `from: "const"` supplies the literal currency. The four bindings supply the transfer's amount, currency, source account and destination account. `internal_transfer.create` names the transfer operation; `payment_transfer` identifies this move within the action. Account IDs come from account creation or discovery before creating the payment. They are never invented by the program.

`create` opens a pending record without cash movement. `pay` moves the stored amount and transitions to `paid`; the lifecycle refuses a second payment under a new action request. The compiler emits these bindings into UDL. Execution still requires an engine that admits the operation and accounts.
