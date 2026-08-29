/**
 * The lowering: checked program model -> HSX-JSON IR + congruent Business
 * Frame. This is where the piece choreography the Architect used to hand-author
 * is EMITTED deterministically instead.
 *
 * Semantics fixed here, once, for every archetype:
 *
 * - Fees: a payer-side fee is a service charge ON TOP of the amount, moving
 *   payer -> platform directly and never entering custody; a payee-side fee
 *   (or a premium commission) is CARVED FROM the amount at release.
 * - Partitions: whenever an amount splits, it is partitioned into the finest
 *   common refinement of every exit, each piece its own required money field
 *   funded and debited under that exact name, the shape the independent
 *   checker's terminal-escrow analysis can prove conserving. Every partition
 *   is also declared on the noun, so create admission refuses pieces that do
 *   not sum to their total.
 * - Integer minor-unit arithmetic: each piece is floor(amount * bps / 10000);
 *   the division remainder goes to the FIRST piece unless a split names its
 *   `remainder_to` recipient.
 * - Schedules are finite by construction: a literal anchor count unrolls into
 *   one due-driven verb per anchor, each its own idempotent lifecycle step.
 * - Metered usage never accrues custody: each usage charge IS the ledger
 *   transfer, so emission and ledger cannot diverge; the period close makes
 *   further charges unreachable.
 * - Deposits are reservations: placed as a hold, then posted to the holder
 *   (claim) or voided back to the payer (return); the hold pairing law
 *   accounts for the full amount on both exits.
 *
 * The lowering never shares code with the checker that verifies its output;
 * that independence is the safety argument of the whole compiler.
 */

import type { Span } from "./ast.ts";
import { ARCHETYPE_DEFINITIONS } from "./archetypes.ts";
import type {
  CancelPolicy,
  CheckedAdvance,
  CheckedCaptureReservation,
  CheckedConditionalDisbursement,
  CheckedCreditFacility,
  CheckedDeposit,
  CheckedDerivedAmount,
  CheckedFundingRound,
  CheckedHeldPayment,
  CheckedInstantTransfer,
  CheckedMetered,
  CheckedPooledSplit,
  CheckedPort,
  CheckedPremiumForward,
  CheckedProgram,
  CheckedRecurringCollection,
  CheckedRotatingPool,
  CheckedScheduled,
  CheckedScheduledObligation,
  CheckedSettlement,
  CheckedSettlementBatch,
  CheckedSwap,
  CheckedWeightedDistribution,
  MoneyField,
  ScheduleTerms,
} from "./model.ts";
import { HSX_IR_VERSION } from "./version.ts";

type Json = Record<string, unknown>;

/**
 * The most money events one program may mint. The Business Frame contract caps
 * its moneyEvents array at the same number, and a runtime spec pins the two
 * against each other, so neither can drift alone. A repeatable schedule costs
 * one event declaration. Fee legs, cancellation legs, refunds, and forwards
 * each count when they emit their own event declaration.
 */
export const MONEY_EVENT_BUDGET = 20;

const PUBLIC_INTENT_BUDGET = 48;
const TOTAL_BPS = 10_000n;

interface LoweredPiece {
  /** Exact width of this piece in basis points of the held amount. */
  readonly bps: number;
  /** Party receiving this piece when the settlement cancels; absent without a cancel policy. */
  readonly cancelTo?: string;
  /** The required money field carrying this piece's minor-unit amount. */
  readonly field: string;
  /** Source span of the term this piece derives from (fee or split share). */
  readonly origin: Span;
  /** Party receiving this piece when the settlement releases. */
  readonly releaseTo: string;
}

interface LoweredSettlement {
  readonly name: string;
  readonly pieces: readonly LoweredPiece[];
  /** Payer-side service fee charged on top at funding, if any. */
  readonly serviceFee?: { readonly bps: number; readonly field: string };
}

export interface LoweringIssue {
  readonly message: string;
  readonly span: Span;
}

interface LoweredProgram {
  /** The HSX-JSON IR document the independent checker verifies. */
  readonly document: Json;
  /** The congruent Business Frame: one money event per settlement behavior
   * (funding stream, per-recipient release, per-party cancel, abandonment
   * refund), each covering its piece movements. */
  readonly frame: Json;
  readonly settlements: readonly LoweredSettlement[];
}

export type LowerResult =
  | { readonly issues: readonly LoweringIssue[]; readonly ok: false }
  | { readonly ok: true; readonly value: LoweredProgram };

/**
 * Split a minor-unit amount across pieces by exact basis points. Floors every
 * piece and gives the division remainder to the piece at `remainderIndex`
 * (the first by default), so the piece amounts always sum exactly.
 */
export function pieceAmounts(
  pieces: readonly { readonly bps: number }[],
  amountMinor: bigint,
  remainderIndex = 0,
): bigint[] {
  if (amountMinor < 0n) throw new Error("amount must be non-negative");
  const floors = pieces.map(
    (piece) => (amountMinor * BigInt(piece.bps)) / TOTAL_BPS,
  );
  const distributed = floors.reduce((sum, value) => sum + value, 0n);
  if (floors.length > 0) {
    const target = remainderIndex < floors.length ? remainderIndex : 0;
    floors[target] = (floors[target] as bigint) + (amountMinor - distributed);
  }
  return floors;
}

// ---------------------------------------------------------------------------
// Shared emission machinery

/** What lowering one settlement produces, merged into the program document. */
interface LoweredNoun {
  readonly design: readonly string[];
  readonly feeLines: readonly Json[];
  readonly moneyEvents: readonly Json[];
  readonly noun: Json;
  readonly extraNouns?: readonly Json[];
  readonly generatedPrefixNounIds?: readonly string[];
  readonly repeatableCounterparty?: RepeatableCounterpartyRole;
  readonly rules: readonly Json[];
  readonly settlement: LoweredSettlement;
}

export type FrameActorRole =
  | "beneficiary"
  | "guardian"
  | "holder"
  | "payer"
  | "provider";

/** One role whose account endpoint repeats within one settlement. */
export interface RepeatableCounterpartyRole {
  readonly key: string;
  readonly label: string;
  readonly maxCount: number;
  readonly minCount: number;
  readonly origin: Span;
  readonly role: FrameActorRole;
}

export type AmountDependencyExpression =
  | {
      readonly kind: "bounded_by_reference";
      readonly reference: string;
    }
  | {
      readonly kind: "net_of_offsets";
      readonly offsets: readonly string[];
      readonly source: string;
    }
  | {
      readonly bps: number;
      readonly kind: "percent_of_reference";
      readonly reference: string;
    }
  | {
      readonly consumed: readonly string[];
      readonly kind: "remainder";
      readonly source: string;
    };

interface EventAmountFields {
  readonly amountDependencies: readonly string[];
  readonly amountMode: "fixed" | "remaining_balance" | "runtime_bounded";
}

/** Lower one arithmetic dependency into the Business Frame's existing keys. */
export function lowerAmountDependency(
  expression?: AmountDependencyExpression,
): EventAmountFields {
  if (!expression) return { amountDependencies: [], amountMode: "fixed" };
  switch (expression.kind) {
    case "bounded_by_reference":
      return {
        amountDependencies: [frameKey(expression.reference)],
        amountMode: "runtime_bounded",
      };
    case "net_of_offsets": {
      if (expression.offsets.length === 0) {
        throw new Error("net_of_offsets requires at least one offset event");
      }
      const dependencies = canonicalDependencies(
        expression.source,
        expression.offsets,
      );
      return {
        amountDependencies: dependencies,
        amountMode: "runtime_bounded",
      };
    }
    case "percent_of_reference":
      if (
        !Number.isInteger(expression.bps) ||
        expression.bps <= 0 ||
        expression.bps > 10_000
      ) {
        throw new Error(
          "percent_of_reference bps must be an integer between 1 and 10000",
        );
      }
      return {
        amountDependencies: [frameKey(expression.reference)],
        amountMode: "runtime_bounded",
      };
    case "remainder": {
      if (expression.consumed.length === 0) {
        throw new Error("remainder requires at least one consumed event");
      }
      const dependencies = canonicalDependencies(
        expression.source,
        expression.consumed,
      );
      return {
        amountDependencies: dependencies,
        amountMode: "remaining_balance",
      };
    }
  }
}

function canonicalDependencies(
  source: string,
  dependents: readonly string[],
): readonly string[] {
  const all = [source, ...dependents].map(frameKey);
  if (new Set(all).size !== all.length) {
    throw new Error("amount dependency event keys must be distinct");
  }
  return all;
}

export interface EventSpec {
  readonly amount: string;
  readonly amountDependency?: AmountDependencyExpression;
  readonly fromActor: string;
  readonly key: string;
  readonly kind: string;
  readonly occurrence?: "once" | "repeatable";
  readonly timing?: "external_schedule" | "on_lifecycle";
  readonly toActor: string;
  readonly trigger: string;
}

/**
 * Frame keys carry a 40-char snake_case budget, set by the Business Frame
 * contract's key text. Composed keys include model-authored names (ports,
 * parties, meters) with no length bound of their own, so an overlong
 * composition clamps to a 33-char prefix plus a stable 6-char hash of the
 * full name. Deterministic and idempotent: equal compositions stay equal, so
 * a rule's gatesEvent keeps matching its money event's key.
 */
/**
 * Frame prose fields (headline, summary, design lines, event labels and
 * triggers, rule details, amounts) share a 160-char schema budget, and
 * their compositions embed model-authored names with no length bound of
 * their own. One walker over the assembled frame clamps every prose string
 * so the compiler can never emit a frame the platform schema rejects as an
 * internal fault. Keys are snake_case identities, not prose: they clamp
 * separately via frameKey and are never touched here.
 */
const PROSE_BUDGET = 160;
const FRAME_PROSE_FIELDS: ReadonlySet<string> = new Set([
  "amount",
  "design",
  "detail",
  "headline",
  "label",
  "summary",
  "title",
  "trigger",
  "why",
]);

function clampProseValue(value: unknown, field?: string): unknown {
  if (typeof value === "string") {
    return field !== undefined &&
      FRAME_PROSE_FIELDS.has(field) &&
      value.length > PROSE_BUDGET
      ? `${value.slice(0, PROSE_BUDGET - 3)}...`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clampProseValue(item, field));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        clampProseValue(child, key),
      ]),
    );
  }
  return value;
}

function clampFrameProse(frame: Json): Json {
  return clampProseValue(frame) as Json;
}

function frameKey(key: string): string {
  if (key.length <= 40) return key;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return `${key.slice(0, 33)}_${(hash >>> 0).toString(36).slice(0, 6)}`;
}

function dependentAmountDescription(spec: EventSpec): string {
  const expression = spec.amountDependency;
  if (!expression) return spec.amount;
  switch (expression.kind) {
    case "bounded_by_reference":
      return `Bounded by ${expression.reference}: ${spec.amount}`;
    case "net_of_offsets":
      return `Net of ${expression.source} after ${expression.offsets.join(", ")}: ${spec.amount}`;
    case "percent_of_reference":
      return `${formatBps(expression.bps)} of ${expression.reference}: ${spec.amount}`;
    case "remainder":
      return `Remainder of ${expression.source} after ${expression.consumed.join(", ")}: ${spec.amount}`;
  }
}

export function mintEvent(spec: EventSpec): Json {
  return {
    allocationTotalBps: 0,
    amount: dependentAmountDescription(spec),
    ...lowerAmountDependency(spec.amountDependency),
    amountSchedule: [],
    distribution: "single",
    fromActor: spec.fromActor,
    key: frameKey(spec.key),
    kind: spec.kind,
    label: spec.trigger,
    occurrence: spec.occurrence ?? "once",
    timing: spec.timing ?? "on_lifecycle",
    toActor: spec.toActor,
    trigger: spec.trigger,
  };
}

/** One lifecycle edge per verb, threading `from -> stem_1 -> ... -> to`. */
function chain(
  names: readonly string[],
  from: string,
  to: string,
  stateStem: string,
): readonly { readonly from: string; readonly to: string }[] {
  return names.map((_, index) => ({
    from: index === 0 ? from : `${stateStem}_${index}`,
    to: index === names.length - 1 ? to : `${stateStem}_${index + 1}`,
  }));
}

/** Refuse verb-name collisions before they silently overwrite each other. */
function verbNameIssues(
  settlementName: string,
  names: readonly string[],
  origin: Span,
  issues: LoweringIssue[],
): boolean {
  const seen = new Set<string>();
  for (const name of names) {
    if (name === "create" || seen.has(name)) {
      issues.push({
        message: `settlement ${settlementName} generates two verbs named "${name}"; rename the colliding port`,
        span: origin,
      });
      return false;
    }
    seen.add(name);
  }
  return true;
}

/**
 * The partition clauses declared on the noun: create admission proves each
 * sum exactly. Spread into the noun literal; empty when nothing partitions.
 */
function partitionClause(total: string, pieces: readonly string[]): Json[] {
  return pieces.length >= 2 ? [{ pieces: [...pieces], total }] : [];
}

function partitionsSpread(clauses: readonly Json[]): Json {
  return clauses.length > 0 ? { partitions: [...clauses] } : {};
}

function moneyFieldSpec(desc: string): Json {
  return { desc, type: "money" };
}

function dateFieldSpec(desc: string): Json {
  return { desc, type: "date" };
}

function optionalDateFieldSpec(desc: string): Json {
  return { desc, type: "date?" };
}

function derivedNounPrefix(noun: Json): string {
  if (typeof noun.prefix === "string") return noun.prefix;
  const id = noun.id as string;
  const words = id.split("_");
  const derived =
    words.length > 1 ? words.map((word) => word[0]).join("") : id.slice(0, 4);
  return derived.slice(0, 8).padEnd(2, "x");
}

