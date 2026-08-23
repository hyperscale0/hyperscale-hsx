# Security

## Reporting a vulnerability

Report privately through GitHub, using this repository's
[private vulnerability reporting form](https://github.com/hyperscale0/hyperscale-hsx/security/advisories/new).
That is the only intake. There is no security email address, and nothing
security-sensitive belongs in an issue, a pull request, a discussion, or a
commit message.

A report we can act on names the affected version and gives us something to
run: the `.hsx` source, and what you expected the compiler to do with it. If
you can shape it as a fixture under `test/fixtures/`, do that; it goes straight
into the fix.

## What counts

This compiler reads untrusted source and emits a document a runtime then
executes, so the interesting failures are the ones a source file can cause:

- **A program that compiles but should not**, especially one whose emitted
  pieces do not partition their total, whose exits do not drain custody, or
  whose fees move money the source did not authorise. A `valid` verdict on an
  unsound program is the worst bug this package can have.
- **A program that makes the lexer, parser, checker, or lowering burn
  unbounded time or memory.** Every stage is meant to be linear or near it in
  the size of the input, and the schedule, split, and money-event limits exist
  to bound the output.
- **A crash.** Parsing and checking are total by design: they return
  diagnostics, they never throw. A source file that throws out of `compile()`
  is a bug even when the program is nonsense.
- **A diagnostic that reports the wrong source coordinates**, which sends an
  author to fix the wrong line.

Out of scope: the `hsx` command reading a file you told it to read, and
anything that requires already controlling the machine running it.

## Supported versions

Alpha releases are supported at the newest published `alpha` version only.
Fixes land there; there is no backport branch before 1.0.0.

## Disclosure

We will confirm receipt, tell you what we found, and agree a disclosure date
with you before publishing an advisory. If a fix is not straightforward we will
say so rather than go quiet.
