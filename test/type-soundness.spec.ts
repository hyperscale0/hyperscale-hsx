import { describe, expect, it } from "bun:test";
import type { UdlDocument } from "@hyperscale0/udl";
import { lowerGeneralProgram } from "../src/emit.ts";
import { compile } from "./compile.ts";
import type { JsonValue, TypedProgram } from "../src/ir.ts";

const documentOf = (
  result: ReturnType<typeof compile>,
): UdlDocument | undefined =>
  result.artifacts?.document as UdlDocument | undefined;

const TEMPLATE = `program soundness "Soundness"
party buyer: person
export instrument payable<C>(payer: party, amount: money<C>, count: integer, release: condition) {
  title: "Payable";
  fields { amount: money<C>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: payer; }
  action create { steps: []; }
  action pay { steps: []; moves: []; }
}`;

describe("general typechecker soundness", () => {
  it("rejects unknown fee party keys", () => {
    const result = compile(`program fee_roles "Fee roles"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port confirm
  fees { buyer: 1%, sellr: 2% }
}
port confirm { allowed: [buyer] }
`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1001",
        fix: expect.stringContaining("buyer, seller"),
        message: expect.stringContaining("sellr"),
      }),
    );
  });

  it("rejects unknown cancellation party keys", () => {
    const result = compile(`program cancellation_roles "Cancellation roles"
import { held_payment } from "std/settlements"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port confirm
  on_cancel(funded) { buyr: 50%, seller: 50% }
}
port confirm { allowed: [buyer] }
`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1001",
        fix: expect.stringContaining("buyer, seller"),
        message: expect.stringContaining("buyr"),
      }),
    );
  });

  it("rejects unknown swap amount and fee party keys", () => {
    const result = compile(`program swap_roles "Swap roles"
import { swap } from "std/settlements"
party member: person
party seller: business
settlement trade = swap {
  between: [member, seller]
  amounts {
    member: memberPays: money(SAR)
    sellr: sellerPays: money(SAR)
  }
  fees {
    membar: memberFee: money(SAR)
    seller: sellerFee: money(SAR)
  }
  release: port confirm
  dispute: port resolve within P14D
}
port confirm { allowed: [member, seller] }
port resolve { allowed: [member, seller] }
`);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "HSX1001",
          fix: expect.stringContaining("member, seller"),
          message: expect.stringContaining("sellr"),
        }),
        expect.objectContaining({
          code: "HSX1001",
          fix: expect.stringContaining("member, seller"),
          message: expect.stringContaining("membar"),
        }),
      ]),
    );
  });

  it("rejects unknown pooled split party keys derived through keys_except", () => {
    const result = compile(`program pooled_split_roles "Pooled split roles"
import { pooled_split } from "std/settlements"
party merchant: business
party courier: business
party packer: business
settlement fulfillment = pooled_split {
  payer: merchant
  amount: poolTotal: money(SAR)
  payout_due: payoutDate
  split { courier: 60%, packr: 40%, remainder_to: courier }
}
`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1001",
        fix: expect.stringContaining("courier, merchant, packer"),
        message: expect.stringContaining("packr"),
      }),
    );
  });

  it("refuses unresolved compile-time markers before UDL emission", () => {
    const result = compile(`program unresolved_marker "Unresolved marker"
instrument item {
  title: "__hsx_none__";
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1603", stage: "lower" }),
    );
    expect(result.artifacts).toBeUndefined();
  });

  it("refuses unresolved compile-time markers in lowered document paths", () => {
    const actionSlots: Record<string, JsonValue> = {
      moves: [
        {
          bind: {
            amount: "__hsx_none__",
            destinationAccountId: "fields.destinationAccountId",
            sourceAccountId: "fields.sourceAccountId",
          },
          key: "probe",
          operation: "internal_transfer.create",
        },
      ],
      steps: [],
      summary: "Create the document probe",
    };
    const program: TypedProgram = {
      instruments: [
        {
          actions: [
            {
              effects: {},
              name: "create",
              origin: { end: 1, start: 0 },
              slots: actionSlots,
            },
          ],
          fields: [],
          id: "zz_document_probe",
          origin: { end: 1, start: 0 },
          slots: {
            idPrefix: "zzdoc",
            lifecycle: {
              initial: "created",
              states: ["created"],
              transitions: {},
            },
            summary: "Document probe",
            title: "Document probe",
          },
        },
      ],
      kind: "typed_program",
      name: "document_probe",
      origin: { end: 1, start: 0 },
      subjects: [],
      title: "Document probe",
    };

    const result = lowerGeneralProgram(program);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "HSX1603",
        path: "$.instruments[0].actions.create.moves[0].bind.amount",
      }),
    );
  });

  it("appends repeated many-valued clauses", () => {
    const result = compile(`program transfers "Transfers"
instrument transfer {
  fields { amount: money<SAR>; }
  lifecycle { states created moved; initial created; on move: created -> moved; }
  action create { steps: []; }
  action move {
    moves: [{ amount: "refs.firstAmount"; from: "refs.sourceAccountId"; to: "refs.destinationAccountId"; }];
    moves: [{ amount: "refs.secondAmount"; from: "refs.sourceAccountId"; to: "refs.destinationAccountId"; }];
  }
}`);
    expect(result.verdict).toBe("valid");
    expect(
      documentOf(result)?.instruments[0]?.actions.move?.moves,
    ).toHaveLength(2);
  });

  it("rejects repeated single-valued clauses from UDL cardinality", () => {
    const result = compile(
      TEMPLATE.replace(
        'title: "Payable";',
        'title: "First"; title: "Second";',
      ) +
        "\nport release_payment { allowed: [buyer]; }\n" +
        "instrument bill = payable<SAR>(payer: buyer, amount: SAR 1.00, count: 1, release: port release_payment)",
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1505" }),
    );
  });

  it("rejects undeclared decision ports", () => {
    const result = compile(
      `${TEMPLATE}\ninstrument bill = payable<SAR>(payer: buyer, amount: SAR 1.00, count: 1, release: port ghost)`,
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1008",
        message: expect.stringContaining("ghost"),
      }),
    );
  });

  it("reports undeclared parties and ports in the same pass", () => {
    const result = compile(
      `${TEMPLATE}\ninstrument bill = payable<SAR>(payer: ghost, amount: SAR 1.00, count: 1, release: port ghostport)`,
    );
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["HSX1001", "HSX1008"]),
    );
  });

  it("rejects unknown and duplicate named arguments", () => {
    const port = "\nport release_payment { allowed: [buyer]; }";
    const unknown = compile(
      `${TEMPLATE}${port}\ninstrument bill = payable<SAR>(payer: buyer, amount: SAR 1.00, count: 1, release: port release_payment, typo: true)`,
    );
    expect(unknown.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1012" }),
    );

    const duplicate = compile(
      `${TEMPLATE}${port}\ninstrument bill = payable<SAR>(payer: buyer, payer: buyer, amount: SAR 1.00, count: 1, release: port release_payment)`,
    );
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1013" }),
    );
  });

  it("checks every argument type and accepts a literal integer bound", () => {
    const port = "\nport release_payment { allowed: [buyer]; }";
    const wrong = compile(
      `${TEMPLATE}${port}\ninstrument bill = payable<SAR>(payer: 5%, amount: SAR 1.00, count: 1, release: port release_payment)`,
    );
    expect(wrong.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1104" }),
    );

    const bounded = compile(
      `${TEMPLATE.replace(
        "  lifecycle { states created paid; initial created; on pay: created -> paid; }",
        "  lifecycle { states created paid; initial created; on pay: created -> paid; for item in count { on inspect_[item]: created -> created; } }",
      ).replace(
        "  action create { steps: []; }",
        "  action create { steps: []; } for item in count { action inspect_[item] { steps: []; } }",
      )}${port}\ninstrument bill = payable<SAR>(payer: buyer, amount: SAR 1.00, count: 2, release: port release_payment)`,
    );
    expect(bounded.verdict).toBe("valid");
    expect(
      documentOf(bounded)?.instruments[0]?.actions.inspect_2,
    ).toBeDefined();
  });

  it("resolves money aliases before checking currency", () => {
    const result = compile(`program aliases "Aliases"
type SaudiMoney = money<SAR>
party buyer: person
export instrument payable(amount: SaudiMoney) {
  fields { amount: SaudiMoney; }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}
instrument bill = payable(amount: USD 1.00)`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1101" }),
    );
  });

  it("substitutes local and imported constants", () => {
    const result = compile(
      `program constants "Constants"
import { imported_title } from "titles"
const local_summary: text = "Local summary"
instrument bill {
  title: imported_title;
  summary: local_summary;
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`,
      {
        moduleName: "constants.hsx",
        resolveModule: () => ({
          name: "titles.hsx",
          source:
            'module titles\nexport const imported_title: text = "Imported title"',
        }),
      },
    );
    expect(result.verdict).toBe("valid");
    expect(documentOf(result)?.instruments[0]).toMatchObject({
      summary: "Local summary",
      title: "Imported title",
    });
  });

  it("selects the principal move when an optional fee side is absent", () => {
    const result = compile(`program fee_side "Fee side"
import { instant_transfer } from "std/settlements"
party buyer: person
party seller: business
settlement sale = instant_transfer {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  fees { buyer: checkoutFee: money(SAR) }
}`);
    expect(result.verdict).toBe("valid");
    expect(
      documentOf(result)?.instruments[0]?.actions.pay_piece_1?.moves,
    ).toHaveLength(1);
  });

  it("emits an inferred party account once in required", () => {
    const result = compile(`program credit "Credit"
party borrower: person
instrument facility {
  fields {}
  parties { payer: borrower; }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`);
    expect(result.verdict).toBe("valid");
    const required = documentOf(result)?.instruments[0]?.required ?? [];
    expect(
      required.filter((name) => name === "borrowerAccountId"),
    ).toHaveLength(1);
  });

  it("binds a declared shape-less port to an empty finite field set", () => {
    const result = compile(`program empty_port "Empty port"
party buyer: person
port approve { allowed: [buyer]; }
export instrument inspected(decision: condition) {
  fields {
    for field in keys(decision_fields) { [field]: text; }
  }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}
instrument item = inspected(decision: port approve)`);
    expect(result.verdict).toBe("valid");
    expect(documentOf(result)?.instruments[0]?.fields).toEqual({});
  });

  it("refuses endorsement without its renewal due argument before lowering", () => {
    const result = compile(`program endorsement_due "Endorsement due"
import { premium_forward } from "std/settlements"
party payer: person
party carrier: business
settlement premium = premium_forward {
  payer: payer
  carrier: carrier
  amount: premiumAmount: money(SAR)
  bind: port bind_policy
  commission: 5%
  endorsement: port endorse_policy
}
port bind_policy { allowed: [payer, carrier] }
port endorse_policy { allowed: [carrier] }
`);

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "HSX1011",
        message:
          "premium_forward needs argument renewal_due for the selected options",
        stage: "typecheck",
      }),
    ]);
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "HSX1502" }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ stage: "lower" }),
    );
  });

  it("finds a missing optional argument inside a call", () => {
    const result = compile(`program call_dependency "Call dependency"
export instrument called_optional(value: optional<text>) {
  fields {}
  lifecycle { states created; initial created; }
  action create { summary: concat(value); steps: []; }
}
instrument probe = called_optional()
`);

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "HSX1011",
        message:
          "called_optional needs argument value for the selected options",
        stage: "typecheck",
      }),
    ]);
  });
});