function allocatedGeneratedPrefixes(
  nouns: readonly Json[],
  generatedIds: ReadonlySet<string>,
): Json[] {
  const used = new Set(
    nouns
      .filter((noun) => !generatedIds.has(noun.id as string))
      .map(derivedNounPrefix),
  );
  let ordinal = 0;
  const nextPrefix = (): string => {
    while (true) {
      const high = String.fromCharCode(97 + Math.floor(ordinal / 26));
      const low = String.fromCharCode(97 + (ordinal % 26));
      ordinal += 1;
      const candidate = `zz${high}${low}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
  return nouns.map((noun) =>
    generatedIds.has(noun.id as string)
      ? { ...noun, prefix: nextPrefix() }
      : noun,
  );
}

// ---------------------------------------------------------------------------
// The whole-program lowering

export function lowerProgram(program: CheckedProgram): LowerResult {
  const issues: LoweringIssue[] = [];
  const settlements: LoweredSettlement[] = [];
  const nouns: Json[] = [];
  const moneyEvents: Json[] = [];
  const rules: Json[] = [];
  const design: string[] = [];
  const feeLines: Json[] = [];
  const repeatableCounterparties: RepeatableCounterpartyRole[] = [];
  const generatedPrefixNounIds = new Set<string>();
  const mintedKeys = new Map<string, string>();
  const portsByName = new Map(program.ports.map((port) => [port.name, port]));

  const portFor = (
    settlement: CheckedSettlement,
    portName: string,
    origin: Span,
  ): CheckedPort | undefined => {
    const port = portsByName.get(portName);
    if (!port) {
      issues.push({
        message: `settlement ${settlement.name} decides through an unknown port; the checker should have refused this program`,
        span: origin,
      });
    }
    return port;
  };

  // `advance { against: <hold>.release }` carves the hold's release, so the
  // hold must know the funder's name before it lowers. The checker already
  // proved each target is a held payment releasing to the financed party, and
  // that no two advances draw against the same one.
  const carveFunderByHold = new Map(
    program.settlements.flatMap((settlement) =>
      settlement.archetype === "advance" && settlement.source.kind === "carve"
        ? [[settlement.source.settlement, settlement.funder] as const]
        : [],
    ),
  );
  const recoursesByAdvance = new Map(
    program.settlements.flatMap((settlement) => {
      if (
        settlement.archetype !== "advance" ||
        settlement.source.kind !== "carve"
      ) {
        return [];
      }
      const recourses = program.settlements.filter(
        (candidate): candidate is CheckedScheduled =>
          candidate.archetype === "scheduled" &&
          candidate.mode === "transfer" &&
          candidate.payer === settlement.advanced &&
          candidate.payee === settlement.funder &&
          candidate.amount.name === settlement.amount.name &&
          candidate.amount.currency === settlement.amount.currency,
      );
      return [[settlement.name, recourses] as const];
    }),
  );
  const collectionByObligation = new Map(
    program.settlements.flatMap((settlement) =>
      settlement.archetype === "recurring_collection"
        ? [[settlement.obligation.settlement, settlement] as const]
        : [],
    ),
  );

  for (const settlement of program.settlements) {
    let lowered: LoweredNoun | undefined;
    switch (settlement.archetype) {
      case "held_payment": {
        const port = portFor(
          settlement,
          settlement.release.port,
          settlement.release.origin,
        );
        if (!port) continue;
        lowered = lowerHeldPayment(
          settlement,
          port,
          carveFunderByHold.get(settlement.name),
          issues,
        );
        break;
      }
      case "captured_payment": {
        const correction = portFor(
          settlement,
          settlement.correction.port,
          settlement.correction.origin,
        );
        const externalReversal = portFor(
          settlement,
          settlement.externalReversal.port,
          settlement.externalReversal.origin,
        );
        if (!correction || !externalReversal) continue;
        lowered = lowerCaptureReservation(
          settlement,
          correction,
          externalReversal,
          issues,
        );
        break;
      }
      case "settlement_batch": {
        const acknowledgement = portFor(
          settlement,
          settlement.payoutAcknowledgement.port,
          settlement.payoutAcknowledgement.origin,
        );
        if (!acknowledgement) continue;
        lowered = lowerSettlementBatch(settlement, acknowledgement, issues);
        break;
      }
      case "funding_round":
        lowered = lowerFundingRound(settlement);
        break;
      case "weighted_distribution": {
        const snapshot = portFor(
          settlement,
          settlement.snapshot.port,
          settlement.snapshot.origin,
        );
        if (!snapshot) continue;
        lowered = lowerWeightedDistribution(settlement, snapshot);
        break;
      }
      case "credit_facility":
        lowered = lowerCreditFacility(settlement);
        break;
      case "recurring_collection":
        // The referenced scheduled obligation owns the payment nouns, amount
        // allocation, and delinquency. Its lowerer adds the explicit mandate
        // evidence gate, so this declaration mints no second noun or event.
        continue;
      case "conditional_disbursement": {
        const decision = portFor(
          settlement,
          settlement.decision.port,
          settlement.decision.origin,
        );
        if (!decision) continue;
        lowered = lowerConditionalDisbursement(settlement, decision);
        break;
      }
      case "rotating_pool":
        lowered = lowerRotatingPool(settlement);
        break;
      case "premium_forward": {
        const port = portFor(
          settlement,
          settlement.bind.port,
          settlement.bind.origin,
        );
        const endorsement = settlement.endorsement
          ? portFor(
              settlement,
              settlement.endorsement.port,
              settlement.endorsement.origin,
            )
          : undefined;
        if (!port || (settlement.endorsement && !endorsement)) continue;
        lowered = lowerPremiumForward(settlement, port, endorsement, issues);
        break;
      }
      case "deposit": {
        const claim = portFor(
          settlement,
          settlement.claim.port,
          settlement.claim.origin,
        );
        const giveBack = portFor(
          settlement,
          settlement.return.port,
          settlement.return.origin,
        );
        if (!claim || !giveBack) continue;
        lowered = lowerDeposit(settlement, claim, giveBack, issues);
        break;
      }
      case "instant_transfer":
        lowered = lowerInstantTransfer(settlement);
        break;
      case "scheduled":
        lowered =
          settlement.mode === "obligation"
            ? lowerScheduledObligation(
                settlement,
                collectionByObligation.get(settlement.name),
                collectionByObligation.has(settlement.name)
                  ? portFor(
                      collectionByObligation.get(settlement.name)!,
                      collectionByObligation.get(settlement.name)!.mandate.port,
                      collectionByObligation.get(settlement.name)!.mandate
                        .origin,
                    )
                  : undefined,
              )
            : lowerScheduled(settlement);
        break;
      case "advance":
        lowered = lowerAdvance(
          settlement,
          recoursesByAdvance.get(settlement.name) ?? [],
        );
        break;
      case "metered":
        lowered = lowerMetered(settlement);
        break;
      case "pooled_split":
        lowered = lowerPooledSplit(settlement);
        break;
      case "swap": {
        const release = portFor(
          settlement,
          settlement.release.port,
          settlement.release.origin,
        );
        const dispute = settlement.dispute
          ? portFor(
              settlement,
              settlement.dispute.port,
              settlement.dispute.origin,
            )
          : undefined;
        if (!release || (settlement.dispute && !dispute)) continue;
        lowered = lowerSwap(settlement, release, dispute);
        break;
      }
    }
    if (!lowered) continue;
    const derivedAmounts = (program.derivedAmounts ?? []).filter(
      (amount) => amount.settlement === settlement.name,
    );
    if (derivedAmounts.length > 0) {
      lowered = addDerivedAmounts(lowered, settlement, derivedAmounts, issues);
      if (!lowered) continue;
    }
    const localCap =
      ARCHETYPE_DEFINITIONS[settlement.archetype].eventCap +
      derivedAmounts.length;
    if (lowered.moneyEvents.length > localCap) {
      issues.push({
        message: `settlement ${settlement.name} emits ${lowered.moneyEvents.length} money events, but ${settlement.archetype} carries a local cap of ${localCap}`,
        span: settlement.origin,
      });
      continue;
    }
    // Event and rule keys concatenate settlement names with generated stems,
    // so two settlements can mint the same key (a + b_service_fee vs a_b +
    // service_fee). The frame schema refuses duplicates wholesale, which
    // would surface as an internal fault; refuse here at the source instead.
    for (const minted of [...lowered.moneyEvents, ...lowered.rules]) {
      const key = minted.key as string;
      const owner = mintedKeys.get(key);
      if (owner) {
        issues.push({
          message: `settlements ${owner} and ${settlement.name} both generate the internal key ${key}; rename one settlement (or its port or meter) so the generated keys stay distinct`,
          span: settlement.origin,
        });
      }
      mintedKeys.set(key, settlement.name);
    }
    settlements.push(lowered.settlement);
    const loweredNouns = [lowered.noun, ...(lowered.extraNouns ?? [])];
    for (const noun of loweredNouns) {
      const verbs = noun.verbs as Record<string, Json>;
      for (const [verbName, verb] of Object.entries(verbs)) {
        if (
          Object.hasOwn(verb, "due") ||
          Object.hasOwn(verb, "requiresSettlement")
        ) {
          continue;
        }
        const publicIntent = callerDrivenPublicIntent(
          noun.id as string,
          verbName,
        );
        if (publicIntent.length <= PUBLIC_INTENT_BUDGET) continue;
        issues.push({
          message: `settlement ${settlement.name} generates public intent "${publicIntent}" with ${publicIntent.length} characters; rename the settlement so each public intent fits the ${PUBLIC_INTENT_BUDGET}-character camelName limit`,
          span: settlement.origin,
        });
      }
    }
    nouns.push(...loweredNouns);
    for (const nounId of lowered.generatedPrefixNounIds ?? []) {
      generatedPrefixNounIds.add(nounId);
    }
    moneyEvents.push(...lowered.moneyEvents);
    rules.push(...lowered.rules);
    design.push(...lowered.design);
    feeLines.push(...lowered.feeLines);
    if (lowered.repeatableCounterparty) {
      repeatableCounterparties.push(lowered.repeatableCounterparty);
    }
  }

  if (moneyEvents.length > MONEY_EVENT_BUDGET) {
    issues.push({
      message: `this program needs ${moneyEvents.length} money events but a Business Frame carries at most ${MONEY_EVENT_BUDGET}; simplify the fee or cancellation terms, or drop a settlement`,
      span: program.settlements[0]?.origin ?? { end: 0, start: 0 },
    });
  }
  issues.push(
    ...validateAmountDependencyGraph(
      moneyEvents,
      program.settlements[0]?.origin ?? { end: 0, start: 0 },
    ),
  );
  const actorLowering = lowerFrameActors(program, repeatableCounterparties);
  issues.push(...actorLowering.issues);
  if (issues.length > 0) return { issues, ok: false };

  const publishedNouns = publishCallerDrivenVerbs(
    allocatedGeneratedPrefixes(nouns, generatedPrefixNounIds),
  );

  const subjects = program.assets.map((asset) => ({
    kind: asset.name,
    title: titleize(asset.name),
    value: "optional",
  }));

  const document: Json = {
    hsx: HSX_IR_VERSION,
    nouns: publishedNouns,
    product: program.name,
    ...(subjects.length > 0 ? { subjects } : {}),
    title: program.title,
  };

  const frame: Json = {
    actors: actorLowering.actors,
    confidence: "high",
    conservationGroups: [],
    design,
    feePolicy: feeLines.length > 0 ? "defined" : "none",
    fees: feeLines,
    headline: program.title,
    mechanics: mechanicsOf(program.settlements),
    moneyEvents,
    offPlatform: program.assets
      .filter((asset) => asset.titleTransfer === "off_platform")
      .map((asset) => ({
        label: `${titleize(asset.name)} title transfer`,
        why: `Ownership of the ${asset.name.replaceAll("_", " ")} changes hands outside the platform`,
      })),
    openQuestions: [],
    rules,
    subjects: program.assets.map((asset) => ({
      kind: asset.name,
      title: titleize(asset.name),
    })),
    summary: summarize(program),
  };

  return {
    ok: true,
    value: { document, frame: clampFrameProse(frame), settlements },
  };
}

function publishCallerDrivenVerbs(nouns: readonly Json[]): Json[] {
  return nouns.map((noun) => {
    const verbs = noun.verbs as Record<string, Json>;
    return {
      ...noun,
      verbs: Object.fromEntries(
        Object.entries(verbs).map(([verbName, verb]) => [
          verbName,
          Object.hasOwn(verb, "due") ||
          Object.hasOwn(verb, "requiresSettlement")
            ? verb
            : {
                ...verb,
                publicIntent: callerDrivenPublicIntent(
                  noun.id as string,
                  verbName,
                ),
              },
        ]),
      ),
    };
  });
}

function callerDrivenPublicIntent(nounId: string, verbName: string): string {
  const nounName = camelize(nounId);
  const domainName = nounName.charAt(0).toUpperCase() + nounName.slice(1);
  return `${camelize(verbName)}${domainName}`;
}

/** Add generic on-top amounts after archetype lowering, so no brick owns fee syntax. */
function addDerivedAmounts(
  lowered: LoweredNoun,
  settlement: CheckedSettlement,
  amounts: readonly CheckedDerivedAmount[],
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const noun = lowered.noun;
  const fields = { ...((noun.fields as Json | undefined) ?? {}) };
  const verbs = { ...((noun.verbs as Json | undefined) ?? {}) };
  const create = { ...((verbs.create as Json | undefined) ?? {}) };
  const moves = [...((create.moves as Json[] | undefined) ?? [])];
  const actors = { ...((noun.actors as Json | undefined) ?? {}) };
  const derived: Json[] = [];
  const events = [...lowered.moneyEvents];
  const lines = [...lowered.feeLines];
  for (const amount of amounts) {
    const sourceField = fields[amount.baseField] as Json | undefined;
    if (sourceField === undefined || sourceField.type !== "money") {
      issues.push({
        message: `settlement ${settlement.name} derives ${amount.field} from ${sourceField === undefined ? "unknown " : "non-money "}field ${amount.baseField}; from must name a stored money field on the settlement owner`,
        span: amount.origin,
      });
      return undefined;
    }
    if (fields[amount.field] !== undefined) {
      issues.push({
        message: `settlement ${settlement.name} derives into existing field ${amount.field}; choose a new derived amount field`,
        span: amount.origin,
      });
      return undefined;
    }
    const eventKey = frameKey(`${settlement.name}_derived_amount`);
    fields[amount.field] = moneyFieldSpec(
      `Machine-computed ${formatBps(amount.bps)} of ${amount.baseField}; callers never supply it`,
    );
    if (actors[amount.bearer] === undefined) {
      actors[amount.bearer] = "payer";
    }
    actors.platform = "beneficiary";
    derived.push({
      field: amount.field,
      rounding: "floor",
      rule: { bps: amount.bps, kind: "percentage_of" },
      sourceField: amount.baseField,
    });
    moves.push({
      amount: amount.field,
      from: amount.bearer,
      key: "derived_amount",
      moneyEvent: eventKey,
      operation: "create",
      to: "platform",
    });
    events.push(
      mintEvent({
        amount: `The machine-computed ${amount.field}`,
        fromActor: amount.bearer,
        key: eventKey,
        kind: "charge",
        toActor: "platform",
        trigger: `Collect ${amount.field} with settlement creation`,
      }),
    );
    lines.push({
      label: titleize(amount.field),
      on: `each ${settlement.name.replaceAll("_", " ")}`,
      structure: `${formatBps(amount.bps)} of stored ${amount.baseField}, computed by the runtime`,
    });
  }
  create.moves = moves;
  verbs.create = create;
  return {
    ...lowered,
    design: [
      ...lowered.design,
      `${settlement.name}: derived amounts are machine-computed from stored source fields before create movements; fixed and tiered rules are refused`,
    ],
    feeLines: lines,
    moneyEvents: events,
    noun: {
      ...noun,
      actors,
      derivedAmounts: derived,
      fields,
      verbs,
    },
  };
}

/** Lower fixed parties plus future settlement-declared repeating roles. */
export interface FrameActorLoweringResult {
  readonly actors: readonly Record<string, unknown>[];
  readonly issues: readonly LoweringIssue[];
}

export function lowerFrameActors(
  program: Pick<CheckedProgram, "parties" | "settlements">,
  repeatableCounterparties: readonly RepeatableCounterpartyRole[] = [],
): FrameActorLoweringResult {
  const roles = partyRoles(program.settlements);
  const parties = new Set(program.parties.map((party) => party.name));
  const overrides = new Map<string, RepeatableCounterpartyRole>();
  const issues: LoweringIssue[] = [];
  for (const counterparty of repeatableCounterparties) {
    if (!parties.has(counterparty.key)) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} is not a declared party`,
        span: counterparty.origin,
      });
      continue;
    }
    const fixedRole = roles.get(counterparty.key);
    if (!fixedRole) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} is not used by any settlement`,
        span: counterparty.origin,
      });
      continue;
    }
    if (fixedRole !== counterparty.role) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} declares role ${counterparty.role}, but its settlement uses role ${fixedRole}`,
        span: counterparty.origin,
      });
      continue;
    }
    if (
      counterparty.label.trim().length === 0 ||
      counterparty.label.length > 160
    ) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} label must contain 1 through 160 characters`,
        span: counterparty.origin,
      });
      continue;
    }
    if (
      !Number.isInteger(counterparty.minCount) ||
      !Number.isInteger(counterparty.maxCount) ||
      counterparty.minCount < 1 ||
      counterparty.maxCount > 10_000
    ) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} counts must be integers from 1 through 10000`,
        span: counterparty.origin,
      });
      continue;
    }
    if (counterparty.minCount > counterparty.maxCount) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} has minCount ${counterparty.minCount} above maxCount ${counterparty.maxCount}`,
        span: counterparty.origin,
      });
      continue;
    }
    if (overrides.has(counterparty.key)) {
      issues.push({
        message: `repeatable counterparty ${counterparty.key} is declared twice`,
        span: counterparty.origin,
      });
      continue;
    }
    overrides.set(counterparty.key, counterparty);
  }
  const actors = [
    ...program.parties
      .filter((party) => roles.has(party.name))
      .map((party) => {
        const override = overrides.get(party.name);
        return override
          ? {
              key: override.key,
              label: override.label,
              maxCount: override.maxCount,
              minCount: override.minCount,
              role: override.role,
            }
          : {
              key: party.name,
              label: titleize(party.name),
              maxCount: 1,
              minCount: 1,
              role: roles.get(party.name),
            };
      }),
    {
      key: "platform",
      label: "Platform",
      maxCount: 1,
      minCount: 1,
      role: "platform",
    },
  ];
  return { actors, issues };
}

/** Validate the completed event graph before HSX returns a frame. */
export function validateAmountDependencyGraph(
  events: readonly Record<string, unknown>[],
  origin: Span,
): readonly LoweringIssue[] {
  const issues: LoweringIssue[] = [];
  const dependenciesByKey = new Map<string, readonly string[]>();
  for (const event of events) {
    if (typeof event.key !== "string") continue;
    const dependencies = Array.isArray(event.amountDependencies)
      ? event.amountDependencies.filter(
          (dependency): dependency is string => typeof dependency === "string",
        )
      : [];
    dependenciesByKey.set(event.key, dependencies);
  }
  for (const [key, dependencies] of dependenciesByKey) {
    for (const dependency of dependencies) {
      if (dependency === key) {
        issues.push({
          message: `money event ${key} cannot depend on itself`,
          span: origin,
        });
        continue;
      }
      if (!dependenciesByKey.has(dependency)) {
        issues.push({
          message: `money event ${key} depends on missing money event ${dependency}`,
          span: origin,
        });
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key) || cyclic.has(key)) return;
    if (visiting.has(key)) {
      cyclic.add(key);
      return;
    }
    visiting.add(key);
    for (const dependency of dependenciesByKey.get(key) ?? []) {
      if (dependenciesByKey.has(dependency)) visit(dependency);
      if (cyclic.has(dependency)) cyclic.add(key);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of dependenciesByKey.keys()) visit(key);
  if (cyclic.size > 0) {
    issues.push({
      message: `money event amount dependencies contain a cycle through ${[...cyclic].sort().join(", ")}`,
      span: origin,
    });
  }
  return issues;
}

/** Frame actor role per party, with a fixed precedence when roles overlap. */
function partyRoles(
  settlements: readonly CheckedSettlement[],
): Map<string, string> {
  const payers = new Set<string>();
  const beneficiaries = new Set<string>();
  const providers = new Set<string>();
  const holders = new Set<string>();
  for (const settlement of settlements) {
    switch (settlement.archetype) {
      case "held_payment":
      case "captured_payment":
      case "instant_transfer":
      case "metered":
        payers.add(settlement.payer);
        beneficiaries.add(settlement.payee);
        break;
      case "scheduled":
        payers.add(settlement.payer);
        beneficiaries.add(settlement.payee);
        if (settlement.mode === "obligation") {
          payers.add(settlement.debtor);
          if (settlement.advanceTo) beneficiaries.add(settlement.advanceTo);
        }
        break;
      case "premium_forward":
        payers.add(settlement.payer);
        providers.add(settlement.carrier);
        break;
      case "deposit":
        payers.add(settlement.payer);
        holders.add(settlement.holder);
        break;
      case "advance":
        payers.add(settlement.funder);
        beneficiaries.add(settlement.advanced);
        break;
      case "pooled_split":
        payers.add(settlement.payer);
        for (const share of settlement.shares) beneficiaries.add(share.to);
        break;
      case "settlement_batch":
        payers.add(settlement.settlementAccount);
        beneficiaries.add(settlement.payoutDestination);
        break;
      case "funding_round":
        payers.add(settlement.contributor);
        beneficiaries.add(settlement.beneficiary);
        break;
      case "weighted_distribution":
        payers.add(settlement.source);
        beneficiaries.add(settlement.recipient);
        break;
      case "credit_facility":
        payers.add(settlement.lender);
        beneficiaries.add(settlement.borrower);
        beneficiaries.add(settlement.drawDestination);
        break;
      case "recurring_collection":
        break;
      case "conditional_disbursement":
        payers.add(settlement.source);
        beneficiaries.add(settlement.destination);
        break;
      case "rotating_pool":
        for (const member of settlement.members) {
          payers.add(member);
          beneficiaries.add(member);
        }
        if (settlement.guarantor) payers.add(settlement.guarantor);
        break;
      case "swap":
        payers.add(settlement.sides[0].party);
        beneficiaries.add(settlement.sides[1].party);
        break;
    }
  }
  const roles = new Map<string, string>();
  const assign = (names: ReadonlySet<string>, role: string): void => {
    for (const name of names) if (!roles.has(name)) roles.set(name, role);
  };
  assign(payers, "payer");
  assign(providers, "provider");
  assign(holders, "holder");
  assign(beneficiaries, "beneficiary");
  return roles;
}

const ARCHETYPE_MECHANICS: Record<CheckedSettlement["archetype"], string> = {
  advance: "credit",
  captured_payment: "escrow",
  conditional_disbursement: "marketplace",
  credit_facility: "credit",
  deposit: "escrow",
  funding_round: "credit",
  held_payment: "escrow",
  instant_transfer: "marketplace",
  metered: "recurring_billing",
  pooled_split: "marketplace",
  premium_forward: "insurance",
  recurring_collection: "recurring_billing",
  rotating_pool: "recurring_billing",
  scheduled: "recurring_billing",
  settlement_batch: "marketplace",
  swap: "escrow",
  weighted_distribution: "marketplace",
};

function mechanicsOf(settlements: readonly CheckedSettlement[]): string[] {
  const mechanics = new Set(
    settlements.map((settlement) =>
      settlement.archetype === "scheduled" && settlement.mode === "obligation"
        ? "credit"
        : ARCHETYPE_MECHANICS[settlement.archetype],
    ),
  );
  return mechanics.size > 0 ? [...mechanics] : ["escrow"];
}

// ---------------------------------------------------------------------------
// swap: strict two-party, two-leg atomic custody

function lowerSwap(
  settlement: CheckedSwap,
  releasePort: CheckedPort,
  disputePort: CheckedPort | undefined,
): LoweredNoun {
  const noun = settlement.name;
  const [sideA, sideB] = settlement.sides;
  const window = settlement.dispute?.window;
  const hasClawback = window !== undefined && window.days > 0;
  const postRuleKey = frameKey(`${noun}_clawback_maturity`);
  const events: Json[] = [];
  const event = (
    stem: string,
    kind: string,
    amount: string,
    fromActor: string,
    toActor: string,
    trigger: string,
  ): string => {
    const key = frameKey(`${noun}_${stem}`);
    events.push(mintEvent({ amount, fromActor, key, kind, toActor, trigger }));
    return key;
  };

  const sideAFundEvent = event(
    "side_a_fund",
    "charge",
    `The full ${sideA.amount.name}`,
    sideA.party,
    "escrow",
    `Fund ${sideA.amount.name} into the shared trade escrow`,
  );
  const sideBFundEvent = event(
    "side_b_fund",
    "charge",
    `The full ${sideB.amount.name}`,
    sideB.party,
    "escrow",
    `Fund ${sideB.amount.name} into the shared trade escrow`,
  );
  const sideAReleaseEvent = event(
    "side_a_release",
    "payout",
    `The full ${sideA.amount.name}`,
    "escrow",
    sideB.party,
    `Release ${sideA.amount.name} across to ${sideB.party.replaceAll("_", " ")}`,
  );
  const sideBReleaseEvent = event(
    "side_b_release",
    "payout",
    `The full ${sideB.amount.name}`,
    "escrow",
    sideA.party,
    `Release ${sideB.amount.name} across to ${sideA.party.replaceAll("_", " ")}`,
  );
  const sideACancelEvent = event(
    "side_a_cancel",
    "refund",
    `The full ${sideA.amount.name}`,
    "escrow",
    sideA.party,
    `Return ${sideA.amount.name} to its original funder on cancellation`,
  );
  const sideBCancelEvent = event(
    "side_b_cancel",
    "refund",
    `The full ${sideB.amount.name}`,
    "escrow",
    sideB.party,
    `Return ${sideB.amount.name} to its original funder on cancellation`,
  );
  const sideAClawbackEvent = hasClawback
    ? event(
        "side_a_clawback",
        "refund",
        `The full ${sideA.amount.name}`,
        "escrow",
        sideA.party,
        `Return ${sideA.amount.name} after the whole trade is disputed`,
      )
    : undefined;
  const sideBClawbackEvent = hasClawback
    ? event(
        "side_b_clawback",
        "refund",
        `The full ${sideB.amount.name}`,
        "escrow",
        sideB.party,
        `Return ${sideB.amount.name} after the whole trade is disputed`,
      )
    : undefined;

  const fields: Json = {
    [sideA.amount.name]: moneyFieldSpec(
      `Side A amount in ${sideA.amount.currency} minor units, held against the whole trade`,
    ),
    [sideB.amount.name]: moneyFieldSpec(
      `Side B amount in ${sideB.amount.currency} minor units, held against the whole trade`,
    ),
    ...(hasClawback
      ? {
          clawbackAt: {
            type: "date?",
            desc: `Machine-owned end of the ${window?.raw ?? "fixed"} whole-trade dispute window`,
          },
        }
      : {}),
  };
  const fundMoves: Json[] = [
    {
      amount: sideA.amount.name,
      from: sideA.party,
      key: "side_a_principal",
      moneyEvent: sideAFundEvent,
      operation: "create",
      to: "escrow",
    },
    {
      amount: sideB.amount.name,
      from: sideB.party,
      key: "side_b_principal",
      moneyEvent: sideBFundEvent,
      operation: "create",
      to: "escrow",
    },
  ];
  const feeLines: Json[] = [];
  for (const [index, side] of settlement.sides.entries()) {
    if (!side.fee) continue;
    const field = side.fee.amount.name;
    fields[field] = moneyFieldSpec(
      `Exact ${side.party.replaceAll("_", " ")} service fee in ${side.fee.amount.currency} minor units, charged on top and never held`,
    );
    const feeEvent = event(
      index === 0 ? "side_a_service_fee" : "side_b_service_fee",
      "charge",
      `The exact ${field}, on top`,
      side.party,
      "platform",
      `Collect the ${side.party.replaceAll("_", " ")} custody fee at funding`,
    );
    fundMoves.push({
      amount: field,
      from: side.party,
      key: index === 0 ? "side_a_service_fee" : "side_b_service_fee",
      moneyEvent: feeEvent,
      operation: "create",
      to: "platform",
    });
    feeLines.push({
      label: `${titleize(side.party)} custody fee`,
      on: `each funded ${noun.replaceAll("_", " ")}`,
      structure: `Exact ${field}, on top`,
    });
  }

  const releaseMoves: Json[] = [
    {
      amount: sideA.amount.name,
      from: "escrow",
      key: "side_a",
      moneyEvent: sideAReleaseEvent,
      operation: hasClawback ? "reserve" : "create",
      to: sideB.party,
    },
    {
      amount: sideB.amount.name,
      from: "escrow",
      key: "side_b",
      moneyEvent: sideBReleaseEvent,
      operation: hasClawback ? "reserve" : "create",
      to: sideA.party,
    },
  ];
  const verbs: Json = {
    abandon: {
      from: ["created"],
      requiresDrainedAccount: { path: "refs.escrowAccountId" },
      summary: "Abandon the trade before its atomic funding batch",
      to: "abandoned",
    },
    cancel: {
      from: ["funded"],
      moves: [
        {
          amount: sideA.amount.name,
          from: "escrow",
          key: "side_a_refund",
          moneyEvent: sideACancelEvent,
          operation: "create",
          to: sideA.party,
        },
        {
          amount: sideB.amount.name,
          from: "escrow",
          key: "side_b_refund",
          moneyEvent: sideBCancelEvent,
          operation: "create",
          to: sideB.party,
        },
      ],
      summary: "Cancel and return both trade principals atomically",
      to: "cancelled",
    },
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()} atomic trade`,
      to: "created",
    },
    fund: {
      from: ["created"],
      moves: fundMoves,
      summary: "Fund both trade sides and collect on-top fees atomically",
      to: "funded",
    },
    release: {
      from: ["funded"],
      moves: releaseMoves,
      port: { allowed: [...releasePort.allowed] },
      ...(hasClawback
        ? { setsAt: { field: "clawbackAt", offset: window?.raw } }
        : {}),
      summary: hasClawback
        ? "Reserve both cross-payments for the whole-trade clawback window"
        : "Post both cross-payments atomically",
      to: hasClawback ? "released" : "settled",
    },
  };

  if (
    hasClawback &&
    settlement.dispute &&
    disputePort &&
    sideAClawbackEvent &&
    sideBClawbackEvent
  ) {
    verbs.post = {
      due: { field: "clawbackAt", rule: postRuleKey },
      from: ["released"],
      moves: [
        { key: "side_a", operation: "post", reservation: "release_side_a" },
        { key: "side_b", operation: "post", reservation: "release_side_b" },
      ],
      summary: "Post both trade reservations when the clawback window matures",
      to: "settled",
    };
    verbs.dispute = {
      deadline: { field: "clawbackAt" },
      from: ["released"],
      moves: [
        {
          key: "side_a_void",
          operation: "void",
          reason: "Whole trade disputed inside the clawback window",
          reservation: "release_side_a",
        },
        {
          key: "side_b_void",
          operation: "void",
          reason: "Whole trade disputed inside the clawback window",
          reservation: "release_side_b",
        },
        {
          amount: sideA.amount.name,
          clawbackOf: "release_side_a",
          from: "escrow",
          key: "side_a_refund",
          moneyEvent: sideAClawbackEvent,
          operation: "create",
          to: sideA.party,
        },
        {
          amount: sideB.amount.name,
          clawbackOf: "release_side_b",
          from: "escrow",
          key: "side_b_refund",
          moneyEvent: sideBClawbackEvent,
          operation: "create",
          to: sideB.party,
        },
      ],
      port: { allowed: [...disputePort.allowed] },
      summary: "Void both reservations, then refund both principals atomically",
      to: "clawed_back",
    };
  }

  const rules: Json[] = [
    {
      allowedActors: [...releasePort.allowed],
      detail: `${releasePort.allowed.map(titleize).join(" or ")} confirms the whole exchange through ${releasePort.name}`,
      dueDriven: false,
      enforcement: "tenant_app",
      gatesEvent: sideAReleaseEvent,
      key: frameKey(`${noun}_${releasePort.name}_gate`),
      kind: "release_condition",
      label: `Whole trade released through ${releasePort.name}`,
      tenantTunable: false,
    },
  ];
  if (hasClawback && settlement.dispute && disputePort) {
    rules.push(
      {
        allowedActors: [],
        detail: `Both pending trade payouts post together at the immutable ${settlement.dispute.window.raw} cutoff`,
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: postRuleKey,
        kind: "deadline",
        label: "Whole trade posts when its clawback window matures",
        tenantTunable: false,
      },
      {
        allowedActors: [...disputePort.allowed],
        detail: `${disputePort.allowed.map(titleize).join(" or ")} may dispute only before the immutable cutoff`,
        dueDriven: false,
        enforcement: "tenant_app",
        gatesEvent: sideAClawbackEvent ?? null,
        key: frameKey(`${noun}_${disputePort.name}_gate`),
        kind: "release_condition",
        label: `Whole trade disputed through ${disputePort.name}`,
        tenantTunable: false,
      },
    );
  }

  return {
    design: [
      `${noun}: exactly two parties, two same-currency principals, one escrow, and one linked batch per phase`,
      hasClawback
        ? `${noun}: ${window?.raw} whole-trade clawback; release reserves both legs, then exactly one grouped post or grouped void-and-refund wins`
        : `${noun}: no clawback window; release posts both legs directly and exposes no pending or dispute surface`,
    ],
    feeLines,
    moneyEvents: events,
    noun: {
      actors: {
        [sideA.party]: "payer",
        [sideB.party]: "beneficiary",
        ...(feeLines.length > 0 ? { platform: "party" } : {}),
      },
      desc: `Atomic swap between ${sideA.party.replaceAll("_", " ")} and ${sideB.party.replaceAll("_", " ")}; half-funded and half-released states do not exist`,
      distinctParties: true,
      escrow: true,
      fields,
      id: noun,
      summary: `Two-party atomic trade between ${sideA.party.replaceAll("_", " ")} and ${sideB.party.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules,
    settlement: {
      name: noun,
      pieces: [
        {
          bps: 10_000,
          cancelTo: sideA.party,
          field: sideA.amount.name,
          origin: sideA.amount.origin,
          releaseTo: sideB.party,
        },
        {
          bps: 10_000,
          cancelTo: sideB.party,
          field: sideB.amount.name,
          origin: sideB.amount.origin,
          releaseTo: sideA.party,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// held_payment and premium_forward: the escrow-held family

function lowerHeldPayment(
  settlement: CheckedHeldPayment,
  port: CheckedPort,
  /** The funder of the advance carving this hold's release, when one does. */
  carveTo: string | undefined,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const payerFee = settlement.fees.find(
    (fee) => fee.bearer === settlement.payer,
  );
  const payeeFee = settlement.fees.find(
    (fee) => fee.bearer === settlement.payee,
  );
  const held = lowerHeldFamily(
    {
      amount: settlement.amount,
      carveTo,
      deadlineField: settlement.releaseDeadlineField,
      fundEventKind: "charge",
      fundTrigger: (index, total) =>
        `Fund piece ${index + 1} of ${total} into escrow`,
      name: settlement.name,
      onCancel: settlement.onCancel,
      payee: settlement.payee,
      payeeFeeBps: payeeFee?.bps ?? 0,
      payer: settlement.payer,
      payerFeeBps: payerFee?.bps,
      port,
      releaseWord: "release",
    },
    issues,
  );
  if (!held) return undefined;
  return {
    ...held,
    feeLines: [
      ...(payerFee
        ? [
            {
              label: `${titleize(settlement.payer)} service fee`,
              on: `each funded ${settlement.name.replaceAll("_", " ")}`,
              structure: `${formatBps(payerFee.bps)} of the ${settlement.amount.name}, on top`,
            },
          ]
        : []),
      ...(payeeFee
        ? [
            {
              label: `${titleize(settlement.payee)} fee`,
              on: `each released ${settlement.name.replaceAll("_", " ")}`,
              structure: `${formatBps(payeeFee.bps)} of the ${settlement.amount.name}, deducted from the payout`,
            },
          ]
        : []),
    ],
    noun: {
      ...held.noun,
      desc: `Held payment: the ${settlement.payer.replaceAll("_", " ")} funds ${settlement.amount.name} into this settlement's own escrow; ${port.allowed
        .map((party) => party.replaceAll("_", " "))
        .join(
          " or ",
        )} confirms through ${port.name} to release${carveTo ? ` to the ${carveTo.replaceAll("_", " ")}, whose advance the ${settlement.payee.replaceAll("_", " ")} repays out of it` : ""}`,
      summary: `Escrow-held payment from ${settlement.payer.replaceAll("_", " ")} to ${settlement.payee.replaceAll("_", " ")}`,
    },
  };
}

function lowerPremiumForward(
  settlement: CheckedPremiumForward,
  port: CheckedPort,
  endorsement: CheckedPort | undefined,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const held = lowerHeldFamily(
    {
      amount: settlement.amount,
      // A premium is the carrier's, never the payer's receivable, so there is
      // nothing here for an advance to draw against.
      carveTo: undefined,
      deadlineField: undefined,
      fundEventKind: "premium",
      fundTrigger: (index, total) =>
        total === 1
          ? "Collect the premium into escrow"
          : `Collect premium piece ${index + 1} of ${total} into escrow`,
      name: settlement.name,
      onCancel: settlement.onCancel,
      payee: settlement.carrier,
      payeeFeeBps: settlement.commissionBps,
      payer: settlement.payer,
      payerFeeBps: undefined,
      port,
      releaseWord: "forward",
    },
    issues,
  );
  if (!held) return undefined;
  const baseNoun = held.noun;
  const fields = { ...((baseNoun.fields as Json | undefined) ?? {}) };
  const verbs = { ...((baseNoun.verbs as Json | undefined) ?? {}) };
  const rules = [...held.rules];
  if (
    settlement.policyReferenceField &&
    settlement.renewalDueField &&
    settlement.endorsement &&
    endorsement
  ) {
    fields[settlement.policyReferenceField] = {
      desc: "Immutable external policy reference recorded with this forward",
      type: "text",
    };
    fields[settlement.renewalDueField] = dateFieldSpec(
      "Stored renewal due condition for the forwarded policy",
    );
    verbs[settlement.endorsement.port] = {
      captureInput: { endorsementEvidenceReference: "evidenceReference" },
      from: ["released"],
      port: {
        allowed: endorsement.allowed,
        fields: { evidenceReference: "text" },
      },
      summary: "Record one non-money endorsement from external evidence",
      to: "endorsed",
    };
    const lapseRule = frameKey(`${settlement.name}_renewal_due`);
    verbs.lapse = {
      due: { field: settlement.renewalDueField, rule: lapseRule },
      from: ["released", "endorsed"],
      requiresDrainedAccount: { path: "refs.escrowAccountId" },
      summary:
        "Mark the forwarded policy lapsed at its stored renewal due condition",
      to: "lapsed",
    };
    rules.push({
      allowedActors: [],
      detail:
        "The stored renewal due condition changes policy state without moving money",
      dueDriven: true,
      enforcement: "platform",
      gatesEvent: null,
      key: lapseRule,
      kind: "deadline",
      label: "Policy lapses at its stored renewal due condition",
      tenantTunable: false,
    });
  }
  return {
    ...held,
    design: [
      `${settlement.name}: premium forwards to the ${settlement.carrier.replaceAll("_", " ")} exactly once on ${port.name}; ${formatBps(settlement.commissionBps)} commission retained by the platform`,
      ...(settlement.policyReferenceField
        ? [
            `${settlement.name}: extends premium_forward with stored policy reference, non-money endorsement evidence, and a due-only lapse; renewal creates a new forward`,
          ]
        : []),
    ],
    feeLines:
      settlement.commissionBps > 0
        ? [
            {
              label: "Platform commission",
              on: `each bound ${settlement.name.replaceAll("_", " ")}`,
              structure: `${formatBps(settlement.commissionBps)} of the ${settlement.amount.name}, deducted at forwarding`,
            },
          ]
        : [],
    noun: {
      ...held.noun,
      fields,
      verbs,
      desc: `Premium forward: the ${settlement.payer.replaceAll("_", " ")} funds the ${settlement.amount.name} into this settlement's own escrow; binding through ${port.name} forwards it to the ${settlement.carrier.replaceAll("_", " ")} exactly once, minus the platform commission`,
      summary: `Premium held for the ${settlement.carrier.replaceAll("_", " ")} until the policy binds`,
    },
    rules,
  };
}

