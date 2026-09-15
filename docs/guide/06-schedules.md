# Schedules

HSX schedules are finite. A literal `count`, an interval, and a first due date let the compiler expand installments at compile time. The monthly obligation form can instead use a caller-controlled end condition, but it must name the drain action that ends future liability.

```hsx
program installments "Installments"
import { scheduled } from "std/money_flows"
party buyer: person
party seller: business
settlement plan = scheduled {
  payer: buyer
  payee: seller
  amount: totalAmount: money(SAR)
  count: 3
  every: P30D
  first_due: firstDueAt
}
```

`scheduled` handles finite installments and obligation schedules. `rotating_pool` expands a fixed roster and cycle count. `settlement_batch` closes on a stored date before calculation, approval, instruction, acknowledgement, and reconciliation actions.

General modules may use a comprehension over a compile-time integer or finite list. Runtime-dependent bounds are refused. An expansion may contain at most 256 generated rows.

Finite obligation counts expand the same lifecycle for each slice. A lifecycle source may be a finite list; `without(states, state)` removes one state before expansion. This preserves rejection of a repeated delinquency marker for its current slice.

Use `advance` with `dated: true` when each repayment has a signed date. `repayment_source` separates the borrower from the capital recipient; `profit_to` sends computed profit to a separate account. The caller partitions the principal and profit across stored repayments. These partitions do not enforce equal slices or ordered dates.
