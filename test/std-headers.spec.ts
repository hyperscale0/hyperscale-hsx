import { libraryAuditSource } from "./fixtures/library-audit.ts";
import { expect, test } from "bun:test";
import { genericAdapter } from "../../adl/src/boundary-fixture.ts";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { standardLibrary } from "./fixtures/std-source.ts";

// Mutation unreachable-header-state: add an unentered state to any std lifecycle.
// The manifest comparison also fails if a new export lacks a compilation witness.
test("every standard header export is instantiated under the strict compiler", () => {
  const result = compile(libraryAuditSource, {
    standardLibrary,
    adapterRegistry: {
      fixture: { adapter: genericAdapter, operation: "boundary.observe" },
    },
  });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.diagnostics).toEqual([]);
  const attached = new Map(
    [...libraryAuditSource.matchAll(/attach (\w+) = ([\w.]+) \{/g)].map((m) => [
      m[2]!,
      m[1]!,
    ]),
  );
  const compiled = new Set(
    result.artifacts.document.objects.flatMap((kind) =>
      kind.attachments.map((a) => a.name),
    ),
  );
  for (const header of headerManifest(standardLibrary).headers)
    for (const item of header.objects) {
      const name = attached.get(item.qualifiedName);
      expect(name, item.qualifiedName).toBeDefined();
      expect(compiled.has(name!), item.qualifiedName).toBe(true);
    }
});

// Mutation own-parameter-shadowing: resolve sibling attachments before own
// bindings in compile.ts and escrow's `dispute.refund_after` names cards.dispute.
test("an own bound parameter shadows a sibling attachment of the same name", () => {
  const program = `program p "P"
use escrow
use cards
party supplier: business
object item "Item" {
 attach sale = escrow.hold { payer: actor, payee: owner }
 attach cardholder = cards.cardholder { holder: actor }
 attach card = cards.card { holder: cardholder, person: actor, spend_limit: 5000 SAR }
 attach authorization = cards.authorization { card: card, merchant: supplier }
 attach transaction = cards.transaction { authorization: authorization }
 attach dispute = cards.dispute { transaction: transaction }
}`;
  const result = compile(program, { standardLibrary });
  expect(result.diagnostics).toEqual([]);
  const hold = result.artifacts!.document.instruments.find(
    (item) => item.id === "item_sale",
  )!;
  expect(hold.lifecycle.transitions.refund!.from).toEqual([
    "funded",
    "return_verified",
  ]);
});
