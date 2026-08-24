import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.ts";
import { checkProgram, parseProgram } from "../src/index.ts";
import { lowerProgram, pieceAmounts } from "../src/lower.ts";
import { lineColAt } from "../src/index.ts";
import { lineColIn, lineIndex } from "../src/ast.ts";
import { HSX_LIMITS } from "../src/limits.ts";
import type {
  BlockExpr,
  CallExpr,
  ListExpr,
  PercentExpr,
  PortDecl,
  PortRefExpr,
  SettlementDecl,
} from "../src/index.ts";
import { percentToBps } from "../src/parse.ts";

const FIXTURE = readFileSync(
  join(import.meta.dir, "fixtures", "car-escrow.hsx"),
  "utf8",
);

describe("compile · three verdicts", () => {
  it("compiles the car escrow one-shot into its exact nouns and money events", () => {
    const result = compile(FIXTURE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toBeDefined();
    // `toBeDefined()` passed on an empty document and an empty frame alike --
    // a lowering that emitted nothing at all still looked like a green
    // compile. Pin what the acceptance program actually compiles TO: one
    // escrow noun named after the settlement (grounding law: settlement names
    // are the published noun ids), and the grouped per-recipient money events
    // in their emitted order.
    const nouns = result.artifacts!.document.nouns as {
      escrow?: boolean;
      id: string;
    }[];
    expect(nouns.map((noun) => noun.id)).toEqual(["sale"]);
    expect(nouns[0]!.escrow).toBe(true);
    const events = result.artifacts!.frame.moneyEvents as { key: string }[];
    expect(events.map((event) => event.key)).toEqual([
      "sale_fund",
      "sale_service_fee",
      "sale_release_seller",
      "sale_release_platform",
      "sale_cancel_buyer",
      "sale_cancel_seller",
      "sale_abandon",
    ]);
  });

  it("returns warning with artifacts when only lint notes exist", () => {
    const result = compile(`program lintful "Lintful"
import { held_payment } from "settlement"
party payer_side: person
party payee_side: business
party bystander: person
settlement pay = held_payment {
  payer: payer_side
  payee: payee_side
  amount: total: money(SAR)
  release: port approve
}
port approve { allowed: [payer_side] }
`);
    expect(result.verdict).toBe("warning");
    expect(result.artifacts).toBeDefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(
      result.diagnostics.every(
        (diagnostic) =>
          diagnostic.severity === "warning" && diagnostic.stage === "check",
      ),
    ).toBe(true);
    // The lint note anchors at the idle party's declaration on line 5.
    expect(result.diagnostics.some((d) => d.line === 5 && d.column >= 1)).toBe(
      true,
    );
  });

  it("returns invalid with source-anchored parse diagnostics", () => {
    const result = compile(`program broken "Broken"
import { held_payment } from "settlement"
party buyer person
`);
    expect(result.verdict).toBe("invalid");
    expect(result.artifacts).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const first = result.diagnostics[0]!;
    expect(first.stage).toBe("parse");
    expect(first.severity).toBe("error");
    expect(first.line).toBe(3);
  });

  it("returns invalid on check errors, keeping the source line", () => {
    const result = compile(`program bad "Bad"
import { held_payment } from "settlement"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  on_cancel(funded) { buyer: 60%, seller: 30% }
  release: port approve
}
port approve { allowed: [buyer] }
`);
    expect(result.verdict).toBe("invalid");
    expect(result.artifacts).toBeUndefined();
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.stage).toBe("check");
    expect(errors[0]!.line).toBe(9);
  });

  it("returns invalid when lowering refuses the frame capacity", () => {
    const settlement = (
      name: string,
      port: string,
      field: string,
    ) => `settlement ${name} = held_payment {
  payer: buyer
  payee: seller
  amount: ${field}: money(SAR)
  fees { buyer: 1%, seller: 2% }
  on_cancel(funded) { buyer: 99.5%, seller: 0.5% }
  release: port ${port}
}
port ${port} { allowed: [buyer] }
`;
    const result = compile(`program big "Big"
import { held_payment } from "settlement"
party buyer: person
party seller: business
${settlement("one", "gate_one", "priceOne")}
${settlement("two", "gate_two", "priceTwo")}
${settlement("three", "gate_three", "priceThree")}
`);
    expect(result.verdict).toBe("invalid");
    expect(result.artifacts).toBeUndefined();
    const first = result.diagnostics[0]!;
    expect(first.stage).toBe("lower");
    expect(first.message).toContain("at most 14");
    expect(first.line).toBeGreaterThan(1);
  });

  it("a port is only allowed and shape; decided_by is not part of the language", () => {
    const result = compile(`program terse "Terse port"
import { held_payment } from "settlement"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port confirm
}
port confirm { allowed: [buyer] }
`);
    expect(result.verdict).toBe("valid");
    const removed = compile(`program removed "Removed knob"
import { held_payment } from "settlement"
party buyer: person
party seller: business
settlement sale = held_payment {
  payer: buyer
  payee: seller
  amount: price: money(SAR)
  release: port confirm
}
port confirm { decided_by: tenant_backend, allowed: [buyer] }
`);
    expect(removed.verdict).toBe("invalid");
    expect(
      removed.diagnostics.some((d) =>
        d.message.includes('does not understand "decided_by"'),
      ),
    ).toBe(true);
  });
});

