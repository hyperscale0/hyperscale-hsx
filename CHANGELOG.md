# HSX 5.0.0

Money moves refuse a zero amount unless the action declares `allowZero: true`,
so a program that moved zero before now fails at compile or at execution. The
standard library declares the permission on calculated pieces (repayment
slices, floored fees, rounding remainders) and keeps a positive requirement on
authored totals. Pools refuse a contribution above the remaining target and
fee collection posts the exact fee that was billed.

Headers carry binding contracts: `dependencies` name a binding that only
applies under one enum choice of another, and `parameterDiagnostics` explain
why a typed parameter refuses a policy shape. Ten diagnostics were rewritten
to name the failing construct and the repair; each carries a compiler witness.
Worked programs open with a one-line intent comment and `repair-approval.hsx`
joins the examples. Header docs, README and llms-full.txt correct sixteen
stale claims. Package, compiler and VS Code versions are aligned at 5.0.0.

# HSX 4.2.0

Adds the browser-safe `language` export with semantic highlights and hover
explanations for complete and unfinished HSX. Headers own instrument summaries,
verbatim signatures, parameter bounds, lifecycle states and action actors.
The playground uses this API for its token view and explanations. Drift tests
cover keyword help, TextMate keyword matching and authored instrument summaries.
Six instruments in cards and savings now author their missing summaries.
The TextMate string escape pattern now matches a single escaped character.
Package, compiler and VS Code versions are aligned at 4.2.0.

Adds twelve business programs, one for each standard header, beside the minimal
financed sale and the serviced car finance example. The browser-safe `examples`
export contains source and metadata generated from the authored files. One test
compiles every example, another checks bundle drift, and the language service
covers every sample token and offset. The generated sample index lists all files.

Resolved party parameters take precedence over same-named attachments when
lowering account owners. Savings memberships use the circle calendar without
collecting a second, conflicting dates field.

# HSX 4.1.1

`examples/serviced.hsx` is a second worked programme: a financed sale with a late charge, payment reminders, an early payoff rebate and a write-off. The car financing spec compiles it from the file. No grammar or standard library change.

# HSX 4.1.0

Second-person approval is deleted from the grammar and the standard library. `financing.portfolio_limit` is a top-level instrument, a plan's `funds` hold is optional, and `insurance.cover` and `financing.credit_line` name their provider with `adapter: text` instead of a party. A car financing programme compiles from the standard library and is covered by its own spec.

# HSX 4.0.1

The compiler resolves list targets in field blocks and child record export paths, refuses duplicate child export path suffixes naming both candidates, and no longer restricts aggregate limit bounds at compile time; `<= self.<field>` bounds resolve at runtime. No grammar change.

# HSX 4.0.0

HSX adds authored object kinds and attachments with party bindings to owner, actor or operator. Action subject requirements are collected when an attached action runs. The vehicles header is deleted, public instrument create actions are gone, and UDL 3 is rejected. Programs compile to UDL 4; recreate development estates.

# HSX 3.3.0

The standard library adds financing (range primitive, installment waterfall, late charges, collections, vehicles, marketplace and escrow), reporting.portfolio, collections.reminder with clock actions, and money.payout distinct-member approval. Cost estimation covers the nested children of the financing range. The compiler targets UDL 3.2.0.

# HSX 3.2.0

Header manifests carry an `authoringTemplate` per object: the `use` import, an instance placeholder, the source line with one placeholder per required binding, and the typed binding list. Required tunables, text tunables and reference selectors (`object`, `party`) are bindings; everything else keeps its default. The permutation suite proves every template compiles once its placeholders are bound. No grammar change.

# HSX 3.1.0

Licensed under the Hyperscale Intellectual Property and Copyright License 1.0 (`LicenseRef-Hyperscale-IPCL-1.0`), Tier 2 (Source Available). The AGPL-3.0-only grant ends with this release; earlier versions keep it. `LICENSE.md` and `NOTICE.md` replace the previous license, licensing and trademark files; trademark and conformance rules now live in the license. No grammar change.

# HSX 3.0.1

std financing: `payment.pay` collects slice by slice in position order (profit before principal under `fines_profit_principal`, principal first under `principal_profit`) and selects pending and due slices only, so paid slices stay paid. The CLI reports the package version from `version.ts`.

# HSX 3.0.0

Version 3 replaces the previous grammar. Recreate development estates. There is no migration reader.
