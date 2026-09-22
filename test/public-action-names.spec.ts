import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

const source = `program p "P"
instrument record {
 lifecycle { states: [open], initial: open }
 action create {}
 action check { from: open, to: open }
}
`;

// Mutation: emit duplicate aliases on a standalone instrument after exposure.
test("an alias cannot shadow another action's generated public name", () => {
  const exposure = "expose record.check as createRecord";
  const result = compile(source + exposure);
  expect(result.artifacts).toBeUndefined();
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic.message).toBe(
    "public action createRecord is used more than once on record",
  );
  expect(
    (source + exposure).slice(diagnostic.span.start, diagnostic.span.end),
  ).toBe(exposure);
  expect(
    compile(source + exposure + "\nhide record.create").diagnostics,
  ).toEqual([]);
});
