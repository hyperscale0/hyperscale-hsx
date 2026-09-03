# Contributing to HSX

Read the repository `PRINCIPLES.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and
`open/AGENTS.md` before changing this package. `open/hsx` is AGPL and cannot
import proprietary code.

The compiler pipeline is `parse.ts` to `modules.ts` to `typecheck.ts` to
`emit.ts`. `cost.ts` derives the compile-time cost manifest. `format.ts` owns
the one canonical style. Settlement behavior belongs in `std/`, not in a
compiler switch.

Run:

```sh
bun run --cwd open/hsx check
bun run --cwd open/udl check
```

The general-path witness compares every pinned program with its canonical UDL
fixture under `test/fixtures/general-path-oracle/`. A standard module or oracle
entry may not disappear silently. New UDL clauses enter HSX through the UDL
vocabulary without a grammar production.
