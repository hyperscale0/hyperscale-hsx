import {
  serializeUdl,
  validateUdl,
  type UdlDocument,
  type UdlIssueCode,
} from "@hyperscale0/udl";
import type { JsonValue, TypedInstrument, TypedProgram } from "./ir.ts";

export interface OriginMapEntry {
  readonly path: string;
  readonly span: { readonly end: number; readonly start: number };
}

export interface GeneralLoweringIssue {
  readonly code: string;
  readonly fix: string;
  readonly message: string;
  readonly path: string;
  readonly span: { readonly end: number; readonly start: number };
  readonly udlCode: UdlIssueCode;
}

export type GeneralLowerResult =
  | { readonly issues: readonly GeneralLoweringIssue[]; readonly ok: false }
  | {
      readonly ok: true;
      readonly value: {
        readonly canonicalUdl: string;
        readonly document: UdlDocument;
        readonly frame: Record<string, JsonValue>;
        readonly originMap: readonly OriginMapEntry[];
      };
    };

export function lowerGeneralProgram(program: TypedProgram): GeneralLowerResult {
  const candidate = {
    instruments: program.instruments.map((instrument) => ({
      ...instrument.slots,
      actionOrder: instrument.actions.map((action) => action.name),
      actions: Object.fromEntries(
        instrument.actions.map((action) => [action.name, action.slots]),
      ),
      fields: Object.fromEntries(
        instrument.fields.map((field) => [field.name, field.schema]),
      ),
      id: instrument.id,
      required: requiredFields(instrument),
    })),
    product: program.name,
    subjects: program.subjects.map((subject) => ({
      declaredValue: subject.declaredValue,
      kind: subject.kind,
      schema: subject.schema,
      title: subject.title,
      version: subject.version,
    })),
    title: program.title,
    udl: 1,
    version: 1,
  };
  const frame = frameFor(program);
  const unresolved = [
    ...unresolvedCompilerMarkers(candidate),
    ...unresolvedCompilerMarkers(frame, "$.frame"),
  ];
  if (unresolved.length > 0) {
    const origins = originMapFor(program);
    return {
      issues: unresolved.map(({ marker, path }) => ({
        code: "HSX1603",
        fix: "correct the compile-time block keys or parameter bindings",
        message: `${path}: emitted value contains unresolved compiler marker ${marker}`,
        path,
        span: originForUdlPath(path, origins)?.span ?? program.origin,
        udlCode: "UDL1003",
      })),
      ok: false,
    };
  }
  const validation = validateUdl(candidate);
  if (!validation.ok) {
    const origins = originMapFor(program);
    return {
      issues: validation.issues.map((issue) => {
        const origin = originForUdlPath(issue.path, origins);
        return {
          code: issue.category === "invalid_semantics" ? "HSX1602" : "HSX1601",
          fix: "correct the named clause so it matches the targeted UDL definition",
          message: `${issue.path}: ${issue.message}`,
          path: issue.path,
          span: origin?.span ?? program.origin,
          udlCode: issue.code,
        };
      }),
      ok: false,
    };
  }
  const document = validation.value;
  return {
    ok: true,
    value: {
      canonicalUdl: serializeUdl(document),
      document,
      frame,
      originMap: originMapFor(program),
    },
  };
}

const COMPILER_MARKERS = ["__hsx_none__", "invalid_compile_time_name"] as const;

