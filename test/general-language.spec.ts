import { describe, expect, it } from "bun:test";
import { serializeUdl, validateUdl, type UdlDocument } from "@hyperscale0/udl";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Program } from "../src/ast.ts";
import type { JsonValue } from "../src/ir.ts";
import { format } from "../src/format.ts";
import { emitUdlClause, lowerGeneralProgram } from "../src/emit.ts";
import {
  checkGeneralProgram,
  compile as compileHsx,
  parseProgram,
} from "../src/index.ts";
import type { StandardLibrary } from "../src/std-library.ts";
import { compile, testCostTable } from "./compile.ts";

const BASE = `program invoices "Invoices"
party buyer: person
instrument invoice {
  title: "Invoice";
  summary: "A payable invoice";
  id_prefix: "inv";
  agent_description: "A payable invoice instrument for general language tests.";
  fields { amount: money<SAR>; }
  lifecycle {
    states created paid;
    initial created;
    on pay: created -> paid;
  }
  parties { payer: buyer; }
  action create {
    agent_description: "Create an invoice for the buyer.";
    summary: "Create an invoice";
    steps: [];
  }
  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
  }
}`;

describe("general-form HSX", () => {
  it("refuses the retired catalog composition option", () => {
    const options = {
      costTable: testCostTable,
      composesCatalogBlueprint: true,
    };
    const result = compileHsx(BASE, options);
    expect(result).toMatchObject({
      verdict: "invalid",
      diagnostics: [
        expect.objectContaining({
          message: "unknown compile option composesCatalogBlueprint",
        }),
      ],
    });
  });

  it("refuses the retired blueprint cost weight", () => {
    const result = compileHsx(BASE, {
      costTable: {
        ...testCostTable,
        fixed: {
          ...testCostTable.fixed,
          weights: { ...testCostTable.fixed.weights, blueprint: 5 },
        },
      },
    });
    expect(result).toMatchObject({
      verdict: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "HSX1302",
          message: `cost table ${testCostTable.version} has an unknown blueprint complexity weight`,
        }),
      ],
    });
  });

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
  agent_description: "A payable instrument for currency generic tests.";
  fields { amount: money<C>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: payer; }
  action create {
    agent_description: "Create a payable instance.";
    steps: [];
  }
  action pay {
    agent_description: "Pay the payable instance.";
    steps: []; moves: [];
  }
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
  agent_description: "A fixed fee instrument.";
  fields { fee: fee; }
  lifecycle { states created; initial created; }
  action create {
    agent_description: "Create a fixed fee.";
    steps: [];
  }
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
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
  }`,
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
    notify buyer via email;
  }`,
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
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
  }`,
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
    notify buyer via sms;
  }`,
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
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
  }`,
      `  action pay {
    agent_description: "Pay the invoice.";
    summary: "Pay the invoice";
    steps: []; moves: [];
    notify buyer via email;
  }`,
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
  agent_description: "Installment payment plan.";
  fields {}
  lifecycle {
    states created;
    initial created;
    for installment in 2 {
      states paid_[installment];
      on pay_[installment]: created -> paid_[installment];
    }
  }
  action create { agent_description: "Create plan."; steps: []; }
  for installment in 2 {
    action pay_[installment] {
      agent_description: "Pay installment.";
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
  agent_description: "Batch execution plan.";
  fields {}
  lifecycle {
    states created;
    initial created;
    for name in names { on run_[name]: created -> created; }
  }
  action create { agent_description: "Create batch."; steps: []; }
  for name in names {
    action run_[name] { agent_description: "Run batch item."; steps: []; }
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
  agent_description: "Usage meter for tracking item rates.";
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
  action create { agent_description: "Create meter."; steps: []; }
  for item in keys(rates) {
    action record_[item] {
      agent_description: "Record usage for item.";
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
  agent_description: "Escrow pool holding funds.";
  fields { amount: money<SAR>; }
  lifecycle {
    states created moved;
    initial created;
    on move: created -> moved;
  }
  action create {
    agent_description: "Provision the escrow pool.";
    steps: [{ operation: "account.escrow.provision", bind: {
      "owner.id": { from: "instance", path: "instrumentInstanceId" }
    }}];
  }
  action move {
    agent_description: "Move shares from the escrow pool.";
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
  agent_description: "Snapshot taker for recorded items.";
  fields { first: text; second: text; }
  required: [second, first];
  lifecycle {
    states open done;
    initial open;
    for item in names {
      on [item]: open -> done;
    }
  }
  action create { agent_description: "Create snapshotter."; steps: []; }
  for item in names {
    action [item] { agent_description: "Capture snapshot item."; steps: []; }
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
  agent_description: "Snapshot test instrument.";
  fields {
    first: text;
    second: text;
    optionalMemo: { type: text; optional: true; };
  }
  required: ${required};
  lifecycle { states open; initial open; }
  action create { agent_description: "Create snapshot."; steps: []; }
}`);

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1023", message }),
    );
  });

  it("expands a finite list into companion instruments", () => {
    const result = compile(`program rosters "Rosters"
export instrument roster(names: list<text>) {
  agent_description: "Team roster tracking member companions.";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create team roster."; steps: []; }
  instruments {
    for name in names {
      instrument {
        agent_description: "Companion member instrument.";
        id: concat(instrument, "_", name);
        generatedPrefix: true;
        fields {}
        lifecycle {
          states created complete;
          initial created;
          on complete: created -> complete;
        }
        action create { agent_description: "Create companion member."; steps: []; }
        action complete { agent_description: "Complete companion member."; steps: []; }
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

function withoutSpans(value: Program): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === "span" ? undefined : item)),
  );
}

const SRC_ROOT = resolve(import.meta.dir, "../src");

function stripCommentsAndNonImportStrings(source: string): string {
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  cleaned = cleaned.replace(/\/\/.*$/gm, "");
  const stringRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  cleaned = cleaned.replace(stringRegex, (match, offset, fullText) => {
    const prefix = fullText.slice(0, offset).trimEnd();
    if (
      /\bfrom$/.test(prefix) ||
      /\bimport$/.test(prefix) ||
      /\bimport\s*\($/.test(prefix)
    ) {
      return match;
    }
    return '""';
  });
  return cleaned;
}

function findNodeImports(content: string): readonly string[] {
  const cleaned = stripCommentsAndNonImportStrings(content);
  const patterns = [
    /\bfrom\s*["'](node:[^"']+)["']/g,
    /\bimport\s*["'](node:[^"']+)["']/g,
    /\bimport\s*\(\s*["'](node:[^"']+)["']\s*\)/g,
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  return matches;
}

function extractRelativeSpecifiers(content: string): readonly string[] {
  const cleaned = stripCommentsAndNonImportStrings(content);
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const relativeSpecifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const specifier = match[1];
      if (
        specifier &&
        (specifier.startsWith("./") || specifier.startsWith("../"))
      ) {
        relativeSpecifiers.push(specifier);
      }
    }
  }
  return relativeSpecifiers;
}

function collectSourceFiles(dir: string): readonly string[] {
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (stat.isFile() && entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const catalogSource = `program published_catalog "Published catalog"
instrument parent {
  agent_description: "Parent instrument managing limits.";
  title: "Parent";
  summary: "A parent record";
  id_prefix: "par";
  fields { limitAmount: money<SAR>; memo: text; }
  lifecycle { states open closed; initial open; on close: open -> closed; }
  action create { agent_description: "Create parent."; summary: "Create parent"; steps: []; }
  action close { agent_description: "Close parent."; summary: "Close parent"; steps: []; moves: []; }
}
instrument child {
  agent_description: "Child instrument referencing a parent.";
  title: "Child";
  summary: "A child record";
  id_prefix: "chd";
  fields { parentId: text; amount: money<SAR>; }
  lifecycle { states open; initial open; }
  action create { agent_description: "Create child."; summary: "Create child"; steps: []; }
}`;

function catalog(): UdlDocument {
  const result = compile(catalogSource);
  expect(result.verdict).toBe("valid");
  const document = structuredClone(result.artifacts?.document) as UdlDocument;
  const parent = document.instruments.find(
    (instrument) => instrument.id === "parent",
  )!;
  const child = document.instruments.find(
    (instrument) => instrument.id === "child",
  )!;
  child.fields.parentId = {
    description: "Parent id",
    pattern: "^par_(sandbox|live)_[a-z0-9]{8,64}$",
    type: "string",
  };
  parent.aggregateInvariants = [
    {
      childField: "amount",
      childInstrumentId: "child",
      childRefField: "parentId",
      childStatuses: ["open"],
      parentField: "limitAmount",
    },
  ];
  parent.required = ["memo", "limitAmount"];
  parent.subject = { kinds: ["vehicle"] };
  document.subjects = [
    {
      declaredValue: "optional",
      kind: "vehicle",
      schema: { additionalProperties: false, properties: {}, type: "object" },
      title: "Vehicle",
      version: 1,
    },
  ];
  return document;
}

describe("instrument application metadata", () => {
  const appSource = (metadata: string) => `program applications "Applications"
export instrument mechanism() {
  agent_description: "Base mechanism instrument.";
  title: "Mechanism";
  summary: "Base mechanism";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create mechanism."; summary: "Create mechanism"; steps: []; }
}
instrument domain_name = mechanism() ${metadata}`;

  it("merges instrument and action metadata before lowering", () => {
    const result = compile(
      appSource(`{
        template_id: "escrow";
        title: "Domain name";
        summary: "Named application";
        nav: ["Products", "Named applications"];
        action create { summary: "Create domain name"; public: none; }
      }`),
    );

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "domain_name",
    );
    expect(instrument).toMatchObject({
      actions: { create: { summary: "Create domain name" } },
      id: "domain_name",
      nav: ["Products", "Named applications"],
      summary: "Named application",
      templateId: "escrow",
      title: "Domain name",
    });
    expect(instrument?.actions.create).not.toHaveProperty("publicAction");
  });

  it("lets an application author action examples", () => {
    const result = compile(
      appSource(`{
        action create {
          examples: [{ name: "create_domain"; input: {}; }];
        }
      }`),
    );

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "domain_name",
    );
    expect(instrument?.actions.create?.examples?.[0]?.name).toBe(
      "create_domain",
    );
  });

  it("refuses authored journeys metadata", () => {
    const result = compile(
      appSource(`{
        action create {
          examples: [{ name: "create_domain"; input: {}; }];
        }
        journeys: [{
          id: "domain_lifecycle";
          label: "Create a domain";
          summary: "Create one domain.";
          steps: [{ id: "domain"; operation: "domain_name.create"; example: "create_domain"; bind: {}; }];
        }];
      }`),
    );
    expect(result).toMatchObject({
      verdict: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("journeys"),
        }),
      ]),
    });
  });

  it("rejects mechanics in an application metadata block", () => {
    const result = compile(appSource("{ fields: { amount: money<SAR>; }; }"));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1507" }),
    );
  });

  it("replaces inherited metadata across accepted alias spellings", () => {
    const result = compile(`program aliases "Aliases"
export instrument mechanism() {
  agent_description: "Base mechanism for alias tests.";
  nav: ["Mechanisms"];
  surface_visibility: internal;
  fields {}
  lifecycle { states created; initial created; }
  action create {
    agent_description: "Create mechanism.";
    public_action: "createMechanism";
    steps: [];
  }
}
instrument domain_name = mechanism() {
  navigation: ["Domains"];
  visibility: public;
  action create { public: none; }
}`);

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "domain_name",
    );
    expect(instrument?.nav).toEqual(["Domains"]);
    expect(instrument?.surfaceVisibility).toBe("public");
    expect(instrument?.actions.create).not.toHaveProperty("publicAction");
  });
});

describe("format", () => {
  it("formats settlement sugar into the canonical instrument application", () => {
    const source = `program market "Market"
      import{held_payment,security_deposit}from"std/money_flows"
      party buyer:person{country:"SA"}
      asset vehicle:good{title_transfer:off_platform}
      settlement sale=held_payment{payer:buyer payee:seller amount:price:money(SAR) on_cancel(funded){return_to:buyer}}
      port confirm_handover{allowed:[buyer,seller]}`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `program market "Market";
import { held_payment, security_deposit } from "std/money_flows";
party buyer: person {
  country: "SA";
}
asset vehicle: good {
  title_transfer: off_platform;
}
instrument sale = held_payment(payer: buyer, payee: seller, amount: price: money(SAR), on_cancel: {
  return_to: buyer;
});
port confirm_handover {
  allowed: [buyer, seller];
}
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected formatting to succeed");
    expect(withoutSpans(parseProgram(result.formatted).program)).toEqual(
      withoutSpans(parseProgram(source).program),
    );
  });

  it("formats general instruments with canonical clause spacing", () => {
    const source = `module std.payments
      export type Currency=SAR
      export const fee:bps=25
      export instrument held_payment<C>(payer:party,payee:party,amount:money<C>){
        fields{amount:stored_amount:money<C>}
        lifecycle{states draft funded released;initial draft;parked draft reason "awaiting funds";on fund:draft->funded;on release:funded|draft->released}
        parties{payer:payer payee:payee}
        action fund{requires refs:[payer] computes remainder{from:amount} notify payee via sms moves{amount:amount}}
      }
      export instrument sale=std.payments.held_payment<SAR>(buyer,seller,SAR 500.00)`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `module std.payments;
export type Currency = SAR;
export const fee: bps = 25;
export instrument held_payment<C>(payer: party, payee: party, amount: money<C>) {
  fields {
    amount: stored_amount: money<C>;
  }
  lifecycle {
    states draft funded released;
    initial draft;
    parked draft reason "awaiting funds";
    on fund: draft -> funded;
    on release: funded | draft -> released;
  }
  parties {
    payer: payer;
    payee: payee;
  }
  action fund {
    requires refs: [payer];
    computes remainder {
      from: amount;
    }
    notify payee via sms;
    moves {
      amount: amount;
    }
  }
}
export instrument sale = std.payments.held_payment<SAR>(buyer, seller, SAR 500.00);
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected formatting to succeed");
    expect(withoutSpans(parseProgram(result.formatted).program)).toEqual(
      withoutSpans(parseProgram(source).program),
    );
  });

  it("is idempotent", () => {
    const first = format(
      `instrument transfer{lifecycle{states ready done;initial ready;on send:ready->done}action send{notify payee via webhook}}`,
    );
    if (!first.ok) throw new Error("expected first formatting pass to succeed");

    expect(format(first.formatted)).toEqual(first);
  });

  it("retains leading, trailing, and nested line comments", () => {
    const source = `// Product identity
program market "Market" // stable public name
instrument transfer { // lifecycle follows
  // One bounded transition
  lifecycle { states ready done; initial ready; on send: ready -> done }
  action send { notify payee via webhook } // priced effect
}
// End of file
`;

    const result = format(source);

    expect(result).toEqual({
      formatted: `// Product identity
program market "Market"; // stable public name
instrument transfer {
  // lifecycle follows
  // One bounded transition
  lifecycle {
    states ready done;
    initial ready;
    on send: ready -> done;
  }
  action send {
    notify payee via webhook;
  } // priced effect
}
// End of file
`,
      ok: true,
    });
    if (!result.ok) throw new Error("expected comment formatting to succeed");
    expect(format(result.formatted)).toEqual(result);
  });

  it("formats bounded comprehensions and indexed names", () => {
    const result = format(
      `instrument schedule{for installment in 3{action pay_[installment]{summary:"Pay {installment}" steps:[]}}}`,
    );

    expect(result).toEqual({
      formatted: `instrument schedule {
  for installment in 3 {
    action pay_[installment] {
      summary: "Pay {installment}";
      steps: [];
    }
  }
}
`,
      ok: true,
    });
  });

  it("returns parser diagnostics without printing a partial program", () => {
    const result = format("instrument broken {");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected formatting to fail");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("block never closes");
  });
});

describe("node-free compiler core", () => {
  it("detects the three real node: import forms and ignores comments and strings", () => {
    expect(findNodeImports(`import { readFileSync } from "node:fs";`)).toEqual([
      "node:fs",
    ]);
    expect(findNodeImports(`export { resolve } from "node:path";`)).toEqual([
      "node:path",
    ]);

    expect(findNodeImports(`import "node:crypto";`)).toEqual(["node:crypto"]);
    expect(findNodeImports(`  import 'node:events';`)).toEqual(["node:events"]);

    expect(findNodeImports(`const os = await import("node:os");`)).toEqual([
      "node:os",
    ]);
    expect(findNodeImports(`const p = import('node:perf_hooks');`)).toEqual([
      "node:perf_hooks",
    ]);

    expect(findNodeImports(`// import { x } from "node:fs";`)).toEqual([]);
    expect(findNodeImports(`// import "node:crypto";`)).toEqual([]);
    expect(findNodeImports(`/* import("node:os"); */`)).toEqual([]);
    expect(
      findNodeImports(
        `/*\n * Comment mentioning node:path and from "node:path"\n */`,
      ),
    ).toEqual([]);

    expect(
      findNodeImports(`const msg = "we do not use node:fs here";`),
    ).toEqual([]);
    expect(
      findNodeImports(`const raw = "import 'node:fs'; from 'node:path'";`),
    ).toEqual([]);
  });

  it("contains no node: specifiers outside src/cli.ts and src/lsp", () => {
    const allFiles = collectSourceFiles(SRC_ROOT);
    const nonCliFiles = allFiles.filter((filePath) => {
      const rel = relative(SRC_ROOT, filePath);
      return (
        rel !== "cli.ts" && !rel.startsWith("lsp/") && !rel.startsWith("lsp\\")
      );
    });

    const violations: string[] = [];
    for (const file of nonCliFiles) {
      const content = readFileSync(file, "utf8");
      const found = findNodeImports(content);
      if (found.length > 0) {
        violations.push(`${relative(SRC_ROOT, file)}: ${found.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("walks the import graph from src/index.ts and reaches zero node: specifiers", () => {
    const entry = join(SRC_ROOT, "index.ts");
    const visited = new Set<string>();
    const queue = [entry];
    const nodeViolations: string[] = [];

    while (queue.length > 0) {
      const currentFile = queue.shift()!;
      if (visited.has(currentFile)) continue;
      visited.add(currentFile);

      const content = readFileSync(currentFile, "utf8");
      const nodeImports = findNodeImports(content);
      if (nodeImports.length > 0) {
        nodeViolations.push(
          `${relative(SRC_ROOT, currentFile)}: ${nodeImports.join(", ")}`,
        );
      }

      const relativeSpecifiers = extractRelativeSpecifiers(content);
      const currentDir = dirname(currentFile);
      for (const specifier of relativeSpecifiers) {
        let resolved = resolve(currentDir, specifier);
        if (!resolved.endsWith(".ts")) {
          resolved += ".ts";
        }
        if (!visited.has(resolved) && !queue.includes(resolved)) {
          queue.push(resolved);
        }
      }
    }

    expect(visited.size).toBeGreaterThan(5);
    expect(nodeViolations).toEqual([]);
  });

  it("permits a custom StandardLibrary host override", () => {
    const customStandardLibrary: StandardLibrary = {
      source(specifier: string, name: string): string | undefined {
        if (specifier === "std/money_flows" && name === "custom_witness") {
          return `module std.money_flows.custom_witness
export instrument custom_witness {
  agent_description: "Custom witness test instrument.";
  title: "Custom";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create custom witness."; moves: []; steps: []; }
}`;
        }
        return undefined;
      },
    };

    const source = `program custom_test "Custom Test"
import { custom_witness } from "std/money_flows"
`;

    const result = compile(source, {
      standardLibrary: customStandardLibrary,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
  });
});

describe("published program composition", () => {
  it("parses and formats the closed composition declarations", () => {
    const source = `program marketplace "Marketplace"
use parent
expose parent.close as closeMarketplace`;
    const parsed = parseProgram(source);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.program.decls.map((decl) => decl.kind)).toEqual([
      "program",
      "use",
      "expose",
    ]);
    expect(format(source)).toEqual({
      formatted: `program marketplace "Marketplace";
use parent;
expose parent.close as closeMarketplace;
`,
      ok: true,
    });
  });

  it("admits reserved words as published action names", () => {
    const parsed = parseProgram(
      'program marketplace "Marketplace"\nuse parent\nexpose parent.quote as quoteMarketplace',
    );

    expect(parsed.diagnostics).toEqual([]);
  });

  it("copies published instruments with dependency closure and public names", () => {
    const source = `program marketplace "Marketplace"
use parent
expose parent.close as closeMarketplace`;
    const result = compile(source, { publishedCatalog: catalog() });

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(document.instruments.map((instrument) => instrument.id)).toEqual([
      "parent",
      "child",
    ]);
    expect(document.instruments[0]?.actions.close?.publicAction).toBe(
      "closeMarketplace",
    );
    expect(document.instruments[0]?.actions.create).not.toHaveProperty(
      "publicAction",
    );
    expect(document.instruments[0]?.actionOrder).toEqual(["create", "close"]);
    expect(document.instruments[0]?.required).toEqual(["memo", "limitAmount"]);
    expect(document.subjects.map((subject) => subject.kind)).toEqual([
      "vehicle",
    ]);
    expect(serializeUdl(document)).toContain('"childInstrumentId": "child"');

    const useStart = source.indexOf("use parent");
    const exposeStart = source.indexOf("expose parent.close");
    expect(result.artifacts?.originMap).toContainEqual(
      expect.objectContaining({
        path: "$.instruments[0]",
        span: expect.objectContaining({ start: useStart }),
      }),
    );
    expect(result.artifacts?.originMap).toContainEqual(
      expect.objectContaining({
        path: "$.instruments[0].actions.close",
        span: expect.objectContaining({ start: exposeStart }),
      }),
    );
  });

  it("keeps proprietary metadata outside the composed UDL", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
const company_notes = { rank: 1; label: "example"; }
expose parent.close as closeMarketplace`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).not.toHaveProperty("company_notes");
  });

  it("merges authored subjects after catalog subjects", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
subject shipment {
  title: "Shipment";
  version: 1;
  declared_value: none;
  schema: { type: "object"; properties: {}; additionalProperties: false; };
}`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("HSX program emitted no artifacts");
    expect(
      (result.artifacts.document as UdlDocument).subjects.map(
        (subject) => subject.kind,
      ),
    ).toEqual(["vehicle", "shipment"]);
  });

  it("rejects an authored subject already supplied by the catalog", () => {
    const result = compile(
      `program marketplace "Marketplace"
use parent
subject vehicle {
  title: "Vehicle";
  version: 1;
  declared_value: optional;
  schema: { type: "object"; properties: {}; additionalProperties: false; };
}`,
      { publishedCatalog: catalog() },
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1008" }),
    );
  });

  it("requires a catalog when a program uses published composition forms", () => {
    const result = compile(
      'program marketplace "Marketplace"\nuse parent\nexpose parent.close as closeMarketplace',
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1018" }),
    );
  });

  it.each([
    {
      code: "HSX1015",
      source: "program marketplace\nuse parent",
    },
    {
      code: "HSX1016",
      source: 'program marketplace "Marketplace"',
    },
    {
      code: "HSX1017",
      source: 'program marketplace "Marketplace"\nuse parent\nuse parent',
    },
    {
      code: "HSX1018",
      source: 'program marketplace "Marketplace"\nuse missing',
    },
    {
      code: "HSX1020",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.close as NotCamel',
    },
    {
      code: "HSX1020",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.create as closeMarketplace\nexpose parent.close as closeMarketplace',
    },
    {
      code: "HSX1021",
      source:
        'program marketplace "Marketplace"\nuse parent\nexpose parent.missing as closeMarketplace',
    },
    {
      code: "HSX1022",
      source: `program marketplace "Marketplace"
use parent
instrument parent { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }`,
    },
  ])("reports $code for an invalid composed program", ({ code, source }) => {
    const result = compile(source, { publishedCatalog: catalog() });

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code }),
    );
  });

  it("compiles a mixed program with authored and published instruments", () => {
    const source = `program marketplace "Marketplace"
use parent
instrument local {
  agent_description: "Local instrument.";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create local."; steps: []; }
}
expose parent.close as closeMarketplace
expose local.create as openLocal`;
    const result = compile(source, { publishedCatalog: catalog() });

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument;
    expect(document.instruments.map((instrument) => instrument.id)).toEqual([
      "parent",
      "child",
      "local",
    ]);
    expect(document.instruments[0]?.actions.close?.publicAction).toBe(
      "closeMarketplace",
    );
    expect(document.instruments[2]?.actions.create?.publicAction).toBe(
      "openLocal",
    );
  });

  it("does not limit how many published instruments a program uses", () => {
    const source = `program published_catalog "Published catalog"
${Array.from(
  { length: 10 },
  (_, index) => `instrument item_${index} {
  agent_description: "Catalog item ${index}.";
  id_prefix: "i${String.fromCharCode(97 + index)}x";
  fields {}
  lifecycle { states open; initial open; }
  action create { agent_description: "Create item ${index}."; steps: []; }
}`,
).join("\n")}`;
    const catalogResult = compile(source);
    expect(catalogResult.verdict).toBe("valid");
    const publishedCatalog = catalogResult.artifacts?.document as
      | UdlDocument
      | undefined;
    if (!publishedCatalog) throw new Error("expected compiled catalog");

    const result = compile(
      `program marketplace "Marketplace"
${Array.from({ length: 10 }, (_, index) => `use item_${index}`).join("\n")}`,
      { publishedCatalog },
    );

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document.instruments).toHaveLength(10);
  });

  it("refuses JSON at the parse boundary", () => {
    const result = compile('{ "hsx": 1, "product": "marketplace" }', {
      publishedCatalog: catalog(),
    });

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1014",
        message: "JSON is not HSX",
        stage: "parse",
      }),
    );
  });
});

describe("public action omission", () => {
  const omitSource = (
    actionBody: string,
  ) => `program private_actions "Private actions"
instrument private_job {
  agent_description: "Private job execution.";
  fields {}
  lifecycle { states created complete; initial created; on finish: created -> complete; }
  action create { agent_description: "Create private job."; steps: []; }
  action finish { agent_description: "Finish private job."; ${actionBody}; steps: []; moves: []; }
}`;

  it("consumes public: none before default public-action synthesis", () => {
    const result = compile(omitSource("public: none"));

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    expect(document?.instruments[0]?.actions.finish).not.toHaveProperty(
      "publicAction",
    );
  });

  it("rejects an opt-out combined with a public name", () => {
    const result = compile(
      omitSource("public: none; public_action: finishPrivateJob"),
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1506" }),
    );
  });
});

describe("subject declarations", () => {
  it("lowers the complete UDL subject document", () => {
    const result = compile(`program vehicles "Vehicles"
subject vehicle {
  title: "Vehicle";
  version: 2;
  declared_value: required;
  schema: {
    type: "object";
    additionalProperties: false;
    properties: {
      vin: { type: "string"; minLength: 11; maxLength: 17; };
      "policy_number": { type: "string"; };
    };
    required: ["vin", "policy_number"];
  };
}
instrument listing {
  agent_description: "Vehicle listing.";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create listing."; steps: []; }
}`);

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      subjects: [
        {
          declaredValue: "required",
          kind: "vehicle",
          schema: {
            additionalProperties: false,
            properties: {
              policy_number: { type: "string" },
              vin: { maxLength: 17, minLength: 11, type: "string" },
            },
            required: ["vin", "policy_number"],
            type: "object",
          },
          title: "Vehicle",
          version: 2,
        },
      ],
    });
  });

  it("reports an incomplete subject at its declaration", () => {
    const result = compile(`program broken "Broken"
subject vehicle { title: "Vehicle"; }
instrument listing { agent_description: "Vehicle listing."; fields {}; lifecycle { states created; initial created; }; action create { agent_description: "Create listing."; steps: []; }; }`);

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1008", line: 2 }),
    );
  });
});

describe("update state lists", () => {
  it("keeps lifecycle shorthand inside lifecycle blocks", () => {
    const result = compile(`program records "Records"
instrument record {
  agent_description: "Record instrument.";
  title: "Record";
  summary: "A record";
  id_prefix: "rec";
  fields { memo: string; }
  lifecycle {
    states draft final;
    initial draft;
    on finalize: draft -> final;
  }
  update {
    fields: ["memo"];
    states: ["draft"];
  }
  action create { agent_description: "Create record."; summary: "Create a record"; steps: []; }
  action finalize { agent_description: "Finalize record."; summary: "Finalize a record"; steps: []; moves: []; }
}`);

    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          lifecycle: {
            initial: "draft",
            states: ["draft", "final"],
            transitions: {
              finalize: { from: ["draft"], to: "final" },
            },
          },
          update: { fields: ["memo"], states: ["draft"] },
        },
      ],
    });
  });
});

describe("published catalog checking for modules and headerless programs", () => {
  it("returns typed program for modules and diagnostics for headerless files with publishedCatalog", () => {
    const publishedCatalog = catalog();

    const moduleParsed = parseProgram(`module custom.record;
instrument custom_record {
  agent_description: "Custom record module.";
  fields {}
  lifecycle { states created; initial created; }
  action create { agent_description: "Create custom record."; steps: []; }
}`);
    const moduleResult = checkGeneralProgram(moduleParsed.program, {
      publishedCatalog,
    });
    expect(moduleResult.diagnostics).toEqual([]);
    expect(moduleResult.program).toMatchObject({
      instruments: [expect.objectContaining({ id: "custom_record" })],
      kind: "typed_program",
      name: "record",
    });

    const headerlessParsed = parseProgram(`instrument floating_record {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`);
    const headerlessResult = checkGeneralProgram(headerlessParsed.program, {
      publishedCatalog,
    });
    expect(headerlessResult.program).toBeUndefined();
    expect(headerlessResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1000",
        message: "this file needs one program header or one module declaration",
      }),
    );
  });
});

describe("security deposit return port", () => {
  it("compiles return port with shape and allowed party to return action with required shape keys and mapped role", () => {
    const source = `program deposit_program "Deposit program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: [seller]
  shape { inspectionNotes: text }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);

    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "inspection_hold",
    );
    expect(instrument).toBeDefined();

    const returnAction = instrument?.actions.pass_inspection;
    expect(returnAction).toBeDefined();
    expect(returnAction?.input?.required).toEqual(["inspectionNotes"]);
    expect(returnAction?.port?.allowedParties).toEqual(["beneficiary"]);
  });

  it("normalizes a scalar allowed port party into a list without inverting its role", () => {
    const source = `program deposit_program "Deposit program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: buyer
  shape { inspectionNotes: text }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);

    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "inspection_hold",
    );
    expect(instrument).toBeDefined();

    const returnAction = instrument?.actions.pass_inspection;
    expect(returnAction).toBeDefined();
    expect(returnAction?.input?.required).toEqual(["inspectionNotes"]);
    expect(returnAction?.port?.allowedParties).toEqual(["payer"]);
  });

  it("binds a scheduled decision port to its non-paying debtor", () => {
    const source = `program installment_obligation "Installment obligation"
import { scheduled } from "std/money_flows"

party debtor_party: person
party repayment_source: business
party settlement_recipient: business

settlement obligation = scheduled {
  mode: obligation
  payer: repayment_source
  payee: settlement_recipient
  debtor: debtor_party
  amount: periodAmount: money(SAR)
  every: P1M
  first_due: firstDueAt
  until: port cancel_period
  month_end: clamp_to_last_day
  period_liability: one_open
  termination_drain: cancel_period
}

port cancel_period {
  allowed: [debtor_party]
  shape: { terminateAt: date }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document.instruments).toContainEqual(
      expect.objectContaining({
        id: "obligation",
        parties: expect.objectContaining({
          debtor_party: "debtorPartyAccountId",
        }),
        actions: expect.objectContaining({
          cancel_period: expect.objectContaining({
            port: { allowedParties: ["debtor_party"] },
          }),
        }),
      }),
    );
  });

  it("binds a swap dispute port to an independent arbitrator", () => {
    const source = `program swap_program "Swap program"
import { swap } from "std/money_flows"

party buyer: business
party seller: business
party arbitrator: person

settlement exchange = swap {
  between: [buyer, seller]
  amounts {
    buyer: buyerAmount: money(SAR)
    seller: sellerAmount: money(SAR)
  }
  fees {
    buyer: buyerFee: money(SAR)
    seller: sellerFee: money(SAR)
  }
  release: port release_exchange
  dispute: port dispute_exchange within P7D
}

port release_exchange { allowed: [buyer, seller] }
port dispute_exchange { allowed: [arbitrator] }`;

    const result = compile(source);
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document.instruments).toContainEqual(
      expect.objectContaining({
        id: "exchange",
        parties: expect.objectContaining({ arbitrator: "arbitratorAccountId" }),
        actions: expect.objectContaining({
          dispute: expect.objectContaining({
            port: { allowedParties: ["arbitrator"] },
          }),
        }),
      }),
    );
  });
});

