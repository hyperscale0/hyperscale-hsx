# Schedules

HSX schedules are finite. A literal `count`, an interval, and a first due date let the compiler expand installments at compile time. The monthly obligation form can instead use a caller-controlled end condition, but it must name the drain action that ends future liability.

```hsx
program installments "Installments"
import { scheduled } from "std/settlements"
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

`scheduled` handles finite installments and obligation schedules. `recurring_collection` records collection periods without inventing money movement. `rotating_pool` expands a fixed roster and cycle count. `settlement_batch` closes on a stored date before calculation, approval, instruction, acknowledgement, and reconciliation actions.

General modules may use a comprehension over a compile-time integer or finite list. Runtime-dependent bounds are refused. An expansion may contain at most 256 generated rows.
