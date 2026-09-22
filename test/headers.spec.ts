import { expect, test } from "bun:test";
import { headerManifest } from "../src/headers.ts";

// Mutation: filter adapter requirements by their value instead of their key.
test("manifest separates adapter bindings from authored subject fields", () => {
  const source = `header custom
instrument review {
 action check { subject { adapter: verification, reference: text } }
}`;
  const manifest = headerManifest({ source: () => source }, ["custom"]);
  expect(manifest.headers[0]?.objects[0]?.subject).toEqual([
    { name: "reference", type: "text" },
  ]);
});

// Mutation: bypass shared header declaration validation in headerManifest.
test("metadata refuses duplicate parameters before presenting a signature", () => {
  const source =
    "header custom instrument review(count: integer, count: integer) {}";
  expect(() => headerManifest({ source: () => source }, ["custom"])).toThrow(
    "duplicate parameter count",
  );
});
