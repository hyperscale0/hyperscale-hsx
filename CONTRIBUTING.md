# Contributing

## How changes get made

This repository is issues-only. Hyperscale makes the changes to the language
and to the compiler; the public proposes them in an issue. That is the whole
model, and it is stated up front so nobody spends a weekend on a branch that
was never going to be merged.

A proposal is an issue carrying two things: the program you were trying to
write, and the fixture the change would add under `test/fixtures/`. An issue
with both is a design discussion; an issue with neither is a wish.

Hyperscale accepts a pull request rarely, and only after asking for one. When
that happens the maintainer who asked sends the CLA and the author signs it
before the merge. The AGPL on its own does not let
Hyperscale LLC offer a contribution under the commercial license it sells, so
the CLA is what makes a merge possible at all.

The setup below is here because reading the compiler, running the suite, and
building the case for a proposal all need it.

## Setup

This package builds and tests with [Bun](https://bun.sh). It has zero runtime
dependencies and is meant to keep it that way, so a proposal that adds one
needs to argue for it.

```bash
bun install
bun test          # the whole suite
bun run typecheck # tsc, no emit
bun run build     # dist/, what the tarball ships
bun run check     # test + typecheck, what CI runs
```

The command, on any file:

```bash
bun bin/hsx.ts check examples/01-first-program/tip-jar.hsx
bun bin/hsx.ts build examples/01-first-program/tip-jar.hsx --out ir.json
```

## How the compiler is laid out

| File             | Stage                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `src/lex.ts`     | Text to tokens. Total: every input produces a token stream.       |
| `src/parse.ts`   | Tokens to AST. Total: always a best-effort tree plus diagnostics. |
| `src/check.ts`   | AST to the checked model. Resolves names, validates archetypes.   |
| `src/model.ts`   | What a checked program MEANS. The only input the lowering reads.  |
| `src/lower.ts`   | Checked model to HSX-JSON IR and Business Frame.                  |
| `src/compile.ts` | The driver: source in, three-verdict result out.                  |
| `src/cli.ts`     | The `hsx` command, as a pure function of argv plus injected IO.   |

Two rules hold the design together. **Parsing and checking never throw**: they
return diagnostics, because a compiler that crashes on bad input cannot report
on bad input. And **the lowering shares no code with the checker** that
verifies its output; that independence is the safety argument of the whole
compiler, so please do not factor a helper across the two.

## Grammar changes need a fixture

**A change to the grammar, the checker, or the lowering that no fixture
exercises will be asked for one.** This is the rule, not a preference.

Add a `.hsx` file under `test/fixtures/`, then assert what it compiles to in
`test/check.spec.ts` or `test/compile.spec.ts`. `test/spec.spec.ts` picks up
every `.hsx` file in the tree automatically and validates its artifacts
against `spec/hsx-ir.schema.json`, so a fixture also tests the schema for free.

If the change alters what the compiler emits, `spec/hsx-ir.schema.json` moves
with it, in the same change. Where the prose in
`docs/reference.md` and the schema disagree, the schema wins, and the prose is
a bug.

New diagnostics get a test that pins their exact message. Their wording is
part of the product: people read these while they are stuck.

## Voice

Diagnostics are written for the person who wrote the program, not for the
person who wrote the compiler. Say what is wrong and what to do about it, in
one sentence, with no jargon from the implementation:

```
settlement basket decides release through port confirm_pickup, but no port with that name is declared
```

not `unresolved reference: PortRef(confirm_pickup)`.

Examples in `examples/` are teaching material. When one changes, its README
changes in the same commit, and the companies stay invented.

## Proposals

Small and focused beats large and comprehensive. Say what you were trying to
compile and why the compiler would not let you; a fixture that fails without
the change is the strongest thing you can put in an issue.

**In the rare case Hyperscale accepts a pull request, the author signs
[the CLA](./CLA.md) first.** The AGPL alone does not let Hyperscale LLC offer
the contribution under the commercial license it sells alongside it, and the
AGPL says nothing about patents, so the patent terms live in the CLA too.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Found a vulnerability? Do not open an issue: [SECURITY.md](./SECURITY.md) has
the private reporting form.
