# Examples

Four programs, in the order they teach best. Every one of them is compiled by
`test/examples.spec.ts`, so nothing here can drift away from the compiler.

|     |                                                               |                                               |
| --- | ------------------------------------------------------------- | --------------------------------------------- |
| 1   | [First program](./01-first-program/)                          | The smallest thing that moves money.          |
| 2   | [Imports and settlement bricks](./02-imports-and-archetypes/) | Holding money, and the port that releases it. |
| 3   | [Diagnostics](./03-diagnostics/)                              | A file that is wrong on purpose, and the fix. |
| 4   | [A complete product](./04-complete-product/)                  | Three settlements doing three different jobs. |

Run any of them:

```bash
hsx check examples/01-first-program/tip-jar.hsx
hsx build examples/01-first-program/tip-jar.hsx --out ir.json
```

The companies are invented. Any resemblance to a real business is a
coincidence and not an endorsement.