describe("decision port party binding across conditional branches", () => {
  const source = (buyerLeads: string) => `program gated_program "Gated program"
party buyer: person
party seller: business
export instrument gated<C>(buyer: party, seller: party, amount: money<C>, buyer_leads: optional<text>, approve: condition) {
  agent_description: "Gated settlement mechanism.";
  let(approve_name): approve;
  when(buyer_leads) { let(lead): buyer; }
  when_not(buyer_leads) { let(lead): seller; }
  fields { amount: money<C>; }
  lifecycle { states created done; initial created; on [approve_name]: created -> done; }
  parties { payer: lead; beneficiary: seller; }
  action create { agent_description: "Create gated mechanism."; steps: []; }
  action [approve_name] { agent_description: "Approve gated mechanism."; steps: []; moves: []; port { allowed_parties: [payer]; }; }
}
settlement gate = gated {
  buyer: buyer
  seller: seller
  amount: SAR 5.00${buyerLeads}
  approve: port ok
}
port ok {
  allowed: [buyer]
  shape { note: text }
}`;

  it("binds the party chosen by the active branch", () => {
    const result = compile(source('\n  buyer_leads: "buyer leads"'));
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts?.document).toMatchObject({
      instruments: [{ parties: { payer: "buyerAccountId" } }],
    });
  });

  it("refuses a port whose allowed party has no bound account in the active branch", () => {
    const result = compile(source(""));
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1024" }),
    );
  });
});

