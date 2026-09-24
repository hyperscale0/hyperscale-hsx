import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { bundledStandardLibrary } from "../src/std-library.ts";

const source = `program demo "Demo"
use escrow
object car "Car" { fields { price: money } attach agreement = escrow.hold { payer: actor, payee: operator, expose create as start } }`;

test("a bundled declaration carries its header digest; a changed library does not", () => {
  // Mutation: accept a familiar header name without proving its bytes.
  const bundled = compile(source);
  expect(bundled.artifacts?.originMap[0]?.standardBlock).toMatchObject({
    key: "escrow.hold",
    recordPath: "",
    headerDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const custom = compile(source, {
    standardLibrary: {
      source: (name) =>
        bundledStandardLibrary
          .source(name)
          ?.replace("header escrow", "header escrow\n// custom"),
    },
  });
  expect(custom.verdict).toBe("valid");
  expect(custom.artifacts?.originMap[0]?.standardBlock).toBeUndefined();
});
