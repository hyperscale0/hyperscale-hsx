# 3 · Reading diagnostics

[`corner-shop.hsx`](./corner-shop.hsx) is wrong on purpose. Three mistakes,
one per idea. [`corner-shop-fixed.hsx`](./corner-shop-fixed.hsx) is the same
program repaired.

```bash
hsx check corner-shop.hsx        # exits 1
hsx check corner-shop-fixed.hsx  # exits 0, prints nothing
```

## What comes back

```
corner-shop.hsx:15:12: error [check] settlement basket payee must name a declared party; there is no party named grocer
corner-shop.hsx:17:17: error [check] settlement basket decides release through port confirm_pickup, but no port with that name is declared
corner-shop.hsx:18:21: error [check] the on_cancel split must account for exactly 100%; these shares total 60%
```

Every diagnostic carries a 1-indexed line and column, a severity, the stage
that raised it, and one sentence. Coordinates always point at the source you
wrote, never at a path inside the compiled IR.

## The three mistakes

**Line 15, a name that was never declared.** `payee: grocer` names a party
that does not exist. Parties, assets, settlements, and ports share one flat
namespace, and everything in it must be declared. The fix is one line:
`party grocer: business`.

**Line 17, a decision with nothing behind it.** `release: port confirm_pickup`
says the release is decided by a port called `confirm_pickup`, and no such
port is declared. HSX will not invent a decider: someone real has to answer,
and the file has to say who. The fix declares the port and names who may
answer it.

**Line 18, money that does not add up.** `on_cancel(funded) { shopper: 60% }`
leaves 40% of the held amount unaccounted for. There is no default recipient
and no implicit remainder. The message does the arithmetic for you and says
what the shares actually total.

## All three at once, and why

The compiler reports every error it can rather than stopping at the first, so
one run tells you everything you have to fix.

But it will not report errors from two different stages in the same run.
Compiling is three stages, parse then check then lower, and a stage only runs
the one before it produced something to work with. All three errors here are
`[check]`. Introduce a syntax error, say by deleting a closing brace, and you
get one `[parse]` diagnostic and nothing else: a file that does not parse has
no meaning to check, so anything else the compiler said about it would be
guesswork.

## Errors, warnings, verdicts

There are three verdicts:

| Verdict   | Artifacts |                                            |
| --------- | --------- | ------------------------------------------ |
| `valid`   | present   | Nothing to say.                            |
| `warning` | present   | It compiled, and the lint voice has notes. |
| `invalid` | absent    | It cannot be compiled.                     |

Warnings are lint, not soft errors: a party nobody involves, an import nothing
instantiates, a 0% fee, a port nothing releases through. They never block, and
the artifacts of a `warning` compile are complete and usable. If you want them
to block in CI, `hsx check --strict` exits 1 on a warning.