interface HeldFamilyParams {
  readonly amount: MoneyField;
  /**
   * When an advance carves this hold, the funder the payee's release share
   * goes to instead. The payee stays the beneficiary, it is their money the
   * carve assigns, but no piece of the release reaches them directly.
   */
  readonly carveTo: string | undefined;
  /** `at(<field>)`: the stored date an undecided hold releases on. */
  readonly deadlineField: string | undefined;
  readonly fundEventKind: string;
  readonly fundTrigger: (index: number, total: number) => string;
  readonly name: string;
  readonly onCancel: CancelPolicy | undefined;
  readonly payee: string;
  readonly payeeFeeBps: number;
  readonly payer: string;
  readonly payerFeeBps: number | undefined;
  readonly port: CheckedPort;
  readonly releaseWord: string;
}

function lowerHeldFamily(
  params: HeldFamilyParams,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const amountName = params.amount.name;
  // A single-piece partition would mint a piece field nothing ties to the
  // gross amount (no partition clause is declarable over one piece), letting
  // an instance store one gross and move another. When the amount never
  // splits, the choreography moves the amount field ITSELF.
  const rawPieces = partitionPieces(params);
  const pieces =
    rawPieces.length === 1
      ? rawPieces.map((piece) => ({ ...piece, field: amountName }))
      : rawPieces;
  const noun = params.name;
  // Who the payee's share actually lands on. Every sentence about the release
  // has to say this name, not the payee's, or the program would describe a
  // payout it does not make.
  const releaseTo = params.carveTo ?? params.payee;
  const releaseToWords = releaseTo.replaceAll("_", " ");

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      pieces.length === 1
        ? `The held amount in ${params.amount.currency} minor units, funded and paid out whole`
        : `The gross held amount in ${params.amount.currency} minor units; the piece fields below partition it exactly`,
    ),
  };
  for (const [index, piece] of pieces.entries()) {
    if (piece.field === amountName) continue;
    fields[piece.field] = moneyFieldSpec(
      pieceDescription(piece, index, amountName, params.amount.currency),
    );
  }
  if (params.deadlineField) {
    fields[params.deadlineField] = dateFieldSpec(
      `The date an undecided hold releases to the ${releaseToWords} on; ${params.port.name} and cancellation decide only before it`,
    );
  }
  if (params.payerFeeBps !== undefined) {
    fields.serviceFeeAmount = moneyFieldSpec(
      `${formatBps(params.payerFeeBps)} of ${amountName}, the ${params.payer.replaceAll("_", " ")}-side service fee charged on top at funding; non-refundable`,
    );
  }

  const fundVerbs = pieces.map((_, index) => `fund_piece_${index + 1}`);
  if (params.payerFeeBps !== undefined) fundVerbs.push("collect_service_fee");
  const releaseVerbs = pieces.map((_, index) =>
    index === 0 ? params.port.name : `${params.releaseWord}_piece_${index + 1}`,
  );
  const cancelVerbs = params.onCancel
    ? pieces.map((_, index) =>
        index === 0 ? "cancel" : `refund_piece_${index + 1}`,
      )
    : [];
  // The anchor is the DEFAULT exit, not a second decider. It mints one more
  // entry into the SAME release chain, so every piece drains through the
  // verbs the port path already proves, and the port and the cancel keep
  // their veto only until the date. Acting before it IS the veto.
  const deadlineVerb = params.deadlineField
    ? `${params.releaseWord}_on_deadline`
    : undefined;
  const deadlineRuleKey = frameKey(`${noun}_${params.releaseWord}_deadline`);
  // Abandonment: the pre-funded exit. Custody exists only while the deal is
  // still forming, so each intermediate funding state (funding_k holds pieces
  // 1..k) unwinds piece by piece. Every unfund verb returns exactly the piece
  // its funding verb moved, back to the payer, and `created` closes directly.
  // The chain runs through its own abandoning_* states (never back into
  // funding states) so the lifecycle stays acyclic and the terminal-escrow
  // analysis keeps its exact custody tokens. The service fee moves only on the
  // transition INTO funded (a completed collection), so abandonment never owes
  // it, the on_cancel policy stays the sole exit from funded.
  const fundingStateCount = fundVerbs.length - 1;
  const unfundVerbs = Array.from(
    { length: fundingStateCount },
    (_, index) => `unfund_piece_${index + 1}`,
  );
  if (
    !verbNameIssues(
      params.name,
      [
        ...fundVerbs,
        ...releaseVerbs,
        ...(deadlineVerb ? [deadlineVerb] : []),
        ...cancelVerbs,
        "abandon",
        ...unfundVerbs,
      ],
      params.port.origin,
      issues,
    )
  ) {
    return undefined;
  }

  const fundStates = chain(fundVerbs, "created", "funded", "funding");
  const releaseStates = chain(releaseVerbs, "funded", "released", "releasing");
  const cancelStates = chain(cancelVerbs, "funded", "cancelled", "cancelling");

  const events: Json[] = [];
  const verbs: Json = {};

  // The budget counts money BEHAVIORS, not pieces: every piece verb sharing a
  // phase and endpoint pair implements ONE frame event (occurrence repeatable
  // when several piece verbs share it), so fee carving and cancellation splits
  // never crowd a composite program out of the frame's event budget.
  const fundEventKey = `${noun}_fund`;
  events.push(
    mintEvent({
      amount:
        pieces.length === 1
          ? `The full ${amountName}`
          : `The ${amountName}, funded piece by piece`,
      fromActor: params.payer,
      key: fundEventKey,
      kind: params.fundEventKind,
      ...(pieces.length > 1 ? { occurrence: "repeatable" as const } : {}),
      toActor: "escrow",
      trigger: params.fundTrigger(0, pieces.length),
    }),
  );
  for (const [index, piece] of pieces.entries()) {
    verbs[fundVerbs[index] as string] = {
      from: [fundStates[index]?.from],
      moneyEvent: fundEventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: piece.field,
          from: params.payer,
          to: "escrow",
        },
      ],
      summary: `Fund piece ${index + 1} of the held amount into escrow`,
      to: fundStates[index]?.to,
    };
  }
  if (params.payerFeeBps !== undefined) {
    const index = fundVerbs.length - 1;
    const eventKey = `${noun}_service_fee`;
    events.push(
      mintEvent({
        amount: `${formatBps(params.payerFeeBps)} of the ${amountName}, on top`,
        fromActor: params.payer,
        key: eventKey,
        kind: "charge",
        toActor: "platform",
        trigger: "Collect the service fee at funding",
      }),
    );
    verbs.collect_service_fee = {
      from: [fundStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: "serviceFeeAmount",
          from: params.payer,
          to: "platform",
        },
      ],
      summary: "Collect the payer-side service fee",
      to: fundStates[index]?.to,
    };
  }

  // Release and cancel pieces group by recipient: one frame event per
  // distinct endpoint (an event's toActor is fixed), shared by every piece
  // verb paying that recipient.
  const releaseGroups = new Map<string, number>();
  for (const piece of pieces) {
    releaseGroups.set(
      piece.releaseTo,
      (releaseGroups.get(piece.releaseTo) ?? 0) + 1,
    );
  }
  for (const [releaseTo, pieceCount] of releaseGroups) {
    const totalBps = pieces
      .filter((piece) => piece.releaseTo === releaseTo)
      .reduce((sum, piece) => sum + piece.bps, 0);
    events.push(
      mintEvent({
        amount: `${formatBps(totalBps)} of the ${amountName}`,
        fromActor: "escrow",
        key: `${noun}_release_${releaseTo}`,
        kind: "payout",
        ...(pieceCount > 1 ? { occurrence: "repeatable" as const } : {}),
        toActor: releaseTo,
        trigger: `Release to the ${releaseTo.replaceAll("_", " ")}`,
      }),
    );
  }
  for (const [index, piece] of pieces.entries()) {
    verbs[releaseVerbs[index] as string] = {
      ...(index === 0 && params.deadlineField
        ? { deadline: { field: params.deadlineField } }
        : {}),
      from: [releaseStates[index]?.from],
      moneyEvent: frameKey(`${noun}_release_${piece.releaseTo}`),
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: piece.field,
          from: "escrow",
          to: piece.releaseTo,
        },
      ],
      summary:
        index === 0
          ? `Confirm through ${params.port.name} and start the ${params.releaseWord} payout`
          : `${titleize(params.releaseWord)} piece ${index + 1} of the held amount`,
      to: releaseStates[index]?.to,
    };
  }
  if (deadlineVerb && params.deadlineField) {
    const first = pieces[0] as LoweredPiece;
    verbs[deadlineVerb] = {
      due: { field: params.deadlineField, rule: deadlineRuleKey },
      from: [releaseStates[0]?.from],
      moneyEvent: frameKey(`${noun}_release_${first.releaseTo}`),
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: first.field,
          from: "escrow",
          to: first.releaseTo,
        },
      ],
      summary: `Release to the ${first.releaseTo.replaceAll("_", " ")} when ${params.deadlineField} arrives undecided`,
      to: releaseStates[0]?.to,
    };
  }

  if (params.onCancel) {
    const cancelGroups = new Map<string, number>();
    for (const piece of pieces) {
      const cancelTo = piece.cancelTo as string;
      cancelGroups.set(cancelTo, (cancelGroups.get(cancelTo) ?? 0) + 1);
    }
    for (const [cancelTo, pieceCount] of cancelGroups) {
      const totalBps = pieces
        .filter((piece) => piece.cancelTo === cancelTo)
        .reduce((sum, piece) => sum + piece.bps, 0);
      events.push(
        mintEvent({
          amount: `${formatBps(totalBps)} of the ${amountName}`,
          fromActor: "escrow",
          key: `${noun}_cancel_${cancelTo}`,
          kind: cancelTo === params.payer ? "refund" : "penalty",
          ...(pieceCount > 1 ? { occurrence: "repeatable" as const } : {}),
          toActor: cancelTo,
          trigger: `Return to the ${cancelTo.replaceAll("_", " ")} on cancellation`,
        }),
      );
    }
    for (const [index, piece] of pieces.entries()) {
      verbs[cancelVerbs[index] as string] = {
        ...(index === 0 && params.deadlineField
          ? { deadline: { field: params.deadlineField } }
          : {}),
        from: [cancelStates[index]?.from],
        moneyEvent: frameKey(`${noun}_cancel_${piece.cancelTo as string}`),
        moves: [
          {
            key: "transfer",
            operation: "create",
            amount: piece.field,
            from: "escrow",
            to: piece.cancelTo as string,
          },
        ],
        summary:
          index === 0
            ? "Cancel the settlement and start the unwind"
            : `Return piece ${index + 1} on cancellation`,
        to: cancelStates[index]?.to,
      };
    }
  }

  if (unfundVerbs.length > 0) {
    const eventKey = `${noun}_abandon`;
    events.push(
      mintEvent({
        amount: `The funded pieces of the ${amountName}, returned exactly`,
        fromActor: "escrow",
        key: eventKey,
        kind: "refund",
        ...(unfundVerbs.length > 1
          ? { occurrence: "repeatable" as const }
          : {}),
        toActor: params.payer,
        trigger: `Return the held pieces to the ${params.payer.replaceAll("_", " ")} on abandonment`,
      }),
    );
    for (const [index, verbName] of unfundVerbs.entries()) {
      const step = index + 1;
      verbs[verbName] = {
        from: [
          `funding_${step}`,
          ...(step < fundingStateCount ? [`abandoning_${step}`] : []),
        ],
        moneyEvent: frameKey(eventKey),
        moves: [
          {
            key: "transfer",
            operation: "create",
            amount: (pieces[index] as LoweredPiece).field,
            from: "escrow",
            to: params.payer,
          },
        ],
        summary: `Return piece ${step} to the ${params.payer.replaceAll("_", " ")} on abandonment`,
        to: step === 1 ? "abandoned" : `abandoning_${step - 1}`,
      };
    }
  }
  verbs.abandon = {
    from: ["created"],
    requiresDrainedAccount: { path: "refs.escrowAccountId" },
    summary: "Abandon the settlement before any money is held",
    to: "abandoned",
  };

  verbs.create = {
    summary: `Create a ${titleize(params.name).toLowerCase()} settlement`,
    to: "created",
  };

  const rules: Json[] = [
    {
      allowedActors: [...params.port.allowed],
      detail: `${params.port.allowed.map(titleize).join(" or ")} confirms through the tenant backend before ${params.deadlineField ? `${params.deadlineField}, to decide ahead of it` : "any payout"}`,
      dueDriven: false,
      enforcement: "tenant_app",
      gatesEvent: frameKey(`${noun}_release_${pieces[0]!.releaseTo}`),
      key: frameKey(`${noun}_${params.port.name}_gate`),
      kind: "release_condition",
      label: `${titleize(params.releaseWord)} decided through ${params.port.name}`,
      tenantTunable: false,
    },
  ];
  if (params.deadlineField) {
    rules.push({
      allowedActors: [],
      detail: `A hold nobody decided releases to the ${releaseToWords} on its stored ${params.deadlineField}, exactly once`,
      dueDriven: true,
      enforcement: "platform",
      gatesEvent: null,
      key: deadlineRuleKey,
      kind: "deadline",
      label: `Undecided holds release on ${params.deadlineField}`,
      tenantTunable: false,
    });
  }

  return {
    design: [
      `${noun}: own escrow; ${pieces.length}-piece partition of ${amountName} (${pieces
        .map((piece) => formatBps(piece.bps))
        .join(
          " + ",
        )}); every exit drains every piece; abandonable before funded (created closes directly, funding states unwind piece by piece to the ${params.payer})`,
      ...(params.deadlineField
        ? [
            `${noun}: undecided holds release to the ${releaseTo} on ${params.deadlineField}; the port and the cancel decide only before that anchor`,
          ]
        : []),
      ...(params.carveTo
        ? [
            `${noun}: the ${params.payee}'s whole release share is carved to the ${params.carveTo}, who financed it; the platform fee and the cancellation split are untouched`,
          ]
        : []),
      ...(params.payerFeeBps !== undefined
        ? [
            `${noun}: ${formatBps(params.payerFeeBps)} ${params.payer} service fee on top, straight to platform at funding`,
          ]
        : []),
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [params.payer]: "payer",
        // The payee stays the beneficiary under a carve, it is their
        // receivable, while the funder joins as the endpoint the release
        // pays. Only one beneficiary, so the frame's parties stay unambiguous.
        [params.payee]: "beneficiary",
        ...(params.carveTo ? { [params.carveTo]: "party" as const } : {}),
        platform: "party",
      },
      desc: `Held amount from ${params.payer.replaceAll("_", " ")} to ${params.payee.replaceAll("_", " ")}${params.carveTo ? `, released to the ${releaseToWords} against the advance it secures` : ""}`,
      escrow: true,
      fields,
      id: params.name,
      ...partitionsSpread(
        partitionClause(
          amountName,
          pieces.map((piece) => piece.field),
        ),
      ),
      summary: `Escrow-held amount from ${params.payer.replaceAll("_", " ")}`,
      title: titleize(params.name),
      verbs,
    },
    rules,
    settlement: {
      name: params.name,
      pieces,
      ...(params.payerFeeBps !== undefined
        ? { serviceFee: { bps: params.payerFeeBps, field: "serviceFeeAmount" } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// instant_transfer: straight-through partitioned payment, no custody

function lowerInstantTransfer(settlement: CheckedInstantTransfer): LoweredNoun {
  const payerFee = settlement.fees.find(
    (fee) => fee.bearer === settlement.payer,
  );
  const payeeFee = settlement.fees.find(
    (fee) => fee.bearer === settlement.payee,
  );
  const amountName = settlement.amount.name;
  // Same single-piece law as the held family: a fee-free transfer moves the
  // amount field itself, so nothing untied to the gross can be admitted.
  const rawPieces = partitionPieces({
    amount: settlement.amount,
    payee: settlement.payee,
    payeeFeeBps: payeeFee?.bps ?? 0,
  });
  const pieces =
    rawPieces.length === 1
      ? rawPieces.map((piece) => ({ ...piece, field: amountName }))
      : rawPieces;
  const noun = settlement.name;

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      pieces.length === 1
        ? `The amount in ${settlement.amount.currency} minor units, paid through whole`
        : `The gross amount in ${settlement.amount.currency} minor units; the piece fields below partition it exactly`,
    ),
  };
  for (const [index, piece] of pieces.entries()) {
    if (piece.field === amountName) continue;
    fields[piece.field] = moneyFieldSpec(
      pieceDescription(piece, index, amountName, settlement.amount.currency),
    );
  }
  if (payerFee) {
    fields.serviceFeeAmount = moneyFieldSpec(
      `${formatBps(payerFee.bps)} of ${amountName}, the ${settlement.payer.replaceAll("_", " ")}-side service fee charged on top; non-refundable`,
    );
  }

  const payVerbs = pieces.map((_, index) => `pay_piece_${index + 1}`);
  if (payerFee) payVerbs.push("collect_service_fee");
  const payStates = chain(payVerbs, "created", "paid", "paying");

  const events: Json[] = [];
  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()} payment`,
      to: "created",
    },
  };
  for (const [index, piece] of pieces.entries()) {
    const eventKey = `${noun}_pay_${index + 1}`;
    events.push(
      mintEvent({
        amount: `${formatBps(piece.bps)} of the ${amountName}`,
        fromActor: settlement.payer,
        key: eventKey,
        kind: "charge",
        toActor: piece.releaseTo,
        trigger: `Pay piece ${index + 1} straight to the ${piece.releaseTo.replaceAll("_", " ")}`,
      }),
    );
    verbs[payVerbs[index] as string] = {
      from: [payStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: piece.field,
          from: settlement.payer,
          to: piece.releaseTo,
        },
      ],
      summary: `Pay piece ${index + 1} of the amount through`,
      to: payStates[index]?.to,
    };
  }
  if (payerFee) {
    const index = payVerbs.length - 1;
    const eventKey = `${noun}_service_fee`;
    events.push(
      mintEvent({
        amount: `${formatBps(payerFee.bps)} of the ${amountName}, on top`,
        fromActor: settlement.payer,
        key: eventKey,
        kind: "charge",
        toActor: "platform",
        trigger: "Collect the service fee with the payment",
      }),
    );
    verbs.collect_service_fee = {
      from: [payStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: "serviceFeeAmount",
          from: settlement.payer,
          to: "platform",
        },
      ],
      summary: "Collect the payer-side service fee",
      to: payStates[index]?.to,
    };
  }

  const touchesPlatform =
    payerFee !== undefined ||
    pieces.some((piece) => piece.releaseTo === "platform");
  return {
    design: [
      `${noun}: instant pass-through; ${pieces.length}-piece partition of ${amountName} (${pieces
        .map((piece) => formatBps(piece.bps))
        .join(" + ")}); no custody`,
    ],
    feeLines: [
      ...(payerFee
        ? [
            {
              label: `${titleize(settlement.payer)} service fee`,
              on: `each ${noun.replaceAll("_", " ")}`,
              structure: `${formatBps(payerFee.bps)} of the ${amountName}, on top`,
            },
          ]
        : []),
      ...(payeeFee
        ? [
            {
              label: `${titleize(settlement.payee)} fee`,
              on: `each ${noun.replaceAll("_", " ")}`,
              structure: `${formatBps(payeeFee.bps)} of the ${amountName}, deducted from the payout`,
            },
          ]
        : []),
    ],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        [settlement.payee]: "beneficiary",
        ...(touchesPlatform ? { platform: "party" } : {}),
      },
      desc: `Instant transfer: the ${settlement.payer.replaceAll("_", " ")} pays ${amountName} straight through to the ${settlement.payee.replaceAll("_", " ")}, no custody`,
      fields,
      id: noun,
      ...partitionsSpread(
        partitionClause(
          amountName,
          pieces.map((piece) => piece.field),
        ),
      ),
      summary: `Instant payment from ${settlement.payer.replaceAll("_", " ")} to ${settlement.payee.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules: [],
    settlement: {
      name: noun,
      pieces,
      ...(payerFee
        ? { serviceFee: { bps: payerFee.bps, field: "serviceFeeAmount" } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// deposit: a reservation placed, then claimed or returned

function lowerCaptureReservation(
  settlement: CheckedCaptureReservation,
  correctionPort: CheckedPort,
  reversalPort: CheckedPort,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const reserveRef = "authorize_reservation";
  const capturedRef = "capturedAmount";
  const reversalCutoffField = "reversalUntil";
  const captureVerbs = ["capture", "capture_more"];
  const verbNames = [
    "authorize",
    ...captureVerbs,
    "settle",
    "void",
    "expire",
    "settle_on_expiry",
    settlement.correction.port,
    settlement.externalReversal.port,
  ];
  if (!verbNameIssues(noun, verbNames, settlement.origin, issues)) {
    return undefined;
  }

  const reserveEventKey = frameKey(`${noun}_reserve`);
  const captureEventKey = frameKey(`${noun}_capture`);
  const correctionEventKey = frameKey(`${noun}_correction`);
  const reversalEventKey = frameKey(`${noun}_external_reversal`);
  const expiryRuleKey = frameKey(`${noun}_reservation_expiry`);
  const captureMove = (partialOnly: boolean): Json => ({
    amount: "captureAmount",
    capture: { [capturedRef]: "postedAmount" },
    key: "post",
    operation: "post",
    ...(partialOnly ? { partialOnly: true } : {}),
    reservation: reserveRef,
  });
  const reverseMove = (): Json => ({
    amount: `refs.${capturedRef}`,
    clawbackOf: reserveRef,
    from: settlement.payee,
    key: "transfer",
    operation: "create",
    to: settlement.payer,
  });
  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()}`,
      to: "created",
    },
    authorize: {
      from: ["created"],
      moneyEvent: reserveEventKey,
      moves: [
        {
          amount: amountName,
          from: settlement.payer,
          key: "reservation",
          operation: "reserve",
          to: settlement.payee,
        },
      ],
      summary: `Reserve the ${amountName} until ${settlement.reserveUntilField}`,
      to: "authorized",
    },
    capture: {
      deadline: { field: settlement.reserveUntilField },
      from: ["authorized"],
      moneyEvent: captureEventKey,
      moves: [captureMove(true)],
      summary: "Post one strict partial capture slice",
      to: "partially_captured",
    },
    capture_more: {
      deadline: { field: settlement.reserveUntilField },
      from: ["partially_captured"],
      moneyEvent: captureEventKey,
      moves: [captureMove(true)],
      summary: "Post another strict partial capture slice",
      to: "partially_captured",
    },
    settle: {
      deadline: { field: settlement.reserveUntilField },
      from: ["authorized", "partially_captured"],
      moneyEvent: captureEventKey,
      moves: [
        {
          capture: { [capturedRef]: "postedAmount" },
          key: "post",
          operation: "post",
          reservation: reserveRef,
        },
      ],
      summary: "Post the full reserved remainder and settle",
      setsAt: {
        field: reversalCutoffField,
        offset: settlement.externalReversal.window.raw,
      },
      to: "settled",
    },
    void: {
      from: ["authorized"],
      moves: [
        {
          key: "void",
          operation: "void",
          reason: "Reservation voided before any capture",
          reservation: reserveRef,
        },
      ],
      summary: "Release an entirely uncaptured reservation",
      to: "voided",
    },
    expire: {
      due: { field: settlement.reserveUntilField, rule: expiryRuleKey },
      from: ["authorized"],
      moves: [
        {
          key: "void",
          operation: "void",
          reason: "Uncaptured reservation expired",
          reservation: reserveRef,
        },
      ],
      summary: "Release an uncaptured reservation at expiry",
      to: "expired",
    },
    settle_on_expiry: {
      due: { field: settlement.reserveUntilField, rule: expiryRuleKey },
      from: ["partially_captured"],
      moves: [
        {
          key: "void",
          operation: "void",
          reason: "Uncaptured remainder released at expiry",
          reservation: reserveRef,
        },
      ],
      summary: "Release the uncaptured remainder and settle captured slices",
      setsAt: {
        field: reversalCutoffField,
        offset: settlement.externalReversal.window.raw,
      },
      to: "settled",
    },
    [settlement.correction.port]: {
      from: ["settled"],
      moneyEvent: correctionEventKey,
      moves: [reverseMove()],
      port: { allowed: correctionPort.allowed },
      summary: "Return the full captured amount on payee correction",
      to: "corrected",
    },
    [settlement.externalReversal.port]: {
      captureInput: { externalReference: "externalReference" },
      deadline: { field: reversalCutoffField },
      from: ["settled"],
      moneyEvent: reversalEventKey,
      moves: [reverseMove()],
      port: {
        allowed: reversalPort.allowed,
        fields: { externalReference: "text" },
      },
      summary: "Return the full captured amount on an external reversal",
      to: "reversed",
    },
  };

  const events = [
    mintEvent({
      amount: `The full ${amountName}`,
      fromActor: settlement.payer,
      key: reserveEventKey,
      kind: "hold",
      toActor: settlement.payee,
      trigger: `Reserve ${amountName} until ${settlement.reserveUntilField}`,
    }),
    mintEvent({
      amount: `Each posted slice, never more than the remaining ${amountName}`,
      amountDependency: {
        kind: "bounded_by_reference",
        reference: reserveEventKey,
      },
      fromActor: settlement.payer,
      key: captureEventKey,
      kind: "payout",
      occurrence: "repeatable",
      toActor: settlement.payee,
      trigger: "Post a capture slice or the final remainder",
    }),
    mintEvent({
      amount: "100% of the cumulative captured amount",
      amountDependency: {
        bps: 10_000,
        kind: "percent_of_reference",
        reference: captureEventKey,
      },
      fromActor: settlement.payee,
      key: correctionEventKey,
      kind: "refund",
      toActor: settlement.payer,
      trigger: "Apply one full payee correction",
    }),
    mintEvent({
      amount: "100% of the cumulative captured amount",
      amountDependency: {
        bps: 10_000,
        kind: "percent_of_reference",
        reference: captureEventKey,
      },
      fromActor: settlement.payee,
      key: reversalEventKey,
      kind: "refund",
      toActor: settlement.payer,
      trigger: "Apply one full externally decided reversal",
    }),
  ];

  return {
    design: [
      `${noun}: reserve ${amountName} until ${settlement.reserveUntilField}; capture in strict partial slices; post the remainder to settle; expiry releases only the uncaptured remainder`,
      `${noun}: correction and external reversal each return the full captured amount once; insufficient payee funds reject the move instead of creating a negative position`,
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        [settlement.payee]: "beneficiary",
      },
      desc: `Payer reservation captured by the payee in slices within a fixed window`,
      fields: {
        [amountName]: moneyFieldSpec(
          `Maximum captured amount in ${settlement.amount.currency} minor units`,
        ),
        [settlement.reserveUntilField]: dateFieldSpec(
          "Reservation expiry that releases any uncaptured remainder",
        ),
        [reversalCutoffField]: {
          desc: "Machine-owned external reversal cutoff anchored when settlement completes",
          type: "date?",
        },
      },
      id: noun,
      summary: `Capture reservation from ${settlement.payer.replaceAll("_", " ")} to ${settlement.payee.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail: `At ${settlement.reserveUntilField}, the platform releases the uncaptured remainder and preserves any posted slices`,
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: expiryRuleKey,
        kind: "deadline",
        label: `Uncaptured remainder releases on ${settlement.reserveUntilField}`,
        tenantTunable: false,
      },
      {
        allowedActors: [...correctionPort.allowed],
        detail: "The payee may return the full captured amount once",
        dueDriven: false,
        enforcement: "tenant_app",
        gatesEvent: correctionEventKey,
        key: frameKey(`${noun}_${settlement.correction.port}_gate`),
        kind: "release_condition",
        label: "Full correction confirmed through the tenant backend",
        tenantTunable: false,
      },
      {
        allowedActors: [...reversalPort.allowed],
        detail: `A confirmed external decision may reverse the full captured amount within ${settlement.externalReversal.window.raw}; timeout moves nothing`,
        dueDriven: false,
        enforcement: "tenant_app",
        gatesEvent: reversalEventKey,
        key: frameKey(`${noun}_${settlement.externalReversal.port}_gate`),
        kind: "release_condition",
        label: "External reversal confirmed through the tenant backend",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// settlement_batch: immutable close, signed lineage sum, one payout

function lowerSettlementBatch(
  settlement: CheckedSettlementBatch,
  acknowledgementPort: CheckedPort,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const noun = settlement.name;
  const captureEntry = `${noun}_capture_entry`;
  const creditAdjustment = `${noun}_credit_adjustment`;
  const debitAdjustment = `${noun}_debit_adjustment`;
  const batchIdField = `${noun.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}Id`;
  const payoutEventKey = frameKey(`${noun}_payout`);
  const closeRuleKey = frameKey(`${noun}_close`);
  if (
    !verbNameIssues(
      noun,
      [
        "close",
        "calculate",
        "approve",
        "instruct",
        "reconcile",
        settlement.payoutAcknowledgement.port,
      ],
      settlement.origin,
      issues,
    )
  ) {
    return undefined;
  }

  const parentRequirement: Json = {
    [batchIdField]: {
      match: { "fields.currency": "fields.currency" },
      statuses: ["open"],
    },
  };
  const captureNoun: Json = {
    desc: "One gross capture entry linked to an open payout batch",
    fields: {
      amount: moneyFieldSpec("Gross captured amount in minor units"),
      currency: {
        desc: "ISO 4217 currency shared with the payout batch",
        type: "currency",
      },
      [batchIdField]: {
        desc: "Open batch this capture entry accrues into",
        type: `ref:${noun}`,
      },
      [settlement.sourceCaptureReferenceField]: {
        desc: "Immutable source capture reference",
        type: "text",
      },
    },
    id: captureEntry,
    summary: "Gross capture lineage entry",
    title: `${titleize(noun)} Capture Entry`,
    verbs: {
      create: {
        requires: parentRequirement,
        summary: "Create a capture lineage entry on an open batch",
        to: "created",
      },
      accrue: {
        from: ["created"],
        requires: parentRequirement,
        summary: "Accrue the capture entry into the open batch",
        to: "accrued",
      },
    },
  };

  const adjustmentNoun = (id: string, direction: "credit" | "debit"): Json => ({
    desc: `One ${direction} adjustment linked to an open payout batch; closed batches stay unchanged`,
    fields: {
      amount: moneyFieldSpec(
        `${titleize(direction)} adjustment amount in minor units`,
      ),
      currency: {
        desc: "ISO 4217 currency shared with the payout batch",
        type: "currency",
      },
      adjustmentReference: {
        desc: "Immutable explicit adjustment reference",
        type: "text",
      },
      [batchIdField]: {
        desc: "Open batch this adjustment applies to",
        type: `ref:${noun}`,
      },
      [settlement.externalReversalReferenceField]: {
        desc: "Optional externally decided reversal reference",
        type: "text?",
      },
      [settlement.feeReferenceField]: {
        desc: "Optional fee entry reference",
        type: "text?",
      },
      [settlement.sourceCaptureReferenceField]: {
        desc: "Original capture reference that this adjustment corrects",
        type: "text",
      },
    },
    id,
    summary: `${titleize(direction)} adjustment with capture lineage`,
    title: `${titleize(noun)} ${titleize(direction)} Adjustment`,
    verbs: {
      create: {
        requires: parentRequirement,
        summary: `Create a ${direction} adjustment on an open batch`,
        to: "created",
      },
      adjust: {
        from: ["created"],
        requires: parentRequirement,
        summary: `Apply the ${direction} adjustment to the open batch`,
        to: "applied",
      },
      correct: {
        from: ["created"],
        requires: parentRequirement,
        summary:
          "Record a later correction on this open batch instead of changing the closed source batch",
        to: "applied",
      },
    },
  });

  const verbs: Json = {
    create: {
      summary: `Open a ${titleize(noun).toLowerCase()}`,
      to: "open",
    },
    close: {
      due: { field: settlement.closeTriggerField, rule: closeRuleKey },
      from: ["open"],
      summary: "Freeze the batch and stop all new entries",
      to: "closed",
    },
    calculate: {
      from: ["closed"],
      signedSum: {
        amountRef: "netPayable",
        onNegative: "refuse",
        onZero: "refuse",
        sources: [
          {
            amountField: "amount",
            nounId: captureEntry,
            refField: batchIdField,
            sign: "add",
            statuses: ["accrued"],
            subtotalRef: "grossCaptureAmount",
          },
          {
            amountField: "amount",
            nounId: creditAdjustment,
            refField: batchIdField,
            sign: "add",
            statuses: ["applied"],
            subtotalRef: "creditAdjustmentAmount",
          },
          {
            amountField: "amount",
            nounId: debitAdjustment,
            refField: batchIdField,
            sign: "subtract",
            statuses: ["applied"],
            subtotalRef: "debitAdjustmentAmount",
          },
        ],
      },
      summary: "Prove and freeze the one signed net payable amount",
      to: "calculated",
    },
    approve: {
      from: ["calculated"],
      summary: "Approve the frozen payable without recomputing it",
      to: "approved",
    },
    instruct: {
      from: ["approved"],
      moneyEvent: payoutEventKey,
      payout: {
        amount: "refs.netPayable",
        beneficiaryField: settlement.payoutBeneficiaryReferenceField,
        beneficiaryPartyField: `${camelize(settlement.payoutDestination)}AccountId`,
        capture: "payoutId",
        currencyField: "currency",
        sourceAccountField: `${camelize(settlement.settlementAccount)}AccountId`,
        speed: "standard",
      },
      summary: "Create one idempotent payout from the frozen net payable",
      to: "instructed",
    },
    [settlement.payoutAcknowledgement.port]: {
      captureInput: {
        acknowledgementReference: "acknowledgementReference",
      },
      from: ["instructed"],
      port: {
        allowed: acknowledgementPort.allowed,
        fields: { acknowledgementReference: "text" },
      },
      summary: "Record the tenant's payout acknowledgement in the receipt",
      to: "acknowledged",
    },
    reconcile: {
      from: ["instructed", "acknowledged"],
      requiresSettlement: {
        capture: "settlementEvidenceId",
        payoutRef: "payoutId",
      },
      summary: "Record durable evidence that the payout settled",
      to: "reconciled",
    },
  };

  return {
    design: [
      `${noun}: capture entries plus signed adjustments freeze at ${settlement.closeTriggerField}; calculate persists gross, credit, debit, and net refs; negative or zero net refuses`,
      `${noun}: instruct creates one payout intent for the frozen refs.netPayable; only matched settlement evidence can reconcile it`,
    ],
    extraNouns: [
      captureNoun,
      adjustmentNoun(creditAdjustment, "credit"),
      adjustmentNoun(debitAdjustment, "debit"),
    ],
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount:
          "The frozen signed sum of gross capture entries plus credit adjustments minus debit adjustments",
        fromActor: settlement.settlementAccount,
        key: payoutEventKey,
        kind: "payout",
        toActor: settlement.payoutDestination,
        trigger: "Instruct the approved batch payout exactly once",
      }),
    ],
    noun: {
      actors: {
        [settlement.payoutDestination]: "beneficiary",
        [settlement.settlementAccount]: "payer",
      },
      desc: "Immutable batch of capture lineage and signed adjustments that creates one payout",
      fields: {
        [settlement.closeTriggerField]: dateFieldSpec(
          "Date the open batch freezes against later entries",
        ),
        currency: {
          desc: "ISO 4217 currency shared by the batch and payout instruction",
          type: "currency",
        },
        [settlement.payoutBeneficiaryReferenceField]: {
          desc: "Beneficiary ID for the payout instruction",
          type: "beneficiary",
        },
      },
      id: noun,
      summary: `Payout batch from ${settlement.settlementAccount.replaceAll("_", " ")} to ${settlement.payoutDestination.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail: `At ${settlement.closeTriggerField}, the platform closes the batch and every child reference gate refuses later entries`,
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: closeRuleKey,
        kind: "deadline",
        label: `Batch freezes on ${settlement.closeTriggerField}`,
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

function lowerDeposit(
  settlement: CheckedDeposit,
  claim: CheckedPort,
  giveBack: CheckedPort,
  issues: LoweringIssue[],
): LoweredNoun | undefined {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  if (
    !verbNameIssues(
      noun,
      ["place_deposit", claim.name, giveBack.name],
      settlement.origin,
      issues,
    )
  ) {
    return undefined;
  }

  const eventKey = `${noun}_hold_1`;
  const events = [
    mintEvent({
      amount: `The full ${amountName}`,
      fromActor: settlement.payer,
      key: eventKey,
      kind: "hold",
      toActor: settlement.holder,
      trigger: `Reserve the ${amountName} in the ${settlement.holder.replaceAll("_", " ")}'s favor`,
    }),
  ];

  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()}`,
      to: "created",
    },
    place_deposit: {
      from: ["created"],
      moves: [
        {
          key: "reservation",
          operation: "reserve",
          amount: amountName,
          from: settlement.payer,
          to: settlement.holder,
        },
      ],
      moneyEvent: eventKey,
      summary: `Reserve the ${amountName} against the ${settlement.payer.replaceAll("_", " ")}'s account`,
      to: "held",
    },
    [claim.name]: {
      from: ["held"],
      moves: [
        {
          key: "post",
          operation: "post",
          reservation: "place_deposit_reservation",
        },
      ],
      summary: `Claim the deposit for the ${settlement.holder.replaceAll("_", " ")} through ${claim.name}`,
      to: "claimed",
    },
    [giveBack.name]: {
      from: ["held"],
      summary: `Return the deposit to the ${settlement.payer.replaceAll("_", " ")} through ${giveBack.name}`,
      to: "returned",
      moves: [
        {
          key: "void",
          operation: "void",
          reason: "Deposit returned in full",
          reservation: "place_deposit_reservation",
        },
      ],
    },
  };

  const portRule = (port: CheckedPort, verbLabel: string): Json => ({
    allowedActors: [...port.allowed],
    detail: `${port.allowed.map(titleize).join(" or ")} decides through the tenant backend`,
    dueDriven: false,
    enforcement: "tenant_app",
    gatesEvent: null,
    key: frameKey(`${noun}_${port.name}_gate`),
    kind: "release_condition",
    label: `${verbLabel} decided through ${port.name}`,
    tenantTunable: false,
  });

  return {
    design: [
      `${noun}: ${amountName} held as a reservation on the ${settlement.payer.replaceAll("_", " ")}'s account; claimed whole through ${claim.name} or returned whole through ${giveBack.name}`,
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        [settlement.holder]: "beneficiary",
      },
      desc: `Deposit: the ${amountName} is reserved against the ${settlement.payer.replaceAll("_", " ")}'s account in the ${settlement.holder.replaceAll("_", " ")}'s favor, then claimed or returned in full`,
      fields: {
        [amountName]: moneyFieldSpec(
          `The deposit amount in ${settlement.amount.currency} minor units, reserved in full and fully accounted on claim or return`,
        ),
      },
      id: noun,
      summary: `Refundable deposit from ${settlement.payer.replaceAll("_", " ")} held for ${settlement.holder.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules: [portRule(claim, "Claim"), portRule(giveBack, "Return")],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// scheduled and advance: finite due-driven anchors

/** Equal N-way piece widths in bps; the first anchor absorbs the remainder. */
function evenPieceBps(count: number): number[] {
  const base = Math.floor(Number(TOTAL_BPS) / count);
  const widths = Array.from({ length: count }, () => base);
  widths[0] = Number(TOTAL_BPS) - base * (count - 1);
  return widths;
}

// ---------------------------------------------------------------------------
// funding_round: aggregate commitments with threshold close and whole unwind

function lowerFundingRound(settlement: CheckedFundingRound): LoweredNoun {
  const noun = settlement.name;
  const child = `${noun}_commitment`;
  const parentRef = `${camelize(noun)}Id`;
  const commitEvent = frameKey(`${noun}_commit`);
  const cancelEvent = frameKey(`${noun}_cancel`);
  const collectEvent = frameKey(`${noun}_collect`);
  const refundEvent = frameKey(`${noun}_refund`);
  const closeRule = frameKey(`${noun}_close`);
  const aggregate = (kind: "sum_at_least" | "sum_below"): Json[] => [
    {
      check: {
        amountField: "amount",
        kind,
        targetField: settlement.target.name,
      },
      nounId: child,
      over: "children",
      refField: parentRef,
      statuses: ["committed"],
    },
  ];
  const parentRequirement = (statuses: readonly string[]): Json => ({
    [parentRef]: {
      bind: {
        currency: "fields.currency",
        [`${camelize(settlement.beneficiary)}AccountId`]: `fields.${camelize(settlement.beneficiary)}AccountId`,
      },
      statuses,
    },
  });
  const transitionRequirement = (statuses: readonly string[]): Json => ({
    [parentRef]: {
      match: {
        "fields.currency": "fields.currency",
        [`fields.${camelize(settlement.beneficiary)}AccountId`]: `fields.${camelize(settlement.beneficiary)}AccountId`,
      },
      statuses,
    },
  });

  return {
    design: [
      `${noun}: reuses the catalog funding round and commitment mechanism; the parent lock caps committed rows by target and contributor count`,
      `${noun}: the stored close anchor chooses threshold activation or failure; each commitment then moves whole from its own custody`,
    ],
    extraNouns: [
      {
        actors: {
          [settlement.beneficiary]: "beneficiary",
          [settlement.contributor]: "payer",
        },
        desc: `One whole commitment linked to ${noun}`,
        escrow: true,
        fields: {
          amount: moneyFieldSpec("One whole commitment amount"),
          currency: {
            desc: "Currency derived from the funding round",
            type: "currency",
          },
          [parentRef]: { desc: `The exact ${noun}`, type: `ref:${noun}` },
        },
        id: child,
        summary: `Whole commitment to ${noun}`,
        title: `${titleize(noun)} Commitment`,
        verbs: {
          create: {
            moneyEvent: commitEvent,
            moves: [
              {
                amount: "amount",
                from: settlement.contributor,
                key: "commit",
                operation: "create",
                to: "escrow",
              },
            ],
            requires: parentRequirement(["open"]),
            requiresExposure: [
              {
                amountField: "amount",
                anchorField: parentRef,
                capField: settlement.target.name,
                capOnAnchor: true,
                childNounId: child,
                statuses: ["committed"],
              },
            ],
            summary:
              "Store one whole commitment without exceeding the round target",
            to: "committed",
          },
          cancel: {
            from: ["committed"],
            moneyEvent: cancelEvent,
            moves: [
              {
                amount: "amount",
                from: "escrow",
                key: "cancel",
                operation: "create",
                to: settlement.contributor,
              },
            ],
            requires: transitionRequirement(["open"]),
            summary: "Cancel one commitment while the round is open",
            to: "cancelled",
          },
          collect: {
            from: ["committed"],
            moneyEvent: collectEvent,
            moves: [
              {
                amount: "amount",
                from: "escrow",
                key: "collect",
                operation: "create",
                to: settlement.beneficiary,
              },
            ],
            requires: transitionRequirement(["active"]),
            summary: "Collect one successful commitment whole",
            to: "collected",
          },
          refund: {
            from: ["committed"],
            moneyEvent: refundEvent,
            moves: [
              {
                amount: "amount",
                from: "escrow",
                key: "refund",
                operation: "create",
                to: settlement.contributor,
              },
            ],
            requires: transitionRequirement(["failed"]),
            summary: "Refund one failed-round commitment whole",
            to: "refunded",
          },
        },
      },
    ],
    generatedPrefixNounIds: [child],
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount: "One stored commitment",
        fromActor: settlement.contributor,
        key: commitEvent,
        kind: "charge",
        occurrence: "repeatable",
        toActor: "escrow",
        trigger: "Create one target-capped commitment",
      }),
      mintEvent({
        amount: "One stored commitment whole",
        fromActor: "escrow",
        key: cancelEvent,
        kind: "refund",
        occurrence: "repeatable",
        toActor: settlement.contributor,
        trigger: "Cancel before close",
      }),
      mintEvent({
        amount: "One stored commitment whole",
        fromActor: "escrow",
        key: collectEvent,
        kind: "payout",
        occurrence: "repeatable",
        toActor: settlement.beneficiary,
        trigger: "Collect after threshold close",
      }),
      mintEvent({
        amount: "One stored commitment whole",
        fromActor: "escrow",
        key: refundEvent,
        kind: "refund",
        occurrence: "repeatable",
        toActor: settlement.contributor,
        trigger: "Refund after failed close",
      }),
    ],
    noun: {
      actors: { [settlement.beneficiary]: "beneficiary" },
      aggregateInvariants: [
        {
          childField: "amount",
          childNounId: child,
          childRefField: parentRef,
          childStatuses: ["committed"],
          parentField: settlement.target.name,
        },
        {
          count: true,
          childNounId: child,
          childRefField: parentRef,
          childStatuses: ["committed"],
          parentField: "maxContributors",
        },
      ],
      desc: "All-or-nothing aggregate funding threshold",
      fields: {
        currency: {
          desc: `Currency fixed to ${settlement.target.currency}`,
          type: "currency",
        },
        [settlement.target.name]: moneyFieldSpec(
          `Funding target in ${settlement.target.currency} minor units`,
        ),
        [settlement.closeByField]: dateFieldSpec("Stored close anchor"),
        maxContributors: {
          desc: `Exactly ${settlement.maxContributors} admitted contributors`,
          type: `const:${settlement.maxContributors}`,
        },
      },
      id: noun,
      summary: `Threshold funding round for ${settlement.beneficiary.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs: {
        create: { summary: "Open the funding round", to: "open" },
        activate: {
          due: { field: settlement.closeByField, rule: closeRule },
          from: ["open"],
          requiresAggregate: aggregate("sum_at_least"),
          summary: "Activate when commitments meet the target",
          to: "active",
        },
        fail: {
          due: { field: settlement.closeByField, rule: closeRule },
          from: ["open"],
          requiresAggregate: aggregate("sum_below"),
          summary: "Fail when commitments remain below target",
          to: "failed",
        },
        close: {
          from: ["active"],
          requiresAggregate: [
            {
              check: { kind: "all_in" },
              nounId: child,
              over: "children",
              refField: parentRef,
              statuses: ["cancelled", "collected"],
            },
          ],
          summary:
            "Settle after every admitted row is collected or was cancelled before activation",
          to: "settled",
        },
      },
    },
    rules: [
      {
        allowedActors: [],
        detail:
          "The stored close anchor compares committed rows with the target",
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: closeRule,
        kind: "deadline",
        label: "Round closes against its stored threshold",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// weighted_distribution: frozen weights with deterministic largest remainder

function lowerWeightedDistribution(
  settlement: CheckedWeightedDistribution,
  snapshot: CheckedPort,
): LoweredNoun {
  const noun = settlement.name;
  const child = `${noun}_entitlement`;
  const parentRef = `${camelize(noun)}Id`;
  const payoutEvent = frameKey(`${noun}_payout`);
  const parentRequirement = (statuses: readonly string[]): Json => ({
    [parentRef]: {
      bind: {
        currency: "fields.currency",
        [`${camelize(settlement.source)}AccountId`]: `fields.${camelize(settlement.source)}AccountId`,
      },
      statuses,
    },
  });
  return {
    design: [
      `${noun}: reuses the catalog largest-remainder distribution; the evidence port freezes the claimant set before any payout`,
    ],
    extraNouns: [
      {
        actors: {
          [settlement.recipient]: "beneficiary",
          [settlement.source]: "payer",
        },
        desc: `One frozen weighted entitlement in ${noun}`,
        fields: {
          currency: {
            desc: "Currency derived from the distribution",
            type: "currency",
          },
          [parentRef]: { desc: `The exact ${noun}`, type: `ref:${noun}` },
          [settlement.weight.name]: moneyFieldSpec(
            "Stored non-negative entitlement weight",
          ),
        },
        id: child,
        summary: `Frozen entitlement in ${noun}`,
        title: `${titleize(noun)} Entitlement`,
        verbs: {
          create: {
            requires: parentRequirement(["open"]),
            summary: "Record one entitlement before snapshot",
            to: "recorded",
          },
          payout: {
            distribute: {
              amountRef: "payoutShare",
              onZero: "skip_steps",
              pool: {
                from: "parent",
                path: `fields.${settlement.amount.name}`,
              },
              refField: parentRef,
              statuses: ["recorded", "paid"],
              weightField: settlement.weight.name,
            },
            from: ["recorded"],
            moneyEvent: payoutEvent,
            moves: [
              {
                amount: "refs.payoutShare",
                from: settlement.source,
                key: "payout",
                operation: "create",
                to: settlement.recipient,
              },
            ],
            requires: {
              [parentRef]: {
                match: {
                  "fields.currency": "fields.currency",
                  [`fields.${camelize(settlement.source)}AccountId`]: `fields.${camelize(settlement.source)}AccountId`,
                },
                statuses: ["snapshotted"],
              },
            },
            summary: "Pay the deterministic largest-remainder share once",
            to: "paid",
          },
        },
      },
    ],
    generatedPrefixNounIds: [child],
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount: "A deterministic largest-remainder share of the stored pool",
        fromActor: settlement.source,
        key: payoutEvent,
        kind: "payout",
        occurrence: "repeatable",
        toActor: settlement.recipient,
        trigger: "Pay one frozen entitlement",
      }),
    ],
    noun: {
      actors: { [settlement.source]: "payer" },
      aggregateInvariants: [
        {
          count: true,
          childNounId: child,
          childRefField: parentRef,
          childStatuses: ["recorded", "paid"],
          parentField: "maxRecipients",
        },
      ],
      desc: "Evidence-frozen weighted distribution",
      fields: {
        currency: {
          desc: `Currency fixed to ${settlement.amount.currency}`,
          type: "currency",
        },
        [settlement.amount.name]: moneyFieldSpec(
          `Distribution pool in ${settlement.amount.currency} minor units`,
        ),
        [settlement.recordAtField]: dateFieldSpec("Stored record date"),
        maxRecipients: {
          desc: `Exactly ${settlement.maxRecipients} frozen entitlement rows`,
          type: `const:${settlement.maxRecipients}`,
        },
      },
      id: noun,
      summary: "Frozen largest-remainder distribution",
      title: titleize(noun),
      verbs: {
        create: { summary: "Open entitlement recording", to: "open" },
        [settlement.snapshot.port]: {
          captureInput: { snapshotEvidenceReference: "evidenceReference" },
          from: ["open"],
          port: {
            allowed: snapshot.allowed,
            fields: { evidenceReference: "text" },
          },
          summary: "Freeze the entitlement set from stored evidence",
          to: "snapshotted",
        },
      },
    },
    rules: [],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// credit_facility: draw capacity only, repayment remains on scheduled obligation

function lowerCreditFacility(settlement: CheckedCreditFacility): LoweredNoun {
  const noun = settlement.name;
  const child = `${noun}_draw`;
  const facilityRef = `${camelize(noun)}Id`;
  const obligationRef = `${camelize(settlement.obligation.settlement)}Id`;
  const drawEvent = frameKey(`${noun}_draw`);
  const expiryRule = frameKey(`${noun}_expiry`);
  const countedStatuses =
    settlement.availabilityPolicy === "revolving"
      ? ["drawn"]
      : ["drawn", "resolved"];
  return {
    design: [
      `${noun}: owns reusable draw capacity only; ${settlement.obligation.settlement} remains the sole repayment and delinquency owner`,
    ],
    extraNouns: [
      {
        actors: {
          [settlement.drawDestination]: "beneficiary",
          [settlement.lender]: "payer",
        },
        desc: `One capacity-capped draw linked to ${settlement.obligation.settlement}`,
        fields: {
          amount: moneyFieldSpec("One draw amount"),
          currency: {
            desc: "Currency derived from the facility",
            type: "currency",
          },
          [facilityRef]: { desc: `The exact ${noun}`, type: `ref:${noun}` },
          [obligationRef]: {
            desc: "The sole repayment obligation",
            type: `ref:${settlement.obligation.settlement}`,
          },
        },
        id: child,
        summary: `Draw from ${noun}`,
        title: `${titleize(noun)} Draw`,
        verbs: {
          create: {
            moneyEvent: drawEvent,
            moves: [
              {
                amount: "amount",
                from: settlement.lender,
                key: "draw",
                operation: "create",
                to: settlement.drawDestination,
              },
            ],
            requires: {
              [facilityRef]: {
                bind: {
                  currency: "fields.currency",
                  [`${camelize(settlement.drawDestination)}AccountId`]: `fields.${camelize(settlement.drawDestination)}AccountId`,
                  [`${camelize(settlement.lender)}AccountId`]: `fields.${camelize(settlement.lender)}AccountId`,
                },
                statuses: ["active"],
              },
              [obligationRef]: { statuses: ["active"], unique: true },
            },
            requiresExposure: [
              {
                amountField: "amount",
                anchorField: facilityRef,
                capField: settlement.limit.name,
                capOnAnchor: true,
                childNounId: child,
                statuses: countedStatuses,
              },
            ],
            summary: "Create one draw under the locked facility capacity",
            to: "drawn",
          },
          resolve: {
            from: ["drawn"],
            requires: {
              [obligationRef]: ["repaid", "written_off"],
            },
            summary:
              "Release revolving capacity only after the linked obligation resolves",
            to: "resolved",
          },
        },
      },
    ],
    generatedPrefixNounIds: [child],
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount: "One draw under the stored facility limit",
        fromActor: settlement.lender,
        key: drawEvent,
        kind: "payout",
        occurrence: "repeatable",
        toActor: settlement.drawDestination,
        trigger: "Admit one linked draw",
      }),
    ],
    noun: {
      actors: {
        [settlement.borrower]: "party",
        [settlement.drawDestination]: "beneficiary",
        [settlement.lender]: "payer",
      },
      desc: "Reusable capacity with repayment delegated to one scheduled obligation",
      fields: {
        currency: {
          desc: `Currency fixed to ${settlement.limit.currency}`,
          type: "currency",
        },
        [settlement.limit.name]: moneyFieldSpec(
          `Facility limit in ${settlement.limit.currency} minor units`,
        ),
        [settlement.expiresAtField]: dateFieldSpec("Stored draw expiry"),
      },
      id: noun,
      summary: `Draw capacity for ${settlement.borrower.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs: {
        create: { summary: "Open the facility", to: "active" },
        freeze: {
          due: { field: settlement.expiresAtField, rule: expiryRule },
          from: ["active"],
          summary: "Freeze new draws at expiry",
          to: "frozen",
        },
        close: {
          from: ["active", "frozen"],
          requiresAggregate: [
            {
              check: { kind: "all_in" },
              nounId: child,
              over: "children",
              refField: facilityRef,
              statuses: ["resolved"],
            },
          ],
          summary: "Close only when every admitted draw resolved",
          to: "closed",
        },
      },
    },
    rules: [
      {
        allowedActors: [],
        detail:
          "The stored expiry freezes new draws without changing repayment state",
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: expiryRule,
        kind: "deadline",
        label: "Facility freezes at expiry",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// conditional_disbursement: one evidence-gated amount under a stored cap

function lowerConditionalDisbursement(
  settlement: CheckedConditionalDisbursement,
  decision: CheckedPort,
): LoweredNoun {
  const noun = settlement.name;
  const child = `${noun}_approved_amount`;
  const parentRef = `${camelize(noun)}Id`;
  const payoutEvent = frameKey(`${noun}_payout`);
  const sourceAccountField = `${camelize(settlement.source)}AccountId`;
  const destinationAccountField = `${camelize(settlement.destination)}AccountId`;
  const parentTransitionRequirement = {
    [parentRef]: {
      match: {
        "fields.currency": "fields.currency",
        [`fields.${destinationAccountField}`]: `fields.${destinationAccountField}`,
        [`fields.${sourceAccountField}`]: `fields.${sourceAccountField}`,
      },
      statuses: ["submitted"],
    },
  };
  return {
    design: [
      `${noun}: a stored external decision may approve one amount under the cap; recovery requires a separate transfer`,
    ],
    extraNouns: [
      {
        actors: {
          [settlement.destination]: "beneficiary",
          [settlement.source]: "payer",
        },
        desc: `One evidence-gated amount under ${noun}`,
        fields: {
          amount: moneyFieldSpec("Approved amount under the parent cap"),
          currency: {
            desc: "Currency derived from the parent cap",
            type: "currency",
          },
          [parentRef]: { desc: `The exact ${noun}`, type: `ref:${noun}` },
        },
        id: child,
        summary: `Approved amount under ${noun}`,
        title: `${titleize(noun)} Approved Amount`,
        verbs: {
          create: {
            requires: {
              [parentRef]: {
                bind: {
                  currency: "fields.currency",
                  [destinationAccountField]: `fields.${destinationAccountField}`,
                  [sourceAccountField]: `fields.${sourceAccountField}`,
                },
                statuses: ["submitted"],
                unique: true,
              },
            },
            summary: "Create one candidate amount under the parent",
            to: "created",
          },
          approve: {
            captureInput: { decisionEvidenceReference: "evidenceReference" },
            from: ["created"],
            port: {
              allowed: decision.allowed,
              fields: { evidenceReference: "text" },
            },
            requires: parentTransitionRequirement,
            requiresExposure: [
              {
                amountField: "amount",
                anchorField: parentRef,
                capField: settlement.cap.name,
                capOnAnchor: true,
                childNounId: child,
                statuses: ["approved", "paid"],
              },
            ],
            summary: "Store one externally approved amount under the cap",
            to: "approved",
          },
          pay: {
            from: ["approved"],
            moneyEvent: payoutEvent,
            moves: [
              {
                amount: "amount",
                from: settlement.source,
                key: "payout",
                operation: "create",
                to: settlement.destination,
              },
            ],
            requires: parentTransitionRequirement,
            summary: "Pay the stored approved amount once",
            to: "paid",
          },
        },
      },
    ],
    generatedPrefixNounIds: [child],
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount: "The stored approved amount under the cap",
        fromActor: settlement.source,
        key: payoutEvent,
        kind: "payout",
        occurrence: "repeatable",
        toActor: settlement.destination,
        trigger: "Pay one approved amount",
      }),
    ],
    noun: {
      actors: {
        [settlement.destination]: "beneficiary",
        [settlement.source]: "payer",
      },
      desc: "Capped disbursement controlled by stored external evidence",
      fields: {
        currency: {
          desc: `Currency fixed to ${settlement.cap.currency}`,
          type: "currency",
        },
        [settlement.cap.name]: moneyFieldSpec(
          `Disbursement cap in ${settlement.cap.currency} minor units`,
        ),
      },
      id: noun,
      summary: `Capped disbursement to ${settlement.destination.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs: {
        create: { summary: "Submit the capped disbursement", to: "submitted" },
        deny: {
          captureInput: { decisionEvidenceReference: "evidenceReference" },
          from: ["submitted"],
          port: {
            allowed: decision.allowed,
            fields: { evidenceReference: "text" },
          },
          requiresAggregate: [
            {
              check: { kind: "all_in" },
              nounId: child,
              over: "children",
              refField: parentRef,
              statuses: ["created"],
            },
          ],
          summary: "Record a denial without moving money",
          to: "denied",
        },
      },
    },
    rules: [],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// rotating_pool: fixed roster, one contribution per member and cycle

function lowerRotatingPool(settlement: CheckedRotatingPool): LoweredNoun {
  const noun = settlement.name;
  const parentRef = `${camelize(noun)}Id`;
  const contributionEvent = frameKey(`${noun}_contribution`);
  const guaranteeEvent = frameKey(`${noun}_guarantee_contribution`);
  const payoutEvent = frameKey(`${noun}_payout`);
  const fixedActors = [
    ...new Set([
      ...settlement.members,
      ...settlement.payoutOrder,
      ...(settlement.guarantor ? [settlement.guarantor] : []),
    ]),
  ];
  const fixedActorBindings = Object.fromEntries(
    fixedActors.map((actor) => {
      const accountField = `${camelize(actor)}AccountId`;
      return [accountField, `fields.${accountField}`];
    }),
  );
  const childIds = settlement.members.map(
    (member) => `${noun}_${member}_contribution`,
  );
  const childNouns = settlement.members.map((member, memberIndex): Json => {
    const id = childIds[memberIndex] as string;
    const verbs: Json = {
      create: {
        requires: {
          [parentRef]: {
            bind: {
              currency: "fields.currency",
              ...fixedActorBindings,
              [settlement.schedule.firstDueField]:
                `fields.${settlement.schedule.firstDueField}`,
              [settlement.contribution.name]:
                `fields.${settlement.contribution.name}`,
            },
            statuses: ["forming"],
            unique: true,
          },
        },
        summary: `Create the fixed contribution row for ${member.replaceAll("_", " ")}`,
        to: "cycle_1_due",
      },
    };
    for (let index = 0; index < settlement.schedule.count; index += 1) {
      const cycle = index + 1;
      const dueState = `cycle_${cycle}_due`;
      const defaultState = `cycle_${cycle}_defaulted`;
      const fundedState = `cycle_${cycle}_funded`;
      const guaranteedState = `cycle_${cycle}_guaranteed`;
      const nextState =
        cycle === settlement.schedule.count
          ? "final_paid"
          : `cycle_${cycle + 1}_due`;
      const dueRule = frameKey(`${noun}_cycle_${cycle}_due`);
      const cycleAmount = settlement.contribution.name;
      const guaranteeAmount = settlement.contribution.name;
      const due = {
        field: settlement.schedule.firstDueField,
        rule: dueRule,
        ...anchorOffset(settlement.schedule, index),
      };
      verbs[`contribute_cycle_${cycle}`] = {
        due,
        from: [dueState],
        moneyEvent: contributionEvent,
        moves: [
          {
            amount: cycleAmount,
            from: member,
            key: "contribution",
            operation: "create",
            to: "escrow",
          },
        ],
        requires: { [parentRef]: [`active_cycle_${cycle}`] },
        summary: `Fund ${member.replaceAll("_", " ")}'s cycle ${cycle} contribution`,
        to: fundedState,
      };
      verbs[`mark_default_cycle_${cycle}`] = {
        due,
        from: [dueState],
        requires: { [parentRef]: [`active_cycle_${cycle}`] },
        summary: `Mark the stored cycle ${cycle} due condition`,
        to: defaultState,
      };
      if (settlement.guarantor) {
        verbs[`guarantee_cycle_${cycle}`] = {
          from: [defaultState],
          moneyEvent: guaranteeEvent,
          moves: [
            {
              amount: guaranteeAmount,
              from: settlement.guarantor,
              key: "guarantee",
              operation: "create",
              to: "escrow",
            },
          ],
          requires: { [parentRef]: [`active_cycle_${cycle}`] },
          summary: `Fund the defaulted cycle ${cycle} amount before payout`,
          to: guaranteedState,
        };
      }
      verbs[`pay_cycle_${cycle}`] = {
        from: [fundedState],
        moneyEvent: payoutEvent,
        moves: [
          {
            amount: cycleAmount,
            from: "escrow",
            key: "payout",
            operation: "create",
            to: settlement.payoutOrder[index],
          },
        ],
        requires: { [parentRef]: [`cycle_${cycle}_ready`] },
        summary: `Pay this member's stored contribution into cycle ${cycle}'s shared pot recipient`,
        to: nextState,
      };
      if (settlement.guarantor) {
        verbs[`pay_guaranteed_cycle_${cycle}`] = {
          from: [guaranteedState],
          moneyEvent: payoutEvent,
          moves: [
            {
              amount: guaranteeAmount,
              from: "escrow",
              key: "payout",
              operation: "create",
              to: settlement.payoutOrder[index],
            },
          ],
          requires: { [parentRef]: [`cycle_${cycle}_ready`] },
          summary: `Pay the funded default into cycle ${cycle}'s stored recipient`,
          to: nextState,
        };
      }
    }
    verbs.close = {
      from: ["final_paid"],
      requiresDrainedAccount: { path: "refs.escrowAccountId" },
      summary: "Complete after the final payout drains this member custody",
      to: "completed",
    };
    return {
      actors: Object.fromEntries([
        [member, "payer"],
        ...(settlement.guarantor ? [[settlement.guarantor, "payer"]] : []),
        ...settlement.payoutOrder.map((recipient) => [
          recipient,
          "beneficiary",
        ]),
      ]),
      desc: `Fixed contribution row for ${member.replaceAll("_", " ")}`,
      escrow: true,
      fields: {
        [settlement.contribution.name]: moneyFieldSpec(
          "Exact contribution amount shared by every cycle",
        ),
        currency: { desc: "Currency derived from the pool", type: "currency" },
        [settlement.schedule.firstDueField]: dateFieldSpec(
          "First due anchor derived from the pool",
        ),
        [parentRef]: { desc: `The exact ${noun}`, type: `ref:${noun}` },
      },
      id,
      summary: `${member.replaceAll("_", " ")} contribution row`,
      title: `${titleize(noun)} ${titleize(member)} Contribution`,
      verbs,
    };
  });
  const parentVerbs: Json = {
    create: {
      summary: "Create the fixed roster before activation",
      to: "forming",
    },
    cancel: {
      from: ["forming"],
      summary: "Cancel before activation without moving money",
      to: "cancelled",
    },
    activate: {
      from: ["forming"],
      requiresAggregate: childIds.map((childId) => ({
        check: { kind: "count_equals_field", field: "one" },
        nounId: childId,
        over: "children",
        refField: parentRef,
        statuses: ["cycle_1_due"],
      })),
      summary: "Activate only after every fixed member row exists once",
      to: "active_cycle_1",
    },
  };
  for (let index = 0; index < settlement.schedule.count; index += 1) {
    const cycle = index + 1;
    parentVerbs[`ready_cycle_${cycle}`] = {
      from: [`active_cycle_${cycle}`],
      requiresAggregate: childIds.map((childId) => ({
        check: { kind: "all_in" },
        nounId: childId,
        over: "children",
        refField: parentRef,
        statuses: [
          `cycle_${cycle}_funded`,
          ...(settlement.guarantor ? [`cycle_${cycle}_guaranteed`] : []),
        ],
      })),
      summary: `Lock cycle ${cycle} only after every member row is funded or guaranteed`,
      to: `cycle_${cycle}_ready`,
    };
    parentVerbs[`advance_cycle_${cycle}`] = {
      from: [`cycle_${cycle}_ready`],
      requiresAggregate: childIds.map((childId) => ({
        check: { kind: "all_in" },
        nounId: childId,
        over: "children",
        refField: parentRef,
        statuses: [
          cycle === settlement.schedule.count
            ? "completed"
            : `cycle_${cycle + 1}_due`,
        ],
      })),
      summary:
        cycle === settlement.schedule.count
          ? "Complete after the final shared pot pays"
          : `Advance after every cycle ${cycle} contribution pays`,
      to:
        cycle === settlement.schedule.count
          ? "completed"
          : `active_cycle_${cycle + 1}`,
    };
  }
  return {
    design: [
      `${noun}: fixed roster and stored payout order; one member-specific row per member avoids tuple identity and keeps each cycle idempotent`,
    ],
    extraNouns: childNouns,
    generatedPrefixNounIds: childIds,
    feeLines: [],
    moneyEvents: [
      mintEvent({
        amount: "One exact member contribution",
        fromActor: settlement.members[0] as string,
        key: contributionEvent,
        kind: "charge",
        occurrence: "repeatable",
        toActor: "escrow",
        trigger: "Fund one member and cycle",
      }),
      ...(settlement.guarantor
        ? [
            mintEvent({
              amount: "One exact defaulted contribution",
              fromActor: settlement.guarantor,
              key: guaranteeEvent,
              kind: "charge",
              occurrence: "repeatable",
              toActor: "escrow",
              trigger: "Fund one defaulted member and cycle",
            }),
          ]
        : []),
      mintEvent({
        amount: "One exact member contribution from the cycle pot",
        fromActor: "escrow",
        key: payoutEvent,
        kind: "payout",
        occurrence: "repeatable",
        toActor: settlement.payoutOrder[0] as string,
        trigger: "Pay the stored cycle recipient",
      }),
    ],
    noun: {
      actors: Object.fromEntries([
        ...settlement.members.map((member) => [member, "party"]),
        ...(settlement.guarantor ? [[settlement.guarantor, "payer"]] : []),
      ]),
      desc: "Fixed rotating contribution and payout order",
      fields: {
        currency: {
          desc: `Currency fixed to ${settlement.contribution.currency}`,
          type: "currency",
        },
        [settlement.contribution.name]: moneyFieldSpec(
          `Exact contribution in ${settlement.contribution.currency} minor units`,
        ),
        [settlement.schedule.firstDueField]: dateFieldSpec(
          "Stored first contribution due date",
        ),
        one: { desc: "Exact fixed member-row count", type: "const:1" },
      },
      id: noun,
      summary: `${settlement.members.length}-member rotating pool`,
      title: titleize(noun),
      verbs: parentVerbs,
    },
    rules: Array.from({ length: settlement.schedule.count }, (_, index) => ({
      allowedActors: [],
      detail: `Cycle ${index + 1} default follows its stored due condition`,
      dueDriven: true,
      enforcement: "platform",
      gatesEvent: null,
      key: frameKey(`${noun}_cycle_${index + 1}_due`),
      kind: "deadline",
      label: `Cycle ${index + 1} due condition`,
      tenantTunable: false,
    })),
    settlement: { name: noun, pieces: [] },
  };
}

function anchorOffset(schedule: ScheduleTerms, index: number): Json {
  return index === 0 ? {} : { offset: `P${schedule.every.days * index}D` };
}

/**
 * Obligation mode extends the existing schedule instead of minting a second
 * repayment archetype. The parent stores every anchor amount and date. One
 * generated payment noun per anchor makes matching exact at the operation
 * boundary and lets the generic aggregate lock cap concurrent partial pays.
 */
function lowerScheduledObligation(
  settlement: CheckedScheduledObligation,
  collection?: CheckedRecurringCollection,
  collectionMandate?: CheckedPort,
): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const obligationIdField = `${noun.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}Id`;
  const widths = evenPieceBps(settlement.schedule.count);
  const installmentFields = widths.map(
    (_, index) => `installment${index + 1}Amount`,
  );
  const paymentNouns = widths.map(
    (_, index) => `${noun}_installment_${index + 1}_payment`,
  );
  const activeState = "active";
  const delinquentState = (index: number) =>
    `installment_${index + 1}_delinquent`;
  const delinquentStates = widths.map((_, index) => delinquentState(index));
  const liveStates = [activeState, ...delinquentStates];
  const repaymentEvent = frameKey(`${noun}_repayment`);
  const refundEvent = frameKey(`${noun}_refund`);
  const advanceEvent = frameKey(`${noun}_advance`);

  const fields: Json = {
    currency: {
      desc: `Currency fixed to ${settlement.amount.currency}`,
      type: "currency",
    },
    [amountName]: moneyFieldSpec(
      `The principal in ${settlement.amount.currency} minor units; the stored installment anchors partition it exactly`,
    ),
    [settlement.schedule.firstDueField]: dateFieldSpec(
      `Due date of the first installment; later anchors use fixed offsets of ${settlement.schedule.every.raw}`,
    ),
  };
  for (const [index, field] of installmentFields.entries()) {
    fields[field] = moneyFieldSpec(
      `Stored amount for installment ${index + 1} of ${settlement.schedule.count}${index === 0 ? " (carries the integer-division remainder)" : ""}`,
    );
    fields[`installment${index + 1}DelinquentAfter`] = optionalDateFieldSpec(
      `Machine-set marker proving installment ${index + 1} reached its stored due date while unpaid`,
    );
  }

  const aggregateInvariants = paymentNouns.map((paymentNoun, index) => ({
    childField: "amount",
    childNounId: paymentNoun,
    childRefField: obligationIdField,
    childStatuses: ["paid"],
    parentField: installmentFields[index],
  }));

  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()} obligation`,
      to: "draft",
    },
    approve: {
      from: ["draft"],
      summary: "Approve the immutable principal partition and stored anchors",
      to: settlement.advanceTo ? "approved" : activeState,
    },
    ...(settlement.advanceTo
      ? {
          advance: {
            from: ["approved"],
            moneyEvent: advanceEvent,
            moves: [
              {
                amount: amountName,
                from: settlement.payee,
                key: "advance",
                operation: "create",
                to: settlement.advanceTo,
              },
            ],
            summary: `Advance the principal to the ${settlement.advanceTo.replaceAll("_", " ")}; the internal ledger receipt is the confirmation`,
            to: activeState,
          },
        }
      : {}),
    write_off: {
      from: [
        "draft",
        ...(settlement.advanceTo ? ["approved"] : []),
        ...liveStates,
      ],
      summary: "Write off the remaining exposure without moving money",
      to: "written_off",
    },
  };

  const rules: Json[] = [];
  for (const [index, paymentNoun] of paymentNouns.entries()) {
    const anchor = index + 1;
    const ruleKey = frameKey(`${noun}_installment_${anchor}_due`);
    const due = {
      field: settlement.schedule.firstDueField,
      rule: ruleKey,
      ...anchorOffset(settlement.schedule, index),
    };
    const aggregate = (kind: "sum_below" | "sum_exactly"): Json[] => [
      {
        check: {
          amountField: "amount",
          kind,
          targetField: installmentFields[index],
        },
        nounId: paymentNoun,
        over: "children",
        refField: obligationIdField,
        statuses: ["paid"],
      },
    ];
    verbs[`mark_installment_${anchor}_delinquent`] = {
      due,
      from: liveStates.filter((state) => state !== delinquentState(index)),
      requiresAggregate: aggregate("sum_below"),
      setsAt: {
        field: `installment${anchor}DelinquentAfter`,
        marker: true,
        offset: "PT1S",
      },
      summary: `Mark installment ${anchor} delinquent only when its due anchor is unmet`,
      to: delinquentState(index),
    };
    verbs[`collect_installment_${anchor}`] = {
      due,
      from: delinquentStates,
      requiresAggregate: aggregate("sum_exactly"),
      summary: `Close delinquent installment ${anchor} after linked payments reach its stored amount`,
      to: activeState,
    };
    rules.push({
      allowedActors: [],
      detail: `At stored anchor ${anchor}, the platform compares paid child rows with ${installmentFields[index]} and chooses paid or delinquent`,
      dueDriven: true,
      enforcement: "platform",
      gatesEvent: null,
      key: ruleKey,
      kind: "deadline",
      label: `Installment ${anchor} resolves from its stored due condition`,
      tenantTunable: false,
    });
  }

  const completionRuleKey = frameKey(`${noun}_completion_due`);
  verbs.complete = {
    due: {
      field: settlement.schedule.firstDueField,
      rule: completionRuleKey,
      ...anchorOffset(settlement.schedule, widths.length - 1),
    },
    from: liveStates,
    requiresAggregate: paymentNouns.map((paymentNoun, index) => ({
      check: {
        amountField: "amount",
        kind: "sum_exactly",
        targetField: installmentFields[index],
      },
      nounId: paymentNoun,
      over: "children",
      refField: obligationIdField,
      statuses: ["paid"],
    })),
    summary:
      "Close the obligation only after every stored anchor is paid exactly",
    to: "repaid",
  };
  rules.push({
    allowedActors: [],
    detail:
      "After the final stored anchor, the platform closes only when every anchor is paid exactly",
    dueDriven: true,
    enforcement: "platform",
    gatesEvent: null,
    key: completionRuleKey,
    kind: "deadline",
    label: "Obligation completion follows exact aggregate repayment",
    tenantTunable: false,
  });

  const paymentNoun = (index: number): Json => {
    const anchor = index + 1;
    const id = paymentNouns[index] as string;
    const permittedParentStates = liveStates;
    const payerAccountField = `${settlement.payer.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}AccountId`;
    const payeeAccountField = `${settlement.payee.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}AccountId`;
    const createRequirement = {
      [obligationIdField]: {
        bind: {
          currency: "fields.currency",
          [payerAccountField]: `fields.${payerAccountField}`,
          [payeeAccountField]: `fields.${payeeAccountField}`,
        },
        statuses: permittedParentStates,
      },
    };
    const transitionRequirement = {
      [obligationIdField]: {
        match: {
          "fields.currency": "fields.currency",
          [`fields.${payerAccountField}`]: `fields.${payerAccountField}`,
          [`fields.${payeeAccountField}`]: `fields.${payeeAccountField}`,
        },
        statuses: permittedParentStates,
      },
    };
    return {
      actors: {
        [settlement.payee]: "beneficiary",
        [settlement.payer]: "payer",
      },
      desc: `One partial or full payment bound to installment ${anchor} of ${noun}; the operation name fixes the anchor and ${obligationIdField} fixes the obligation`,
      fields: {
        amount: moneyFieldSpec(
          `Positive payment amount capped with its paid siblings at ${installmentFields[index]}`,
        ),
        currency: {
          desc: "ISO 4217 currency derived from the obligation",
          type: "currency",
        },
        [obligationIdField]: {
          desc: `The exact ${noun.replaceAll("_", " ")} this payment belongs to`,
          type: `ref:${noun}`,
        },
      },
      id,
      summary: `Anchor-bound payment for installment ${anchor}`,
      title: `${titleize(noun)} Installment ${anchor} Payment`,
      verbs: {
        create: {
          requires: createRequirement,
          summary: `Create a payment record for installment ${anchor}`,
          to: "created",
        },
        repay: {
          ...(collection && collectionMandate
            ? {
                captureInput: {
                  mandateEvidenceReference: "evidenceReference",
                },
                port: {
                  allowed: collectionMandate.allowed,
                  fields: { evidenceReference: "text" },
                },
              }
            : {}),
          from: ["created"],
          moneyEvent: repaymentEvent,
          moves: [
            {
              amount: "amount",
              from: settlement.payer,
              key: "repayment",
              operation: "create",
              to: settlement.payee,
            },
          ],
          requires: transitionRequirement,
          requiresExposure: [
            {
              amountField: "amount",
              anchorField: obligationIdField,
              capField: installmentFields[index],
              capOnAnchor: true,
              childNounId: id,
              statuses: ["paid"],
            },
          ],
          summary: `Pay a partial or full amount against installment ${anchor}`,
          to: "paid",
        },
        refund: {
          from: ["paid"],
          moneyEvent: refundEvent,
          moves: [
            {
              amount: "amount",
              from: settlement.payee,
              key: "refund",
              operation: "create",
              to: settlement.payer,
            },
          ],
          requires: transitionRequirement,
          summary: `Refund this one stored installment ${anchor} payment whole`,
          to: "refunded",
        },
      },
    };
  };

  return {
    design: [
      `${noun}: existing scheduled mechanism in obligation mode; principal partitions into ${settlement.schedule.count} stored anchors; each payment operation names one anchor and one obligation`,
      `${noun}: partial and early payments serialize under per-anchor aggregate caps; each refund reverses one paid row whole; rescheduling is refused by the checker`,
      `${noun}: due-only delinquency and write-off change state without money; ${settlement.advanceTo ? "advance is an internal ledger movement with no provider claim" : "no advance is emitted"}`,
      ...(collection
        ? [
            `${collection.name}: explicit collection attempts reuse ${noun}'s anchor-bound repayment verbs; mandate evidence is captured per attempt; failures remain receipted failures and delinquency stays on ${noun}`,
          ]
        : []),
    ],
    extraNouns: paymentNouns.map((_, index) => paymentNoun(index)),
    generatedPrefixNounIds: paymentNouns,
    feeLines: [],
    moneyEvents: [
      ...(settlement.advanceTo
        ? [
            mintEvent({
              amount: `The full ${amountName}`,
              fromActor: settlement.payee,
              key: advanceEvent,
              kind: "payout",
              toActor: settlement.advanceTo,
              trigger: "Advance the approved principal once",
            }),
          ]
        : []),
      mintEvent({
        amount: "A positive amount capped by its stored installment anchor",
        fromActor: settlement.payer,
        key: repaymentEvent,
        kind: "installment",
        occurrence: "repeatable",
        toActor: settlement.payee,
        trigger: "Pay one anchor-bound partial or full installment amount",
      }),
      mintEvent({
        amount: "Exactly one stored paid installment payment",
        fromActor: settlement.payee,
        key: refundEvent,
        kind: "refund",
        occurrence: "repeatable",
        toActor: settlement.payer,
        trigger: "Refund one linked paid installment payment whole",
      }),
    ],
    noun: {
      actors: {
        ...(settlement.advanceTo
          ? { [settlement.advanceTo]: "beneficiary" }
          : {}),
        [settlement.payee]: "beneficiary",
        [settlement.payer]: "payer",
        [settlement.debtor]: "party",
      },
      aggregateInvariants,
      desc: `Installment obligation for ${settlement.debtor.replaceAll("_", " ")}; ${settlement.payer.replaceAll("_", " ")} pays ${settlement.payee.replaceAll("_", " ")} against exact stored anchors`,
      fields,
      id: noun,
      ...partitionsSpread(partitionClause(amountName, installmentFields)),
      summary: `${settlement.schedule.count}-anchor obligation for ${settlement.debtor.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules,
    settlement: { name: noun, pieces: [] },
  };
}

function lowerScheduled(settlement: CheckedScheduled): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const { schedule } = settlement;
  const ruleKey = `${noun}_schedule`;
  const widths = evenPieceBps(schedule.count);

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      `The total scheduled amount in ${settlement.amount.currency} minor units; the installment fields below partition it exactly`,
    ),
    [schedule.firstDueField]: dateFieldSpec(
      `Due date of the first installment; installment k falls ${schedule.every.raw} after its predecessor`,
    ),
  };
  const installmentFields = widths.map((_, index) => {
    const field = `installment${index + 1}Amount`;
    fields[field] = moneyFieldSpec(
      `Installment ${index + 1} of ${schedule.count}${index === 0 ? " (carries the integer-division remainder)" : ""}: about ${formatBps(widths[index] as number)} of ${amountName}, collected on its own stored-date anchor`,
    );
    return field;
  });

  const payVerbs = widths.map((_, index) => `pay_installment_${index + 1}`);
  const payStates = chain(payVerbs, "active", "settled", "collecting");

  // The whole schedule is ONE money event (occurrence: repeatable): the
  // budget counts money BEHAVIORS, not anchors, so a longer schedule never
  // crowds out a composite program's other settlements. The document still
  // unrolls to one idempotent anchor verb per installment, all implementing
  // the same event key.
  const eventKey = `${noun}_installments`;
  const events: Json[] = [
    mintEvent({
      amount: `The ${amountName}, partitioned into ${schedule.count} installments`,
      fromActor: settlement.payer,
      key: eventKey,
      kind: "installment",
      occurrence: "repeatable",
      toActor: settlement.payee,
      trigger: `Collect each of the ${schedule.count} installments on its stored due date`,
    }),
  ];
  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()} plan`,
      to: "active",
    },
  };
  for (const [index, field] of installmentFields.entries()) {
    verbs[payVerbs[index] as string] = {
      due: {
        field: schedule.firstDueField,
        rule: ruleKey,
        ...anchorOffset(schedule, index),
      },
      from: [payStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: field,
          from: settlement.payer,
          to: settlement.payee,
        },
      ],
      summary: `Collect installment ${index + 1} of ${schedule.count}`,
      to: payStates[index]?.to,
    };
  }

  return {
    design: [
      `${noun}: ${schedule.count} installments every ${schedule.every.raw} from ${schedule.firstDueField}; finite by construction, one idempotent anchor per installment`,
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        [settlement.payee]: "beneficiary",
      },
      desc: `Scheduled payment: the ${settlement.payer.replaceAll("_", " ")} pays ${amountName} to the ${settlement.payee.replaceAll("_", " ")} in ${schedule.count} installments, one every ${schedule.every.raw}`,
      fields,
      id: noun,
      ...partitionsSpread(partitionClause(amountName, installmentFields)),
      summary: `${schedule.count}-installment schedule from ${settlement.payer.replaceAll("_", " ")} to ${settlement.payee.replaceAll("_", " ")}`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail: `Each of the ${schedule.count} installments is collected once from its stored due date`,
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: ruleKey,
        kind: "deadline",
        label: "Installments collected on their stored due dates",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

function lowerAdvance(
  settlement: CheckedAdvance,
  recourses: readonly CheckedScheduled[],
): LoweredNoun {
  return settlement.source.kind === "carve"
    ? lowerCarvedAdvance(settlement, settlement.source.settlement, recourses)
    : lowerScheduledAdvance(settlement, settlement.source.schedule);
}

/**
 * `advance { against: <hold>.release }`. The repayment leg is not this noun's
 * to make: the hold releases the financed party's whole share straight to the
 * funder, so what stays here is the disbursement, the terms the funder is
 * owed on, and the close that records the carve landing. An advance carved
 * this way can never pay out more than the hold already holds.
 */
function lowerCarvedAdvance(
  settlement: CheckedAdvance,
  hold: string,
  recourses: readonly CheckedScheduled[],
): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const hasFee = settlement.feeBps > 0;
  const advancedWords = settlement.advanced.replaceAll("_", " ");
  const funderWords = settlement.funder.replaceAll("_", " ");
  const holdWords = hold.replaceAll("_", " ");
  const holdRefField = "carveHoldId";
  const referenceBindings = [
    { field: holdRefField, statuses: ["funded"], target: hold },
    ...recourses.map((recourse, index) => ({
      field: `carveRecourse${index + 1}Id`,
      statuses: ["active"],
      target: recourse.name,
    })),
  ];

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      `The advanced amount in ${settlement.amount.currency} minor units, disbursed to the ${advancedWords} up front`,
    ),
    ...Object.fromEntries(
      referenceBindings.map((binding) => [
        binding.field,
        {
          desc: `The ${binding.target.replaceAll("_", " ")} bound to this advance`,
          type: `ref:${binding.target}`,
        },
      ]),
    ),
    ...(hasFee
      ? {
          feeAmount: moneyFieldSpec(
            `${formatBps(settlement.feeBps)} of ${amountName}, the funder's discount owed on top of the advance`,
          ),
          repayableAmount: moneyFieldSpec(
            `${amountName} + feeAmount: what the ${holdWords} release owes the ${funderWords}`,
          ),
        }
      : {}),
  };

  return {
    design: [
      `${noun}: ${amountName} advanced to the ${settlement.advanced} up front and repaid by carving the ${hold} release${hasFee ? `; repayableAmount = ${amountName} + ${formatBps(settlement.feeBps)} fee` : ""}`,
    ],
    feeLines: hasFee
      ? [
          {
            label: `${titleize(settlement.funder)} discount`,
            on: `each ${noun.replaceAll("_", " ")}`,
            structure: `${formatBps(settlement.feeBps)} of the ${amountName}, owed on top out of the ${holdWords} release`,
          },
        ]
      : [],
    moneyEvents: [
      mintEvent({
        amount: `The full ${amountName}`,
        fromActor: settlement.funder,
        key: `${noun}_disburse`,
        kind: "payout",
        toActor: settlement.advanced,
        trigger: `Disburse the advance to the ${advancedWords}`,
      }),
    ],
    noun: {
      actors: {
        [settlement.advanced]: "beneficiary",
        [settlement.funder]: "payer",
      },
      desc: `Advance: the ${funderWords} disburses ${amountName} to the ${advancedWords} and is repaid out of the ${holdWords} release, which pays the ${funderWords} in the ${advancedWords}'s place${hasFee ? ", plus the funder's discount" : ""}`,
      fields,
      id: noun,
      ...partitionsSpread(
        hasFee
          ? partitionClause("repayableAmount", [amountName, "feeAmount"])
          : [],
      ),
      summary: `Advance to the ${advancedWords} repaid by carving the ${holdWords} release`,
      title: titleize(noun),
      verbs: {
        create: {
          summary: `Create a ${titleize(noun).toLowerCase()}`,
          to: "created",
        },
        disburse: {
          from: ["created"],
          moneyEvent: `${noun}_disburse`,
          moves: [
            {
              key: "transfer",
              operation: "create",
              amount: amountName,
              from: settlement.funder,
              to: settlement.advanced,
            },
          ],
          requires: Object.fromEntries(
            referenceBindings.map((binding) => [
              binding.field,
              {
                match: {
                  [`fields.${amountName}`]: `fields.${amountName}`,
                  "fields.currency": "fields.currency",
                },
                statuses: binding.statuses,
              },
            ]),
          ),
          summary: `Disburse the ${amountName} to the ${advancedWords}`,
          to: "advanced",
        },
        // Moneyless by construction: the repayment already moved, on the hold.
        // This verb only records that it did, so the advance has a close
        // instead of resting forever in the state it was disbursed in.
        settle: {
          from: ["advanced"],
          summary: `Close the advance once the ${holdWords} has released to the ${funderWords}`,
          to: "repaid",
        },
      },
    },
    rules: [
      {
        allowedActors: [],
        detail: `The ${holdWords} releases the ${advancedWords}'s whole share to the ${funderWords} instead of to the ${advancedWords}; the advance is repaid out of that release and never out of new money`,
        dueDriven: false,
        enforcement: "platform",
        gatesEvent: null,
        key: `${noun}_carve`,
        kind: "release_condition",
        label: `Repaid by carving the ${holdWords} release`,
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

function lowerScheduledAdvance(
  settlement: CheckedAdvance,
  schedule: ScheduleTerms,
): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const ruleKey = `${noun}_schedule`;
  const widths = evenPieceBps(schedule.count);
  const hasFee = settlement.feeBps > 0;
  const repayableField = hasFee ? "repayableAmount" : amountName;

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      `The advanced amount in ${settlement.amount.currency} minor units, disbursed to the ${settlement.advanced.replaceAll("_", " ")} up front`,
    ),
    ...(hasFee
      ? {
          feeAmount: moneyFieldSpec(
            `${formatBps(settlement.feeBps)} of ${amountName}, the funder's discount repaid on top of the advance`,
          ),
          repayableAmount: moneyFieldSpec(
            `${amountName} + feeAmount: the total the repayment fields below partition exactly`,
          ),
        }
      : {}),
    [schedule.firstDueField]: dateFieldSpec(
      `Due date of the first repayment; repayment k falls ${schedule.every.raw} after its predecessor`,
    ),
  };
  const repaymentFields = widths.map((_, index) => {
    const field = `repayment${index + 1}Amount`;
    fields[field] = moneyFieldSpec(
      `Repayment ${index + 1} of ${schedule.count}${index === 0 ? " (carries the integer-division remainder)" : ""}: about ${formatBps(widths[index] as number)} of ${repayableField}, collected on its own stored-date anchor`,
    );
    return field;
  });

  const repayVerbs = widths.map((_, index) => `collect_repayment_${index + 1}`);
  const repayStates = chain(repayVerbs, "advanced", "repaid", "repaying");

  const events: Json[] = [
    mintEvent({
      amount: `The full ${amountName}`,
      fromActor: settlement.funder,
      key: `${noun}_disburse`,
      kind: "payout",
      toActor: settlement.advanced,
      trigger: `Disburse the advance to the ${settlement.advanced.replaceAll("_", " ")}`,
    }),
  ];
  const verbs: Json = {
    create: {
      summary: `Create a ${titleize(noun).toLowerCase()}`,
      to: "created",
    },
    disburse: {
      from: ["created"],
      moneyEvent: `${noun}_disburse`,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: amountName,
          from: settlement.funder,
          to: settlement.advanced,
        },
      ],
      summary: `Disburse the ${amountName} to the ${settlement.advanced.replaceAll("_", " ")}`,
      to: "advanced",
    },
  };
  // One repeatable event for the whole repayment schedule (see lowerScheduled:
  // the budget counts money behaviors, not anchors).
  const repayEventKey = `${noun}_repayments`;
  events.push(
    mintEvent({
      amount: `The ${repayableField}, partitioned into ${schedule.count} repayments`,
      fromActor: settlement.advanced,
      key: repayEventKey,
      kind: "installment",
      occurrence: "repeatable",
      toActor: settlement.funder,
      trigger: `Collect each of the ${schedule.count} repayments on its stored due date`,
    }),
  );
  for (const [index, field] of repaymentFields.entries()) {
    const eventKey = repayEventKey;
    verbs[repayVerbs[index] as string] = {
      due: {
        field: schedule.firstDueField,
        rule: ruleKey,
        ...anchorOffset(schedule, index),
      },
      from: [repayStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: field,
          from: settlement.advanced,
          to: settlement.funder,
        },
      ],
      summary: `Collect repayment ${index + 1} of ${schedule.count}`,
      to: repayStates[index]?.to,
    };
  }

  return {
    design: [
      `${noun}: ${amountName} advanced up front; ${schedule.count} repayments every ${schedule.every.raw} conserve against ${repayableField}${hasFee ? ` (advance + ${formatBps(settlement.feeBps)} fee)` : ""}`,
    ],
    feeLines: hasFee
      ? [
          {
            label: `${titleize(settlement.funder)} discount`,
            on: `each ${noun.replaceAll("_", " ")}`,
            structure: `${formatBps(settlement.feeBps)} of the ${amountName}, repaid on top of the advance`,
          },
        ]
      : [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.funder]: "payer",
        [settlement.advanced]: "beneficiary",
      },
      desc: `Advance: the ${settlement.funder.replaceAll("_", " ")} disburses ${amountName} to the ${settlement.advanced.replaceAll("_", " ")}, repaid over ${schedule.count} scheduled repayments${hasFee ? " plus the funder's discount" : ""}`,
      fields,
      id: noun,
      ...partitionsSpread([
        ...partitionClause(repayableField, repaymentFields),
        ...(hasFee
          ? partitionClause("repayableAmount", [amountName, "feeAmount"])
          : []),
      ]),
      summary: `Advance to ${settlement.advanced.replaceAll("_", " ")} repaid over ${schedule.count} anchors`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail: `Each of the ${schedule.count} repayments is collected once from its stored due date`,
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: ruleKey,
        kind: "deadline",
        label: "Repayments collected on their stored due dates",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// metered: each usage charge IS the ledger transfer