describe("compile · frame key budget", () => {
  // Live composer regression (tutoring run, 2026-07-21): grounding-law noun
  // ids are long ("sale_settlement"), so a composed rule key like
  // `${noun}_${port}_gate` overflowed the 40-char frame key budget and the
  // engine rejected the compiler's own frame as an internal fault. Every
  // composed key and cross-reference must fit the budget and stay congruent.
  const FRAME_KEY = /^[a-z][a-z0-9_]{0,39}$/;

  it("clamps composed keys to the contracts key budget, congruently", () => {
    const result =
      compile(`program tutoring_marketplace "Tutoring marketplace payments"
import { held_payment } from "settlement"
party parent: person
party tutor: business
settlement sale_settlement = held_payment {
  payer: parent
  payee: tutor
  amount: bookingPrice: money(SAR)
  release: port approve_tutor_payment
  on_cancel(funded) { parent: 100% }
}
port approve_tutor_payment { allowed: [parent] }
`);
    expect(result.verdict).toBe("valid");
    const frame = result.artifacts!.frame as {
      moneyEvents: { key: string }[];
      rules: { key: string; gatesEvent: string | null }[];
    };
    // Calibration first: both loops below iterate emitted collections, so a
    // lowering that emitted no events and no rules would satisfy every
    // assertion in them without ever checking a key.
    expect(frame.moneyEvents.length).toBeGreaterThan(0);
    expect(frame.rules.length).toBeGreaterThan(0);

    const eventKeys = new Set(frame.moneyEvents.map((event) => event.key));
    // Keys are identities: two events sharing one key is a collision the
    // clamping introduced, and the congruence check below would not see it.
    expect(eventKeys.size).toBe(frame.moneyEvents.length);
    for (const event of frame.moneyEvents) {
      expect(event.key).toMatch(FRAME_KEY);
    }
    const gating = frame.rules.filter((rule) => rule.gatesEvent !== null);
    // At least one rule really points at an event, otherwise the congruence
    // arm of this proof never runs -- which is exactly the regression class.
    expect(gating.length).toBeGreaterThan(0);
    for (const rule of frame.rules) {
      expect(rule.key).toMatch(FRAME_KEY);
      if (rule.gatesEvent !== null) {
        expect(eventKeys.has(rule.gatesEvent)).toBe(true);
      }
    }
  });
});

