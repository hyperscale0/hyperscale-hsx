# Contributing to HSX

Read [the language](docs/README.md) and [header inventory](docs/headers.md).
The published package does not import private platform code. The frontend parses typed
programs and headers; `compile.ts` binds references and lowers generic arithmetic
and moves. Business behavior belongs in the twelve `std` headers.

Run `bun run check` for generation, types, builds and package tests.
The platform repository checks its company programs with `bun toolchain/companies/hsx-check.ts`.
Change a rule with one example that distinguishes admitted and refused programs.
The package has no byte-fixture corpus or UDL 2 migration path.

Report security defects through [SECURITY.md](SECURITY.md).
Accepted contributions require [the CLA](CLA.md).
