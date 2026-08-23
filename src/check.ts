/**
 * The HSX typechecker. Takes the parsed AST, resolves every name, validates
 * each archetype's parameter surface, and produces the checked program model
 * the lowering consumes. Total: always returns diagnostics; returns the model
 * exactly when nothing error-severity was found. Warnings are the compiler's
 * lint voice and never block.
 */

import type {
  BlockExpr,
  Entry,
  Expr,
  IdentExpr,
  Program,
  Span,
} from "./ast.ts";
import {
  ASSET_KINDS,
  PARTY_KINDS,
  type AdvanceSource,
  type AssetKind,
  type CancelPolicy,
  type CheckDiagnostic,
  type CheckResult,
  type CheckedAsset,
  type CheckedParty,
  type CheckedPort,
  type CheckedSettlement,
  type FeeTerm,
  type MeterRate,
  type MoneyField,
  type PartyKind,
  type PortField,
  type PortFieldType,
  type ScheduleTerms,
  type SplitShare,
  type SwapFee,
} from "./model.ts";

/** Every archetype the settlement stdlib ships; all of them lower today. */
const SETTLEMENT_ARCHETYPES = [
  "advance",
  "deposit",
  "held_payment",
  "instant_transfer",
  "metered",
  "pooled_split",
  "premium_forward",
  "scheduled",
  "swap",
] as const;

type ArchetypeName = (typeof SETTLEMENT_ARCHETYPES)[number];

/** Each archetype's parameter surface: the entries its body understands. */
const ARCHETYPE_SURFACES: Record<
  ArchetypeName,
  { readonly keys: readonly string[]; readonly required: readonly string[] }
> = {
  advance: {
    keys: [
      "against",
      "amount",
      "count",
      "every",
      "fee",
      "first_due",
      "funder",
      "to",
    ],
    // The repayment source is one of two shapes (a schedule, or a carve out of
    // a hold's release), so the advance case below states that requirement
    // itself rather than listing either shape's keys here.
    required: ["funder", "to", "amount"],
  },
  deposit: {
    keys: ["amount", "claim", "holder", "payer", "return"],
    required: ["payer", "holder", "amount", "claim", "return"],
  },
  held_payment: {
    keys: ["amount", "fees", "on_cancel", "payer", "payee", "release"],
    required: ["payer", "payee", "amount", "release"],
  },
  instant_transfer: {
    keys: ["amount", "fees", "payer", "payee"],
    required: ["payer", "payee", "amount"],
  },
  metered: {
    keys: ["close_by", "payer", "payee", "rates"],
    required: ["payer", "payee", "rates", "close_by"],
  },
  pooled_split: {
    keys: ["amount", "payer", "payout_due", "split"],
    required: ["payer", "amount", "split", "payout_due"],
  },
  premium_forward: {
    keys: ["amount", "bind", "carrier", "commission", "on_cancel", "payer"],
    required: ["payer", "carrier", "amount", "bind"],
  },
  scheduled: {
    keys: ["amount", "count", "every", "first_due", "payer", "payee"],
    required: ["payer", "payee", "amount", "count", "every", "first_due"],
  },
  swap: {
    keys: ["amounts", "between", "dispute", "fees", "release"],
    required: ["between", "amounts", "release"],
  },
};

/** The three terms that together declare a finite schedule. */
const SCHEDULE_KEYS = ["count", "every", "first_due"] as const;

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;
const CURRENCY = /^[A-Z]{3}$/;

const TOTAL_BPS = 10_000;

