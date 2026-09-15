import {
  udlEffectKinds,
  resolveUdlActionPlans,
  type UdlDocument,
  type UdlEffectKind,
} from "@hyperscale0/udl";
import type {
  GeneralDiagnostic,
  JsonValue,
  TypedField,
  TypedProgram,
} from "./ir.ts";

export type HsxEffectKind = UdlEffectKind;

const CURRENCY = /^[A-Z]{3}$/;

export interface UdlCostTable {
  readonly version: string;
  /** Digest of the effective prices and fixed anchors after overrides. */
  readonly effectiveTableDigest: string;
  readonly currency: string;
  /** Billable runtime meters the platform's operation contract can emit. */
  readonly declaredMeters: readonly string[];
  readonly rows: readonly {
    readonly signature: string;
    readonly perEventMinor: string;
    readonly bps: number;
    readonly payer: "product" | "end_customer";
    /** Collection policy. Runtime resolves movement rows to execution or invoice. */
    readonly settlement: "per_event" | "invoice";
    readonly meter: string;
    readonly volumeMeter?: string;
  }[];
  readonly fixed: {
    readonly weights: Readonly<Record<string, number>>;
    readonly monthlyBaseMinor: string;
    readonly monthlyPerPointMinor: string;
    readonly activationBaseMinor: string;
    readonly activationPerPointMinor: string;
  };
}

export interface UdlCostManifest {
  readonly costTableVersion: string;
  readonly effectiveTableDigest: string;
  readonly currency: string;
  /** Complete runtime meter allowlist, independent of clause effects and payer. */
  readonly declaredMeters: readonly string[];
  readonly fixed: {
    readonly complexityScore: number;
    readonly monthlyMinor: string;
    readonly activationMinor: string;
    readonly components: readonly {
      readonly weight: string;
      readonly count: number;
    }[];
  };
  readonly actions: readonly {
    readonly instrument: string;
    readonly action: string;
    readonly components: readonly {
      readonly signature: string;
      readonly count: number;
      readonly perEventMinor: string;
      readonly bps: number;
      readonly payer: "product" | "end_customer";
      readonly settlement: "per_event" | "invoice";
      readonly meter: string;
      readonly volumeMeter?: string;
    }[];
    readonly perEventMinor: string;
    readonly endCustomerPerEventMinor: string;
  }[];
  /** Frozen list prices for every declared runtime meter. */
  readonly meterPrices: readonly UdlCostTable["rows"][number][];
  readonly monthlyEstimate: {
    readonly expression: string;
    readonly variables: readonly string[];
  };
}

/** One cost table, or one per billing currency the host prices. */
export type UdlCostTables = UdlCostTable | readonly UdlCostTable[];

export type CostManifestResult =
  | { readonly diagnostics: readonly GeneralDiagnostic[]; readonly ok: false }
  | { readonly manifest: UdlCostManifest; readonly ok: true };

export function buildCostManifest(
  program: TypedProgram,
  tables: UdlCostTables | undefined,
): CostManifestResult {
  const priced = tables === undefined ? [] : [tables].flat();
  if (priced.length === 0) {
    return {
      diagnostics: [
        {
          code: "HSX1301",
          fix: "supply the versioned UDL cost table to the compiler",
          message:
            "the compiler cannot price this program without a cost table",
          severity: "error",
          span: program.origin,
        },
      ],
      ok: false,
    };
  }

  const malformed = priced.find(
    (candidate) => !CURRENCY.test(candidate.currency),
  );
  if (malformed) {
    return {
      diagnostics: [
        {
          code: "HSX1303",
          fix: "name one three-letter uppercase billing currency on the cost table",
          message: `cost table ${malformed.version} has invalid billing currency ${malformed.currency}`,
          severity: "error",
          span: program.origin,
        },
      ],
      ok: false,
    };
  }

  const diagnostics: GeneralDiagnostic[] = [];
  const table = ledgerCostTable(program, priced, diagnostics);
  if (!table) return { diagnostics, ok: false };
  const rowsBySignature = indexCostRows(table);
  const actions: UdlCostManifest["actions"][number][] = [];
  for (const instrument of program.instruments) {
    for (const action of instrument.actions) {
      actions.push(
        priceAction(
          instrument.id,
          action.name,
          effectCounts(action.effects),
          rowsBySignature,
          (issue) => {
            if (issue.kind === "missing_price") {
              diagnostics.push({
                code: "HSX1301",
                fix: `add ${issue.signature} to cost table ${table.version}`,
                message: `${instrument.id}.${action.name} has unpriced effect signature ${issue.signature}`,
                severity: "error",
                span: action.origin,
              });
            } else {
              diagnostics.push({
                code: "HSX1302",
                fix: `store ${issue.signature} prices as nonnegative integers and name a volume meter for bps`,
                message: `cost table ${table.version} has an invalid ${issue.signature} price`,
                severity: "error",
                span: action.origin,
              });
            }
          },
        ),
      );
    }
  }
  const fixed = fixedCost(
    typedStructuralCounts(program),
    table,
    program.origin,
    diagnostics,
  );
  if (diagnostics.length > 0) return { diagnostics, ok: false };
  return { manifest: manifest(table, fixed, actions), ok: true };
}

