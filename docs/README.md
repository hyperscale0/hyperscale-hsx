# HSX 4

A program declares business objects and financial instruments. Objects contain
optional metadata. Attachments expose named actions against an object.

```hsx
program cars "Cars"
use escrow
object car "Cars" {
 fields { make: text, model: text, year: integer }
 columns: [make, model, year]
 attach sale = escrow.hold { payer: actor, payee: owner, expose fund as sell }
}
```

Every attached party parameter binds to `owner`, `actor`, `operator`, a declared
business, or a declared staff party with a supported role. Configure declared
business participants per Build. Declared person parties cannot bind attachments.
`owner` is the object's resolved customer or business, `actor` is the authenticated
caller, and `operator` is the program operator. A parameter with one of these
names binds by name. Other party parameters require an explicit binding.
Unbound parameters report `subject_party_unbound`. These bindings are frozen in
UDL `objects[].attachments[].parties`; no caller supplies party IDs at creation.

Object `fields` are authored metadata. `columns` names up to eight normalized
fields. An action's `subject { price: money }` declares its metadata requirement;
`subject { adapter: verification }` inherits a selected ADL declaration. The
compiler freezes the adapter identity, digest and requirements. An unavailable
declaration leaves a null snapshot in compiled output. Product creation and
recomposition reject unresolved or changed declarations during Build admission.
Execution checks the frozen declaration too; later adapter unavailability can
block actions on an already saved Build.

An attachment can use `rename { price: salePrice }` to separate requirements with
different meanings. Matching names must match types and constraints. The compiler
reports `subject_field_conflict` with both origins, or `subject_field_unknown` for
unknown rename sources, columns or subject expressions. Action admission reports
`subject_requirement_missing` or `subject_adapter_unbound` before dispatch.

Creation accepts `{}`. Every normalized field, including adapter requirements,
is optional at creation. Only a named action requires its subject metadata.
Use `attach` inside the object block to configure its financial instruments.

The header defines the available policies. The company chooses percentages, amounts, durations,
parties and typed references. `funds: sale` links the stored records through the
library's declared reference type. References can name a child, such as
`receipt: plan.settlement`. A header tunable declared `ref<T>[]` accepts one object or a list of up to 16
objects of type T. `on: [plan_3, plan_6]` creates one late-charge or collections
policy. Its references can point into either plan; selections can span both.
A plain `ref<T>` accepts one object only.
Imports are `use header`; there are no file imports, macros or executable strings.

Amounts use `750 SAR`; percentages use `2.5%`; durations use `48h`, `3d`, or `1w`.
Dates use `2026-11-28` or a timestamp with an explicit offset. Money has at most two
decimal places and percentages at most two. The compiler uses integer minor units
and basis points. Fee and tax calculations round down. Split percentages sum to
100%; the last declared recipient receives the rounding remainder. Finite
schedules use positions 1 through n and put the division remainder in position 1.
Tax binds `programTax`. Fees default to `programOperator`. Fine, recovery and
residual destinations are party tunables. Unused `programFines` and `programCosts`
bindings are omitted.

Attached actions are private unless the attachment exposes them with
`expose fund as sell`. Exposure grants no authority. Clock and parent actions
remain executor-owned. Instruments have no standalone create route: an
attachment exposes its create action by name (`expose create as finance`) or
keeps it internal. Callers create objects and run their attached actions.

Accounts use cash or claim books. A move stays in one book. `account of buyer`
aliases the default cash account; `account of self` provisions an owned account.
`account(lender, cash, "capital")` binds a named account.
`account(buyer, claim, contra, "debt")` declares the borrower's claim contra account.
`account(seller, cash, external, "bank")` binds the executor-managed bank destination.
Outstanding debt is an account balance. The library pairs cash repayment with
claim reduction and represents receipts as immutable child records. Cash and loss
shares round down; the declared residual account receives leftover minor units.

Money moves require a positive amount by default. An action may declare
`allowZero: true` when a calculated piece can be zero, such as an exhausted
repayment slice, a floored fee or a rounding remainder. A zero create move in
that action posts no transfer and captures no receipt. The permission belongs
to that action only and does not pass to invoked actions. Reserve, post and
void still require real reservation receipts. Keep a positive requirement on
an authored total when only its calculated pieces may be zero.

```hsx
action collect {
  from: pending, to: paid
  allowZero: true
  moves self.calculatedPiece from payer to payee
}
```

The four transfer instructions are create, reserve, post and void under
`internal_transfer`. A captured transfer exposes reserved, posted, settled,
reversed or voided status. Voided means a released reservation. Settled means
provider confirmation, not an internal account balance change.

For a new record type, declare `instrument name { fields { ... } lifecycle { ... }
action create { ... } }`. Fields are `money`, `account of buyer`, `ref<order>`,
`date`, `duration`, `text`, `integer`, `percent`, `boolean`, `enum(a, b)` or
`list(date, 12)`. `?` makes a field optional; `= value` fixes a constant or a typed
calculation. Actions declare `input { reason: text }`. Headers and expert records
write ordered requirements and moves as expressions:

