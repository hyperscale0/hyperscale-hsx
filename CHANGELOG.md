# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The IR format version (`"hsx": 1`, exported as `HSX_IR_VERSION`) moves
independently of the package version. While the package is below 1.0.0, an
alpha release may change what IR version 1 contains; every such change is
listed here.

## [Unreleased]

## [1.0.0-alpha.3] - 2026-08-25

### Fixed

- `compile()` no longer throws on a deeply nested source. Lists, blocks, calls,
  and bindings are parsed by recursion and nothing bounded it, so a file
  nesting past roughly 9,000 levels exhausted the call stack and a `RangeError`
  escaped `compile()`, which SECURITY.md says never happens. Parsing stops at
  the depth budget now and reports an ordinary parse diagnostic. The deepest
  program in the corpus nests 5 levels.
- Diagnostic coordinates cost O(n + d log n) instead of O(n·d). `compile()`
  resolved every diagnostic by rescanning the source from offset zero. On the
  largest file this release will read, 262,144 bytes carrying one diagnostic
  per two bytes, that was 10,304 ms of line and column arithmetic for 131,072
  diagnostics while the parse itself took 18 ms. It scans once and
  binary-searches now: same coordinates, 2.6 ms.

### Added

- Two source limits, both checked before the program is read. A file over
  262,144 UTF-8 bytes, the same ceiling UDL uses, is refused before the lexer
  runs. Nesting is refused past a parser depth budget of 64.

  The depth budget counts nested expressions and blocks, which is not the same
  number as source levels: `key { … }` spends one per level and `key: { … }`
  spends two, so the budget buys 63 levels of the first and 31 of the second.
  `docs/reference.md` carries the conversion for every shape. Both refusals are
  ordinary parse diagnostics, not exceptions.

## [1.0.0-alpha.2] - 2026-08-23

### Fixed

- `bin` points at the built JavaScript; alpha.1's registry metadata pointed at
  TypeScript source. npm builds the packument from package.json as it sits on
  disk after `postpack`, so the pack-time rewrite never reached `bin`, and
  every install linked `.bin/hsx` to `bin/hsx.ts`, which Node refuses to
  execute.

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

[Unreleased]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.3...HEAD
[1.0.0-alpha.3]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-hsx/releases/tag/v1.0.0-alpha.1
