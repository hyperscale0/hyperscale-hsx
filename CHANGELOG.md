# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The IR format version (`"hsx": 1`, stamped into every compiled document) moves
independently of the package version.

## [Unreleased]

## [2.3.0] - 2026-09-17

Pairs with UDL 2.5.0.

### Added

- `allow_zero: true` on a `money<C>` field admits a zero amount; the default still refuses zero. `allow_zero` on any other type is HSX1105. Decision port shapes set it on their money fields.

### Changed

- `date` fields admit any RFC 3339 offset, such as `+03:00`; the host stores the UTC instant. Values already in `Z` pass through unchanged.

### Docs

- The instruments guide gains "Money fields" and "Date fields" sections covering both rules.

## [2.2.1] - 2026-09-16

Pairs with UDL 2.4.0.

### Fixed

- `cancellable_booking` pins its four priced-booking account fields to the `customer_balance` role, so programs that import it pass the host's account-role admission law.
- Pin receipt distribution fee, tax and residual accounts to customer balances.
- Lower omitted and full-refund unpaid cancellation bands as deposit refunds. Refuse constant cancellation partitions that exceed the deposit.

### Docs

- The instruments guide teaches the `"x-hyperscale-reference-filter"` role pin on account fields, and the generated type reference repeats it.

## [2.2.0] - 2026-09-15

Pairs with UDL 2.4.0.

### Added

- General lowering for allocation, `requiresAllocation`, `templateBinding`, children buckets, unique account fields and allocation-backed exposure measures. Signed schedules, stored rates, referenced transitions, equal partitions, contributions and attested decisions retain their UDL contracts.
- Custody vocabulary: `shift_date`, `requiresExposure.groupField` and `minimumField`, `funding` and `receiptDistribution`.
- `cancellable_booking` accepts finite `cancel_bands`, deposit/balance custody, supplier shares, confirmation release and timeout refunds. `held_payment.private_actions` lets a program select its public aliases.
- `threshold_pool.funding_join` binds frozen wallet tickets to priced funding. `weighted_distribution` receipt mode derives ticket ratios, carves fee and VAT, pays a named residual and allocates noncash losses.
- A complete authored cash-movement example and checkout CLI instructions. Generated std references include parameter tables and clause coverage across branches.

### Changed

- `advance` derives profit from principal, separates repayment and profit parties, and accepts signed dates. `scheduled` expands finite slice lists and preserves other delinquent slices.
- Remove the empty `recurring_collection` module, unused std parameters, the journeys clause and the Blueprint cost dimension.

## [2.1.1] - 2026-09-15

Published in lockstep with UDL 2.3.0.

### Added

- `docs/piece-plans.md`, a guide to partitioned totals: declaring pieces, orders and payees, staging one piece per action, and reading the compiled plan.

## [2.1.0] - 2026-09-14

Published in lockstep with UDL 2.1.0.

### Added

- `piece_plan` declares a partitioned total with named pieces, immutable release and refund payees, and fund, release, refund and unfund orders. `piece_stage` on an action moves one piece and derives the `pieceId` input from the selected order.
- `calls` on an action invoke typed private actions from an `action_library`, binding parameters and capturing results. Public and authored calls lower to the same leaf origins, and the compiled document round-trips calls and piece plans losslessly.
- Diagnostics `HSX1610` (piece partition), `HSX1611` (piece stage), `HSX1612` (action graph), `HSX1613` (static call binding), `HSX1614` (action boundary) and `HSX1615` (leaf evidence and effects), each mapped from its UDL counterpart. `HSX1601` and `HSX1602` now take their fix text from the diagnostic table.
- The cost kernel prices every expanded leaf of a call and refuses a leaf without a price (`HSX1301`).

### Changed

- The VS Code extension is titled "Hyperscale HSX". The README and playground carry the design-language brand assets.
- `HSX_LIMITS.maxExpansions` (256) bounds action-graph expansion; the typechecker's own limit is gone.

## [2.0.5] - 2026-09-11

### Fixed

- Print diagnostic codes next to severity, stage, and location on compiler and formatter error paths so `hsx explain <code>` works.
- Reconcile `version.ts` with `package.json`.

