import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { defaultToolchain } from "../src/toolchain.ts";
import { testToolchain } from "./fixtures/toolchain.ts";

const source = `program demo "Demo"
object car "Car" { fields { price: money } attach agreement = escrow.hold { payer: actor, payee: operator, expose create as start } }`;

test("a std declaration carries its declaration digest, which a header comment does not move", () => {
  // Mutation: digest the header bytes instead of the declaration AST.
  const bundled = compile(source);
  const origin = bundled.artifacts?.originMap[0]?.standardBlock;
  expect(origin).toEqual({
    key: "escrow.hold",
    recordPath: "",
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(bundled.artifacts?.document.instruments[0]?.family).toMatchObject({
    digest: origin?.digest,
  });
  const commented = compile(
    source,
    testToolchain([
      [
        "escrow",
        defaultToolchain.std
          .get("escrow")!
          .replace("header escrow", "header escrow\n// custom"),
      ],
    ]),
  );
  expect(commented.verdict).toBe("valid");
  expect(commented.artifacts?.originMap[0]?.standardBlock).toEqual(origin);
});
