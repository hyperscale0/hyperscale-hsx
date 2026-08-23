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
import type {
  CancelPolicy,
  CheckedAdvance,
  CheckedDeposit,
  CheckedHeldPayment,
  CheckedInstantTransfer,
  CheckedMetered,
  CheckedPooledSplit,
  CheckedPort,
  CheckedPremiumForward,
  CheckedProgram,
  CheckedScheduled,
  CheckedSettlement,
  CheckedSwap,
  MoneyField,
  ScheduleTerms,
} from "./model.ts";
import { HSX_IR_VERSION } from "./version.ts";

type Json = Record<string, unknown>;

/**
 * The most money events one program may mint. The Business Frame contract caps
 * its moneyEvents array at the same number, and a runtime spec pins the two
 * against each other, so neither can drift alone. Every installment anchor,
 * fee leg, cancellation leg, abandonment refund, and forward counts one.
 */
export const MONEY_EVENT_BUDGET = 14;

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

interface LoweringIssue {
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
  readonly rules: readonly Json[];
  readonly settlement: LoweredSettlement;
}

interface EventSpec {
  readonly amount: string;
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

function mintEvent(spec: EventSpec): Json {
  return {
    allocationTotalBps: 0,
    amount: spec.amount,
    amountDependencies: [],
    amountMode: "fixed",
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
      case "premium_forward": {
        const port = portFor(
          settlement,
          settlement.bind.port,
          settlement.bind.origin,
        );
        if (!port) continue;
        lowered = lowerPremiumForward(settlement, port, issues);
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
        lowered = lowerScheduled(settlement);
        break;
      case "advance":
        lowered = lowerAdvance(settlement);
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
    nouns.push(lowered.noun);
    moneyEvents.push(...lowered.moneyEvents);
    rules.push(...lowered.rules);
    design.push(...lowered.design);
    feeLines.push(...lowered.feeLines);
  }

  if (moneyEvents.length > MONEY_EVENT_BUDGET) {
    issues.push({
      message: `this program needs ${moneyEvents.length} money events but a Business Frame carries at most ${MONEY_EVENT_BUDGET}; simplify the fee or cancellation terms, or drop a settlement`,
      span: program.settlements[0]?.origin ?? { end: 0, start: 0 },
    });
  }
  if (issues.length > 0) return { issues, ok: false };

  const subjects = program.assets.map((asset) => ({
    kind: asset.name,
    title: titleize(asset.name),
    value: "optional",
  }));

  const document: Json = {
    hsx: HSX_IR_VERSION,
    nouns,
    product: program.name,
    ...(subjects.length > 0 ? { subjects } : {}),
    title: program.title,
  };

  const roles = partyRoles(program.settlements);
  const frame: Json = {
    actors: [
      ...program.parties
        .filter((party) => roles.has(party.name))
        .map((party) => ({
          key: party.name,
          label: titleize(party.name),
          maxCount: 1,
          minCount: 1,
          role: roles.get(party.name),
        })),
      {
        key: "platform",
        label: "Platform",
        maxCount: 1,
        minCount: 1,
        role: "platform",
      },
    ],
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
      case "instant_transfer":
      case "scheduled":
      case "metered":
        payers.add(settlement.payer);
        beneficiaries.add(settlement.payee);
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
  deposit: "escrow",
  held_payment: "escrow",
  instant_transfer: "marketplace",
  metered: "recurring_billing",
  pooled_split: "marketplace",
  premium_forward: "insurance",
  scheduled: "recurring_billing",
  swap: "escrow",
};

function mechanicsOf(settlements: readonly CheckedSettlement[]): string[] {
  const mechanics = new Set(
    settlements.map((settlement) => ARCHETYPE_MECHANICS[settlement.archetype]),
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
  return {
    ...held,
    design: [
      `${settlement.name}: premium forwards to the ${settlement.carrier.replaceAll("_", " ")} exactly once on ${port.name}; ${formatBps(settlement.commissionBps)} commission retained by the platform`,
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
      desc: `Premium forward: the ${settlement.payer.replaceAll("_", " ")} funds the ${settlement.amount.name} into this settlement's own escrow; binding through ${port.name} forwards it to the ${settlement.carrier.replaceAll("_", " ")} exactly once, minus the platform commission`,
      summary: `Premium held for the ${settlement.carrier.replaceAll("_", " ")} until the policy binds`,
    },
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

function anchorOffset(schedule: ScheduleTerms, index: number): Json {
  return index === 0 ? {} : { offset: `P${schedule.every.days * index}D` };
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

function lowerAdvance(settlement: CheckedAdvance): LoweredNoun {
  return settlement.source.kind === "carve"
    ? lowerCarvedAdvance(settlement, settlement.source.settlement)
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
): LoweredNoun {
  const noun = settlement.name;
  const amountName = settlement.amount.name;
  const hasFee = settlement.feeBps > 0;
  const advancedWords = settlement.advanced.replaceAll("_", " ");
  const funderWords = settlement.funder.replaceAll("_", " ");
  const holdWords = hold.replaceAll("_", " ");

  const fields: Json = {
    [amountName]: moneyFieldSpec(
      `The advanced amount in ${settlement.amount.currency} minor units, disbursed to the ${advancedWords} up front`,
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
      case "instant_transfer":
        return `The ${settlement.payer.replaceAll("_", " ")} pays ${settlement.amount.name} straight through to the ${settlement.payee.replaceAll("_", " ")}`;
      case "premium_forward":
        return `The ${settlement.payer.replaceAll("_", " ")}'s ${settlement.amount.name} forwards to the ${settlement.carrier.replaceAll("_", " ")} exactly once on binding`;
      case "deposit":
        return `The ${settlement.payer.replaceAll("_", " ")}'s ${settlement.amount.name} is reserved for the ${settlement.holder.replaceAll("_", " ")} until claimed or returned`;
      case "scheduled":
        return `The ${settlement.payer.replaceAll("_", " ")} pays ${settlement.amount.name} to the ${settlement.payee.replaceAll("_", " ")} over ${settlement.schedule.count} scheduled installments`;
      case "advance":
        return settlement.source.kind === "carve"
          ? `The ${settlement.funder.replaceAll("_", " ")} advances ${settlement.amount.name} to the ${settlement.advanced.replaceAll("_", " ")}, repaid out of the ${settlement.source.settlement.replaceAll("_", " ")} release`
          : `The ${settlement.funder.replaceAll("_", " ")} advances ${settlement.amount.name} to the ${settlement.advanced.replaceAll("_", " ")}, repaid over ${settlement.source.schedule.count} anchors`;
      case "metered":
        return `The ${settlement.payer.replaceAll("_", " ")} is charged per metered unit at a committed rate card until the period closes`;
      case "pooled_split":
        return `The ${settlement.payer.replaceAll("_", " ")} pools ${settlement.amount.name} and it distributes ${settlement.shares.length} ways on the payout date`;
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
