# Your first program

An HSX file declares one program, the parties that take part, and the instruments that define its money rules. A settlement applies a standard-library instrument. The compiler checks the application and emits canonical UDL with an origin map and a cost manifest.

This program sends a tip from a listener to a host:

```hsx
program tip_jar "Tip jar"
import { instant_transfer } from "std/settlements"
party listener: person
party host: business
settlement tip = instant_transfer {
  payer: listener
  payee: host
  amount: tipAmount: money(SAR)
  fees { listener: 1% }
}
```

`tipAmount` is an input field measured in SAR minor units. The settlement becomes an instrument named `tip` in the UDL document.

A port declares a decision that an external caller may supply. The port names the parties allowed to answer and may define a typed input shape. Use a port only when the selected instrument accepts a condition parameter.

After package installation, run `npx hsx check product.hsx` while editing and `npx hsx build product.hsx --out product.udl.json` when the program passes. In a repository checkout, run `bun install` once, then use `bun run bin/hsx.ts check product.hsx` and `bun run bin/hsx.ts build product.hsx --out product.udl.json`.