## [2.0.4] - 2026-09-11

Published in lockstep with UDL 2.0.4.

### Added

- Diagnostic `HSX1026` reports a decision port field whose declared type differs from the type its instrument captures for that field. It runs only when the compiler is given a published catalog, so plain CLI compiles are unchanged.

### Fixed

- The standard `held_payment` flow accepts `quote_cancellation` again from `cancellation_quoted`, so an expired offer can be re-quoted instead of trapping the deal.
- `held_payment` admits a dispute from `cancellation_quoted`.
- A `held_payment` cancellation with `cancel_charge_bps` of zero settles without emitting a zero-amount retain transfer.

## [2.0.3] - 2026-09-10

Published in lockstep with UDL 2.0.3.

### Added

- The quote clause key `charge_retained_by` lowers to the UDL `chargeRetainedBy` declaration, so an instrument can say which party keeps a cancellation charge. The lowering rides the generic key mapping that 2.0.2 already shipped; this release pins it with a test.

## [2.0.2] - 2026-09-10

### Added

- `held_payment` takes an opt-in quoted cancellation with an authored flat charge, so a cancellation quote can name the amount the refund source keeps.
- `std/money_flows/weighted_distribution` flow.
- Every std flow describes itself: the reference pages carry parameters and an example for each flow, and the guide documents the sandbox.

### Removed

- The GitHub Actions workflows. Publishing runs from the platform release lane.

## [2.0.1] - 2026-09-10

Published in lockstep with UDL 2.0.1.

### Added

- Pinned the currency of every move of a `money<CUR>` field, and of every account step in a fixed-currency instrument, to the constant `CUR` in the lowered document; a binding that reads the instrument's currency field is rewritten, and one the compiler cannot pin (an input, a ref, or a constant naming another currency) reports `HSX1306`.

### Changed

- Anchored `dispute` on `held_payment` to `release_deadline` like `cancel`, so a dispute after the release deadline refuses instead of freezing money the clock already released.
- Declared the safe-integer maximum on `share_offering.totalShares` and `share_allocation.shares` so the lowered schema round-trips byte for byte.

## [2.0.0] - 2026-09-10

### Added

- Added `hsx lsp` over stdio with diagnostics and formatting, and a VS Code language client.
- Added a static browser playground under `playground/` with debounced compilation, diagnostics inspection, span navigation, canonical UDL and cost manifest inspection, and inlined examples.
- Bundled standard library sources as data in `src/std-bundle.ts` and decoupled compiler module resolution from Node filesystem imports.
- Lowered money fields with an `x-hyperscale-currency` schema marker so consumers read the ledger currency without parsing descriptions.
- Accepted an array of cost tables (`examples/cost-table.json` now ships one card per priced currency); the compiler prices the card matching the program's ledger currency, reporting `HSX1304` for an unpriced currency and `HSX1305` for a program that moves money in two currencies.
- Reported `HSX1509` when an instrument, or an action a caller can reach, lacks an `agent_description`.
- Declared `sandbox_failure_point` on the std money-flow fund and release actions so sandbox failures land on a named step.
- Added `share_offering` and `share_allocation` std instruments with an integer-sum supply invariant, `dispute` and `resume` on `held_payment`, and `quote_refund` and `confirm_refund` on policy programs.
- Bound decision port parties through declared account fields; a decision-only party binds to an account and decides without holding money, and every action a port reaches carries its allowed parties.

### Changed

- Lowered `account<CUR>` fields with the `acct_(sandbox|live)_...` pattern.
- Diagnosed `allowed:` written on an action instead of its port, and refused ports whose allowed parties are not declared (`HSX1024`).
- Field descriptions are prose in the lowered document and no longer part of the frozen schema.
- Moved LSP server exports (`startLspServer`, `createHostForUri`, and LSP types) from the package root to `@hyperscale0/hsx/lsp`.

### Removed

- Deleted the Business Frame artifact (`frame`) from the compiler output and CLI build command.

## [1.0.0] - 2026-09-04

This release is byte-identical to 1.0.0-rc.1.

## [1.0.0-rc.1] - 2026-09-02

### Added

