import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { assertValidUdl, parseUdl, serializeUdl } from "@hyperscale0/udl";
import { compile, testCostTable as costTable } from "./compile.ts";
const source = readFileSync(
  new URL("./fixtures/attested.hsx", import.meta.url),
  "utf8",
);

test("ordinary HSX binds an action to an engine-consumed decision", () => {
  const result = compile(source, { costTable });
  expect(result.diagnostics).toEqual([]);
  const document = assertValidUdl(result.artifacts!.document);
  expect(parseUdl(serializeUdl(document))).toEqual(document);
  for (const [from, to] of [
    ['digest: "fields.digest"', 'digest: "fields.role"'],
    ["consume: consume;", "consume: absent;"],
    ['instrument: "fields.requestInstrument";', 'instrument: "fields.absent";'],
    ['instrument: "fields.requestInstrument";', ""],
    ["party: decider;", "party: absent;"],
    ["party: decider;", ""],
    ["capture: decidedBy;", "capture: requestId;"],

    ["engine_owned: true;", ""],
    [
      "public: none; engine_owned: true;",
      "public: spendApproval; engine_owned: true;",
    ],
    ['amount: "fields.amount"', 'amount: "fields.approvalId"'],
    ['expires_at: "fields.expiry"', 'expires_at: "fields.absent"'],
  ]) {
    expect(compile(source.replace(from!, to!), { costTable }).verdict).toBe(
      "invalid",
    );
  }
});
