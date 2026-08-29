import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "installment-obligation.hsx"),
  "utf8",
);

const messages = (source: string): string =>
  compile(source)
    .diagnostics.map((diagnostic) => diagnostic.message)
    .join("\n");

describe("scheduled obligation mode", () => {
  it("checks to pure obligation vocabulary", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    const settlement = checked.program?.settlements[0];
    expect(settlement).toMatchObject({
      archetype: "scheduled",
      debtor: "debtor",
      mode: "obligation",
      name: "obligation",
      payee: "settlement_recipient",
      payer: "repayment_source",
    });
    expect(Object.keys(settlement ?? {}).join(" ")).not.toMatch(
      /merchant|biller|chargeback|provider|confirmation|lateFee|profit|impairment|sharia/i,
    );
  });

  it("lowers one parent and one payment noun per stored anchor", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "obligation",
      "obligation_installment_1_payment",
      "obligation_installment_2_payment",
      "obligation_installment_3_payment",
    ]);

    const parent = nouns[0]!;
    expect(parent.actors).toMatchObject({ debtor: "party" });
    expect(Object.keys(parent.verbs)).toEqual(
      expect.arrayContaining([
        "advance",
        "approve",
        "complete",
        "create",
        "mark_installment_1_delinquent",
        "collect_installment_1",
        "write_off",
      ]),
    );
    expect(parent.verbs.advance.moves[0]).toEqual({
      amount: "principal",
      from: "settlement_recipient",
      key: "advance",
      operation: "create",
      to: "advance_recipient",
    });
    expect(parent.verbs.advance).not.toHaveProperty("captureInput");
    expect(parent.verbs.advance).not.toHaveProperty("decision");
    expect(parent.verbs.advance).not.toHaveProperty("port");
    expect(parent.verbs.write_off).not.toHaveProperty("moves");
    expect(parent.verbs.write_off).not.toHaveProperty("moneyEvent");
    expect(parent.verbs).not.toHaveProperty("reschedule");
    expect(parent.verbs).not.toHaveProperty("mark_installment_1_paid");
    expect(JSON.stringify(parent.verbs)).not.toMatch(/provider/i);

    const events = result.artifacts.frame.moneyEvents as Json[];
    expect(events.map((event) => event.key)).toEqual([
      "obligation_advance",
      "obligation_repayment",
      "obligation_refund",
    ]);
    expect(events[1]).toMatchObject({
      occurrence: "repeatable",
    });
    expect(events[2]).toMatchObject({
      occurrence: "repeatable",
    });
  });

  it("omits the advance path instead of claiming external confirmation", () => {
    const result = compile(
      SOURCE.replace("party advance_recipient: business\n", "").replace(
        "  advance_to: advance_recipient\n",
        "",
      ),
    );
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const obligation = (result.artifacts.document.nouns as Json[]).find(
      (noun) => noun.id === "obligation",
    )!;
    expect(obligation.verbs).not.toHaveProperty("advance");
    expect(JSON.stringify(obligation)).not.toMatch(/provider|confirm/i);
    expect(result.artifacts.frame.moneyEvents).toHaveLength(2);
  });

  it("binds each partial or early payment to one obligation and one anchor", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    const parent = nouns.find((noun) => noun.id === "obligation")!;
    const payment = nouns.find(
      (noun) => noun.id === "obligation_installment_2_payment",
    )!;

    expect(parent.aggregateInvariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childField: "amount",
          childNounId: "obligation_installment_2_payment",
          childRefField: "obligationId",
          childStatuses: ["paid"],
          parentField: "installment2Amount",
        }),
      ]),
    );
    expect(payment.fields).toMatchObject({
      amount: expect.anything(),
      obligationId: { type: "ref:obligation" },
    });
    expect(payment.fields).not.toHaveProperty("installmentId");
    expect(payment.verbs.create).toMatchObject({
      requires: {
        obligationId: {
          bind: {
            currency: "fields.currency",
            repaymentSourceAccountId: "fields.repaymentSourceAccountId",
            settlementRecipientAccountId: "fields.settlementRecipientAccountId",
          },
          statuses: expect.any(Array),
        },
      },
      to: "created",
    });
    expect(payment.verbs.repay).toMatchObject({
      from: ["created"],
      moves: [
        expect.objectContaining({
          amount: "amount",
          from: "repayment_source",
          operation: "create",
          to: "settlement_recipient",
        }),
      ],
      to: "paid",
    });
    expect(payment.verbs.repay.requires).toMatchObject({
      obligationId: {
        match: {
          "fields.currency": "fields.currency",
          "fields.repaymentSourceAccountId": "fields.repaymentSourceAccountId",
          "fields.settlementRecipientAccountId":
            "fields.settlementRecipientAccountId",
        },
        statuses: expect.any(Array),
      },
    });
    expect(payment.verbs.repay.requiresExposure).toEqual([
      {
        amountField: "amount",
        anchorField: "obligationId",
        capField: "installment2Amount",
        capOnAnchor: true,
        childNounId: "obligation_installment_2_payment",
        statuses: ["paid"],
      },
    ]);
    expect(payment.verbs.repay).not.toHaveProperty("due");
    expect(payment.verbs.repay).not.toHaveProperty("deadline");
  });

  it("caps a linked full refund at the paid amount", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const payment = (result.artifacts.document.nouns as Json[]).find(
      (noun) => noun.id === "obligation_installment_1_payment",
    )!;
    expect(payment.verbs.refund).toMatchObject({
      from: ["paid"],
      moves: [
        expect.objectContaining({
          amount: "amount",
          from: "settlement_recipient",
          operation: "create",
          to: "repayment_source",
        }),
      ],
      to: "refunded",
    });
    expect(payment.verbs.refund.requires.obligationId.statuses).toEqual([
      "active",
      "installment_1_delinquent",
      "installment_2_delinquent",
      "installment_3_delinquent",
    ]);
    expect(payment.verbs.refund).not.toHaveProperty("captureInput");
  });

  it("marks delinquency only from the stored due condition", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const obligation = (result.artifacts.document.nouns as Json[]).find(
      (noun) => noun.id === "obligation",
    )!;
    expect(obligation.verbs.mark_installment_1_delinquent).toMatchObject({
      due: expect.objectContaining({
        rule: "obligation_installment_1_due",
      }),
      from: ["active", "installment_2_delinquent", "installment_3_delinquent"],
      requiresAggregate: [
        expect.objectContaining({
          check: expect.objectContaining({ kind: "sum_below" }),
          nounId: "obligation_installment_1_payment",
        }),
      ],
      to: "installment_1_delinquent",
    });
    expect(obligation.fields.installment1DelinquentAfter).toMatchObject({
      type: "date?",
    });
    expect(obligation.verbs.mark_installment_1_delinquent.setsAt).toEqual({
      field: "installment1DelinquentAfter",
      marker: true,
      offset: "PT1S",
    });
    expect(obligation.verbs.mark_installment_1_delinquent).not.toHaveProperty(
      "moves",
    );
    expect(obligation.verbs.mark_installment_1_delinquent).not.toHaveProperty(
      "port",
    );
    expect(obligation.verbs.collect_installment_1).toMatchObject({
      from: [
        "installment_1_delinquent",
        "installment_2_delinquent",
        "installment_3_delinquent",
      ],
      to: "active",
    });
    expect(obligation.verbs.collect_installment_1).not.toHaveProperty("moves");
    const rule = (result.artifacts.frame.rules as Json[]).find(
      (candidate) => candidate.key === "obligation_installment_1_due",
    );
    expect(rule).toMatchObject({
      allowedActors: [],
      dueDriven: true,
      enforcement: "platform",
    });
  });

  it("closes only after every anchor is paid exactly", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const obligation = (result.artifacts.document.nouns as Json[]).find(
      (noun) => noun.id === "obligation",
    )!;
    expect(obligation.verbs.complete).toMatchObject({
      due: {
        field: "firstDueAt",
        offset: "P60D",
        rule: "obligation_completion_due",
      },
      from: expect.arrayContaining([
        "active",
        "installment_1_delinquent",
        "installment_2_delinquent",
        "installment_3_delinquent",
      ]),
      to: "repaid",
    });
    expect(obligation.verbs.complete.requiresAggregate).toHaveLength(3);
    expect(
      obligation.verbs.complete.requiresAggregate.every(
        (condition: Json) => condition.check.kind === "sum_exactly",
      ),
    ).toBe(true);
    expect(obligation.verbs.complete).not.toHaveProperty("port");
    expect(obligation.verbs.complete).not.toHaveProperty("moves");
  });

  it("projects obligation parties and mechanics as credit", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const actors = result.artifacts.frame.actors as Json[];
    expect(actors.map((actor) => actor.key)).toEqual(
      expect.arrayContaining([
        "advance_recipient",
        "debtor",
        "repayment_source",
        "settlement_recipient",
      ]),
    );
    expect(result.artifacts.frame.mechanics).toContain("credit");
    expect(result.artifacts.frame.mechanics).not.toContain("recurring_billing");
    expect(result.artifacts.frame.summary).toContain("debtor owes principal");
    expect(result.artifacts.frame.summary).toContain("advance recipient");
  });

  it("refuses unproved schedule mutation and unsafe policy variants", () => {
    expect(
      messages(
        SOURCE.replace(
          "reschedule_policy: refuse",
          "reschedule_policy: versioned",
        ),
      ),
    ).toContain("forward-version carryover is not mechanically proven");
    expect(
      messages(
        SOURCE.replace(
          "partial_payment: anchor_bound",
          "partial_payment: balance",
        ),
      ),
    ).toContain("one stored installment anchor");
    expect(
      messages(
        SOURCE.replace(
          "repayment_matching: obligation_and_anchor",
          "repayment_matching: obligation_only",
        ),
      ),
    ).toContain("both the obligation and its installment anchor");
    expect(
      messages(
        SOURCE.replace(
          "refund_policy: full_payment_only",
          "refund_policy: partial",
        ),
      ),
    ).toContain("one stored payment whole");
  });

  it("does not admit obligation policies on a transfer schedule", () => {
    expect(messages(SOURCE.replace("  mode: obligation\n", ""))).toContain(
      "uses obligation policies without mode: obligation",
    );
  });

  it("refuses obligation schedules outside the settled noun budget", () => {
    expect(messages(SOURCE.replace("count: 3", "count: 1"))).toContain(
      "between 2 and 7",
    );
    expect(messages(SOURCE.replace("count: 3", "count: 8"))).toContain(
      "between 2 and 7",
    );
  });

  it("refuses financing policy that belongs outside the obligation", () => {
    const result = compile(
      SOURCE.replace(
        "delinquency_policy: due_condition",
        "delinquency_policy: due_condition\n  fee: 1%",
      ),
    );
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics.map((item) => item.message).join("\n")).toContain(
      'does not understand "fee"',
    );
  });
});