describe("decision port shape types reach generated action input", () => {
  it("uses field-block schemas for aliased port types and keeps every shape key required", () => {
    const types = `note: Note; amount: Amount; fixed: money(SAR, 5000); on: date;
      count: integer; agreed: boolean; destination: account(SAR);
      boothId: id(booth); boothRef: ref<booth>; fee: bps; share: percent;`;
    const source = `program shape_parity "Shape parity"
import { security_deposit } from "std/money_flows"
type Note = text
type Amount = money(SAR)
party buyer: person
party seller: business
instrument booth {
  agent_description: "Inspection booth.";
  fields { ${types
    .replace(
      "note: Note",
      "note: { type: Note; min_length: 1; max_length: 180; }",
    )
    .replace("amount: Amount", "amount: { type: Amount; optional: true; }")
    .replace(
      "destination: account(SAR)",
      'destination: { type: account(SAR); pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$"; }',
    )
    .replace(
      "boothId: id(booth)",
      'boothId: { type: id(booth); min_length: 1; max_length: 180; pattern: "^boot_(sandbox|live)_[a-z0-9]{8,64}$"; }',
    )
    .replace(
      "boothRef: ref<booth>",
      'boothRef: { type: ref<booth>; min_length: 1; max_length: 180; pattern: "^boot_(sandbox|live)_[a-z0-9]{8,64}$"; }',
    )} }
  lifecycle { states active; initial active; }
  action create { agent_description: "Create booth."; steps: []; }
}
settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}
port report_damage { allowed: [seller] shape { damageAmount: money(SAR) } }
port pass_inspection { allowed: [seller] shape { ${types} damageAmount: text; } }`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts!.document as UdlDocument;
    const fields = document.instruments.find(
      (item) => item.id === "booth",
    )!.fields;
    const input = document.instruments.find(
      (item) => item.id === "inspection_hold",
    )!.actions.pass_inspection!.input!;
    const properties = input.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const [name, property] of Object.entries(properties)) {
      if (name === "damageAmount") continue;
      const { description: _description, ...schema } = property;
      // A port money field may be decided as zero unless the amount is fixed;
      // every other key matches the instrument field.
      const field = fields[name]!;
      expect(schema).toEqual(
        field.pattern === "^[1-9][0-9]{0,17}$" && field.const === undefined
          ? { ...field, pattern: "^(0|[1-9][0-9]{0,17})$" }
          : field,
      );
    }
    expect(input.required).toEqual(Object.keys(input.properties!));
    expect(properties.damageAmount).toMatchObject({ type: "string" });
  });

  it("refuses an unknown decision port shape field type with HSX1025", () => {
    const source = `program inspection_program "Inspection program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: [seller]
  shape {
    inspectionNotes: text;
    unsupportedField: float;
  }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1025",
        fix: "declare unsupportedField as text, money(CUR), date, integer, boolean, account(CUR), ref<instrument_id>, id(instrument_id), bps, or percent",
        message:
          "decision port pass_inspection shape field unsupportedField has unknown type float",
      }),
    );
  });

  it("refuses a non-money claim field in decision port shape with HSX1104", () => {
    const source = `program inspection_program "Inspection program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: text }
}

port pass_inspection {
  allowed: [seller]
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1104",
        fix: "pass money<SAR> to damageAmount",
        message: "damageAmount needs money<SAR> but receives text",
      }),
    );
  });

  it("refuses a currency-mismatched claim field in decision port shape with HSX1101", () => {
    const source = `program inspection_program "Inspection program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(USD) }
}

port pass_inspection {
  allowed: [seller]
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1101",
        fix: "pass money<SAR> to damageAmount",
        message: "damageAmount needs money<SAR> but receives money<USD>",
      }),
    );
  });

  it("lowers a shared port again in each imported alias scope", () => {
    const standardLibrary: StandardLibrary = {
      source(_specifier, name) {
        if (name !== "gate_a" && name !== "gate_b") return undefined;
        // One ledger currency per program, so the scopes differ by kind.
        const fee = name === "gate_a" ? "money(SAR)" : "text";
        return `module std.money_flows.${name}
type Fee = ${fee}
export instrument ${name}(decision: condition) {
  agent_description: "Gate instrument for ${name}.";
  fields { charge { type: Fee; optional: true; } }
  lifecycle { states active; initial active; on approve: active -> active; }
  action create { agent_description: "Create gate."; steps: []; }
  action approve {
    agent_description: "Approve gate.";
    input { type: object; additional_properties: false; properties: decision_fields; required: keys(decision_fields); }
    port { allowed_parties: decision_allowed; }
    steps: [];
  }
}`;
      },
    };
    const source = (names: string[]) => `program scoped_shapes "Scoped shapes"
import { gate_a, gate_b } from "std/money_flows"
party reviewer: business
port approve { allowed: [reviewer]; shape { charge: Fee } }
${names.map((name) => `settlement ${name}_hold = ${name} { decision: port approve }`).join("\n")}`;
    const withoutAuthority: StandardLibrary = {
      source(specifier, name) {
        return standardLibrary
          .source(specifier, name)
          ?.replace("port { allowed_parties: decision_allowed; }", "");
      },
    };
    const shapeOnly = compile(
      source(["gate_a", "gate_b"]).replace("allowed: [reviewer]; ", ""),
      { standardLibrary: withoutAuthority },
    );
    expect(shapeOnly.diagnostics).toEqual([
      expect.objectContaining({
        code: "HSX1024",
        message:
          "wired decision port approve reaches action approve without declared allowed parties",
        fix: "declare a nonempty allowed list of declared parties on port approve",
      }),
      expect.objectContaining({
        code: "HSX1024",
        message:
          "wired decision port approve reaches action approve without declared allowed parties",
        fix: "declare a nonempty allowed list of declared parties on port approve",
      }),
    ]);
    for (const order of [
      ["gate_a", "gate_b"],
      ["gate_b", "gate_a"],
    ]) {
      const result = compile(source(order), { standardLibrary });
      expect(result.diagnostics).toEqual([]);
      const descriptions = Object.fromEntries(
        (result.artifacts!.document as UdlDocument).instruments.map((item) => [
          item.id,
          (
            item.actions.approve!.input!.properties as Record<
              string,
              Record<string, unknown>
            >
          ).charge!.description,
        ]),
      );
      expect(descriptions).toEqual({
        gate_a_hold: "Decided amount in SAR minor units",
        gate_b_hold:
          "Required decision reference retained in the operation receipt",
      });
    }
  });

  it("emits HSX1025 only once when two settlements share a port with an invalid shape field", () => {
    const source = `program shared_port_program "Shared port program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement hold_one = security_deposit {
  payer: buyer
  holder: seller
  amount: deposit1: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: deposit1, remainder: return }
  return: port pass_inspection
}

