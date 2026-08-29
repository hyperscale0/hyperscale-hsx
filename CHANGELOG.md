# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The IR format version (`"hsx": 1`, stamped into every compiled document) moves
independently of the package version. While the package is below 1.0.0, an
alpha release may change what IR version 1 contains; every such change is
listed here.

## [Unreleased]

## [1.0.0-beta.1] - 2026-08-29

- This is the first beta and has no package behavior changes from
  1.0.0-alpha.6.

## [1.0.0-alpha.6] - 2026-08-29

### Fixed

- Alpha.6 carries a `held_payment` or `premium_forward` release port's actor
  allowlist and declared input fields into the generated release verb. Alpha.5
  kept those constraints in the checked program and Business Frame but dropped
  them from HSX-JSON IR, so a runtime consuming the IR could admit the release
  without the declared actor or evidence. Recompile affected programs with
  alpha.6.

## [1.0.0-alpha.5] - 2026-08-29

### Added

- Six settlement archetypes now compile and lower. `funding_round` caps locked
  commitments and contributor count, then collects or refunds each commitment
  whole. `weighted_distribution` freezes evidence-backed weights and pays by
  deterministic largest remainder. `credit_facility` owns draw capacity while
  a referenced `scheduled` obligation owns repayment. `recurring_collection`
  adds mandate evidence and explicit attempts to that obligation.
  `conditional_disbursement` stores one evidence-approved amount under a cap.
  `rotating_pool` fixes its roster, contribution, due anchors, and payout order
  before activation. Import the required archetype from `"settlement"` and
  supply every policy entry that its reference table marks as required.
- Any settlement may declare one `derived_amount` block. The runtime computes
  `floor(source * bps / 10000)` from a stored money field and callers omit the
  target field. Version 1 accepts percentage rules from 1 through 9,999 basis
  points. The checker refuses fixed rules, tiered rules, missing source fields,
  non-money source fields, and target fields that already exist.
- `captured_payment` reserves a payer amount for strict partial captures before
  a stored deadline. The payee may settle the remainder, void before capture,
  or use separate full-only correction and externally decided reversal ports.
  Declare the required capture, correction, negative-position, and timeout
  policies explicitly. Compose another settlement when capture fees are
  needed, because this archetype refuses `fees`.
- `settlement_batch` freezes capture lineage and signed adjustments at a stored
  close date, persists gross, credit, debit, and net subtotals, and instructs
  one payout from the frozen net. Supply lineage field names, the payout
  destination and beneficiary reference, and an acknowledgement port. Apply a
  correction to a later open batch instead of changing a closed batch.
- `overrideProgramEntries()`, `Program`, and the typed override and issue shapes
  are public package exports. The function replaces existing integer or
  basis-point literals in a parsed `Program`, then callers run the checker and
  lowerer again. Every
  override declares inclusive integer bounds. Negative, fractional, `NaN`,
  infinite, out-of-range, missing, ambiguous, and non-literal targets return
  coded issues, and one bad override prevents every replacement from being
  returned.
- `premium_forward` accepts an optional stored policy reference, one non-money
  endorsement port, a renewal due condition, and explicit-new-forward renewal.
  Supply `policy_ref`, `renewal_due`, `renewal_policy`, `endorsement`,
  `endorsement_policy`, and `lapse_policy` together when the forward needs
  endorsement, lapse, or renewal behavior. The original forwarding shape
  remains valid.

### Changed

- `scheduled` accepts `mode: obligation` for installment obligations. It emits
  one payment noun per anchor, binds each payment to its obligation and anchor,
  allows partial and early payments, and refunds one stored paid row whole.
  Obligation mode accepts 2 through 7 anchors and refuses rescheduling. Use the
  original transfer schedule without `mode`, or declare the debtor and every
  obligation policy explicitly.
- The program money-event budget is 20 instead of 14, and every settlement has
  its own event cap. Advance carves now validate their amount field, currency,
  recourse, and fee rules. Settlement references resolve through
  archetype-declared exits, and lowering binds referenced noun identity,
  statuses, amounts, and currency before movement. Recompile programs that
  previously sat near the budget or used an advance carve. The stricter checker
  may refuse a carve or reference that alpha.4 accepted.
- HSX-JSON IR version 1 grew new noun fields for generated-child prefixes,
  aggregate invariants, derived amounts, typed references, beneficiary IDs,
  currency, text, counts, and constants. Verbs gained public intents, reference
  bindings, captured input, payout instructions, signed sums, deterministic
  distribution, aggregate and exposure checks, and durable-settlement gates.
  Money events gained fixed, remaining-balance, and runtime-bounded amount
  modes with dependency lists. Consumers that validate or interpret IR version
  1 must adopt alpha.5's schema before accepting alpha.5 output.
- `settlement_batch` now requires `payout_beneficiary_ref`. Instruct emits a
  payout intent and captures `payoutId` instead of emitting an internal
  transfer. A system-only reconcile transition records `settlementEvidenceId`
  after durable evidence matches that payout. The tenant acknowledgement port
  remains a separate claim.

## [1.0.0-alpha.4] - 2026-08-26

### Removed

- Eleven names left the package entry point: the AST types `BlockExpr`,
  `CallExpr`, `ListExpr`, `PercentExpr`, `PortDecl`, `PortRefExpr`, and
  `SettlementDecl`, plus `lineColAt`, `CompileResult`, `HSX_IR_VERSION`, and
  `HSX_VERSION`. Nothing outside this package imported any of them, and the
  seven AST types were seven of the twenty-two the tree defines, chosen by no
  rule anyone could restate. What the entry point exports now is what callers
  use: `compile`, `checkProgram`, `lowerProgram`, `parseProgram`, and
  `MONEY_EVENT_BUDGET`. Every removed name still exists in its own module for
  the compiler's own use. Read the IR format version off the compiled
  document's `hsx` field, which is what `spec/hsx-ir.schema.json` pins and what
  a consumer of the JSON artifact already holds.

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

First public release.
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

[Unreleased]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-beta.1...HEAD
[1.0.0-beta.1]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.6...v1.0.0-beta.1
[1.0.0-alpha.6]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.5...v1.0.0-alpha.6
[1.0.0-alpha.5]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.4...v1.0.0-alpha.5
[1.0.0-alpha.4]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.3...v1.0.0-alpha.4
[1.0.0-alpha.3]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-hsx/releases/tag/v1.0.0-alpha.1