/**
 * The table priced in the program's ledger currency: the one currency its
 * money fields move. A program without money fields prices in the host's
 * first table.
 */
function ledgerCostTable(
  program: TypedProgram,
  tables: readonly UdlCostTable[],
  diagnostics: GeneralDiagnostic[],
): UdlCostTable | undefined {
  const currencies = new Map<string, TypedField["origin"]>();
  for (const instrument of program.instruments) {
    for (const field of instrument.fields) {
      // An unbound currency parameter (money<C>) is decided per instance,
      // not by the program, so it names no ledger currency.
      const currency = field.type.currency;
      if (field.type.kind !== "money" || !currency || !CURRENCY.test(currency))
        continue;
      if (!currencies.has(currency)) currencies.set(currency, field.origin);
    }
  }
  const [first, second] = [...currencies];
  if (second) {
    diagnostics.push({
      code: "HSX1305",
      fix: `move all money in ${first![0]}; a program bills in one ledger currency`,
      message: `program moves money in ${[...currencies.keys()].join(" and ")}; a program bills in one ledger currency`,
      severity: "error",
      span: second[1],
    });
    return undefined;
  }
  const ledger = first?.[0] ?? tables[0]!.currency;
  const table = tables.find((candidate) => candidate.currency === ledger);
  if (table) return table;
  const priced = tables.map((candidate) => candidate.currency).join(", ");
  diagnostics.push({
    code: "HSX1304",
    fix: `move money in a priced currency: ${priced}`,
    message: `program moves money in ${ledger}, which no cost table prices (priced: ${priced})`,
    severity: "error",
    span: first?.[1] ?? program.origin,
  });
  return undefined;
}

export function computeUdlFixedCost(
  document: UdlDocument,
  table: UdlCostTable,
): UdlCostManifest["fixed"] {
  const diagnostics: GeneralDiagnostic[] = [];
  const fixed = fixedCost(
    udlStructuralCounts(document),
    table,
    { start: 0, end: 0 },
    diagnostics,
  );
  if (diagnostics.length > 0) throw new Error(diagnostics[0]?.message);
  return fixed;
}

export function buildUdlCostManifest(
  document: UdlDocument,
  table: UdlCostTable,
): UdlCostManifest {
  if (!CURRENCY.test(table.currency)) {
    throw new Error(
      `cost table ${table.version} has invalid billing currency ${table.currency}`,
    );
  }
  const rowsBySignature = indexCostRows(table);
  const actions: UdlCostManifest["actions"][number][] = [];
  for (const instrument of document.instruments) {
    const resolved = resolveUdlActionPlans(instrument);
    if (resolved.issues.length > 0)
      throw new Error(resolved.issues[0]!.message);
    for (const actionName of instrument.actionOrder) {
      const action = instrument.actions[actionName]!;
      const plan = resolved.plans.find(
        (candidate) => candidate.action === actionName,
      );
      const effects = (
        action.calls && plan ? plan.effects : (action.effects ?? {})
      ) as Readonly<
        Partial<
          Record<
            HsxEffectKind,
            readonly { readonly signature: string; readonly source: string }[]
          >
        >
      >;
      actions.push(
        priceAction(
          instrument.id,
          actionName,
          effectCounts(effects),
          rowsBySignature,
          (issue) => {
            if (issue.kind === "missing_price") {
              throw new Error(
                `${instrument.id}.${actionName} has unpriced effect signature ${issue.signature}`,
              );
            }
            throw new Error(
              `cost table ${table.version} has an invalid ${issue.signature} price`,
            );
          },
        ),
      );
    }
  }
  return manifest(table, computeUdlFixedCost(document, table), actions);
}