settlement hold_two = security_deposit {
  payer: buyer
  holder: seller
  amount: deposit2: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: deposit2, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: [seller]
  shape { badField: float }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    const shapeErrors = result.diagnostics.filter((d) => d.code === "HSX1025");
    expect(shapeErrors).toHaveLength(1);
    expect(shapeErrors[0]).toEqual(
      expect.objectContaining({
        code: "HSX1025",
        fix: "declare badField as text, money(CUR), date, integer, boolean, account(CUR), ref<instrument_id>, id(instrument_id), bps, or percent",
        message:
          "decision port pass_inspection shape field badField has unknown type float",
      }),
    );
  });

  it("refuses a duplicated decision port shape field with HSX1004", () => {
    const source = `program inspection_program "Inspection program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: [seller]
  shape {
    note: text;
    note: money(SAR);
  }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1004",
        message:
          "decision port pass_inspection shape field note is declared twice",
      }),
    );
  });

  it("refuses a claim port whose shape lacks the claim field with HSX1011", () => {
    const source = `program inspection_program "Inspection program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { reason: text }
}

port pass_inspection {
  allowed: [seller]
  shape { note: text }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1011",
        fix: "add damageAmount: money(SAR) to the shape of decision port report_damage",
        message:
          "decision port report_damage shape lacks claim field damageAmount",
      }),
    );
    expect(result.diagnostics.filter((d) => d.code === "HSX1602")).toHaveLength(
      0,
    );
  });

  it("points an aliased fixed-money error at the field, not the alias", () => {
    const source = `program alias_span_program "Alias span program"

type bad_fee = money(SAR, 0)

instrument ledger {
  fields {
    fee: bad_fee;
  }
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    const issue = result.diagnostics.find((d) => d.code === "HSX1103");
    expect(issue).toBeDefined();
    const fieldOffset = source.indexOf("fee: bad_fee") + "fee: ".length;
    expect(issue!.span.start).toBe(fieldOffset);
  });

  it("reports unknown type block when a port shape field declares a nested block", () => {
    const source = `program nested_block_program "Nested block program"
import { security_deposit } from "std/money_flows"

party buyer: person
party seller: business

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: { field: damageAmount, bound: depositAmount, remainder: return }
  return: port pass_inspection
}

port report_damage {
  allowed: [seller]
  shape { damageAmount: money(SAR) }
}

port pass_inspection {
  allowed: [seller]
  shape { nestedField: { inner: true } }
}`;

    const result = compile(source);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1025",
        message:
          "decision port pass_inspection shape field nestedField has unknown type block",
      }),
    );
  });
});

describe("std money flow sandbox failure points", () => {
  const source = `program market "Market"
import { held_payment, security_deposit } from "std/money_flows"

party buyer: person
party seller: business
party inspector: business

settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  fees { buyer: 2% }
  on_cancel(funded) { buyer: 100% }
  release: port confirm_delivery | at(releaseDueAt)
}

