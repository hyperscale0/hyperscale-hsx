import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { UdlDocument } from "@hyperscale0/udl";
import { lowerGeneralProgram } from "../src/emit.ts";
import { checkGeneralProgram, compile as compileHsx } from "../src/index.ts";
import { hsxDiagnostics } from "../src/diagnostics.ts";
import { resolveProgramModules } from "../src/modules.ts";
import { parseProgram } from "../src/parse.ts";
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
  agent_description: "A payable instrument for soundness tests.";
  fields { amount: money<C>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: payer; }
  action create {
    agent_description: "Create a payable instance.";
    steps: [];
  }
  action pay {
    agent_description: "Pay the payable instance.";
    steps: []; moves: []; port { allowed_parties: release_allowed; }
  }
}`;

describe("general typechecker soundness", () => {
  it("keeps a decision party distinct from a colliding economic role", () => {
    const result = compile(`program collision "Collision"
import { held_payment } from "std/money_flows"
party buyer: person
party seller: business
party payer: person
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port confirm_delivery
}
port confirm_delivery { allowed: [payer] }
`);
    expect(result.verdict).toBe("valid");
    const sale = documentOf(result)?.instruments[0];
    const role = sale?.actions.confirm_delivery?.port?.allowedParties[0];
    expect(role && sale?.parties?.[role]).toBe("payerAccountId");
    expect(sale?.parties?.payer).toBe("buyerAccountId");
  });

  it("binds authority consumed through an action name without an explicit port row", () => {
    const result = compile(`${TEMPLATE.replaceAll("on pay:", "on [release]:")
      .replace("action pay", "action [release]")
      .replace("port { allowed_parties: release_allowed; }", "")}
port confirm { allowed: [buyer] }
instrument bill = payable<SAR>(payer: buyer, amount: SAR 1.00, count: 1, release: port confirm)`);
    expect(result.verdict).toBe("valid");
    expect(
      documentOf(result)?.instruments[0]?.actions.confirm?.port?.allowedParties,
    ).toEqual(["payer"]);
  });

  it("binds a decision-only party without routing money through its account", () => {
    const source = readFileSync(
      new URL("./fixtures/vehicle-inspection.hsx", import.meta.url),
      "utf8",
    );
    const result = compile(source);
    expect(result.verdict).toBe("valid");
    const instrument = documentOf(result)?.instruments[0];
    expect(instrument?.parties).toMatchObject({
      inspector: "inspectorAccountId",
    });
    expect(instrument?.required).toContain("inspectorAccountId");
    expect(instrument?.actions.pass_inspection?.port?.allowedParties).toEqual([
      "inspector",
    ]);
    expect(
      JSON.stringify(
        Object.values(instrument?.actions ?? {}).flatMap(
          (action) => action.moves ?? [],
        ),
      ),
    ).not.toContain("inspectorAccountId");
  });

  it("preserves every allowed party when a decision has more than two deciders", () => {
    const source = readFileSync(
      new URL("./fixtures/vehicle-inspection.hsx", import.meta.url),
      "utf8",
    );
    const result = compile(
      source.replace(
        "allowed: [inspector]",
        "allowed: [buyer, seller, inspector]",
      ),
    );
    expect(
      documentOf(result)?.instruments[0]?.actions.pass_inspection?.port
        ?.allowedParties,
    ).toEqual(["payer", "beneficiary", "inspector"]);
  });

  it("rejects an undeclared decision party", () => {
    const source = readFileSync(
      new URL("./fixtures/vehicle-inspection.hsx", import.meta.url),
      "utf8",
    );
    const result = compile(source.replace("party inspector: business", ""));
    expect(result.verdict).toBe("invalid");
    expect(result.artifacts).toBeUndefined();
  });

  it("rejects unknown fee party keys", () => {
    const result = compile(`program fee_roles "Fee roles"