export function evaluateUdlCostManifest(
  costManifest: UdlCostManifest,
  readings: Readonly<Record<string, string>>,
): string {
  let total = BigInt(costManifest.fixed.monthlyMinor);
  const priced = new Set<string>();
  for (const price of costManifest.meterPrices) {
    if (price.payer !== "product") continue;
    const key = pricingKey(price);
    if (priced.has(key)) continue;
    priced.add(key);
    const count = scaledDecimal(readings[price.meter] ?? "0");
    total += (BigInt(price.perEventMinor) * count) / 1_000_000n;
    if (price.bps > 0 && price.volumeMeter) {
      const volume = scaledDecimal(readings[price.volumeMeter] ?? "0");
      total += (volume * BigInt(price.bps)) / 10_000n / 1_000_000n;
    }
  }
  return total.toString();
}

interface ActionPricingIssue {
  readonly kind: "invalid_price" | "missing_price";
  readonly signature: string;
}

function indexCostRows(
  table: UdlCostTable,
): ReadonlyMap<string, readonly UdlCostTable["rows"][number][]> {
  const rowsBySignature = new Map<string, UdlCostTable["rows"][number][]>();
  for (const row of table.rows) {
    const existing = rowsBySignature.get(row.signature);
    if (existing) existing.push(row);
    else rowsBySignature.set(row.signature, [row]);
  }
  return rowsBySignature;
}

function priceAction(
  instrument: string,
  action: string,
  counts: Iterable<readonly [string, number]>,
  rowsBySignature: ReadonlyMap<string, readonly UdlCostTable["rows"][number][]>,
  onIssue: (issue: ActionPricingIssue) => void,
): UdlCostManifest["actions"][number] {
  const components: UdlCostManifest["actions"][number]["components"][number][] =
    [];
  let productPerEvent = 0n;
  let endCustomerPerEvent = 0n;
  for (const [signature, count] of counts) {
    const rows = rowsBySignature.get(signature);
    if (!rows || rows.length === 0) {
      onIssue({ kind: "missing_price", signature });
      continue;
    }
    for (const row of rows) {
      if (!validPrice(row)) {
        onIssue({ kind: "invalid_price", signature });
        continue;
      }
      const eventTotal = BigInt(row.perEventMinor) * BigInt(count);
      if (row.payer === "product") productPerEvent += eventTotal;
      else endCustomerPerEvent += eventTotal;
      components.push({
        bps: row.bps,
        count,
        meter: row.meter,
        payer: row.payer,
        perEventMinor: row.perEventMinor,
        settlement: row.settlement,
        signature,
        ...(row.volumeMeter ? { volumeMeter: row.volumeMeter } : {}),
      });
    }
  }
  return {
    action,
    components,
    endCustomerPerEventMinor: endCustomerPerEvent.toString(),
    instrument,
    perEventMinor: productPerEvent.toString(),
  };
}

