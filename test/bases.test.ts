import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";
import { parseProgram } from "../src/parse.ts";
import { bases } from "../src/bases.ts";
import { generateBasesBundleCode, readBases } from "../scripts/bundle-bases.ts";
import { readExamples } from "../scripts/bundle-examples.ts";

const archetypes = {
  escrow: "Hold payment until delivery",
  money: "Collect a payment",
  wallet: "Offer prepaid credit",
  cards: "Control card spending",
  financing: "Split a purchase into instalments",
  savings: "Save as a group",
  marketplace: "Connect buyers and sellers",
  insurance: "Protect a purchase",
  lending: "Pool funds for lending",
  collections: "Follow up overdue payments",
  reporting: "Track repayments",
};
const authored = readBases();
const examples = readExamples();
const cities = /\b(?:Riyadh|Jeddah|Khobar|Madinah|Tabuk|Qassim|Dammam)\b/i;

test("each archetype has one base with a neutral identity and one object", () => {
  expect(authored.map((base) => base.id)).toEqual(
    Object.keys(archetypes).sort(),
  );
  for (const base of authored) {
    const { program } = parseProgram(base.source);
    expect(program.name).toBe(`${base.id}_base`);
    expect(base.title).toBe(archetypes[base.id as keyof typeof archetypes]);
    expect(base.headers).toContain(base.id);
    expect(program.decls.filter((decl) => decl.kind === "object")).toHaveLength(
      1,
    );
  }
});

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
  expect(bases).toEqual(authored);
  expect(
    readFileSync(new URL("../src/bases-bundle.ts", import.meta.url), "utf8"),
  ).toBe(generateBasesBundleCode());
});
