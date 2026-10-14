import { expect, test } from "bun:test";
import { documentDigest } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";
import { describe } from "../src/language.ts";

// The Dunes program from the Nix study, modules R1.
const dunes = `program dunes "Dunes Travel"

object tour "Desert tour" {
  fields { departure: date, price: money }
  attach booking = booking.reservation {
    customer: actor
    late_forfeit: 50%
    expose create as book_tour
  }
}
`;
const terms = (source: string, path = "$.instruments[0]") => {
  const result = compile(source);
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  return result.artifacts.originMap.find((entry) => entry.path === path)?.terms;
};
const lineOf = (source: string, needle: string) =>
  source.slice(0, source.indexOf(needle)).split("\n").length;

test("each term of an attach line says who set it and where", () => {
  const booking = compile(dunes);
  const header = booking.artifacts!.originMap[0]!;
  expect(header.terms).toContainEqual({
    name: "late_forfeit",
    from: "program",
    text: "50%",
    source: "program",
    line: lineOf(dunes, "late_forfeit: 50%"),
    column: 19,
  });
  expect(header.terms).toContainEqual(
    expect.objectContaining({
      name: "middle_forfeit",
      from: "std",
      text: "0%",
      source: "booking",
      line: 25,
    }),
  );
  expect(header.terms!.map((term) => term.name)).toEqual([
    "customer",
    "operator",
    "early_until",
    "late_from",
    "balance_due",
    "middle_forfeit",
    "late_forfeit",
  ]);
  // Provenance is source map only: the document is the one main compiles.
  expect(documentDigest(booking.artifacts!.document)).toBe(
    "4097bb1845ac824d287fdfe328ea20d5d4ed5ddab2c49fb8b4b950710fc38d15",
  );
});

test("a by-name party is the party's, and a record inherits its parent's terms", () => {
  // operator is a subject role, so the unbound operator parameter binds by name.
  expect(terms(dunes)).toContainEqual(
    expect.objectContaining({
      name: "operator",
      from: "party",
      text: "operator",
    }),
  );
  const gym = `program gym "Gym"
object membership "Membership" {
 attach dues = money.schedule { payer: owner, payee: operator, amount: 150 SAR, every: 1 month
  expose create as start, expose activate as accept, expose stop as end }
}`;
  const result = compile(gym);
  const occurrence = result.artifacts!.document.instruments.findIndex(
    (item) => item.id === "membership_dues_occurrence",
  );
  const record = terms(gym, `$.instruments[${occurrence}]`)!;
  expect(record).toContainEqual(
    expect.objectContaining({
      name: "every",
      from: "program",
      text: "1 month",
    }),
  );
  expect(record).toContainEqual(
    expect.objectContaining({ name: "count", from: "std", text: "unset" }),
  );
  expect(record).toEqual(terms(gym)!);
});

test("hover shows the term in force on a tunable and on the attach line", () => {
  expect(
    describe(dunes, dunes.indexOf("late_forfeit"))?.details,
  ).toContainEqual({ label: "In force", value: "50% (set by the program)" });
  expect(describe(dunes, dunes.indexOf("reservation"))?.details).toContainEqual(
    {
      label: "middle_forfeit in force",
      value: "0% (booking default)",
    },
  );
  // Inside the attach block, an instrument name is not the attach line.
  expect(
    describe(dunes, dunes.indexOf("customer"))?.details?.some(
      (detail) =>
        detail.label.endsWith("in force") && detail.label !== "In force",
    ),
  ).toBeFalsy();
});
