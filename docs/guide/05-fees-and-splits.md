# Fees and splits

Standard-library payment modules accept bounded fee forms. A payer fee sits on top of the principal. A payee fee is carved from the payout. A fee may be an exact percentage, an immutable money field, or a finite tier table when the module accepts it.

```hsx
program lesson_market "Lesson market"
import { instant_transfer, pooled_split } from "std/settlements"
party student: person
party tutor: business
party assistant: business
party school: business
settlement lesson = instant_transfer {
  payer: student
  payee: tutor
  amount: lessonFee: money(SAR)
  fees { student: 1%, tutor: 8% }
}
settlement payout = pooled_split {
  payer: school
  amount: weeklyPool: money(SAR)
  payout_due: payoutAt
  split { tutor: 60%, assistant: 40%, remainder_to: tutor }
}
```

Every percentage partition must total 100 percent. `pooled_split` distributes a pool among named recipients and sends integer-division residue to `remainder_to`. `security_deposit` can bind a decided claim amount and return the unused remainder. `weighted_distribution` records bounded entitlement rows before it snapshots a distribution.

`cancellable_booking` uses `quote` and `commit` when a fee must be shown before it can move money. Its `cancel` action prices a penalty from the time left before `starts_at`, freezes the price and the fields named by `fixes`, and gives the offer a bounded life. Its `confirm` action commits that exact quote. Expiry or a changed frozen field refuses the commit instead of repricing it silently.

```hsx
program studio_booking "Studio booking"
import { cancellable_booking } from "std/settlements"
party guest: person
party studio: business
settlement session = cancellable_booking {
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
