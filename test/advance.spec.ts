import type { UdlDocument } from "@hyperscale0/udl";
import { expect, it } from "bun:test";
import { compile } from "./compile.ts";

const source = `program financed "Financed"
import { advance } from "std/money_flows"
party funder: business
party recipient: business
party buyer: person
party income: business
settlement finance = advance {
  funder: funder
  to: recipient
  repayment_source: buyer
  profit_to: income
  amount: principal: money(SAR)
  fee: 5%
  count: 6
  dated: true
  every: P1M
  first_due: firstDueAt
}`;

it("derives fixed profit from advanced principal", () => {
  const finance = (
    compile(source).artifacts?.document as UdlDocument | undefined
  )?.instruments.find((item) => item.id === "finance");
  expect(finance?.derivedAmounts).toEqual([
    {
      field: "feeAmount",
      sourceField: "principal",
      rule: { kind: "percentage_of", bps: 500 },
      rounding: "floor",
    },
  ]);
});

it("collects principal and profit from the borrower into their separate accounts", () => {
  const finance = (
    compile(source).artifacts?.document as UdlDocument | undefined
  )?.instruments.find((item) => item.id === "finance");
  expect(
    finance?.actions.collect_repayment_1?.moves?.map((move) => [
      move.bind.amount,
      move.bind.sourceAccountId,
      move.bind.destinationAccountId,
    ]),
  ).toEqual([
    [
      { from: "instance", path: "fields.repayment1Principal" },
      { from: "instance", path: "fields.buyerAccountId" },
      { from: "instance", path: "fields.funderAccountId" },
    ],
    [
      { from: "instance", path: "fields.repayment1Profit" },
      { from: "instance", path: "fields.buyerAccountId" },
      { from: "instance", path: "fields.incomeAccountId" },
    ],
  ]);
});

it("anchors the sixth repayment on its signed date", () => {
  const finance = (
    compile(source).artifacts?.document as UdlDocument | undefined
  )?.instruments.find((item) => item.id === "finance");
  expect(finance?.actions.collect_repayment_6?.due).toEqual({
    field: "repayment6DueAt",
  });
});