settlement inspection_hold = security_deposit {
  payer: buyer
  holder: seller
  amount: depositAmount: money(SAR)
  claim: port report_damage
  claim_amount: decided {
    field: damageAmount
    bound: depositAmount
    remainder: return
  }
  return: port pass_inspection
}

port confirm_delivery {
  allowed: [buyer]
  shape {
    odometerKm: integer
  }
}

port report_damage {
  allowed: [buyer]
  shape {
    damageAmount: money(SAR)
  }
}

port pass_inspection {
  allowed: [inspector]
  shape {
    inspectionNotes: text
  }
}
`;

  function actionSandboxPoints(
    document: unknown,
  ): Record<string, string | null> {
    const doc = document as UdlDocument | undefined;
    return Object.fromEntries(
      (doc?.instruments ?? []).flatMap((instrument) =>
        Object.entries(instrument.actions).map(([name, action]) => [
          `${instrument.id}.${name}`,
          action.sandboxFailurePoint ?? null,
        ]),
      ),
    );
  }

  it("declares the sentinel on held_payment and security_deposit", () => {
    const result = compile(source);
    const document = result.artifacts?.document as UdlDocument | undefined;
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(document);
    expect(points["sale.fund_piece_1"]).toBe("funding");
    expect(points["sale.confirm_delivery"]).toBe("release");
    expect(points["sale.cancel"]).toBeNull();
    expect(points["sale.release_on_deadline"]).toBeNull();
    expect(points["inspection_hold.place_deposit"]).toBe("funding");
    expect(points["inspection_hold.report_damage"]).toBeNull();
  });

  it("declares the sentinel on cancellable_booking", () => {
    const result =
      compile(`program test_cancellable_booking "Cancellable booking"
