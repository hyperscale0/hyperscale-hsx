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
  customerAccountId {
    type: account<SAR>;
    "x-hyperscale-reference-filter": { column: role; values: [customer_balance]; };
  }
  amount: money<SAR>;
}
```

The account type pins the currency and identifier shape. The reference filter
pins the allowed ledger roles. Product admission requires every account field
to declare a non-empty role list. Choose roles that match the accounts the
program will use; `customer_balance` is the role in this example.

Use the quoted `"x-hyperscale-reference-filter"` key inside the field block,
with `column: role` and `values: [...]`. There is no shorter role annotation.
A bare `customerAccountId: account<SAR>;` compiles as HSX but does not satisfy
the host's account-role admission law.

## Money fields

A `money<C>` field admits a minor-unit integer string and refuses zero: it lowers to the pattern `^[1-9][0-9]{0,17}$`. Marking the field `optional: true` lets a caller omit it; it does not let a caller send `"0"`. When zero is a real value for the field, opt in with `allow_zero: true`, which lowers to `^(0|[1-9][0-9]{0,17})$`:

```hsx
fields {
  amount: money<SAR>;
  discount { type: money<SAR>; optional: true; allow_zero: true; }
}
```

`allow_zero` on any other type is HSX1105. Decision port shapes set it on their money fields, because a decided amount may be zero.

## Date fields

A `date` field lowers to the UDL `hyperscale-date-time` format. Callers may send any RFC 3339 offset, such as `2026-10-03T09:00:00+03:00`; the host admits it and stores the UTC instant, `2026-10-03T06:00:00.000Z`. A value already in `Z` is stored byte for byte. A local date-time without an offset is refused.

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
