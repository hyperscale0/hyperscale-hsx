import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";
import { describe as hover } from "../src/language.ts";
import { templateGuide } from "../src/template-guide.ts";

const stays = `program stays "Stays"
object stay "Stays" {
  fields { guest: text }
  attach booking = booking.reservation { customer: owner, expose create, expose pay_deposit }
  attach purse = wallet.balance { holder: owner }
}`;

// Mutation: load headers only from a declaration list, so a bare qualified name is unknown.
test("a qualified name loads its header, and the document matches the one main compiled with use lines", () => {
  const result = compile(stays);
  expect(result.diagnostics).toEqual([]);
  const json = JSON.stringify(result.artifacts!.document);
  // Main at 43173f0a0 compiled this program with `use booking` and `use wallet`
  // after the program line to these bytes.
  expect(json.length).toBe(10431);
  expect(createHash("sha256").update(json).digest("hex")).toBe(
    "89d7063113dc61154f9abbdbdec7f89d11ebe4f1dea5dd339bae7b6439a97d20",
  );
});

// Mutation: drop the header-name check, so a misspelt header reads as an unknown instrument.
test("a misspelt header fails at its qualified name and suggests the published header", () => {
  const result = compile(
    stays.replace("booking.reservation", "bookng.reservation"),
  );
  expect(
    result.diagnostics.map((d) => [d.message, d.fix, d.line, d.column]),
  ).toEqual([
    [
      "unknown header bookng. Did you mean `booking`?",
      "name a published header",
      4,
      3,
    ],
  ]);
});

// Mutation: keep a parser branch or skip for use lines.
test("a use line is an ordinary unknown declaration at its line", () => {
  const result = compile(stays.replace("\n", "\nuse booking\n"));
  expect(result.diagnostics.map((d) => [d.stage, d.line])).toEqual([
    ["parse", 2],
  ]);
});

// Mutation: restore the template's import field or the guide's use field, or resolve hover from use lines.
test("the manifest and guide carry no import, and hover resolves a header with no use line", () => {
  for (const object of headerManifest().headers.flatMap((h) => h.objects))
    expect(Object.keys(object.authoringTemplate).sort()).toEqual([
      "instancePlaceholder",
      "requiredBindings",
      "source",
    ]);
  expect(Object.keys(templateGuide("booking.reservation")!)).not.toContain(
    "use",
  );
  const help = hover(stays, stays.indexOf("reservation"));
  expect(help?.title).toBe("booking.reservation");
  expect(help?.details?.map((d) => d.label)).toContain("customer");
  expect(hover(stays, stays.indexOf("booking.reservation"))?.kind).toBe(
    "header",
  );
});
