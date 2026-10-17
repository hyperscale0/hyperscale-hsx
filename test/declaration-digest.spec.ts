import { expect, test } from "bun:test";
import { catalogProgramSource } from "../src/catalog-program.ts";
import { compile } from "../src/compile.ts";
import { defaultToolchain } from "../src/toolchain.ts";
import { testToolchain } from "./fixtures/toolchain.ts";

const money = defaultToolchain.std.get("money")!;
const declaration =
  "instrument transfer(payer: party, payee: party, amount: money = runtime) {";
const fields = "fields { amount: money = amount }";
const source = `program shop "Shop"
party buyer: person
party seller: business
sale = money.transfer { payer: buyer, payee: seller, amount: 750 SAR }`;

function transferFamily(header = money) {
  const result = compile(source, testToolchain([["money", header]]));
  expect(result.diagnostics).toEqual([]);
  return result.artifacts!.document.instruments[0]!.family;
}

// Mutation: digest the declaration's source bytes instead of its AST.
test("a comment inside a std declaration keeps its family digest", () => {
  expect(money).toContain(declaration);
  expect(
    transferFamily(
      money.replace(declaration, `${declaration}\n  // Reviewed terms.`),
    ),
  ).toEqual(transferFamily());
});

// Mutation: digest only the declaration's name and parameters.
test("a new field in a std declaration moves its family digest", () => {
  expect(money).toContain(fields);
  const before = transferFamily();
  const after = transferFamily(
    money.replace(fields, "fields { amount: money = amount, note: text }"),
  );
  expect(after).toMatchObject({ module: "money", exportPath: "transfer" });
  expect(after).not.toEqual(before);
});

// Mutation: leave a std instrument without a family, or emit a format 1 revision.
test("every instrument of every bundled std header names its family by digest", () => {
  // The catalogue program attaches every published template.
  const result = compile(catalogProgramSource);
  expect(result.diagnostics).toEqual([]);
  const instruments = result.artifacts!.document.instruments;
  for (const { id, family } of instruments) {
    expect(family, id).toEqual({
      module: expect.any(String),
      exportPath: expect.any(String),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  }
  expect(new Set(instruments.map(({ family }) => family?.module))).toEqual(
    new Set(defaultToolchain.std.keys()),
  );
});

// Mutation: leave std sources out of the toolchain digest.
test("a changed std header changes the toolchain digest", () => {
  const changed = testToolchain([
    [
      "money",
      money.replace(declaration, `${declaration}\n  // Reviewed terms.`),
    ],
  ]);
  expect(changed.digest).not.toBe(defaultToolchain.digest);
  expect(testToolchain().digest).toBe(defaultToolchain.digest);
});
