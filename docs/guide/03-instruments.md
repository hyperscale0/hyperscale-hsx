# Instruments

Start with the standard library. Import a settlement module by export name from `std/settlements`, then apply it under a local settlement name. The local name becomes the emitted instrument id.

```hsx
program equipment_hire "Equipment hire"
import { scheduled } from "std/settlements"
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

The generated standard-library reference lists every module, parameter, action, port, and emitted clause. Read that page before choosing a module. Prefer one module that already states the required lifecycle over a custom instrument with copied mechanics.
