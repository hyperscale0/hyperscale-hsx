import {
  validateUdl,
  resolveUdlActionPlans,
  udlClauseVocabulary,
  type UdlDocument,
  type UdlIssueCode,
} from "@hyperscale0/udl";
import type {
  JsonValue,
  TypedInstrument,
  TypedProgram,
  ResolvedProgramActionPlan,
} from "./ir.ts";

import { hsxClauseDiagnosticCode } from "./diagnostics.ts";

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
        readonly document: UdlDocument;
        readonly actionPlans?: readonly ResolvedProgramActionPlan[];
        readonly originMap: readonly OriginMapEntry[];
      };
    };

export function lowerGeneralProgram(program: TypedProgram): GeneralLowerResult {
  const candidate = {
    instruments: program.instruments.map(generalInstrumentValue),
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
  const unresolved = unresolvedCompilerMarkers(candidate);
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
  const validation = validateUdl(candidate, {
    requireDecisionPartyBindings: true,
  });
  if (!validation.ok) {
    const origins = originMapFor(program);
    return {
      issues: validation.issues.map((issue) => {
        const origin = originForUdlPath(issue.path, origins);
        return {
          code:
            issue.category === "invalid_semantics"
              ? hsxClauseDiagnosticCode(issue.code)
              : "HSX1601",
          fix: issue.fix,
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
  const actionPlans = document.instruments.flatMap((instrument) =>
    resolveUdlActionPlans(instrument).plans.map((plan) => ({
      ...plan,
      instrument: instrument.id,
    })),
  );
  return {
    ok: true,
    value: {
      document,
      ...(actionPlans.length > 0 ? { actionPlans } : {}),
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

export function originForUdlPath<T extends { readonly path: string }>(
  path: string,
  origins: readonly T[],
): T | undefined {
  let longestMatch: T | undefined;
  let longestLength = -1;
  let rootFallback: T | undefined;

  for (let i = 0; i < origins.length; i += 1) {
    const entry = origins[i]!;
    const entryPath = entry.path;
    if (rootFallback === undefined && entryPath === "$") {
      rootFallback = entry;
    }
    const entryLen = entryPath.length;
    if (
      path === entryPath ||
      (path.length > entryLen &&
        (path.charCodeAt(entryLen) === 46 ||
          path.charCodeAt(entryLen) === 91) &&
        path.startsWith(entryPath))
    ) {
      if (entryLen > longestLength) {
        longestMatch = entry;
        longestLength = entryLen;
      }
    }
  }

  return longestMatch ?? rootFallback;
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

/** Emit a canonical clause value through the same generic HSX block syntax. */
export function emitUdlClause(
  scope: "instrument" | "action",
  target: string,
  value: JsonValue,
): string {
  const clause = udlClauseVocabulary.find(
    (entry) => entry.scope === scope && entry.target === target,
  );
  if (!clause) throw new Error(`Unknown ${scope} clause ${target}`);
  return `${clause.spelling.replaceAll(" ", "_")}: ${clauseLiteral(value)};`;
}

function clauseLiteral(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(clauseLiteral).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${clauseLiteral(item)};`)
      .join(" ")} }`;
  }
  if (
    value === null ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new Error(
      "HSX clause literals require non-null values and safe integers",
    );
  }
  return JSON.stringify(value);
}

export function hasActionPlanClauses(instrument: TypedInstrument): boolean {
  return (
    instrument.slots.piecePlan !== undefined ||
    instrument.slots.actionLibrary !== undefined ||
    instrument.actions.some(
      (action) =>
        action.slots.calls !== undefined ||
        action.slots.pieceStage !== undefined,
    )
  );
}

export function generalInstrumentValue(instrument: TypedInstrument) {
  return {
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
  };
}
