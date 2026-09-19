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
