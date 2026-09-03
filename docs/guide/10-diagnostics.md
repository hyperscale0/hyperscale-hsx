# Diagnostics

An HSX diagnostic carries a stable code, severity, stage, source line and column, message, and fix. Match automation on the code. Treat the message as explanation rather than a stable interface.

The stages locate the refusal:

- `parse` means the source did not form valid declarations or expressions.
- `bind` means an import, name, port, or reference did not resolve.
- `typecheck` and `check` mean the program formed but violated a type or language law.
- `lower` means the typed program could not emit valid UDL.

Use one loop: compile, find the first error code in the diagnostics reference, apply its stated fix, and compile again. Do not suppress the diagnostic or alter generated UDL by hand.

```hsx
program repaired_transfer "Repaired transfer"
import { instant_transfer } from "std/settlements"
party sender: person
party recipient: business
settlement transfer = instant_transfer {
  payer: sender
  payee: recipient
  amount: transferAmount: money(SAR)
  fees { sender: 1% }
}
```

Exit code `0` means the command accepted the program. Exit code `1` means compilation refused it. Exit code `2` means the invocation or file operation failed. `hsx explain HSX1201` prints the catalog entry for one code.
