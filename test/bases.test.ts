import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { readHsxDir } from "../scripts/bundle-programs.ts";

const authored = readHsxDir("bases");
const examples = readHsxDir("examples");
const cities = /\b(?:Boston|Portland|Seattle|York|Lyon|Bristol|Denver)\b/i;

test.each(authored)("$id compiles without diagnostics", (base) => {
  const result = compile(base.source);
  expect(result.diagnostics).toEqual([]);
  expect(result.verdict).toBe("valid");
});

test.each(authored)("$id stays neutral", (base) => {
  const source = base.source.toLowerCase();
  for (const example of examples)
    expect(source).not.toContain(example.title.toLowerCase());
  expect(base.source).not.toMatch(cities);
  expect(base.source).not.toMatch(/\bfee\s*:\s*\{/i);
  // Financing requires a fixed rate; zero leaves profit for Architect to tailor.
  for (const [percentage] of base.source.matchAll(/\d+(?:\.\d+)?\s*%/g))
    expect(Number.parseFloat(percentage)).toBe(0);
  expect(base.source).not.toMatch(/\b\d[\d_,]*(?:\.\d+)?\s*[A-Z]{3}\b/i);
});
