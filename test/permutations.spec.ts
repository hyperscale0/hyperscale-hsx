import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { referencedUdlInstrumentIds, validateUdl } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { parseProgram } from "../src/parse.ts";
import type { Expr } from "../src/ast.ts";

const source = readFileSync(
  new URL("../examples/library.hsx", import.meta.url),
  "utf8",
);
const parsed = parseProgram(source).program;
const objects = parsed.decls.filter((decl) => decl.kind === "object");
const baseline = compile(source);
if (!baseline.artifacts) throw new Error(JSON.stringify(baseline.diagnostics));
const document = baseline.artifacts.document;
const manifest = headerManifest();
const spell = (expr: Expr) => source.slice(expr.span.start, expr.span.end);
const owner = (id: string) =>
  objects
    .filter((object) => id === object.name || id.startsWith(object.name + "_"))
    .sort((a, b) => b.name.length - a.name.length)[0];

/** Include the transitive record dependencies of the selected public object. */
function programFor(name: string, values: Record<string, string>): string {
  const selected = new Set([name]);
  for (const current of selected) {
    for (const instrument of document.instruments.filter(
      (instrument) => owner(instrument.id)?.name === current,
    )) {
      for (const id of referencedUdlInstrumentIds(instrument)) {
        const dependency = owner(id);
        if (dependency) selected.add(dependency.name);
      }
    }
  }
  const declarations = objects.filter((object) => selected.has(object.name));
  const headers = [
    ...new Set(declarations.map((object) => object.object.split(".")[0]!)),
  ];
  const parties = parsed.decls
    .filter((decl) => decl.kind === "party")
    .map((decl) => source.slice(decl.span.start, decl.span.end));
  return [
    `program permutation "Permutation"`,
    ...headers.map((header) => `use ${header}`),
    ...parties,
    ...declarations.map((object) => {
      const entries = new Map(
        object.body.entries.map((entry) => [entry.key, spell(entry.value)]),
      );
      if (object.name === name)
        for (const [key, value] of Object.entries(values))
          entries.set(key, value);
      return `${object.name} = ${object.object} { ${[...entries].map(([key, value]) => `${key}: ${value}`).join(", ")} }`;
    }),
  ].join("\n");
}

type Tunable = ReturnType<
  typeof headerManifest
>["headers"][number]["objects"][number]["tunables"][number];
function notation(type: string, value: bigint): string {
  if (value < 0n) return "-" + notation(type, -value);
  if (type === "money")
    return `${value / 100n}.${String(value % 100n).padStart(2, "0")} SAR`;
  if (type === "percent") return `${Number(value) / 100}%`;
  if (type === "duration") return `${value}ms`;
  return String(value);
}
function sample(tunable: Tunable, fallback: string | undefined): string[] {
  if (tunable.values) return tunable.values;
  if (tunable.minimum === undefined || tunable.maximum === undefined) return [];
  const type = tunable.type.split("(")[0]!;
  const minimum = BigInt(tunable.minimum),
    maximum = BigInt(tunable.maximum);
  const large =
    type === "money"
      ? 100000000n
      : type === "duration"
        ? 31536000000n
        : type === "percent"
          ? 10000n
          : 366n;
  const middle =
    tunable.default && tunable.default !== "runtime"
      ? tunable.default
      : fallback;
  return [
    ...new Set([
      notation(type, minimum),
      middle ??
        notation(type, (minimum + (large < maximum ? large : maximum)) / 2n),
      notation(type, large < maximum ? large : maximum),
    ]),
  ];
}

/** Full products up to 512; larger domains cover every pair with other values at baseline. */
function combinations(domains: string[][]): string[][] {
  if (domains.reduce((size, domain) => size * domain.length, 1) <= 512)
    return domains.reduce<string[][]>(
      (rows, domain) =>
        rows.flatMap((row) => domain.map((value) => [...row, value])),
      [[]],
    );
  const cases = new Map<string, string[]>();
  for (let i = 0; i < domains.length; i++)
    for (let j = i + 1; j < domains.length; j++)
      for (const first of domains[i]!)
        for (const second of domains[j]!) {
          const row = domains.map((domain) => domain[1] ?? domain[0]!);
          row[i] = first;
          row[j] = second;
          cases.set(JSON.stringify(row), row);
        }
  if (cases.size > 512) throw new Error("pairwise matrix exceeds 512 cases");
  return [...cases.values()];
}

const numeric = (text: string): bigint => {
  const match = /^(\d+)(?:\.(\d+))?\s*(SAR|%|ms|s|m|h|d|w)?$/.exec(text);
  if (!match) throw new Error(`not numeric: ${text}`);
  if (match[3] === "SAR" || match[3] === "%")
    return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  const scale: Record<string, bigint> = {
    ms: 1n,
    s: 1000n,
    m: 60000n,
    h: 3600000n,
    d: 86400000n,
    w: 604800000n,
  };
  return BigInt(match[1]!) * (scale[match[3] ?? ""] ?? 1n);
};

