import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "funding-round.hsx"),
  "utf8",
);

const messages = (source: string): string =>
  compile(source)
    .diagnostics.map((diagnostic) => diagnostic.message)
    .join("\n");

describe("funding_round", () => {
  it("checks to the existing pooled-funding mechanism vocabulary", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.program?.settlements[0]).toMatchObject({
      archetype: "funding_round",
      beneficiary: "beneficiary",
      cancelPolicy: "before_close",
      closeByField: "closeBy",
      closePolicy: "threshold",
      commitment: { currency: "SAR", name: "amount" },
      contributor: "contributor",
      failPolicy: "whole_commitment_refund",
      maxContributors: 3,
      name: "capital_pool",
      overfundPolicy: "reject",
      target: { currency: "SAR", name: "targetAmount" },
    });
    expect(JSON.stringify(checked.program?.settlements[0])).not.toMatch(
      /merchant|biller|chargeback|late.?fee|insurance|profit|impairment|sharia/i,
    );
  });

  it("lowers one threshold owner and one repeatable commitment noun", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "capital_pool",
      "capital_pool_commitment",
    ]);

    const parent = nouns[0]!;
    const commitment = nouns[1]!;
    expect(parent.aggregateInvariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childField: "amount",
          childNounId: "capital_pool_commitment",
          childRefField: "capitalPoolId",
          childStatuses: ["committed"],
          parentField: "targetAmount",
        }),
        expect.objectContaining({
          childNounId: "capital_pool_commitment",
          childRefField: "capitalPoolId",
          childStatuses: ["committed"],
          count: true,
          parentField: "maxContributors",
        }),
      ]),
    );
    expect(parent.verbs.activate.due).toEqual({
      field: "closeBy",
      rule: "capital_pool_close",
    });
    expect(parent.verbs.activate.requiresAggregate[0].check).toEqual({
      amountField: "amount",
      kind: "sum_at_least",
      targetField: "targetAmount",
    });
    expect(parent.verbs.activate.to).toBe("active");
    expect(parent.verbs.fail.requiresAggregate[0].check.kind).toBe("sum_below");
    expect(parent.verbs.close).toMatchObject({
      from: ["active"],
      requiresAggregate: [
        expect.objectContaining({
          check: { kind: "all_in" },
          statuses: ["cancelled", "collected"],
        }),
      ],
      to: "settled",
    });
    expect(parent.fields.maxContributors).toMatchObject({ type: "const:3" });

    expect(commitment.fields).toMatchObject({
      amount: expect.anything(),
      capitalPoolId: { type: "ref:capital_pool" },
      currency: { type: "currency" },
    });
    expect(commitment.verbs.create).toMatchObject({
      moves: [
        expect.objectContaining({
          amount: "amount",
          from: "contributor",
          operation: "create",
          to: "escrow",
        }),
      ],
      to: "committed",
    });
    expect(commitment.verbs.cancel).toMatchObject({
      from: ["committed"],
      moves: [
        expect.objectContaining({
          amount: "amount",
          from: "escrow",
          operation: "create",
          to: "contributor",
        }),
      ],
      to: "cancelled",
    });
    expect(commitment.verbs.cancel.requires.capitalPoolId.statuses).toEqual([
      "open",
    ]);
    expect(commitment.verbs.collect).toMatchObject({
      from: ["committed"],
      moves: [
        expect.objectContaining({
          amount: "amount",
          from: "escrow",
          operation: "create",
          to: "beneficiary",
        }),
      ],
      to: "collected",
    });
    expect(commitment.verbs.collect.requires.capitalPoolId.statuses).toEqual([
      "active",
    ]);
    expect(commitment.verbs.refund.requires.capitalPoolId.statuses).toEqual([
      "failed",
    ]);
  });

  it("uses four repeatable event slots for whole commitment movements", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const events = result.artifacts.frame.moneyEvents as Json[];
    expect(events.map((event) => event.key)).toEqual([
      "capital_pool_commit",
      "capital_pool_cancel",
      "capital_pool_collect",
      "capital_pool_refund",
    ]);
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event.occurrence).toBe("repeatable");
    }
    expect(events[1]?.amount).toMatch(/whole|stored/i);
    expect(events[2]?.amount).toMatch(/whole|stored/i);
    expect(events[3]?.amount).toMatch(/whole|stored/i);
  });

  it("refuses unsupported close, overfund, cancellation, and refund policies", () => {
    expect(messages(SOURCE.replace("threshold", "partial"))).toContain(
      "close must follow the locked committed sum",
    );
    expect(
      messages(
        SOURCE.replace("overfund_policy: reject", "overfund_policy: allow"),
      ),
    ).toContain("commitment past the remaining target headroom must refuse");
    expect(messages(SOURCE.replace("before_close", "anytime"))).toContain(
      "commitment may cancel only while its parent remains open",
    );
    expect(
      messages(SOURCE.replace("whole_commitment_refund", "pro_rata_refund")),
    ).toContain("failure refunds each stored commitment whole");
  });

  it("refuses invalid cardinality and mismatched money denominations", () => {
    expect(
      messages(SOURCE.replace("max_contributors: 3", "max_contributors: 0")),
    ).toContain("literal integer from 2 through");
    expect(
      messages(
        SOURCE.replace(
          "commitment: amount: money(SAR)",
          "commitment: amount: money(USD)",
        ),
      ),
    ).toContain("target and commitment need one currency");
  });
});
