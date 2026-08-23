# HSX

HSX is a language for describing how money moves through a financial product.
You write the product's parties, the things they trade, and the settlements
between them; the compiler turns that into an intermediate representation the
Hyperscale engine executes.

Seventeen lines of HSX ([`car-escrow.hsx`](./test/fixtures/car-escrow.hsx)) are
a used-car escrow: the buyer's money is held, the buyer's own backend confirms
the handover, the platform takes asymmetric fees, and a cancellation splits the
held amount to the basis point. There is no account provisioning in it, no
lifecycle table, no transfer plumbing. That is the point: those are consequences
of the settlement you named, so the compiler derives them instead of asking you
to hand-write them and get them right.

The line here is the one HCL draws with Terraform. **The language is open.**
The lexer, the parser, the typechecker, the lowering, the diagnostics, the IR
schema, and this compiler are AGPL-3.0-only and live in this repository. **The
runtime that executes the IR is the product**, and it is not open. HSX targets
it the way HCL targets a provider: you can read every rule the compiler
enforces, compile any program, and inspect the exact document that gets
executed.

## Install

```bash
npm install @hyperscale0/hsx@alpha
```

The `@alpha` tag is not optional. There is no `latest` tag before 1.0.0, so a
bare `npm install @hyperscale0/hsx` fails loudly rather than quietly installing
something you did not choose.

## A program

[`photo-booth.hsx`](./examples/02-imports-and-archetypes/photo-booth.hsx), a
booth rental company, whole apart from its comments:

```hsx
program photo_booth "Photo booth rentals"

import { held_payment } from "settlement"

party renter:  person
party company: business

asset booth: good { title_transfer: off_platform }

settlement booking = held_payment {
  payer:   renter
  payee:   company
  amount:  bookingFee: money(SAR)
  fees { renter: 1%, company: 3% }
  release: port confirm_delivery
  on_cancel(funded) { renter: 90%, company: 10% }
}

port confirm_delivery {
  allowed: [company]
  shape {
    boothId:     id(booth)
    deliveredOn: date
  }
}
```

```ts
import { compile } from "@hyperscale0/hsx";

const result = compile(await Bun.file("photo-booth.hsx").text());

result.verdict; // "valid" | "warning" | "invalid"
result.diagnostics; // [{ line, column, severity, stage, message }]
result.artifacts; // present unless the verdict is "invalid"
```

`result.artifacts.document` is the HSX-JSON IR. Those 20 lines compile to one
escrow noun, `booking`, carrying:

- **five money fields**: `bookingFee`, the three pieces it partitions into
  (90%, 7%, 3%: the finest split that every exit agrees on, since release pays
  97/3 to company and platform while cancellation pays 90/10 to renter and
  company), and `serviceFeeAmount` for the renter's 1% charged on top;
- **a `partitions` clause** proving those pieces sum to `bookingFee` exactly,
  checked at create admission before any money moves;
- **fifteen verbs**: the funding chain, the fee collection, the port itself,
  the release payout, the cancellation unwind, and the abandonment refunds,
  each with its `from` states, its `to` state, and its ledger moves.

`result.artifacts.frame` is the congruent Business Frame: the same product as
actors, money events, rules, and fees, for the surfaces people read rather
than the runtime that executes.

Both shapes are specified in
[`spec/hsx-ir.schema.json`](./spec/hsx-ir.schema.json) (JSON Schema 2020-12),
and every file under `examples/` and `test/fixtures/` is validated against it
in CI.

## The command

```bash
hsx check photo-booth.hsx              # diagnostics, nothing else
hsx check photo-booth.hsx --strict     # warnings fail too
hsx build photo-booth.hsx              # artifacts to stdout
hsx build photo-booth.hsx --out ir.json
```

Exit codes: `0` the program compiled, `1` it was refused, `2` the command line
or the input file could not be used. A refused program and a mistyped command
are different failures, so they get different codes.

There is no `hsx fmt`. This package ships no formatter, and shipping a bad one
is worse than shipping none.

## Learn it

- [`examples/`](./examples/) has four programs, in order: the smallest one that
  moves money, archetypes and ports, a walk through the diagnostics, and a
  complete small product. Each has its own README, and each is compiled by the
  test suite so they cannot rot.
- [`docs/reference.md`](./docs/reference.md) is the language reference: lexical
  grammar, EBNF, what each stage does, the diagnostic model, and every
  archetype in the `settlement` standard library with its parameters and
  constraints.
- [`editors/vscode/`](./editors/vscode/) carries the syntax highlighting.

## Versioning

Two numbers move independently.

**IR version** is the literal `"hsx": 1` stamped into every compiled document,
exported as `HSX_IR_VERSION`. A consumer reads that one integer to decide
whether it understands the document. It moves only when the emitted IR shape
changes in a way a consumer must notice.

**Package version** is this package's semver, currently `1.0.0-alpha.1`,
published only under the `alpha` dist-tag. It moves whenever the compiler
changes, including changes that only affect a diagnostic's wording.

IR version 1 is unstable until the package reaches 1.0.0. Until then an alpha
release may change what the compiler emits, and every such change is listed in
[`CHANGELOG.md`](./CHANGELOG.md). After 1.0.0, an incompatible IR change bumps
the literal to `2`.

## Status

Alpha. Nine settlement archetypes ship and all nine lower. The compiler is in
production use; the surface is settled enough to build on and the version
number is honest about the rest. What is most likely to move: diagnostic
wording (there are no stable diagnostic codes yet), and the archetype
parameter surfaces as more products land.

## Contributing

Issues only. Hyperscale makes the changes to the language and the compiler; you
propose them in an issue carrying the program you were trying to write and the
fixture the change would add. [`CONTRIBUTING.md`](./CONTRIBUTING.md) has that
model in full, plus the setup, the test commands, and the one hard rule: a
grammar change without a fixture is not a grammar change. Conduct:
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Vulnerabilities:
[`SECURITY.md`](./SECURITY.md).

## License

AGPL-3.0-only, with a commercial license available from Hyperscale LLC for
organisations that cannot accept the AGPL. See [`LICENSE`](./LICENSE) for the
text and [`LICENSING.md`](./LICENSING.md) for which one you want and how to ask
for the commercial one. The marks are not covered by either; see
[`TRADEMARKS.md`](./TRADEMARKS.md), which also carries the rule for claiming
HSX compatibility.
