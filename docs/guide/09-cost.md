# Cost

Compilation emits a deterministic cost manifest beside the UDL document. The manifest pins the cost-table version and effective digest. It records fixed structural cost, action effect rows, payer, settlement policy, meters, per-event prices, and any basis-point volume price.

```hsx
program direct_sale "Direct sale"
import { instant_transfer } from "std/money_flows"
party buyer: person
party seller: business
settlement sale = instant_transfer {
  payer: buyer
  payee: seller
  amount: saleAmount: money(SAR)
  fees { buyer: 1% }
}
```

Read an action line as `instrument.action`, followed by the effect signature and its count. The payer tells whether the product or end customer bears the row. `perEventMinor` prices one occurrence in the cost table's billing currency. A row with `bps` also names a volume meter.

The monthly estimate is an expression over declared meter variables. Billing supplies observed readings to that frozen expression. Recomposition emits a new manifest for the next commercial snapshot. It does not rewrite a prior manifest. During recomposition planning, compose plan calculates the candidate program's proposed estimate and reconciles it against the current Build's frozen pricing quote. The existing Product retains its frozen quote until the recomposition is applied.

An effect without a price row reports `HSX1301`. An invalid price reports `HSX1302`. A missing cost table also reports `HSX1301`. `examples/cost-table.json` ships one rate card per priced billing currency; the compiler picks the card whose currency the program's money fields move. Money in a currency no card prices reports `HSX1304`, and money in two currencies reports `HSX1305`: a program bills in one ledger currency. A move of a `money<SAR>` field moves SAR whatever the caller wrote in the instance currency field: the compiler pins the move's currency binding to the constant, and a binding it cannot pin reports `HSX1306`. Do not create another table for documentation.

Do not confuse an action `quote` with the commercial cost manifest. `cancellable_booking.cancel` quotes a customer-visible cancellation penalty and `confirm` commits it. The compiler counts an instrument that carries a quote as unwind work because an expired or abandoned offer still needs bounded cleanup. The cost manifest prices that runtime work from the shipped rate card. It does not replace, spend, or alter the quoted financial amount.