```hsx
requires self.payer == self.order.buyer
requires self.order in [placed]
moves self.price from payer to self.held
moves self.price from self.held to payee fee fee
```

Comparisons accept `==`, `!=`, `<`, `<=`, `>` and `>=`. A path beginning with
`self`, `input` or `party` is a field operand; a quoted string, amount or number is
a literal. `requires unique "order" on [self.order]` fixes an identity namespace.
`requires count of { instrument: child, reference: "parent", anchor: self.id,
states: [pending], limit: 12 } == 12` checks a typed selection; `sum "amount" of`
uses the same selection syntax. `invariants` accepts these requirement expressions.
`requires hours self.now between 8 and 20 timezone "Asia/Riyadh"` checks local hours.
`requires evidence self.payer family registry check ownership result verified
maxAge 1d` requires a recent completed provider check.

`moves reserve amount from payer to payee capture receipt` reserves a transfer;
`moves post self.receipt` posts it and `moves void self.receipt` releases it.
`moves amount from payer shares shares` expands a declared split. Optional `fee`,
`capture` and `key` modifiers follow a move in that order. Repeated clauses keep
their declaration order. The JSON-like clause form remains accepted and lowers
to the same [UDL clauses](../../udl/spec/README.md).
They cannot add kernel instructions. `at(list, position)` reads a dated list;
`aggregate(selection, "amount")` sums selected money; `ratio(amount, weight, total)`
floors a weighted share. `records` declares child types. `invoke` can create a child
with typed input in the same transaction.

The compiler removes branches excluded by fixed enum tunables. An invalid program reports its source line
and a correction. No artifact is returned with diagnostics.

## Financing policies

`financing.installments` keeps principal and fixed flat profit as claims from
activation. The company chooses where funding goes and when profit becomes earned.
All choices use accounts, calculations and moves in the same two books.

