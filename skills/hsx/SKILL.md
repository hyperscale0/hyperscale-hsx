---
name: hsx
description: Write, review, and repair HSX programs that compile financial-product rules to canonical UDL.
---

# Write HSX

Use this skill when a task creates or changes an `.hsx` program, chooses a standard-library settlement form, explains an HSX diagnostic, or reviews authored money rules. Do not use it to hand-edit canonical UDL or runtime state.

## Program shape

One file declares one `program`. Declare parties and assets before using them. Import standard-library instruments from `std/settlements`. Apply each selected instrument as a `settlement`, and declare every decision port it names. A program may also declare general instruments and subjects.

Start with [the first-program guide](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/guide/01-first-program.md). Read the generated [grammar](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/reference/grammar.md), [types](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/reference/types.md), and [standard-library pages](https://github.com/hyperscale0/hyperscale-hsx/tree/main/docs/reference/std) for the exact surface.

## Choose a standard instrument

Choose the module whose lifecycle and money path already match the product. Do not copy its emitted mechanics into a custom instrument.

- `instant_transfer` sends money without custody.
- `held_payment` holds money until a decision or deadline.
- `security_deposit` reserves value for a bounded claim or return.
- `cancellable_booking` quotes a cancellation penalty before commitment.
- `captured_payment` reserves, captures, settles, voids, or corrects a payment.
- `scheduled` expands finite installments or a bounded obligation.
- `recurring_collection` records collection periods.
- `advance` disburses now against finite repayment or a referenced release.
- `credit_facility` controls draws against a referenced obligation.
- `conditional_disbursement` releases a capped amount on stored evidence.
- `pooled_split`, `weighted_distribution`, and `rotating_pool` divide bounded pools.
- `threshold_pool` closes a bounded contribution campaign.
- `premium_forward` holds and forwards an insurance premium.
- `reconciled_payout` matches an instructed payout against bank evidence.
- `metered` commits a finite usage rate card for a period.
- `settlement_batch` closes, calculates, approves, instructs, acknowledges, and reconciles a batch.
- `swap` exchanges two independently typed sides.

The standard library forms are demonstrated below. The marker before each program lets the repository test read the module list from disk and compile one matching example per module.

## Diagnostic loop

Run `hsx check` after each coherent edit. Read the first error code, open the [diagnostics reference](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/reference/diagnostics.md), apply the catalog fix, and compile again. Match tools on the stable `HSX####` code, not the message. Never patch emitted UDL to bypass a refusal.

## Money rules

- Money uses integer minor units and carries a currency type.
- Money in different currencies never unifies.
- Percent literals have basis-point precision.
- Every percentage partition totals 100 percent.
- Every computed amount is consumed exactly once.
- Every held balance drains on each reachable exit.
- Schedules and comprehensions have compile-time finite bounds.
- A port supplies typed evidence or a bounded decision. It cannot invent money or a new route.

The [money](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/guide/02-money.md), [fees and splits](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/guide/05-fees-and-splits.md), [schedules](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/guide/06-schedules.md), and [cost](https://github.com/hyperscale0/hyperscale-hsx/blob/main/docs/guide/09-cost.md) chapters explain these rules.

## Standard-library witnesses

<!-- hsx-brick: advance -->

```hsx
program advance_example "Advance example"
import { advance } from "std/settlements"
party funder: business
party recipient: business
settlement advance_payment = advance {
  funder: funder
  to: recipient
  amount: principal: money(SAR)
  fee: 2.5%
  count: 2
  every: P30D
  first_due: firstDueAt
}
```

<!-- hsx-brick: cancellable_booking -->

```hsx
program cancellable_booking_example "Cancellable booking example"
import { cancellable_booking } from "std/settlements"
party guest: person
party studio: business
settlement studio_session = cancellable_booking {
  guest: guest
  host: studio
  amount: sessionPrice: money(SAR)
  starts_at: startsAt
  late_penalty_bps: 5000
  late_within: P2D
  early_penalty_bps: 1000
  offer_life: PT30M
}
```

<!-- hsx-brick: captured_payment -->

```hsx
program captured_payment_example "Captured payment example"
import { captured_payment } from "std/settlements"
party payer: person
party payee: business
settlement card_payment = captured_payment {
  payer: payer
  payee: payee
  amount: authorizedAmount: money(SAR)
  reserve_until: reserveUntil
  correction: port correct_capture
  external_reversal: port reverse_capture within P14D
  capture_mode: partial_then_full
  correction_mode: full_only
  negative_position: reject
  timeout: reject
}
port correct_capture { allowed: [payee] }
port reverse_capture {
  allowed: [payee]
  shape: { externalReference: text }
}
```

<!-- hsx-brick: conditional_disbursement -->

```hsx
program conditional_disbursement_example "Conditional disbursement example"
import { conditional_disbursement } from "std/settlements"
party source: business
party claimant: person
settlement claim_payment = conditional_disbursement {
  source: source
  destination: claimant
  cap: policyLimit: money(SAR)
  amount: approvedAmount: money(SAR)
  decision: port approve_claim
  reopen_policy: refuse
  recovery_policy: separate_transfer
}
port approve_claim {
  allowed: [source]
  shape: { evidenceReference: text }
}
```

<!-- hsx-brick: credit_facility -->

```hsx
program credit_facility_example "Credit facility example"
import { credit_facility, scheduled } from "std/settlements"
party lender: business
party borrower: business
party draw_destination: business
party repayment_source: business
settlement repayment = scheduled {
  mode: obligation
  payer: repayment_source
  payee: lender
  debtor: borrower
  amount: principal: money(SAR)
  count: 2
  every: P30D
  first_due: firstDueAt
}
settlement facility = credit_facility {
  lender: lender
  borrower: borrower
  draw_destination: draw_destination
  limit: facilityLimit: money(SAR)
  expires_at: expiresAt
  obligation: repayment.obligation
  availability_policy: revolving
  expiry_policy: freeze_draws
  close_policy: no_open_draws
}
```

<!-- hsx-brick: security_deposit -->

```hsx
program deposit_example "Deposit example"
import { security_deposit } from "std/settlements"
party renter: person
party owner: business
settlement security_deposit = security_deposit {
  payer: renter
  holder: owner
  amount: depositAmount: money(SAR)
  claim: port assess_damage
  claim_amount: decided {
    field: damageAmount
    bound: depositAmount
    remainder: return
  }
  return: port return_deposit
}
port assess_damage {
  allowed: [owner]
  shape: { damageAmount: money(SAR), evidence: text }
}
port return_deposit { allowed: [owner] }
```

<!-- hsx-brick: threshold_pool -->

```hsx
program capital_pool_example "Capital pool example"
import { threshold_pool } from "std/settlements"
party contributor: person
party company: business
settlement round = threshold_pool {
  contributor: contributor
  beneficiary: company
  target: targetAmount: money(SAR)
  commitment: commitmentAmount: money(SAR)
  max_contributors: 100
  close_by: closeBy
  close_policy: threshold
  overfund_policy: reject
  cancel_policy: before_close
  fail_policy: whole_commitment_refund
}
```

<!-- hsx-brick: held_payment -->

```hsx
program held_payment_example "Held payment example"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  fees { buyer: 1% }
  on_cancel(funded) { buyer: 100% }
  release: port confirm_delivery | at(releaseDueAt)
}
port confirm_delivery { allowed: [buyer] }
```

<!-- hsx-brick: instant_transfer -->

```hsx
program instant_transfer_example "Instant transfer example"
import { instant_transfer } from "std/settlements"
party customer: person
party merchant: business
settlement transfer = instant_transfer {
  payer: customer
  payee: merchant
  amount: transferAmount: money(SAR)
  fees {
    customer: checkoutFee: money(SAR)
    merchant {
      tier { from: 0, to: 10000, fee: 1% }
      tier { from: 10000, fee: highValueFee: money(SAR) }
    }
  }
}
```

<!-- hsx-brick: metered -->

```hsx
program metered_example "Metered example"
import { metered } from "std/settlements"
party customer: business
party provider: business
settlement usage = metered {
  payer: customer
  payee: provider
  close_by: periodEnd
  rates {
    api_call: callRate: money(SAR)
    storage_gib: storageRate: money(SAR)
  }
}
```

<!-- hsx-brick: pooled_split -->

```hsx
program pooled_split_example "Pooled split example"
import { pooled_split } from "std/settlements"
party payer: business
party first_recipient: business
party second_recipient: business
settlement pool = pooled_split {
  payer: payer
  amount: poolAmount: money(SAR)
  payout_due: payoutDueAt
  split {
    first_recipient: 60%
    second_recipient: 40%
    remainder_to: first_recipient
  }
}
```

<!-- hsx-brick: premium_forward -->

```hsx
program premium_forward_example "Premium forward example"
import { premium_forward } from "std/settlements"
party policyholder: person
party carrier: business
settlement premium = premium_forward {
  payer: policyholder
  carrier: carrier
  amount: premiumAmount: money(SAR)
  commission: 2%
  bind: port bind_policy
  policy_ref: policyReference
  renewal_due: renewalDueAt
  endorsement: port record_endorsement
}
port bind_policy { allowed: [policyholder, carrier] }
port record_endorsement {
  allowed: [carrier]
  shape: { evidenceReference: text }
}
```

<!-- hsx-brick: reconciled_payout -->

```hsx
program reconciled_payout_example "Reconciled payout example"
import { reconciled_payout } from "std/settlements"
party treasury: business
party supplier: business
settlement supplier_payout = reconciled_payout {
  payer: treasury
  beneficiary: supplier
  amount: netPayable: money(SAR)
  beneficiary_ref: supplierBeneficiaryId
  settle_by: settleBy
  matched_within: 100
  matched_ceiling: 500
}
```

<!-- hsx-brick: recurring_collection -->

```hsx
program recurring_collection_example "Recurring collection example"
import { recurring_collection, scheduled } from "std/settlements"
party debtor: person
party repayment_source: business
party recipient: business
settlement obligation = scheduled {
  mode: obligation
  payer: repayment_source
  payee: recipient
  debtor: debtor
  amount: principal: money(SAR)
  count: 2
  every: P30D
  first_due: firstDueAt
  mandate: port mandate_evidence
}
settlement collection = recurring_collection {}
port mandate_evidence {
  allowed: [repayment_source]
  shape: { evidenceReference: text }
}
```

<!-- hsx-brick: rotating_pool -->

```hsx
program rotating_pool_example "Rotating pool example"
import { rotating_pool } from "std/settlements"
party member_a: person
party member_b: person
party member_c: person
party guarantor: business
settlement pool = rotating_pool {
  members: [member_a, member_b, member_c]
  contribution: contributionAmount: money(SAR)
  count: 3
  every: P30D
  first_due: firstContributionAt
  payout_order: [member_b, member_c, member_a]
  default_policy: due_condition
  guarantee_policy: funded_only
  guarantor: guarantor
  exit_policy: before_activation_only
}
```

<!-- hsx-brick: scheduled -->

```hsx
program scheduled_example "Scheduled example"
import { scheduled } from "std/settlements"
party payer: business
party payee: business
settlement installments = scheduled {
  payer: payer
  payee: payee
  amount: totalAmount: money(SAR)
  count: 3
  every: P30D
  first_due: firstDueAt
}
```

<!-- hsx-brick: settlement_batch -->

```hsx
program settlement_batch_example "Settlement batch example"
import { settlement_batch } from "std/settlements"
party settlement_account: business
party payout_destination: business
settlement batch = settlement_batch {
  settlement_account: settlement_account
  source_capture_refs: captureReference
  fee_entries: feeReference
  external_reversal_offsets: reversalReference
  close_trigger: closeAt
  payout_destination: payout_destination
  negative_position: reject
  payout_acknowledgement: port acknowledge_payout
  payout_beneficiary_ref: payoutBeneficiaryId
}
port acknowledge_payout {
  allowed: [payout_destination]
  shape: { acknowledgementReference: text }
}
```

<!-- hsx-brick: swap -->

```hsx
program swap_example "Swap example"
import { swap } from "std/settlements"
party buyer: business
party seller: business
settlement exchange = swap {
  between: [buyer, seller]
  amounts {
    buyer: buyerAmount: money(SAR)
    seller: sellerAmount: money(SAR)
  }
  fees {
    buyer: buyerFee: money(SAR)
    seller: sellerFee: money(SAR)
  }
  release: port release_exchange
  dispute: port dispute_exchange within P7D
}
port release_exchange { allowed: [buyer, seller] }
port dispute_exchange { allowed: [buyer, seller] }
```

<!-- hsx-brick: weighted_distribution -->

```hsx
program weighted_distribution_example "Weighted distribution example"
import { weighted_distribution } from "std/settlements"
party distribution_source: business
party recipient: business
settlement proceeds = weighted_distribution {
  source: distribution_source
  recipient: recipient
  amount: distributableAmount: money(SAR)
  weight: entitlementWeight: money(SAR)
  max_recipients: 12
  record_at: recordAt
  snapshot: port snapshot_entitlements
  rounding_policy: largest_remainder
  withholding_policy: refuse
  correction_policy: new_distribution
}
port snapshot_entitlements {
  allowed: [distribution_source]
  shape: { evidenceReference: text }
}
```

## Output boundary

Use `compile` or the CLI to obtain canonical UDL, the Business Frame, the origin map, and the cost manifest. The engine reads UDL and never HSX. When a task needs direct UDL work, use the UDL skill instead.