import { cancellable_booking } from "std/money_flows"

party guest: person
party host: business

settlement booking = cancellable_booking {
  guest: guest
  host: host
  amount: sessionPrice: money(SAR)
  starts_at: startsAt
  late_penalty_bps: 5000
  late_within: P2D
  early_penalty_bps: 1000
  offer_life: PT30M
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["booking.take"]).toBe("funding");
    expect(points["booking.complete"]).toBeNull();
    expect(points["booking.cancel"]).toBeNull();
    expect(points["booking.confirm"]).toBeNull();
    expect(points["booking.retain"]).toBeNull();
    expect(points["booking.create"]).toBeNull();
  });

  it("declares the sentinel on captured_payment", () => {
    const result = compile(`program test_captured_payment "Captured payment"
import { captured_payment } from "std/money_flows"

party payer: person
party payee: business

settlement payment = captured_payment {
  payer: payer
  payee: payee
  amount: authorizedAmount: money(SAR)
  reserve_until: reserveUntil
  correction: port correct_capture
  external_reversal: port reverse_capture within P14D
}

port correct_capture { allowed: [payee] }
port reverse_capture {
  allowed: [payee]
  shape: { externalReference: text }
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["payment.authorize"]).toBe("funding");
    expect(points["payment.capture"]).toBe("release");
    expect(points["payment.capture_more"]).toBeNull();
    expect(points["payment.settle"]).toBeNull();
    expect(points["payment.void"]).toBeNull();
    expect(points["payment.expire"]).toBeNull();
    expect(points["payment.settle_on_expiry"]).toBeNull();
    expect(points["payment.correct_capture"]).toBeNull();
    expect(points["payment.reverse_capture"]).toBeNull();
    expect(points["payment.create"]).toBeNull();
  });

  it("declares the sentinel on instant_transfer", () => {
    const result = compile(`program test_instant_transfer "Instant transfer"
import { instant_transfer } from "std/money_flows"

party customer: person
party merchant: business

settlement transfer = instant_transfer {
  payer: customer
  payee: merchant
  amount: transferAmount: money(SAR)
  fees {
    customer: checkoutFee: money(SAR)
    merchant {
      tier { from: 0, to: 10000, fee: 1% }
      tier { from: 10000, fee: highValueFee: money(SAR) }
    }
  }
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["transfer.pay_piece_1"]).toBe("funding");
    expect(points["transfer.pay_piece_2"]).toBeNull();
    expect(points["transfer.collect_service_fee"]).toBeNull();
    expect(points["transfer.create"]).toBeNull();
  });

  it("declares the sentinel on premium_forward", () => {
    const result = compile(`program test_premium_forward "Premium forward"
import { premium_forward } from "std/money_flows"

party policyholder: person
party carrier: business

settlement premium = premium_forward {
  payer: policyholder
  carrier: carrier
  amount: premiumAmount: money(SAR)
  commission: 2%
  bind: port bind_policy
  policy_ref: policyReference
  renewal_due: renewalDueAt
  endorsement: port record_endorsement
}

port bind_policy { allowed: [policyholder, carrier] }
port record_endorsement {
  allowed: [carrier]
  shape: { evidenceReference: text }
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["premium.fund_piece_1"]).toBe("funding");
    expect(points["premium.fund_piece_2"]).toBe("funding");
    expect(points["premium.bind_policy"]).toBe("release");
    expect(points["premium.forward_piece_2"]).toBeNull();
    expect(points["premium.unfund_piece_1"]).toBeNull();
    expect(points["premium.abandon"]).toBeNull();
    expect(points["premium.record_endorsement"]).toBeNull();
    expect(points["premium.lapse"]).toBeNull();
    expect(points["premium.create"]).toBeNull();
  });

  it("describes the authored commission split on premium_forward", () => {
    const result15 = compile(`program test_premium_forward_15 "Premium forward"
import { premium_forward } from "std/money_flows"

party policyholder: person
party carrier: business

settlement premium = premium_forward {
  payer: policyholder
  carrier: carrier
  amount: premiumAmount: money(SAR)
  commission: 15%
  bind: port bind_policy
}

port bind_policy { allowed: [policyholder, carrier] }
`);
    expect(result15.verdict).toBe("valid");
    const doc15 = result15.artifacts?.document as UdlDocument;
    const instrument15 = doc15.instruments[0]!;
    expect(instrument15.agentDescription).toContain(
      "Binding then forwards 85% to the carrier and 15% to the platform.",
    );
    expect(instrument15.fields.piece1Amount?.description).toBe(
      "85% of premiumAmount (carries the integer-division remainder): released to the carrier. Computed as floor(premiumAmount * 8500 / 10000) in SAR minor units",
    );
    expect(instrument15.fields.piece2Amount?.description).toBe(
      "15% of premiumAmount: released to the platform. Computed as floor(premiumAmount * 1500 / 10000) in SAR minor units",
    );

    const resultDefault =
      compile(`program test_premium_forward_default "Premium forward"
import { premium_forward } from "std/money_flows"

party policyholder: person
party carrier: business

settlement premium = premium_forward {
  payer: policyholder
  carrier: carrier
  amount: premiumAmount: money(SAR)
  commission: 2%
  bind: port bind_policy
}

port bind_policy { allowed: [policyholder, carrier] }
`);
    expect(resultDefault.verdict).toBe("valid");
    const docDefault = resultDefault.artifacts?.document as UdlDocument;
    const instrumentDefault = docDefault.instruments[0]!;
    expect(instrumentDefault.agentDescription).toContain(
      "Binding then forwards 98% to the carrier and 2% to the platform.",
    );
    expect(instrumentDefault.fields.piece1Amount?.description).toBe(
      "98% of premiumAmount (carries the integer-division remainder): released to the carrier. Computed as floor(premiumAmount * 9800 / 10000) in SAR minor units",
    );
    expect(instrumentDefault.fields.piece2Amount?.description).toBe(
      "2% of premiumAmount: released to the platform. Computed as floor(premiumAmount * 200 / 10000) in SAR minor units",
    );
  });

  it("declares the sentinel on rotating_pool", () => {
    const result = compile(`program test_rotating_pool "Rotating pool"
import { rotating_pool } from "std/money_flows"

party member_a: person
party member_b: person
party guarantor: business

settlement pool = rotating_pool {
  members: [member_a, member_b]
  contribution: contributionAmount: money(SAR)
  count: 2
  every: P30D
  first_due: firstContributionAt
  payout_order: [member_b, member_a]
  default_policy: due_condition
  guarantee_policy: funded_only
  guarantor: guarantor
  exit_policy: before_activation_only
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["pool_member_a_contribution.contribute_cycle_1"]).toBe(
      "funding",
    );
    expect(points["pool_member_a_contribution.pay_cycle_1"]).toBe("release");
    expect(points["pool_member_a_contribution.contribute_cycle_2"]).toBeNull();
    expect(points["pool_member_a_contribution.pay_cycle_2"]).toBeNull();
    expect(points["pool_member_a_contribution.guarantee_cycle_1"]).toBeNull();
    expect(points["pool_member_b_contribution.contribute_cycle_1"]).toBe(
      "funding",
    );
    expect(points["pool_member_b_contribution.pay_cycle_1"]).toBe("release");
    expect(points["pool_member_b_contribution.contribute_cycle_2"]).toBeNull();
    expect(points["pool_member_b_contribution.pay_cycle_2"]).toBeNull();
    expect(points["pool.activate"]).toBeNull();
  });

  it("declares the sentinel on scheduled", () => {
    const result = compile(`program test_scheduled "Scheduled"
import { scheduled } from "std/money_flows"

party payer: business
party payee: business

settlement installments = scheduled {
  payer: payer
  payee: payee
  amount: totalAmount: money(SAR)
  count: 3
  every: P30D
  first_due: firstDueAt
}

party debtor_party: person
settlement obligation = scheduled {
  mode: obligation
  payer: payer
  payee: payee
  debtor: debtor_party
  amount: periodAmount: money(SAR)
  every: P1M
  first_due: firstDueAt
  until: port cancel_period
  month_end: clamp_to_last_day
  period_liability: one_open
  termination_drain: cancel_period
}

port cancel_period {
  allowed: [debtor_party]
  shape: { terminateAt: date }
}
`);
    expect(result.verdict).toBe("valid");
    const points = actionSandboxPoints(result.artifacts?.document);
    expect(points["installments.pay_installment_1"]).toBe("funding");
    expect(points["installments.pay_installment_2"]).toBeNull();
    expect(points["installments.pay_installment_3"]).toBeNull();
    expect(points["installments.create"]).toBeNull();
    expect(points["obligation.collect_period"]).toBe("funding");
    expect(points["obligation.open_period"]).toBeNull();
    expect(points["obligation.cancel_period"]).toBeNull();
    expect(points["obligation.create"]).toBeNull();
  });

  it("lowers charge_retained_by in quote clause to camelCase chargeRetainedBy", () => {
    const result = compile(`program quote_retention "Quote Retention"
party insurer: business
party policyholder: person
instrument policy_quote {
  title: "Policy Quote";
  summary: "Policy quote";
  id_prefix: "pol";
  agent_description: "Policy with retained charge quote.";
  fields {
    premium: money<SAR>;
  }
  parties {
    beneficiary: insurer;
    payer: policyholder;
  }
  lifecycle {
    states created active refund_quoted canceled;
    initial created;
    on fund: created -> active;
    on quote_refund: active -> refund_quoted;
    on confirm_refund: refund_quoted -> canceled;
  }
  action create {
    agent_description: "Create policy quote.";
    summary: "Create policy quote";
    steps: [];
  }
  action fund {
    agent_description: "Fund policy.";
    summary: "Fund policy";
    steps: [];
    moves: [
      {
        key: "fund_transfer",
        operation: "internal_transfer.create",
        bind: {
          amount: { from: "instance", path: "fields.premium" },
          destinationAccountId: { from: "instance", path: "fields.insurerAccountId" },
          sourceAccountId: { from: "instance", path: "fields.policyholderAccountId" },
        },
      },
    ];
  }
  action quote_refund {
    agent_description: "Quote refund.";
    summary: "Quote refund";
    quote {
      baseField: premium;
      chargeRef: penalty;
      charge_retained_by: beneficiary;
      charges: [{ bps: 1000; }];
      expires { offset: "PT15M"; }
      fixes: [insurerAccountId, policyholderAccountId, premium];
      netDestinationField: policyholderAccountId;
      netRef: refund;
    }
  }
  action confirm_refund {
    commit: quote_refund;
    agent_description: "Confirm refund.";
    summary: "Confirm refund";
    moves: [
      {
        key: "refund_transfer",
        operation: "internal_transfer.create",
        bind: {
          amount: { from: "instance", path: "refs.refund" },
          destinationAccountId: { from: "instance", path: "fields.policyholderAccountId" },
          sourceAccountId: { from: "instance", path: "fields.insurerAccountId" },
        },
      },
    ];
  }
}`);
    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const quote = (document?.instruments[0]?.actions?.quote_refund as any)
      ?.quote;
    expect(quote?.chargeRetainedBy).toBe("beneficiary");
  });
});