| Tunable                            | Default                  | Selected behavior                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disburse_to`                      | `funds`                  | `funds` pays down payment and principal into the hold and confirms it. `borrower` credits principal to the borrower's balance.                                                                                                                                                                                                                                      |
| `profit_earned`                    | `on_payment`             | `on_payment` collects unearned profit on payment. `by_schedule` moves unearned claims to earned claims at each slice's date. `at_disbursement` makes that move at activation. Cash arrives only on payment.                                                                                                                                                         |
| `apply`                            | `fines_profit_principal` | Collect assessed fines by overdue date, then evidenced costs, then each slice in position order, profit before principal. `principal_profit` collects each slice in position order, principal before profit. `pro_rata` uses the slice's fixed principal:profit ratio, caps each side by its collectible balance, and assigns the remainder without stranding cash. |
| `payoff_rebate`                    | `100%`                   | Reverse this share of unearned profit to borrower debt. Collect the remainder and all earned profit with outstanding principal.                                                                                                                                                                                                                                     |
| `late_charge.fines_to`             | `programOperator`        | Receive fine cash and fund its refunds.                                                                                                                                                                                                                                                                                                                             |
| `late_charge.costs_to`             | `programOperator`        | Receive evidenced recovery cash and fund its refunds.                                                                                                                                                                                                                                                                                                               |
| `collections.case.fee`             | `20%`                    | After payment succeeds, transfer this share of the payment amount from plan capital to the agency.                                                                                                                                                                                                                                                                  |
| `lending.distribution.residual_to` | `programOperator`        | Receive the cash remainder and own the claim loss remainder after weighted distribution.                                                                                                                                                                                                                                                                            |

Each slice owns separate unearned and earned claim accounts. Scheduled recognition
uses a dated child record so a partial payment cannot disable the maturity clock.
A normal payment collects only earned profit for the schedule and disbursement
choices; payoff can also collect non-rebated unearned profit. Partial fines and
costs stay assessed until their receivable reaches zero. Immutable receipts let
a refund restore only what that payment collected. The plan's payment receipt
records actual principal and profit after all ordered collections finish.
Write-off moves principal and earned profit claims to loss and reverses unearned
profit to debt. There is no provision policy or write-off tunable.

## Header branches and bounds

A header may select action clauses at compile time:

```hsx
when disburse_to is borrower {
  moves self.principal from self.capital to self.borrower
}
```

`when <reference tunable> has <field>` includes its clauses only when the bound
object declares that field. The compiler checks the object's declared shape,
regardless of declaration order, and emits no runtime branch. Financing uses
this to commit marketplace orders for order-backed holds while plain money
holds need no order relation.

`when <enum tunable> is <value>` accepts requirements, calculations, moves and
invocations, including nested branches. The compiler emits only the selected
clauses and preserves their order within each UDL phase. Lifecycle and actor
clauses stay outside branches. Calculations and requirements run before moves;
invocations run after moves. A collections fee therefore uses an internal action
invoked after payment. Clock and parent actions have no public API name.

`integer(1, 366)` declares an inclusive tunable bound. The compiler-owned manifest
publishes enum values, numeric minima and maxima, and cross-tunable constraints.
Bounds use minor units for money, basis points for percentages and milliseconds
for durations. Money spans 0 through 999999999999999999 minor units; percentages
span 0 through 10000 basis points. Durations start at 1 millisecond. Integers
default to 0 through 9007199254740991 unless their declaration narrows the range. For example, `constraints { contact_from: less_than(contact_until) }`
requires a valid hours interval. `at_most` and `greater_than` are also supported.
A refusal names the tunable. Empty `all(type)` selections lower to zero aggregates
or no invocations, so a plan does not require a late-charge object.

Headers can declare conditional bindings and parameter policy diagnostics:

```hsx
dependencies {
  funds {
    selector: destination, is: held
    message: "Attachment `{attachment}` needs a funds binding."
    fix: "Bind funds to a hold attachment."
  }
}
parameterDiagnostics {
  amount {
    accepts: "a fixed amount"
    percentage: "a percentage-based charge"
    fix: "Author a rate calculation when the policy varies with a base amount."
  }
}
```

Each dependency names a declared tunable, an enum selector and one of its choices.
The compiler checks selected dependencies before lowering and the manifest retains
them. `{attachment}` in the message expands to the authored attachment name.
Parameter diagnostics name a declared tunable and explain its accepted value,
unsupported percentage semantics and repair. They do not change the tunable type.
UDL refusals retain their UDL codes. A terminal-money refusal includes the owned
account and the prover's action path in related diagnostic information.

Build with `hsx build company.hsx --out company.udl.json`; check with
`hsx check company.hsx`; print instruction counts with `hsx cost company.hsx`.
Print the compiler-owned object manifest with `hsx headers --json`.
The compiler API is `compile(source)`. A valid result contains `artifacts.document`,
`costManifest` and source origins. Instruction counts are not bank tariffs or a
promise of provider execution cost.

The [header inventory](headers.md) is generated from the declarations. The
[object example](../examples/library.hsx) shows authenticated role bindings.
The [playground](../playground/index.html) compiles locally in the browser.

## Financing attachments

Financing retains its authored borrower and portfolio limits. Bind every party
parameter to a subject role, declared business or staff party with a supported
role, and link the existing escrow and limits attachments.
No limit is inferred from object metadata.

See the complete [financing object example](../examples/library.hsx).

## Standard-library behavior

Read the instrument's states, time gates and moves before promising a money
outcome. A compiler pass does not prove that required actions are exposed,
adapters are bound, participants have funds, or the flow can finish.

| Instrument                                 | Behavior                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `financing.installments`                   | `share` allocates collected profit to a cash payable owned by `capital`. It does not itself pay operator income.                                                                                                                                                                                                             |
| `financing.limits`                         | `per_borrower` caps outstanding principal. Both borrower and portfolio limits must be approved before disbursement; attaching them does not approve them.                                                                                                                                                                    |
| `lending.round`                            | The target is the linked plan's principal. Closing requires commitments and held funds to equal that amount.                                                                                                                                                                                                                 |
| `lending.distribution`                     | Cash distribution needs an eligible recorded settlement, `prepare_cash`, one share record per funded commitment, then `distribute_cash`. Attaching it moves nothing.                                                                                                                                                         |
| `insurance.cover.slice`                    | `commission` is calculated, but `collect` sends the whole premium to `programOperator`; that action makes no broker commission transfer.                                                                                                                                                                                     |
| `travel.booking`                           | From `deposit_paid` or `paid`, early cancellation returns the full held balance, middle returns held balance minus deposit, and late has no buyer refund transfer. State, time and balance requirements still apply. A deposit-only early cancellation refunds the deposit; a deposit-only middle cancellation refunds zero. |
| `financing.installments`, `savings.circle` | Supply explicit date lists when creating agreements. A term count does not generate a monthly calendar. Savings supports at most 60 distinct member positions.                                                                                                                                                               |
| `escrow.hold`                              | `fund` takes the whole price. Financing into pending escrow collects the remaining down payment and adds capital principal at disbursement; `fund` is not a down-payment checkout.                                                                                                                                           |
| `escrow.hold`                              | Acceptance timeout enters `disputed` without paying the seller. Delivery and return verification belong to `payee`; rebinding it also changes who receives accepted funds.                                                                                                                                                   |
| `financing.late_charge`                    | `fine` is a fixed money amount, not a percentage of overdue principal.                                                                                                                                                                                                                                                       |
| `cards.card`                               | `spend_limit` is a per-authorization ceiling, not a monthly aggregate.                                                                                                                                                                                                                                                       |

The [lending sample](../examples/lending.hsx) exposes limit approvals, funding and
commitment creation, and cash prepare/distribute actions. Its repayment and share
child actions still lack a public execution path. It is a composition example,
not a complete public repayment flow. Callers still need dates, agreement inputs,
funded wallets, eligible settlements and the distribution's share records.