describe("compile · frame prose budget", () => {
  // Live composer regression (rental run, 2026-07-21): the deposit
  // archetype's design line embeds settlement, field, and port names, and
  // the composition overflowed the 160-char frame prose budget, and the engine
  // rejected the compiler's own frame as an internal fault. Every prose
  // field in the emitted frame must fit the schema budget.
  it("clamps composed prose to the 160-char schema budget", () => {
    const result =
      compile(`program camera_gear_rental "Camera gear rental payments"
import { held_payment, deposit } from "settlement"
party renter: person
party gear_provider: business
party platform_business: business
settlement sale_settlement = held_payment {
  payer: renter
  payee: gear_provider
  amount: rentalPrice: money(SAR)
  release: port approve_rental_settlement
  on_cancel(funded) { renter: 100% }
}
settlement escrow_order = deposit {
  payer: renter
  holder: gear_provider
  amount: securityDeposit: money(SAR)
  claim: port claim_full_deposit
  return: port return_full_deposit
}
port approve_rental_settlement { allowed: [platform_business] }
port claim_full_deposit { allowed: [gear_provider] }
port return_full_deposit { allowed: [gear_provider] }
`);
    expect(result.verdict).toBe("valid");
    const seen: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") seen.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object")
        Object.values(value).forEach(walk);
    };
    walk(result.artifacts!.frame);
    // A walker that stopped descending would collect nothing and pass this
    // loop while proving no string at all fits the budget.
    expect(seen.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...seen.map((text) => text.length))).toBeGreaterThan(60);
    for (const text of seen) {
      expect(text.length).toBeLessThanOrEqual(160);
    }

    // The design lines are the field the regression came from, so assert them
    // by path rather than trusting the generic walk to have reached them: a
    // two-settlement composition emits one line per settlement, and at least
    // one of them is long enough that the clamp actually fires.
    const design = (result.artifacts!.frame as { design: string[] }).design;
    expect(design.length).toBeGreaterThanOrEqual(2);
    for (const line of design) {
      expect(line.length).toBeLessThanOrEqual(160);
    }
    expect(
      design.some((line) => line.length === 160 && line.endsWith("...")),
    ).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/lower.spec.ts
// --------------------------------------------------------------------------
describe("lower", () => {
  const FIXTURE = readFileSync(
    join(import.meta.dir, "fixtures", "car-escrow.hsx"),
    "utf8",
  );

  const lowerSource = (source: string) => {
    const parsed = parseProgram(source);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    return lowerProgram(checked.program!);
  };

  describe("lowerProgram · car-escrow partition", () => {
    const result = lowerSource(FIXTURE);
    if (!result.ok) throw new Error("car escrow must lower");
    const sale = result.value.settlements[0]!;

    it("computes the finest common partition of both exits", () => {
      // Release cuts at 98% (2% seller fee); cancel cuts at 99.5%.
      expect(
        sale.pieces.map(
          (piece) => `${piece.bps}:${piece.releaseTo}:${piece.cancelTo ?? "-"}`,
        ),
      ).toEqual([
        "9800:seller:buyer",
        "150:platform:buyer",
        "50:platform:seller",
      ]);
      expect(sale.serviceFee).toEqual({ bps: 100, field: "serviceFeeAmount" });
    });

    it("emits one noun whose every exit drains every piece", () => {
      const document = result.value.document;
      const noun = (document.nouns as Record<string, unknown>[])[0]!;
      const verbs = noun.verbs as Record<
        string,
        {
          moves?: readonly {
            amount: string;
            from: string;
            key: string;
            operation: string;
            to: string;
          }[];
          from?: string[];
          to?: string;
        }
      >;
      expect(noun.escrow).toBe(true);

      const inflows = Object.values(verbs)
        .filter((verb) => verb.moves?.[0]?.to === "escrow")
        .map((verb) => verb.moves![0]!.amount)
        .sort();
      const releaseOutflows = [
        "confirm_handover",
        "release_piece_2",
        "release_piece_3",
      ]
        .map((name) => verbs[name]!.moves![0]!.amount)
        .sort();
      const cancelOutflows = ["cancel", "refund_piece_2", "refund_piece_3"]
        .map((name) => verbs[name]!.moves![0]!.amount)
        .sort();
      expect(inflows).toEqual(["piece1Amount", "piece2Amount", "piece3Amount"]);
      expect(releaseOutflows).toEqual(inflows);
      expect(cancelOutflows).toEqual(inflows);

      // The service fee never enters escrow: straight to the platform.
      expect(verbs.collect_service_fee!.moves![0]).toMatchObject({
        amount: "serviceFeeAmount",
        from: "buyer",
        to: "platform",
      });

      // The release chain starts at the port's verb, gated by the tenant backend.
      expect(verbs.confirm_handover!.from).toEqual(["funded"]);
      expect(verbs.confirm_handover!.moves![0]).toMatchObject({
        from: "escrow",
        to: "seller",
      });
    });

    it("admits abandonment from every pre-funded state, refunding exactly the held pieces", () => {
      const document = result.value.document;
      const noun = (document.nouns as Record<string, unknown>[])[0]!;
      const verbs = noun.verbs as Record<
        string,
        {
          moves?: readonly {
            amount: string;
            from: string;
            key: string;
            operation: string;
            to: string;
          }[];
          from?: string[];
          to?: string;
        }
      >;

      // `created` holds nothing, so it closes directly with no money movement.
      expect(verbs.abandon).toMatchObject({
        from: ["created"],
        to: "abandoned",
      });
      expect(verbs.abandon!.moves?.[0]).toBeUndefined();

      // funding_k holds pieces 1..k; each unfund returns exactly the piece its
      // funding verb moved, back to the buyer, through acyclic abandoning states.
      expect(verbs.unfund_piece_3).toMatchObject({
        from: ["funding_3"],
        moves: [
          {
            key: "transfer",
            operation: "create",
            amount: "piece3Amount",
            from: "escrow",
            to: "buyer",
          },
        ],
        to: "abandoning_2",
      });
      expect(verbs.unfund_piece_2).toMatchObject({
        from: ["funding_2", "abandoning_2"],
        moves: [
          {
            key: "transfer",
            operation: "create",
            amount: "piece2Amount",
            from: "escrow",
            to: "buyer",
          },
        ],
        to: "abandoning_1",
      });
      expect(verbs.unfund_piece_1).toMatchObject({
        from: ["funding_1", "abandoning_1"],
        moves: [
          {
            key: "transfer",
            operation: "create",
            amount: "piece1Amount",
            from: "escrow",
            to: "buyer",
          },
        ],
        to: "abandoned",
      });

      // The service fee moves only on the transition INTO funded, so no
      // abandonment path ever touches it: the fee is owed exactly when
      // collection completes, never as the price of getting a refund.
      const abandonmentVerbs = [
        "abandon",
        "unfund_piece_1",
        "unfund_piece_2",
        "unfund_piece_3",
      ];
      for (const name of abandonmentVerbs) {
        expect(verbs[name]!.moves?.[0]?.amount).not.toBe("serviceFeeAmount");
      }
    });

    it("emits a congruent frame: one money event per behavior, grouped by recipient", () => {
      const frame = result.value.frame;
      const events = frame.moneyEvents as {
        key: string;
        kind: string;
        occurrence: string;
      }[];
      // fund + fee + release{seller, platform} + cancel{buyer, seller} +
      // abandonment refund: the three pieces collapse into per-recipient
      // events, not per-piece ones.
      expect(events.map((event) => event.key)).toEqual([
        "sale_fund",
        "sale_service_fee",
        "sale_release_seller",
        "sale_release_platform",
        "sale_cancel_buyer",
        "sale_cancel_seller",
        "sale_abandon",
      ]);
      expect(events.every((event) => event.kind.length > 0)).toBe(true);
      expect(events.filter((event) => event.kind === "refund")).toHaveLength(2);
      expect(events.filter((event) => event.kind === "penalty")).toHaveLength(
        1,
      );
      // Grouped events (several pieces, one key) are repeatable; single-piece
      // events stay one-shot.
      const occurrence = Object.fromEntries(
        events.map((event) => [event.key, event.occurrence]),
      );
      expect(occurrence.sale_fund).toBe("repeatable");
      expect(occurrence.sale_release_platform).toBe("repeatable");
      expect(occurrence.sale_release_seller).toBe("once");
      expect(occurrence.sale_cancel_buyer).toBe("repeatable");
      expect(occurrence.sale_cancel_seller).toBe("once");
      expect(occurrence.sale_abandon).toBe("repeatable");

      const rules = frame.rules as Record<string, unknown>[];
      expect(rules).toEqual([
        expect.objectContaining({
          allowedActors: ["buyer"],
          enforcement: "tenant_app",
          gatesEvent: "sale_release_seller",
          kind: "release_condition",
        }),
      ]);
      expect(frame.feePolicy).toBe("defined");
      expect(frame.fees).toHaveLength(2);
      expect(frame.offPlatform).toHaveLength(1);
    });
  });

  describe("pieceAmounts · integer conservation", () => {
    const PIECES = [{ bps: 9800 }, { bps: 150 }, { bps: 50 }];

    it("sums exactly to the amount for every price, remainder to piece 1", () => {
      // Deterministic pseudo-random sweep: conservation must hold everywhere.
      let seed = 0x2f6e2b1n;
      const next = (): bigint => {
        seed =
          (seed * 6364136223846793005n + 1442695040888963407n) &
          ((1n << 63n) - 1n);
        return seed % 10_000_000_000n;
      };
      for (let round = 0; round < 500; round += 1) {
        const price = next();
        const amounts = pieceAmounts(PIECES, price);
        const total = amounts.reduce((sum, value) => sum + value, 0n);
        expect(total).toBe(price);
        expect(amounts.every((value) => value >= 0n)).toBe(true);
        expect(amounts[1]).toBe((price * 150n) / 10_000n);
        expect(amounts[2]).toBe((price * 50n) / 10_000n);
      }
    });

    it("handles the degenerate amounts", () => {
      expect(pieceAmounts(PIECES, 0n)).toEqual([0n, 0n, 0n]);
      expect(pieceAmounts(PIECES, 1n)).toEqual([1n, 0n, 0n]);
      expect(pieceAmounts(PIECES, 10_000n)).toEqual([9800n, 150n, 50n]);
      expect(pieceAmounts([], 5n)).toEqual([]);
    });
  });

  describe("lowerProgram · shapes without optional terms", () => {
    it("lowers a fee-free, non-cancellable settlement to one piece per exit", () => {
      const result = lowerSource(`program simple "Simple"
  import { held_payment } from "settlement"
  party payer_side: person
  party payee_side: business
  settlement pay = held_payment {
    payer: payer_side
    payee: payee_side
    amount: total: money(SAR)
    release: port approve
  }
  port approve { allowed: [payer_side] }
  `);
      if (!result.ok) throw new Error("must lower");
      const pay = result.value.settlements[0]!;
      expect(pay.pieces).toHaveLength(1);
      expect(pay.pieces[0]).toMatchObject({
        bps: 10_000,
        releaseTo: "payee_side",
      });
      expect(pay.serviceFee).toBeUndefined();
      const frame = result.value.frame;
      expect(frame.feePolicy).toBe("none");
      const noun = (
        result.value.document.nouns as Record<string, unknown>[]
      )[0]!;
      // Single piece, no fee: funding is one step (created -> funded), so the
      // only pre-funded state is `created` and abandonment needs no unwind.
      expect(Object.keys(noun.verbs as object).sort()).toEqual([
        "abandon",
        "approve",
        "create",
        "fund_piece_1",
      ]);
    });

    it("refuses a program that would exceed the frame's money-event capacity", () => {
      const settlementBlock = (
        name: string,
        portName: string,
      ) => `settlement ${name} = held_payment {
    payer: buyer
    payee: seller
    amount: amt${name.length}: money(SAR)
    fees { buyer: 1%, seller: 2% }
    on_cancel(funded) { buyer: 99.5%, seller: 0.5% }
    release: port ${portName}
  }
  port ${portName} { allowed: [buyer] }
  `;
      // Each full settlement costs 7 events under grouped accounting (fund,
      // fee, 2 release groups, 2 cancel groups, abandonment refund): two of
      // them = 14 fit exactly; three = 21 > 14.
      const twoSettlements = lowerSource(`program two "Two"
  import { held_payment } from "settlement"
  party buyer: person
  party seller: business
  ${settlementBlock("one", "gate_one")}
  ${settlementBlock("two", "gate_two")}
  `);
      expect(twoSettlements.ok).toBe(true);
      const result = lowerSource(`program big "Big"
  import { held_payment } from "settlement"
  party buyer: person
  party seller: business
  ${settlementBlock("one", "gate_one")}
  ${settlementBlock("two", "gate_two")}
  ${settlementBlock("three", "gate_three")}
  `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0]?.message).toContain("at most 14");
    });
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/parse.spec.ts
// --------------------------------------------------------------------------
describe("parse", () => {
  const FIXTURE = readFileSync(
    join(import.meta.dir, "fixtures", "car-escrow.hsx"),
    "utf8",
  );

  const entryValue = (block: BlockExpr, key: string) => {
    const entry = block.entries.find((candidate) => candidate.key.name === key);
    if (!entry) throw new Error(`fixture block is missing entry ${key}`);
    return entry;
  };

  describe("parseProgram · car-escrow golden fixture", () => {
    const { diagnostics, program } = parseProgram(FIXTURE);

    it("parses cleanly", () => {
      expect(diagnostics).toEqual([]);
    });

    it("reads the full declaration skeleton in order", () => {
      expect(program.decls.map((decl) => decl.kind)).toEqual([
        "program",
        "import",
        "party",
        "party",
        "asset",
        "settlement",
        "port",
      ]);
    });

    it("names the program and its title", () => {
      const header = program.decls[0];
      if (header?.kind !== "program") throw new Error("expected program decl");
      expect(header.name.name).toBe("used_car_escrow");
      expect(header.title?.value).toBe("Used-car escrow");
    });

    it("imports held_payment from the settlement stdlib", () => {
      const importDecl = program.decls[1];
      if (importDecl?.kind !== "import")
        throw new Error("expected import decl");
      expect(importDecl.names.map((name) => name.name)).toEqual([
        "held_payment",
      ]);
      expect(importDecl.from.value).toBe("settlement");
    });

    it("declares both parties and the off-platform asset", () => {
      const [buyer, seller] = program.decls.filter(
        (decl) => decl.kind === "party",
      );
      expect(buyer?.name.name).toBe("buyer");
      expect(buyer?.partyKind.name).toBe("person");
      expect(seller?.name.name).toBe("seller");
      expect(seller?.partyKind.name).toBe("business");

      const asset = program.decls.find((decl) => decl.kind === "asset");
      expect(asset?.name.name).toBe("vehicle");
      expect(asset?.assetKind.name).toBe("good");
      const transfer = entryValue(asset!.attrs!, "title_transfer").value;
      expect(transfer.kind).toBe("ident");
      if (transfer.kind === "ident") {
        expect(transfer.name).toBe("off_platform");
      }
    });

    it("instantiates held_payment with the typed amount binding", () => {
      const sale = program.decls.find(
        (decl): decl is SettlementDecl => decl.kind === "settlement",
      );
      if (!sale) throw new Error("expected settlement decl");
      expect(sale.name.name).toBe("sale");
      expect(sale.archetype.name).toBe("held_payment");

      const amount = entryValue(sale.body, "amount").value;
      if (amount.kind !== "binding")
        throw new Error("amount must be a binding");
      expect(amount.name.name).toBe("price");
      const type = amount.type as CallExpr;
      expect(type.kind).toBe("call");
      expect(type.callee.name).toBe("money");
      expect(
        type.args.map((arg) => (arg.kind === "ident" ? arg.name : "")),
      ).toEqual(["SAR"]);
    });

    it("routes release through the decision port", () => {
      const sale = program.decls.find(
        (decl): decl is SettlementDecl => decl.kind === "settlement",
      );
      const release = entryValue(sale!.body, "release").value as PortRefExpr;
      expect(release.kind).toBe("port_ref");
      expect(release.name.name).toBe("confirm_handover");
    });

    it("carries the fee and cancellation percents as exact basis points", () => {
      const sale = program.decls.find(
        (decl): decl is SettlementDecl => decl.kind === "settlement",
      );
      const fees = entryValue(sale!.body, "fees").value as BlockExpr;
      expect((entryValue(fees, "buyer").value as PercentExpr).bps).toBe(100);
      expect((entryValue(fees, "seller").value as PercentExpr).bps).toBe(200);

      const onCancel = entryValue(sale!.body, "on_cancel");
      expect(onCancel.qualifiers.map((qualifier) => qualifier.name)).toEqual([
        "funded",
      ]);
      const split = onCancel.value as BlockExpr;
      expect((entryValue(split, "buyer").value as PercentExpr).bps).toBe(9950);
      expect((entryValue(split, "seller").value as PercentExpr).bps).toBe(50);
    });

    it("declares the buyer-only port with its typed shape", () => {
      const port = program.decls.find(
        (decl): decl is PortDecl => decl.kind === "port",
      );
      if (!port) throw new Error("expected port decl");
      expect(port.name.name).toBe("confirm_handover");

      const allowed = entryValue(port.body, "allowed").value as ListExpr;
      expect(allowed.kind).toBe("list");
      expect(
        allowed.items.map((item) => (item.kind === "ident" ? item.name : "")),
      ).toEqual(["buyer"]);

      const shape = entryValue(port.body, "shape").value as BlockExpr;
      const vehicleId = entryValue(shape, "vehicleId").value as CallExpr;
      expect(vehicleId.callee.name).toBe("id");
      expect(
        vehicleId.args.map((arg) => (arg.kind === "ident" ? arg.name : "")),
      ).toEqual(["vehicle"]);
    });

    it("anchors every declaration to real source text", () => {
      for (const decl of program.decls) {
        const text = FIXTURE.slice(decl.span.start, decl.span.end);
        expect(text.length).toBeGreaterThan(0);
        expect(decl.span.end).toBeGreaterThan(decl.span.start);
      }
      const sale = program.decls.find((decl) => decl.kind === "settlement");
      expect(FIXTURE.slice(sale!.span.start, sale!.span.end)).toStartWith(
        "settlement sale = held_payment",
      );
      expect(lineColAt(FIXTURE, sale!.span.start).line).toBe(14);
    });

    // `compile` resolves diagnostic coordinates through the index, everything
    // else through `lineColAt`. If the two ever disagree, a diagnostic points
    // at a different line than the AST says it does, so pin them together
    // over every offset of a real fixture plus both out-of-range clamps.
    it("resolves every offset the same through the index as through lineColAt", () => {
      const index = lineIndex(FIXTURE);
      for (let offset = -1; offset <= FIXTURE.length + 1; offset += 1) {
        expect(lineColIn(index, offset)).toEqual(lineColAt(FIXTURE, offset));
      }
    });
  });

  describe("parseProgram · diagnostics", () => {
    it("refuses a percent finer than a basis point, at its span", () => {
      const source = "settlement s = x { fee: 1.005% }";
      const { diagnostics } = parseProgram(source);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toContain("basis point");
      expect(
        source.slice(diagnostics[0]!.span.start, diagnostics[0]!.span.end),
      ).toBe("1.005%");
    });

    it("reports an unterminated string without dying", () => {
      const { diagnostics } = parseProgram('program p "never closes');
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes("never closes"),
        ),
      ).toBe(true);
    });

    it("recovers after a broken declaration and still parses the rest", () => {
      const source = "import broken\nparty buyer: person\n";
      const { diagnostics, program } = parseProgram(source);
      expect(diagnostics.length).toBeGreaterThan(0);
      const party = program.decls.find((decl) => decl.kind === "party");
      expect(party?.name.name).toBe("buyer");
    });

    it("recovers inside a block after a bad entry", () => {
      const source = "port p { gate: %, allowed: [buyer] }";
      const { diagnostics, program } = parseProgram(source);
      expect(diagnostics.length).toBeGreaterThan(0);
      const port = program.decls.find(
        (decl): decl is PortDecl => decl.kind === "port",
      );
      const allowed = port?.body.entries.find(
        (entry) => entry.key.name === "allowed",
      );
      expect(allowed).toBeDefined();
    });

    it("terminates on a keyword used as an entry key (from/to inside a body)", () => {
      // Live composer regression (gym r5, 2026-07-21): the model authored
      // `from member` / `to gym` inside a scheduled settlement body. `from`
      // lexes as a keyword, so parseEntry consumed nothing and recoverInBlock
      // bailed at the depth-0 keyword, so parseBlock spun forever and wedged
      // the engine's request loop. Parsing must stay total AND terminating.
      const source = [
        'program fixed_term_gym "Fixed-term gym memberships"',
        'import { scheduled } from "settlement"',
        "party member: person",
        "party gym: business",
        "settlement membership_payment = scheduled {",
        "  from member",
        "  to gym",
        '  amount "Stored installment amount"',
        "  count 12",
        "  every 100 days",
        "}",
      ].join("\n");
      const { diagnostics } = parseProgram(source);
      expect(diagnostics.length).toBeGreaterThan(0);
    });

    it("explains an entry with no value in the author's terms", () => {
      const { diagnostics } = parseProgram("port p { allowed }");
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes('either "allowed: <value>"'),
        ),
      ).toBe(true);
    });

    it("flags characters outside the language", () => {
      const { diagnostics } = parseProgram("party buyer: person @!");
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.message.includes("not part of the HSX language"),
        ),
      ).toBe(true);
    });
  });

  describe("parseProgram · limits", () => {
    // A port body is level 1 and its shape block is level 2, so the value of
    // `x` opens at level 3 and the deepest list that still fits the ceiling
    // is maxNestingDepth - 2.
    const nestedList = (depth: number): string =>
      `port p { shape { x: ${"[".repeat(depth)}${"]".repeat(depth)} } }`;

    it("parses a nesting that lands exactly on the ceiling", () => {
      const { diagnostics } = parseProgram(
        nestedList(HSX_LIMITS.maxNestingDepth - 2),
      );
      expect(diagnostics).toEqual([]);
    });

    // The refusal is the first diagnostic; the rest are ordinary recovery
    // noise from the unread tail, one per token the block walks over.
    it("refuses one level past the ceiling", () => {
      const { diagnostics } = parseProgram(
        nestedList(HSX_LIMITS.maxNestingDepth - 1),
      );
      expect(diagnostics[0]?.message).toContain("depth budget of 64");
    });

    // The budget counts parser steps, and `key: { ... }` spends two of them
    // per source level where `key { ... }` spends one. Pinned because the
    // reference table quotes these numbers to builders.
    it("buys fewer source levels for the form that costs two steps", () => {
      const deepest = (build: (levels: number) => string): number => {
        let last = 0;
        for (let levels = 1; levels <= 200; levels += 1) {
          const refused = parseProgram(build(levels)).diagnostics.some(
            (diagnostic) => diagnostic.message.includes("depth budget"),
          );
          if (refused) break;
          last = levels;
        }
        return last;
      };
      expect(
        deepest((n) => `port p { shape ${"{ k ".repeat(n)}${"}".repeat(n)} }`),
      ).toBe(63);
      expect(
        deepest(
          (n) => `port p { shape ${"{ k: ".repeat(n)}text${" }".repeat(n)} }`,
        ),
      ).toBe(31);
    });

    // SECURITY.md: "Parsing and checking are total by design: they return
    // diagnostics, they never throw." Before the ceiling, each of these
    // exhausted the call stack somewhere between 9,000 and 20,000 levels and
    // threw a RangeError out of compile().
    it("returns a verdict instead of throwing on every recursive production", () => {
      const deep = 50_000;
      const shapes = [
        `port p { shape { x: ${"[".repeat(deep)}${"]".repeat(deep)} } }`,
        `port p { shape { x: ${"x: ".repeat(deep)}text } }`,
        `port p { shape { x: ${"f(".repeat(deep)}${")".repeat(deep)} } }`,
        `port p { shape ${"{ k ".repeat(deep)}${"}".repeat(deep)} }`,
      ];
      for (const source of shapes) {
        expect(compile(source).verdict).toBe("invalid");
      }
    });

    it("refuses a source over the byte ceiling without lexing it", () => {
      const { diagnostics, program } = parseProgram(
        "x".repeat(HSX_LIMITS.maxSourceBytes + 1),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.message).toContain("HSX reads at most 262144");
      expect(program.decls).toEqual([]);
    });

    // The ceiling counts UTF-8 bytes and the diagnostic names how many the
    // file has. Both halves have to hold whether or not the code-unit count
    // clears the ceiling on its own: an earlier version short-circuited on
    // `source.length` in that case and printed code units as bytes, so a
    // 900,000-byte file was reported as 300000.
    it("reports the source's UTF-8 size, not its code-unit count", () => {
      const cases = [
        // 100,000 code units, under the ceiling; 300,000 bytes, over it.
        { bytes: 300_000, source: "あ".repeat(100_000) },
        // 300,000 code units, over the ceiling on its own. Three bytes each.
        { bytes: 900_000, source: "あ".repeat(300_000) },
        // 600,000 code units, because each G-clef is a surrogate pair.
        { bytes: 1_200_000, source: "𝄞".repeat(300_000) },
      ];
      for (const { bytes, source } of cases) {
        expect(new TextEncoder().encode(source).byteLength).toBe(bytes);
        const { diagnostics } = parseProgram(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.message).toBe(
          `this file is ${bytes} bytes; HSX reads at most 262144`,
        );
      }
    });
  });

  describe("percentToBps", () => {
    it("converts exactly", () => {
      expect(percentToBps("100")).toBe(10_000);
      expect(percentToBps("99.5")).toBe(9950);
      expect(percentToBps("0.5")).toBe(50);
      expect(percentToBps("0.05")).toBe(5);
      expect(percentToBps("1")).toBe(100);
      expect(percentToBps("2")).toBe(200);
    });

    it("refuses sub-basis-point precision", () => {
      expect(percentToBps("1.005")).toBeUndefined();
      expect(percentToBps("0.001")).toBeUndefined();
    });
  });
});

