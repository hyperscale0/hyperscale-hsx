import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { parseProgram } from "../src/parse.ts";

const instrument = (clauses: string) => `program review "Review"
instrument review {
 lifecycle { states: [open], initial: open }
 action create {}
 ${clauses}
}`;
const headerProgram = (parameters: string, supplied: string, body = "") => {
  const header = `header custom
instrument review(${parameters}) {
 lifecycle { states: [open], initial: open }
 action create {}
 ${body}
}`;
  const source = `program p "P"\nuse custom\nreview = custom.review { ${supplied} }`;
  return {
    header,
    source,
    options: { standardLibrary: { source: () => header } },
  };
};

// Mutation: restore the string regex that permits raw JSON control characters.
test("raw controls return a lexical diagnostic instead of escaping JSON.parse", () => {
  for (const code of [0, 9, 13, 31]) {
    const result = compile(
      `program p "before${String.fromCharCode(code)}after"`,
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics[0]).toMatchObject({
      code: "HSX1000",
      stage: "parse",
    });
  }
  expect(parseProgram('program p "before\\tafter"').diagnostics).toEqual([]);
});

// Mutation: point the operator failure at peek() after consuming the bad token.
test("comparison syntax errors point at the offending operator", () => {
  const source = instrument(
    'action check { from: open, to: open requires self.id wrong "id" }',
  );
  const result = compile(source);
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  expect([
    diagnostic.code,
    source.slice(diagnostic.span.start, diagnostic.span.end),
  ]).toEqual(["HSX1000", "wrong"]);
});

// Mutation: remove the byte cap or count UTF-16 units instead of UTF-8 bytes.
test("HSX1004 rejects a source larger than 256 KiB before lexing", () => {
  const source = `program p "P"\n//${"é".repeat(131072)}`;
  expect(compile(source).diagnostics.map((d) => d.code)).toEqual(["HSX1004"]);
});

// Mutation: remove the JSON boundary diagnostic.
test("HSX1014 explains that serialized UDL is not authoring input", () => {
  const source = ' \n {"udl":4}';
  expect(compile(source).diagnostics).toMatchObject([
    {
      code: "HSX1014",
      stage: "parse",
      span: { start: 3, end: 4 },
      fix: 'write program name "Title" followed by HSX declarations',
    },
  ]);
});

// Mutation: permit the second declaration to overwrite the first currency.
test("a later currency cannot hide an unsupported earlier declaration", () => {
  const source = 'program p "P" currency USD currency SAR';
  expect(compile(source).diagnostics.map((d) => d.message)).toEqual([
    "currency is declared twice",
  ]);
});

// Mutation: remove field-constructor arity and name checks.
test("field constructors refuse missing and discarded arguments", () => {
  for (const [type, message] of [
    ["sensitive()", "sensitive needs one field type"],
    ["sensitive(text, money)", "sensitive needs one field type"],
    ["list()", "list needs an item type and optional bound"],
    ["list(text, 2, 3)", "list needs an item type and optional bound"],
    ["boolean(true)", "unknown field constructor boolean"],
  ] as const) {
    const result = compile(instrument(`fields { note: ${type} }`));
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["HSX1001", message],
    ]);
  }
});

// Mutation: use the sensitive wrapper as the reference type in lowerFields.
test("sensitive reference fields retain their target and sensitivity", () => {
  const result = compile(
    instrument("fields { related: sensitive(ref<self>) }"),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.artifacts?.document.instruments[0]?.fields).toEqual([
    {
      name: "related",
      type: "ref",
      targetKind: "instrument",
      target: "review",
      sensitive: true,
    },
  ]);
});

// Mutation: restore ISO-duration detection for quoted text in literal().
test("duration-shaped quoted text remains text while duration tunables lower to milliseconds", () => {
  const fixture = headerProgram(
    "label: text, delay: duration",
    'label: "P1D", delay: "P1D"',
    "fields { label: text = label, delay: duration = delay }",
  );
  const result = compile(fixture.source, fixture.options);
  expect(result.diagnostics).toEqual([]);
  expect(result.artifacts?.document.instruments[0]?.fields).toEqual([
    { name: "label", type: "text", value: "P1D" },
    { name: "delay", type: "duration", value: 86400000 },
  ]);
});

