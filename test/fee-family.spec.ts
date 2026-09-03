import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUdl, serializeUdl } from "@hyperscale0/udl";
import { expect, test } from "bun:test";
import { compile } from "./compile.ts";

test("fractional percentages emit numeric basis points", () => {
  const source = readFileSync(
    join(import.meta.dir, "fixtures", "fractional-bps.hsx"),
    "utf8",
  );
  const result = compile(source);
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }

  // This oracle declares both fee and cancellation sides. The old one pinned
  // unresolved compile-time markers in field descriptions, which lowering now
  // refuses because those markers can hide a missing money rule.
  const expected = readFileSync(
    join(import.meta.dir, "fixtures", "fee-oracle", "fractional-bps.udl"),
    "utf8",
  );
  const actual = serializeUdl(result.artifacts.document);
  expect(actual).toBe(expected);
  const document = parseUdl(actual);
  expect(
    document.instruments[0]?.feeRules?.map((fee) => fee.rule),
  ).toContainEqual({ bps: 150, kind: "bps" });
});

test("payer-only fees keep the principal transfer", () => {
  const source = readFileSync(
    join(import.meta.dir, "fixtures", "payer-fee-transfer.hsx"),
    "utf8",
  );
  const result = compile(source);
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }

  const document = parseUdl(serializeUdl(result.artifacts.document));
  expect(document.instruments[0]?.actions.pay_piece_1?.moves).toEqual([
    {
      bind: {
        amount: { from: "instance", path: "fields.lessonPrice" },
        currency: { from: "instance", path: "fields.currency" },
        destinationAccountId: {
          from: "instance",
          path: "fields.tutorAccountId",
        },
        "metadata.instrumentId": {
          from: "const",
          value: "lesson_payment",
        },
        "metadata.instrumentInstanceId": {
          from: "instance",
          path: "instrumentInstanceId",
        },
        "metadata.phase": { from: "const", value: "pay_piece_1" },
        productId: { from: "instance", path: "productId" },
        sourceAccountId: {
          from: "instance",
          path: "fields.studentAccountId",
        },
      },
      capture: { payPiece1TransferTransferId: "transferId" },
      key: "transfer",
      operation: "internal_transfer.create",
    },
  ]);
});

test("payer-only held fees keep the principal whole", () => {
  const result = compile(`program one_sided_hold "One-sided hold"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port approve
  fees { buyer: 2.5% }
  on_cancel(funded) { buyer: 100% }
}
port approve { allowed: [seller] }
`);
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }
  const instrument = parseUdl(serializeUdl(result.artifacts.document))
    .instruments[0];
  expect(instrument?.feeRules).toContainEqual({
    amountField: "serviceFeeAmount",
    baseField: "price",
    bearerField: "buyerAccountId",
    position: "on_top",
    rule: { bps: 250, kind: "bps" },
  });
  expect(instrument?.partitions).toBeUndefined();
  expect(instrument?.actions.fund_piece_1?.moves).toHaveLength(2);
});

test("held payments collect an exact payer fee on top", () => {
  const result = compile(`program exact_payer_hold "Exact payer hold"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port approve
  fees { buyer: buyerFee: money(SAR), seller: 2% }
}
port approve { allowed: [seller] }
`);
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }

  const instrument = parseUdl(serializeUdl(result.artifacts.document))
    .instruments[0];
  expect(instrument?.feeRules).toEqual([
    {
      amountField: "buyerFee",
      baseField: "price",
      bearerField: "buyerAccountId",
      position: "on_top",
      rule: {
        currencyField: "currency",
        field: "buyerFee",
        kind: "exact",
      },
    },
    {
      amountField: "piece2Amount",
      baseField: "price",
      bearerField: "sellerAccountId",
      position: "carved",
      rule: { bps: 200, kind: "bps" },
    },
  ]);
  expect(instrument?.required).toContain("buyerFee");
  expect(instrument?.actions.fund_piece_1?.moves).toHaveLength(2);
  expect(instrument?.actions.fund_piece_1?.moves?.[1]?.bind.amount).toEqual({
    from: "instance",
    path: "fields.buyerFee",
  });
});

test("held payments carve an exact payee fee from escrow", () => {
  const result = compile(`program exact_payee_hold "Exact payee hold"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port approve
  fees { seller: sellerFee: money(SAR) }
}
port approve { allowed: [seller] }
`);
  if (!result.artifacts) {
    throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  }

  const instrument = parseUdl(serializeUdl(result.artifacts.document))
    .instruments[0];
  expect(instrument?.feeRules).toEqual([
    {
      amountField: "sellerFee",
      baseField: "price",
      bearerField: "sellerAccountId",
      position: "carved",
      rule: {
        currencyField: "currency",
        field: "sellerFee",
        kind: "exact",
      },
    },
  ]);
  expect(instrument?.required).toContain("sellerFee");
  expect(instrument?.partitions).toEqual([
    { pieceFields: ["piece1Amount", "sellerFee"], totalField: "price" },
  ]);
  expect(instrument?.actions.fund_piece_2?.moves?.[0]?.bind.amount).toEqual({
    from: "instance",
    path: "fields.sellerFee",
  });
  expect(instrument?.actions.release_piece_2?.moves?.[0]?.bind.amount).toEqual({
    from: "instance",
    path: "fields.sellerFee",
  });
});
