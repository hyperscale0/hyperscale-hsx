import { describe, expect, it } from "bun:test";
import { serializeUdl, type UdlDocument } from "@hyperscale0/udl";
import {
  lowerGeneralProgram,
  originForUdlPath,
  parseProgram,
  checkGeneralProgram,
  compile,
  type UdlCostTable,
} from "../src/index.ts";
import { buildCostManifest, buildUdlCostManifest } from "../src/cost.ts";
import { testCostTable } from "./compile.ts";

const SOURCE = `program billing_test "Billing Test"
party buyer: person
instrument invoice {
  title: "Invoice";
  summary: "A payable invoice";
  id_prefix: "inv";
  agent_description: "A payable invoice instrument for billing tests.";
  fields { amount: money<SAR>; }
  lifecycle { states created paid; initial created; on pay: created -> paid; }
  parties { payer: buyer; }
  action create {
    agent_description: "Create an invoice for the buyer.";
    summary: "Create an invoice";
    steps: [];
  }
  action pay {
    agent_description: "Pay the invoice when ready.";
    summary: "Pay the invoice";
    steps: [];
    moves: [];
    notify buyer via email;
  }
}
`;

describe("cost pricing kernel parity", () => {
  function prepare(source = SOURCE) {
    const parsed = parseProgram(source);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkGeneralProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    if (!checked.program) throw new Error("typecheck failed");
    const lowered = lowerGeneralProgram(checked.program);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) throw new Error("lowering failed");
    return {
      document: lowered.value.document,
      program: checked.program,
    };
  }

  it("produces identical action pricing between HSX and UDL entrypoints on equivalent lowered input", () => {
    const { program, document } = prepare();
    const hsxResult = buildCostManifest(program, testCostTable);
    expect(hsxResult.ok).toBe(true);
    if (!hsxResult.ok) throw new Error("HSX pricing failed");

    const udlResult = buildUdlCostManifest(document, testCostTable);

    expect(hsxResult.manifest.actions).toEqual(udlResult.actions);
    expect(hsxResult.manifest.actions.length).toBeGreaterThan(0);
  });

  it("handles multiple price rows per signature and splits payers identically", () => {
    const multiRowTable: UdlCostTable = {
      ...testCostTable,
      rows: [
        ...testCostTable.rows.filter((r) => r.signature !== "notifies.email"),
        {
          bps: 0,
          meter: "notifications.email.product",
          payer: "product",
          perEventMinor: "7",
          settlement: "invoice",
          signature: "notifies.email",
        },
        {
          bps: 0,
          meter: "notifications.email.customer",
          payer: "end_customer",
          perEventMinor: "5",
          settlement: "invoice",
          signature: "notifies.email",
        },
      ],
      version: "multi-row-test",
    };

    const { program, document } = prepare();
    const hsxResult = buildCostManifest(program, multiRowTable);
    expect(hsxResult.ok).toBe(true);
    if (!hsxResult.ok) throw new Error("HSX pricing failed");

    const udlResult = buildUdlCostManifest(document, multiRowTable);

    expect(hsxResult.manifest.actions).toEqual(udlResult.actions);
    const payAction = hsxResult.manifest.actions.find(
      (a) => a.action === "pay",
    );
    expect(payAction).toBeDefined();
    expect(
      payAction?.components.filter((c) => c.signature === "notifies.email"),
    ).toHaveLength(2);
    expect(payAction?.endCustomerPerEventMinor).toBe("5");
    expect(payAction?.perEventMinor).toBe("7");
  });

  it("reports missing prices through diagnostic with span in HSX and thrown error in UDL", () => {
    const missingTable: UdlCostTable = {
      ...testCostTable,
      rows: testCostTable.rows.filter((r) => r.signature !== "notifies.email"),
      version: "missing-email",
    };

    const { program, document } = prepare();
    const hsxResult = buildCostManifest(program, missingTable);
    expect(hsxResult.ok).toBe(false);
    if (hsxResult.ok) throw new Error("expected HSX pricing failure");

    expect(hsxResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1301",
        message: "invoice.pay has unpriced effect signature notifies.email",
        span: program.instruments[0]?.actions[1]?.origin,
      }),
    );

    expect(() => buildUdlCostManifest(document, missingTable)).toThrow(
      "invoice.pay has unpriced effect signature notifies.email",
    );
  });

  it("reports invalid basis-point pricing through diagnostic in HSX and thrown error in UDL", () => {
    const invalidBpsTable: UdlCostTable = {
      ...testCostTable,
      rows: [
        ...testCostTable.rows.filter((r) => r.signature !== "notifies.email"),
        {
          bps: 50,
          meter: "notifications.email",
          payer: "product",
          perEventMinor: "1",
          settlement: "invoice",
          signature: "notifies.email",
        },
      ],
      version: "invalid-bps",
    };

    const { program, document } = prepare();
    const hsxResult = buildCostManifest(program, invalidBpsTable);
    expect(hsxResult.ok).toBe(false);
    if (hsxResult.ok) throw new Error("expected HSX pricing failure");

    expect(hsxResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1302",
        message: "cost table invalid-bps has an invalid notifies.email price",
        span: program.instruments[0]?.actions[1]?.origin,
      }),
    );

    expect(() => buildUdlCostManifest(document, invalidBpsTable)).toThrow(
      "cost table invalid-bps has an invalid notifies.email price",
    );
  });

  it("prices each program in the table that matches its ledger currency", () => {
    const tables = ["USD", "EUR", "GBP"].map((currency): UdlCostTable => ({
      ...testCostTable,
      currency,
      version: `version-${currency}`,
    }));
    for (const currencyTable of tables) {
      const curr = currencyTable.currency;
      const { program, document } = prepare(
        SOURCE.replace("money<SAR>", `money<${curr}>`),
      );

      const hsxResult = buildCostManifest(program, tables);
      expect(hsxResult.ok).toBe(true);
      if (!hsxResult.ok) throw new Error(`HSX pricing failed for ${curr}`);
      expect(hsxResult.manifest.currency).toBe(curr);

      const udlResult = buildUdlCostManifest(document, currencyTable);
      expect(udlResult.currency).toBe(curr);
      expect(hsxResult.manifest.actions).toEqual(udlResult.actions);
    }
  });

  it("refuses a program whose ledger currency no table prices", () => {
    const { program } = prepare(SOURCE.replace("money<SAR>", "money<JPY>"));
    const result = buildCostManifest(program, testCostTable);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected HSX pricing failure");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1304",
        message:
          "program moves money in JPY, which no cost table prices (priced: SAR)",
        span: program.instruments[0]?.fields[0]?.origin,
      }),
    );
  });

  it("refuses a program that moves money in two ledger currencies", () => {
    const { program } = prepare(
      SOURCE.replace(
        "fields { amount: money<SAR>; }",
        "fields { amount: money<SAR>; fee: money<USD>; }",
      ),
    );
    const result = buildCostManifest(program, testCostTable);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected HSX pricing failure");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1305",
        message:
          "program moves money in SAR and USD; a program bills in one ledger currency",
        span: program.instruments[0]?.fields[1]?.origin,
      }),
    );
  });

  it("pins a fixed-currency move to its currency and refuses one bound elsewhere", () => {
    const move = (currency: string) =>
      SOURCE.replace(
        "moves: [];",
        `moves: [{ "bind": { "amount": { "from": "instance"; "path": "fields.amount"; }; "currency": ${currency}; "destinationAccountId": { "from": "instance"; "path": "fields.payeeAccountId"; }; "sourceAccountId": { "from": "instance"; "path": "fields.buyerAccountId"; }; }; "key": "transfer"; "operation": "internal_transfer.create"; }];`,
      ).replace(
        "fields { amount: money<SAR>; }",
        "fields { amount: money<SAR>; payeeAccountId: account<SAR>; }",
      );

    const pinned = prepare(
      move('{ "from": "instance"; "path": "fields.currency"; }'),
    );
    const pay = pinned.document.instruments[0]?.actions.pay;
    expect(pay?.moves[0]?.bind.currency).toEqual({
      from: "const",
      value: "SAR",
    });

    for (const [bound, spelled] of [
      ['{ "from": "const"; "value": "USD"; }', "USD"],
      ['{ "from": "input"; "path": "currency"; }', "a caller-supplied value"],
    ]) {
      const parsed = parseProgram(move(bound!));
      expect(parsed.diagnostics).toEqual([]);
      const checked = checkGeneralProgram(parsed.program);
      expect(checked.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HSX1306",
          fix: "bind currency as { from: const; value: SAR; }",
          message: `action pay binds the currency of fields.amount to ${spelled}; a money<SAR> amount moves in SAR`,
        }),
      );
    }
  });

  it("reports invalid billing currency through diagnostic in HSX and thrown error in UDL", () => {
    const invalidCurrencyTable: UdlCostTable = {
      ...testCostTable,
      currency: "INVALID",
      version: "invalid-currency",
    };

    const { program, document } = prepare();
    const hsxResult = buildCostManifest(program, invalidCurrencyTable);
    expect(hsxResult.ok).toBe(false);
    if (hsxResult.ok) throw new Error("expected HSX pricing failure");

    expect(hsxResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1303",
        message:
          "cost table invalid-currency has invalid billing currency INVALID",
      }),
    );

    expect(() => buildUdlCostManifest(document, invalidCurrencyTable)).toThrow(
      "cost table invalid-currency has invalid billing currency INVALID",
    );
  });
});

