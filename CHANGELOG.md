# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The IR format version (`"hsx": 1`, exported as `HSX_IR_VERSION`) moves
independently of the package version. While the package is below 1.0.0, an
alpha release may change what IR version 1 contains; every such change is
listed here.

## [Unreleased]

### Changed

- Licensed AGPL-3.0-only with a commercial license from Hyperscale LLC;
  copyright holder Hyperscale LLC; repository renamed to
  `hyperscale0/hyperscale-hsx`.

## [1.0.0-alpha.1] - 2026-08-22

First public release. The compiler is not new, it has been in production use.
This is the first version published as a package anyone can install.

### Added

- `compile(source)`, the three-verdict driver: `valid`, `warning`, and
  `invalid`, with diagnostics carrying 1-indexed line and column, a severity,
  and the stage that raised them.
- The stage entry points `parseProgram`, `checkProgram`, and `lowerProgram`,
  for tools that need one stage rather than the whole compile.
- `HSX_IR_VERSION`, exported and stamped into every compiled document as its
  `hsx` field, so a consumer can decide from one integer whether it
  understands the document. `HSX_VERSION` carries the package version.
- The `hsx` command: `hsx check <file> [--strict]` and
  `hsx build <file> [--out <file>] [--strict]`. Exit codes are `0` compiled,
  `1` refused, `2` unusable command line or input.
- `spec/hsx-ir.schema.json`, JSON Schema 2020-12 for the HSX-JSON IR document
  and the Business Frame. Every `.hsx` file in the repository is validated
  against it in CI.
- `docs/reference.md`: the lexical grammar, the EBNF the parser accepts, what
  each stage does, the diagnostic model, and all nine `settlement` archetypes
  with their parameters and constraints.
- `examples/`, four teaching programs compiled by the test suite.
- `editors/vscode/`, a TextMate grammar for syntax highlighting.

### Known limitations

- **Diagnostics have no stable codes.** Match on `severity` and `stage`, which
  are stable; do not pattern-match on message text. Codes would be additive
  and are the obvious next step.
- **There is no formatter.** `hsx fmt` does not exist rather than existing
  badly.
- **One program carries at most 14 money events** (`MONEY_EVENT_BUDGET`). A
  program that needs more is refused with a diagnostic saying so.
- **`party` takes no attribute block yet**, though the grammar parses one.

[Unreleased]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.1...HEAD
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-hsx/releases/tag/v1.0.0-alpha.1
