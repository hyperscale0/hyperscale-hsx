import { describe, expect, it } from "bun:test";
import { ARCHETYPE_DEFINITIONS } from "../src/archetypes.ts";
import { checkProgram, compile, parseProgram } from "../src/index.ts";
import {
  lowerFrameActors,
  lowerProgram,
  mintEvent,
  MONEY_EVENT_BUDGET,
  validateAmountDependencyGraph,
} from "../src/lower.ts";
import type { CheckedProgram } from "../src/model.ts";

describe("settlement compiler foundation", () => {
  const actorProgram = () => {
    const parsed = parseProgram(`program actors "Actors"
import { instant_transfer } from "settlement"
party payer: business
party payee: business
party spectator: business
settlement payment = instant_transfer {
  payer: payer
  payee: payee
  amount: total: money(SAR)
}`);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(
      checked.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      ),
    ).toEqual([]);
    return checked.program!;
  };

  it("declares a local money-event cap for every current archetype", () => {
    expect(
      Object.fromEntries(
        Object.entries(ARCHETYPE_DEFINITIONS).map(([name, definition]) => [
          name,
          definition.eventCap,
        ]),
      ),
    ).toEqual({
      advance: 2,
      captured_payment: 4,
      conditional_disbursement: 1,
      credit_facility: 1,
      deposit: 1,
      funding_round: 4,
      held_payment: 7,
      instant_transfer: 3,
      metered: 14,
      pooled_split: 14,
      premium_forward: 6,
      recurring_collection: 0,
      rotating_pool: 3,
      scheduled: 3,
      settlement_batch: 1,
      swap: 10,
      weighted_distribution: 1,
    });
    expect(
      Object.values(ARCHETYPE_DEFINITIONS).every(
        (definition) => definition.eventCap < MONEY_EVENT_BUDGET,
      ),
    ).toBe(true);
  });

  it("keeps representative lowering for all eleven archetypes within local caps", () => {
    const programs = {
      advance: `program p "P"
import { advance } from "settlement"
party payer: business
party payee: business
settlement s = advance {
  funder: payer
  to: payee
  amount: total: money(SAR)
  count: 2
  every: P1D
  first_due: firstDueAt
}`,
      captured_payment: `program p "P"
import { captured_payment } from "settlement"
party payer: business
party payee: business
settlement s = captured_payment {
  payer: payer
  payee: payee
  amount: total: money(SAR)
  reserve_until: reserveUntil
  correction: port correct
  external_reversal: port reverse within P14D
  capture_mode: partial_then_full
  correction_mode: full_only
  negative_position: reject
  timeout: reject
}
port correct { allowed: [payee] }
port reverse { allowed: [payee], shape: { externalReference: text } }`,
      settlement_batch: `program p "P"
import { settlement_batch } from "settlement"
party settlement_account: business
party payout_destination: business
settlement s = settlement_batch {
  settlement_account: settlement_account
  source_capture_refs: captureReference
  fee_entries: feeReference
  external_reversal_offsets: externalReversalReference
  close_trigger: closeAt
  payout_destination: payout_destination
  negative_position: reject
  payout_acknowledgement: port acknowledge_payout
  payout_beneficiary_ref: payoutBeneficiaryId
}
port acknowledge_payout {
  allowed: [payout_destination]
  shape: { acknowledgementReference: text }
}`,
      deposit: `program p "P"
import { deposit } from "settlement"
party payer: business
party payee: business
settlement s = deposit {
  payer: payer
  holder: payee
  amount: total: money(SAR)
  claim: port claim
  return: port return_deposit
}
port claim { allowed: [payee] }
port return_deposit { allowed: [payer] }`,
      held_payment: `program p "P"
import { held_payment } from "settlement"
party payer: business
party payee: business
settlement s = held_payment {
  payer: payer
  payee: payee
  amount: total: money(SAR)
  fees { payer: 1%, payee: 1% }
  on_cancel(funded) { payer: 50%, payee: 50% }
  release: port release
}
port release { allowed: [payer] }`,
      instant_transfer: `program p "P"
import { instant_transfer } from "settlement"
party payer: business
party payee: business
settlement s = instant_transfer {
  payer: payer
  payee: payee
  amount: total: money(SAR)
  fees { payer: 1%, payee: 1% }
}`,
      metered: `program p "P"
import { metered } from "settlement"
party payer: business
party payee: business
settlement s = metered {
  payer: payer
  payee: payee
  close_by: periodEnd
  rates { api_call: callRate: money(SAR), storage: storageRate: money(SAR) }
}`,
      pooled_split: `program p "P"
import { pooled_split } from "settlement"
party payer: business
party first: business
party second: business
settlement s = pooled_split {
  payer: payer
  amount: total: money(SAR)
  payout_due: payoutDueAt
  split { first: 50%, second: 50% }
}`,
      premium_forward: `program p "P"
import { premium_forward } from "settlement"
party payer: business
party carrier: business
settlement s = premium_forward {
  payer: payer
  carrier: carrier
  amount: total: money(SAR)
  commission: 1%
  on_cancel(funded) { payer: 50%, carrier: 50% }
  bind: port bind
}
port bind { allowed: [payer] }`,
      scheduled: `program p "P"
import { scheduled } from "settlement"
party payer: business
party payee: business
settlement s = scheduled {
  payer: payer
  payee: payee
  amount: total: money(SAR)
  count: 2
  every: P1D
  first_due: firstDueAt
}`,
      swap: `program p "P"
import { swap } from "settlement"
party payer: business
party payee: business
settlement s = swap {
  between: [payer, payee]
  amounts { payer: payerAmount: money(SAR), payee: payeeAmount: money(SAR) }
  fees { payer: payerFee: money(SAR), payee: payeeFee: money(SAR) }
  release: port release
  dispute: port dispute within P1D
}
port release { allowed: [payer, payee] }
port dispute { allowed: [payer, payee] }`,
    } as const;
    const expectedCounts = {
      advance: 2,
      captured_payment: 4,
      deposit: 1,
      held_payment: 7,
      instant_transfer: 3,
      metered: 2,
      pooled_split: 4,
      premium_forward: 6,
      scheduled: 1,
      settlement_batch: 1,
      swap: 10,
    } as const;
    for (const [archetype, source] of Object.entries(programs)) {
      const result = compile(source);
      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
      const eventCount = (result.artifacts!.frame.moneyEvents as unknown[])
        .length;
      expect(eventCount).toBe(
        expectedCounts[archetype as keyof typeof expectedCounts],
      );
      expect(eventCount).toBeLessThanOrEqual(
        ARCHETYPE_DEFINITIONS[archetype as keyof typeof programs].eventCap,
      );
    }
  });

  it("bounds metered fan-out through its declared event cap", () => {
    const rates = Array.from(
      { length: 15 },
      (_, index) => `meter_${index + 1}: rate${index + 1}: money(SAR)`,
    ).join("\n");
    const result = compile(`program too_many_meters "Too many meters"
import { metered } from "settlement"
party payer: business
party payee: business
settlement usage = metered {
  payer: payer
  payee: payee
  close_by: periodEnd
  rates { ${rates} }
}`);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics.map((item) => item.message)).toContain(
      "settlement usage prices 15 meters, but metered allows at most 14 so one settlement stays within its 14-event cap",
    );
  });

  it("bounds pooled fan-out at seven recipients and fourteen events", () => {
    const parties = Array.from(
      { length: 8 },
      (_, index) => `party recipient_${index + 1}: business`,
    ).join("\n");
    const shares = Array.from(
      { length: 8 },
      (_, index) => `recipient_${index + 1}: 12.5%`,
    ).join("\n");
    const result = compile(`program too_many_recipients "Too many recipients"
import { pooled_split } from "settlement"
party payer: business
${parties}
settlement pool = pooled_split {
  payer: payer
  amount: total: money(SAR)
  payout_due: payoutDueAt
  split { ${shares} }
}`);
    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics.map((item) => item.message)).toContain(
      "settlement pool splits to 8 recipients, but pooled_split allows at most 7 so funding and payout stay within its 14-event cap",
    );
  });

  it("refuses a lowerer that exceeds its declared local cap", () => {
    const origin = { end: 1, start: 0 };
    const program: CheckedProgram = {
      assets: [],
      derivedAmounts: [],
      name: "unchecked_metered",
      parties: [
        { kind: "business", name: "payer", origin },
        { kind: "business", name: "payee", origin },
      ],
      ports: [],
      settlements: [
        {
          archetype: "metered",
          closeByField: "periodEnd",
          name: "usage",
          origin,
          payee: "payee",
          payer: "payer",
          rates: Array.from({ length: 15 }, (_, index) => ({
            field: {
              currency: "SAR",
              name: `rate${index + 1}`,
              origin,
            },
            meter: `meter_${index + 1}`,
            origin,
          })),
        },
      ],
      title: "Unchecked metered",
    };
    const result = lowerProgram(program);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message)).toContain(
      "settlement usage emits 15 money events, but metered carries a local cap of 14",
    );
  });

  it("declares held-payment release as referenceable archetype data", () => {
    expect(ARCHETYPE_DEFINITIONS.held_payment.referenceableExits).toEqual([
      "release",
    ]);
    expect(ARCHETYPE_DEFINITIONS.scheduled.referenceableExits).toEqual([
      "obligation",
    ]);
  });

  it("lowers one repeatable counterparty role with honest cardinality", () => {
    const result = lowerFrameActors(actorProgram(), [
      {
        key: "payer",
        label: "Contributors",
        maxCount: 250,
        minCount: 2,
        origin: { end: 1, start: 0 },
        role: "payer",
      },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.actors).toEqual([
      {
        key: "payer",
        label: "Contributors",
        maxCount: 250,
        minCount: 2,
        role: "payer",
      },
      {
        key: "payee",
        label: "Payee",
        maxCount: 1,
        minCount: 1,
        role: "beneficiary",
      },
      {
        key: "platform",
        label: "Platform",
        maxCount: 1,
        minCount: 1,
        role: "platform",
      },
    ]);
  });

  it("rejects invalid repeatable actor overrides", () => {
    const role = {
      key: "payer",
      label: "Contributors",
      maxCount: 250,
      minCount: 2,
      origin: { end: 1, start: 0 },
      role: "payer" as const,
    };
    const messages = [
      [{ ...role, key: "ghost" }],
      [{ ...role, key: "spectator" }],
      [role, role],
      [{ ...role, role: "beneficiary" as const }],
      [{ ...role, maxCount: 1 }],
      [{ ...role, minCount: 0 }],
      [{ ...role, minCount: 1.5 }],
      [{ ...role, maxCount: 10_001 }],
    ].map((overrides) =>
      lowerFrameActors(actorProgram(), overrides).issues.map(
        (issue) => issue.message,
      ),
    );
    expect(messages).toEqual([
      ["repeatable counterparty ghost is not a declared party"],
      ["repeatable counterparty spectator is not used by any settlement"],
      ["repeatable counterparty payer is declared twice"],
      [
        "repeatable counterparty payer declares role beneficiary, but its settlement uses role payer",
      ],
      ["repeatable counterparty payer has minCount 2 above maxCount 1"],
      [
        "repeatable counterparty payer counts must be integers from 1 through 10000",
      ],
      [
        "repeatable counterparty payer counts must be integers from 1 through 10000",
      ],
      [
        "repeatable counterparty payer counts must be integers from 1 through 10000",
      ],
    ]);
  });

  it("enforces the Business Frame label bounds for repeatable actors", () => {
    const role = {
      key: "payer",
      maxCount: 250,
      minCount: 2,
      origin: { end: 1, start: 0 },
      role: "payer" as const,
    };
    const boundary = lowerFrameActors(actorProgram(), [
      { ...role, label: "C".repeat(160) },
    ]);
    expect(boundary.issues).toEqual([]);
    expect(boundary.actors[0]?.label).toHaveLength(160);

    for (const label of ["", "   ", "C".repeat(161)]) {
      expect(
        lowerFrameActors(actorProgram(), [{ ...role, label }]).issues.map(
          (issue) => issue.message,
        ),
      ).toEqual([
        "repeatable counterparty payer label must contain 1 through 160 characters",
      ]);
    }
  });

  it("mints future amount expressions into existing frame dependency keys", () => {
    const event = (
      amountDependency: NonNullable<
        Parameters<typeof mintEvent>[0]["amountDependency"]
      >,
    ) =>
      mintEvent({
        amount: "the dependent amount",
        amountDependency,
        fromActor: "payer",
        key: "dependent_event",
        kind: "payout",
        toActor: "payee",
        trigger: "Move the dependent amount",
      });
    expect(
      event({
        kind: "net_of_offsets",
        offsets: ["refunds", "fees"],
        source: "captures",
      }),
    ).toMatchObject({
      amount: "Net of captures after refunds, fees: the dependent amount",
      amountDependencies: ["captures", "refunds", "fees"],
      amountMode: "runtime_bounded",
    });
    expect(
      event({
        bps: 2_500,
        kind: "percent_of_reference",
        reference: "round_release",
      }),
    ).toMatchObject({
      amount: "25% of round_release: the dependent amount",
      amountDependencies: ["round_release"],
      amountMode: "runtime_bounded",
    });
    expect(
      event({
        bps: 10_000,
        kind: "percent_of_reference",
        reference: "round_release",
      }),
    ).toMatchObject({
      amount: "100% of round_release: the dependent amount",
      amountDependencies: ["round_release"],
      amountMode: "runtime_bounded",
    });
    expect(
      event({
        consumed: ["paid_a", "paid_b"],
        kind: "remainder",
        source: "funded",
      }),
    ).toMatchObject({
      amount: "Remainder of funded after paid_a, paid_b: the dependent amount",
      amountDependencies: ["funded", "paid_a", "paid_b"],
      amountMode: "remaining_balance",
    });
  });

  it("rejects invalid lowerer-authored amount expressions", () => {
    const event = (
      amountDependency: NonNullable<
        Parameters<typeof mintEvent>[0]["amountDependency"]
      >,
    ) =>
      mintEvent({
        amount: "the dependent amount",
        amountDependency,
        fromActor: "payer",
        key: "dependent_event",
        kind: "payout",
        toActor: "payee",
        trigger: "Move the dependent amount",
      });
    expect(() =>
      event({ kind: "net_of_offsets", offsets: [], source: "captures" }),
    ).toThrow("net_of_offsets requires at least one offset event");
    expect(() =>
      event({
        kind: "net_of_offsets",
        offsets: ["captures"],
        source: "captures",
      }),
    ).toThrow("amount dependency event keys must be distinct");
    expect(() =>
      event({
        bps: 0,
        kind: "percent_of_reference",
        reference: "captures",
      }),
    ).toThrow(
      "percent_of_reference bps must be an integer between 1 and 10000",
    );
    expect(() =>
      event({
        bps: 10_001,
        kind: "percent_of_reference",
        reference: "captures",
      }),
    ).toThrow(
      "percent_of_reference bps must be an integer between 1 and 10000",
    );
    expect(() =>
      event({ consumed: [], kind: "remainder", source: "funded" }),
    ).toThrow("remainder requires at least one consumed event");
    expect(() =>
      event({
        consumed: ["funded"],
        kind: "remainder",
        source: "funded",
      }),
    ).toThrow("amount dependency event keys must be distinct");
  });

  it("canonicalizes long dependency keys with their source events", () => {
    const sourceKey = "source_event_name_that_is_longer_than_forty_characters";
    const source = mintEvent({
      amount: "the source amount",
      fromActor: "payer",
      key: sourceKey,
      kind: "charge",
      toActor: "escrow",
      trigger: "Fund the source",
    });
    const dependent = mintEvent({
      amount: "the dependent amount",
      amountDependency: {
        bps: 2_500,
        kind: "percent_of_reference",
        reference: sourceKey,
      },
      fromActor: "escrow",
      key: "dependent",
      kind: "payout",
      toActor: "payee",
      trigger: "Pay the dependent amount",
    });
    expect(dependent.amountDependencies).toEqual([source.key]);
  });

  it("rejects missing, self, and cyclic event dependencies", () => {
    const origin = { end: 1, start: 0 };
    const event = (key: string, amountDependencies: readonly string[]) => ({
      amountDependencies,
      key,
    });
    expect(
      validateAmountDependencyGraph([event("payout", ["missing"])], origin).map(
        (issue) => issue.message,
      ),
    ).toEqual(["money event payout depends on missing money event missing"]);
    expect(
      validateAmountDependencyGraph([event("self", ["self"])], origin).map(
        (issue) => issue.message,
      ),
    ).toEqual([
      "money event self cannot depend on itself",
      "money event amount dependencies contain a cycle through self",
    ]);
    expect(
      validateAmountDependencyGraph(
        [event("first", ["second"]), event("second", ["first"])],
        origin,
      ).map((issue) => issue.message),
    ).toEqual([
      "money event amount dependencies contain a cycle through first, second",
    ]);
    expect(
      validateAmountDependencyGraph(
        [
          event("funding", []),
          event("left", ["funding"]),
          event("right", ["funding"]),
          event("remainder", ["funding", "left", "right"]),
        ],
        origin,
      ),
    ).toEqual([]);
  });

  it("keeps current emitted events fixed with no dependencies", () => {
    const result = compile(`program ordinary "Ordinary"
import { instant_transfer } from "settlement"
party payer: business
party payee: business
settlement payment = instant_transfer {
  payer: payer
  payee: payee
  amount: total: money(SAR)
}`);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts?.frame.moneyEvents).toEqual([
      expect.objectContaining({
        amountDependencies: [],
        amountMode: "fixed",
      }),
    ]);
    expect(result.artifacts?.frame.actors).toEqual([
      {
        key: "payer",
        label: "Payer",
        maxCount: 1,
        minCount: 1,
        role: "payer",
      },
      {
        key: "payee",
        label: "Payee",
        maxCount: 1,
        minCount: 1,
        role: "beneficiary",
      },
      {
        key: "platform",
        label: "Platform",
        maxCount: 1,
        minCount: 1,
        role: "platform",
      },
    ]);
  });
});
