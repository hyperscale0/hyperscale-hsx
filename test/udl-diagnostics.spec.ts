import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const program = (body: string) => `program p "P"
instrument record {
 lifecycle { states: [open], initial: open }
 action create {}
 ${body}
}`;

// Mutation: bypass validateUdl in compile and emit the unchecked document.
test("UDL2001 preserves the duplicate-field refusal through HSX", () => {
  const result = compile(program("fields { note: text, note: text }"));
  expect(result.diagnostics.map((d) => d.code)).toEqual(["UDL2001"]);
  expect(result.artifacts).toBeUndefined();
});

// Mutation: discard semantic UDL issues when shape validation has passed.
test("UDL2002 preserves the undeclared-parent refusal through HSX", () => {
  const source = program("").replace(
    "action create {}",
    "action create { actor: { parent: absent } }",
  );
  expect(compile(source).diagnostics.map((d) => [d.code, d.message])).toEqual([
    [
      "UDL2002",
      "$.instruments[0].actions.create: actor names an undeclared parent",
    ],
  ]);
});

// Mutation: return artifacts before UDL invocation-cycle analysis.
test("UDL2010 refuses a recursive action instead of entering cost recursion", () => {
  const result = compile(
    program(`action again {
    from: open, to: open
    invoke: [{ reference: self, action: again, input: {} }]
  }`),
  );
  expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(
    new Set(["UDL2010"]),
  );
  expect(
    result.diagnostics.some((d) => d.message.includes("invocation cycle")),
  ).toBe(true);
  expect(result.artifacts).toBeUndefined();
});

// Mutation: discard UDL field-type issues after field lowering.
test("UDL5001 preserves the field-type refusal through HSX", () => {
  const result = compile(
    program(
      "fields { note: text }\n action late { from: open, to: open, deadline: { at: self.note } }",
    ),
  );
  expect(result.diagnostics.map((d) => d.code)).toEqual(["UDL5001"]);
});

// Mutation: omit UDL structural limits after expanding a compact imported header.
test("UDL1004 bounds expanded documents independently of source size", () => {
  const fields = Array.from(
    { length: 200 },
    (_, index) => `field${index}: text`,
  ).join(", ");
  const header = `header custom instrument record {
    fields { ${fields} }
    lifecycle { states: [open], initial: open }
    action create {}
  }`;
  const instances = Array.from(
    { length: 256 },
    (_, index) => `record${index} = custom.record {}`,
  ).join("\n");
  const result = compile(`program p "P"\nuse custom\n${instances}`, {
    standardLibrary: { source: () => header },
  });
  expect(result.diagnostics.map((d) => d.code)).toEqual(["UDL1004"]);
  expect(result.artifacts).toBeUndefined();
});
