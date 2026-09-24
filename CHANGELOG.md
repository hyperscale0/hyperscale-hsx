# HSX 5.7.0

Follows UDL 4.9.0. Object `entryActions` admits enrolled customers through named
actor-bound create actions. Product-scoped limits resolve across records with
matching parties. `programTax` moves use an operator-owned pass-through account.

Late charge creation accepts a slice reference for plans with multiple instalments.
Financing, collections and lending samples expose repayment child actions.
Aggregate selectors retain their selected instrument family, including child
records, so shared limits compare the matching contracts across Builds.

# HSX 5.6.1

Action summaries without authored text use the action title without the instrument id.

# HSX 5.6.0

The compiler records the standard block origin of every instrument compiled
from a bundled std header: block key, record path and header digest. Travel
booking cancellations declare `purpose: option`. Follows UDL 4.8.0.

# HSX 5.5.0

Std money moves declare posted economic purposes. Fee legs and recipient choices
retain separate purposes. Paid earnings and payout refunds retain their original
transfer identity. Supports UDL pass-through money.

# HSX 5.4.2

Follows UDL 4.6.0: an action's `availability` carries `blockers` with a code and a plain reason instead of one code; an adapter that is not set up reads as `setup_required`. Tests updated. No compiler behaviour changed.

# HSX 5.4.1

Documentation only. The newcomer path now starts from a rental deposit
with a fixed late fee and a partial refund (`examples/rental-deposit.hsx`),
every sample program exposes agreement creation, the twelve standard
library headers explain their instruction cost in their comment blocks,
the reference explains objects versus agreements and admission versus
static acceptance before using the terms, and `llms-full.txt` links are
rebased to the package root. No compiler or standard library behaviour
changed.

# HSX 5.4.0

Standard library: financing collects the missing down payment as a
separate checkout action (`collect_down_payment`) after a signed plan,
with escrow cancel returning checkout cash when financing is abandoned;
insurance cover pays the insurer's net premium and the broker's
commission as two moves, the broker defaulting to `programOperator`;
savings memberships take a fixed seat with `preceding` recipients
counted before the pot is received; every header documents which
actions to expose and why. An instrument's own parameter shadows a
same-named sibling attachment instead of colliding with it.

Header admission refuses unsupported tunable constructors: only
`enum(choices)` and `integer(minimum, maximum)` carry arguments, so
`money(10 SAR, 20 SAR)` no longer loses its bounds silently. An
exposure alias cannot reuse another action's generated public name.
Undeclared subject-path diagnostics keep the imported header's source
location. The CLI refuses `--strict` and `--json` where they have no
effect and `check --out`, and output commands require a real
destination. The `HSX_TARGET_UDL_VERSION` export is gone and the
model-readable index heading is unversioned.

# HSX 5.3.0

Malformed strings, field constructors, lifecycle and action shapes,
integer bounds, constraints and family targets are refused with a
diagnostic before traversal instead of throwing. Lifecycle pruning needs
a real constant specialization: a `from` typo, an unreachable authored
state and an explicit exposure that does not resolve reach UDL3001
instead of being dropped. Typed child references follow declarations and
export paths, so attachment order no longer matters, and subject
requirement propagation is bounded by the declared action count instead
of 32 passes. Adapter and party lookups use own entries only. Imported
header diagnostics keep their source and the CLI prints it. Duplicate
currency, instrument and parameter declarations refuse. HSX1014 refuses
JSON authoring. Compilation and metadata share header admission, hover
text names staff and SAR restrictions, and the keyword tables carry
`has`, `boundary` and `instruction`. The standard `financing.late_charge`
drops a `refunded` state no action reached.

# HSX 5.2.0

An instrument field can bind an account owned by an ADL adapter:
`account(adapter(binding), cash, "premium")` resolves at execution
through the Product's adapter binding to the provider's account in the
tenant's ledger (UDL 4.4.0). Providers stay adapters, not parties. The
standard insurance header pays the insurer its premium net of the
tenant's commission with a plain move, reverses both portions on refund,
and reserves claim funds from the insurer-owned account.

# HSX 5.1.0

Child records of an attached instrument compile as their own attachments
(`<attachment>_<record>` with a `parent`), so a guarded child action is
discoverable and admissible from the object it belongs to (UDL 4.3.0).

Standard library review: card authorizations require an active holder,
a lending commitment records its investor account and caps tickets per
investor rather than per wallet, pool contributions are bounded at 366
paid records, portfolio ageing counts earned profit as outstanding, and
a late charge assesses a zero amount without refusing. Docs corrected.

# HSX 5.0.1

Per-action subject evidence compiles: `fields { price: money = subject.price }`
and `set: { x: { field: subject.y } }` accept requirements declared on the
action alone (UDL 4.2.1).

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
