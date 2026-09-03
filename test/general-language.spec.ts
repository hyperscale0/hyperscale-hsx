import { describe, expect, it } from "bun:test";
import { validateUdl, type UdlDocument } from "@hyperscale0/udl";
import { compile as compileHsx } from "../src/index.ts";
import { compile, testCostTable } from "./compile.ts";

const BASE = `program invoices "Invoices"
party buyer: person
instrument invoice {
  title: "Invoice";
  summary: "A payable invoice";
  id_prefix: "inv";
  fields { amount: money<SAR>; }
  lifecycle {
    states created paid;
    initial created;
    on pay: created -> paid;
  }
  parties { payer: buyer; }
  action create { summary: "Create an invoice"; steps: []; }
  action pay { summary: "Pay the invoice"; steps: []; moves: []; }
}`;

describe("general-form HSX", () => {
  it("refuses compilation without a cost table", () => {
    const result = compileHsx(BASE);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1301" }),
    );
  });

  it("emits canonical UDL directly with inferred account fields", () => {
    const result = compile(BASE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document;
    expect(validateUdl(document).ok).toBe(true);
    expect(document).toMatchObject({
      product: "invoices",
      udl: 1,
      instruments: [
        {
          id: "invoice",
          parties: { payer: "buyerAccountId" },
          lifecycle: {
            initial: "created",
            transitions: { pay: { from: ["created"], to: "paid" } },
          },
        },
      ],
    });
    expect(result.artifacts?.costManifest).toMatchObject({
      costTableVersion: testCostTable.version,
      declaredMeters: testCostTable.declaredMeters,
      effectiveTableDigest: testCostTable.effectiveTableDigest,
      monthlyEstimate: {
        variables: [
          "account.active_month",
          "financial_address.active_month",
          "financial_address.issued.count",
          "instrument.event.count",
          "instrument.event.volume_sar",
          "kyb.application.review",
          "payout.external.count",
          "payout.external.volume_sar",
          "verification.kyb.count",
          "verification.kyc.basic.count",
          "verification.kyc.investment.count",
          "verification.kyc.standard.count",
        ],
      },
    });
  });

  it("instantiates a currency-generic instrument without coercion", () => {
    const result = compile(`program bills "Bills"
party buyer: person
export instrument payable<C>(payer: party, amount: money<C>) {
  fields { amount: money<C>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: payer; }
  action create { steps: []; }
  action pay { steps: []; moves: []; }
}
instrument bill = payable<SAR>(payer: buyer, amount: SAR 5.00)`);
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [{ id: "bill", fields: { amount: { type: "string" } } }],
    });
  });

  it("lowers a two-argument money binding as a fixed field", () => {
    const source = (amount: number) => `program fixed_fees "Fixed fees"
party buyer: person
export instrument fixed_fee(fee: money<SAR>) {
  fields { fee: fee; }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}
instrument charge = fixed_fee(fee: platformFee: money(SAR, ${amount}))`;

    const fixed = compile(source(2500));
    expect(fixed.verdict).toBe("valid");
    expect(fixed.artifacts?.document).toMatchObject({
      instruments: [
        {
          fields: {
            platformFee: { const: "2500", type: "string" },
          },
        },
      ],
    });

    const changed = compile(source(5000));
    expect(changed.verdict).toBe("valid");
    expect(changed.artifacts?.document).not.toEqual(fixed.artifacts?.document);
  });

  it("refuses fixed money in a UDL slot that has no fixed-money shape", () => {
    const result = compile(
      BASE.replace('summary: "Create an invoice"', "summary: money(SAR, 2500)"),
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1104",
        message: expect.stringContaining("summary"),
      }),
    );
  });

  it("infers notification effects and prices the same facts", () => {
    const source = BASE.replace(
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; }',
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; notify buyer via email; }',
    );
    const result = compile(source, {
      costTable: {
        ...testCostTable,
        rows: [
          {
            bps: 0,
            meter: "instrument.event.count",
            payer: "product",
            perEventMinor: "7",
            settlement: "invoice",
            signature: "notifies.email",
          },
        ],
        version: "2026-09-01",
      },
    });
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: {
            pay: {
              effects: {
                notifies: [
                  {
                    channel: "email",
                    role: "buyer",
                    signature: "notifies.email",
                    source: "effects.notifies[0]",
                  },
                ],
              },
            },
          },
        },
      ],
    });
    expect(result.artifacts?.costManifest?.actions).toContainEqual(
      expect.objectContaining({
        action: "pay",
        perEventMinor: "7",
      }),
    );
  });

  it("refuses an effect absent from the versioned cost table", () => {
    const source = BASE.replace(
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; }',
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; notify buyer via sms; }',
    );
    const result = compile(source, {
      costTable: { ...testCostTable, rows: [], version: "empty" },
    });
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1301", stage: "typecheck" }),
    );
  });

  it("keeps the cost-table price and currency diagnostics stable", () => {
    const source = BASE.replace(
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; }',
      'action pay { summary: "Pay the invoice"; steps: []; moves: []; notify buyer via email; }',
    );
    const invalidPrice = compile(source, {
      costTable: {
        ...testCostTable,
        rows: [
          {
            bps: 0,
            meter: "instrument.event.count",
            payer: "product",
            perEventMinor: "1.5",
            settlement: "invoice",
            signature: "notifies.email",
          },
        ],
      },
    });
    expect(invalidPrice.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1302" }),
    );

    const invalidSettlement = compile(source, {
      costTable: {
        ...testCostTable,
        rows: [
          {
            bps: 0,
            meter: "instrument.event.count",
            payer: "product",
            perEventMinor: "1",
            settlement: "after_period" as "invoice",
            signature: "notifies.email",
          },
        ],
      },
    });
    expect(invalidSettlement.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1302" }),
    );

    const invalidCurrency = compile(BASE, {
      costTable: { ...testCostTable, currency: "sar" },
    });
    expect(invalidCurrency.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1303" }),
    );
  });

  it("reports currency mismatch and precision with stable fixes", () => {
    const mismatch = compile(`${BASE}\nconst fee: money<SAR> = USD 1.00`);
    expect(mismatch.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1101", stage: "typecheck" }),
    );

    const precision = compile(`${BASE}\nconst fee: money<SAR> = SAR 1.001`);
    expect(precision.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1102",
        fix: expect.stringContaining("2"),
      }),
    );
  });

  it("binds lifecycle names before UDL validation", () => {
    const result = compile(BASE.replace("created -> paid", "missing -> paid"));
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1001",
        message: expect.stringContaining("undeclared state missing"),
        stage: "bind",
      }),
    );
  });

  it("rejects clauses outside the targeted UDL vocabulary", () => {
    const result = compile(
      BASE.replace("steps: []; moves: [];", "steps: []; teleport: [];"),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1501" }),
    );
  });

  it("rejects unbounded iteration", () => {
    const result = compile(
      BASE.replace(
        "steps: []; moves: [];",
        "steps: []; while { condition: true; };",
      ),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1401" }),
    );
  });

  it("expands integer-bounded actions and lifecycle names before binding", () => {
    const result = compile(`program installments "Installments"
instrument plan {
  fields {}
  lifecycle {
    states created;
    initial created;
    for installment in 2 {
      states paid_[installment];
      on pay_[installment]: created -> paid_[installment];
    }
  }
  action create { steps: []; }
  for installment in 2 {
    action pay_[installment] {
      summary: "Pay installment {installment}";
      steps: [];
    }
  }
}`);

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(document.instruments[0]).toMatchObject({
      actions: {
        pay_1: { summary: "Pay installment 1" },
        pay_2: { summary: "Pay installment 2" },
      },
      lifecycle: {
        states: ["created", "paid_1", "paid_2"],
      },
    });
  });

  it("expands a literal list parameter", () => {
    const result = compile(`program batches "Batches"
export instrument batch(names: list<text>) {
  fields {}
  lifecycle {
    states created;
    initial created;
    for name in names { on run_[name]: created -> created; }
  }
  action create { steps: []; }
  for name in names {
    action run_[name] { steps: []; }
  }
}
instrument daily = batch(names: [alpha, beta])`);

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(document.instruments[0]?.actions).toMatchObject({
      run_alpha: {},
      run_beta: {},
    });
  });

  it("uses bound field names and types in finite construction", () => {
    const result = compile(`program meters "Meters"
export instrument meter<C>(rates: block) {
  fields {
    for item in keys(rates) {
      rate_[item]: get(rates, item);
    }
  }
  lifecycle {
    states created;
    initial created;
    for item in keys(rates) {
      on record_[item]: created -> created;
    }
  }
  action create { steps: []; }
  for item in keys(rates) {
    action record_[item] {
      summary: concat("Record ", get(rates, item));
      steps: [];
    }
  }
}
instrument usage = meter<SAR>(rates: {
  api_calls: apiAmount: money<SAR>;
  storage: storageAmount: money<SAR>;
})`);

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: {
            record_api_calls: { summary: "Record apiAmount" },
            record_storage: { summary: "Record storageAmount" },
          },
          fields: {
            rateApiCalls: { type: "string" },
            rateStorage: { type: "string" },
          },
        },
      ],
    });
  });

  it("keeps quoted object keys and reference move paths exact", () => {
    const result = compile(`program pools "Pools"
instrument pool {
  fields { amount: money<SAR>; }
  lifecycle {
    states created moved;
    initial created;
    on move: created -> moved;
  }
  action create {
    steps: [{ operation: "account.escrow.provision", bind: {
      "owner.id": { from: "instance", path: "instrumentInstanceId" }
    }}];
  }
  action move {
    moves: [{ amount: "refs.share", from: "refs.escrowAccountId", to: "refs.destinationAccountId" }];
  }
}`);

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: {
            create: { steps: [{ bind: { "owner.id": { from: "instance" } } }] },
            move: {
              moves: [
                {
                  bind: {
                    amount: { path: "refs.share" },
                    destinationAccountId: { path: "refs.destinationAccountId" },
                    sourceAccountId: { path: "refs.escrowAccountId" },
                  },
                },
              ],
            },
          },
        },
      ],
    });
  });

  it("expands dynamic lifecycle actions and preserves explicit required order", () => {
    const result = compile(`program snapshots "Snapshots"
export instrument snapshotter(names: list<text>) {
  fields { first: text; second: text; }
  required: [second, first];
  lifecycle {
    states open done;
    initial open;
    for item in names {
      on [item]: open -> done;
    }
  }
  action create { steps: []; }
  for item in names {
    action [item] { steps: []; }
  }
}
instrument snapshots = snapshotter(names: [snapshot])`);

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          actions: { snapshot: {} },
          lifecycle: {
            transitions: { snapshot: { from: ["open"], to: "done" } },
          },
          required: ["second", "first"],
        },
      ],
    });
  });

  it.each([
    ["a scalar", "second", "required must be a list of field names"],
    [
      "a mixed list",
      "[second, 1]",
      "required contains a value that is not a field name",
    ],
    [
      "a duplicate field",
      "[second, second]",
      "required names second more than once",
    ],
    ["an unknown field", "[missing]", "required names unknown field missing"],
    [
      "an optional field",
      "[optionalMemo]",
      "required names optional field optionalMemo",
    ],
  ])("rejects %s in required", (_, required, message) => {
    const result = compile(`program snapshots "Snapshots"
instrument snapshot {
  fields {
    first: text;
    second: text;
    optionalMemo: { type: text; optional: true; };
  }
  required: ${required};
  lifecycle { states open; initial open; }
  action create { steps: []; }
}`);

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1023", message }),
    );
  });

  it("expands a finite list into companion instruments", () => {
    const result = compile(`program rosters "Rosters"
export instrument roster(names: list<text>) {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
  instruments {
    for name in names {
      instrument {
        id: concat(instrument, "_", name);
        generatedPrefix: true;
        fields {}
        lifecycle {
          states created complete;
          initial created;
          on complete: created -> complete;
        }
        action create { steps: []; }
        action complete { steps: []; }
      }
    }
  }
}
instrument team = roster(names: [alpha, beta])`);

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(
      document.instruments.map((instrument) => [
        instrument.id,
        instrument.idPrefix,
      ]),
    ).toEqual([
      ["team", "team"],
      ["team_alpha", "zzaa"],
      ["team_beta", "zzab"],
    ]);
  });

  it("refuses runtime and oversized comprehension bounds with stable codes", () => {
    const runtime = compile(`program runtime_bound "Runtime bound"
export instrument batch(count: integer) {
  fields { count: integer; }
  lifecycle { states created; initial created; }
  action create { steps: []; }
  for item in count { action run_[item] { steps: []; } }
}
instrument daily = batch(count: runtimeCount: integer)`);
    expect(runtime.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1403", stage: "typecheck" }),
    );

    const oversized = compile(`program oversized "Oversized"
instrument batch {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
  for item in 257 { action run_[item] { steps: []; } }
}`);
    expect(oversized.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1404", stage: "typecheck" }),
    );
  });

  it("reports unconsumed and duplicated computed money", () => {
    const unconsumed = compile(
      BASE.replace(
        "steps: []; moves: [];",
        "steps: []; computes remainder rest { amount_ref: total; on_zero: refuse; total_path: fields.amount; };",
      ),
    );
    expect(unconsumed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1202",
        message: expect.stringContaining("rest"),
      }),
    );

    const duplicated = compile(
      BASE.replace(
        "steps: []; moves: [];",
        "steps: []; computes remainder rest { amount_ref: total; on_zero: refuse; total_path: fields.amount; }; moves: [{ amount: rest; }, { amount: rest; }];",
      ),
    );
    expect(duplicated.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1201",
        message: expect.stringContaining("2 times"),
      }),
    );

    const vocabularyNamed = compile(
      BASE.replace(
        "steps: []; moves: [];",
        "steps: []; computes distribute { amount_ref: payoutShare; on_zero: skip_steps; pool: { from: parent; path: fields.amount; }; ref_field: parentId; statuses: [ready]; weight_field: weight; }; moves: [];",
      ),
    );
    expect(vocabularyNamed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1202",
        message: expect.stringContaining("payoutShare"),
      }),
    );
  });

  it("binds cross-instrument ref targets and referenced money fields", () => {
    const missingRefType = compile(`program references "References"
instrument child {
  fields { parentId { type: ref; description: "Parent"; pattern: "^pare_(sandbox|live)_[a-z0-9]{8,64}$"; } }
  lifecycle { states created; initial created; }
  action create { steps: []; moves: []; }
}`);
    expect(missingRefType.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("without an instrument target"),
      }),
    );

    const missingTarget = compile(`program references "References"
instrument child {
  fields { parentId { type: ref<missing_parent>; description: "Missing parent"; pattern: "^miss_(sandbox|live)_[a-z0-9]{8,64}$"; } }
  lifecycle { states created; initial created; }
  action create { steps: []; moves: []; }
}`);
    expect(missingTarget.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("missing_parent"),
      }),
    );

    const wrongMoneyField = compile(`program references "References"
instrument parent {
  fields { total { type: money<SAR>; description: "Total"; pattern: "^[1-9][0-9]{0,17}$"; } }
  lifecycle { states open; initial open; }
  action create { steps: []; moves: []; }
  action close { requires aggregate { instrumentId: child; over: children; refField: parentId; statuses: [created]; check: { kind: sum_exactly; amountField: label; targetField: total; } }; steps: []; moves: []; }
}
instrument child {
  fields { parentId { type: ref<parent>; description: "Parent"; pattern: "^pare_(sandbox|live)_[a-z0-9]{8,64}$"; } label { type: text; description: "Not money"; } }
  lifecycle { states created; initial created; }
  action create { steps: []; moves: []; }
}`);
    expect(wrongMoneyField.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1007",
        message: expect.stringContaining("child.label is not declared money"),
      }),
    );
  });
});