function lowerMetered(settlement: CheckedMetered): LoweredNoun {
  const noun = settlement.name;
  const ruleKey = `${noun}_period`;
  const currency = settlement.rates[0]?.field.currency ?? "SAR";

  const fields: Json = {
    [settlement.closeByField]: dateFieldSpec(
      "End of this metering period; the close makes further charges unreachable",
    ),
  };
  for (const rate of settlement.rates) {
    fields[rate.field.name] = moneyFieldSpec(
      `Per-unit price of ${rate.meter.replaceAll("_", " ")} in ${currency} minor units, committed at period open`,
    );
  }

  const events: Json[] = [];
  const verbs: Json = {
    close_period: {
      due: { field: settlement.closeByField, rule: ruleKey },
      from: ["open"],
      summary: "Close the metering period; no further usage can be charged",
      to: "closed",
    },
    create: {
      summary: `Open a ${titleize(noun).toLowerCase()} period with its committed rate card`,
      to: "open",
    },
  };
  for (const rate of settlement.rates) {
    const eventKey = frameKey(`${noun}_${rate.meter}`);
    events.push(
      mintEvent({
        amount: `The committed ${rate.field.name} per unit`,
        fromActor: settlement.payer,
        key: eventKey,
        kind: "charge",
        occurrence: "repeatable",
        timing: "external_schedule",
        toActor: settlement.payee,
        trigger: `Charge one ${rate.meter.replaceAll("_", " ")} at the committed rate`,
      }),
    );
    verbs[`charge_${rate.meter}`] = {
      from: ["open"],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: rate.field.name,
          from: settlement.payer,
          to: settlement.payee,
        },
      ],
      summary: `Charge one metered ${rate.meter.replaceAll("_", " ")}; the emission is the transfer itself`,
      to: "open",
    };
  }

  return {
    design: [
      `${noun}: committed rate card (${settlement.rates
        .map((rate) => rate.meter)
        .join(
          ", ",
        )}); each usage charge IS the ledger transfer; period closes on ${settlement.closeByField}`,
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        [settlement.payee]: "beneficiary",
      },
      desc: `Metered usage: the ${settlement.payer.replaceAll("_", " ")} is charged per unit at the committed rate card until the period closes on its stored end date`,
      fields,
      id: noun,
      summary: `Metered charges from ${settlement.payer.replaceAll("_", " ")} on a committed rate card`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail: "The period closes once from its stored end date",
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: ruleKey,
        kind: "deadline",
        label: "Period closed on its stored end date",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces: [] },
  };
}

