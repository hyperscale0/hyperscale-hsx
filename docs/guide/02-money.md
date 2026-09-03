# Money

HSX indexes money by currency. `money<SAR>` is the field type inside a general instrument. `amount: total: money(SAR)` binds a settlement parameter to a new SAR money field. Values use integer minor units, so `1250` means SAR 12.50.

Money of different currencies never unifies. Percent literals use basis-point precision: `2%` is 200 basis points and `2.5%` is 250 basis points. The compiler floors percentage-derived minor units and assigns any declared remainder according to the selected instrument.

Money is linear. A computed amount must be consumed exactly once. This invalid general-form program uses `rest` twice, so the compiler reports `HSX1201`:

```hsx expect=HSX1201
program duplicated_money "Duplicated money"
party buyer: person
instrument invoice {
  fields { amount: money<SAR>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: buyer; }
  action create { steps: []; }
  action pay {
    computes remainder rest { amount_ref: total; on_zero: refuse; total_path: fields.amount; }
    moves: [{ amount: rest; }, { amount: rest; }]
    steps: []
  }
}
```

Do not use free arithmetic to repair a linearity refusal. Choose a standard-library split, fee, or derived-amount form that states where every minor unit goes.
