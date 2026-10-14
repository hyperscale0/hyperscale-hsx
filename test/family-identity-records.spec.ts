import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { testToolchain } from "./fixtures/toolchain.ts";

test("duplicate child export path suffixes refuse at compile time naming both candidates", () => {
  // Mutation: return first match in resolveChildExportPath without ambiguity check.
  const headerWithDupRecords = `header dup_records
instrument parent {
  fields {}
  lifecycle { states: [active], initial: active }
  action create {}
  records {
    a_b: {
      fields {}
      lifecycle { states: [active], initial: active }
      action create {}
    }
    a: {
      fields {}
      lifecycle { states: [active], initial: active }
      action create {}
      records {
        b: {
          fields {}
          lifecycle { states: [active], initial: active }
          action create {}
        }
      }
    }
  }
}
`;
  const source = `program ambiguous_child "AmbiguousChild"
party client: person
instrument consumer {
  fields {
    targetRef: {
      target: system_root_a_b
      family: dup_records.parent.a_b
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
}
object system "System" {
  attach root = dup_records.parent { expose create as create_root }
}
`;
  const result = compile(source, testToolchain([headerWithDupRecords]));
  expect(result.diagnostics.length).toBeGreaterThan(0);
  const diag = result.diagnostics.find((d) => d.code === "HSX1001");
  expect(diag).toBeDefined();
  expect(diag!.message).toContain("ambiguous child export path suffix 'a_b'");
  expect(diag!.message).toContain("a_b");
  expect(diag!.message).toContain("a.b");
});
