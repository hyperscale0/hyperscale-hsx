import { expect, test } from "bun:test";
import { compile } from "../src/compile.ts";
import { headerManifest } from "../src/headers.ts";

const header = `header custom
instrument approval(destination: enum(direct, held) = held, reserve: ref<custom.hold>?, fee: money = 10 SAR) {
 dependencies {
  reserve { selector: destination, is: held, message: "Attachment {attachment} needs reserve.", fix: "Bind reserve or select direct." }
 }
 parameterDiagnostics {
  fee { accepts: "a fixed review fee", percentage: "a percentage of a quote", fix: "Author the quote calculation." }
 }
 lifecycle { states: [open], initial: open }
 action create {}
}`;
const standardLibrary = { source: () => header };

// Mutation: special-case financing or omit contract metadata from the manifest.
test("host headers own conditional requirements and parameter policy explanations", () => {
  const source = `program reviews "Reviews"
use custom
object quote "Quote" { attach assessment = custom.approval {} }`;
  expect(compile(source, { standardLibrary }).diagnostics[0]).toMatchObject({
    message: "Attachment assessment needs reserve.",
    fix: "Bind reserve or select direct.",
  });
  expect(
    compile(
      source.replace(
        "approval {}",
        "approval { destination: direct, fee: 2% }",
      ),
      { standardLibrary },
    ).diagnostics[0],
  ).toMatchObject({
    message:
      "`custom.approval.fee` accepts a fixed review fee. It cannot express a percentage of a quote.",
    fix: "Author the quote calculation.",
  });
  expect(
    compile(source.replace("approval {}", "approval { destination: direct }"), {
      standardLibrary,
    }).diagnostics,
  ).toEqual([]);
  expect(
    headerManifest(standardLibrary, ["custom"]).headers[0]?.objects[0]
      ?.parameterDiagnostics,
  ).toEqual([
    {
      parameter: "fee",
      accepts: "a fixed review fee",
      percentage: "a percentage of a quote",
      fix: "Author the quote calculation.",
    },
  ]);
});

// Mutation: accept undeclared enum choices in dependency contracts.
test("malformed header dependency refuses instead of silently dropping a requirement", () => {
  const result = compile('program p "P"\nuse custom\na = custom.approval {}', {
    standardLibrary: { source: () => header.replace("is: held", "is: absent") },
  });
  expect(result.diagnostics[0]).toMatchObject({
    message: "Dependency must select a declared enum choice.",
    fix: "Repair the header binding contract.",
  });
});

// Mutation: throw on the first failed parameter instead of retaining independent failures.
test("independent party bindings are returned together with their parameter locations", () => {
  const result = compile(
    `program p "P"
use custom
object quote "Quote" { attach review = custom.review { payer: absent, payee: missing } }`,
    {
      standardLibrary: {
        source: () => `header custom
instrument review(payer: party, payee: party) {
 lifecycle { states: [open], initial: open }
 action create {}
}`,
      },
    },
  );
  expect(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.related?.[0]?.message,
    ]),
  ).toEqual([
    ["subject_party_unbound", "Parameter payer"],
    ["subject_party_unbound", "Parameter payee"],
  ]);
});
