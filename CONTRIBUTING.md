# Contributing to HSX

Read [the language](docs/README.md) and the headers in [`std/`](std/).
The published package does not import private platform code. The frontend parses typed
programs and headers; `compile.ts` binds references and lowers generic arithmetic
and moves. Business behavior belongs in `std` headers. Programs declare object
kinds with authored metadata and attach library instruments with parties bound
to `owner`, `actor`, or `operator`. Action subject requirements become mandatory
when the action runs; object creation may omit every metadata field.

Run `bun run check` for generation, types, builds and package tests.
Change a rule with one example that distinguishes admitted and refused programs.
Keep the object-discovery fixture aligned with its authored source. Earlier
UDL formats have no migration reader. Instrument creation stays internal.

Report security defects through [SECURITY.md](SECURITY.md).
Accepted contributions require [the CLA](CLA.md).
