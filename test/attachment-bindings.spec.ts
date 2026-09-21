import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compile } from "../src/compile.ts";

const declarations = `party agency: business
party alternate: business
party underwriter: staff role underwrite
party customer: person
party roleless: staff`;
function binding(
  parameters: string,
  supplied = "",
  parties = declarations,
  body = "",
) {
  const source = `program bindings "Bindings"
use fixture
${parties}
object car "Car" { attach sale = fixture.sale { ${supplied} expose run as run } }`;
  const header = `header fixture
instrument sale(${parameters}) {
 fields {}
 lifecycle { states: [open, closed], initial: open }
 action create {}
 action run { from: open, to: closed ${body} }
}`;
  return compile(source, {
    standardLibrary: {
      source: (name) =>
        name === "fixture"
          ? header
          : readFileSync(
              new URL(`../std/${name}.hsx`, import.meta.url),
              "utf8",
            ),
    },
  });
}
function bindings(result: ReturnType<typeof compile>) {
  expect(result.diagnostics).toEqual([]);
  return result.artifacts!.document.objects[0]!.attachments[0]!.parties;
}

test("Explicit binding wins over by-name and default", () => {
  const result = binding(
    "actor: party = operator",
    "actor: agency",
    declarations,
    "actor: { party: actor }",
  );
  expect(bindings(result)).toEqual({ actor: { party: "agency" } });
  expect(result.artifacts!.document.instruments[0]!.actions.run!.actor).toEqual(
    { party: "agency" },
  );
});

test("By-name binding wins over default", () => {
  expect(bindings(binding("agency: party = operator"))).toEqual({
    agency: { party: "agency" },
  });
  expect(bindings(binding("actor: party = agency"))).toEqual({
    actor: { role: "actor" },
  });
});

test("Default resolves when no explicit or by-name candidate exists", () => {
  expect(
    bindings(
      binding("payer: party = party(business)", "", "party agency: business"),
    ),
  ).toEqual({ payer: { party: "agency" } });
  expect(
    bindings(binding("payer: party = recipient, recipient: party = agency")),
  ).toEqual({ payer: { party: "agency" }, recipient: { party: "agency" } });
});

test("Resolved bindings are reused by executable references", () => {
  const result = binding(
    "payer: party = party(business), agency: party",
    "agency: actor",
    "party agency: business",
    "actor: { party: payer } requires party.agency.balance >= 0 SAR; requires party.agency.reserved >= 0 SAR",
  );
  expect(bindings(result)).toEqual({
    payer: { party: "agency" },
    agency: { role: "actor" },
  });
  expect(result.artifacts!.document.instruments[0]!.actions.run!.actor).toEqual(
    { party: "agency" },
  );
  expect(
    result.artifacts!.document.instruments[0]!.actions.run!.requires.map(
      (rule) => rule.kind === "compare" && rule.left,
    ),
  ).toEqual([
    { field: "party.actor.balance" },
    { field: "party.actor.reserved" },
  ]);
});

test("Invalid selected binding does not fall through", () => {
  for (const result of [
    binding("payer: party = agency", "payer: missing"),
    binding("customer: party = agency"),
  ])
    expect(result.verdict).toBe("invalid");
});

test("Required party defaults must resolve uniquely", () => {
  for (const parameters of [
    "payer: party",
    "payer: party = missing",
    "payer: party = recipient, recipient: party = payer",
    "payer: party = party(business)",
  ])
    expect(binding(parameters).diagnostics[0]?.code).toBe(
      "subject_party_unbound",
    );
});

test("Optional unbound party parameters remain absent", () => {
  expect(bindings(binding("payer: party?"))).toEqual({});
});

test("Duplicate explicit bindings refuse", () => {
  expect(
    binding("payer: party", "payer: actor, payer: agency").diagnostics[0]?.code,
  ).toBe("HSX1001");
});

test("Role names cannot be declared as parties", () => {
  for (const role of ["owner", "actor", "operator"]) {
    const declaration = `party ${role}: business`;
    const source = `program p "P"\n${declaration}\nobject car "Car" {}`;
    const diagnostic = compile(source).diagnostics[0]!;
    expect(diagnostic.code).toBe("party_name_reserved");
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
      declaration,
    );
  }
});

test("Declared businesses retain their binding kinds", () => {
  const result = binding(
    "payer: party = agency",
    "",
    declarations,
    "actor: { party: payer }",
  );
  expect(bindings(result)).toEqual({
    payer: { party: "agency" },
  });
});

test("Attachment parameter kind controls admission", () => {
  for (const [type, party] of [
    ["party", "roleless"],
    ["party", "customer"],
  ])
    expect(
      binding(`binding: ${type}`, `binding: ${party}`).diagnostics[0]?.code,
    ).toBe("party_kind_mismatch");
});

test("Named canonical diagnostics retain source spans and fixes", () => {
  const header = `header fixture
instrument sale(payer: party = missing) {
 fields {}
 lifecycle { states: [open], initial: open }
 action create {}
}`;
  const imported = compile(
    'program p "P"\nuse fixture\nobject car "Car" { attach sale = fixture.sale {} }',
    { standardLibrary: { source: () => header } },
  ).diagnostics[0]!;
  expect(imported.source).toBe("fixture");
  expect(header.slice(imported.span.start, imported.span.end)).toBe("missing");
  expect([imported.line, imported.column]).toEqual([2, 32]);
});
