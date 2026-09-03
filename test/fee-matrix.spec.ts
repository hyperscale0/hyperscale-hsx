import { describe, expect, test } from "bun:test";
import type { UdlDocument, UdlInstrument } from "@hyperscale0/udl";
import { validateUdl } from "@hyperscale0/udl";
import { compile } from "./compile.ts";

type FeeKind = "exact" | "none" | "percent";
type CancellationKind = "none" | "split";
type ExpectedOutcome = "unsupported" | "valid";

interface HeldPaymentFeeCase {
  readonly cancellation: CancellationKind;
  readonly outcome: ExpectedOutcome;
  readonly payee: FeeKind;
  readonly payer: FeeKind;
}

// Exact payee fees need a separate cancellation partition. Every other cell is
// part of the supported held-payment contract.
const heldPaymentFeeMatrix: readonly HeldPaymentFeeCase[] = [
  { payer: "none", payee: "none", cancellation: "none", outcome: "valid" },
  { payer: "none", payee: "none", cancellation: "split", outcome: "valid" },
  { payer: "none", payee: "percent", cancellation: "none", outcome: "valid" },
  { payer: "none", payee: "percent", cancellation: "split", outcome: "valid" },
  { payer: "none", payee: "exact", cancellation: "none", outcome: "valid" },
  {
    payer: "none",
    payee: "exact",
    cancellation: "split",
    outcome: "unsupported",
  },
  { payer: "percent", payee: "none", cancellation: "none", outcome: "valid" },
  { payer: "percent", payee: "none", cancellation: "split", outcome: "valid" },
  {
    payer: "percent",
    payee: "percent",
    cancellation: "none",
    outcome: "valid",
  },
  {
    payer: "percent",
    payee: "percent",
    cancellation: "split",
    outcome: "valid",
  },
  {
    payer: "percent",
    payee: "exact",
    cancellation: "none",
    outcome: "valid",
  },
  {
    payer: "percent",
    payee: "exact",
    cancellation: "split",
    outcome: "unsupported",
  },
  { payer: "exact", payee: "none", cancellation: "none", outcome: "valid" },
  { payer: "exact", payee: "none", cancellation: "split", outcome: "valid" },
  {
    payer: "exact",
    payee: "percent",
    cancellation: "none",
    outcome: "valid",
  },
  {
    payer: "exact",
    payee: "percent",
    cancellation: "split",
    outcome: "valid",
  },
  { payer: "exact", payee: "exact", cancellation: "none", outcome: "valid" },
  {
    payer: "exact",
    payee: "exact",
    cancellation: "split",
    outcome: "unsupported",
  },
];

type InstantPayeeFeeKind = "none" | "percent" | "tiered";

interface InstantTransferFeeCase {
  readonly payee: InstantPayeeFeeKind;
  readonly payer: FeeKind;
}

const instantTransferFeeMatrix: readonly InstantTransferFeeCase[] = [
  { payer: "none", payee: "none" },
  { payer: "none", payee: "percent" },
  { payer: "none", payee: "tiered" },
  { payer: "percent", payee: "none" },
  { payer: "percent", payee: "percent" },
  { payer: "percent", payee: "tiered" },
  { payer: "exact", payee: "none" },
  { payer: "exact", payee: "percent" },
  { payer: "exact", payee: "tiered" },
];

describe("held_payment fee matrix", () => {
  for (const feeCase of heldPaymentFeeMatrix) {
    test(feeCaseName(feeCase), () => {
      const result = compile(heldPaymentSource(feeCase));
      if (feeCase.outcome === "unsupported") {
        expect(result.artifacts).toBeUndefined();
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: expect.stringMatching(/^HSX11[0-9]{2}$/),
            message: expect.stringContaining(
              "exact payee fees cannot combine with on_cancel yet",
            ),
          }),
        );
        expect(result.diagnostics).not.toContainEqual(
          expect.objectContaining({ code: "HSX1603" }),
        );
        return;
      }

      const document = requiredDocument(result);
      const validation = validateUdl(document);
      expect(validation.ok).toBe(true);
      const instrument = requiredInstrument(document.instruments[0]);
      assertEveryFeeHasACollectingMove(
        instrument,
        declaredFeeCount(feeCase.payer, feeCase.payee),
      );
    });
  }
});

