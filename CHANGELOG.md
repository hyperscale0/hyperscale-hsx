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
