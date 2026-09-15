import { expect, test } from "bun:test";
import { assertValidUdl } from "@hyperscale0/udl";
import { compile } from "./compile.ts";

const source = `program custody "Custody"
import { held_payment } from "std/money_flows"
party buyer: person
party seller: business
port approved { allowed: [buyer] }
instrument sale = held_payment<SAR>(payer: buyer, payee: seller, amount: price: money(SAR), release: port approved, private_actions: true)
expose sale.create as openSale
`;

test("private custody exposes only the actions the program selects", () => {
  const aliases = (text: string) => {
    const catalog = compile(`program catalog "Catalog"
instrument anchor { agent_description: "Catalog anchor"; fields {} lifecycle { states open; initial open; } action create { public: none; agent_description: "Create anchor"; steps: []; } }`);
    expect(catalog.diagnostics).toEqual([]);
    const result = compile(
      text.replace(
        'program custody "Custody"',
        'program custody "Custody"\nuse anchor',
      ),
      { publishedCatalog: assertValidUdl(catalog.artifacts!.document) },
    );
    expect(result.diagnostics).toEqual([]);
    return assertValidUdl(result.artifacts!.document).instruments.flatMap(
      (instrument) =>
        Object.values(instrument.actions).flatMap((action) =>
          action.publicAction ? [action.publicAction] : [],
        ),
    );
  };
  expect(aliases(source)).toEqual(["openSale"]);
  expect(
    aliases(source.replace("private_actions: true", "private_actions: false")),
  ).not.toEqual(["openSale"]);
});