describe("instant_transfer fee matrix", () => {
  for (const feeCase of instantTransferFeeMatrix) {
    test(`payer ${feeCase.payer}, payee ${feeCase.payee}`, () => {
      const result = compile(instantTransferSource(feeCase));
      const document = requiredDocument(result);
      const validation = validateUdl(document);
      expect(validation.ok).toBe(true);
      const instrument = requiredInstrument(document.instruments[0]);
      assertEveryFeeHasACollectingMove(
        instrument,
        declaredFeeCount(feeCase.payer, feeCase.payee),
      );
    });
  }
});

function feeCaseName(feeCase: HeldPaymentFeeCase): string {
  return `payer ${feeCase.payer}, payee ${feeCase.payee}, cancellation ${feeCase.cancellation}: ${feeCase.outcome}`;
}

function heldPaymentSource(feeCase: HeldPaymentFeeCase): string {
  const fees = feeBlock(feeCase.payer, feeCase.payee);
  const cancellation =
    feeCase.cancellation === "split"
      ? "on_cancel(funded) { buyer: 50%, seller: 50% }"
      : "";
  return `program held_fee_matrix "Held fee matrix"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port approve
  ${fees}
  ${cancellation}
}
port approve { allowed: [seller] }
`;
}

function instantTransferSource(feeCase: InstantTransferFeeCase): string {
  const payerFee = feeEntry("buyer", feeCase.payer);
  const payeeFee =
    feeCase.payee === "tiered"
      ? `seller {
      tier { from: 0 to: 10000 fee: 1% }
      tier { from: 10000 fee: sellerFee: money(SAR, 150) }
    }`
      : feeEntry("seller", feeCase.payee);
  const entries = [payerFee, payeeFee].filter(Boolean).join("\n    ");
  const fees = entries.length > 0 ? `fees {\n    ${entries}\n  }` : "";
  return `program instant_fee_matrix "Instant fee matrix"
import { instant_transfer } from "std/settlements"
party buyer: person
party seller: business
settlement sale = instant_transfer {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  ${fees}
}
`;
}

function feeBlock(payer: FeeKind, payee: FeeKind): string {
  const entries = [feeEntry("buyer", payer), feeEntry("seller", payee)]
    .filter(Boolean)
    .join("\n    ");
  return entries.length > 0 ? `fees {\n    ${entries}\n  }` : "";
}

function feeEntry(role: "buyer" | "seller", fee: FeeKind): string {
  if (fee === "none") return "";
  if (fee === "percent") return `${role}: ${role === "buyer" ? "2%" : "3%"}`;
  const field = role === "buyer" ? "buyerFee" : "sellerFee";
  const amount = role === "buyer" ? 250 : 150;
  return `${role}: ${field}: money(SAR, ${amount})`;
}

function declaredFeeCount(
  payer: FeeKind,
  payee: FeeKind | InstantPayeeFeeKind,
): number {
  return Number(payer !== "none") + Number(payee !== "none");
}

function requiredDocument(result: ReturnType<typeof compile>): UdlDocument {
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics
        .map(
          (diagnostic) => `${diagnostic.code ?? "HSX"}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  return result.artifacts.document as UdlDocument;
}

function requiredInstrument(
  instrument: UdlInstrument | undefined,
): UdlInstrument {
  if (!instrument) throw new Error("compiler emitted no instrument");
  return instrument;
}

function assertEveryFeeHasACollectingMove(
  instrument: UdlInstrument,
  declaredFees: number,
): void {
  const feeRules = instrument.feeRules ?? [];
  expect(feeRules).toHaveLength(declaredFees);
  const collectingAmountFields = new Set<string>();
  for (const action of Object.values(instrument.actions)) {
    for (const move of action.moves ?? []) {
      const amount = move.bind.amount;
      const destination = move.bind.destinationAccountId;
      if (
        amount?.from === "instance" &&
        amount.path.startsWith("fields.") &&
        destination?.from === "instance" &&
        destination.path === "fields.platformAccountId"
      ) {
        collectingAmountFields.add(amount.path.slice("fields.".length));
      }
    }
  }
  for (const feeRule of feeRules) {
    expect(collectingAmountFields, feeRule.amountField).toContain(
      feeRule.amountField,
    );
  }
}