for (const header of manifest.headers)
  for (const object of header.objects) {
    test(`${object.qualifiedName} tunable permutations`, () => {
      const example = objects.find(
        (entry) => entry.object === object.qualifiedName,
      );
      if (!example)
        throw new Error(`missing inventory object ${object.qualifiedName}`);
      const arguments_ = Object.fromEntries(
        example.body.entries.map((entry) => [entry.key, spell(entry.value)]),
      );
      const varied = object.tunables
        .map((tunable) => ({
          tunable,
          values: sample(tunable, arguments_[tunable.name]),
        }))
        .filter((entry) => entry.values.length);
      const cases = combinations(varied.map((entry) => entry.values));
      for (const row of cases) {
        const overrides = Object.fromEntries(
          varied.map((entry, index) => [entry.tunable.name, row[index]!]),
        );
        const values = { ...arguments_, ...overrides };
        const violated = object.constraints.filter((constraint) => {
          const a = numeric(values[constraint.tunable]!),
            b = numeric(values[constraint.other]!);
          return !(constraint.relation === "less_than"
            ? a < b
            : constraint.relation === "at_most"
              ? a <= b
              : a > b);
        });
        const result = compile(programFor(example.name, overrides));
        if (violated.length) {
          expect(
            result.verdict === "invalid" &&
              result.diagnostics.some((diagnostic) =>
                violated.some((constraint) =>
                  diagnostic.message.includes(constraint.tunable),
                ),
              ),
          ).toBe(true);
          continue;
        }
        if (!result.artifacts)
          throw new Error(
            `${object.qualifiedName} ${JSON.stringify(overrides)}: ${JSON.stringify(result.diagnostics)}`,
          );
        const valid = validateUdl(result.artifacts.document);
        const publicNames = result.artifacts.document.instruments.every(
          (instrument) =>
            Object.values(instrument.actions).every((action) => {
              const automatic =
                action.actor === "clock" ||
                (typeof action.actor === "object" && "parent" in action.actor);
              return automatic
                ? action.publicAction === undefined
                : typeof action.publicAction === "string";
            }),
        );
        const emitted = result.artifacts.document;
        const names = new Set(
          emitted.instruments.flatMap((instrument) =>
            Object.values(instrument.actions).flatMap((action) =>
              action.publicAction ? [action.publicAction] : [],
            ),
          ),
        );
        const presentIds = new Set(
          emitted.instruments.map((instrument) => instrument.id),
        );
        const retained =
          presentIds.has(example.name) &&
          document.instruments
            .filter((instrument) => presentIds.has(instrument.id))
            .every((instrument) =>
              Object.entries(instrument.actions).every(([key, action]) => {
                if (!action.publicAction) return true;
                const lossBranch =
                  object.qualifiedName === "lending.distribution" &&
                  instrument.id === example.name &&
                  values.mode === "loss" &&
                  ["prepare_cash", "distribute_cash"].includes(key);
                return names.has(
                  lossBranch
                    ? action.publicAction.replace("Cash", "Loss")
                    : action.publicAction,
                );
              }),
            );
        expect([result.verdict, valid.ok, publicNames && retained]).toEqual([
          "valid",
          true,
          true,
        ]);
      }
      for (const { tunable } of varied) {
        if (tunable.values) {
          const result = compile(
            programFor(example.name, { [tunable.name]: "undeclared_choice" }),
          );
          expect(
            result.verdict === "invalid" &&
              result.diagnostics.some((diagnostic) =>
                diagnostic.message.includes(tunable.name),
              ),
          ).toBe(true);
        }
        if (tunable.maximum === undefined || tunable.minimum === undefined)
          continue;
        const type = tunable.type.split("(")[0]!;
        for (const value of [
          BigInt(tunable.minimum) - 1n,
          BigInt(tunable.maximum) + 1n,
        ]) {
          const invalid = notation(type, value);
          const result = compile(
            programFor(example.name, { [tunable.name]: invalid }),
          );
          expect(
            result.verdict === "invalid" &&
              result.diagnostics.some((diagnostic) =>
                diagnostic.message.includes(tunable.name),
              ),
          ).toBe(true);
        }
      }
    }, 120000);
  }

// Mutations: omit a required binding, emit an instrument declaration, or name the wrong header.
test("compiler authoring templates become valid programs after binding their placeholders", () => {
  for (const header of manifest.headers) {
    for (const entry of header.objects) {
      const witness = objects.find(
        (object) => object.object === entry.qualifiedName,
      )!;
      const template = entry.authoringTemplate;
      let completed = template.source.replaceAll(
        template.instancePlaceholder,
        witness.name,
      );
      for (const binding of template.requiredBindings) {
        const value = witness.body.entries.find(
          (item) => item.key === binding.name,
        );
        const referencedType = binding.type.match(/^ref<([^>]+)>/)?.[1];
        const implicitObject = objects.find(
          (object) => object.object === referencedType,
        );
        const fallback = entry.tunables.find(
          (tunable) => tunable.name === binding.name,
        )?.default;
        const partyKind = fallback?.match(/^party\(([^)]+)\)$/)?.[1];
        const implicitParty = parsed.decls
          .filter((decl) => decl.kind === "party")
          .find((decl) => decl.partyKind === partyKind);
        const spelling = value
          ? spell(value.value)
          : (implicitObject?.name ?? implicitParty?.name ?? fallback);
        if (!spelling)
          throw new Error(
            `Missing witness binding ${entry.qualifiedName}.${binding.name}`,
          );
        completed = completed.replaceAll(binding.placeholder, spelling);
      }
      const program = source.replace(
        `use ${header.name}`,
        template.requiredImport,
      );
      const target = parseProgram(program).program.decls.find(
        (decl) => decl.kind === "object" && decl.name === witness.name,
      )!;
      const result = compile(
        program.slice(0, target.span.start) +
          completed +
          program.slice(target.span.end),
      );
      expect(
        result.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        ),
      ).toEqual([]);
      expect(result.artifacts).toBeDefined();
    }
  }
});
