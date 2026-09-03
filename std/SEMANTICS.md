# Settlement semantics frozen before legacy teardown

This note records the behavior that the former archetype branches emitted on
2026-09-01. The 48 canonical documents under
`test/fixtures/general-path-oracle/` are the byte-level authority. This note is
the human porting index.

## Direct and held payments

- `instant_transfer` stores the amount, currency, payer, and payee. Create pays
  through one or more ordered pieces and ends in `paid`. A payer fee is an
  `on_top` move. A payee fee is carved from the base amount. Exact, basis-point,
  and tiered rules produce fee fields and `feeRules`. The finest common
  refinement of all fee cuts produces piece fields and one partition. Floor
  rounding sends the remainder to the named non-fee recipient. A derived
  amount adds a floor percentage field, `derivedAmounts`, a platform party, and
  its own transfer piece.
- `held_payment` reserves every refined piece before release. It posts release
  pieces, voids cancellation pieces, and keeps payer service fees outside the
  held principal. Release and cancellation fee sides share the finest common
  partition, so each stored piece has one release recipient and one cancel
  recipient. States track each funding, release, cancellation, and abandonment
  step. Abandonment refunds every still-held piece. A deadline release and a
  caller decision release carry the named date or port clause. Retention is the
  same form with one held piece, a release deadline, and cancellation back to
  the contractor. Whole-amount mode funds the principal and on-top fee in one
  action, then releases or cancels the principal whole. A condition and date
  can coexist, with separate early and scheduled release actions.
- `captured_payment` stores authorization total, reserve and reversal dates,
  and both party accounts. It moves through `created`, `authorized`, optional
  `partially_captured`, `settled`, `voided`, `expired`, `corrected`, or
  `reversed`. Authorize reserves custody. Capture and capture-more consume the
  authorized balance according to the declared mode. Settle posts the captured
  amount. Void and expiry release the reserve. Correction and external reversal
  use their declared ports and windows. Derived fees use the same floor,
  partition, bearer, and position rules as direct payment.
- `premium_forward` holds premium pieces, then forwards the net pieces after a
  bind decision. It can abandon unbound custody. Policy reference, renewal due,
  endorsement evidence, and lapse actions appear only when declared. Its fee
  partition and floor remainder rules match `held_payment`.

## Decisions and credit

- `conditional_disbursement` emits a submitted parent with cap, currency,
  source, destination, and the decision port. Denial terminates the parent. An
  approved-amount child stores a runtime-bounded amount and a parent reference.
  The child captures the port input, moves through `created`, `approved`, and
  `paid`, and refuses reopening. Recovery is a separate transfer.
- `advance` has two forms. A carved advance references a held settlement and
  its recourse settlement, disburses once, and settles from the referenced
  release without minting new value. A scheduled advance stores advance,
  fee, repayable total, first due date, and one repayment field per fixed
  installment. It partitions repayments to the repayable total and advances
  before collecting each due installment.
- `credit_facility` stores lender, borrower, draw destination, limit, currency,
  and expiry. The facility can freeze and close. Each draw is a generated child
  with amount, facility reference, and obligation reference. Draw admission
  checks the facility state and aggregate limit. Resolution waits for the
  referenced obligation state.

## Schedules and usage

- A finite `scheduled` transfer stores total, first due date, and one money
  field per installment. Floor division creates equal pieces and gives the
  final field the remainder. States and actions unroll in order. Each action
  carries its due rule and cumulative duration offset.
- Scheduled obligation mode emits a parent plus one generated payment child per
  installment. The parent stores principal, delinquency dates, party accounts,
  partitions, and aggregate invariants. It supports draft approval, optional
  advance, fixed collection and delinquency actions, write-off, and completion.
  Each child binds parent fields, repays once, and can refund once.
- `recurring_collection` with a finite count uses the scheduled construction.
  Open recurrence stores one amount and anchor, opens one period at a time,
  collects that period, and permits cancellation. It never unrolls an unbounded
  runtime loop.
- `metered` stores one money field for each declared meter and a period end.
  Every charge moves directly from payer to payee. The instrument never accrues
  custody. Closing the period only changes state.

## Collections and distributions

- `pooled_split` stores the pool total, due date, and one share amount and
  account per recipient. Positive shares total exactly 10,000 basis points.
  Floor division assigns each share, and the named remainder recipient absorbs
  minor-unit residue. Funding and distribution actions unroll in roster order.
- `weighted_distribution` emits an open parent and an entitlement child. The
  parent stores source, total, record date, and maximum recipient count. A port
  freezes the entitlement snapshot. Child rows store recipient, weight, source,
  currency, and parent reference. Largest-remainder distribution pays children
  once. Aggregate clauses cap and total the child set. Withholding is refused
  and correction creates a new distribution. Its `flat` form emits a single
  claim instead. The caller supplies typed pool, weight, and group references,
  their state gates, copy and match maps, and the pool amount path.
- `threshold_pool` emits a pool parent and commitment child. The parent stores
  target, close date, maximum contributors, beneficiary, and currency. It moves
  through open, active, failed, or settled based on aggregate commitment gates.
  Each commitment can cancel before collection, collect into the round, or
  refund after failure. Its referenced-contribution form accepts a published
  contribution instrument, beneficiary account, and memo and emits no child.
- `security_deposit` reserves the full amount. A claim port posts either the
  whole hold or a decided amount bounded by the hold. The explicit remainder
  returns to the payer. A return port voids the whole hold. The deadline form
  adds machine expiry and unfunded cancellation. Claim and return targets can
  name either party.

## Composition and unwind

- `swap` stores both side amounts, accounts, fees, currency, and optional
  clawback date. Funding is atomic across both sides. Release, settlement,
  cancellation, dispute, abandonment, and clawback preserve the two-sided
  conservation group. Side fees keep their declared bearer and position.
  `distinctParties` prevents self-dealing. Unwind refunds each side and applies
  the declared penalty tiers without changing the principal partition. Fixed
  side names, state order, action bindings, parked-state reasons, and ID prefix
  are general compile-time parameters.
- `settlement_batch` emits a batch plus capture, credit-adjustment, and
  debit-adjustment children. The batch stores close time, settlement and payout
  accounts, beneficiary reference, and currency. Close freezes intake.
  Calculate signs capture, fee, and reversal entries. Approve rejects a negative
  position when configured. Instruct, acknowledge, and reconcile use the
  declared payout port. Child references and statuses define every aggregate
  and signed-sum input.
- `rotating_pool` emits one parent plus one contribution child per fixed member.
  The parent unrolls active and ready states for every cycle and checks that each
  member row exists exactly once. Every child unrolls due, funded, defaulted,
  guaranteed, paid, and completed states for every cycle. Due offsets scale the
  fixed recurrence. A funded or guaranteed contribution pays the roster's fixed
  beneficiary for that cycle. The final close requires the escrow account to be
  drained. Its referenced-membership form delegates those member cycles to a
  published membership instrument and emits only the parent.
