# 1 · Your first program

[`tip-jar.hsx`](./tip-jar.hsx) is the smallest HSX program that moves money.
A listener tips a podcast host and the money goes straight through.

```bash
hsx check tip-jar.hsx     # prints nothing, exits 0
hsx build tip-jar.hsx     # the compiled IR
```

## The four things in the file

**`program tip_jar "Tip jar"`** names the company. Exactly one per file. The
name is `snake_case` and becomes the IR document's `product`; the title is
optional and is what people read.

**`import { instant_transfer } from "settlement"`** brings in one settlement brick.
`"settlement"` is the only module there is, and it holds seventeen settlement
bricks. A brick you have not imported cannot be instantiated, so the imports
at the top tell you what shape of company this is before you read a line of it.

**`party listener: person`** declares who is involved. A party is a `person`
or a `business`. Both are needed here: `instant_transfer` names a payer and a
payee, and both must be declared parties.

**`settlement tip = instant_transfer { … }`** is the money. `payer` and
`payee` name declared parties; `amount: tipAmount: money(SAR)` declares a
field the instance stores, called `tipAmount`, holding an amount in SAR.

That doubled colon reads oddly the first time. The archetype's parameter is
`amount`; its value is a typed binding, `tipAmount: money(SAR)`, which names
the field AND its type. You choose the field name because it shows up in the
generated API, and `amount` is HSX's word, not your product's.

## What it compiles to

One noun with one verb that moves money, and one money event, `tip_pay_1`.
Notice what is NOT there: no escrow flag, because nothing is held. Compare
that with example 2, where the money waits for someone to decide.

## Try breaking it

Change `payee: host` to `payee: hosts` and run `hsx check` again. The
compiler tells you there is no party named `hosts`, and points at the column
where you wrote it. That is example 3's whole subject.