// ---------------------------------------------------------------------------
// pooled_split: pool a period total piece-wise, distribute it exactly

function lowerPooledSplit(settlement: CheckedPooledSplit): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const ruleKey = `${noun}_payout`;
  const remainderIndex = settlement.shares.findIndex(
    (share) => share.to === settlement.remainderTo,
  );
  const pieces: LoweredPiece[] = settlement.shares.map((share) => ({
    bps: share.bps,
    field: `${camelize(share.to)}ShareAmount`,
    origin: share.origin,
    releaseTo: share.to,
  }));

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      `The pooled period total in ${settlement.amount.currency} minor units; the share fields below partition it exactly`,
    ),
    [settlement.distributeDueField]: dateFieldSpec(
      "The period's payout date; the pool distributes from it",
    ),
  };
  for (const [index, piece] of pieces.entries()) {
    const remainder =
      index === Math.max(remainderIndex, 0)
        ? " (carries the integer-division remainder)"
        : "";
    fields[piece.field] = moneyFieldSpec(
      `${formatBps(piece.bps)} of ${amountName}${remainder}: the ${piece.releaseTo.replaceAll("_", " ")}'s share. Computed as floor(${amountName} * ${piece.bps} / 10000) in ${settlement.amount.currency} minor units`,
    );
  }

  const fundVerbs = pieces.map((_, index) => `fund_share_${index + 1}`);
  const payoutVerbs = pieces.map((_, index) => `distribute_share_${index + 1}`);
  const fundStates = chain(fundVerbs, "created", "pooled", "pooling");
  const payoutStates = chain(
    payoutVerbs,
    "pooled",
    "distributed",
    "distributing",
  );

  const events: Json[] = [];
  const verbs: Json = {
    create: {
      summary: `Open a ${titleize(noun).toLowerCase()} period`,
      to: "created",
    },
  };
  for (const [index, piece] of pieces.entries()) {
    const eventKey = `${noun}_pool_${index + 1}`;
    events.push(
      mintEvent({
        amount: `${formatBps(piece.bps)} of the ${amountName}`,
        fromActor: settlement.payer,
        key: eventKey,
        kind: "charge",
        toActor: "escrow",
        trigger: `Pool the ${piece.releaseTo.replaceAll("_", " ")}'s share for the period`,
      }),
    );
    verbs[fundVerbs[index] as string] = {
      from: [fundStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: piece.field,
          from: settlement.payer,
          to: "escrow",
        },
      ],
      summary: `Pool share ${index + 1} of the period total`,
      to: fundStates[index]?.to,
    };
  }
  for (const [index, piece] of pieces.entries()) {
    const eventKey = `${noun}_payout_${index + 1}`;
    events.push(
      mintEvent({
        amount: `${formatBps(piece.bps)} of the ${amountName}`,
        fromActor: "escrow",
        key: eventKey,
        kind: "payout",
        toActor: piece.releaseTo,
        trigger: `Distribute the ${piece.releaseTo.replaceAll("_", " ")}'s share on the payout date`,
      }),
    );
    verbs[payoutVerbs[index] as string] = {
      due: { field: settlement.distributeDueField, rule: ruleKey },
      from: [payoutStates[index]?.from],
      moneyEvent: eventKey,
      moves: [
        {
          key: "transfer",
          operation: "create",
          amount: piece.field,
          from: "escrow",
          to: piece.releaseTo,
        },
      ],
      summary: `Distribute the ${piece.releaseTo.replaceAll("_", " ")}'s share of the pool`,
      to: payoutStates[index]?.to,
    };
  }

  return {
    design: [
      `${noun}: pool of ${amountName} partitioned ${pieces
        .map((piece) => `${formatBps(piece.bps)} ${piece.releaseTo}`)
        .join(
          " + ",
        )}; distributes in full on ${settlement.distributeDueField}; remainder to ${settlement.remainderTo}`,
    ],
    feeLines: [],
    moneyEvents: events,
    noun: {
      actors: {
        [settlement.payer]: "payer",
        ...Object.fromEntries(
          settlement.shares.map((share) => [share.to, "beneficiary"]),
        ),
      },
      desc: `Pooled split: the ${settlement.payer.replaceAll("_", " ")} pools the period's ${amountName} share by share; the pool distributes to every recipient in full on the stored payout date`,
      escrow: true,
      fields,
      id: noun,
      ...partitionsSpread(
        partitionClause(
          amountName,
          pieces.map((piece) => piece.field),
        ),
      ),
      summary: `Period pool from ${settlement.payer.replaceAll("_", " ")} split ${settlement.shares.length} ways`,
      title: titleize(noun),
      verbs,
    },
    rules: [
      {
        allowedActors: [],
        detail:
          "Every share of the pool distributes once from the stored payout date",
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        key: ruleKey,
        kind: "deadline",
        label: "Pool distributed on its stored payout date",
        tenantTunable: false,
      },
    ],
    settlement: { name: noun, pieces },
  };
}

