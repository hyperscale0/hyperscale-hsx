import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";

const workshop = readFileSync(
  new URL("../examples/wallet.hsx", import.meta.url),
  "utf8",
);
const declaration = "economics pay { purpose: earning, sourceParty: owner }";

// Mutation: drop economics or its source binding while specializing an attachment.
test("an attachment retains its own purpose and payer without changing the imported instrument", () => {
  const result = compile(
    workshop.replace("economics pay {", "economics pay.move1 {"),
  );
  expect(result.diagnostics).toEqual([]);
  const document = result.artifacts!.document;
  const visit = document.instruments.find(
    (item) => item.id === "membership_visit",
  )!;
  expect(visit.actions.pay!.moves[0]!.economics).toEqual({
    purpose: "earning",
    sourceParty: "owner",
  });
  expect(
    Object.values(document.objects[0]!.attachments[1]!.parties),
  ).toContainEqual({ role: "owner" });
  const generic = compile(workshop.replace(declaration, ""));
  expect(generic.diagnostics).toEqual([]);
  expect(
    generic.artifacts!.document.instruments.find(
      (item) => item.id === visit.id,
    )!.actions.pay!.moves[0]!.economics,
  ).toBeUndefined();
});

// Mutation: resolve the parameter name instead of its bound party, or assume every receipt is earnings.
test.each([
  ["earning", "actor", "operator"],
  ["participant_payout", "operator", "owner"],
  ["pass_through", "actor", "owner"],
] as const)(
  "%s resolves its attachment's source parameter",
  (purpose, payer, payee) => {
    const result = compile(`program service "Service"
use money
object purchase "Purchase" {
 attach payment = money.transfer {
  payer: ${payer}, payee: ${payee}
  economics pay { purpose: ${purpose}, sourceParty: payer }
 }
}`);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.artifacts!.document.instruments[0]!.actions.pay!.moves[0]!
        .economics,
    ).toEqual({ purpose, sourceParty: payer });
  },
);

// Mutations: remove the named refusal and the corresponding row compiles or loses its repair.
test.each([
  [
    "missing action",
    "economics missing { purpose: earning, sourceParty: owner }",
    "unknown economics action missing",
    "choose create, reserve, pay, cancel, expire",
  ],
  [
    "missing move",
    "economics pay.absent { purpose: earning, sourceParty: owner }",
    "must select one money move",
    "choose pay.move1",
  ],
  [
    "empty action",
    "economics create { purpose: earning, sourceParty: owner }",
    "must select one money move",
    "choose an action that transfers",
  ],
  [
    "void",
    "economics cancel { purpose: earning, sourceParty: owner }",
    "cannot classify a void",
    "reservation or its posting",
  ],
  [
    "unbound party",
    "economics pay { purpose: earning, sourceParty: nobody }",
    "unknown economic source party nobody",
    "owner, actor, operator",
  ],
  [
    "unknown purpose",
    "economics pay { purpose: sales, sourceParty: owner }",
    "invalid economics",
    "declare purpose and sourceParty",
  ],
  [
    "duplicate selection",
    `${declaration}\n${declaration.replace("pay {", "pay.move1 {")}`,
    "repeated economics",
    "once",
  ],
])("refuses %s with a repair", (_rule, replacement, message, fix) => {
  const source = workshop.replace(declaration, replacement);
  const result = compile(source);
  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics[0]!.message).toContain(message);
  expect(result.diagnostics[0]!.fix).toContain(fix);
  expect(
    source.split("\n")[result.diagnostics[0]!.line - 1]!.trim(),
  ).toStartWith("economics ");
});

test("an attachment cannot replace the standard instrument's economics", () => {
  const result = compile(
    workshop.replace(
      "holder: owner",
      "holder: owner\n economics topup { purpose: earning, sourceParty: holder }",
    ),
  );
  expect(result.diagnostics[0]!.message).toContain(
    "conflicts with the instrument's declared purpose",
  );
  expect(result.diagnostics[0]!.fix).toContain("choose an unclassified move");
});

test("a split requires an explicit move instead of classifying every recipient", () => {
  const source = `program split_payment "Split"
use money
party studio: business
party seller: business
object purchase "Purchase" {
 attach payment = money.split {
  payer: actor, shares: { studio: 50%, seller: 50% }
  economics pay { purpose: earning, sourceParty: actor }
 }
}`;
  const refused = compile(source);
  expect(refused.diagnostics[0]!.message).toContain(
    "must select one money move",
  );
  expect(refused.diagnostics[0]!.fix).toContain("pay.move1_1, pay.move1_2");
  const selected = compile(
    source.replace("economics pay {", "economics pay.move1_1 {"),
  );
  expect(selected.diagnostics).toEqual([]);
  const moves = selected.artifacts!.document.instruments[0]!.actions.pay!.moves;
  expect(moves.map((move) => move.economics?.purpose)).toEqual([
    "earning",
    undefined,
  ]);
});