export function checkProgram(program: Program): CheckResult {
  const diagnostics: CheckDiagnostic[] = [];
  const error = (span: Span, message: string): void => {
    diagnostics.push({ message, severity: "error", span });
  };
  const warning = (span: Span, message: string): void => {
    diagnostics.push({ message, severity: "warning", span });
  };

  // --- Header ---------------------------------------------------------------
  const headers = program.decls.filter((decl) => decl.kind === "program");
  const header = headers[0];
  if (!header) {
    error(
      { end: 0, start: 0 },
      'the file needs a program header naming the company, like: program used_car_escrow "Used-car escrow"',
    );
  }
  for (const extra of headers.slice(1)) {
    error(extra.span, "a file declares exactly one program");
  }
  if (header && !SNAKE_CASE.test(header.name.name)) {
    error(
      header.name.span,
      `the program name must be snake_case, like used_car_escrow; "${header.name.name}" is not`,
    );
  }

  // --- Imports --------------------------------------------------------------
  const imported = new Map<string, Span>();
  for (const decl of program.decls) {
    if (decl.kind !== "import") continue;
    if (decl.from.value !== "settlement") {
      error(
        decl.from.span,
        `"${decl.from.value}" is not an importable module; the settlement algebra lives in "settlement"`,
      );
      continue;
    }
    for (const name of decl.names) {
      if (!(SETTLEMENT_ARCHETYPES as readonly string[]).includes(name.name)) {
        error(
          name.span,
          `"settlement" has no archetype named ${name.name}; it offers ${SETTLEMENT_ARCHETYPES.join(", ")}`,
        );
        continue;
      }
      if (imported.has(name.name)) {
        warning(name.span, `${name.name} is imported more than once`);
      }
      imported.set(name.name, name.span);
    }
  }

  // --- One namespace for every declared name --------------------------------
  const declared = new Map<string, { kind: string; span: Span }>();
  const claim = (name: IdentExpr, kind: string): boolean => {
    if (name.name === "platform" || name.name === "escrow") {
      error(
        name.span,
        `the name ${name.name} is reserved: the platform and each settlement's escrow are always present without being declared`,
      );
      return false;
    }
    const existing = declared.get(name.name);
    if (existing) {
      error(
        name.span,
        `the name ${name.name} is already taken by a ${existing.kind}; every party, asset, settlement, and port needs its own name`,
      );
      return false;
    }
    if (!SNAKE_CASE.test(name.name)) {
      error(name.span, `${kind} names are snake_case; "${name.name}" is not`);
      return false;
    }
    declared.set(name.name, { kind, span: name.span });
    return true;
  };

  // --- Parties and assets ---------------------------------------------------
  const parties = new Map<string, CheckedParty>();
  const assets = new Map<string, CheckedAsset>();
  for (const decl of program.decls) {
    if (decl.kind === "party") {
      if (!claim(decl.name, "party")) continue;
      if (!(PARTY_KINDS as readonly string[]).includes(decl.partyKind.name)) {
        error(
          decl.partyKind.span,
          `a party is a ${PARTY_KINDS.join(" or a ")}; "${decl.partyKind.name}" is neither`,
        );
        continue;
      }
      if (decl.attrs) {
        error(
          decl.attrs.span,
          `party ${decl.name.name} takes no attribute block yet`,
        );
      }
      parties.set(decl.name.name, {
        kind: decl.partyKind.name as PartyKind,
        name: decl.name.name,
        origin: decl.span,
      });
    }
    if (decl.kind === "asset") {
      if (!claim(decl.name, "asset")) continue;
      if (!(ASSET_KINDS as readonly string[]).includes(decl.assetKind.name)) {
        error(
          decl.assetKind.span,
          `an asset is one of ${ASSET_KINDS.join(", ")}; "${decl.assetKind.name}" is none of those`,
        );
        continue;
      }
      let titleTransfer: CheckedAsset["titleTransfer"] = "on_platform";
      for (const entry of decl.attrs?.entries ?? []) {
        if (entry.key.name !== "title_transfer") {
          error(
            entry.key.span,
            `asset ${decl.name.name} does not understand "${entry.key.name}"; the only attribute is title_transfer`,
          );
          continue;
        }
        const value = entry.value;
        if (
          value.kind === "ident" &&
          (value.name === "off_platform" || value.name === "on_platform")
        ) {
          titleTransfer = value.name;
        } else {
          error(
            value.span,
            "title_transfer is either on_platform or off_platform",
          );
        }
      }
      assets.set(decl.name.name, {
        kind: decl.assetKind.name as AssetKind,
        name: decl.name.name,
        origin: decl.span,
        titleTransfer,
      });
    }
  }

  // Claim settlement and port names before checking bodies, so declarations
  // may reference each other regardless of file order.
  const portDecls = program.decls.filter((decl) => decl.kind === "port");
  const settlementDecls = program.decls.filter(
    (decl) => decl.kind === "settlement",
  );
  for (const decl of settlementDecls) claim(decl.name, "settlement");
  const portNames = new Set<string>();
  for (const decl of portDecls) {
    if (claim(decl.name, "port")) portNames.add(decl.name.name);
  }

  // --- Shared body helpers ----------------------------------------------------
  const entriesOf = (
    block: BlockExpr,
    valid: readonly string[],
    owner: string,
  ): Map<string, Entry> => {
    const seen = new Map<string, Entry>();
    for (const entry of block.entries) {
      if (!valid.includes(entry.key.name)) {
        error(
          entry.key.span,
          `${owner} does not understand "${entry.key.name}"; it takes ${valid.join(", ")}`,
        );
        continue;
      }
      if (seen.has(entry.key.name)) {
        error(entry.key.span, `${owner} sets ${entry.key.name} twice`);
        continue;
      }
      seen.set(entry.key.name, entry);
    }
    return seen;
  };
  const noQualifiers = (entry: Entry, owner: string): void => {
    if (entry.qualifiers.length > 0) {
      error(
        entry.span,
        `${entry.key.name} on ${owner} takes no ( ... ) qualifier`,
      );
    }
  };
  const referencedParties = new Set<string>();
  const partyRef = (expr: Expr, role: string): string | undefined => {
    if (expr.kind === "ident" && parties.has(expr.name)) {
      referencedParties.add(expr.name);
      return expr.name;
    }
    error(
      expr.span,
      expr.kind === "ident"
        ? `${role} must name a declared party; there is no party named ${expr.name}`
        : `${role} must name a declared party`,
    );
    return undefined;
  };

  // --- Settlements: shared term parsers ---------------------------------------
  const referencedPorts = new Set<string>();
  const settlements: CheckedSettlement[] = [];

  // The lowering mints fields with these names; a user field that collides
  // would silently overwrite the generated one and corrupt the choreography
  // (e.g. an amount named serviceFeeAmount would BE the fee moved to the
  // platform). Refused here, at source coordinates, for every archetype.
  const RESERVED_FIELD_NAMES = new Set([
    "currency",
    "feeAmount",
    "repayableAmount",
    "serviceFeeAmount",
    "clawbackAt",
  ]);
  const RESERVED_FIELD_PATTERNS = [
    /^piece\d+Amount$/,
    /^installment\d+Amount$/,
    /^repayment\d+Amount$/,
    /ShareAmount$/,
    /AccountId$/,
  ];
  const reservedFieldName = (
    name: string,
    span: Span,
    owner: string,
  ): boolean => {
    if (
      RESERVED_FIELD_NAMES.has(name) ||
      RESERVED_FIELD_PATTERNS.some((pattern) => pattern.test(name))
    ) {
      error(
        span,
        `${owner} names a field ${name}, but the compiler reserves that name for a generated field; pick another name`,
      );
      return true;
    }
    return false;
  };

  const parseAmount = (
    entry: Entry | undefined,
    owner: string,
  ): MoneyField | undefined => {
    if (!entry) return undefined;
    noQualifiers(entry, owner);
    const value = entry.value;
    if (
      value.kind === "binding" &&
      value.type.kind === "call" &&
      value.type.callee.name === "money" &&
      value.type.args.length === 1 &&
      value.type.args[0]?.kind === "ident"
    ) {
      const currency = value.type.args[0].name;
      if (!CAMEL_CASE.test(value.name.name)) {
        error(
          value.name.span,
          `the ${entry.key.name} field is a camelCase name like price; "${value.name.name}" is not`,
        );
      } else if (!CURRENCY.test(currency)) {
        error(
          value.type.args[0].span,
          `"${currency}" is not a currency code; use three capital letters like SAR`,
        );
      } else if (!reservedFieldName(value.name.name, value.name.span, owner)) {
        return { currency, name: value.name.name, origin: value.span };
      }
      return undefined;
    }
    error(
      value.span,
      `${owner} declares ${entry.key.name} as a typed field, like: ${entry.key.name}: price: money(SAR)`,
    );
    return undefined;
  };

  const parsePortEntry = (
    entry: Entry | undefined,
    owner: string,
    role: string,
    acceptsDeadline = false,
  ):
    | {
        readonly deadlineField?: string;
        readonly origin: Span;
        readonly port: string;
      }
    | undefined => {
    if (!entry) return undefined;
    noQualifiers(entry, owner);
    const value = entry.value;
    if (value.kind !== "port_ref") {
      error(
        value.span,
        `${owner} needs a ${role} decision, like: ${entry.key.name}: port ${entry.key.name}_decided`,
      );
      return undefined;
    }
    if (value.within) {
      error(
        value.within.span,
        `${entry.key.name} on ${owner} has no time window; only dispute accepts "within <duration>"`,
      );
      return undefined;
    }
    if (value.deadline && !acceptsDeadline) {
      error(
        value.deadline.span,
        `${entry.key.name} on ${owner} has no date default; only a held payment's release falls back to a date`,
      );
      return undefined;
    }
    if (!portNames.has(value.name.name)) {
      error(
        value.name.span,
        `${owner} decides ${role} through port ${value.name.name}, but no port with that name is declared`,
      );
      return undefined;
    }
    let deadlineField: string | undefined;
    if (value.deadline) {
      if (!CAMEL_CASE.test(value.deadline.name)) {
        error(
          value.deadline.span,
          `at( ... ) names a camelCase date field, like at(releaseDueAt); "${value.deadline.name}" is not`,
        );
        return undefined;
      }
      if (reservedFieldName(value.deadline.name, value.deadline.span, owner)) {
        return undefined;
      }
      deadlineField = value.deadline.name;
    }
    referencedPorts.add(value.name.name);
    return {
      ...(deadlineField ? { deadlineField } : {}),
      origin: value.span,
      port: value.name.name,
    };
  };

  const parseDisputeEntry = (
    entry: Entry | undefined,
    owner: string,
  ):
    | {
        readonly origin: Span;
        readonly port: string;
        readonly window: { readonly days: number; readonly raw: string };
      }
    | undefined => {
    if (!entry) return undefined;
    noQualifiers(entry, owner);
    const value = entry.value;
    if (value.kind !== "port_ref") {
      error(
        value.span,
        `${owner} needs one whole-trade dispute decision, like: dispute: port resolve_dispute within P14D`,
      );
      return undefined;
    }
    if (!portNames.has(value.name.name)) {
      error(
        value.name.span,
        `${owner} disputes through port ${value.name.name}, but no port with that name is declared`,
      );
      return undefined;
    }
    if (!value.within) {
      error(
        value.span,
        `${owner} dispute needs a fixed window, like: dispute: port ${value.name.name} within P14D`,
      );
      return undefined;
    }
    const raw = value.within.name;
    const match = /^P([1-9]\d{0,3})([DW])$/.exec(raw);
    if (raw !== "P0D" && !match) {
      error(
        value.within.span,
        `dispute on ${owner} uses a fixed duration in days or weeks, like P14D; calendar months cannot define an exact money deadline`,
      );
      return undefined;
    }
    const magnitude = match ? Number(match[1]) : 0;
    const days = match?.[2] === "W" ? magnitude * 7 : magnitude;
    referencedPorts.add(value.name.name);
    return {
      origin: value.span,
      port: value.name.name,
      window: { days, raw },
    };
  };

  const parsePercentEntry = (
    entry: Entry | undefined,
    owner: string,
    label: string,
  ): number | undefined => {
    if (!entry) return undefined;
    noQualifiers(entry, owner);
    if (entry.value.kind !== "percent") {
      error(entry.value.span, `${label} on ${owner} must be a percent`);
      return undefined;
    }
    if (entry.value.bps >= TOTAL_BPS) {
      error(
        entry.value.span,
        `a ${entry.value.raw}% ${label} consumes the whole amount; it stays under 100%`,
      );
      return undefined;
    }
    if (entry.value.bps === 0) {
      warning(
        entry.value.span,
        `${label} on ${owner} is 0%; drop the entry if none is meant`,
      );
    }
    return entry.value.bps;
  };

  const parseFees = (
    entry: Entry | undefined,
    owner: string,
    payer: string | undefined,
    payee: string | undefined,
  ): FeeTerm[] => {
    const fees: FeeTerm[] = [];
    if (!entry) return fees;
    noQualifiers(entry, owner);
    if (entry.value.kind !== "block") {
      error(
        entry.value.span,
        `fees is a block of party shares, like: fees { buyer: 1% }`,
      );
      return fees;
    }
    for (const fee of entry.value.entries) {
      const bearer = fee.key.name;
      if (bearer !== payer && bearer !== payee) {
        error(
          fee.key.span,
          `fees are borne by this settlement's payer or payee; ${bearer} is neither`,
        );
        continue;
      }
      if (fees.some((existing) => existing.bearer === bearer)) {
        error(fee.key.span, `${owner} sets a fee for ${bearer} twice`);
        continue;
      }
      if (fee.value.kind !== "percent") {
        error(fee.value.span, `the fee for ${bearer} must be a percent`);
        continue;
      }
      if (fee.value.bps >= TOTAL_BPS) {
        error(
          fee.value.span,
          `a ${fee.value.raw}% fee consumes the whole amount; fees stay under 100%`,
        );
        continue;
      }
      if (fee.value.bps === 0) {
        warning(
          fee.value.span,
          `the fee for ${bearer} is 0%; drop the entry if no fee is meant`,
        );
      }
      fees.push({ bearer, bps: fee.value.bps, origin: fee.span });
    }
    return fees;
  };

  const parseSwapFees = (
    entry: Entry | undefined,
    owner: string,
    sides: readonly [string | undefined, string | undefined],
  ): SwapFee[] => {
    const fees: SwapFee[] = [];
    if (!entry) return fees;
    noQualifiers(entry, owner);
    if (entry.value.kind !== "block") {
      error(
        entry.value.span,
        `fees is a block of exact on-top money fields, like: fees { buyer: buyerFee: money(SAR) }`,
      );
      return fees;
    }
    for (const fee of entry.value.entries) {
      const bearer = fee.key.name;
      if (!sides.includes(bearer)) {
        error(
          fee.key.span,
          `swap fees are borne by one of its two parties; ${bearer} is not in between`,
        );
        continue;
      }
      if (fees.some((existing) => existing.bearer === bearer)) {
        error(fee.key.span, `${owner} sets a fee for ${bearer} twice`);
        continue;
      }
      const amount = parseAmount(fee, `${owner} fee for ${bearer}`);
      if (amount) fees.push({ amount, bearer });
    }
    return fees;
  };

  /**
   * A percent split block whose shares must sum to exactly 100%. Recipients
   * are constrained to `allowed`; `remainder_to` is accepted only when
   * `remainderAllowed` (pooled_split), naming the share that carries the
   * integer-division remainder.
   */
  const parseSplitBlock = (
    entry: Entry,
    owner: string,
    allowed: readonly string[],
    allowedLabel: string,
    remainderAllowed: boolean,
  ):
    | { readonly remainderTo?: string; readonly shares: SplitShare[] }
    | undefined => {
    if (entry.value.kind !== "block") {
      error(
        entry.value.span,
        `${entry.key.name} on ${owner} is a block of percent shares, like: { ${allowed[0] ?? "party"}: 100% }`,
      );
      return undefined;
    }
    const shares: SplitShare[] = [];
    let remainderTo: { readonly name: string; readonly span: Span } | undefined;
    let sum = 0;
    let sound = true;
    for (const share of entry.value.entries) {
      const to = share.key.name;
      if (to === "remainder_to") {
        if (!remainderAllowed) {
          error(
            share.key.span,
            `${owner} does not take remainder_to here; the first share carries the integer remainder`,
          );
          sound = false;
          continue;
        }
        if (share.value.kind !== "ident") {
          error(share.value.span, `remainder_to names one of the recipients`);
          sound = false;
          continue;
        }
        if (remainderTo) {
          error(share.key.span, `${owner} sets remainder_to twice`);
          sound = false;
          continue;
        }
        remainderTo = { name: share.value.name, span: share.value.span };
        continue;
      }
      if (!allowed.includes(to)) {
        error(
          share.key.span,
          `the ${entry.key.name} split goes to ${allowedLabel}; ${to} is not among them`,
        );
        sound = false;
        continue;
      }
      referencedParties.add(to);
      if (shares.some((existing) => existing.to === to)) {
        error(share.key.span, `${owner} splits to ${to} twice`);
        sound = false;
        continue;
      }
      if (share.value.kind !== "percent") {
        error(share.value.span, `the share for ${to} must be a percent`);
        sound = false;
        continue;
      }
      // A 0% share would lower to a zero-amount money movement, which the
      // kernel refuses at runtime; a recipient who receives nothing simply
      // leaves the block.
      if (share.value.bps === 0) {
        error(
          share.value.span,
          `the share for ${to} is 0%; drop ${to} from the split instead of giving it nothing`,
        );
        sound = false;
        continue;
      }
      shares.push({ bps: share.value.bps, origin: share.span, to });
      sum += share.value.bps;
    }
    if (sound && sum !== TOTAL_BPS) {
      error(
        entry.value.span,
        `the ${entry.key.name} split must account for exactly 100%; these shares total ${(sum / 100).toFixed(2).replace(/\.?0+$/, "")}%`,
      );
      sound = false;
    }
    if (
      remainderTo &&
      !shares.some((share) => share.to === remainderTo?.name)
    ) {
      error(
        remainderTo.span,
        `remainder_to must name one of the split's recipients; ${remainderTo.name} holds no share`,
      );
      sound = false;
    }
    if (!sound || shares.length === 0) return undefined;
    return {
      ...(remainderTo ? { remainderTo: remainderTo.name } : {}),
      shares,
    };
  };

  const parseCancelPolicy = (
    entry: Entry | undefined,
    owner: string,
    allowed: readonly string[],
    allowedLabel: string,
  ): CancelPolicy | undefined => {
    if (!entry) return undefined;
    const qualifier = entry.qualifiers[0];
    if (entry.qualifiers.length !== 1 || qualifier?.name !== "funded") {
      error(
        entry.span,
        `on_cancel states the phase it covers; today that is on_cancel(funded)`,
      );
      return undefined;
    }
    const split = parseSplitBlock(entry, owner, allowed, allowedLabel, false);
    if (!split) return undefined;
    return { origin: entry.span, shares: split.shares, when: "funded" };
  };

  const parseDateField = (
    entry: Entry | undefined,
    owner: string,
  ): string | undefined => {
    if (!entry) return undefined;
    noQualifiers(entry, owner);
    if (entry.value.kind === "ident" && CAMEL_CASE.test(entry.value.name)) {
      return reservedFieldName(entry.value.name, entry.value.span, owner)
        ? undefined
        : entry.value.name;
    }
    error(
      entry.value.span,
      `${entry.key.name} on ${owner} names a camelCase date field, like: ${entry.key.name}: dueDate`,
    );
    return undefined;
  };

  const parseSchedule = (
    entries: Map<string, Entry>,
    owner: string,
    origin: Span,
  ): ScheduleTerms | undefined => {
    const countEntry = entries.get("count");
    const everyEntry = entries.get("every");
    let count: number | undefined;
    if (countEntry) {
      noQualifiers(countEntry, owner);
      const value = countEntry.value;
      const parsed = value.kind === "number" ? Number(value.raw) : Number.NaN;
      if (Number.isInteger(parsed) && parsed >= 2 && parsed <= 12) {
        count = parsed;
      } else {
        error(
          value.span,
          `count on ${owner} is a literal number of anchors between 2 and 12; the schedule stays finite by construction`,
        );
      }
    }
    let every: ScheduleTerms["every"] | undefined;
    if (everyEntry) {
      noQualifiers(everyEntry, owner);
      const value = everyEntry.value;
      const raw =
        value.kind === "ident"
          ? value.name
          : value.kind === "string"
            ? value.value
            : undefined;
      const match = raw ? /^P([1-9]\d{0,3})([DW])$/.exec(raw) : null;
      if (match && raw) {
        const magnitude = Number(match[1]);
        every = {
          days: match[2] === "W" ? magnitude * 7 : magnitude,
          raw,
        };
      } else {
        error(
          value.span,
          `every on ${owner} is a fixed duration in days or weeks, like P30D or P2W; calendar months drift and cannot anchor an exact schedule`,
        );
      }
    }
    const firstDueField = parseDateField(entries.get("first_due"), owner);
    if (count === undefined || !every || !firstDueField) return undefined;
    return { count, every, firstDueField, origin };
  };

  /**
   * An advance draws its repayment from exactly one source: its own finite
   * schedule, or a carve out of the release of a hold the advanced party is
   * already owed. Which hold that is resolves after every settlement is
   * checked, so only the reference's shape is validated here.
   */
  const parseAdvanceSource = (
    entries: Map<string, Entry>,
    owner: string,
    origin: Span,
  ): AdvanceSource | undefined => {
    const againstEntry = entries.get("against");
    const scheduleKeys = SCHEDULE_KEYS.filter((key) => entries.has(key));
    if (againstEntry && scheduleKeys.length > 0) {
      error(
        againstEntry.span,
        `${owner} is repaid by a carve and by its own schedule (${scheduleKeys.join(", ")}); an advance draws on one source`,
      );
      return undefined;
    }
    if (!againstEntry) {
      if (scheduleKeys.length === 0) {
        error(
          origin,
          `${owner} needs a repayment source: against: <hold>.release carves it out of a hold's release, or count + every + first_due collects it on a schedule`,
        );
        return undefined;
      }
      for (const key of SCHEDULE_KEYS) {
        if (!entries.has(key)) error(origin, `${owner} is missing ${key}`);
      }
      const schedule = parseSchedule(entries, owner, origin);
      return schedule ? { kind: "schedule", schedule } : undefined;
    }
    noQualifiers(againstEntry, owner);
    const value = againstEntry.value;
    if (value.kind !== "settlement_ref") {
      error(
        value.span,
        `${owner} draws against a held payment's release, like: against: retention.release`,
      );
      return undefined;
    }
    if (value.member.name !== "release") {
      error(
        value.member.span,
        `an advance carves a hold's release; there is no exit named ${value.member.name} on ${value.owner.name} to draw against`,
      );
      return undefined;
    }
    return { kind: "carve", origin: value.span, settlement: value.owner.name };
  };

  // --- Settlements: one checker per archetype ---------------------------------
  for (const decl of settlementDecls) {
    const archetype = decl.archetype.name;
    if (!imported.has(archetype)) {
      error(
        decl.archetype.span,
        (SETTLEMENT_ARCHETYPES as readonly string[]).includes(archetype)
          ? `${archetype} must be imported first: import { ${archetype} } from "settlement"`
          : `there is no settlement archetype named ${archetype}`,
      );
      continue;
    }

    const owner = `settlement ${decl.name.name}`;
    const surface = ARCHETYPE_SURFACES[archetype as ArchetypeName];
    const entries = entriesOf(decl.body, surface.keys, owner);
    for (const required of surface.required) {
      if (!entries.has(required)) {
        error(decl.span, `${owner} is missing ${required}`);
      }
    }
    const party = (key: string, role: string): string | undefined => {
      const entry = entries.get(key);
      if (!entry) return undefined;
      noQualifiers(entry, owner);
      return partyRef(entry.value, `${owner} ${role}`);
    };
    const distinct = (
      left: string | undefined,
      right: string | undefined,
      message: string,
    ): boolean => {
      if (left && right && left === right) {
        error(decl.span, `${owner} ${message}`);
        return false;
      }
      return true;
    };

    switch (archetype as ArchetypeName) {
      case "swap": {
        const betweenEntry = entries.get("between");
        let sideA: string | undefined;
        let sideB: string | undefined;
        if (betweenEntry) {
          noQualifiers(betweenEntry, owner);
          if (
            betweenEntry.value.kind !== "list" ||
            betweenEntry.value.items.length !== 2
          ) {
            error(
              betweenEntry.value.span,
              `${owner} swaps between exactly two parties, like: between: [buyer, seller]`,
            );
          } else {
            sideA = partyRef(
              betweenEntry.value.items[0] as Expr,
              `${owner} first side`,
            );
            sideB = partyRef(
              betweenEntry.value.items[1] as Expr,
              `${owner} second side`,
            );
            distinct(
              sideA,
              sideB,
              `names ${sideA} on both sides; the two swap parties must differ`,
            );
          }
        }

        const amountByParty = new Map<string, MoneyField>();
        const amountsEntry = entries.get("amounts");
        if (amountsEntry) {
          noQualifiers(amountsEntry, owner);
          if (amountsEntry.value.kind !== "block") {
            error(
              amountsEntry.value.span,
              `${owner} amounts is a two-party block, like: amounts { buyer: buyerPays: money(SAR), seller: sellerPays: money(SAR) }`,
            );
          } else {
            for (const amountEntry of amountsEntry.value.entries) {
              const partyName = amountEntry.key.name;
              if (partyName !== sideA && partyName !== sideB) {
                error(
                  amountEntry.key.span,
                  `${owner} amount belongs to one of its two parties; ${partyName} is not in between`,
                );
                continue;
              }
              if (amountByParty.has(partyName)) {
                error(
                  amountEntry.key.span,
                  `${owner} declares more than one amount for ${partyName}`,
                );
                continue;
              }
              const amount = parseAmount(amountEntry, owner);
              if (amount) amountByParty.set(partyName, amount);
            }
          }
        }
        const sideAAmount = sideA ? amountByParty.get(sideA) : undefined;
        const sideBAmount = sideB ? amountByParty.get(sideB) : undefined;
        if (sideA && !sideAAmount) {
          error(
            amountsEntry?.span ?? decl.span,
            `${owner} needs exactly one funded amount for ${sideA}`,
          );
        }
        if (sideB && !sideBAmount) {
          error(
            amountsEntry?.span ?? decl.span,
            `${owner} needs exactly one funded amount for ${sideB}`,
          );
        }
        if (
          sideAAmount &&
          sideBAmount &&
          sideAAmount.currency !== sideBAmount.currency
        ) {
          error(
            amountsEntry?.span ?? decl.span,
            `${owner} cannot link ${sideAAmount.currency} and ${sideBAmount.currency} in one atomic ledger batch; both amounts need one currency`,
          );
        }

        const release = parsePortEntry(
          entries.get("release"),
          owner,
          "whole-trade release",
        );
        const dispute = parseDisputeEntry(entries.get("dispute"), owner);
        const fees = parseSwapFees(entries.get("fees"), owner, [sideA, sideB]);
        const swapAmounts = [sideAAmount, sideBAmount].filter(
          (amount): amount is MoneyField => amount !== undefined,
        );
        for (const fee of fees) {
          if (
            swapAmounts.some((amount) => amount.name === fee.amount.name) ||
            fees.some(
              (other) => other !== fee && other.amount.name === fee.amount.name,
            )
          ) {
            error(
              fee.amount.origin,
              `${owner} fee field ${fee.amount.name} must be distinct from both principal and fee fields`,
            );
          }
          if (sideAAmount && fee.amount.currency !== sideAAmount.currency) {
            error(
              fee.amount.origin,
              `${owner} fee field ${fee.amount.name} must use the trade currency ${sideAAmount.currency}`,
            );
          }
        }
        if (
          sideA &&
          sideB &&
          sideAAmount &&
          sideBAmount &&
          sideAAmount.currency === sideBAmount.currency &&
          release
        ) {
          const sideAFee = fees.find((fee) => fee.bearer === sideA);
          const sideBFee = fees.find((fee) => fee.bearer === sideB);
          settlements.push({
            archetype: "swap",
            ...(dispute ? { dispute } : {}),
            name: decl.name.name,
            origin: decl.span,
            release,
            sides: [
              {
                amount: sideAAmount,
                ...(sideAFee ? { fee: sideAFee } : {}),
                party: sideA,
              },
              {
                amount: sideBAmount,
                ...(sideBFee ? { fee: sideBFee } : {}),
                party: sideB,
              },
            ],
          });
        }
        break;
      }
      case "held_payment": {
        const payer = party("payer", "payer");
        const payee = party("payee", "payee");
        const sound = distinct(
          payer,
          payee,
          `pays ${payer} from ${payer}; payer and payee must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const release = parsePortEntry(
          entries.get("release"),
          owner,
          "release",
          true,
        );
        const fees = parseFees(entries.get("fees"), owner, payer, payee);
        const onCancel = parseCancelPolicy(
          entries.get("on_cancel"),
          owner,
          [payer, payee].filter((name): name is string => name !== undefined),
          "this settlement's payer or payee",
        );
        if (amount && release?.deadlineField === amount.name) {
          error(
            release.origin,
            `${owner} uses ${amount.name} as both the held amount and the release date field; they need distinct names`,
          );
          break;
        }
        if (payer && payee && amount && release && sound) {
          settlements.push({
            amount,
            archetype: "held_payment",
            fees,
            name: decl.name.name,
            ...(onCancel ? { onCancel } : {}),
            origin: decl.span,
            payee,
            payer,
            release: { origin: release.origin, port: release.port },
            ...(release.deadlineField
              ? { releaseDeadlineField: release.deadlineField }
              : {}),
          });
        }
        break;
      }
      case "instant_transfer": {
        const payer = party("payer", "payer");
        const payee = party("payee", "payee");
        const sound = distinct(
          payer,
          payee,
          `pays ${payer} from ${payer}; payer and payee must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const fees = parseFees(entries.get("fees"), owner, payer, payee);
        if (payer && payee && amount && sound) {
          settlements.push({
            amount,
            archetype: "instant_transfer",
            fees,
            name: decl.name.name,
            origin: decl.span,
            payee,
            payer,
          });
        }
        break;
      }
      case "premium_forward": {
        const payer = party("payer", "payer");
        const carrier = party("carrier", "carrier");
        const sound = distinct(
          payer,
          carrier,
          `forwards the premium from ${payer} to ${payer}; payer and carrier must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const bind = parsePortEntry(entries.get("bind"), owner, "binding");
        const commissionBps =
          parsePercentEntry(entries.get("commission"), owner, "commission") ??
          0;
        const onCancel = parseCancelPolicy(
          entries.get("on_cancel"),
          owner,
          [payer, carrier].filter((name): name is string => name !== undefined),
          "this settlement's payer or carrier",
        );
        if (payer && carrier && amount && bind && sound) {
          settlements.push({
            amount,
            archetype: "premium_forward",
            bind,
            carrier,
            commissionBps,
            name: decl.name.name,
            ...(onCancel ? { onCancel } : {}),
            origin: decl.span,
            payer,
          });
        }
        break;
      }
      case "deposit": {
        const payer = party("payer", "payer");
        const holder = party("holder", "holder");
        const sound = distinct(
          payer,
          holder,
          `holds ${payer}'s deposit for ${payer}; payer and holder must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const claim = parsePortEntry(entries.get("claim"), owner, "claim");
        const returnPort = parsePortEntry(
          entries.get("return"),
          owner,
          "return",
        );
        if (claim && returnPort && claim.port === returnPort.port) {
          error(
            returnPort.origin,
            `${owner} claims and returns through the same port ${claim.port}; the two exits need their own ports`,
          );
          break;
        }
        if (payer && holder && amount && claim && returnPort && sound) {
          settlements.push({
            amount,
            archetype: "deposit",
            claim,
            holder,
            name: decl.name.name,
            origin: decl.span,
            payer,
            return: returnPort,
          });
        }
        break;
      }
      case "scheduled": {
        const payer = party("payer", "payer");
        const payee = party("payee", "payee");
        const sound = distinct(
          payer,
          payee,
          `pays ${payer} from ${payer}; payer and payee must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const schedule = parseSchedule(entries, owner, decl.span);
        if (amount && schedule && amount.name === schedule.firstDueField) {
          error(
            schedule.origin,
            `${owner} uses ${amount.name} as both the amount and the first_due date field; they need distinct names`,
          );
          break;
        }
        if (payer && payee && amount && schedule && sound) {
          settlements.push({
            amount,
            archetype: "scheduled",
            name: decl.name.name,
            origin: decl.span,
            payee,
            payer,
            schedule,
          });
        }
        break;
      }
      case "advance": {
        const funder = party("funder", "funder");
        const advanced = party("to", "advanced party");
        const sound = distinct(
          funder,
          advanced,
          `advances ${funder} their own money; funder and advanced party must differ`,
        );
        const amount = parseAmount(entries.get("amount"), owner);
        const feeBps = parsePercentEntry(entries.get("fee"), owner, "fee") ?? 0;
        const source = parseAdvanceSource(entries, owner, decl.span);
        if (
          amount &&
          source?.kind === "schedule" &&
          amount.name === source.schedule.firstDueField
        ) {
          error(
            source.schedule.origin,
            `${owner} uses ${amount.name} as both the amount and the first_due date field; they need distinct names`,
          );
          break;
        }
        if (funder && advanced && amount && source && sound) {
          settlements.push({
            advanced,
            amount,
            archetype: "advance",
            feeBps,
            funder,
            name: decl.name.name,
            origin: decl.span,
            source,
          });
        }
        break;
      }
      case "metered": {
        const payer = party("payer", "payer");
        const payee = party("payee", "payee");
        const sound = distinct(
          payer,
          payee,
          `meters ${payer} against ${payer}; payer and payee must differ`,
        );
        const closeByField = parseDateField(entries.get("close_by"), owner);
        const rates: MeterRate[] = [];
        const ratesEntry = entries.get("rates");
        if (ratesEntry) {
          noQualifiers(ratesEntry, owner);
          if (ratesEntry.value.kind !== "block") {
            error(
              ratesEntry.value.span,
              `rates is a block of per-unit prices, like: rates { api_call: unitFee: money(SAR) }`,
            );
          } else {
            for (const rate of ratesEntry.value.entries) {
              if (!SNAKE_CASE.test(rate.key.name)) {
                error(
                  rate.key.span,
                  `meter names are snake_case; "${rate.key.name}" is not`,
                );
                continue;
              }
              if (rates.some((existing) => existing.meter === rate.key.name)) {
                error(
                  rate.key.span,
                  `${owner} prices meter ${rate.key.name} twice`,
                );
                continue;
              }
              const field = parseAmount(rate, owner);
              if (!field) continue;
              if (
                rates.some((existing) => existing.field.name === field.name)
              ) {
                error(
                  field.origin,
                  `${owner} reuses the field ${field.name} for two meters`,
                );
                continue;
              }
              const currency = rates[0]?.field.currency;
              if (currency && currency !== field.currency) {
                error(
                  field.origin,
                  `${owner} mixes ${currency} and ${field.currency}; one settlement meters in one currency`,
                );
                continue;
              }
              rates.push({ field, meter: rate.key.name, origin: rate.span });
            }
            if (ratesEntry.value.entries.length === 0) {
              error(ratesEntry.value.span, `${owner} prices no meters`);
            }
          }
        }
        if (
          closeByField &&
          rates.some((rate) => rate.field.name === closeByField)
        ) {
          error(
            decl.span,
            `${owner} uses ${closeByField} as both a rate field and the close_by date field; they need distinct names`,
          );
          break;
        }
        if (payer && payee && closeByField && rates.length > 0 && sound) {
          settlements.push({
            archetype: "metered",
            closeByField,
            name: decl.name.name,
            origin: decl.span,
            payee,
            payer,
            rates,
          });
        }
        break;
      }
      case "pooled_split": {
        const payer = party("payer", "payer");
        const amount = parseAmount(entries.get("amount"), owner);
        const distributeDueField = parseDateField(
          entries.get("payout_due"),
          owner,
        );
        const splitEntry = entries.get("split");
        const recipients = [...parties.keys()].filter((name) => name !== payer);
        const split = splitEntry
          ? parseSplitBlock(
              splitEntry,
              owner,
              recipients,
              "declared parties other than the funder",
              true,
            )
          : undefined;
        if (split && split.shares.length < 2) {
          error(
            splitEntry!.value.span,
            `${owner} splits to a single recipient; a pool distributes between at least two`,
          );
          break;
        }
        // The lowering names each share field ${camelCase(party)}ShareAmount;
        // camelCasing is not injective (a_2b and a2b collide), so two shares
        // must never map onto one generated field.
        if (split) {
          const shareFieldOwners = new Map<string, string>();
          for (const share of split.shares) {
            const [head = "", ...rest] = share.to.split("_");
            const field = `${
              head +
              rest
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join("")
            }ShareAmount`;
            const other = shareFieldOwners.get(field);
            if (other) {
              error(
                share.origin,
                `${owner} splits to ${other} and ${share.to}, whose generated share fields both come out as ${field}; rename one party`,
              );
            }
            shareFieldOwners.set(field, share.to);
          }
        }
        if (
          amount &&
          distributeDueField &&
          amount.name === distributeDueField
        ) {
          error(
            decl.span,
            `${owner} uses ${amount.name} as both the amount and the payout_due date field; they need distinct names`,
          );
          break;
        }
        if (payer && amount && distributeDueField && split) {
          settlements.push({
            amount,
            archetype: "pooled_split",
            distributeDueField,
            name: decl.name.name,
            origin: decl.span,
            payer,
            remainderTo: split.remainderTo ?? split.shares[0]!.to,
            shares: split.shares,
          });
        }
        break;
      }
    }
  }

  // --- Ports ------------------------------------------------------------------
  const ports: CheckedPort[] = [];
  for (const decl of portDecls) {
    const owner = `port ${decl.name.name}`;
    // The tenant's own backend is always the decider, so a port carries only
    // who may ask (allowed) and what the answer looks like (shape).
    const entries = entriesOf(decl.body, ["allowed", "shape"], owner);
    if (!entries.has("allowed")) {
      error(decl.span, `${owner} is missing allowed`);
    }

    const allowed: string[] = [];
    const allowedEntry = entries.get("allowed");
    if (allowedEntry) {
      noQualifiers(allowedEntry, owner);
      const value = allowedEntry.value;
      if (value.kind !== "list" || value.items.length === 0) {
        error(
          value.span,
          `allowed lists who may ask this question, like: allowed: [buyer]`,
        );
      } else {
        for (const item of value.items) {
          const party = partyRef(item, `${owner} allowed`);
          if (!party) continue;
          if (allowed.includes(party)) {
            error(item.span, `${owner} allows ${party} twice`);
            continue;
          }
          allowed.push(party);
        }
      }
    }

    const fields: PortField[] = [];
    const shapeEntry = entries.get("shape");
    if (shapeEntry) {
      noQualifiers(shapeEntry, owner);
      if (shapeEntry.value.kind !== "block") {
        error(
          shapeEntry.value.span,
          `shape is a block of typed fields, like: shape { vehicleId: id(vehicle) }`,
        );
      } else {
        for (const field of shapeEntry.value.entries) {
          if (!CAMEL_CASE.test(field.key.name)) {
            error(
              field.key.span,
              `shape fields are camelCase names; "${field.key.name}" is not`,
            );
            continue;
          }
          if (fields.some((existing) => existing.name === field.key.name)) {
            error(field.key.span, `${owner} declares ${field.key.name} twice`);
            continue;
          }
          const type = portFieldType(field.value);
          if (!type) {
            error(
              field.value.span,
              `${field.key.name} needs a type: id(<asset>), money(<CUR>), text, or date`,
            );
            continue;
          }
          if (type.kind === "asset_id" && !assets.has(type.asset)) {
            error(
              field.value.span,
              `id(${type.asset}) points at an asset that is not declared`,
            );
            continue;
          }
          if (type.kind === "money" && !CURRENCY.test(type.currency)) {
            error(
              field.value.span,
              `"${type.currency}" is not a currency code; use three capital letters like SAR`,
            );
            continue;
          }
          fields.push({ name: field.key.name, origin: field.span, type });
        }
      }
    }

    if (allowed.length > 0) {
      ports.push({
        allowed,
        fields,
        name: decl.name.name,
        origin: decl.span,
      });
    }
  }

  const checkedPortByName = new Map(ports.map((port) => [port.name, port]));
  for (const settlement of settlements) {
    if (settlement.archetype !== "swap") continue;
    const parties = new Set(settlement.sides.map((side) => side.party));
    const decisions = [
      { label: "release", portRef: settlement.release },
      ...(settlement.dispute
        ? [{ label: "dispute", portRef: settlement.dispute }]
        : []),
    ];
    for (const decision of decisions) {
      const port = checkedPortByName.get(decision.portRef.port);
      if (!port) continue;
      for (const actor of port.allowed) {
        if (!parties.has(actor)) {
          error(
            port.origin,
            `swap ${settlement.name} ${decision.label} port ${port.name} allows ${actor}, but whole-trade decisions belong only to ${settlement.sides.map((side) => side.party).join(" or ")}`,
          );
        }
      }
    }
  }

  // --- Carved advances: the hold each one draws against -----------------------
  // `against: retention.release` is the only cross-declaration reference in the
  // language, so it is the only place a settlement's terms are judged against
  // another's. Everything here resolves at check time; nothing is left for a
  // caller to pick.
  const heldByName = new Map(
    settlements
      .filter((settlement) => settlement.archetype === "held_payment")
      .map((settlement) => [settlement.name, settlement]),
  );
  const carvedBy = new Map<string, string>();
  for (const settlement of settlements) {
    if (settlement.archetype !== "advance") continue;
    if (settlement.source.kind !== "carve") continue;
    const owner = `settlement ${settlement.name}`;
    const target = settlement.source.settlement;
    const origin = settlement.source.origin;
    const targetDecl = settlementDecls.find(
      (decl) => decl.name.name === target,
    );
    if (!targetDecl) {
      const other = declared.get(target);
      error(
        origin,
        other
          ? `${owner} draws against ${target}, which is a ${other.kind}; an advance carves a held payment's release`
          : `${owner} draws against ${target}, but no settlement with that name is declared`,
      );
      continue;
    }
    if (targetDecl.archetype.name !== "held_payment") {
      error(
        origin,
        `${owner} draws against ${target}, which is a ${targetDecl.archetype.name}; only a held payment has a release to carve`,
      );
      continue;
    }
    const hold = heldByName.get(target);
    // The hold's own body failed to check and already said why; a second
    // complaint about it here would only bury the first.
    if (!hold) continue;

    if (hold.payee !== settlement.advanced) {
      error(
        origin,
        `${owner} advances ${settlement.advanced}, but ${target} releases to ${hold.payee}; an advance carves the release of the party it finances`,
      );
      continue;
    }
    if (hold.payer === settlement.funder) {
      error(
        origin,
        `${settlement.funder} funds ${target} and finances it too; the party who pays the hold cannot be the funder its release repays`,
      );
      continue;
    }
    const first = carvedBy.get(target);
    if (first) {
      error(
        origin,
        `${owner} and settlement ${first} both draw against ${target}; one release repays one advance`,
      );
      continue;
    }
    carvedBy.set(target, settlement.name);

    // The hold's release is the advance's only repayment, so every exit that
    // is not that release leaves the funder unpaid. Cancellation is the exit
    // the author chose to declare, so an uncovered one is an error; the
    // pre-funding abandonment every hold carries is a lint.
    const recourse = settlements.some(
      (other) =>
        other.archetype === "scheduled" &&
        other.payer === settlement.advanced &&
        other.payee === settlement.funder,
    );
    if (recourse) continue;
    const repayment = `add a scheduled settlement collecting from the ${settlement.advanced.replaceAll("_", " ")} to the ${settlement.funder.replaceAll("_", " ")}`;
    if (hold.onCancel) {
      error(
        origin,
        `${owner} has no repayment path when ${target} is refunded instead of released; ${repayment}`,
      );
      continue;
    }
    warning(
      origin,
      `${owner} has no repayment path if ${target} is abandoned before it funds; ${repayment}`,
    );
  }

  // --- Whole-program lint -----------------------------------------------------
  for (const [name, party] of parties) {
    if (!referencedParties.has(name)) {
      warning(
        party.origin,
        `party ${name} is declared but no settlement or port involves them`,
      );
    }
  }
  for (const decl of portDecls) {
    if (portNames.has(decl.name.name) && !referencedPorts.has(decl.name.name)) {
      warning(
        decl.span,
        `port ${decl.name.name} is declared but nothing releases through it`,
      );
    }
  }
  for (const [name, span] of imported) {
    const used = settlementDecls.some((decl) => decl.archetype.name === name);
    if (!used) {
      warning(span, `${name} is imported but never instantiated`);
    }
  }

  const hasErrors = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (hasErrors || !header) return { diagnostics };
  return {
    diagnostics,
    program: {
      assets: [...assets.values()],
      name: header.name.name,
      parties: [...parties.values()],
      ports,
      settlements,
      title: header.title?.value ?? titleize(header.name.name),
    },
  };
}

function portFieldType(expr: Expr): PortFieldType | undefined {
  if (expr.kind === "ident" && expr.name === "text") return { kind: "text" };
  if (expr.kind === "ident" && expr.name === "date") return { kind: "date" };
  if (
    expr.kind === "call" &&
    expr.args.length === 1 &&
    expr.args[0]?.kind === "ident"
  ) {
    const argument = expr.args[0].name;
    if (expr.callee.name === "id") return { asset: argument, kind: "asset_id" };
    if (expr.callee.name === "money") {
      return { currency: argument, kind: "money" };
    }
  }
  return undefined;
}

function titleize(snake: string): string {
  const spaced = snake.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