function manifest(
  table: UdlCostTable,
  fixed: UdlCostManifest["fixed"],
  actions: UdlCostManifest["actions"],
): UdlCostManifest {
  const declaredMeters = [...new Set(table.declaredMeters)].sort();
  const declaredMeterSet = new Set(declaredMeters);
  const meterPrices = table.rows.filter(
    (row) =>
      (row.perEventMinor !== "0" || row.bps > 0) &&
      (declaredMeterSet.has(row.meter) ||
        (row.volumeMeter !== undefined &&
          declaredMeterSet.has(row.volumeMeter))),
  );
  const variables = new Set<string>();
  const terms = [fixed.monthlyMinor];
  const priced = new Set<string>();
  for (const price of meterPrices) {
    if (price.payer !== "product") continue;
    const key = pricingKey(price);
    if (priced.has(key)) continue;
    priced.add(key);
    variables.add(price.meter);
    if (price.perEventMinor !== "0")
      terms.push(`${price.perEventMinor} * ${price.meter}`);
    if (price.bps > 0 && price.volumeMeter) {
      variables.add(price.volumeMeter);
      terms.push(`${price.bps} / 10000 * ${price.volumeMeter}`);
    }
  }
  return {
    actions,
    costTableVersion: table.version,
    currency: table.currency,
    declaredMeters,
    effectiveTableDigest: table.effectiveTableDigest,
    fixed,
    meterPrices,
    monthlyEstimate: {
      expression: terms.join(" + "),
      variables: [...variables].sort(),
    },
  };
}

function pricingKey(
  component: Pick<
    UdlCostTable["rows"][number],
    | "bps"
    | "meter"
    | "payer"
    | "perEventMinor"
    | "settlement"
    | "signature"
    | "volumeMeter"
  >,
): string {
  return [
    component.signature,
    component.meter,
    component.volumeMeter ?? "",
    component.perEventMinor,
    String(component.bps),
    component.payer,
    component.settlement,
  ].join("\u0000");
}