describe("originForUdlPath allocation-free diagnostic selector", () => {
  const origins = [
    { path: "$", span: { end: 100, start: 0 } },
    { path: "$.instruments[0]", span: { end: 50, start: 10 } },
    { path: "$.instruments[0].actions.pay", span: { end: 40, start: 20 } },
    { path: "$.instruments[0].fields.amount", span: { end: 25, start: 15 } },
  ];

  it("selects exact match when path matches entry exactly", () => {
    const result = originForUdlPath("$.instruments[0]", origins);
    expect(result?.span).toEqual({ end: 50, start: 10 });
  });

  it("selects longest matching parent at dot and bracket boundaries", () => {
    const dotResult = originForUdlPath(
      "$.instruments[0].actions.pay.steps[0]",
      origins,
    );
    expect(dotResult?.span).toEqual({ end: 40, start: 20 });

    const bracketResult = originForUdlPath("$.instruments[0][1]", origins);
    expect(bracketResult?.span).toEqual({ end: 50, start: 10 });
  });

  it("does not match non-boundary string prefixes", () => {
    const nonBoundaryResult = originForUdlPath("$.instruments_other", origins);
    expect(nonBoundaryResult?.span).toEqual({ end: 100, start: 0 });
  });

  it("preserves equal-length precedence by selecting the first matching entry", () => {
    const originsWithTie = [
      { path: "$.item.a", span: { end: 10, start: 10 } },
      { path: "$.item.b", span: { end: 20, start: 20 } },
    ];
    const result = originForUdlPath("$.item.a.sub", originsWithTie);
    expect(result?.span).toEqual({ end: 10, start: 10 });
  });

  it("falls back to root $ entry when no prefix matches", () => {
    const result = originForUdlPath("$.other_path", origins);
    expect(result?.span).toEqual({ end: 100, start: 0 });
  });
});

