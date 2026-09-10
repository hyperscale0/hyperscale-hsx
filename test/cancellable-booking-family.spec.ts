import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");

function compileFixture(relativePath: string): UdlDocument {
  const source = readFileSync(join(packageRoot, relativePath), "utf8");
  const result = compile(source, { moduleName: relativePath });
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result.artifacts.document as UdlDocument;
}

describe("cancellable booking standard library", () => {
  test("provisions holding account, quotes cancellation penalty, and refunds net to guest", () => {
    const document = compileFixture("test/fixtures/cancellable-booking.hsx");
    const booking = document.instruments.find(
      (instrument) => instrument.id === "studio_session",
    );
    expect(booking).toBeDefined();
    if (!booking) return;

    expect(booking.lifecycle.states).toEqual([
      "created",
      "held",
      "cancellation_quoted",
      "canceled",
      "settled",
      "completed",
    ]);

    expect(booking.actions.create?.steps).toEqual([
      {
        bind: {
          currency: { from: "instance", path: "fields.currency" },
          "owner.id": { from: "instance", path: "productId" },
          "owner.type": { from: "const", value: "product" },
          productId: { from: "instance", path: "productId" },
          role: { from: "const", value: "product_escrow" },
        },
        capture: { bookingHoldingAccountId: "accountId" },
        operation: "account.escrow.provision",
      },
    ]);

    expect(booking.actions.take?.moves?.[0]?.operation).toBe(
      "internal_transfer.create",
    );
    expect(booking.actions.take?.moves?.[0]?.bind.destinationAccountId).toEqual(
      {
        from: "instance",
        path: "refs.bookingHoldingAccountId",
      },
    );

    expect(booking.actions.cancel?.quote).toEqual({
      anchorField: "startsAt",
      baseField: "sessionPrice",
      chargeRef: "cancellationPenaltyAmount",
      charges: [{ bps: 5000, withinOffset: "P2D" }, { bps: 1000 }],
      expires: { offset: "PT30M" },
      fixes: ["sessionPrice", "guestAccountId"],
      netDestinationField: "guestAccountId",
      netRef: "cancellationRefundAmount",
    });

    expect(booking.actions.confirm?.moves?.[0]?.bind.amount).toEqual({
      from: "instance",
      path: "refs.cancellationRefundAmount",
    });
    expect(
      booking.actions.confirm?.moves?.[0]?.bind.destinationAccountId,
    ).toEqual({
      from: "instance",
      path: "fields.guestAccountId",
    });

    expect(booking.actions.retain?.moves?.[0]?.bind.amount).toEqual({
      from: "instance",
      path: "refs.cancellationPenaltyAmount",
    });
    expect(
      booking.actions.retain?.moves?.[0]?.bind.destinationAccountId,
    ).toEqual({
      from: "instance",
      path: "fields.studioAccountId",
    });
  });
});
