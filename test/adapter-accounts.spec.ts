import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";

// Mutation: lower adapter(...) to a party name instead of an adapter owner.
test("account adapter binding resolves a text tunable without declaring a party", () => {
  const header = `header custody

instrument balance(provider: text) {
 summary: "An adapter-owned premium account."
 fields { premium: account(adapter(provider), cash, "premium") }
 lifecycle { states: [open], initial: open }
 action create { subject { adapter: provider } }
}`;
  const result = compile(
    `program accounts "Accounts"
use custody
object policy "Policy" { attach funds = custody.balance { provider: "insurer" } }`,
    {
      standardLibrary: {
        source: (name) => (name === "custody" ? header : undefined),
      },
    },
  );
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(doc.instruments[0]!.fields[0]).toMatchObject({
    owner: { adapter: "insurer" },
    book: "cash",
    key: "premium",
  });
  expect(doc.parties).not.toHaveProperty("insurer");
});

// Mutation broker-payment: send the commission to programOperator instead of broker.
// Mutation broker-refund: return the gross premium from insurer instead of both portions.
test("insurance pays and refunds insurer and broker as separate funded portions", () => {
  const result = compile(
    readFileSync(new URL("../examples/insurance.hsx", import.meta.url), "utf8")
      .replace("party inspector:", "party broker: business\nparty inspector:")
      .replace("commission: 10%", "commission: 10%, broker: broker"),
    {
      standardLibrary: {
        source: (name) =>
          readFileSync(new URL(`../std/${name}.hsx`, import.meta.url), "utf8"),
      },
    },
  );
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  const cover = doc.instruments.find((item) => item.id === "device_protection");
  const slice = doc.instruments.find(
    (item) => item.id === "device_protection_slice",
  );
  const claim = doc.instruments.find((item) => item.id === "device_claim");
  if (!cover || !slice || !claim)
    throw new Error("Missing insurance agreements");
  expect(cover.fields.find((field) => field.name === "insurer")).toMatchObject({
    owner: { adapter: "device_insurer" },
    book: "cash",
    key: "premium",
  });
  expect(slice.calculate).toContainEqual({
    target: "insurerPremium",
    op: "subtract",
    base: { field: "self.premium" },
    subtract: [{ field: "self.commission" }],
  });
  expect(slice.actions.collect!.moves).toMatchObject([
    {
      from: "party.owner",
      to: "self.cover.insurer",
      amount: { field: "self.insurerPremium" },
    },
    {
      from: "party.owner",
      to: "party.broker",
      amount: { field: "self.commission" },
    },
  ]);
  expect(slice.actions.refund!.moves).toMatchObject([
    {
      from: "self.cover.insurer",
      to: "party.owner",
      amount: { field: "self.insurerPremium" },
    },
    {
      from: "party.broker",
      to: "party.owner",
      amount: { field: "self.commission" },
    },
  ]);
  expect(claim.actions.approve!.moves[0]).toMatchObject({
    operation: "internal_transfer.reserve",
    from: "self.cover.insurer",
    to: "self.cover.holder",
  });
});
