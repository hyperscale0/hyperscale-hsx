# Trademarks

"Hyperscale" and "HSX" are trademarks of Hyperscale LLC.

The AGPL covers the code in this repository and nothing else. It grants no
rights to the marks, and it never mentions them: a copyright license says
nothing about trademarks either way. This file draws that boundary so nobody
has to guess where it sits.

What that means in practice:

- **Yes.** Say your project uses HSX, compiles HSX, or reads its internal lowering record.
  Say it in your README, your docs, your talk, and your package description.
  Fork this repository and keep the notices intact.
- **Yes.** Publish an HSX implementation or tool in another language, and name
  it in a way that describes what it does: `hsx-rs`, `hsx-lsp`, `tree-sitter-hsx`.
- **No.** Name your project, company, or product in a way that suggests
  Hyperscale LLC published it or endorses it. `@hyperscale0/*` on npm and the
  `hyperscale0` GitHub organisation are ours.
- **No.** Use the marks or our logo in a way that implies affiliation,
  sponsorship, or certification we have not given.

## Claiming compatibility

An independent implementation may say it "implements HSX IR version X" only
while it emits canonical UDL that validates against the UDL schema published
for that version, from the published example programs, unmodified. The UDL
schema and the programs in [`examples/`](./examples) are the whole
test: no edited fixture, no local relaxation of the schema.

That claim is a statement about your implementation, so keep the marks out of
its name and off its logo, and do not present it as endorsement or
certification by Hyperscale LLC. We certify nothing; the schema does.

If you are unsure, open an issue and ask. Nobody has ever regretted asking.
