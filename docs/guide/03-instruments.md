# Instruments

Start with the money flows library (open/hsx/std). Import a money flow by export name from `std/money_flows`, then apply it under a local settlement name. The local name becomes the emitted instrument id.

```hsx
program equipment_hire "Equipment hire"
import { scheduled } from "std/money_flows"
party renter: person
party owner: business
settlement installments = scheduled {
  payer: renter
  payee: owner
  amount: hirePrice: money(SAR)
  count: 2
  every: P30D
  first_due: firstPaymentAt
}
```

Required parameters state the instrument's core contract. Optional parameters add bounded behavior such as a deadline, cancellation allocation, fee, or policy. Omit an optional block when the product does not need it. Do not pass an empty block as a substitute unless the module documents that form.

The generated money flows reference lists every module, parameter, action, port, and emitted clause. Read that page before choosing a module. Prefer one module that already states the required lifecycle over a custom instrument with copied mechanics.

## Account fields

When declaring fields of type `account<C>`, the HSX compiler automatically lowers the field schema with the UDL2002 account pattern (`^acct_(sandbox|live)_[a-z0-9]{8,64}$`). Authors do not need to write an explicit `pattern` clause on account fields.

```hsx
fields {
  customerAccountId: account<SAR>;
  amount: money<SAR>;
}
```

## Port declarations and action clauses

HSX supports two distinct port syntaxes depending on scope:

1. **Top-level port declarations** declare a named port at program scope using `allowed: [...]`.
2. **Action-level port clauses** define caller permissions directly inside an instrument action using `allowed_parties: [...]`.

Top-level port declaration:

```hsx
port confirm_delivery {
  allowed: [buyer];
}
```

Action-level port clause:

```hsx
action release {
  agent_description: "Release escrowed funds to the payee."
  steps: [];
  moves: [];
  port {
    allowed_parties: [payer];
  }
}
```

Writing `allowed:` inside an action-level `port` clause triggers diagnostic `HSX1508`. Use `allowed_parties: [...]` inside action clauses, and reserve `allowed: [...]` for top-level port declarations.
