# HSX

HSX is the typed language for money on the Hyperscale operating system. It
defines general instruments, composes a standard library, checks
currency-indexed linear money, and calculates cost at compile time.
HSX compiles each accepted program to canonical UDL.

```hsx
program held_sale "Held sale"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port accept_delivery
}

port accept_delivery { allowed: [buyer] }
```

```sh
npm install @hyperscale0/hsx @hyperscale0/udl
npx hsx check product.hsx
```

After installing dependencies in a repository checkout, run `bun run bin/hsx.ts check product.hsx`.

```ts
import { compile } from "@hyperscale0/hsx";
const result = compile(source, { costTable });
const { document, originMap, costManifest } = result.artifacts!;
```

The compiler returns three artifacts named `document`, `originMap`, and `costManifest`.

`document` is the canonical UDL value.

The built-in module resolver reads every settlement module in `std/settlements`.

The CLI exits 0 for an accepted program, 1 for a refused program, and 2 when it cannot use the command line or input file.

Every compiler diagnostic code appears in the generated diagnostics catalog.

Start with the [first program](./docs/guide/01-first-program.md), then read the
[guide in order](./docs/README.md). The generated [grammar](./docs/reference/grammar.md),
[standard library pages](./docs/reference/std/), and
[diagnostics catalog](./docs/reference/diagnostics.md) track the compiler.

HSX is like Terraform for a financial product: the program declares the
contract, and the compiler refuses an invalid plan before a runtime reads it.

The VS Code extension is built as `hsx.vsix` in CI. Download the workflow
artifact, then run `code --install-extension hsx.vsix`.

The editor extension runs `hsx lsp` over stdio to surface diagnostics and format documents. Configure `hsx.serverPath` or install the compiler binary globally with `npm i -g @hyperscale0/hsx`.

HSX is licensed under AGPL-3.0-only. See [LICENSE](./LICENSE) and
[LICENSING.md](./LICENSING.md).
