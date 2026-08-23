# Licensing

The code in this repository is Copyright 2026 Hyperscale LLC and is licensed
under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). The full text is in [`LICENSE`](./LICENSE).

## What the AGPL asks of you

Two obligations matter in practice.

**If you distribute a copy in object form**, modified or not, you make its
Corresponding Source available under the same license.

**If you run a modified copy as a network service**, section 13 applies: the
users interacting with it over the network get an offer of the source of the
version you are running. Compiling HSX with an unmodified copy behind your own
service does not trigger this. Changing the lexer, the parser, the lowering, or
the emitted IR and then serving that change does.

Using `@hyperscale0/hsx` as a library inside your own program is a combined
work under the AGPL. If that does not fit how you ship, take the commercial
license instead.

## Commercial license

Hyperscale LLC sells a commercial license to organisations that cannot accept
the AGPL, for the usual reasons: a proprietary product that links the compiler,
a hosted service you will not open, a procurement policy that refuses copyleft.
It grants the same code under ordinary commercial terms with no source
obligation.

Ask through <https://hyperscale0.ai>.

## The license covers code, not marks

"Hyperscale" and "HSX" are trademarks of Hyperscale LLC. A copyright license
says nothing about trademarks in either direction, so
[`TRADEMARKS.md`](./TRADEMARKS.md) draws that boundary.

## The language is not the compiler

HSX the language and the HSX-JSON IR are separate from this compiler. The IR
schema in [`spec/`](./spec) and the fixtures under [`examples/`](./examples)
are data describing a language, and anyone may write their own compiler,
formatter, or runtime against them, in any language, under any license, without
touching this code.

What you may then say about it is a trademark question, not a copyright one.
[`TRADEMARKS.md`](./TRADEMARKS.md) has the rule: claim compatibility with an
HSX IR version only when your implementation emits IR that validates against
that version's published schema, from the published example programs,
unmodified.
