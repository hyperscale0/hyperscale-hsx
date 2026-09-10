# Contributing to HSX

Read `README.md`, `docs/README.md`, and `std/SEMANTICS.md` before changing
this package. `open/hsx` is AGPL and cannot
import proprietary code.

The compiler pipeline is `parse.ts` to `modules.ts` to `typecheck.ts` to
`emit.ts`. `cost.ts` derives the compile-time cost manifest. `format.ts` owns
the one canonical style. Settlement behavior belongs in `std/`, not in a
compiler switch.

Run:

```sh
bun run check
```

The family specs compile standard library programs in place and assert their
UDL semantic properties directly without fixture bytes. A standard module or
semantic assertion may not disappear silently. New UDL clauses enter HSX
through the UDL vocabulary without a grammar production.
