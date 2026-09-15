import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { parseUdl, serializeUdl, type UdlDocument } from "@hyperscale0/udl";
import { compile, testCostTable as costTable } from "./compile.ts";
const source = readFileSync(
  new URL("./fixtures/vocabulary.hsx", import.meta.url),
  "utf8",
);
const compiled = compile(source, { costTable });
function instrument(id: string) {
  return (
    compiled.artifacts?.document as UdlDocument | undefined
  )?.instruments.find((value) => value.id === id);
}
function refuses(from: string, to: string) {
  expect(source.includes(from)).toBe(true);
  expect(compile(source.replace(from, to), { costTable }).verdict).toBe(
    "invalid",
  );
}

test("ordinary HSX preserves the vocabulary in canonical UDL", () => {
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.verdict).toBe("valid");
  const doc = compiled.artifacts!.document as UdlDocument;
  expect(parseUdl(serializeUdl(doc))).toEqual(doc);
});
test("HSX emits stored bps and field-valued cost caps", () => {
  expect(
    instrument("slice")?.derivedAmounts?.map((amount) => amount.rule),
  ).toEqual([
    { kind: "percentage_of", bps: { field: "rate" } },
    { kind: "minimum", capField: "cap" },
  ]);
  refuses("bps: {field: rate;}", "bps: {field: absent;}");
  refuses("cap_field: cap;", "cap_field: rate;");
});
test("HSX emits per-instance grace", () => {
  expect(instrument("slice")?.actions.close?.due?.offset).toEqual({
    field: "grace",
  });
  refuses('enum: ["P3D", "P7D"]', 'enum: ["P3D", "monthly"]');
});
test("HSX emits own date order and two bounds on one reference", () => {
  expect(instrument("cover")?.dateOrder).toEqual([
    { beforeField: "start", afterField: "end", operator: "<" },
  ]);
  expect(instrument("slice")?.actions.create?.requiresRefs).toHaveLength(2);
  refuses("after_field: end", "after_field: principal");
});
test("HSX emits the same-parent clock gate and integer count", () => {
  expect(
    instrument("claim")?.actions.create?.requiresAggregate?.[0],
  ).toMatchObject({
    anchorField: "coverId",
    dueBefore: { field: "dueAt" },
    check: { kind: "count_exactly", value: 0 },
  });
  expect(
    instrument("cover")?.actions.close?.requiresAggregate?.[0]?.check,
  ).toEqual({ kind: "count_at_least", targetField: "minimumMissed" });
  refuses("anchor_field: coverId", "anchor_field: absent");
  refuses("target_field: minimumMissed", "target_field: principal");
});
test("HSX emits exact signed schedule membership and ordered dates", () => {
  const checks = instrument("cover")?.actions.close?.requiresAggregate?.map(
    (value) => value.check,
  );
  expect(checks?.[1]).toMatchObject({
    kind: "ordered",
    positionField: "position",
  });
  expect(checks?.[2]).toMatchObject({
    kind: "schedule",
    remainder: "first",
    datesField: "dates",
  });
  refuses("dates_field: dates", "dates_field: principal");
});
test("HSX emits namespaced unique-kind assessment", () => {
  expect(
    instrument("slice")?.actions.create?.requiresRefs?.[0]?.unique,
  ).toEqual({ namespace: "assessment", byFields: ["kind"] });
  refuses("by_fields: [kind]", "by_fields: [absent]");
});
test("HSX emits a child-to-parent transition and rejects a missing action", () => {
  expect(instrument("slice")?.actions.close?.transitionsRefs).toEqual([
    { field: "coverId", action: "close" },
  ]);
  refuses(
    "transitions refs: {field: coverId; action: close;}",
    "transitions refs: {field: coverId; action: absent;}",
  );
});
test("HSX emits shared allocation and the closed earning-rule choices", () => {
  expect(
    instrument("cover")?.allocation?.buckets.map((bucket) => bucket.key),
  ).toEqual(["principal", "profit", "cost"]);
  expect(instrument("payment")?.actions.close?.allocate).toMatchObject({
    refField: "coverId",
    mode: "payment",
    paymentIdentityField: "paymentIdentity",
  });
  refuses("enum: [per_slice_on_due, on_disbursement]", "enum: [daily_accrual]");
  refuses(
    "payment_identity_field: paymentIdentity",
    "payment_identity_field: amount",
  );
});

