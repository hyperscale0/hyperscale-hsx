# HSX

Read [how Hyperscale fits](https://hyperscale0.ai/docs/runtime.md#how-hyperscale-fits) for provider authority and the shared operation API.

HSX composes a company's objects, agreements and actions into a typed program.
A repair approval can change state without moving money. A rental can collect a
deposit and refund it under declared rules. Headers supply reusable instruments;
you can also write an instrument with its own fields, lifecycle and actions.
The compiler emits UDL, the Universal Domain Language contract an executor reads.
It does not run the business or move money. This release supports SAR only.

## First program

The package supplies the `hsx` executable. Save this as `lesson.hsx`:

```hsx
program tutoring "Tutoring studio"
use money
object lesson "Lesson" {
  fields { student: text }
  columns: [student]
  attach payment = money.transfer {
    payer: owner, payee: operator, amount: 150 SAR
    expose create as book_lesson
    expose pay as pay_for_lesson
    expose cancel as cancel_lesson
  }
}
```

An object is the business record. An instrument holds an agreement's state and
money rules. An attachment connects the instrument to an object kind. A tunable
is a header parameter, such as `amount`, fixed by this program. An exposed action
is a public name for an instrument action. Exposing it does not grant permission.

```sh
hsx check lesson.hsx
hsx build lesson.hsx --out lesson.udl.json
hsx cost lesson.hsx
```

`check` exits zero without output on success. `build` writes canonical UDL;
without `--out` it prints to stdout. `cost` prints instruction counts, described
below. `format` prints formatted source or writes it with `--out`. `headers --json`
prints the header manifest. Exit 1 means invalid source; exit 2 means a command
or file error. Diagnostics name the source, line, column, code, problem and
suggested fix. UDL validation keeps its UDL diagnostic codes; binding errors can
have names such as
`subject_party_unbound`. Read the message and fix, not just the code.

At runtime, create a lesson object first, then call `book_lesson` to create its
agreement. Call `pay_for_lesson` on that agreement to move 150 SAR from its bound
owner to the operator. Object creation alone creates no agreement. Object
metadata such as `student` is optional until an action requires it. Account IDs
and party IDs are not metadata supplied by the caller.

## A rental deposit in one hour

For a separate hire charge and refundable security, use
[rental-hire.hsx](../examples/rental-hire.hsx) and the `rental` header.
Its shared rules refund both paid parts on cancellation before pickup.
`complete_hire` requires recorded pickup, and an ended hire still counts toward
the one-hire limit. The operator records pickup, return and damage.

Open [rental-deposit.hsx](../examples/rental-deposit.hsx). It is a complete source
file for a customer renting equipment from the program operator. Copy it to
`rental.hsx` and run the same check, build and cost commands against that file.
No header import is needed because it declares its own instrument.

The terms are a 1,000 SAR deposit and one late charge of 50 SAR plus 15% VAT,
which is 7.50 SAR. The record's `startsAt` and `dueAt` timestamps reach the
agreement through `rename`, so `agree_rental` reads them from the object. A
return before `dueAt` gets the whole deposit back; a return at or after it gets
942.50 SAR back. The operator receives 50 SAR and `programTax` receives 7.50 SAR.
The late charge is not a daily charge and is not `financing.late_charge`, which
requires a financing plan and an overdue installment.

| Step                         | Public action           | Actor and required values                                                                                 | Money effect                                                           |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Create the object            | Host object creation    | Optional `equipment`, `serialNumber`, `renterName`, `startsAt` and `dueAt` metadata                       | None                                                                   |
| Agree terms                  | `agree_rental`          | Bound renter; `startsAt` and `dueAt`, for example `2027-01-10T12:00:00+03:00`, both future, `dueAt` later | Creates the agreement's held account                                   |
| Fund before pickup           | `pay_deposit`           | Bound renter with 1,000 SAR available, before `startsAt`                                                  | Renter pays 1,000 SAR into held                                        |
| Record an on-time return     | `return_equipment`      | Operator, before `dueAt`; `returnReference` metadata                                                      | Held pays 1,000 SAR to renter                                          |
| Or record a late return      | `return_equipment_late` | Operator, at or after `dueAt`; `returnReference` metadata                                                 | Held pays 50 SAR to operator, 7.50 SAR to tax and 942.50 SAR to renter |
| Cancel before pickup         | `cancel_before_pickup`  | Bound renter on a funded agreement, before `startsAt`                                                     | Held pays 1,000 SAR back to renter                                     |
| Cancel an unfunded agreement | `cancel_unpaid_rental`  | Bound renter, while pending                                                                               | None                                                                   |

Choose one return action. Both finish the agreement, so the fee and refund cannot
repeat. The late action calculates the refund from the held balance before any
move runs. Both paths empty the held account. `returnReference` records the
operator's return evidence; it does not verify the physical return. Time means
the executor's current time when the action runs, not a caller-supplied return date.
A late `due` permits the operator action; it does not schedule that action.

The renter is a party parameter bound to the rental object's `owner`. Each rental
can belong to a different customer without a fixed business binding. A
parameterized program instrument exists only through its attachments. A `fee` on
a move of an action input, such as `moves input.amount from holder to self.held
fee { seller: 1% }`, is calculated when that action runs. Reusable custom headers
require a host-supplied `StandardLibrary`; `use` cannot load a local file through
this CLI.

Inspect `objects` in the compiled UDL for the attachment and public names, then
its instrument for fields, transitions, actors, requirements and ordered moves.
`money.hold` and `escrow.hold` both refund
whole amounts, so neither implements this partial-refund policy by itself.

A local compile gives you a contract. Executing it needs a host with authenticated
parties, object actions, funded accounts and a saved Product Build. A Build is the
frozen contract and configuration used by its agreements. Existing agreements
keep that Build when the program changes. The package includes no local money
executor. Compilation cannot establish balances, permissions or provider readiness.

## Objects, metadata and parties

Every attached party parameter binds to `owner`, `actor`, `operator`, a declared
business, or a declared staff party with a supported role. Configure declared
business participants per Build. The host binds a declared business to an
organization customer of this company, and that business must be a customer with
an account before the Build that binds it is saved. It also needs an open balance
account in this Product before it takes part in a payment. Declared person
parties cannot bind attachments.
`owner` is the object's resolved customer or business, `actor` is the authenticated
caller, or the customer a Product key or member names in `onBehalfOf`, and
`operator` is the program operator. `programOperator`, the default
of many std party parameters, is the same company: it resolves to the Product's
own company, and a Build binding for it is ignored. A parameter with one of these
names binds by name. Other required party parameters use a same-named eligible
declaration, a header default, or an explicit binding. An optional party parameter
stays unset unless the attachment binds it. Explicit bindings take precedence.
Unbound parameters report `subject_party_unbound`. These bindings are frozen in
UDL `objects[].attachments[].parties`; no caller supplies party IDs at creation.

Object `fields` are authored metadata. `columns` names up to eight normalized
fields. An action's `subject { price: money }` declares its metadata requirement;
`subject { adapter: verification }` inherits a selected ADL declaration. The
compiler freezes the adapter identity, digest and requirements. An unavailable
declaration leaves a null snapshot in compiled output. Product creation and
recomposition reject unresolved or changed declarations during Build admission.
Execution checks the frozen declaration too; later adapter unavailability can
block actions on an already saved Build. A boundary adapter, such
as `conformance_boundary`, only binds its accounts and needs no evidence. Any
other adapter also needs a matching `requires evidence` rule on the action, or
preview and execution refuse with `subject_adapter_unbound`.

An attachment can use `rename { price: salePrice }` to separate requirements with
different meanings. Matching names must match types and constraints. The compiler
reports `subject_field_conflict` with both origins, or `subject_field_unknown` for
unknown rename sources, columns or subject expressions. Action admission reports
`subject_requirement_missing` or `subject_adapter_unbound` before dispatch.

Creation accepts `{}`. Every normalized field, including adapter requirements,
is optional at creation. Only a named action requires its subject metadata.
Use `attach` inside the object block to configure its financial instruments.

A required instrument field with no fixed value is a local creation value by
default. It becomes create `input` on that agreement and never an object field,
so two agreements on one object keep separate amounts and a wallet spend never
prefills a later fee. Only a rename such as `rename { dueAt: dueAt }` shares
it as record metadata: the value then comes from the object field as a create
subject requirement. An authored object field of the same name does not share
it; write `rename { price: price }` when the agreement should read that field.
Later actions still read `self.amount` from the agreement either way. An
attachment whose create needs input must expose `create`, or compilation fails,
because a public action on a fresh attachment creates it first with no input.
A rename binds only fields of the attached instrument itself; renaming a record
field such as `insurance.cover`'s slice `premium` reports `subject_field_unknown`.

## Headers and tunables

The header defines the available policies. The company chooses percentages, amounts, durations,
parties and typed references. `funds: sale` links the stored records through the
library's declared reference type. References can name a child, such as
`receipt: plan.settlement`. A header tunable declared `ref<T>[]` accepts one object or a list of up to 16
objects of type T. `on: [plan_3, plan_6]` creates one late-charge or collections
policy. Its references can point into either plan; selections can span both.
A plain `ref<T>` accepts one object only.
Tunable constructors are `enum(choices)` and `integer(minimum, maximum)`.
Other constructors, including `party(business)` and bounded `money(...)`, are
rejected as tunable types. A default selector such as `payer: party = party(person)`
is different: its type is plain `party`, and the call chooses a default binding.
Use explicit `payer: owner` or `payer: actor` bindings when the participant comes
from the object or session.
Imports are `use header`; there are no file imports, macros or executable strings.

## Values and money

Amounts use `750 SAR`; percentages use `2.5%`; durations use `48h`, `3d`, or `1w`.
Dates use `2026-11-28` or a timestamp with an explicit offset. Money has at most two
decimal places and percentages at most two. The compiler uses integer minor units
and basis points. Fee and tax calculations round down. Split percentages sum to
100%; the last declared recipient receives the rounding remainder. Finite
schedules use positions 1 through n and put the division remainder in position 1.
Amortizing financing is the exception: it rounds half up and puts the remainder in
the last instalment, as a standard amortization table does.
Tax binds `programTax`. Fees go to `programOperator`. Fine, recovery and
residual destinations are party tunables.

Attached actions are private unless the attachment exposes them with
`expose fund as sell`. Exposure grants no authority. Clock and parent actions
remain executor-owned. Instruments have no standalone create route: an
attachment exposes its create action by name (`expose create as finance`) or
keeps it internal. Callers create objects and run their attached actions.

Accounts use cash or claim books. A move stays in one book. `account of buyer`
aliases the default cash account; `account of self` provisions an owned account.
`account(lender, cash, "capital")` binds a named account.
`account(adapter(insurer), cash, "premium")` binds the account of the provider
selected by `insurer`. Declare that binding with `subject { adapter: insurer }`
in an action of the same instrument. A text tunable may supply its binding name.
The agreement retains the provider identity; aliases for that provider share the
same book and key within the Product. Providers remain outside parties.
A missing binding refuses before money moves. Reference paths such as
`self.cover.insurer` use the referenced agreement's account.

`account(buyer, claim, contra, "debt")` declares the borrower's claim contra account.
Provider confirmation belongs on a reserved move with `boundary adapter`,
followed by instruction-bound evidence and a post or void.
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

## Authored instruments and actions

An action is the business instruction: its actor, state, requirements and effects
define when it is valid. The executor still checks those conditions on each call.
The four transfer instructions below that action are its money effects. There is
no general-purpose `instruction` declaration; `instruction` in an evidence clause
binds external evidence to a captured boundary instruction.

For a new record type, declare `instrument name { fields { ... } lifecycle { ... }
action create { ... } }`. Fields are `money`, `account of buyer`, `ref<order>`,
`date`, `duration`, `text`, `integer`, `percent`, `boolean`, `enum(a, b)` or
`list(date, 12)`. `?` makes a plain type or `ref<T>` optional. Call types such as
`list(date, 12)` do not accept `?`. `= value` fixes a constant or a typed
calculation. Actions declare `input { reason: text }`. Headers and expert records
write ordered requirements and moves as expressions:

```hsx
requires self.payer == self.order.buyer
requires self.order in [placed]
moves self.price from payer to self.held
moves self.price from self.held to payee fee fee
```

Comparisons accept `==`, `!=`, `<`, `<=`, `>` and `>=`. A path beginning with
`self`, `input`, `party` or `subject` is a field operand; a quoted string, amount or number is
a literal. `requires unique "order" on [self.order]` fixes an identity namespace.
`requires count of { instrument: child, reference: "parent", anchor: self.id,
states: [pending], limit: 12 } == 12` checks a typed selection; `sum "amount" of`
uses the same selection syntax. `invariants` accepts these requirement expressions.
The reference is a `ref` field or a party account; `reference: "traveller",
anchor: self.traveller` selects every record of the same traveller. `overlaps:
{ start: departure, end: returning, from: { field: self.departure }, until: {
field: self.returning } }` keeps rows whose own `[departure, returning)` period
meets the range, so a stay ending on the 8th and one starting on the 8th do not
overlap. `count of { instrument: current(), ..., overlaps: ... } <= 1` stops one
traveller holding two trips on the same dates.
`requires hours self.now between 8 and 20 timezone "Asia/Riyadh"` checks local hours.
`requires evidence self.payer family registry check ownership result verified
maxAge 1d` requires a recent completed provider check.

`moves reserve amount from payer to payee capture receipt` reserves a transfer;
`moves post self.receipt` posts it and `moves void self.receipt` releases it.
`moves amount from payer shares shares` expands a declared split. Optional `fee`,
`capture`, `key` and `boundary` modifiers describe a move. `boundary` applies
only to reservations. Fees settle with create moves, never reservations. A fee move
also derives `<action>_<move>_debit`, the payer's whole debit: amount plus fee and
tax when the buyer pays, the amount alone when the seller pays. Repeated clauses keep
their declaration order. A clause list after a colon, such as `calculate: [{ ... }]`
or `invoke: [{ ... }]`, writes [UDL clauses](https://github.com/hyperscale0/hyperscale-udl/blob/main/spec/README.md)
directly; the std headers use it for calculations, `set` and invocations.
Use `economics { purpose: earning, sourceParty: merchant }` on a move to
classify posted money. Other purposes are `principal`, `participant_payout`,
`internal`, `prepaid_credit`, and `pass_through`. `reversalOf: self.originalTransfer` links a
reversal. The source party must own the source account, except when an earning
releases the retained payer’s money from an agreement-bound instrument account
to a company account outside the agreement. A reservation passes its economics
to its post. Fee shorthand accepts separate economics for each expanded leg.
They cannot add kernel instructions. `at(list, position)` reads a dated list;
`aggregate(selection, "amount")` sums selected money; `ratio(amount, weight, total)`
floors a weighted share. `records` declares child types. `invoke` can create a child
with typed input in the same transaction.

The compiler removes branches excluded by fixed enum tunables. An invalid program reports its source line
and a correction. No artifact is returned with diagnostics.

## Header branches and bounds

A header may select action clauses at compile time:

```hsx
when disburse_to is borrower {
  moves self.principal from self.capital to self.borrower
}
```

`when <reference tunable> has <field>` includes its clauses only when the bound
object declares that field. The compiler checks the object's declared shape,
regardless of declaration order, and emits no runtime branch.

`when <enum tunable> is <value>` accepts requirements, calculations, moves and
invocations, including nested branches. The compiler emits only the selected
clauses and preserves their order within each UDL phase. Lifecycle and actor
clauses stay outside branches. Calculations and requirements run before moves;
invocations run after moves. A collections fee therefore uses an internal action
invoked after payment. Clock and parent actions have no public API name.

`integer(1, 366)` declares an inclusive tunable bound, and `integer(1, 366)?`
keeps the bound on a tunable the author may leave unset. The compiler-owned manifest
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

Each dependency names a declared tunable, an enum selector and one of its choices,
or an optional selector and `set` or `unset`: `money.schedule` needs `count` when
`every` is unset.
The compiler checks selected dependencies before lowering and the manifest retains
them. `{attachment}` in the message expands to the authored attachment name.
Parameter diagnostics name a declared tunable and explain its accepted value,
unsupported percentage semantics and repair. They do not change the tunable type.
UDL refusals retain their UDL codes. A terminal-money refusal includes the owned
account and the prover's action path in related diagnostic information.

## Instruction cost

`hsx cost company.hsx` reports `transfers`, `accounts` and `invocations` per
instrument action after lowering. Transfers count declared move instructions,
including reserve, post and void. Accounts count self-owned accounts created by
`create`, not every party account. Bounded invocations include child costs up to
the selection limit, so a count is an upper bound rather than observed usage.
Zero-valued moves can cost fewer actual transfers than their static count.

The rental attachment's create declares one owned account, fund declares one
transfer, on-time return one, and late return three: the charge, its VAT and
the refund. These are counts, not SAR
prices. The executor's tariff supplies commercial prices and actual usage.

The compiler API is `compile(source)`. On success, `result.verdict` is `valid`
and `result.artifacts` contains `document`, `costManifest` and `originMap`.
On refusal, inspect `result.diagnostics`; no artifact is returned.

`hsx headers --json` prints the instrument inventory from the declarations. The
[object example](../examples/library.hsx) shows authenticated role bindings.
The [playground](https://hyperscale0.ai/playground/) compiles locally in the browser.

A seller-owned marketplace object can declare `entryActions: [create_order]`
when `create_order` exposes an attachment's create action with its buyer bound
to `actor`. This admits active enrolled customers to that action. The default
is closed. A retained buyer can read the record and run its buyer actions;
the seller remains owner. Entry never grants access to an existing escrow.
Without entry actions, the company runs a two-customer sale from its Product
key: create the record with `onBehalfOf` naming the seller, then run the buyer's
steps with `onBehalfOf` naming the buyer.

The same rule admits the other std creates whose starting party can be a
customer: `financing.limits` and `financing.installments` (borrower),
`insurance.cover` (holder), `wallet.balance` (holder) and `savings.membership`
(member). Several customers can each start one on the same record. A plan,
commitment or other reference resolves the sibling that binds the same
accounts to the parties both share, so each customer's plan finds its own
checkout and each investor's commitment finds their own wallet.

A financed purchase connects `financing.installments` to `escrow.hold` through
`purchase.checkout`. Bind the plan's `funds` to checkout, checkout's `funds` to
the hold, and checkout's `plans` to the plan. Give the hold the funding policy
`{ controllers: [checkout], reference: "funds", blocking_states: [active] }`.
If a marketplace reservation contributes a deposit, its `converters` also names
checkout. Create the hold, then checkout, then the plan. The coordinator collects
the missing down payment and returns outstanding lender capital before a buyer
refund. See [library.hsx](../examples/library.hsx) for the complete wiring.

`financing.limits` and `financing.portfolio_limit` declare `scope: product`.
Create and approve the portfolio limit once per Product and the borrower limit
once per borrower. Plans on later records resolve those shared references.
Ordinary references remain on the current record; shared references must match
the bound party accounts. The aggregate caps still apply across all plans.

`programTax` transfers use an operator-owned cash account keyed `programTax`.
The account primitive creates it automatically and shares it across the Product.
Zero-tax escrow releases need no additional party setup.

A child action uses the object's existing operation routes. A caller sees it
only after the program exposes it; admission still checks authority, state and
provider evidence. A child alias names the full attachment path, for example:

```hsx
expose enrolment.tuition.payment.create as create_payment
expose enrolment.tuition.payment.pay as pay_instalment
expose enrolment.tuition.payoff_quote.create as request_payoff_quote
```

Read the parent object's actions and follow pagination to discover child actions.
Use the returned target, Build, digest and object revision when executing. Creation
targets the child attachment; later actions target the child's instance ID on the
same object. The caller must satisfy the header's actor rule. Parties bind from
the session and object ownership. Retry the same request with the same
Idempotency-Key to retrieve its result without moving money again.

Every agreement reference is an optional creation input on an exposed create.
With one matching agreement on the object the engine picks it; with several,
such as a plan's slices or a lending round's settlements, the caller passes the
chosen instance ID under the reference's name.
Read each header's creation and lifecycle requirements. Financial decisions
come from a provider or the tenant's people; a header records their result.

## Posted economics in the money flows

An attachment can declare the purpose of an imported action's money:

```hsx
attach visit = wallet.spend {
  wallet: balance, payee: operator, holder: owner
  economics pay { purpose: earning, sourceParty: owner }
  expose pay as charge_visit
}
```

Name the original action, before its public alias. If it has several moves,
select a move key, for example `economics pay.move1 { ... }`. A record's
action takes the record name first: a schedule's payments are
`economics occurrence.pay { ... }`. The compiler
refuses an unknown action or move, a repeated selection, a void, or economics
that conflict with the instrument or its reservation. Cash purposes require
cash accounts. `sourceParty` resolves a party parameter, a subject role or a
declared business. The attachment retains this binding even when only economics
uses it. The credited account supplies the destination participant.

Stock transfers, splits and schedules declare no purpose, because the purpose
depends on how the attach binds its parties. When an attached move that
creates or reserves money has none, `hsx check` and `composer.check` return an
`economic_purpose_missing` warning on the attach line. Its fix is the line to
add, with `earning` when the payee binds `operator`, `participant_payout` when
the payer does, and `pass_through` otherwise. A warning does not block a
freeze, but the books leave an unclassified payment out of revenue.

The compiler writes the declaration into that attachment's UDL move. Imported
instruments stay generic. New Builds carry the purpose; existing agreements
and postings keep their retained Build and classification.

Held customer funding and its unspent return are `principal`. A release for the
company's sale is `earning`; its release to another participant is
`pass_through`, because the company never owned it. A payment from company cash
to another participant is `participant_payout`. Claims, waivers, write-offs and own-account allocations
are `internal`; prepaid balance topups and returns are `prepaid_credit`. Tax is
`pass_through`, excluded from earnings and costs. Unpaid claims count as neither.
Refunds of paid profit, company charges and commission capture the original
transfer and use `reversalOf`, so refunds reduce the original purpose.

Fee shorthand accepts separate move economics: `economics { payee: { purpose:
earning, sourceParty: payer }, fee: { purpose: earning, sourceParty: payer },
tax: { purpose: pass_through, sourceParty: payer } }`. These describe authored
product fees. Automatic platform fees keep their commercial classification.

A move's economics block can select by a resolved party: `economics { recipient:
recipient, company: { purpose: earning, sourceParty: payer }, participant:
{ purpose: pass_through, sourceParty: programOperator } }`. The compiler
chooses `company` for `operator`, `programOperator`, or a declared party with the
`program_operator` role; it chooses `participant` for other bound parties.
Both branches must be supplied. A branch may be `unclassified` when no purpose
is established. Outside financing-profit and recovery recipients refund directly
to the customer; those refund branches remain unclassified. Customer cash paid to
outside recipients is pass-through, whether paid direct or released from a hold
the customer funded as principal. Only company-owned cash paid out is a cost.

Generic transfers and mixed principal/profit distributions remain unclassified
when their structure does not establish a purpose. Adapter-owned premium and
claim accounts and credit-line advances also lack an authored source party.
Their reports remain incomplete rather than guessing a company earning or cost.