// ---------------------------------------------------------------------------
// The finest-common-partition machinery

/** The slice of a held-family settlement the partition computation needs. */
interface PartitionInput {
  readonly amount: MoneyField;
  /** The funder an advance carved this release to, in the payee's place. */
  readonly carveTo?: string | undefined;
  readonly onCancel?: CancelPolicy | undefined;
  readonly payee: string;
  readonly payeeFeeBps: number;
}

/**
 * The finest common partition of the amount across both exits. Cut points
 * come from the release allocation (payee share, then the payee-side fee to
 * the platform) and the cancellation split; every resulting interval becomes
 * one piece with a fixed destination per exit.
 *
 * A carve changes only WHO the payee's share is released to. It is not a cut
 * point: the funder takes the payee's whole share, so a carved hold has the
 * same pieces as an uncarved one and the platform's fee is untouched.
 */
function partitionPieces(input: PartitionInput): readonly LoweredPiece[] {
  const total = Number(TOTAL_BPS);
  const releaseTo = input.carveTo ?? input.payee;
  const release: { end: number; to: string }[] = [];
  if (input.payeeFeeBps < total) {
    release.push({ end: total - input.payeeFeeBps, to: releaseTo });
  }
  if (input.payeeFeeBps > 0) release.push({ end: total, to: "platform" });

  const cancel: { end: number; origin: Span; to: string }[] = [];
  let cumulative = 0;
  for (const share of input.onCancel?.shares ?? []) {
    cumulative += share.bps;
    cancel.push({ end: cumulative, origin: share.origin, to: share.to });
  }

  const cuts = [
    ...new Set([
      ...release.map((segment) => segment.end),
      ...cancel.map((segment) => segment.end),
      total,
    ]),
  ].sort((left, right) => left - right);

  const destinationAt = <T extends { readonly end: number }>(
    segments: readonly T[],
    start: number,
  ): T | undefined => segments.find((segment) => start < segment.end);

  const pieces: LoweredPiece[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut <= start) continue;
    const releaseSegment = destinationAt(release, start);
    const cancelSegment = destinationAt(cancel, start);
    pieces.push({
      bps: cut - start,
      ...(cancelSegment ? { cancelTo: cancelSegment.to } : {}),
      field: `piece${pieces.length + 1}Amount`,
      origin: cancelSegment?.origin ?? input.amount.origin,
      releaseTo: releaseSegment?.to ?? releaseTo,
    });
    start = cut;
  }
  return pieces;
}

