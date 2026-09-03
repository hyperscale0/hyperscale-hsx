# 2 · Imports, settlement bricks, and the port

[`photo-booth.hsx`](./photo-booth.hsx) is a photo-booth rental company. The
renter pays up front, but the money does not reach the company until the booth
is delivered.

```bash
hsx check photo-booth.hsx
hsx build photo-booth.hsx --out ir.json
```

## Holding money changes everything

`instant_transfer` in example 1 had no custody: money left the payer and
arrived at the payee in one step. `held_payment` puts the money in the
settlement's own escrow and holds it there until something says to let go.
That "something" is the interesting part.

```hsx
release: port confirm_delivery
```

A **port** is the typed seam where the tenant's own backend decides. HSX does
not model delivery, and the platform has no way to know whether a booth showed
up. So the language does not pretend: it declares who may answer the question
and what the answer looks like, and the answer comes from outside.

```hsx
port confirm_delivery {
  allowed: [company]
  shape {
    boothId:     id(booth)
    deliveredOn: date
  }
}
```

`allowed` is required and must name declared parties. `shape` is optional; its
field types are `text`, `date`, `id(<asset>)`, and `money(<CUR>)`.

## Assets are the things, not the money

```hsx
asset booth: good { title_transfer: off_platform }
```

`title_transfer: off_platform` records that ownership of the booth changes
hands outside the platform. Money stays on-platform; this flag describes the
object. Today `frameFor` emits `offPlatform` as an empty list alongside the
frame's five constant fields (`confidence: "high"`, `conservationGroups: []`,
`offPlatform: []`, `openQuestions: []`, and `rules: []`), so callers never
assume the list carries parsed asset flags.

## Fees have a side, and the side matters

```hsx
fees { renter: 1%, company: 3% }
```

Those two percentages behave completely differently, and the difference is
fixed by the compiler, not by you:

- The **payer-side** fee (`renter: 1%`) is charged **on top** at funding and
  moves renter → platform directly. It never enters escrow, so no exit
  refunds it.
- The **payee-side** fee (`company: 3%`) is **carved out** of the amount at
  release. The renter pays the booking fee, and the company receives 97% of it.

## Cancellation splits to the basis point

```hsx
on_cancel(funded) { renter: 90%, company: 10% }
```

The shares must total exactly 100%. Not 99.99%, not 100.01%. A 0% share is
refused outright: drop the party from the block instead of promising them
nothing.

## Where the piece fields come from

Look at the compiled instrument's `fields` and you will find `piece1Amount`,
`piece2Amount`, `piece3Amount` next to `bookingFee`, plus a `partitions`
clause proving they sum to it exactly.

Release pays out 97/3 (company, platform). Cancellation pays out 90/10
(renter, company). The compiler cuts the amount at every boundary either exit
cares about, which lands on 90 / 7 / 3, and then every exit is a whole number
of pieces:

| Piece                | Release  | Cancel  |
| -------------------- | -------- | ------- |
| `piece1Amount` (90%) | company  | renter  |
| `piece2Amount` (7%)  | company  | company |
| `piece3Amount` (3%)  | platform | company |

Each piece is `floor(bookingFee × bps / 10000)` in minor units, and the
division remainder goes to `piece1Amount`. Nothing rounds; nothing is lost.
This is what "the runtime does the plumbing" actually means, and it is why the
source is 20 lines instead of a lifecycle table.