function effectCounts(
  effects: Readonly<
    Partial<
      Record<
        HsxEffectKind,
        readonly { readonly signature: string; readonly source: string }[]
      >
    >
  >,
): readonly [string, number][] {
  const counts = new Map<string, number>();
  for (const kind of udlEffectKinds) {
    for (const effect of effects[kind] ?? [])
      counts.set(effect.signature, (counts.get(effect.signature) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function fixedCost(
  counts: Readonly<Record<string, number>>,
  table: UdlCostTable,
  span: { readonly start: number; readonly end: number },
  diagnostics: GeneralDiagnostic[],
): UdlCostManifest["fixed"] {
  const components: UdlCostManifest["fixed"]["components"][number][] = [];
  let complexityScore = 0;
  for (const weight of Object.keys(table.fixed.weights)) {
    if (Object.hasOwn(counts, weight)) continue;
    diagnostics.push({
      code: "HSX1302",
      fix: `remove the unknown ${weight} weight from cost table ${table.version}`,
      message: `cost table ${table.version} has an unknown ${weight} complexity weight`,
      severity: "error",
      span,
    });
  }
  for (const [weight, count] of Object.entries(counts)) {
    if (count === 0) continue;
    const value = table.fixed.weights[weight];
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
      diagnostics.push({
        code: "HSX1302",
        fix: `add a nonnegative integer ${weight} weight to cost table ${table.version}`,
        message: `cost table ${table.version} has an invalid ${weight} complexity weight`,
        severity: "error",
        span,
      });
      continue;
    }
    complexityScore += value * count;
    components.push({ count, weight });
  }
  for (const [field, value] of Object.entries(table.fixed).filter(
    ([key]) => key !== "weights",
  )) {
    if (typeof value === "string" && nonnegativeInteger(value)) continue;
    diagnostics.push({
      code: "HSX1302",
      fix: `store fixed.${field} as a nonnegative decimal integer`,
      message: `cost table ${table.version} has an invalid fixed ${field} price`,
      severity: "error",
      span,
    });
  }
  return {
    activationMinor: (
      integerOrZero(table.fixed.activationBaseMinor) +
      integerOrZero(table.fixed.activationPerPointMinor) *
        BigInt(complexityScore)
    ).toString(),
    complexityScore,
    components,
    monthlyMinor: (
      integerOrZero(table.fixed.monthlyBaseMinor) +
      integerOrZero(table.fixed.monthlyPerPointMinor) * BigInt(complexityScore)
    ).toString(),
  };
}

function typedStructuralCounts(
  program: TypedProgram,
): Readonly<Record<string, number>> {
  const subjectKinds = new Set<string>();
  const decisions = new Set<string>();
  let flow = 0,
    move = 0,
    unwind = 0,
    aggregate = 0,
    gate = 0,
    timer = 0;
  for (const instrument of program.instruments) {
    for (const kind of arrayValue(objectValue(instrument.slots.subject)?.kinds))
      if (typeof kind === "string") subjectKinds.add(kind);
    if (instrument.actions.some((action) => action.slots.quote !== undefined))
      unwind += 1;
    aggregate += arrayValue(instrument.slots.aggregateInvariants).length;
    for (const action of instrument.actions) {
      flow += 1;
      const plan = instrument.actionPlans?.find(
        (plan) => plan.action === action.name,
      );
      move +=
        action.slots.calls && plan
          ? plan.leaves.filter((leaf) =>
              leaf.step.operation.startsWith("internal_transfer."),
            ).length
          : arrayValue(action.slots.moves).length;
      gate += arrayValue(action.slots.requiresRefs).length;
      if (action.slots.deadline !== undefined) timer += 1;
      if (action.slots.due !== undefined) timer += 1;
      const capability = objectValue(action.slots.decision)?.capability;
      if (typeof capability === "string") decisions.add(capability);
    }
  }
  return countRecord(
    program.instruments.length,
    subjectKinds.size,
    flow,
    move,
    decisions.size,
    unwind,
    aggregate,
    gate,
    timer,
  );
}

function udlStructuralCounts(
  document: UdlDocument,
): Readonly<Record<string, number>> {
  const subjectKinds = new Set<string>();
  const decisions = new Set<string>();
  let flow = 0,
    move = 0,
    unwind = 0,
    aggregate = 0,
    gate = 0,
    timer = 0;
  for (const instrument of document.instruments) {
    for (const kind of instrument.subject?.kinds ?? []) subjectKinds.add(kind);
    if (Object.values(instrument.actions).some((action) => action.quote))
      unwind += 1;
    aggregate += instrument.aggregateInvariants?.length ?? 0;
    const resolved = resolveUdlActionPlans(instrument);
    if (resolved.issues.length > 0)
      throw new Error(resolved.issues[0]!.message);
    for (const [name, action] of Object.entries(instrument.actions)) {
      flow += 1;
      const plan = resolved.plans.find((plan) => plan.action === name);
      move +=
        action.calls && plan
          ? plan.leaves.filter((leaf) =>
              leaf.step.operation.startsWith("internal_transfer."),
            ).length
          : action.moves.length;
      gate += action.requiresRefs?.length ?? 0;
      if (action.deadline) timer += 1;
      if (action.due) timer += 1;
      if (action.decision) decisions.add(action.decision.capability);
    }
  }
  return countRecord(
    document.instruments.length,
    subjectKinds.size,
    flow,
    move,
    decisions.size,
    unwind,
    aggregate,
    gate,
    timer,
  );
}

function countRecord(
  instrument: number,
  subjectKind: number,
  flow: number,
  move: number,
  providerDecision: number,
  unwind: number,
  aggregateInvariant: number,
  gate: number,
  timer: number,
): Readonly<Record<string, number>> {
  return {
    instrument,
    subject_kind: subjectKind,
    flow,
    move,
    provider_decision: providerDecision,
    unwind,
    aggregate_invariant: aggregateInvariant,
    gate,
    timer,
  };
}

function validPrice(row: UdlCostTable["rows"][number]): boolean {
  return (
    nonnegativeInteger(row.perEventMinor) &&
    Number.isSafeInteger(row.bps) &&
    row.bps >= 0 &&
    (row.settlement === "per_event" || row.settlement === "invoice") &&
    (row.bps === 0 || row.volumeMeter !== undefined)
  );
}

function arrayValue(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}
function objectValue(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}
function nonnegativeInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}
function integerOrZero(value: string): bigint {
  return nonnegativeInteger(value) ? BigInt(value) : 0n;
}

function scaledDecimal(value: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!match) throw new Error(`invalid meter reading ${value}`);
  return (
    BigInt(match[1] ?? "0") * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"))
  );
}
