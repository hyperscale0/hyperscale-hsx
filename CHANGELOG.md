# Changelog

## Since 1.0.123

Releases after 1.0.123 shipped without per-release entries. This entry
summarises what changed in the language, the compiler and the bundled programs
since then.

Added:

- Eleven neutral archetype programs in `bases/` and the browser export
  `@hyperscale0/hsx/bases`. Generation and preparation bundle their source and
  metadata. Package checks enforce compilation, coverage and neutral content.
- The `booking` std header, with deposit, balance and cancellation windows.
- `financing.installments` prices a plan as `amortizing` or `flat_total`, and
  `refund_within` (default 30d) bounds refunds after a plan is paid.
- `wallet.balance` takes a `topup_fee`; `escrow.hold` takes `deliver_within`.
- Selections accept `overlaps: { start, end, from, until }` to match rows whose
  date period meets a range.
- Program instruments take party parameters, and a `fee` on a move of an action
  input is calculated when that action runs.
- Every agreement reference is an optional creation input on an exposed create.
- Customers can start the std agreements whose first party can be a customer on
  a record they do not own, through the object's `entryActions`. The compiler
  adds to `entryActions` every exposed create whose starter the binding rule
  placed from `customer` on `actor`, whether or not the author listed it. A
  starter written `actor` by hand adds nothing. A program instrument's create
  names no actor, so the rule reads its starter from the actor rule: the one
  party its money leaves, else whoever binds `actor`. A two-customer program
  instrument whose buyer pays in opens the buyer's create, and listing that
  create in `entryActions` no longer places both customers on `owner`.
- `economics` can name a party reached through a reference.
- The `once_per_record: { applies, reopen_on }` instrument clause lowers to
  UDL `oncePerRecord: { reopenOn }`. While one of its agreements on a record
  sits outside `reopen_on`, no other customer lists, reads or starts one there.
- The `customer` binding. The compiler places each customer on `owner` or
  `actor` by a fixed rule (`src/bindings.ts`): an entry action's starter is
  `actor`, two customers split by who creates or pays in, and any other
  customer is `owner`, or `actor` on an object marked `belongs_to: company`.
- `belongs_to: company` marks an object that records the company's own thing,
  such as a fleet car or shop stock.
- `customer_binding_rule` refuses a hand-written `owner` or `actor` that
  disagrees with the rule in an entry or two-customer attachment, and
  `fee_on_company_sale` refuses a seller fee on money paid to the company
  itself. `customer_binding_rule` also refuses two customers that only the
  whose-object rule places when some std template takes both names as two of
  its parties, such as a seller on a listing and a buyer on an order, since
  both would bind `owner`.

Changed:

- `escrow.hold` runs once per record and takes `one_buyer: boolean = true`.
  A cancelled or refunded hold reopens the record. Programs that sell one
  record to many buyers bind `one_buyer: false`.
- A program instrument with party parameters that leaves `actor` out gets it
  from the actor rule (`src/actors.ts`): follow actions stay `caller`, an
  unexposed `due` action with no input runs on the clock, the party whose money
  leaves pays, `create` goes to the `actor` or `owner` binding, and the company
  runs the rest. Headers name every actor, so std UDL is unchanged.
- All 15 examples are Saudi businesses with SAR prices, explicit fees and VAT
  treatment, named business counterparties, list columns, and payment, refund,
  dispute and overdue paths.
- A required instrument value with no fixed value becomes create `input` on the
  agreement. Only an explicit `rename` shares it as record metadata.
- Record actions stay private until the program exposes them.
- Examples and template guide examples bind customers with `customer`. Their
  compiled UDL is unchanged, except that `lending.hsx` lists its investor
  creates in `entryActions`. Their economics name the paying parameter, such as
  `sourceParty: payer`. The `marketplace.reservation` guide lists the buyer's
  creates in `entryActions` instead of binding `actor` by hand, and the purpose
  hint for company-held money with no party parameter names `programOperator`.
  `customer` is a reserved party name. An unbound
  person parameter that shares a declared party's name keeps binding that party.
- Compiled `entryActions` now include placed starters' creates. In the
  examples, the `belongs_to: company` vans of `serviced.hsx` and `library.hsx`
  gain `agree_van_purchase`, `request_borrower_limit`,
  `prepare_financed_purchase` and `finance`, and the savings circle of
  `savings.hsx` gains `join_circle`. Before, no customer could start those
  agreements, since each runs on a record its customer does not own.
- Std actions name an accountable actor, and std money pulled from a customer
  needs that customer's authority.
- A split binds declared business and subject-role recipients itself, and a
  share the payer keeps stays in the source account with no self-transfer.
- Late charges and recovery costs are bounded across the whole plan, and an
  insurance cover's claim limit is shared across every claim attachment.
- Financing and escrow plans have exits for returned, undelivered and paid-off
  goods, and a paid-off plan closes once its refund window passes.

## 1.0.123

First unified release. Every public Hyperscale package now ships under one
version that follows the platform release number, so release 123 is 1.0.123.
The compiled contract format is UDL 1 and the HSX header-manifest edition is
HSX 1.
