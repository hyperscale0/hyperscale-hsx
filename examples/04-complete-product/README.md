# 4 · A complete product

[`study-hall.hsx`](./study-hall.hsx) is a tutoring marketplace: three
settlements, three different jobs, one program.

```bash
hsx check study-hall.hsx
hsx build study-hall.hsx --out ir.json
```

| Settlement     | Archetype      | What it does                                                                                           |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `lesson`       | `held_payment` | Holds the student's payment until the tutor confirms the lesson, or until the stored end date arrives. |
| `kit_deposit`  | `deposit`      | Reserves the equipment deposit on the student's own account. Claimed on damage, returned intact.       |
| `tutor_payout` | `pooled_split` | Splits the weekly pool 55/45 between the two tutors, remainder to the lead.                            |

## A deposit is not a payment

```hsx
settlement kit_deposit = deposit {
  payer:  student
  holder: tutor
  amount: kitDeposit: money(SAR)
  claim:  port assess_kit
  return: port release_kit
}
```

The money never leaves the student's account. A deposit is a **reservation**:
placed as a hold, then either posted to the holder (`claim`) or voided back to
the payer (`return`). That is why one settlement needs two ports and why they
must be different ones. Two exits, two decisions, and the hold pairing law
accounts for the full amount on both.

## Nobody answering is an answer

```hsx
release: port confirm_lesson | at(lessonEndsAt)
```

`| at(<date field>)` gives the release a stored date to fall back on. If
nobody answers the port, the date releases the money to the tutor.

This is the one place HSX lets a deadline decide money, and it is deliberately
not symmetric: inaction resolves in the direction the parties already agreed
on, rather than stranding the payment in escrow forever. Only `held_payment`'s
`release` accepts it. Every other port must be answered.

## The remainder has an owner

```hsx
split { lead_tutor: 55%, tutor: 45%, remainder_to: lead_tutor }
```

Percentages of an integer amount of minor units almost never divide evenly.
Every piece is floored, and the leftover minor units go somewhere explicit:
`remainder_to` names which recipient carries them, and without it the first
share does. Nobody's fraction of a halala goes missing, and nobody's is
invented.

A pool needs at least two recipients, and the funder cannot be one of them. A
pool that distributes to one person is a transfer, and there is an archetype
for that.

## What it compiles to

Three nouns, `lesson`, `kit_deposit`, and `tutor_payout`, plus nine money events:

```
lesson_fund
lesson_release_tutor
lesson_release_platform
lesson_abandon
kit_deposit_hold_1
tutor_payout_pool_1
tutor_payout_pool_2
tutor_payout_payout_1
tutor_payout_payout_2
```

The Business Frame's `mechanics` come back as `escrow` and `marketplace`,
derived from the archetypes rather than declared.

One program carries at most **14** money events (`MONEY_EVENT_BUDGET`). This
one uses nine. Every installment anchor, fee leg, cancellation leg, and
abandonment refund counts one, so the budget is the real ceiling on how much
company fits in a single file. Past it, split the product.