test("HSX emits a bounded contribution list and complete origin refund", () => {
  expect(instrument("joined_settlement")?.contributions).toEqual({
    field: "contributions",
    amountKey: "amount",
    accountKey: "origin",
    totalField: "price",
  });
  expect(
    instrument("joined_settlement")?.actions.refund?.contributionStage,
  ).toEqual({
    stage: "refund",
    accountPath: "refs.hold",
  });
  refuses("amount_key: amount", "amount_key: origin");
});

test("HSX emits a bounded multi-operand remainder", () => {
  expect(
    instrument("payoff_remainder")?.actions.close?.remainder?.subtractPaths,
  ).toEqual(["fields.paid", "fields.rebate"]);
  refuses(
    'subtract_paths: ["fields.paid", "fields.rebate"]',
    'subtract_paths: ["fields.paid", "fields.absent"]',
  );
});
test("HSX refunds a referenced allocation receipt", () => {
  expect(
    instrument("allocation_refund")?.actions.close?.allocate,
  ).toMatchObject({
    mode: "refund",
    refField: "paymentId",
    assessmentField: "assessment",
  });
  refuses("mode: refund; action: close", "mode: refund; action: create");
});

test("HSX proves the outgoing settlement partition against the funded total", () => {
  expect(instrument("joined_settlement")?.partitions).toEqual([
    { totalField: "price", pieceFields: ["buyerPart", "funderPart"] },
    { totalField: "price", pieceFields: ["sellerNet", "sellerFee", "tax"] },
  ]);
  refuses(
    "piece_fields: [sellerNet, sellerFee, tax]",
    "piece_fields: [sellerNet, sellerFee]",
  );
});

test("HSX emits a permanent subject claim without a reference gate", () => {
  expect(instrument("limit")?.actions.create?.unique).toEqual({
    namespace: "borrower_limit",
    byFields: ["borrower", "currency"],
  });
  refuses("by_fields: [borrower, currency]", "by_fields: [borrower, absent]");
  refuses("by_fields: [borrower, currency]", "by_fields: [borrower, borrower]");
});

test("HSX measures exposure against the scheduled allocation gross", () => {
  expect(
    instrument("cover")?.actions.create?.requiresExposure?.[0]?.measure,
  ).toEqual({ allocation: "principal" });
  refuses(
    "measure: { allocation: principal; }",
    "measure: { allocation: absent; }",
  );
  refuses(
    "measure: { allocation: principal; }",
    "measure: { allocation: profit; }",
  );
});

test("self write-off and template selectors preserve obligation identity across aliases", () => {
  expect(instrument("cover")?.actions.write_off?.allocate).toEqual({
    mode: "write_off",
    capture: "loss",
  });
  expect(instrument("cover")?.allocation?.buckets[2]?.source).toEqual({
    from: "children",
    template: "assessment",
    parameters: { cost: true },
    refField: "sliceId",
    statuses: ["open"],
    amountField: "amount",
    destinationField: "receiver",
  });
  for (const name of ["first_cost", "second_cost", "fine_only"]) {
    expect(instrument(name)?.templateBinding).toEqual({
      id: "assessment",
      parameters: { cost: name !== "fine_only" },
    });
  }
  refuses("mode: write_off; capture: loss", "mode: payment; capture: loss");
  refuses(
    "amount_field: amount; destination_field: receiver",
    "amount_field: absent; destination_field: receiver",
  );
});
