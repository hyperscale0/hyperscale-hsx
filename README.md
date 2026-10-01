# HSX

Read [how Hyperscale fits](https://hyperscale0.ai/docs/runtime.md#how-hyperscale-fits) for provider authority and the shared operation API.

HSX is a typed composition language for a company's objects, agreements and
actions. Programs can model a repair approval, a rental deposit or a financing
plan. The compiler produces canonical UDL for an executor. It executes no actions.
This release supports SAR.

## Start here

Install the published package locally with `npm install @hyperscale0/hsx`.
Its `hsx` executable requires Node.js 22 or later. Use `npx hsx` for a local install:

```sh
npx hsx check rental.hsx
npx hsx build rental.hsx --out rental.udl.json
npx hsx cost rental.hsx
```

Start with the [first program and rental guide](docs/README.md). Save the
[rental source](examples/rental-deposit.hsx) as `rental.hsx` for these commands.
It holds 1,000 SAR, charges a one-time 50 SAR late fee, and returns the remainder.
The guide explains the fixed business binding and the host needed to execute it.

`npx hsx headers --json` prints every std instrument and its tunables from the
bundled headers as JSON. The [samples](examples/) include both complete action paths and
compositions that still need child-record actions or adapter bindings. A compile
pass does not prove that a flow is publicly executable or funded.

## Bases and examples

Choose one of three starting points: write a bespoke program, tailor a neutral
[base](bases/), or adapt a company from [examples](examples/). The `std/` headers
supply the mechanisms behind both bases and examples. A base supplies one object
and the actions its mechanism needs, without a company's names or prices.

```ts
import { bases, type HsxBase } from "@hyperscale0/hsx/bases";

const escrow: HsxBase = bases.find((base) => base.id === "escrow")!;
const source = escrow.source;
```

Each base has `id`, `title`, `summary`, `headers` and `source`. Its ID is the std
header name. The array is sorted by ID and imports no filesystem APIs. The eleven
bases cover escrow, money, wallet, cards, financing, savings, marketplace,
insurance, lending, collections and reporting.

Architect tailors the base's name, parties, fields, economics and action paths.
Required amounts come from action inputs or the object's price. Optional settings
use std defaults. Financing starts with two instalments and a required zero profit
rate. Savings starts with two members and collects its start date and contribution
at creation. Architect sets these terms during tailoring. Insurance binds the
sandbox `conformance_boundary` adapter; replace it with the insurer's registered
adapter for that provider. Parties, accounts, funding, inputs and lifecycle
prerequisites still govern execution.

## Browser language service

```ts
import { highlight, describe } from "@hyperscale0/hsx/language";
import { examples } from "@hyperscale0/hsx/examples";

const source = examples[0]!.source;
const spans = highlight(source);
const hover = describe(source, source.indexOf("program"));
```

Both functions accept incomplete source and need no Node or editor framework.
Spans use half-open UTF-16 offsets. Whitespace has no span; unknown hover targets
return `null`. Pass a `StandardLibrary` as the last argument for custom headers.
Header signatures and bounds come from compiler metadata. Bounds use minor
currency units, basis points and milliseconds.

Examples have `id`, `title`, `summary`, `headers` and `source`. The ID is the
filename without `.hsx`; leading comments supply the summary. The array is sorted
by filename and contains no filesystem imports. Workspace imports use
`@hyperscale0/hsx` instead of the published `@hyperscale0/hsx` name.

## Working from source

Run `bun install` and `bun run build` in this package's public source checkout.
Run `bun bin/hsx.ts check examples/rental-deposit.hsx` to use the source CLI.
`bun run check` checks types, compiles bases and examples and checks bundle freshness.

Edit prose in `docs/README.md`, programs in `bases/` and `examples/`, and header comments in
`std/`. Run `bun run generate` after changing these inputs. It emits the header
base and example bundles.
`bun run build` also builds the browser playground.
