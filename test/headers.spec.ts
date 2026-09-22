import { expect, test } from "bun:test";
import { headerManifest } from "../src/headers.ts";

test("manifest lists the subject fields an attached object must carry", () => {
  const objects = headerManifest().headers.flatMap((header) => header.objects);
  const byName = new Map(
    objects.map((object) => [object.qualifiedName, object]),
  );
  expect(byName.get("escrow.hold")?.subject).toEqual([
    { name: "price", type: "money" },
  ]);
  expect(byName.get("financing.installments")?.subject).toEqual([
    { name: "price", type: "money" },
  ]);
  // Adapter subjects are provider bindings, not object fields.
  expect(byName.get("insurance.cover")?.subject).toEqual([]);
  expect(
    objects.every((object) =>
      object.subject.every((field) => field.type !== "adapter"),
    ),
  ).toBe(true);
});
