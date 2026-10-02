import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { parseProgram } from "../src/parse.ts";
import { bases } from "../src/bases.ts";
import { generateBasesBundleCode, readBases } from "../scripts/bundle-bases.ts";
import { readExamples } from "../scripts/bundle-examples.ts";

const authored = readBases();
const examples = readExamples();
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

test("the browser bases bundle matches the authored files and metadata", () => {
  expect(
    authored.map(({ id, title, source }) => [
      id,
      parseProgram(source).program.name,
      title,
    ]),
  ).toEqual([
    ["cards", "cards_base", "Control card spending"],
    ["collections", "collections_base", "Follow up overdue payments"],
    ["escrow", "escrow_base", "Hold payment until delivery"],
    ["financing", "financing_base", "Split a purchase into instalments"],
    ["insurance", "insurance_base", "Protect a purchase"],
    ["lending", "lending_base", "Pool funds for lending"],
    ["marketplace", "marketplace_base", "Connect buyers and sellers"],
    ["money", "money_base", "Collect a payment"],
    ["reporting", "reporting_base", "Track repayments"],
    ["savings", "savings_base", "Save as a group"],
    ["wallet", "wallet_base", "Offer prepaid credit"],
  ]);
  expect(bases).toEqual(authored);
  expect(
    readFileSync(new URL("../src/bases-bundle.ts", import.meta.url), "utf8"),
  ).toBe(generateBasesBundleCode());
});
