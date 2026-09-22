import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";

// Mutation: pass only row.span to failWithCode in checkSubjectPaths.
test("undeclared subject paths retain the imported action's source location", () => {
  const action = `action check {
 from: open, to: open
 requires subject.missing == true
}`;
  const header = `header custom
instrument review {
 lifecycle { states: [open], initial: open }
 action create {}
 ${action}
}`;
  const result = compile(
    'program p "P"\nuse custom\nobject item { attach review = custom.review {} }',
    { standardLibrary: { source: () => header } },
  );
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  expect(diagnostic).toMatchObject({
    source: "custom",
    code: "subject_field_unknown",
    line: 5,
    column: 2,
    fix: "declare missing in subject { ... }",
  });
  expect(header.slice(diagnostic.span.start, diagnostic.span.end)).toBe(action);
});