// --------------------------------------------------------------------------
// Merged from open/hsx/test/deadline.spec.ts
// --------------------------------------------------------------------------
describe("deadline", () => {
  /**
   * `release: port <p> | at(<field>)`, the date-anchored release. The anchor is
   * the DEFAULT exit, never a second decider: the port and the cancel decide
   * only before it, and an undecided hold pays the payee when it arrives.
   */

  const RELEASE = "release: port approve_release | at(releaseDueAt)";

  const source = (release = RELEASE) => `
  program retention_holdback "Construction retention"
  import { held_payment } from "settlement"
  party contractor: business
  party subcontractor: business
  settlement retention = held_payment {
    payer:  contractor
    payee:  subcontractor
    amount: retainedAmount: money(SAR)
    ${release}
    on_cancel(funded) { contractor: 100% }
  }
  port approve_release { allowed: [contractor] }
  `;

  function compiled(input: string) {
    const result = compile(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    return {
      frame: result.artifacts.frame as Record<string, any>,
      noun: (result.artifacts.document.nouns as Record<string, any>[])[0]!,
    };
  }

  function refusal(input: string): string[] {
    const result = compile(input);
    expect(result.verdict).toBe("invalid");
    return result.diagnostics.map((item) => item.message);
  }

  describe("at() deadline release", () => {
    it("parses the anchor onto the port reference", () => {
      const parsed = parseProgram(source());
      expect(parsed.diagnostics).toEqual([]);
      const settlement = parsed.program.decls.find(
        (decl) => decl.kind === "settlement",
      );
      if (settlement?.kind !== "settlement") {
        throw new Error("expected held_payment settlement");
      }
      const release = settlement.body.entries.find(
        (entry) => entry.key.name === "release",
      );
      expect(release?.value).toMatchObject({
        deadline: { name: "releaseDueAt" },
        kind: "port_ref",
        name: { name: "approve_release" },
      });
    });

    it("stores the anchor as a date field the author named", () => {
      expect(compiled(source()).noun.fields.releaseDueAt).toMatchObject({
        type: "date",
      });
      expect(
        compiled(source("release: port approve_release | at(defectsPeriodEnd)"))
          .noun.fields.defectsPeriodEnd,
      ).toMatchObject({ type: "date" });
    });

    it("mints one due verb that pays the payee on the stored date", () => {
      const { frame, noun } = compiled(source());
      expect(noun.verbs.release_on_deadline).toMatchObject({
        due: { field: "releaseDueAt", rule: "retention_release_deadline" },
        from: ["funded"],
        to: "released",
      });
      expect(noun.verbs.release_on_deadline.moves).toEqual([
        {
          amount: "retainedAmount",
          from: "escrow",
          key: "transfer",
          operation: "create",
          to: "subcontractor",
        },
      ]);
      const rule = (frame.rules as Record<string, any>[]).find(
        (item) => item.key === "retention_release_deadline",
      );
      expect(rule).toMatchObject({
        allowedActors: [],
        dueDriven: true,
        enforcement: "platform",
        gatesEvent: null,
        kind: "deadline",
      });
    });

    it("cuts the port and the cancel off at the same anchor", () => {
      const { noun } = compiled(source());
      expect(noun.verbs.approve_release.deadline).toEqual({
        field: "releaseDueAt",
      });
      expect(noun.verbs.cancel.deadline).toEqual({ field: "releaseDueAt" });
    });

    it("adds a behaviour, not a money event: both exits share one payout", () => {
      const anchored = compiled(source());
      const portOnly = compiled(source("release: port approve_release"));
      expect(anchored.noun.verbs.release_on_deadline.moneyEvent).toBe(
        anchored.noun.verbs.approve_release.moneyEvent,
      );
      expect(anchored.frame.moneyEvents).toHaveLength(
        (portOnly.frame.moneyEvents as unknown[]).length,
      );
    });

    it("stays opt-in: no anchor mints no date, no verb, no rule", () => {
      const { frame, noun } = compiled(source("release: port approve_release"));
      expect(noun.fields.releaseDueAt).toBeUndefined();
      expect(noun.verbs.release_on_deadline).toBeUndefined();
      expect(noun.verbs.approve_release.deadline).toBeUndefined();
      expect(noun.verbs.cancel.deadline).toBeUndefined();
      expect(
        (frame.rules as Record<string, any>[]).some(
          (rule) => rule.dueDriven === true,
        ),
      ).toBe(false);
    });

    it("refuses an anchor that is not a camelCase field of its own", () => {
      expect(
        refusal(source("release: port approve_release | at(release_due_at)")),
      ).toContain(
        'at( ... ) names a camelCase date field, like at(releaseDueAt); "release_due_at" is not',
      );
      expect(
        refusal(source("release: port approve_release | at(clawbackAt)")),
      ).toContain(
        "settlement retention names a field clawbackAt, but the compiler reserves that name for a generated field; pick another name",
      );
      expect(
        refusal(source("release: port approve_release | at(retainedAmount)")),
      ).toContain(
        "settlement retention uses retainedAmount as both the held amount and the release date field; they need distinct names",
      );
    });

    it("refuses the anchor everywhere a date is not the default", () => {
      const swap = `
  program comic_den "ComicDen"
  import { swap } from "settlement"
  party hind: person
  party tariq: person
  settlement trade = swap {
    between: [hind, tariq]
    amounts { hind: hindPays: money(SAR), tariq: tariqPays: money(SAR) }
    release: port confirm_exchange | at(releaseDueAt)
  }
  port confirm_exchange { allowed: [hind, tariq] }
  `;
      expect(refusal(swap)).toContain(
        "release on settlement trade has no date default; only a held payment's release falls back to a date",
      );
    });

    it("refuses a port whose name the deadline verb already owns", () => {
      expect(
        refusal(source().replaceAll("approve_release", "release_on_deadline")),
      ).toContain(
        'settlement retention generates two verbs named "release_on_deadline"; rename the colliding port',
      );
    });

    it("says what belongs after the pipe when the author guesses", () => {
      for (const [release, needle] of [
        [
          "release: port approve_release | on(releaseDueAt)",
          "after | comes the date the platform decides on, like: | at(releaseDueAt)",
        ],
        [
          "release: port approve_release | at releaseDueAt",
          "at names its date field in parentheses: at(releaseDueAt)",
        ],
        [
          "release: port approve_release | at(releaseDueAt",
          "at( ... ) never closes",
        ],
      ] as const) {
        expect(refusal(source(release))).toContain(needle);
      }
    });
  });
});
