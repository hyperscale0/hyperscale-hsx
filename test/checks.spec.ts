import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { testToolchain } from "./fixtures/toolchain.ts";

const header = `header custom
instrument approval(destination: enum(direct, held) = held, reserve: ref<custom.hold>?, fee: money = 10 SAR) {
 checks {
  reserve is set when destination is held { message: "Attachment {attachment} needs reserve.", fix: "Bind reserve or select direct." }
  fee is money { message: "\`{instrument}.fee\` accepts a fixed review fee. It cannot express a percentage of a quote.", fix: "Author the quote calculation." }
 }
 lifecycle { states: [open], initial: open }
 action create {}
}`;
const custom = testToolchain([header]);

// Mutation: ignore the arguments of a tunable's unsupported constructor.
test("header restrictions cannot disappear during binding or manifest admission", () => {
  for (const [type, value] of [
    ["party(business)", "owner"],
    ["money(10 SAR, 20 SAR)", "30 SAR"],
    ["text(1, 2)", '"long"'],
  ] as const) {
    const declaration = `header custom
instrument review(value: ${type}) {
 lifecycle { states: [open], initial: open }
 action create {}
}`;
    const toolchain = testToolchain([declaration]);
    const result = compile(
      `program p "P" object item { attach review = custom.review { value: ${value} } }`,
      toolchain,
    );
    expect(result.diagnostics).toMatchObject([
      { code: "HSX1001", source: "custom" },
    ]);
    const diagnostic = result.diagnostics[0]!;
    expect(declaration.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
      type,
    );
    expect(() => headerManifest(toolchain.std, ["custom"])).toThrow(
      "unsupported tunable constructor",
    );
  }
});

// Mutation: special-case financing or omit checks from the manifest.
test("host headers own conditional requirements and parameter policy explanations", () => {
  const source = `program reviews "Reviews"
object quote "Quote" { attach assessment = custom.approval {} }`;
  expect(compile(source, custom).diagnostics[0]).toMatchObject({
    message: "Attachment assessment needs reserve.",
    fix: "Bind reserve or select direct.",
  });
  expect(
    compile(
      source.replace(
        "approval {}",
        "approval { destination: direct, fee: 2% }",
      ),
      custom,
    ).diagnostics[0],
  ).toMatchObject({
    message:
      "`custom.approval.fee` accepts a fixed review fee. It cannot express a percentage of a quote.",
    fix: "Author the quote calculation.",
  });
  expect(
    compile(
      source.replace("approval {}", "approval { destination: direct }"),
      custom,
    ).diagnostics,
  ).toEqual([]);
  expect(
    headerManifest(custom.std, ["custom"]).headers[0]?.objects[0]?.checks,
  ).toEqual([
    {
      rule: "reserve is set",
      when: { selector: "destination", is: "held" },
      message: "Attachment {attachment} needs reserve.",
      fix: "Bind reserve or select direct.",
    },
    {
      rule: "fee is money",
      message:
        "`{instrument}.fee` accepts a fixed review fee. It cannot express a percentage of a quote.",
      fix: "Author the quote calculation.",
    },
  ]);
});

// Mutation: accept undeclared enum choices in a check's when.
test("a malformed check refuses instead of silently dropping a requirement", () => {
  const result = compile(
    'program p "P"\na = custom.approval {}',
    testToolchain([
      header.replace("destination is held", "destination is absent"),
    ]),
  );
  expect(result.diagnostics[0]).toMatchObject({
    source: "custom",
    message:
      "when must select a declared enum choice, or set or unset of an optional tunable",
  });
});

// Mutation: throw on the first failed parameter instead of retaining independent failures.
test("independent party bindings are returned together with their parameter locations", () => {
  const result = compile(
    `program p "P"
object quote "Quote" { attach review = custom.review { payer: absent, payee: missing } }`,
    testToolchain([
      `header custom
instrument review(payer: party, payee: party) {
 lifecycle { states: [open], initial: open }
 action create {}
}`,
    ]),
  );
  expect(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.related?.[0]?.message,
    ]),
  ).toEqual([
    ["subject_party_unbound", "Parameter payer"],
    ["subject_party_unbound", "Parameter payee"],
  ]);
});

const booking = readFileSync(
  new URL(
    "../../../toolchain/scenarios/ladder/1-g-booking/company.hsx",
    import.meta.url,
  ),
  "utf8",
);

// Mutation: stop at the first broken rule of an attachment.
test("an attachment returns one diagnostic per broken rule, each in the header's words", () => {
  const result = compile(
    booking.replace(
      "operator: programOperator",
      "operator: programOperator, early_until: 10d, late_from: 20d, middle_forfeit: 200%",
    ),
  );
  expect(
    result.diagnostics.map((d) => [d.source ?? "program", d.message, d.fix]),
  ).toEqual([
    [
      "program",
      "Attachment `reservation` sets `late_from` at or above `early_until`, so the late cancellation window opens before the early one closes.",
      "Choose a `late_from` shorter than `early_until`, such as `early_until: 30d, late_from: 15d`.",
    ],
    [
      "program",
      "`middle_forfeit` is the share of the held money a middle cancellation keeps, from 0% to 100%.",
      "Write `middle_forfeit` as a percentage from 0% to 100%, such as `middle_forfeit: 25%`.",
    ],
  ]);
});

// Mutation: parse check operands as single atoms, as the old constraints form did.
test("a check compares a sum of tunables and fails with its own message", () => {
  const sums = testToolchain([
    `header custom
instrument split(first: percent = 30%, second: percent = 30%, limit: percent = 50%) {
 checks {
  first + second <= limit { message: "Attachment {attachment} splits more than its limit.", fix: "Lower first or second." }
 }
 lifecycle { states: [open], initial: open }
 action create {}
}`,
  ]);
  const source = (tunables: string) =>
    `program p "P"\nobject deal "Deal" { attach share = custom.split { ${tunables} } }`;
  const result = compile(source("first: 40%"), sums);
  expect(result.diagnostics.map((d) => [d.message, d.fix])).toEqual([
    ["Attachment share splits more than its limit.", "Lower first or second."],
  ]);
  const diagnostic = result.diagnostics[0]!;
  expect(
    source("first: 40%").slice(diagnostic.span.start, diagnostic.span.end),
  ).toBe("40%");
  expect(diagnostic.related?.[0]).toMatchObject({
    source: "custom",
    message: "Header check",
  });
  expect(compile(source("first: 20%"), sums).diagnostics).toEqual([]);
});

// Mutation: let a second tunable value replace the first, or refuse an equal repeat.
test("a tunable given twice merges when equal and names both sites when not", () => {
  const twice = (second: string) =>
    booking.replace(
      "customer: owner, operator: programOperator",
      `customer: owner, operator: programOperator\n    late_forfeit: 50%\n    late_forfeit: ${second}`,
    );
  const result = compile(twice("40%"));
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic).toMatchObject({
    line: 7,
    column: 5,
    message:
      "late_forfeit is set twice with different values: 50% at 6:5 and 40% at 7:5",
    fix: "keep one",
  });
  expect(
    twice("40%").slice(
      diagnostic.related![0]!.span.start,
      diagnostic.related![0]!.span.end,
    ),
  ).toBe("late_forfeit: 50%");
  expect(compile(twice("50%")).diagnostics).toEqual([]);
});