function pieceDescription(
  piece: LoweredPiece,
  index: number,
  amountName: string,
  currency: string,
): string {
  const cancelLeg = piece.cancelTo
    ? `; on cancellation to the ${piece.cancelTo.replaceAll("_", " ")}`
    : "";
  const remainder =
    index === 0 ? " (carries the integer-division remainder)" : "";
  return `${formatBps(piece.bps)} of ${amountName}${remainder}: released to the ${piece.releaseTo.replaceAll(
    "_",
    " ",
  )}${cancelLeg}. Computed as floor(${amountName} * ${piece.bps} / 10000) in ${currency} minor units`;
}

function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, "")}%`;
}

function summarize(program: CheckedProgram): string {
  const carveFunderByHold = new Map(
    program.settlements.flatMap((settlement) =>
      settlement.archetype === "advance" && settlement.source.kind === "carve"
        ? [[settlement.source.settlement, settlement.funder] as const]
        : [],
    ),
  );
  const lines = program.settlements.map((settlement) => {
    switch (settlement.archetype) {
      case "held_payment": {
        const cancel = settlement.onCancel
          ? `; cancellation splits the held amount ${settlement.onCancel.shares
              .map(
                (share) =>
                  `${formatBps(share.bps)} to the ${share.to.replaceAll("_", " ")}`,
              )
              .join(" and ")}`
          : "";
        const carveTo = carveFunderByHold.get(settlement.name);
        const paid = carveTo
          ? `the ${carveTo.replaceAll("_", " ")} is paid on confirmed release, in the ${settlement.payee.replaceAll("_", " ")}'s place`
          : `the ${settlement.payee.replaceAll("_", " ")} is paid on confirmed release`;
        return `The ${settlement.payer.replaceAll("_", " ")} funds ${settlement.amount.name} into escrow and ${paid}${cancel}`;
      }
      case "captured_payment":
        return `The ${settlement.payer.replaceAll("_", " ")}'s ${settlement.amount.name} is reserved until ${settlement.reserveUntilField}, captured by the ${settlement.payee.replaceAll("_", " ")} in strict partial slices, then settled or released`;
      case "instant_transfer":
        return `The ${settlement.payer.replaceAll("_", " ")} pays ${settlement.amount.name} straight through to the ${settlement.payee.replaceAll("_", " ")}`;
      case "premium_forward":
        return `The ${settlement.payer.replaceAll("_", " ")}'s ${settlement.amount.name} forwards to the ${settlement.carrier.replaceAll("_", " ")} exactly once on binding`;
      case "deposit":
        return `The ${settlement.payer.replaceAll("_", " ")}'s ${settlement.amount.name} is reserved for the ${settlement.holder.replaceAll("_", " ")} until claimed or returned`;
      case "scheduled":
        return settlement.mode === "obligation"
          ? `The ${settlement.debtor.replaceAll("_", " ")} owes ${settlement.amount.name}; ${settlement.advanceTo ? `the ${settlement.payee.replaceAll("_", " ")} advances it to the ${settlement.advanceTo.replaceAll("_", " ")}, then ` : ""}the ${settlement.payer.replaceAll("_", " ")} repays the ${settlement.payee.replaceAll("_", " ")} over ${settlement.schedule.count} anchor-bound installments`
          : `The ${settlement.payer.replaceAll("_", " ")} pays ${settlement.amount.name} to the ${settlement.payee.replaceAll("_", " ")} over ${settlement.schedule.count} scheduled installments`;
      case "advance":
        return settlement.source.kind === "carve"
          ? `The ${settlement.funder.replaceAll("_", " ")} advances ${settlement.amount.name} to the ${settlement.advanced.replaceAll("_", " ")}, repaid out of the ${settlement.source.settlement.replaceAll("_", " ")} release`
          : `The ${settlement.funder.replaceAll("_", " ")} advances ${settlement.amount.name} to the ${settlement.advanced.replaceAll("_", " ")}, repaid over ${settlement.source.schedule.count} anchors`;
      case "metered":
        return `The ${settlement.payer.replaceAll("_", " ")} is charged per metered unit at a committed rate card until the period closes`;
      case "pooled_split":
        return `The ${settlement.payer.replaceAll("_", " ")} pools ${settlement.amount.name} and it distributes ${settlement.shares.length} ways on the payout date`;
      case "settlement_batch":
        return `The ${settlement.settlementAccount.replaceAll("_", " ")} freezes capture lineage and pays one signed net amount to the ${settlement.payoutDestination.replaceAll("_", " ")}`;
      case "funding_round":
        return `The ${settlement.contributor.replaceAll("_", " ")} commits under ${settlement.target.name} until the stored close anchor activates or fails the round`;
      case "weighted_distribution":
        return `The ${settlement.source.replaceAll("_", " ")} pays a frozen claimant set by deterministic largest remainder`;
      case "credit_facility":
        return `The ${settlement.lender.replaceAll("_", " ")} admits draws under ${settlement.limit.name}; ${settlement.obligation.settlement.replaceAll("_", " ")} owns repayment`;
      case "recurring_collection":
        return `${settlement.name.replaceAll("_", " ")} adds explicit mandate evidence to ${settlement.obligation.settlement.replaceAll("_", " ")} repayment attempts`;
      case "conditional_disbursement":
        return `The ${settlement.source.replaceAll("_", " ")} pays one evidence-approved amount under ${settlement.cap.name} to the ${settlement.destination.replaceAll("_", " ")}`;
      case "rotating_pool":
        return `${settlement.members.length} fixed members contribute one exact amount per cycle in a stored payout order`;
      case "swap":
        return `The ${settlement.sides[0].party.replaceAll("_", " ")} and ${settlement.sides[1].party.replaceAll("_", " ")} fund one shared escrow and the entire two-sided trade releases or reverses together`;
    }
  });
  return `${lines.join(". ")}.`.slice(0, 400);
}

function camelize(snake: string): string {
  const [head, ...rest] = snake.split("_");
  return (
    (head ?? "") +
    rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")
  );
}

function titleize(snake: string): string {
  const spaced = snake.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
