/**
 * The checked program model: what an HSX program MEANS once every name
 * resolves and every archetype's parameter surface is validated. This is the
 * only input the lowering consumes, it never re-reads the AST, and every
 * node keeps its source span so later stages report at source coordinates.
 */

import type { Span } from "./ast.ts";

export const PARTY_KINDS = ["business", "person"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const ASSET_KINDS = [
  "access",
  "claim",
  "good",
  "service",
  "ticket",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface CheckedParty {
  readonly kind: PartyKind;
  readonly name: string;
  readonly origin: Span;
}

export interface CheckedAsset {
  readonly kind: AssetKind;
  readonly name: string;
  readonly origin: Span;
  /** Where ownership of the asset itself changes hands. Money stays on-platform either way. */
  readonly titleTransfer: "off_platform" | "on_platform";
}

/** A typed money amount the program declares, e.g. `price: money(SAR)`. */
export interface MoneyField {
  readonly currency: string;
  readonly name: string;
  readonly origin: Span;
}

/** One platform fee term: `buyer: 1%`, the named party bears bps to the platform. */
export interface FeeTerm {
  readonly bearer: string;
  readonly bps: number;
  readonly origin: Span;
}

/** One share of a cancellation split: `buyer: 99.5%`. */
export interface SplitShare {
  readonly bps: number;
  readonly origin: Span;
  readonly to: string;
}

/** `on_cancel(funded) { ... }`, how the held amount unwinds, summing to 100%. */
export interface CancelPolicy {
  readonly origin: Span;
  readonly shares: readonly SplitShare[];
  readonly when: "funded";
}

/**
 * A finite payment schedule: `count` anchors, one every `every` (a fixed
 * calendar-free ISO duration in days or weeks), the first anchored on the
 * stored date field `firstDueField`. Finiteness is by construction: count is
 * a literal, so the schedule can never be unbounded.
 */
export interface ScheduleTerms {
  readonly count: number;
  /** Fixed ISO duration between anchors, single unit: P<n>D or P<n>W. */
  readonly every: { readonly days: number; readonly raw: string };
  /** camelCase date field carrying the first anchor's due date. */
  readonly firstDueField: string;
  readonly origin: Span;
}

/**
 * The checked `held_payment` instantiation: payer funds `amount` into the
 * settlement's own custody; a decision port releases it to the payee; fees
 * accrue to the platform; cancellation splits the held amount exactly.
 */
export interface CheckedHeldPayment {
  readonly amount: MoneyField;
  readonly archetype: "held_payment";
  readonly fees: readonly FeeTerm[];
  readonly name: string;
  readonly onCancel?: CancelPolicy;
  readonly origin: Span;
  readonly payee: string;
  readonly payer: string;
  readonly release: PortRelease;
  /**
   * `release: port <p> | at(<field>)`, the camelCase stored date field the
   * hold releases to the payee on when no decision was recorded, and the
   * cutoff both caller exits share. Absent when the port is the only way out.
   */
  readonly releaseDeadlineField?: string;
}

/** A fixed, calendar-free decision window. */
interface FixedWindow {
  readonly days: number;
  readonly raw: string;
}

/** An exact on-top service fee declared as money, never a caller-computed rate. */
export interface SwapFee {
  readonly amount: MoneyField;
  readonly bearer: string;
}

/** One side of a strict two-party atomic swap. */
interface SwapSide {
  readonly amount: MoneyField;
  readonly fee?: SwapFee;
  readonly party: string;
}

/**
 * The checked `swap`: exactly two parties fund one amount each into the same
 * escrow, then the entire exchange releases, settles, cancels, or claws back
 * as one indivisible lifecycle.
 */
export interface CheckedSwap {
  readonly archetype: "swap";
  readonly dispute?: PortRelease & { readonly window: FixedWindow };
  readonly name: string;
  readonly origin: Span;
  readonly release: PortRelease;
  readonly sides: readonly [SwapSide, SwapSide];
}

/**
 * The checked `instant_transfer`: payer pays `amount` straight through to the
 * payee, no custody. Fees partition the amount (payee side) or ride on top
 * (payer side); the pieces conserve the amount exactly.
 */
export interface CheckedInstantTransfer {
  readonly amount: MoneyField;
  readonly archetype: "instant_transfer";
  readonly fees: readonly FeeTerm[];
  readonly name: string;
  readonly origin: Span;
  readonly payee: string;
  readonly payer: string;
}

/**
 * The checked `premium_forward`: payer funds the premium into custody; a
 * decision port binds the policy, which forwards the premium to the carrier
 * exactly once, minus the platform's commission. Pre-binding cancellation
 * splits the held premium.
 */
export interface CheckedPremiumForward {
  readonly amount: MoneyField;
  readonly archetype: "premium_forward";
  /** `bind: port confirm_policy`, the binding condition. */
  readonly bind: PortRelease;
  readonly carrier: string;
  /** Platform commission carved from the premium at forwarding, in bps. */
  readonly commissionBps: number;
  readonly name: string;
  readonly onCancel?: CancelPolicy;
  readonly origin: Span;
  readonly payer: string;
}

/**
 * The checked `deposit`: the held amount is a reservation on the payer's own
 * account in the holder's favor, placed as a hold, then either claimed
 * (posted to the holder) or returned (voided back to the payer). The hold
 * pairing law accounts for the full amount on both exits.
 */
export interface CheckedDeposit {
  readonly amount: MoneyField;
  readonly archetype: "deposit";
  /** Port that claims the deposit for the holder. */
  readonly claim: PortRelease;
  readonly holder: string;
  readonly name: string;
  readonly origin: Span;
  readonly payer: string;
  /** Port that returns the deposit to the payer. */
  readonly return: PortRelease;
}

/**
 * The checked `scheduled`: the total partitions into `count` installments,
 * each collected on its own stored-date anchor. The schedule is finite by
 * construction and every anchor is its own idempotent verb.
 */
export interface CheckedScheduled {
  readonly amount: MoneyField;
  readonly archetype: "scheduled";
  readonly name: string;
  readonly origin: Span;
  readonly payee: string;
  readonly payer: string;
  readonly schedule: ScheduleTerms;
}

/**
 * Where an advance's repayment comes from. `schedule` collects it from the
 * advanced party over finite anchors; `carve` takes it out of the release of a
 * hold the advanced party is already owed, so the advance never mints money it
 * is not secured by.
 */
export type AdvanceSource =
  | { readonly kind: "schedule"; readonly schedule: ScheduleTerms }
  | {
      readonly kind: "carve";
      readonly origin: Span;
      /** The held_payment settlement whose release repays this advance. */
      readonly settlement: string;
    };

/**
 * The checked `advance`: the funder disburses the advance to the advanced
 * party, who repays it from the source below. Conservation on the advance
 * itself is one partition law, the repayable total equals advance + fee, and
 * a scheduled source adds a second, that the repayments sum to it.
 */
export interface CheckedAdvance {
  readonly advanced: string;
  readonly amount: MoneyField;
  readonly archetype: "advance";
  /** The funder's discount on the advance, in bps of the advance amount. */
  readonly feeBps: number;
  readonly funder: string;
  readonly name: string;
  readonly origin: Span;
  readonly source: AdvanceSource;
}

/** One rate-card line of a metered settlement: a named meter and its unit price. */
export interface MeterRate {
  readonly field: MoneyField;
  readonly meter: string;
  readonly origin: Span;
}

/**
 * The checked `metered`: per-unit charges on a committed rate card, each
 * usage emission being the ledger transfer itself, until the period closes on
 * its stored end date. Emission matches ledger by construction because the
 * meter event and the transfer are the same admission.
 */
export interface CheckedMetered {
  readonly archetype: "metered";
  /** camelCase date field carrying the period's close date. */
  readonly closeByField: string;
  readonly name: string;
  readonly origin: Span;
  readonly payee: string;
  readonly payer: string;
  readonly rates: readonly MeterRate[];
}

/**
 * The checked `pooled_split`: one instance per payout period. The funder
 * pools the period total piece-wise (one piece per recipient share), and the
 * pool distributes to the named recipients on the stored payout date. The
 * shares sum to 100% and the integer remainder goes to `remainderTo`.
 */
export interface CheckedPooledSplit {
  readonly amount: MoneyField;
  readonly archetype: "pooled_split";
  /** camelCase date field carrying the period's payout date. */
  readonly distributeDueField: string;
  readonly name: string;
  readonly origin: Span;
  readonly payer: string;
  /** The recipient whose piece carries the integer-division remainder. */
  readonly remainderTo: string;
  readonly shares: readonly SplitShare[];
}

/** Release decided through a decision port: `release: port confirm_handover`. */
interface PortRelease {
  readonly origin: Span;
  readonly port: string;
}

export type CheckedSettlement =
  | CheckedAdvance
  | CheckedDeposit
  | CheckedHeldPayment
  | CheckedInstantTransfer
  | CheckedMetered
  | CheckedPooledSplit
  | CheckedPremiumForward
  | CheckedScheduled
  | CheckedSwap;

export type PortFieldType =
  | { readonly asset: string; readonly kind: "asset_id" }
  | { readonly currency: string; readonly kind: "money" }
  | { readonly kind: "date" }
  | { readonly kind: "text" };

export interface PortField {
  readonly name: string;
  readonly origin: Span;
  readonly type: PortFieldType;
}

/** A decision port: the typed seam where the tenant's own backend decides. */
export interface CheckedPort {
  readonly allowed: readonly string[];
  readonly fields: readonly PortField[];
  readonly name: string;
  readonly origin: Span;
}

export interface CheckedProgram {
  readonly assets: readonly CheckedAsset[];
  readonly name: string;
  readonly parties: readonly CheckedParty[];
  readonly ports: readonly CheckedPort[];
  readonly settlements: readonly CheckedSettlement[];
  readonly title: string;
}

/**
 * A semantic problem. `error` blocks lowering; `warning` is the compiler's
 * lint voice, the program is legal but the author should look.
 */
export interface CheckDiagnostic {
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly span: Span;
}

export interface CheckResult {
  readonly diagnostics: readonly CheckDiagnostic[];
  /** Present exactly when no error-severity diagnostic exists. */
  readonly program?: CheckedProgram;
}