const PIECE_CALL_SOURCE = `program piece_calls "Piece calls"
instrument escrow {
  agent_description: "Move a declared piece between its bound accounts.";
  fields {
    total: money(SAR, 100);
    firstAmount: money(SAR, 30);
    secondAmount: money(SAR, 70);
    sourceAccountId: account;
    sellerAccountId: account;
    feeAccountId: account;
  }
  partitions: [{ totalField: "total"; pieceFields: ["firstAmount", "secondAmount"]; }];
  lifecycle { states ready closed; initial ready; on release: ready -> closed; }
  piece_plan: {
    id: "price"; total: "total";
    pieces: [
      { id: "seller"; amount: "firstAmount"; release_to: "sellerAccountId"; refund_to: "sourceAccountId"; },
      { id: "platform_fee"; amount: "secondAmount"; release_to: "feeAccountId"; refund_to: "sourceAccountId"; }
    ];
    fund_order: ["seller", "platform_fee"];
    release_order: ["platform_fee", "seller"];
    refund_order: ["seller", "platform_fee"];
    unfund_order: ["platform_fee", "seller"];
  };
  action_library: {
    settlement_piece: {
      actionOrder: ["move_piece"];
      actions: {
        move_piece: {
          parameters: { piece: { kind: "piece"; }; settlement: { kind: "instance"; }; };
          principal: "api_key"; approval: "inherit"; recovery: "local";
          order: ["transfer"]; calls: [];
          leaves: [{
            id: "transfer"; operation: "internal_transfer.create";
            bind: {
              amount: "$piece.amount"; currency: "$piece.currency";
              sourceAccountId: "$settlement.fields.sourceAccountId";
              destinationAccountId: "$piece.release_to";
            };
            effects: [{ kind: "moves"; signature: "moves.transfer.internal"; }];
            evidence: "transferId";
          }];
        };
      };
    };
  };
  action create { agent_description: "Declare the immutable piece amounts and accounts."; steps: []; }
  action release {
    agent_description: "Release the selected piece to its declared account.";
    piece_stage: { plan: "price"; stage: "release"; };
    calls: [{ id: "move_piece"; action: "settlement_piece.move_piece"; bind: { piece: "$piece"; settlement: "$instance"; }; }];
    steps: [];
  }
}`;

