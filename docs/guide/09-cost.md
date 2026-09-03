# Cost

Compilation emits a deterministic cost manifest beside the UDL document. The manifest pins the cost-table version and effective digest. It records fixed structural cost, action effect rows, payer, settlement policy, meters, per-event prices, and any basis-point volume price.

```hsx
program direct_sale "Direct sale"
import { instant_transfer } from "std/settlements"
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

The monthly estimate is an expression over declared meter variables. Billing supplies observed readings to that frozen expression. Recomposition emits a new manifest for the next commercial snapshot. It does not rewrite a prior manifest.

An effect without a price row reports `HSX1301`. An invalid price reports `HSX1302`. A missing cost table also reports `HSX1301`. Use the single rate card shipped at `examples/cost-table.json`; do not create a second table for documentation.

Do not confuse an action `quote` with the commercial cost manifest. `cancellable_booking.cancel` quotes a customer-visible cancellation penalty and `confirm` commits it. The compiler counts an instrument that carries a quote as unwind work because an expired or abandoned offer still needs bounded cleanup. The cost manifest prices that runtime work from the shipped rate card. It does not replace, spend, or alter the quoted financial amount.