describe("compiler diagnostic byte coordinates", () => {
  it("computes byteSpan correctly for ASCII, CJK, and surrogate pairs", () => {
    const ascii = compile(`program p "Test"\ninvalid\n`, {
      costTable: testCostTable,
    });
    expect(ascii.diagnostics.length).toBeGreaterThan(0);
    const asciiDiag = ascii.diagnostics[0]!;
    expect(asciiDiag.byteSpan).toBeDefined();
    expect(asciiDiag.byteSpan?.start).toBe(asciiDiag.span.start);
    expect(asciiDiag.byteSpan?.end).toBe(asciiDiag.span.end);

    const cjkSource = `// 中文注释\nprogram cjk "中文"\ninvalid\n`;
    const cjk = compile(cjkSource, { costTable: testCostTable });
    expect(cjk.diagnostics.length).toBeGreaterThan(0);
    const cjkDiag = cjk.diagnostics[0]!;
    expect(cjkDiag.byteSpan).toBeDefined();
    expect(cjkDiag.byteSpan!.start).toBeGreaterThan(cjkDiag.span.start);
    expect(cjkDiag.byteSpan!.end - cjkDiag.byteSpan!.start).toBe(
      Buffer.byteLength(
        cjkSource.slice(cjkDiag.span.start, cjkDiag.span.end),
        "utf8",
      ),
    );

    const emojiSource = `// 😀🎉\nprogram emoji "Emoji"\ninvalid\n`;
    const emoji = compile(emojiSource, { costTable: testCostTable });
    expect(emoji.diagnostics.length).toBeGreaterThan(0);
    const emojiDiag = emoji.diagnostics[0]!;
    expect(emojiDiag.byteSpan).toBeDefined();
    expect(emojiDiag.byteSpan!.end - emojiDiag.byteSpan!.start).toBe(
      Buffer.byteLength(
        emojiSource.slice(emojiDiag.span.start, emojiDiag.span.end),
        "utf8",
      ),
    );
  });

  it("omits byteSpan for imported module diagnostics rather than manufacturing root offsets", () => {
    const result = compile(
      `program imported_error "Imported error"\nimport { ready } from "broken"\n`,
      {
        costTable: testCostTable,
        resolveModule() {
          return {
            name: "broken.hsx",
            source: `module broken\nexport instrument ready {\n title: "Ready"; fields {}\n lifecycle { states created; initial created; }\n action create { public: wrong; steps: []; }\n}`,
          };
        },
      },
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const moduleDiag = result.diagnostics.find((d) => d.file === "broken.hsx");
    expect(moduleDiag).toBeDefined();
    expect(moduleDiag?.byteSpan).toBeUndefined();
    expect(moduleDiag?.file).toBe("broken.hsx");
  });
});

const CALLED_TRANSFERS = `program call_cost "Call cost"
instrument payment {
  agent_description: "Move each declared obligation.";
  fields { first: money<SAR>; second: money<SAR>; payerAccountId: account; payeeAccountId: account; }
  lifecycle { states ready paid; initial ready; on pay: ready -> paid; }
  action_library: {
    transfers: {
      actionOrder: ["move"];
      actions: {
        move: {
          parameters: { amount: { kind: "money"; currency: "SAR"; }; owner: { kind: "instance"; }; };
          principal: "api_key"; approval: "inherit"; recovery: "local";
          order: ["transfer"]; calls: [];
          leaves: [{ id: "transfer"; operation: "internal_transfer.create";
            bind: { amount: "$amount"; currency: "$owner.fields.currency";
              sourceAccountId: "$owner.fields.payerAccountId"; destinationAccountId: "$owner.fields.payeeAccountId"; };
            effects: [{ kind: "moves"; signature: "moves.transfer.internal"; }]; evidence: "transferId";
          }];
        };
      };
    };
  };
  action pay {
    agent_description: "Pay both obligations under one parent action.";
    calls: [
      { id: "first"; action: "transfers.move"; bind: { amount: "$fields.first"; owner: "$instance"; }; },
      { id: "second"; action: "transfers.move"; bind: { amount: "$fields.second"; owner: "$instance"; }; }
    ];
    steps: [];
  }
  action create { agent_description: "Declare the two obligations."; steps: []; }
}`;

it("prices expanded calls once per leaf in both language entrypoints", () => {
  const table: UdlCostTable = {
    ...testCostTable,
    rows: [
      {
        signature: "moves.transfer.internal",
        perEventMinor: "7",
        bps: 0,
        payer: "product",
        settlement: "per_event",
        meter: "instrument.event.count",
      },
    ],
  };
  const result = compile(CALLED_TRANSFERS, { costTable: table });
  if (!result.artifacts) throw new Error(JSON.stringify(result.diagnostics));
  const hsx = result.artifacts.costManifest;
  const udl = buildUdlCostManifest(
    JSON.parse(serializeUdl(result.artifacts.document)) as UdlDocument,
    table,
  );
  const pay = hsx.actions.find((action) => action.action === "pay")!;
  expect({
    parity: udl,
    count: pay.components[0]?.count,
    price: pay.perEventMinor,
  }).toEqual({ parity: hsx, count: 2, price: "14" });
});

it("refuses calls whose expanded leaves lack a host price", () => {
  const result = compile(CALLED_TRANSFERS, {
    costTable: {
      ...testCostTable,
      rows: testCostTable.rows.filter(
        (row) => row.signature !== "moves.transfer.internal",
      ),
    },
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "HSX1301" }),
  );
});