// Mutation: accept a trailing T without time components in the duration regex.
test("an incomplete ISO time component is an invalid duration", () => {
  const fixture = headerProgram("delay: duration", "delay: P1DT");
  expect(
    compile(fixture.source, fixture.options).diagnostics.map((d) => d.message),
  ).toEqual(["delay: invalid duration"]);
});

// Mutation: throw a plain Error in tunableBounds or re-anchor it at the supplied value.
test("malformed integer bounds name the header declaration", () => {
  const fixture = headerProgram("count: integer(9, 1)", "count: 2");
  const result = compile(fixture.source, fixture.options);
  expect(result.diagnostics).toHaveLength(1);
  const d = result.diagnostics[0]!;
  expect([
    d.code,
    d.source,
    fixture.header.slice(d.span.start, d.span.end),
  ]).toEqual(["HSX1001", "custom", "integer(9, 1)"]);
});

// Mutation: omit the boolean value check and unknown-type refusal.
test("unused tunables still require a declared type and matching value", () => {
  for (const [type, value, message] of [
    ["boolean", '"yes"', "flag needs boolean"],
    ["boolean", "yes", "flag needs boolean"],
    ["misspelled", "1", "unknown tunable type misspelled"],
  ] as const) {
    const fixture = headerProgram(`flag: ${type}`, `flag: ${value}`);
    expect(
      compile(fixture.source, fixture.options).diagnostics.map(
        (d) => d.message,
      ),
    ).toEqual([message]);
  }
  const fixture = headerProgram(
    "flag: boolean",
    "flag: true",
    "fields { flag: boolean = flag }",
  );
  expect(
    compile(fixture.source, fixture.options).artifacts?.document.instruments[0]
      ?.fields,
  ).toEqual([{ name: "flag", type: "boolean", value: true }]);
});

// Mutation: pass constraint operands straight to BigInt, ignoring their types.
test("constraints refuse nonnumeric or unlike tunables without throwing", () => {
  for (const [parameters, supplied] of [
    ["first: text, second: text", 'first: "a", second: "b"'],
    ["first: money, second: integer", "first: 1 SAR, second: 2"],
  ]) {
    const fixture = headerProgram(
      parameters!,
      supplied!,
      "constraints { first: less_than(second) }",
    );
    expect(
      compile(fixture.source, fixture.options).diagnostics.map(
        (d) => d.message,
      ),
    ).toEqual(["constraint needs numeric tunables of the same type"]);
  }
});

// Mutation: allow the second header symbol or parameter to replace the first.
test("header declarations refuse duplicate instruments and parameters", () => {
  const fixture = headerProgram("count: integer, count: integer", "count: 1");
  expect(
    compile(fixture.source, fixture.options).diagnostics.map((d) => d.message),
  ).toEqual(["duplicate parameter count"]);
  const header = fixture.header.replace("count: integer, count: integer", "");
  expect(
    compile(fixture.source, {
      standardLibrary: { source: () => `${header}\ninstrument review {}` },
    }).diagnostics.map((d) => d.message),
  ).toEqual(["duplicate instrument custom.review"]);
});

// Mutation: scan literal values as if they were executable subject references.
test("subject-shaped literals do not require subject metadata", () => {
  const result = compile(
    instrument(`fields { note: text }
 action record { from: open, to: open requires unique "subject_namespace" on [self.id] set: { note: { literal: "subject.absent" } } }`),
  );
  expect(result.diagnostics).toEqual([]);
  expect(
    result.artifacts?.document.instruments[0]?.actions.record?.set,
  ).toEqual({ note: { literal: "subject.absent" } });
});

// Mutation: treat quoted duration constants as text despite their declared type.
test("object fields interpret duration literals only under a duration type", () => {
  const result = compile(
    'program p "P" object item { fields { label: text = "P1D", delay: duration = "P1D" } }',
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.artifacts?.document.objects[0]?.fields).toEqual([
    { name: "label", type: "text", value: "P1D" },
    { name: "delay", type: "duration", value: 86400000 },
  ]);
});
