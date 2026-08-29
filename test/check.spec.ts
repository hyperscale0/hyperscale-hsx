import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, parseProgram } from "../src/index.ts";
import { compile } from "../src/index.ts";
import { pieceAmounts } from "../src/lower.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "car-escrow.hsx"),
  "utf8",
);

const check = (source: string) => {
  const parsed = parseProgram(source);
  expect(parsed.diagnostics).toEqual([]);
  return checkProgram(parsed.program);
};

const errors = (result: ReturnType<typeof check>) =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);

const warnings = (result: ReturnType<typeof check>) =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => diagnostic.message);

describe("checkProgram · car-escrow golden fixture", () => {
  const result = check(FIXTURE);

  it("checks clean with no diagnostics at all", () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("models the whole company", () => {
    const program = result.program!;
    expect(program.name).toBe("used_car_escrow");
    expect(program.title).toBe("Used-car escrow");
    expect(
      program.parties.map((party) => `${party.name}:${party.kind}`),
    ).toEqual(["buyer:person", "seller:business"]);
    expect(program.assets).toHaveLength(1);
    expect(program.assets[0]?.titleTransfer).toBe("off_platform");
  });

  it("models the held payment exactly", () => {
    const sale = result.program!.settlements[0]!;
    if (sale.archetype !== "held_payment") {
      throw new Error(`expected held_payment, got ${sale.archetype}`);
    }
    expect(sale.name).toBe("sale");
    expect(sale.payer).toBe("buyer");
    expect(sale.payee).toBe("seller");
    expect(sale.amount).toMatchObject({ currency: "SAR", name: "price" });
    expect(sale.release.port).toBe("confirm_handover");
    expect(sale.fees.map((fee) => `${fee.bearer}:${fee.bps}`)).toEqual([
      "buyer:100",
      "seller:200",
    ]);
    expect(sale.onCancel?.when).toBe("funded");
    expect(
      sale.onCancel?.shares.map((share) => `${share.to}:${share.bps}`),
    ).toEqual(["buyer:9950", "seller:50"]);
  });

  it("models the decision port", () => {
    const port = result.program!.ports[0]!;
    expect(port.name).toBe("confirm_handover");
    expect(port.allowed).toEqual(["buyer"]);
    expect(port.fields).toEqual([
      {
        name: "vehicleId",
        origin: expect.anything(),
        type: { asset: "vehicle", kind: "asset_id" },
      },
    ]);
  });

  it("keeps origin spans pointing at real source", () => {
    const sale = result.program!.settlements[0]!;
    if (sale.archetype !== "held_payment") {
      throw new Error(`expected held_payment, got ${sale.archetype}`);
    }
    expect(FIXTURE.slice(sale.origin.start, sale.origin.end)).toStartWith(
      "settlement sale",
    );
    const split = sale.onCancel!.shares[0]!;
    expect(FIXTURE.slice(split.origin.start, split.origin.end)).toBe(
      "buyer: 99.5%",
    );
  });
});

const PRELUDE = `program p "P"
import { held_payment } from "settlement"
party buyer: person
party seller: business
port ok { allowed: [buyer] }
`;

const sale = (body: string) =>
  `${PRELUDE}settlement sale = held_payment {\n${body}\n}\n`;

const COMPLETE = `payer: buyer
payee: seller
amount: price: money(SAR)
release: port ok`;

describe("checkProgram · settlement surface errors", () => {
  it("accepts the minimal complete settlement", () => {
    const result = check(sale(COMPLETE));
    expect(errors(result)).toEqual([]);
    expect(result.program?.settlements).toHaveLength(1);
  });

  it("refuses payer equal to payee", () => {
    const result = check(
      sale(
        "payer: buyer\npayee: buyer\namount: price: money(SAR)\nrelease: port ok",
      ),
    );
    expect(errors(result).join("\n")).toContain("payer and payee must differ");
  });

  it("names every missing required entry", () => {
    const result = check(sale("payer: buyer"));
    const joined = errors(result).join("\n");
    expect(joined).toContain("missing payee");
    expect(joined).toContain("missing amount");
    expect(joined).toContain("missing release");
  });

  it("refuses an unimported archetype with the import to add", () => {
    const source = `program p "P"
import { held_payment } from "settlement"
party a: person
party b: business
port ok { allowed: [a] }
settlement s = deposit { payer: a, payee: b, amount: x: money(SAR), release: port ok }
`;
    const result = checkProgram(parseProgram(source).program);
    expect(errors(result).join("\n")).toContain(
      'import { deposit } from "settlement"',
    );
  });

  it("holds every archetype to its own parameter surface", () => {
    const source =
      sale(COMPLETE).replace(
        "import { held_payment }",
        "import { held_payment, scheduled }",
      ) +
      `settlement later = scheduled { payer: buyer, payee: seller, amount: x: money(SAR), release: port ok }\n`;
    const result = checkProgram(parseProgram(source).program);
    const messages = errors(result).join("\n");
    expect(messages).toContain(
      'settlement later does not understand "release"',
    );
    expect(messages).toContain("settlement later is missing count");
    expect(messages).toContain("settlement later is missing every");
    expect(messages).toContain("settlement later is missing first_due");
  });

  it("refuses a fee borne by a stranger and a fee of 100%", () => {
    const result = check(
      sale(`${COMPLETE}\nfees { intruder: 1%, seller: 100% }`),
    );
    const joined = errors(result).join("\n");
    expect(joined).toContain("intruder is neither");
    expect(joined).toContain("fees stay under 100%");
  });

  it("refuses a cancellation split that does not conserve", () => {
    const result = check(
      sale(`${COMPLETE}\non_cancel(funded) { buyer: 99.5%, seller: 0.4% }`),
    );
    expect(errors(result).join("\n")).toContain("these shares total 99.9%");
  });

  it("refuses a 0% share: it would lower to a zero-amount movement", () => {
    const result = check(
      sale(`${COMPLETE}\non_cancel(funded) { buyer: 100%, seller: 0% }`),
    );
    expect(errors(result).join("\n")).toContain("the share for seller is 0%");
  });

  it("requires the funded qualifier on on_cancel", () => {
    const result = check(
      sale(`${COMPLETE}\non_cancel { buyer: 99.5%, seller: 0.5% }`),
    );
    expect(errors(result).join("\n")).toContain("on_cancel(funded)");
  });

  it("refuses release through an undeclared port", () => {
    const result = check(
      sale(
        "payer: buyer\npayee: seller\namount: price: money(SAR)\nrelease: port ghost",
      ),
    );
    expect(errors(result).join("\n")).toContain(
      "no port with that name is declared",
    );
  });

  it("refuses a lowercase currency", () => {
    const result = check(
      sale(
        "payer: buyer\npayee: seller\namount: price: money(sar)\nrelease: port ok",
      ),
    );
    expect(errors(result).join("\n")).toContain("three capital letters");
  });

  it("rejects unknown settlement entries with the valid list", () => {
    const result = check(sale(`${COMPLETE}\nvibes: buyer`));
    expect(errors(result).join("\n")).toContain('does not understand "vibes"');
  });
});

describe("checkProgram · namespace and ports", () => {
  it("refuses two declarations sharing a name", () => {
    const source = `program p "P"
party buyer: person
asset buyer: good
`;
    const result = checkProgram(parseProgram(source).program);
    expect(errors(result).join("\n")).toContain("already taken by a party");
  });

  it("requires a program header", () => {
    const result = checkProgram(parseProgram("party buyer: person").program);
    expect(errors(result).join("\n")).toContain("program header");
  });

  it("refuses a port shape field typed to an undeclared asset", () => {
    const source = sale(COMPLETE).replace(
      "port ok { allowed: [buyer] }",
      "port ok { allowed: [buyer], shape: { ghostId: id(ghost) } }",
    );
    const result = checkProgram(parseProgram(source).program);
    expect(errors(result).join("\n")).toContain(
      "id(ghost) points at an asset that is not declared",
    );
  });

  it("refuses decided_by: the tenant backend always decides, so the knob is gone", () => {
    const source = sale(COMPLETE).replace(
      "port ok { allowed: [buyer] }",
      "port ok { decided_by: tenant_backend, allowed: [buyer] }",
    );
    const result = checkProgram(parseProgram(source).program);
    expect(errors(result).join("\n")).toContain(
      'port ok does not understand "decided_by"',
    );
  });
});

describe("checkProgram · lint warnings never block", () => {
  it("warns on an idle party, an unreleased port, and an idle import", () => {
    const source = `program p "P"
import { held_payment, deposit } from "settlement"
party buyer: person
party seller: business
party bystander: person
port ok { allowed: [buyer] }
port silent { allowed: [seller] }
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port ok
}
`;
    const result = checkProgram(parseProgram(source).program);
    expect(errors(result)).toEqual([]);
    const joined = warnings(result).join("\n");
    expect(joined).toContain("party bystander is declared");
    expect(joined).toContain("port silent is declared");
    expect(joined).toContain("deposit is imported but never instantiated");
    expect(result.program).toBeDefined();
  });

  it("warns on a zero fee", () => {
    const result = check(sale(`${COMPLETE}\nfees { buyer: 0% }`));
    expect(errors(result)).toEqual([]);
    expect(warnings(result).join("\n")).toContain("0%");
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/algebra.spec.ts
// --------------------------------------------------------------------------
describe("algebra", () => {
  type Json = Record<string, unknown>;

  const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "fixtures", `${name}.hsx`), "utf8");

  const compiled = (name: string) => {
    const result = compile(fixture(name));
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    return result.artifacts!;
  };

  const nounById = (document: Json, id: string): Json => {
    const noun = (document.nouns as Json[]).find((entry) => entry.id === id);
    expect(noun).toBeDefined();
    return noun!;
  };

  const eventKeys = (frame: Json): string[] =>
    (frame.moneyEvents as Json[]).map((event) => event.key as string);

  const firstMove = (verb: Json): Json => {
    if (!Array.isArray(verb.moves) || !verb.moves[0]) {
      throw new Error("expected verb to contain a move");
    }
    return verb.moves[0] as Json;
  };

  describe("settlement algebra · commerce cooperative", () => {
    const { document, frame } = compiled("commerce-escrow");

    it("compiles the whole company within the money-event budget", () => {
      expect((document.nouns as Json[]).map((noun) => noun.id)).toEqual([
        "checkout",
        "rental_deposit",
        "fulfillment_pool",
      ]);
      expect((frame.moneyEvents as Json[]).length).toBeLessThanOrEqual(12);
      expect(frame.mechanics).toEqual(
        expect.arrayContaining(["marketplace", "escrow"]),
      );
    });

    it("instant transfer: partitioned pass-through with both fee sides", () => {
      const checkout = nounById(document, "checkout");
      const partitions = checkout.partitions as Json[];
      expect(partitions).toEqual([
        { pieces: ["piece1Amount", "piece2Amount"], total: "orderTotal" },
      ]);
      const verbs = checkout.verbs as Json;
      const payPiece = verbs.pay_piece_1 as Json;
      expect(firstMove(payPiece)).toMatchObject({
        amount: "piece1Amount",
        from: "shopper",
        to: "merchant",
      });
      const fee = verbs.collect_service_fee as Json;
      expect(firstMove(fee)).toMatchObject({
        amount: "serviceFeeAmount",
        from: "shopper",
        to: "platform",
      });
      expect(checkout.escrow).toBeUndefined();
    });

    it("deposit: one hold, settled on claim and voided on return", () => {
      const deposit = nounById(document, "rental_deposit");
      const verbs = deposit.verbs as Json;
      expect((verbs.place_deposit as Json).moves).toEqual([
        {
          key: "reservation",
          operation: "reserve",
          amount: "depositAmount",
          from: "shopper",
          to: "merchant",
        },
      ]);
      expect((verbs.assess_damage as Json).moves).toEqual([
        {
          key: "post",
          operation: "post",
          reservation: "place_deposit_reservation",
        },
      ]);
      expect((verbs.release_deposit as Json).moves).toEqual([
        {
          key: "void",
          operation: "void",
          reason: "Deposit returned in full",
          reservation: "place_deposit_reservation",
        },
      ]);
      expect(deposit.partitions).toBeUndefined();
    });

    it("pooled split: per-share escrow funding and due-driven distribution", () => {
      const pool = nounById(document, "fulfillment_pool");
      expect(pool.escrow).toBe(true);
      expect(pool.partitions).toEqual([
        {
          pieces: ["courierShareAmount", "packerShareAmount"],
          total: "poolTotal",
        },
      ]);
      const verbs = pool.verbs as Json;
      expect(firstMove(verbs.fund_share_1 as Json)).toMatchObject({
        amount: "courierShareAmount",
        from: "merchant",
        to: "escrow",
      });
      expect((verbs.distribute_share_1 as Json).due).toEqual({
        field: "payoutDate",
        rule: "fulfillment_pool_payout",
      });
      const rules = frame.rules as Json[];
      const payoutRule = rules.find(
        (rule) => rule.key === "fulfillment_pool_payout",
      );
      expect(payoutRule?.dueDriven).toBe(true);
    });
  });

  describe("settlement algebra · insured car marketplace", () => {
    const { document, frame } = compiled("insured-car-marketplace");

    it("compiles held payment, premium forward, and deposit together", () => {
      expect(eventKeys(frame)).toEqual([
        "sale_fund",
        "sale_release_seller",
        "sale_release_platform",
        "sale_abandon",
        "coverage_fund",
        "coverage_release_insurer",
        "coverage_release_platform",
        "coverage_abandon",
        "test_drive_deposit_hold_1",
      ]);
      expect(frame.mechanics).toEqual(
        expect.arrayContaining(["escrow", "insurance"]),
      );
    });

    it("premium forward: commission carved at forwarding, premium event kind", () => {
      const coverage = nounById(document, "coverage");
      expect(coverage.escrow).toBe(true);
      expect(coverage.partitions).toEqual([
        { pieces: ["piece1Amount", "piece2Amount"], total: "premium" },
      ]);
      const verbs = coverage.verbs as Json;
      expect(firstMove(verbs.confirm_policy as Json)).toMatchObject({
        amount: "piece1Amount",
        from: "escrow",
        to: "insurer",
      });
      expect(firstMove(verbs.forward_piece_2 as Json)).toMatchObject({
        amount: "piece2Amount",
        from: "escrow",
        to: "platform",
      });
      const fund = (frame.moneyEvents as Json[]).find(
        (event) => event.key === "coverage_fund",
      );
      expect(fund?.kind).toBe("premium");
      expect(
        (frame.actors as Json[]).find((actor) => actor.key === "insurer")?.role,
      ).toBe("provider");
    });

    it("held payment without cancellation still partitions the payee fee", () => {
      const sale = nounById(document, "sale");
      expect(sale.partitions).toEqual([
        { pieces: ["piece1Amount", "piece2Amount"], total: "price" },
      ]);
      const verbs = sale.verbs as Json;
      expect(verbs.cancel).toBeUndefined();
      expect(firstMove(verbs.confirm_handover as Json)).toMatchObject({
        amount: "piece1Amount",
        from: "escrow",
        to: "seller",
      });
    });
  });

  describe("settlement algebra · insured travel platform", () => {
    const { document, frame } = compiled("insured-travel");

    it("scheduled: finite unrolled anchors on one due-driven rule", () => {
      const plan = nounById(document, "package_plan");
      expect(plan.partitions).toEqual([
        {
          pieces: [
            "installment1Amount",
            "installment2Amount",
            "installment3Amount",
          ],
          total: "packagePrice",
        },
      ]);
      const verbs = plan.verbs as Json;
      expect((verbs.pay_installment_1 as Json).due).toEqual({
        field: "firstInstallmentDue",
        rule: "package_plan_schedule",
      });
      expect((verbs.pay_installment_2 as Json).due).toEqual({
        field: "firstInstallmentDue",
        offset: "P30D",
        rule: "package_plan_schedule",
      });
      expect((verbs.pay_installment_3 as Json).due).toEqual({
        field: "firstInstallmentDue",
        offset: "P60D",
        rule: "package_plan_schedule",
      });
      const rule = (frame.rules as Json[]).find(
        (entry) => entry.key === "package_plan_schedule",
      );
      expect(rule?.dueDriven).toBe(true);
      expect(rule?.enforcement).toBe("platform");
    });

    it("metered: self-loop repeatable charges on external schedule, due-driven close", () => {
      const extras = nounById(document, "trip_extras");
      const verbs = extras.verbs as Json;
      const charge = verbs.charge_excursion as Json;
      expect(charge.from).toEqual(["open"]);
      expect(charge.to).toBe("open");
      expect(firstMove(charge)).toMatchObject({
        amount: "excursionFee",
        from: "traveler",
        to: "agency",
      });
      expect((verbs.close_period as Json).due).toEqual({
        field: "tripEndDate",
        rule: "trip_extras_period",
      });
      const events = (frame.moneyEvents as Json[]).filter((event) =>
        (event.key as string).startsWith("trip_extras_"),
      );
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.occurrence).toBe("repeatable");
        expect(event.timing).toBe("external_schedule");
      }
    });

    it("advance: repayments conserve against advance plus discount", () => {
      const loan = nounById(document, "agency_advance");
      expect(loan.partitions).toEqual([
        {
          pieces: ["repayment1Amount", "repayment2Amount", "repayment3Amount"],
          total: "repayableAmount",
        },
        { pieces: ["advanceAmount", "feeAmount"], total: "repayableAmount" },
      ]);
      const verbs = loan.verbs as Json;
      expect(firstMove(verbs.disburse as Json)).toMatchObject({
        amount: "advanceAmount",
        from: "lender",
        to: "agency",
      });
      expect((verbs.collect_repayment_2 as Json).due).toEqual({
        field: "firstRepaymentDue",
        offset: "P14D",
        rule: "agency_advance_schedule",
      });
    });
  });

  describe("settlement algebra · single-piece settlements move the amount itself", () => {
    it("a fee-free, cancel-free held payment funds and releases the gross field", () => {
      const result = compile(`program marketplace_order "Marketplace order"
  import { held_payment } from "settlement"
  party buyer: person
  party merchant: business
  settlement order = held_payment {
    payer: buyer
    payee: merchant
    amount: orderTotal: money(SAR)
    release: port approve_delivery
  }
  port approve_delivery { allowed: [buyer] }
  `);
      expect(result.verdict).toBe("valid");
      const order = nounById(result.artifacts!.document as Json, "order");
      expect((order.fields as Json).piece1Amount).toBeUndefined();
      expect(order.partitions).toBeUndefined();
      const verbs = order.verbs as Json;
      expect(firstMove(verbs.fund_piece_1 as Json)).toMatchObject({
        amount: "orderTotal",
        from: "buyer",
        to: "escrow",
      });
      expect(firstMove(verbs.approve_delivery as Json)).toMatchObject({
        amount: "orderTotal",
        from: "escrow",
        to: "merchant",
      });
    });

    it("a fee-free instant transfer pays the amount field through whole", () => {
      const result = compile(`program direct_pay "Direct pay"
  import { instant_transfer } from "settlement"
  party payer_x: person
  party payee_y: business
  settlement wire = instant_transfer {
    payer: payer_x
    payee: payee_y
    amount: total: money(SAR)
  }
  `);
      expect(result.verdict).toBe("valid");
      const wire = nounById(result.artifacts!.document as Json, "wire");
      expect((wire.fields as Json).piece1Amount).toBeUndefined();
      expect(firstMove((wire.verbs as Json).pay_piece_1 as Json)).toMatchObject(
        {
          amount: "total",
          from: "payer_x",
          to: "payee_y",
        },
      );
    });
  });

  describe("settlement algebra · compiler-reserved names and keys", () => {
    const errorsOf = (source: string): string => {
      const result = compile(source);
      expect(result.verdict).toBe("invalid");
      return result.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("\n");
    };

    it("refuses an amount named after a generated field", () => {
      const messages = errorsOf(`program p "P"
  import { held_payment } from "settlement"
  party buyer: person
  party seller: business
  settlement s = held_payment {
    payer: buyer
    payee: seller
    amount: serviceFeeAmount: money(SAR)
    release: port ok
    fees { buyer: 1% }
  }
  port ok { allowed: [buyer] }
  `);
      expect(messages).toContain("reserves that name");
    });

    it("refuses a date field named after a generated installment field", () => {
      const messages = errorsOf(`program p "P"
  import { scheduled } from "settlement"
  party buyer: person
  party seller: business
  settlement s = scheduled {
    payer: buyer
    payee: seller
    amount: total: money(SAR)
    count: 3
    every: P30D
    first_due: installment2Amount
  }
  `);
      expect(messages).toContain("reserves that name");
    });

    it("refuses two settlements whose generated event keys collide", () => {
      const messages = errorsOf(`program keyclash "Key clash"
  import { metered, held_payment } from "settlement"
  party payer_x: person
  party payee_y: business
  settlement a = metered {
    payer: payer_x
    payee: payee_y
    close_by: periodEnd
    rates { b_service_fee: unitFee: money(SAR) }
  }
  settlement a_b = held_payment {
    payer: payer_x
    payee: payee_y
    amount: price: money(SAR)
    release: port ok
    fees { payer_x: 1% }
  }
  port ok { allowed: [payer_x] }
  `);
      expect(messages).toContain("both generate the internal key");
    });
  });

  describe("settlement algebra · remainder routing", () => {
    it("pieceAmounts routes the remainder to the named index and conserves", () => {
      const pieces = [{ bps: 6000 }, { bps: 4000 }];
      const [courier, packer] = pieceAmounts(pieces, 101n, 0);
      expect(courier! + packer!).toBe(101n);
      expect(courier).toBe(61n);
      const [first, second] = pieceAmounts(pieces, 101n, 1);
      expect(first! + second!).toBe(101n);
      expect(second).toBe(41n);
    });
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/carve.spec.ts
// --------------------------------------------------------------------------
describe("carve", () => {
  /**
   * `advance { against: <hold>.release }`, financing carved out of the release
   * it secures. The carve mints nothing: it redirects the financed party's whole
   * release share to the funder and leaves the platform fee, the cancellation
   * split, and the piece partition exactly as they were.
   */

  type Json = Record<string, any>;

  const HOLD = `settlement retention = held_payment {
    payer:  contractor
    payee:  subcontractor
    amount: retainedAmount: money(SAR)
    release: port approve_release | at(defectsPeriodEnd)
    on_cancel(funded) { contractor: 100% }
  }`;

  const FINANCING = `settlement financing = advance {
    funder:  financier
    to:      subcontractor
    amount:  retainedAmount: money(SAR)
    against: retention.release
  }`;

  const RECOURSE = `settlement recourse = scheduled {
    payer:     subcontractor
    payee:     financier
    amount:    retainedAmount: money(SAR)
    count:     3
    every:     P30D
    first_due: recourseFirstDueAt
  }`;

  const ARCHETYPES = ["advance", "held_payment", "scheduled"] as const;

  interface Parts {
    readonly extra?: string;
    readonly financing?: string;
    readonly hold?: string;
    readonly parties?: readonly string[];
    readonly recourse?: string;
  }

  /**
   * Imports are derived from the assembled body so a test can drop a settlement
   * without also tripping the "imported but never instantiated" lint, which
   * would drown the diagnostic the test is actually about.
   */
  const source = (parts: Parts = {}): string => {
    const body = [
      parts.hold ?? HOLD,
      parts.financing ?? FINANCING,
      parts.recourse ?? RECOURSE,
      parts.extra ?? "",
    ]
      .filter((block) => block.length > 0)
      .join("\n\n");
    const imports = ARCHETYPES.filter((archetype) =>
      body.includes(`= ${archetype} {`),
    );
    const parties = parts.parties ?? [
      "contractor",
      "subcontractor",
      "financier",
    ];
    return `program financed_retention "Financed construction retention"

  import { ${imports.join(", ")} } from "settlement"

  ${parties.map((party) => `party ${party}: business`).join("\n")}

  ${body}

  port approve_release { allowed: [contractor] }
  `;
  };

  function compiled(input: string = source()) {
    const result = compile(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const document = result.artifacts.document as Json;
    return {
      document,
      frame: result.artifacts.frame as Json,
      noun: (id: string): Json => {
        const found = (document.nouns as Json[]).find(
          (entry) => entry.id === id,
        );
        if (!found) throw new Error(`no noun ${id} in the lowered document`);
        return found;
      },
    };
  }

  function refusal(input: string): string[] {
    const result = compile(input);
    expect(result.verdict).toBe("invalid");
    return result.diagnostics.map((item) => item.message);
  }

  const moves = (verb: Json): string[] =>
    ((verb.moves ?? []) as Json[]).map(
      (move) => `${move.amount} ${move.from}->${move.to}`,
    );

  const ruleByKey = (frame: Json, key: string): Json => {
    const found = (frame.rules as Json[]).find((rule) => rule.key === key);
    if (!found) throw new Error(`no rule ${key} in the frame`);
    return found;
  };

  describe("advance carved from the release it secures", () => {
    it("parses retention.release as one settlement naming another's exit", () => {
      const parsed = parseProgram(source());
      expect(parsed.diagnostics).toEqual([]);
      const financing = parsed.program.decls.find(
        (decl) => decl.kind === "settlement" && decl.name.name === "financing",
      );
      if (financing?.kind !== "settlement") {
        throw new Error("expected the financing settlement");
      }
      const against = financing.body.entries.find(
        (entry) => entry.key.name === "against",
      );
      expect(against?.value).toMatchObject({
        kind: "settlement_ref",
        member: { name: "release" },
        owner: { name: "retention" },
      });
    });

    it("keeps a fee-free carve on the gross money field", () => {
      const fields = compiled().noun("retention").fields as Json;
      expect(fields.retainedAmount.desc).toBe(
        "The held amount in SAR minor units, funded and paid out whole",
      );
      expect(fields.piece1Amount).toBeUndefined();
    });

    it("releases the financed party's whole share to the funder", () => {
      const retention = compiled().noun("retention");
      const verbs = retention.verbs as Json;
      expect(moves(verbs.approve_release)).toEqual([
        "retainedAmount escrow->financier",
      ]);
      expect(moves(verbs.release_on_deadline)).toEqual([
        "retainedAmount escrow->financier",
      ]);
    });

    it("leaves cancellation and pre-funding abandonment intact", () => {
      const verbs = compiled().noun("retention").verbs as Json;
      expect(moves(verbs.cancel)).toEqual([
        "retainedAmount escrow->contractor",
      ]);
      expect(verbs.abandon.moves).toBeUndefined();
      expect(verbs.abandon.requiresDrainedAccount).toEqual({
        path: "refs.escrowAccountId",
      });
      expect(moves(verbs.fund_piece_1)).toEqual([
        "retainedAmount contractor->escrow",
      ]);
    });

    it("is not a cut point: carved and uncarved holds partition identically", () => {
      const carved = compiled().noun("retention");
      const uncarved = compiled(
        source({
          financing: "",
          parties: ["contractor", "subcontractor"],
          recourse: "",
        }),
      ).noun("retention");
      expect(carved.partitions).toEqual(uncarved.partitions);
      expect(Object.keys(carved.fields)).toEqual(Object.keys(uncarved.fields));
      expect(Object.keys(carved.verbs)).toEqual(Object.keys(uncarved.verbs));
    });

    it("adds the funder as a party and leaves one beneficiary", () => {
      expect(compiled().noun("retention").actors).toEqual({
        contractor: "payer",
        financier: "party",
        platform: "party",
        subcontractor: "beneficiary",
      });
    });

    it("says the funder's name everywhere the release is described", () => {
      const { frame, noun } = compiled();
      expect(noun("retention").fields.defectsPeriodEnd.desc).toBe(
        "The date an undecided hold releases to the financier on; approve_release and cancellation decide only before it",
      );
      expect(ruleByKey(frame, "retention_release_deadline").detail).toBe(
        "A hold nobody decided releases to the financier on its stored defectsPeriodEnd, exactly once",
      );
      expect(frame.summary).toContain(
        "the financier is paid on confirmed release, in the subcontractor's place",
      );
      expect(frame.design).toContain(
        "retention: the subcontractor's whole release share is carved to the financier, who financed it; the platform fee and the cancellation split are untouched",
      );
    });

    it("mints one money event for the advance and no repayment anchors", () => {
      const { frame, noun } = compiled();
      const financing = noun("financing");
      expect(Object.keys(financing.verbs)).toEqual([
        "create",
        "disburse",
        "settle",
      ]);
      expect(Object.keys(financing.fields)).toEqual([
        "retainedAmount",
        "carveHoldId",
        "carveRecourse1Id",
      ]);
      expect(financing.verbs.disburse.requires).toEqual({
        carveHoldId: {
          match: {
            "fields.currency": "fields.currency",
            "fields.retainedAmount": "fields.retainedAmount",
          },
          statuses: ["funded"],
        },
        carveRecourse1Id: {
          match: {
            "fields.currency": "fields.currency",
            "fields.retainedAmount": "fields.retainedAmount",
          },
          statuses: ["active"],
        },
      });
      expect(
        Object.values(financing.verbs as Json).some((verb: Json) => verb.due),
      ).toBe(false);
      expect(
        (frame.moneyEvents as Json[])
          .filter((event) => (event.key as string).startsWith("financing_"))
          .map((event) => `${event.key} ${event.kind}`),
      ).toEqual(["financing_disburse payout"]);
    });

    it("moves the advance to the financed party and closes without money", () => {
      const verbs = compiled().noun("financing").verbs as Json;
      expect(moves(verbs.disburse)).toEqual([
        "retainedAmount financier->subcontractor",
      ]);
      expect(verbs.disburse).toMatchObject({
        from: ["created"],
        to: "advanced",
      });
      expect(verbs.settle).toEqual({
        from: ["advanced"],
        publicIntent: "settleFinancing",
        summary:
          "Close the advance once the retention has released to the financier",
        to: "repaid",
      });
    });

    it("does not invent a repayable total for a fee-free carve", () => {
      expect(compiled().noun("financing").partitions).toBeUndefined();
    });

    it("carries the whole financed program on five money events", () => {
      expect(
        (compiled().frame.moneyEvents as Json[]).map((event) => event.key),
      ).toEqual([
        "retention_fund",
        "retention_release_financier",
        "retention_cancel_contractor",
        "financing_disburse",
        "recourse_installments",
      ]);
    });

    it("leaves the scheduled advance exactly as it was", () => {
      const scheduled = compiled(
        source({
          financing: `settlement financing = advance {
    funder:    financier
    to:        subcontractor
    amount:    advanceAmount: money(SAR)
    fee:       4%
    count:     3
    every:     P2W
    first_due: firstRepaymentDue
  }`,
          recourse: "",
        }),
      );
      const financing = scheduled.noun("financing");
      expect(financing.partitions).toEqual([
        {
          pieces: ["repayment1Amount", "repayment2Amount", "repayment3Amount"],
          total: "repayableAmount",
        },
        { pieces: ["advanceAmount", "feeAmount"], total: "repayableAmount" },
      ]);
      expect((financing.verbs as Json).collect_repayment_2.due).toEqual({
        field: "firstRepaymentDue",
        offset: "P14D",
        rule: "financing_schedule",
      });
      // Uncarved again: the hold pays its own payee.
      expect(
        moves((scheduled.noun("retention").verbs as Json).approve_release),
      ).toEqual(["retainedAmount escrow->subcontractor"]);
    });

    it("compiles the shipped fixture with nothing to say about it", () => {
      const fixture = readFileSync(
        join(import.meta.dir, "fixtures", "financed-retention.hsx"),
        "utf8",
      );
      const result = compile(fixture);
      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
    });
  });

  describe("advance carved from the release it secures · refusals", () => {
    it("takes one repayment source, never two", () => {
      expect(
        refusal(
          source({
            financing: `settlement financing = advance {
    funder:    financier
    to:        subcontractor
    amount:    advanceAmount: money(SAR)
    against:   retention.release
    count:     3
    every:     P2W
    first_due: firstRepaymentDue
  }`,
          }),
        ),
      ).toContain(
        "settlement financing is repaid by a carve and by its own schedule (count, every, first_due); an advance draws on one source",
      );
    });

    it("names both sources when an advance declares neither", () => {
      expect(
        refusal(
          source({
            financing: `settlement financing = advance {
    funder: financier
    to:     subcontractor
    amount: advanceAmount: money(SAR)
  }`,
          }),
        ),
      ).toContain(
        "settlement financing needs a repayment source: against: <hold>.release carves it out of a hold's release, or count + every + first_due collects it on a schedule",
      );
    });

    it("carves a release, not a settlement and not another exit", () => {
      const against = (value: string) =>
        refusal(
          source({
            financing: FINANCING.replace("retention.release", value),
          }),
        );
      expect(against("retention")).toContain(
        "settlement financing draws against a held payment's release, like: against: retention.release",
      );
      expect(against("retention.cancel")).toContain(
        "settlement financing references retention.cancel, but held_payment does not expose that exit; it exposes release",
      );
      expect(against("recourse.release")).toContain(
        "settlement financing references recourse.release, but scheduled does not expose that exit; it exposes obligation",
      );
      expect(against("holdback.release")).toContain(
        "settlement financing references holdback, but no settlement with that name is declared",
      );
      expect(against("contractor.release")).toContain(
        "settlement financing references contractor, which is a party; settlement exits belong to settlements",
      );
    });

    it("carves only the release of the party it finances", () => {
      expect(
        refusal(
          source({
            hold: `settlement retention = held_payment {
    payer:  contractor
    payee:  financier
    amount: retainedAmount: money(SAR)
    release: port approve_release
  }`,
          }),
        ),
      ).toContain(
        "settlement financing advances subcontractor, but retention releases to financier; an advance carves the release of the party it finances",
      );
    });

    it("requires the carve and hold to name the same money field", () => {
      expect(
        refusal(
          source({
            financing: FINANCING.replace(
              "retainedAmount: money(SAR)",
              "advanceAmount: money(SAR)",
            ),
          }),
        ),
      ).toContain(
        "settlement financing advances field advanceAmount, but retention.release carries retainedAmount; a carve must name the same money field",
      );
    });

    it("requires the carve and hold to use one currency", () => {
      expect(
        refusal(
          source({
            financing: FINANCING.replace("money(SAR)", "money(USD)"),
          }),
        ),
      ).toContain(
        "settlement financing advances USD, but retention.release carries SAR; a carve must use one currency",
      );
    });

    it("rejects a fee-bearing carved advance", () => {
      expect(
        refusal(
          source({
            financing: FINANCING.replace(
              "amount:  retainedAmount: money(SAR)",
              "amount:  retainedAmount: money(SAR)\n    fee: 4%",
            ),
          }),
        ),
      ).toContain(
        "settlement financing adds a fee to a carved advance, but retention.release can only prove repayment of the principal field; use a fee-free carve or a scheduled advance",
      );
    });

    it("rejects a carve after the hold deducts a payee fee", () => {
      expect(
        refusal(
          source({
            hold: HOLD.replace(
              "amount: retainedAmount: money(SAR)",
              "amount: retainedAmount: money(SAR)\n    fees { subcontractor: 1.5% }",
            ),
          }),
        ),
      ).toContain(
        "settlement financing carves retention.release after a payee fee reduces it; a carved hold must release the full principal field to the funder",
      );
    });

    it("does not accept loosely matched scheduled recourse", () => {
      expect(
        refusal(
          source({
            recourse: RECOURSE.replace(
              "retainedAmount: money(SAR)",
              "otherAmount: money(SAR)",
            ),
          }),
        ),
      ).toContain(
        "settlement financing has no repayment path when retention is refunded instead of released; add a scheduled settlement collecting from the subcontractor to the financier",
      );
    });

    it("refuses the hold's own payer as the funder its release repays", () => {
      expect(
        refusal(
          source({
            hold: `settlement retention = held_payment {
    payer:  financier
    payee:  subcontractor
    amount: retainedAmount: money(SAR)
    release: port approve_release
  }`,
            parties: ["contractor", "subcontractor", "financier"],
          }),
        ),
      ).toContain(
        "financier funds retention and finances it too; the party who pays the hold cannot be the funder its release repays",
      );
    });

    it("lets one release repay one advance", () => {
      expect(
        refusal(
          source({
            extra: `party bank: business

  settlement second_financing = advance {
    funder:  bank
    to:      subcontractor
    amount:  retainedAmount: money(SAR)
    against: retention.release
  }`,
          }),
        ),
      ).toContain(
        "settlement second_financing and settlement financing both draw against retention; one release repays one advance",
      );
    });

    it("refuses a cancellable hold whose refund leaves the funder unpaid", () => {
      expect(refusal(source({ recourse: "" }))).toContain(
        "settlement financing has no repayment path when retention is refunded instead of released; add a scheduled settlement collecting from the subcontractor to the financier",
      );
    });

    it("only warns when the uncovered exit is abandonment", () => {
      const result = compile(
        source({
          hold: `settlement retention = held_payment {
    payer:  contractor
    payee:  subcontractor
    amount: retainedAmount: money(SAR)
    release: port approve_release
  }`,
          recourse: "",
        }),
      );
      expect(result.verdict).toBe("warning");
      expect(result.diagnostics.map((item) => item.message)).toEqual([
        "settlement financing has no repayment path if retention is abandoned before it funds; add a scheduled settlement collecting from the subcontractor to the financier",
      ]);
      expect(result.artifacts).toBeDefined();
    });
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/swap.spec.ts
// --------------------------------------------------------------------------
describe("swap", () => {
  const source = (dispute = "dispute: port resolve_trade within P14D") => `
  program comic_den "ComicDen"
  import { swap } from "settlement"
  party hind: person
  party tariq: person
  settlement trade = swap {
    between: [hind, tariq]
    amounts { hind: hindPays: money(SAR), tariq: tariqPays: money(SAR) }
    fees { hind: hindFee: money(SAR), tariq: tariqFee: money(SAR) }
    release: port confirm_exchange
    ${dispute}
  }
  port confirm_exchange { allowed: [hind, tariq] }
  port resolve_trade { allowed: [hind, tariq] }
  `;

  function compiledNoun(input: string): Record<string, any> {
    const result = compile(input);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    return (result.artifacts.document.nouns as Record<string, any>[])[0]!;
  }

  describe("swap", () => {
    it("parses the fixed dispute window on the port reference", () => {
      const parsed = parseProgram(source());
      expect(parsed.diagnostics).toEqual([]);
      const settlement = parsed.program.decls.find(
        (decl) => decl.kind === "settlement",
      );
      if (settlement?.kind !== "settlement") {
        throw new Error("expected swap settlement");
      }
      const dispute = settlement.body.entries.find(
        (entry) => entry.key.name === "dispute",
      );
      expect(dispute?.value).toMatchObject({
        kind: "port_ref",
        name: { name: "resolve_trade" },
        within: { name: "P14D" },
      });
    });

    it("lowers every positive-window phase to one grouped verb", () => {
      const noun = compiledNoun(source());
      expect(noun.distinctParties).toBe(true);
      expect(noun.verbs.fund.moves).toHaveLength(4);
      expect(noun.verbs.fund.moves.map((move: any) => move.operation)).toEqual([
        "create",
        "create",
        "create",
        "create",
      ]);
      expect(noun.verbs.release).toMatchObject({
        from: ["funded"],
        port: { allowed: ["hind", "tariq"] },
        setsAt: { field: "clawbackAt", offset: "P14D" },
        to: "released",
      });
      expect(
        noun.verbs.release.moves.map((move: any) => move.operation),
      ).toEqual(["reserve", "reserve"]);
      expect(noun.verbs.post.moves.map((move: any) => move.operation)).toEqual([
        "post",
        "post",
      ]);
      expect(
        noun.verbs.dispute.moves.map((move: any) => move.operation),
      ).toEqual(["void", "void", "create", "create"]);
      expect(noun.verbs.dispute.moves.slice(2)).toMatchObject([
        { clawbackOf: "release_side_a" },
        { clawbackOf: "release_side_b" },
      ]);
      expect(
        Object.keys(noun.verbs).some((verb) => verb.includes("piece")),
      ).toBe(false);
    });

    it("refuses a zero-day dispute declaration with no lifecycle", () => {
      const result = compile(source("dispute: port resolve_trade within P0D"));
      expect(result.verdict).toBe("invalid");
      expect(result.artifacts).toBeUndefined();
      expect(result.diagnostics.map((item) => item.message)).toContain(
        "dispute on settlement trade uses a fixed duration in days or weeks, like P14D; calendar months cannot define an exact money deadline",
      );
    });

    it("refuses missing legs, mixed currencies, and calendar windows", () => {
      for (const [needle, mutation] of [
        [
          "exactly one funded amount for tariq",
          "amounts { hind: hindPays: money(SAR) }",
        ],
        [
          "both amounts need one currency",
          "amounts { hind: hindPays: money(SAR), tariq: tariqPays: money(USD) }",
        ],
        [
          "fixed duration in days or weeks",
          "dispute: port resolve_trade within P1M",
        ],
      ] as const) {
        const result = compile(
          source()
            .replace(
              "amounts { hind: hindPays: money(SAR), tariq: tariqPays: money(SAR) }",
              mutation.startsWith("amounts")
                ? mutation
                : "amounts { hind: hindPays: money(SAR), tariq: tariqPays: money(SAR) }",
            )
            .replace(
              "dispute: port resolve_trade within P14D",
              mutation.startsWith("dispute")
                ? mutation
                : "dispute: port resolve_trade within P14D",
            ),
        );
        expect(result.verdict).toBe("invalid");
        expect(
          result.diagnostics.some((item) => item.message.includes(needle)),
        ).toBe(true);
      }
    });

    it("refuses percentage fees and decision actors outside the trade", () => {
      const percentage = compile(
        source().replace(
          "fees { hind: hindFee: money(SAR), tariq: tariqFee: money(SAR) }",
          "fees { hind: 2% }",
        ),
      );
      expect(percentage.verdict).toBe("invalid");
      expect(
        percentage.diagnostics.some((item) =>
          item.message.includes("typed field"),
        ),
      ).toBe(true);

      const invalidActor = compile(
        source()
          .replace(
            "party tariq: person",
            "party tariq: person\nparty mediator: business",
          )
          .replace(
            "port confirm_exchange { allowed: [hind, tariq] }",
            "port confirm_exchange { allowed: [mediator] }",
          ),
      );
      expect(invalidActor.verdict).toBe("invalid");
      expect(invalidActor.diagnostics.map((item) => item.message)).toContain(
        "swap trade release port confirm_exchange allows mediator, but whole-trade decisions belong only to hind or tariq",
      );
    });
  });
});