function unresolvedCompilerMarkers(
  value: unknown,
  path = "$",
): readonly { readonly marker: string; readonly path: string }[] {
  if (typeof value === "string") {
    return COMPILER_MARKERS.filter((marker) => value.includes(marker)).map(
      (marker) => ({ marker, path }),
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      unresolvedCompilerMarkers(item, `${path}[${index}]`),
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const childPath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`;
    const keyIssues = COMPILER_MARKERS.filter((marker) =>
      key.includes(marker),
    ).map((marker) => ({ marker, path: childPath }));
    return [...keyIssues, ...unresolvedCompilerMarkers(item, childPath)];
  });
}

function originForUdlPath(
  path: string,
  origins: readonly OriginMapEntry[],
): OriginMapEntry | undefined {
  return (
    [...origins]
      .filter(
        (entry) =>
          path === entry.path ||
          path.startsWith(`${entry.path}.`) ||
          path.startsWith(`${entry.path}[`),
      )
      .sort((left, right) => right.path.length - left.path.length)[0] ??
    origins.find((entry) => entry.path === "$")
  );
}

export function requiredFields(instrument: TypedInstrument): string[] {
  const explicit = instrument.slots.required;
  if (
    Array.isArray(explicit) &&
    explicit.every((field): field is string => typeof field === "string")
  ) {
    return [...explicit];
  }
  const required = new Set(
    instrument.fields
      .filter((field) => field.required)
      .map((field) => field.name),
  );
  const partyFields =
    instrument.slots.parties &&
    typeof instrument.slots.parties === "object" &&
    !Array.isArray(instrument.slots.parties)
      ? Object.values(instrument.slots.parties).filter(
          (value): value is string =>
            typeof value === "string" && required.has(value),
        )
      : [];
  return [
    ...new Set(partyFields),
    ...instrument.fields
      .map((field) => field.name)
      .filter((name) => required.has(name) && !partyFields.includes(name)),
  ];
}

function frameFor(program: TypedProgram): Record<string, JsonValue> {
  const actors = new Map<string, Record<string, JsonValue>>();
  const moneyEvents: Record<string, JsonValue>[] = [];
  const design: string[] = [];
  const fees: Record<string, JsonValue>[] = [];
  const mechanics = new Set<string>();
  const eventKeys = new Set<string>();
  const ensureActor = (rawKey: string, role: string): string => {
    const key = frameKey(rawKey);
    if (!actors.has(key)) {
      actors.set(key, {
        key,
        label: titleize(key),
        maxCount: 1,
        minCount: 1,
        role,
      });
    }
    return key;
  };
  const uniqueEventKey = (raw: string): string => {
    const base = frameKey(raw);
    let key = base;
    let ordinal = 2;
    while (eventKeys.has(key)) {
      const suffix = `_${ordinal}`;
      key = `${base.slice(0, 40 - suffix.length)}${suffix}`;
      ordinal += 1;
    }
    eventKeys.add(key);
    return key;
  };
  for (const instrument of program.instruments) {
    const actorByField = new Map<string, string>();
    const parties = instrument.slots.parties;
    if (parties && typeof parties === "object" && !Array.isArray(parties)) {
      for (const [role, value] of Object.entries(parties)) {
        if (typeof value !== "string") continue;
        const actor = ensureActor(role, frameActorRole(role, "source"));
        actorByField.set(value, actor);
      }
    }
    for (const action of instrument.actions) {
      if (action.slots.due) mechanics.add("recurring_billing");
      const moves = action.slots.moves;
      if (!Array.isArray(moves)) continue;
      moves.forEach((move, index) => {
        if (moneyEvents.length >= 20) return;
        if (!move || typeof move !== "object" || Array.isArray(move)) return;
        const bind =
          move.bind &&
          typeof move.bind === "object" &&
          !Array.isArray(move.bind)
            ? move.bind
            : {};
        const source = frameActorForBinding(
          bind.sourceAccountId,
          actorByField,
          "source",
          ensureActor,
        );
        const destination = frameActorForBinding(
          bind.destinationAccountId,
          actorByField,
          "destination",
          ensureActor,
        );
        const operation =
          typeof move.operation === "string" ? move.operation : "transfer";
        if (source === "escrow" || destination === "escrow") {
          mechanics.add("escrow");
        }
        moneyEvents.push({
          allocationTotalBps: 0,
          amount: bindingWords(bind.amount) || "the declared amount",
          amountDependencies: [],
          amountMode: "fixed",
          amountSchedule: [],
          distribution: "single",
          fromActor: source,
          key: uniqueEventKey(
            typeof move.key === "string"
              ? move.key
              : `${instrument.id}_${action.name}_${index + 1}`,
          ),
          kind: frameEventKind(operation, source, destination),
          label: `${titleize(action.name)} movement`,
          occurrence: action.slots.due ? "repeatable" : "once",
          timing: action.name === "create" ? "on_create" : "on_lifecycle",
          toActor: destination,
          trigger: `when ${action.name.replaceAll("_", " ")} runs`,
        });
      });
    }
    if (design.length < 10) {
      design.push(
        `${instrument.id}: ${instrument.fields.length} fields and ${instrument.actions.length} actions`,
      );
    }
    const feeRules = instrument.slots.feeRules;
    if (Array.isArray(feeRules)) {
      feeRules.forEach((fee, index) => {
        if (fees.length >= 4) return;
        if (!fee || typeof fee !== "object" || Array.isArray(fee)) return;
        fees.push({
          label: `${titleize(instrument.id)} fee ${index + 1}`,
          on:
            typeof fee.baseField === "string"
              ? fee.baseField
              : `${instrument.id} movement`,
          structure:
            typeof fee.position === "string"
              ? `${fee.position.replaceAll("_", " ")} fee`
              : "declared fee",
        });
      });
    }
  }
  if (actors.size === 0) ensureActor("platform", "platform");
  if (moneyEvents.length === 0) {
    const actor = actors.keys().next().value ?? "platform";
    moneyEvents.push({
      allocationTotalBps: 0,
      amount: "the declared settlement amount",
      amountDependencies: [],
      amountMode: "fixed",
      amountSchedule: [],
      distribution: "single",
      fromActor: actor,
      key: uniqueEventKey(`${program.name}_create`),
      kind: "charge",
      label: `${program.title} movement`,
      occurrence: "once",
      timing: "on_create",
      toActor: actor,
      trigger: "when the settlement is created",
    });
  }
  if (mechanics.size === 0) mechanics.add("escrow");
  return {
    actors: [...actors.values()],
    confidence: "high",
    conservationGroups: [],
    design,
    feePolicy: fees.length > 0 ? "defined" : "none",
    fees,
    headline: program.title,
    mechanics: [...mechanics],
    moneyEvents,
    offPlatform: [],
    openQuestions: [],
    rules: [],
    subjects: program.subjects.map((subject) => ({
      kind: subject.kind,
      title: subject.title,
    })),
    summary: `${program.title} compiles ${program.instruments.length} financial instrument${program.instruments.length === 1 ? "" : "s"}.`,
  };
}

function frameActorForBinding(
  value: JsonValue | undefined,
  actorByField: ReadonlyMap<string, string>,
  direction: "destination" | "source",
  ensureActor: (key: string, role: string) => string,
): string {
  const path = bindingWords(value);
  if (path.includes("escrowAccountId")) return "escrow";
  const field = path.startsWith("fields.")
    ? path.slice("fields.".length)
    : path;
  const declared = actorByField.get(field);
  if (declared) return declared;
  if (field.toLowerCase().includes("platform")) {
    return ensureActor("platform", "platform");
  }
  return ensureActor(
    direction === "source" ? "payer" : "beneficiary",
    direction === "source" ? "payer" : "beneficiary",
  );
}

function frameActorRole(
  role: string,
  direction: "destination" | "source",
): string {
  return [
    "payer",
    "beneficiary",
    "platform",
    "provider",
    "guardian",
    "holder",
  ].includes(role)
    ? role
    : direction === "source"
      ? "payer"
      : "beneficiary";
}

function frameEventKind(
  operation: string,
  source: string,
  destination: string,
): string {
  if (operation.endsWith(".reserve")) return "hold";
  if (operation.endsWith(".void") || operation.endsWith(".return")) {
    return "refund";
  }
  if (operation.startsWith("payout.")) return "payout";
  if (source === "escrow" || destination === "escrow") return "release";
  return "charge";
}

function frameKey(value: string): string {
  const snake = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const leading = /^[a-z]/.test(snake) ? snake : `event_${snake}`;
  return leading.slice(0, 40) || "event";
}

function bindingWords(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const binding = value as Readonly<Record<string, JsonValue>>;
  if (binding.from === "const" && typeof binding.value === "string")
    return binding.value;
  if (typeof binding.path === "string") return binding.path;
  return "";
}

function originMapFor(program: TypedProgram): OriginMapEntry[] {
  const entries: OriginMapEntry[] = [{ path: "$", span: program.origin }];
  program.subjects.forEach((subject, index) => {
    entries.push({ path: `$.subjects[${index}]`, span: subject.origin });
  });
  program.instruments.forEach((instrument, index) => {
    const base = `$.instruments[${index}]`;
    entries.push({ path: base, span: instrument.origin });
    instrument.fields.forEach((field) => {
      entries.push({
        path: `${base}.fields.${field.name}`,
        span: field.origin,
      });
    });
    instrument.actions.forEach((action) => {
      entries.push({
        path: `${base}.actions.${action.name}`,
        span: action.origin,
      });
    });
  });
  return entries;
}

function titleize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
