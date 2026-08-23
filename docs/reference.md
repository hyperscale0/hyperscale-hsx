# HSX language reference

This is the whole language, derived from the compiler that implements it:
`src/lex.ts`, `src/parse.ts`, `src/check.ts`, and `src/lower.ts`. Where this
document and the compiler disagree, the compiler is right and this document is
a bug.

Every production below is exercised by at least one file under
`test/fixtures/` or `examples/`.

- [Lexical grammar](#lexical-grammar)
- [Syntax](#syntax)
- [Stages](#stages)
- [Diagnostics](#diagnostics)
- [Declarations](#declarations)
- [The settlement standard library](#the-settlement-standard-library)
- [Reserved names](#reserved-names)
- [Limits](#limits)

## Lexical grammar

Source is UTF-8 text. Spans are byte offsets; the compiler converts them to
1-indexed line and column before you ever see them.

```ebnf
token   = ident | keyword | number | percent | string | punct ;

ident   = letter , { letter | digit | "_" } ;
letter  = "A" … "Z" | "a" … "z" ;          (* ASCII only *)
digit   = "0" … "9" ;

keyword = "asset" | "from" | "import" | "party"
        | "port" | "program" | "settlement" ;

number  = digit , { digit } , [ "." , digit , { digit } ] ;
percent = number , "%" ;

string  = '"' , { ? any character except '"' and newline ? } , '"' ;

punct   = "{" | "}" | "(" | ")" | "[" | "]"
        | ":" | "," | "=" | "|" | "." ;
```

Four rules the grammar above does not show:

**Whitespace and comments are insignificant everywhere.** Space, tab, carriage
return, and line feed separate tokens and nothing else. A comment runs from
`//` to the end of the line. There is no block comment.

**Strings have no escapes.** A backslash is an ordinary character and a double
quote always ends the literal, so a string cannot contain one. A string that
reaches a newline or the end of file unclosed is a diagnostic ("this string
never closes"), and the lexer still produces the token so parsing continues.

**Percents are exact to a basis point and no finer.** `99.5%` is 9950 basis
points; `0.05%` is 5. A third fraction digit is refused rather than rounded,
because money that rounds at compile time is money that disappears at runtime.

**Case is a semantic rule, not a lexical one.** The lexer accepts any
identifier; the typechecker decides per position whether a name must be
`snake_case` (declarations, meters), `camelCase` (stored fields), or three
uppercase letters (currency codes). That split is why a miscased name gets
"party names are snake_case" and not "unexpected token".

`within` and `at` are contextual: they are ordinary identifiers everywhere
except inside a port reference, where they introduce a window and a date
default. Neither is reserved.

## Syntax

The parser is recursive descent and total: it always returns a best-effort
tree plus diagnostics, recovering at the next top-level keyword so one mistake
never hides the rest of the file.

```ebnf
program         = { decl } ;

decl            = program_decl | import_decl | party_decl
                | asset_decl | settlement_decl | port_decl ;

program_decl    = "program" , ident , [ string ] ;
import_decl     = "import" , "{" , ident , { sep , ident } , "}" ,
                  "from" , string ;
party_decl      = "party" , ident , ":" , ident , [ block ] ;
asset_decl      = "asset" , ident , ":" , ident , [ block ] ;
settlement_decl = "settlement" , ident , "=" , ident , block ;
port_decl       = "port" , ident , block ;

block           = "{" , { entry , [ sep ] } , "}" ;
entry           = ident , [ qualifiers ] , ( block | ":" , expr ) ;
qualifiers      = "(" , ident , { sep , ident } , ")" ;

expr            = string | number | percent | list | block
                | port_ref | ident_expr ;

list            = "[" , { expr , [ sep ] } , "]" ;

port_ref        = "port" , ident ,
                  [ "within" , ident ] ,
                  [ "|" , "at" , "(" , ident , ")" ] ;

ident_expr      = ident , [ member | call | binding ] ;
member          = "." , ident ;                    (* settlement.release *)
call            = "(" , { expr , [ sep ] } , ")" ; (* money(SAR), id(vehicle) *)
binding         = ":" , expr ;                     (* price: money(SAR) *)

sep             = "," ;                            (* optional everywhere *)
```

Commas are separators, never terminators, and they are optional in every list
the grammar shows. These four write the same program:

```hsx
fees { renter: 1%, company: 3% }
fees { renter: 1% company: 3% }
fees {
  renter: 1%
  company: 3%
}
fees: { renter: 1%, company: 3% }
```

An entry gets its value one of two ways: `key: <expr>` or `key { … }`. The
second is sugar for the first when the value is a block, which is why
`shape { … }` and `shape: { … }` both parse.

Qualifiers exist for one production today, `on_cancel(funded)`, and every
other entry refuses them.

## Stages

Compiling runs three stages in order. Each one either hands its output to the
next or stops the compile.

**Parse** turns text into a tree. It knows nothing about settlements: it can
tell you a block never closes, but not that `held_payment` needs a payee. Any
parse diagnostic ends the compile with verdict `invalid`, because a file that
does not parse has no meaning to check. That is also why a badly-braced file
reports one error and not fifty.

**Check** resolves every name and validates every archetype's parameters, and
produces the checked model in `src/model.ts`, what the program MEANS. It
resolves cross-settlement references (`against: retention.release`) here, at
compile time, so nothing is left for a caller to pick at runtime. It emits
both errors and warnings; an error stops the compile, a warning does not.

**Lower** turns the checked model into the HSX-JSON IR document and the
Business Frame. It shares no code with the check stage and never re-reads the
tree. That independence is the compiler's safety argument: the stage that
generates the money choreography is not the stage that proved the program
sound. Lowering issues are rare by design and mean the compiler refused to
emit something it could not prove, not that you wrote bad HSX.

The lowering also fixes semantics the source does not state:

- A **payer-side fee** is charged on top of the amount and moves payer →
  platform at funding. It never enters custody, so it is not refundable by any
  exit.
- A **payee-side fee** (and a premium commission) is carved out of the amount
  at release.
- Whenever an amount splits, it is **partitioned into the finest common
  refinement of every exit**: one required money field per piece, and a
  `partitions` clause on the noun so create admission proves the pieces sum to
  the total before any money moves.
- Piece arithmetic is **integer minor units**: each piece is
  `floor(amount × bps / 10000)`, and the division remainder goes to the first
  piece unless a split names `remainder_to`.
- A **schedule unrolls**: a literal anchor count becomes one due-driven verb
  per anchor, each its own idempotent step.
- **Metered usage never accrues custody**: each usage charge is the ledger
  transfer, so emission and ledger cannot diverge.
- A **deposit is a reservation**, not a transfer: placed as a hold, then
  posted to the holder or voided back to the payer.

## Diagnostics

Every diagnostic carries four things and no more:

| Field      | Values                                           |
| ---------- | ------------------------------------------------ |
| `line`     | 1-indexed source line                            |
| `column`   | 1-indexed source column, in UTF-16 code units    |
| `severity` | `error` or `warning`                             |
| `stage`    | `parse`, `check`, or `lower`                     |
| `message`  | one sentence, in the program author's vocabulary |

**There are no diagnostic codes.** Nothing in the compiler assigns stable
identifiers to messages, so do not build tooling that pattern-matches on
message text: match on `severity` and `stage`, which are stable. Codes are the
obvious next addition and would be additive.

Coordinates always point at SOURCE, never at a lowered IR path. A conservation
failure discovered while lowering reports at the `fees` block you wrote.

The three verdicts:

| Verdict   | Artifacts | Meaning                                                                                     |
| --------- | --------- | ------------------------------------------------------------------------------------------- |
| `valid`   | present   | The program lowered and there is nothing to say about it.                                   |
| `warning` | present   | It lowered, and the compiler's lint voice has notes. The artifacts are complete and usable. |
| `invalid` | absent    | It cannot be lowered. The diagnostics say why.                                              |

Warnings are lint, not soft errors: an unreferenced party, a duplicate import,
a 0% fee, a port nothing releases through, an advance with no repayment path
if its hold is abandoned before funding. `hsx check --strict` turns them into
a failing exit code without changing the verdict.

## Declarations

A file is a flat list of declarations in any order. Forward references are
fine: a settlement may name a port declared below it.

### program

```hsx
program used_car_escrow "Used-car escrow"
program plain_header
```

Exactly one per file. The name is `snake_case`. The title is optional; without
it the compiler derives one from the name (`plain_header` → "Plain header").

### import

```hsx
import { held_payment, deposit } from "settlement"
```

`"settlement"` is the only importable module. Every archetype a settlement
instantiates must be imported first. Importing a name twice, or importing one
and never instantiating it, is a warning.

### party

```hsx
party buyer:  person
party seller: business
```

A party is a `person` or a `business`. The attribute block the grammar allows
is refused by the checker today ("party takes no attribute block yet").

### asset

```hsx
asset vehicle: good { title_transfer: off_platform }
asset locker:  access
```

An asset is `access`, `claim`, `good`, `service`, or `ticket`. The only
attribute is `title_transfer`, either `on_platform` (the default) or
`off_platform`. It describes where ownership of the thing changes hands. Money
stays on-platform either way; an `off_platform` asset shows up in the Business
Frame's `offPlatform` list so nobody mistakes the platform for the escrow of
the object as well as the money.

### settlement

```hsx
settlement sale = held_payment { … }
```

Names an instance of one archetype. The name becomes the IR noun's `id`, so
settlement names are the product's published vocabulary. See the standard
library below.

### port

```hsx
port confirm_handover {
  allowed: [buyer]
  shape {
    vehicleId:   id(vehicle)
    inspectedOn: date
    damageNote:  text
    surcharge:   money(SAR)
  }
}
```

A port is the typed seam where the tenant's own backend decides something the
platform cannot know. `allowed` is a non-empty list of distinct declared
parties and is required. `shape` is optional and declares the answer's fields:
each name is `camelCase`, each type is one of

| Type           | Meaning                                  |
| -------------- | ---------------------------------------- |
| `text`         | free text                                |
| `date`         | a date                                   |
| `id(<asset>)`  | a reference to a declared asset          |
| `money(<CUR>)` | an amount in the named ISO 4217 currency |

## The settlement standard library

Nine archetypes ship in `"settlement"`, and all nine lower. The tables below
list each one's entries: **required** entries are bold.

Shared value shapes:

| Shape       | Written as              | Rules                                                                                                                     |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| party       | `buyer`                 | Must name a declared party.                                                                                               |
| money field | `price: money(SAR)`     | Field name `camelCase`; currency three uppercase letters.                                                                 |
| percent     | `2.5%`                  | Basis-point precision, strictly under 100%. `0%` warns.                                                                   |
| port        | `port confirm_handover` | Must name a declared port.                                                                                                |
| date field  | `releaseDueAt`          | A `camelCase` name for a date the instance stores.                                                                        |
| duration    | `P14D`, `P2W`, `"P30D"` | Fixed days or weeks only. Calendar months are refused by name: they drift, so they cannot anchor an exact money deadline. |

### held_payment

The payer funds the amount into the settlement's own escrow; a decision port
releases it to the payee.

| Entry               | Value                                  | Notes                                                                                                                                                                                            |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`payer`**         | party                                  | Must differ from `payee`.                                                                                                                                                                        |
| **`payee`**         | party                                  |                                                                                                                                                                                                  |
| **`amount`**        | money field                            | The gross held amount.                                                                                                                                                                           |
| **`release`**       | port, optionally `\| at(<date field>)` | The only archetype whose port accepts a date default: with `at(…)`, the stored date releases to the payee when nobody decided. Inaction resolves in the direction the parties already agreed on. |
| `fees`              | block of `party: percent`              | Bearer must be this settlement's payer or payee.                                                                                                                                                 |
| `on_cancel(funded)` | block of `party: percent`              | Shares to payer or payee, summing to exactly 100%. A 0% share is refused: drop the party instead.                                                                                                |

```hsx
settlement retention = held_payment {
  payer:   contractor
  payee:   subcontractor
  amount:  retainedAmount: money(SAR)
  fees { subcontractor: 1.5% }
  release: port approve_release | at(defectsPeriodEnd)
  on_cancel(funded) { contractor: 100% }
}
```

### instant_transfer

The payer pays straight through to the payee. No custody.

| Entry        | Value                     | Notes                                                              |
| ------------ | ------------------------- | ------------------------------------------------------------------ |
| **`payer`**  | party                     | Must differ from `payee`.                                          |
| **`payee`**  | party                     |                                                                    |
| **`amount`** | money field               |                                                                    |
| `fees`       | block of `party: percent` | Payee-side fees partition the amount; payer-side fees ride on top. |

### swap

Exactly two parties fund one amount each into the same escrow, then the whole
exchange releases, settles, cancels, or claws back as one indivisible
lifecycle.

| Entry         | Value                                | Notes                                                                                                                                  |
| ------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`between`** | list of exactly two distinct parties |                                                                                                                                        |
| **`amounts`** | block of `party: money field`        | One per side, both in the same currency: two currencies cannot be linked in one atomic ledger batch.                                   |
| **`release`** | port                                 | Whole-trade. The port may allow only the two swap parties.                                                                             |
| `dispute`     | port `within <duration>`             | The window is required here and forbidden everywhere else. A positive window is the clawback path.                                     |
| `fees`        | block of `party: money field`        | Exact on-top money, never a caller-computed rate. Field names distinct from the principals and from each other, in the trade currency. |

### deposit

The held amount is a reservation on the payer's own account in the holder's
favour: placed as a hold, then claimed (posted to the holder) or returned
(voided back to the payer).

| Entry        | Value       | Notes                                                                          |
| ------------ | ----------- | ------------------------------------------------------------------------------ |
| **`payer`**  | party       | Must differ from `holder`.                                                     |
| **`holder`** | party       |                                                                                |
| **`amount`** | money field |                                                                                |
| **`claim`**  | port        |                                                                                |
| **`return`** | port        | Must be a different port from `claim`: the two exits need their own decisions. |

### premium_forward

The payer funds a premium into custody; a decision port binds the policy,
which forwards the premium to the carrier exactly once, minus commission.

| Entry               | Value                     | Notes                                                          |
| ------------------- | ------------------------- | -------------------------------------------------------------- |
| **`payer`**         | party                     | Must differ from `carrier`.                                    |
| **`carrier`**       | party                     |                                                                |
| **`amount`**        | money field               | The premium.                                                   |
| **`bind`**          | port                      | The binding decision.                                          |
| `commission`        | percent                   | Carved from the premium at forwarding. Defaults to 0%.         |
| `on_cancel(funded)` | block of `party: percent` | Shares to payer or carrier, summing to 100%. Pre-binding only. |

### scheduled

The total partitions into `count` installments, each collected on its own
anchor. Finite by construction: the count is a literal, so the schedule can
never be unbounded.

| Entry           | Value           | Notes                                                                          |
| --------------- | --------------- | ------------------------------------------------------------------------------ |
| **`payer`**     | party           | Must differ from `payee`.                                                      |
| **`payee`**     | party           |                                                                                |
| **`amount`**    | money field     | The total, not the installment.                                                |
| **`count`**     | literal integer | Between 2 and 12.                                                              |
| **`every`**     | duration        | Ident or quoted string: `P30D`, `"P30D"`, `P2W`.                               |
| **`first_due`** | date field      | Carries the first anchor's due date. Must differ from the amount's field name. |

### metered

Per-unit charges on a committed rate card, each usage emission being the
ledger transfer itself, until the period closes.

| Entry          | Value                         | Notes                                                                                     |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| **`payer`**    | party                         | Must differ from `payee`.                                                                 |
| **`payee`**    | party                         |                                                                                           |
| **`rates`**    | block of `meter: money field` | At least one. Meter names `snake_case`; every rate in one currency; field names distinct. |
| **`close_by`** | date field                    | The period's close date. Past it, further charges are unreachable.                        |

```hsx
settlement trip_extras = metered {
  payer:    traveler
  payee:    agency
  close_by: tripEndDate
  rates {
    excursion: excursionFee: money(SAR)
    city_tour: cityTourFee:  money(SAR)
  }
}
```

### pooled_split

One instance per payout period. The funder pools the period total piece-wise,
and the pool distributes to the named recipients on the payout date.

| Entry            | Value                                                          | Notes                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`payer`**      | party                                                          | The funder.                                                                                                                                                                          |
| **`amount`**     | money field                                                    | The period total.                                                                                                                                                                    |
| **`split`**      | block of `party: percent`, plus optional `remainder_to: party` | At least two recipients, none of them the funder, summing to exactly 100%. `remainder_to` names which share carries the integer-division remainder; without it the first share does. |
| **`payout_due`** | date field                                                     |                                                                                                                                                                                      |

### advance

The funder disburses the advance to the advanced party, who repays it from
exactly one source.

| Entry                           | Value                  | Notes                                                          |
| ------------------------------- | ---------------------- | -------------------------------------------------------------- |
| **`funder`**                    | party                  | Must differ from `to`.                                         |
| **`to`**                        | party                  | The advanced party.                                            |
| **`amount`**                    | money field            |                                                                |
| `fee`                           | percent                | The funder's discount on the advance. Defaults to 0%.          |
| `against`                       | `<settlement>.release` | Carve source. Mutually exclusive with the schedule keys below. |
| `count` / `every` / `first_due` | as `scheduled`         | Schedule source. All three or none.                            |

An advance draws on one source and one only. Naming neither is an error, and
so is naming both.

A carve (`against: retention.release`) is the language's one cross-declaration
reference, and it resolves entirely at check time:

- the target must be a declared `held_payment`;
- its payee must be the advanced party, since an advance carves the release of
  the party it finances;
- its payer may not be the funder, since whoever pays the hold cannot also be
  the funder its release repays;
- no two advances may draw against the same release.

The hold's release is the advance's only repayment, so every other exit leaves
the funder unpaid. If the hold declares `on_cancel`, a `scheduled` settlement
collecting from the advanced party to the funder is **required** (its absence
is an error). If the hold has no cancellation, the uncovered path is only
pre-funding abandonment, and its absence is a warning.

## Reserved names

`platform` and `escrow` name the platform and each settlement's own escrow.
They exist without being declared and cannot be taken.

Parties, assets, settlements, and ports share one flat namespace: every
declared name must be unique across all four, and every one is `snake_case`.

The lowering mints fields of its own, and a user field that collided with one
would silently overwrite it and corrupt the choreography. These are refused at
source coordinates, for every archetype:

| Reserved |                                                                                              |
| -------- | -------------------------------------------------------------------------------------------- |
| Exact    | `currency`, `feeAmount`, `repayableAmount`, `serviceFeeAmount`, `clawbackAt`                 |
| Patterns | `piece<n>Amount`, `installment<n>Amount`, `repayment<n>Amount`, `*ShareAmount`, `*AccountId` |

## Limits

| Limit                    | Value                     | Why                                                                                                                                            |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Money events per program | 14 (`MONEY_EVENT_BUDGET`) | The Business Frame carries at most this many. Every installment anchor, fee leg, cancellation leg, abandonment refund, and forward counts one. |
| Schedule anchors         | 2 to 12                   | Keeps a schedule finite by construction.                                                                                                       |
| Percent precision        | 1 basis point             | Money that rounds at compile time disappears at runtime.                                                                                       |
| Durations                | days and weeks            | Calendar months drift.                                                                                                                         |
| Swap parties             | exactly 2                 |                                                                                                                                                |
| Pool recipients          | at least 2                | A pool distributing to one recipient is a transfer.                                                                                            |

Two generated names colliding is also a refusal rather than a silent
overwrite: if two settlements would mint the same internal key, or one
settlement would mint two verbs with the same name, the compiler names both
and asks you to rename one.