import { held_payment } from "std/money_flows"
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
import { held_payment } from "std/money_flows"
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
import { swap } from "std/money_flows"
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
import { pooled_split } from "std/money_flows"
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
  agent_description: "An item instrument for compiler tests.";
  title: "__hsx_none__";
  fields {}
  lifecycle { states created; initial created; }
  action create {
    agent_description: "Create an item instance.";
    steps: [];
  }
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
  agent_description: "A transfer instrument for multi-move tests.";
  fields { amount: money<SAR>; }
  lifecycle { states created moved; initial created; on move: created -> moved; }
  action create {
    agent_description: "Create a transfer record.";
    steps: [];
  }
  action move {
    agent_description: "Execute the transfer moves.";
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
        `  action create {
    agent_description: "Create a payable instance.";
    steps: [];
  }`,
        `  action create {
    agent_description: "Create a payable instance.";
    steps: [];
  } for item in count { action inspect_[item] {
    agent_description: "Inspect the item.";
    steps: [];
  } }`,
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
  agent_description: "A bill instrument for constant tests.";
  title: imported_title;
  summary: local_summary;
  fields {}
  lifecycle { states created; initial created; }
  action create {
    agent_description: "Create a bill.";
    steps: [];
  }
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
import { instant_transfer } from "std/money_flows"
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
  agent_description: "A credit facility instrument.";
  fields {}
  parties { payer: borrower; }
  lifecycle { states created; initial created; }
  action create {
    agent_description: "Create a facility.";
    steps: [];
  }
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
  agent_description: "An inspected instrument.";
  fields {
    for field in keys(decision_fields) { [field]: text; }
  }
  parties { payer: buyer; }
  lifecycle { states created done; initial created; on [decision]: created -> done; }
  action create {
    agent_description: "Create an inspected record.";
    steps: [];
  }
  action [decision] {
    agent_description: "Record the inspection decision.";
    steps: []; port { allowed_parties: decision_allowed; }
  }
}
instrument item = inspected(decision: port approve)`);
    expect(result.verdict).toBe("valid");
    expect(
      Object.keys(documentOf(result)?.instruments[0]?.fields ?? {}),
    ).toEqual(["buyerAccountId"]);
  });

  it("refuses endorsement without its renewal due argument before lowering", () => {
    const result = compile(`program endorsement_due "Endorsement due"
import { premium_forward } from "std/money_flows"
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
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1011",
        message:
          "premium_forward needs argument renewal_due for the selected options",
        stage: "typecheck",
      }),
    );
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

  it("enforces agent descriptions on callable actions and exempts due actions", () => {
    const callableMissing = compile(`program callable_missing "Callable missing"
instrument item {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`);
    expect(callableMissing.verdict).toBe("invalid");
    const callableErrors = callableMissing.diagnostics.filter(
      ({ code }) => code === "HSX1509",
    );
    expect(callableErrors).toHaveLength(2);
    expect(callableErrors[0]?.message).toBe(
      "instrument item exposes callable actions without an agent_description",
    );
    expect(callableErrors[1]?.message).toBe(
      "action create of item is callable without an agent_description",
    );

    const dueOnly = compile(`program due_only "Due only"
instrument timer {
  fields { expiresAt: date; }
  lifecycle { states active; initial active; on create: active -> active; }
  action create { due { field: expiresAt; } steps: []; }
}`);
    const dueErrors = dueOnly.diagnostics.filter(
      ({ code }) => code === "HSX1509",
    );
    expect(dueErrors).toHaveLength(0);
  });
});

