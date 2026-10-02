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
  a record they do not own, through the object's `entryActions`.
- `economics` can name a party reached through a reference.

Changed:

- All 15 examples are Saudi businesses with SAR prices, explicit fees and VAT
  treatment, named business counterparties, list columns, and payment, refund,
  dispute and overdue paths.
- A required instrument value with no fixed value becomes create `input` on the
  agreement. Only an explicit `rename` shares it as record metadata.
- Record actions stay private until the program exposes them.
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
