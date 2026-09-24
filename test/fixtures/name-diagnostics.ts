import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../../src/compile.ts";

export const rental = readFileSync(
  new URL("../../examples/rental-deposit.hsx", import.meta.url),
  "utf8",
);

export function refusal(from: string, to: string, source = rental) {
  expect(source).toContain(from);
  const mutated = source.replace(from, to);
  const result = compile(mutated);
  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics).toHaveLength(1);
  const diagnostic = result.diagnostics[0]!;
  return {
    ...diagnostic,
    at: mutated.slice(diagnostic.span.start, diagnostic.span.end),
  };
}