- Added the repository guide, generated compiler reference, `llms.txt`, and
  `llms-full.txt`. Tests compile every guide program and compare generated
  files byte for byte.
- Added one compiled example and pinned canonical UDL file for every standard
  library module.
- Added the public HSX agent skill and moved language examples into it.
- Added `hsx explain` for the stable diagnostics catalog.
- Added a generated VS Code grammar, standard-library snippets, and a CI-built
  `hsx.vsix` artifact.

### Changed

- `hsx cost` now prints a versioned effect table by default. `--json` prints the
  complete manifest, and `--out <file.json>` writes that JSON. Basis-point rows
  label their total as amount-dependent because the compiler has no priced
  runtime amount. No cost flags were removed.
- The npm package now includes `docs/` and `skills/`. It no longer lists the
  deleted `spec/` directory.
- The package exports its shipped standard-library files through `./std/*`.

### Fixed

- Diagnostics raised from an imported module now name that module and its own
  source coordinates.
- `premium_forward` now reports `HSX1011` when endorsement selects a path that
  needs `renewal_due`. It no longer reaches an internal lowering refusal.

## [1.0.0-beta.1] - 2026-08-29

- This is the first beta and has no package behavior changes from
  1.0.0-alpha.6.

## [1.0.0-alpha.6] - 2026-08-29

### Fixed

- Alpha.6 carries a `held_payment` or `premium_forward` release port's actor
  allowlist and declared input fields into the generated release action. Alpha.5
  kept those constraints in the checked program and Business Frame but dropped
  them from HSX-JSON IR, so a runtime consuming the IR could admit the release
  without the declared actor or evidence. Recompile affected programs with
  alpha.6.

## [1.0.0-alpha.5] - 2026-08-29

### Added

- Six settlement modules now compile and lower. `threshold_pool` caps locked
  commitments and contributor count, then collects or refunds each commitment
  whole. `weighted_distribution` freezes evidence-backed weights and pays by
  deterministic largest remainder. `credit_facility` owns draw capacity while
  a referenced `scheduled` obligation owns repayment. the retired collection tracker
  adds mandate evidence and explicit attempts to that obligation.
  `conditional_disbursement` stores one evidence-approved amount under a cap.
  `rotating_pool` fixes its roster, contribution, due anchors, and payout order
  before activation. Import the required module from `"settlement"` and
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
  needed, because this module refuses `fees`.
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
  one payment instrument per anchor, binds each payment to its obligation and anchor,
  allows partial and early payments, and refunds one stored paid row whole.
  Obligation mode accepts 2 through 7 anchors and refuses rescheduling. Use the
  original transfer schedule without `mode`, or declare the debtor and every
  obligation policy explicitly.
- The program money-event budget is 20 instead of 14, and every settlement has
  its own event cap. Advance carves now validate their amount field, currency,
  recourse, and fee rules. Settlement references resolve through
  module-declared exits, and lowering binds referenced instrument identity,
  statuses, amounts, and currency before movement. Recompile programs that
  previously sat near the budget or used an advance carve. The stricter checker
  may refuse a carve or reference that alpha.4 accepted.
- HSX-JSON IR version 1 grew new instrument fields for generated-child prefixes,
  aggregate invariants, derived amounts, typed references, beneficiary IDs,
  currency, text, counts, and constants. Actions gained public actions, reference
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
  The release reference carried the conversion for every shape. Both refusals are
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
- The release reference: the lexical grammar, the EBNF the parser accepts, what
  each stage does, the diagnostic model, and all nine `settlement` modules
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

[Unreleased]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-rc.1...v1.0.0
[1.0.0-rc.1]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-beta.1...v1.0.0-rc.1
[1.0.0-beta.1]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.6...v1.0.0-beta.1
[1.0.0-alpha.6]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.5...v1.0.0-alpha.6
[1.0.0-alpha.5]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.4...v1.0.0-alpha.5
[1.0.0-alpha.4]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.3...v1.0.0-alpha.4
[1.0.0-alpha.3]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/hyperscale0/hyperscale-hsx/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/hyperscale0/hyperscale-hsx/releases/tag/v1.0.0-alpha.1
