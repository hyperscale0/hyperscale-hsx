# Composition

One program can apply several instruments. Each instrument keeps its own lifecycle and fields. References connect them through typed ids instead of shared mutable state.

```hsx
program studio_sales "Studio sales"
import { instant_transfer, scheduled } from "std/settlements"
party buyer: person
party studio: business
settlement purchase = instant_transfer {
  payer: buyer
  payee: studio
  amount: purchasePrice: money(SAR)
  fees { buyer: 1% }
}
settlement installments = scheduled {
  payer: buyer
  payee: studio
  amount: servicePrice: money(SAR)
  count: 2
  every: P30D
  first_due: firstPaymentAt
}
```

A general instrument declares a `ref<target>` field when an instance must point to another instrument. Cross-instrument clauses bind against the target's declared fields, actions, and lifecycle states after the full module graph resolves. A missing target or incompatible field reports a typed diagnostic before UDL emission.

Keep each money route in one instrument. Connect instruments with evidence and references. Do not move an amount through an untyped text field.

`reconciled_payout` composes a payout instruction with one explicit expectation about the bank debit that follows. Its `reconcile` clause binds the expected amount, currency, direction, payout reference, evidence source, match law, and deadline. A match settles the payout. A missed or mismatched expectation creates the declared break child, so the composition retains the exception as contract data.

```hsx
program supplier_payment "Supplier payment"
import { reconciled_payout } from "std/settlements"
party treasury: business
party supplier: business
settlement payout = reconciled_payout {
  payer: treasury
  beneficiary: supplier
  amount: netPayable: money(SAR)
  beneficiary_ref: supplierBeneficiaryId
  settle_by: settleBy
  matched_within: 100
  matched_ceiling: 500
}
```
