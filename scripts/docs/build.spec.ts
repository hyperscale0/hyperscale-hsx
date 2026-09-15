import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocs } from "./build.ts";

const output = mkdtempSync(join(tmpdir(), "hsx-docs-coverage-"));
buildDocs(output);
afterAll(() => rmSync(output, { recursive: true, force: true }));
const page = (name: string) =>
  readFileSync(join(output, "docs/reference/std", `${name}.md`), "utf8");

test("std parameter tables retain optional types and publication controls", () => {
  expect(page("held_payment")).toMatch(
    /\| `private_actions`\s*\| `optional<boolean>`\s*\| No\s*\| Suppress automatic aliases/,
  );
});

test("parameter guidance excludes the preceding fenced example", () => {
  expect(page("cancellable_booking")).toMatch(
    /\| `cancel_bands`\s*\| `optional<list<block>>`\s*\| No\s*\| Supply cancel_bands/,
  );
});

test("std action tables include finite indexed actions and their clauses", () => {
  expect(page("scheduled")).toMatch(
    /\| `pay_installment_\[i\]`\s*\|[^\n]*`moves`/,
  );
});