describe("cross instrument binding", () => {
  const TARGETS = `module catalog.targets
export instrument child {
  fields { parentId: ref<parent>; amount: money<SAR>; reason: text; }
  lifecycle { states open closed; initial open; }
  action create { steps: []; moves: []; }
}
export instrument limit {
  fields { cap: money<SAR>; }
  required: [cap];
  lifecycle { states open; initial open; }
  action create { steps: []; moves: []; }
}`;

  function check(source: string, targets = TARGETS) {
    const parsed = parseProgram(source);
    expect(parsed.diagnostics).toEqual([]);
    const resolved = resolveProgramModules(parsed.program, {
      resolveModule(specifier) {
        return specifier === "catalog/targets"
          ? { name: specifier, source: targets }
          : undefined;
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.issues[0]?.message);
    return checkGeneralProgram(resolved.program);
  }

  const ROOT = `program cross_binding "Cross binding"
import { child, limit } from "catalog/targets"
instrument parent {
  fields {
    targetAmount: money<SAR>;
    amount: money<SAR>;
    limitId: ref<limit>;
    settleBy: date;
  }
  lifecycle { states open closed; initial open; }
  aggregate_invariants: [{
    childField: "amount";
    childInstrumentId: "child";
    childRefField: "parentId";
    childStatuses: ["open"];
    parentField: "targetAmount";
  }];
  action create {
    steps: [];
    moves: [];
    reconcile: {
      amount: "fields.amount";
      capture: evidenceId;
      counterpartyRef: payoutId;
      currencyField: currency;
      direction: debit;
      evidence: statement_line;
      exception: { amountField: amount; childInstrumentId: child; maxOpen: 1; reasonField: reason; refField: parentId; };
      match: { law: exact; };
      within: { field: settleBy; };
    };
    requires_aggregate: [{
      check: { amountField: "amount"; kind: "sum_at_least"; targetField: "targetAmount"; };
      instrumentId: "child";
      over: "children";
      refField: "parentId";
      statuses: ["open"];
    }];
    requires_exposure: [{
      amountField: "amount";
      anchorField: "limitId";
      capField: "cap";
      capOnAnchor: true;
      childInstrumentId: "parent";
      statuses: ["open"];
    }];
    computes signed_sum {
      amountRef: "netAmount";
      onNegative: "refuse";
      onZero: "refuse";
      sources: [{
        amountField: "amount";
        instrumentId: "child";
        refField: "parentId";
        sign: "add";
        statuses: ["open"];
        subtotalRef: "childTotal";
      }];
    }
  }
}`;

  it("binds action and aggregate child fields after module resolution", () => {
    const checked = check(ROOT);
    expect(
      checked.diagnostics.filter(({ code }) => code === "HSX1007"),
    ).toEqual([]);
  });

  it("reports an unresolved action target at the authored clause", () => {
    const source = ROOT.replace(
      'instrumentId: "child";',
      'instrumentId: "missing";',
    );
    const checked = check(source);
    const diagnostic = checked.diagnostics.find(
      ({ code, message }) => code === "HSX1007" && message.includes("missing"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.span.end).toBeGreaterThan(diagnostic?.span.start ?? 0);
  });

  it("checks aggregate invariant fields on the imported child", () => {
    const checked = check(
      ROOT.replace('childField: "amount";', 'childField: "missingAmount";'),
    );
    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("child.missingAmount"),
      }),
    );
  });
});

describe("account lowering and port clause syntax", () => {
  it("lowers unannotated account<C> fields with the UDL2002 pattern", () => {
    const source = `program account_test "Account Test"
party client: person
instrument invoice {
  title: "Invoice";
  agent_description: "An invoice instrument for account lowering tests.";
  fields {
    clientAccountId: account<SAR>;
    amount: money<SAR>;
  }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: clientAccountId; }
  action create {
    agent_description: "Create an invoice.";
    steps: [];
  }
  action pay {
    agent_description: "Pay the invoice.";
    steps: []; moves: [];
  }
}`;
    const result = compile(source);
    expect(result.verdict).toBe("valid");
    const doc = documentOf(result);
    const invoice = doc?.instruments[0];
    expect(invoice?.fields.clientAccountId).toEqual({
      pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
      type: "string",
    });
  });

  it("lowers action-level port with allowed_parties syntax", () => {
    const source = `program port_test "Port Test"
party reviewer: person
instrument review {
  title: "Review";
  agent_description: "A review instrument for port syntax tests.";
  fields {}
  lifecycle { states created approved; initial created; on approve: created -> approved; }
  parties { approver: reviewer; }
  action create {
    agent_description: "Create a review.";
    steps: [];
  }
  action approve {
    agent_description: "Approve the review.";
    steps: [];
    port { allowed_parties: [approver]; }
  }
}`;
    const result = compile(source);
    expect(result.verdict).toBe("valid");
    const doc = documentOf(result);
    const review = doc?.instruments[0];
    expect(review?.actions.approve?.port?.allowedParties).toEqual(["approver"]);
  });

  it("diagnoses top-level port syntax inside an action clause as HSX1508", () => {
    const source = `program bad_port "Bad Port"
party reviewer: person
instrument review {
  fields {}
  lifecycle { states created; initial created; }
  action create {
    steps: [];
    port { allowed: [reviewer]; }
  }
}`;
    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    const diagnostic = result.diagnostics.find(
      ({ code }) => code === "HSX1508",
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.message).toContain("allowed_parties");
    expect(diagnostic?.fix).toContain("allowed_parties: [...]");
  });
});

describe("HSX diagnostic catalog", () => {
  it("raises every source-only example as its first error", () => {
    for (const diagnostic of hsxDiagnostics) {
      if (diagnostic.example === null) continue;
      const result =
        diagnostic.code === "HSX1301"
          ? compileHsx(diagnostic.example)
          : compile(diagnostic.example);
      const firstError = result.diagnostics.find(
        ({ severity }) => severity === "error",
      );

      expect(firstError?.code).toBe(diagnostic.code);
    }
  });
});