describe("piece plans through generic clauses", () => {
  it("round-trips source calls and piece plans without publishing private actions", () => {
    const first = compile(PIECE_CALL_SOURCE);
    if (!first.artifacts) throw new Error(JSON.stringify(first.diagnostics));
    const instrument = (first.artifacts.document as unknown as UdlDocument)
      .instruments[0]!;
    const source = PIECE_CALL_SOURCE.replace(
      /  piece_plan: \{[\s\S]*?\n  \};/,
      `  ${emitUdlClause("instrument", "piecePlan", instrument.piecePlan!)}`,
    )
      .replace(
        /  action_library: \{[\s\S]*?\n  \};/,
        `  ${emitUdlClause("instrument", "actionLibrary", instrument.actionLibrary! as unknown as JsonValue)}`,
      )
      .replace(
        /    piece_stage: [^\n]+/,
        `    ${emitUdlClause("action", "pieceStage", instrument.actions.release!.pieceStage!)}`,
      )
      .replace(
        /    calls: [^\n]+/,
        `    ${emitUdlClause("action", "calls", instrument.actions.release!.calls!)}`,
      );
    const libraryModule = `module piece_library\n${emitUdlClause("instrument", "actionLibrary", instrument.actionLibrary! as unknown as JsonValue).replace("action_library:", "export const settlement_library =")}`;
    const imported = source
      .replace(
        /  action_library: [^\n]+/,
        "  action_library: settlement_library;",
      )
      .replace(
        'program piece_calls "Piece calls"',
        'program piece_calls "Piece calls"\nimport { settlement_library } from "piece-library.hsx"',
      );
    const second = compile(imported, {
      moduleName: "piece-calls.hsx",
      resolveModule: () => ({
        name: "piece-library.hsx",
        source: libraryModule,
      }),
    });
    expect({
      canonical: second.artifacts && serializeUdl(second.artifacts.document),
      actions: instrument.actionOrder,
      pieceInput: instrument.actions.release!.input,
    }).toEqual({
      canonical: serializeUdl(first.artifacts.document),
      actions: ["create", "release"],
      pieceInput: {
        type: "object",
        additionalProperties: false,
        required: ["pieceId"],
        properties: {
          pieceId: { type: "string", enum: ["platform_fee", "seller"] },
        },
      },
    });
  });

  it("refuses caller-authored piece selectors and amount overrides", () => {
    const inputs = [
      '{ type: "object"; properties: { amount: { type: "string"; }; }; }',
      '{ type: "object"; properties: { pieceId: { type: "string"; }; }; }',
    ];
    expect(
      inputs.map((input) =>
        compile(
          PIECE_CALL_SOURCE.replace(
            "piece_stage:",
            `input: ${input}; piece_stage:`,
          ),
        ).diagnostics.some((issue) => issue.code === "HSX1611"),
      ),
    ).toEqual([true, true]);
  });
});

it("lowers published and authored calls to the same leaf origins", () => {
  const compiled = compile(PIECE_CALL_SOURCE);
  if (!compiled.artifacts)
    throw new Error(JSON.stringify(compiled.diagnostics));
  const authored = checkGeneralProgram(parseProgram(PIECE_CALL_SOURCE).program);
  const published = checkGeneralProgram(
    parseProgram(`program reuse "Reuse"
use escrow
expose escrow.release as releasePiece
`).program,
    { publishedCatalog: compiled.artifacts.document as unknown as UdlDocument },
  );
  if (!authored.program || !published.program)
    throw new Error(
      JSON.stringify([authored.diagnostics, published.diagnostics]),
    );
  const left = lowerGeneralProgram(authored.program);
  const right = lowerGeneralProgram(published.program);
  if (!left.ok || !right.ok)
    throw new Error("action-plan lowering refused a checked program");
  expect({
    published: right.value.actionPlans,
    origins: left.value.actionPlans
      ?.filter((plan) => plan.action === "release")
      .map((plan) => ({
        piece: plan.pieceId,
        paths: plan.leaves.map((leaf) => leaf.originPath),
      })),
  }).toEqual({
    published: left.value.actionPlans,
    origins: [
      { piece: "platform_fee", paths: [["release", "move_piece", "transfer"]] },
      { piece: "seller", paths: [["release", "move_piece", "transfer"]] },
    ],
  });
});

it("retains fatal UDL codes when checking call boundaries in HSX", () => {
  const checked = checkGeneralProgram(
    parseProgram(
      PIECE_CALL_SOURCE.replace(
        'principal: "api_key"',
        'principal: "user_session"',
      ),
    ).program,
  );
  expect(checked.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HSX1614",
      udlCode: "UDL2012",
      severity: "error",
    }),
  );
});

describe("money fields and zero", () => {
  const withFields = (fields: string) =>
    compile(
      BASE.replace("fields { amount: money<SAR>; }", `fields { ${fields} }`),
    );
  const patternOf = (fields: string, field: string) => {
    const result = withFields(fields);
    expect(result.verdict).toBe("valid");
    const document = result.artifacts!.document as {
      instruments: { fields: Record<string, { pattern?: string }> }[];
    };
    return document.instruments[0]!.fields[field]!.pattern;
  };

  it("keeps a required money field strictly positive", () => {
    expect(patternOf("amount: money<SAR>;", "amount")).toBe(
      "^[1-9][0-9]{0,17}$",
    );
  });

  it("keeps an optional money field strictly positive", () => {
    expect(
      patternOf("amount { type: money<SAR>; optional: true; }", "amount"),
    ).toBe("^[1-9][0-9]{0,17}$");
  });

  it("lowers allow_zero money to the non-negative pattern", () => {
    expect(
      patternOf("amount { type: money<SAR>; allow_zero: true; }", "amount"),
    ).toBe("^(0|[1-9][0-9]{0,17})$");
  });

  it("refuses allow_zero on a non-money field with HSX1105", () => {
    const result = withFields(
      "amount: money<SAR>; memo { type: text; allow_zero: true; }",
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1105",
        message: "field memo sets allow_zero but is text, not money",
      }),
    );
  });

  it("resolves declared id_prefix on published and authored instruments and falls back to derived initials", () => {
    const publishedCatalog = {
      instruments: [
        {
          actions: {},
          description: "Authorised Decision",
          fields: {},
          id: "authorised_decision",
          idPrefix: "adec",
          lifecycle: {
            initial: "created",
            states: ["created"],
            transitions: {},
          },
          parties: {},
          summary: "Authorised Decision",
          title: "Authorised Decision",
        },
      ],
      operations: [],
      product: "catalog",
      subjects: [],
      title: "Catalog",
      udl: 1,
      version: 1,
    } as unknown as UdlDocument;
    const result = compile(
      `program prefix_resolution "Prefix Resolution"
party alice: person
party bob: person

instrument custom_auth {
  title: "Custom Auth";
  summary: "Custom auth";
  id_prefix: "cauth";
  agent_description: "Custom auth description";
  fields {}
  parties { buyer: alice; seller: bob; }
  lifecycle {
    states created done;
    initial created;
    on act: created -> done;
  }
  action create {
    summary: "Create";
    agent_description: "Create action";
    steps: [];
  }
  action act {
    summary: "Act";
    agent_description: "Act action";
    steps: [];
    input: {
      type: object;
      properties: {
        declaredRef: {
          type: string;
          pattern: concat("^", prefix(custom_auth), "_[0-9]{1,32}$");
        };
        catalogRef: {
          type: string;
          pattern: concat("^", prefix(authorised_decision), "_[0-9]{1,32}$");
        };
        undeclaredRef: {
          type: string;
          pattern: concat("^", prefix(unknown_external_instrument), "_[0-9]{1,32}$");
        };
      };
      required: [declaredRef, catalogRef, undeclaredRef];
      additionalProperties: false;
    };
  }
}`,
      { publishedCatalog },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    const doc = result.artifacts?.document as UdlDocument;
    const inst = doc.instruments.find((item) => item.id === "custom_auth")!;
    const properties = (
      inst.actions.act!.input as {
        properties: {
          declaredRef: { pattern: string };
          catalogRef: { pattern: string };
          undeclaredRef: { pattern: string };
        };
      }
    ).properties;
    expect(properties.declaredRef.pattern).toBe("^cauth_[0-9]{1,32}$");
    expect(properties.catalogRef.pattern).toBe("^adec_[0-9]{1,32}$");
    expect(properties.undeclaredRef.pattern).toBe("^uei_[0-9]{1,32}$");
  });
});
