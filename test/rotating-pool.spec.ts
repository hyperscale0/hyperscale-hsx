import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkProgram, compile, parseProgram } from "../src/index.ts";

type Json = Record<string, any>;

const SOURCE = readFileSync(
  join(import.meta.dir, "fixtures", "rotating-pool.hsx"),
  "utf8",
);

const messages = (source: string): string =>
  compile(source)
    .diagnostics.map((diagnostic) => diagnostic.message)
    .join("\n");

describe("rotating_pool", () => {
  it("checks a fixed roster and payout order to mechanism vocabulary", () => {
    const parsed = parseProgram(SOURCE);
    expect(parsed.diagnostics).toEqual([]);
    const checked = checkProgram(parsed.program);
    expect(checked.diagnostics).toEqual([]);
    const settlement = checked.program?.settlements[0];
    expect(settlement).toMatchObject({
      archetype: "rotating_pool",
      defaultPolicy: "due_condition",
      exitPolicy: "before_activation_only",
      guaranteePolicy: "funded_only",
      guarantor: "guarantee_source",
      members: ["member_a", "member_b", "member_c"],
      name: "pool",
      payoutOrder: ["member_b", "member_c", "member_a"],
      schedule: {
        count: 3,
        every: { raw: "P30D" },
        firstDueField: "firstContributionAt",
      },
    });
    expect(Object.keys(settlement ?? {}).join(" ")).not.toMatch(
      /savings|circle|insurance|merchant|biller|chargeback|lateFee|profit|impairment|sharia/i,
    );
  });

  it("lowers one pool and one fixed member noun per roster entry with three event streams", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    expect(nouns.map((noun) => noun.id)).toEqual([
      "pool",
      "pool_member_a_contribution",
      "pool_member_b_contribution",
      "pool_member_c_contribution",
    ]);

    const pool = nouns[0]!;
    const contribution = nouns[1]!;
    expect(pool.actors).toMatchObject({
      guarantee_source: "payer",
      member_a: "party",
      member_b: "party",
      member_c: "party",
    });
    expect(pool.verbs).toMatchObject({
      activate: { from: ["forming"], to: "active_cycle_1" },
      cancel: { from: ["forming"], to: "cancelled" },
      advance_cycle_3: { from: ["cycle_3_ready"], to: "completed" },
    });
    expect(pool.verbs.cancel).not.toHaveProperty("moves");
    expect(pool.verbs.cancel).not.toHaveProperty("moneyEvent");
    expect(JSON.stringify(pool.verbs)).not.toMatch(/retry|provider|confirm/i);

    expect(contribution.fields).toMatchObject({
      contributionAmount: expect.anything(),
      poolId: { type: "ref:pool" },
    });
    expect(contribution.verbs.create.requires.poolId.unique).toBe(true);
    expect(contribution.verbs.create.requires.poolId.bind).toMatchObject({
      currency: "fields.currency",
      guaranteeSourceAccountId: "fields.guaranteeSourceAccountId",
      memberAAccountId: "fields.memberAAccountId",
      memberBAccountId: "fields.memberBAccountId",
      memberCAccountId: "fields.memberCAccountId",
      contributionAmount: "fields.contributionAmount",
      firstContributionAt: "fields.firstContributionAt",
    });
    expect(
      Object.keys(contribution.verbs.create.requires.poolId.bind),
    ).toHaveLength(7);
    expect(contribution.verbs.contribute_cycle_1).toMatchObject({
      from: ["cycle_1_due"],
      to: "cycle_1_funded",
    });
    expect(contribution.verbs.guarantee_cycle_1).toMatchObject({
      from: ["cycle_1_defaulted"],
      to: "cycle_1_guaranteed",
    });
    expect(contribution.verbs.mark_default_cycle_1).not.toHaveProperty("moves");
    expect(contribution.verbs.mark_default_cycle_1).not.toHaveProperty(
      "moneyEvent",
    );
    expect(contribution.verbs.mark_default_cycle_1).toMatchObject({
      due: expect.objectContaining({ rule: expect.any(String) }),
      from: ["cycle_1_due"],
      to: "cycle_1_defaulted",
    });
    expect(contribution.verbs.guarantee_cycle_1.moves[0]).toMatchObject({
      amount: "contributionAmount",
      from: "guarantee_source",
      operation: "create",
      to: "escrow",
    });

    const events = result.artifacts.frame.moneyEvents as Json[];
    expect(events.map((event) => event.key)).toEqual([
      "pool_contribution",
      "pool_guarantee_contribution",
      "pool_payout",
    ]);
    expect(events.every((event) => event.occurrence === "repeatable")).toBe(
      true,
    );
  });

  it("pins stored-cycle idempotency, ordered eligibility, and exact-pot payout", () => {
    const result = compile(SOURCE);
    expect(result.verdict).toBe("valid");
    if (!result.artifacts) throw new Error("compile produced no artifacts");
    const nouns = result.artifacts.document.nouns as Json[];
    const pool = nouns.find((noun) => noun.id === "pool")!;
    const contributions = nouns.filter((noun) => noun.id !== "pool");

    expect(contributions).toHaveLength(3);
    expect(contributions[0]!.verbs.create.requires.poolId).toMatchObject({
      statuses: ["forming"],
      unique: true,
    });
    for (const cycle of [1, 2, 3]) {
      const ready = pool.verbs[`ready_cycle_${cycle}`];
      expect(ready).toMatchObject({
        from: [`active_cycle_${cycle}`],
        to: `cycle_${cycle}_ready`,
      });
      expect(ready.requiresAggregate).toHaveLength(3);
      expect(
        ready.requiresAggregate.every(
          (condition: Json) =>
            condition.check.kind === "all_in" &&
            condition.statuses.includes(`cycle_${cycle}_funded`) &&
            condition.statuses.includes(`cycle_${cycle}_guaranteed`),
        ),
      ).toBe(true);
      const advance = pool.verbs[`advance_cycle_${cycle}`];
      expect(advance.requiresAggregate).toHaveLength(3);
      expect(
        advance.requiresAggregate.every(
          (condition: Json) => condition.check.kind === "all_in",
        ),
      ).toBe(true);
      for (const contribution of contributions) {
        expect(
          contribution.verbs[`pay_cycle_${cycle}`].requires.poolId,
        ).toEqual([`cycle_${cycle}_ready`]);
        expect(contribution.verbs[`pay_cycle_${cycle}`].moves[0]).toMatchObject(
          {
            amount: "contributionAmount",
            from: "escrow",
            operation: "create",
            to: ["member_b", "member_c", "member_a"][cycle - 1],
          },
        );
      }
    }
    expect(pool.verbs).not.toHaveProperty("exit_after_activation");
  });

  it("refuses mutable rosters, caller eligibility, and unproved policies", () => {
    expect(
      messages(
        SOURCE.replace(
          "members: [member_a, member_b, member_c]",
          "members: [member_a, member_b, member_a]",
        ),
      ),
    ).toContain("members on settlement pool must not repeat a party");
    expect(messages(SOURCE.replace("count: 3", "count: 2"))).toContain(
      "settlement pool count 2 must equal its 3-member roster",
    );
    expect(
      messages(
        SOURCE.replace(
          "payout_order: [member_b, member_c, member_a]",
          "payout_order: [member_b, member_a, member_a]",
        ),
      ),
    ).toContain("payout_order on settlement pool must not repeat a party");
    expect(
      messages(
        SOURCE.replace(
          "default_policy: due_condition",
          "default_policy: caller",
        ),
      ),
    ).toContain("default follows an unmet stored contribution due condition");
    expect(
      messages(
        SOURCE.replace(
          "guarantee_policy: funded_only",
          "guarantee_policy: promise",
        ),
      ),
    ).toContain(
      "a guarantee changes money only through an explicit funded contribution",
    );
    expect(
      messages(
        SOURCE.replace(
          "exit_policy: before_activation_only",
          "exit_policy: anytime",
        ),
      ),
    ).toContain("membership and order freeze before the first contribution");
    expect(
      messages(
        SOURCE.replace(
          "exit_policy: before_activation_only",
          "exit_policy: before_activation_only\n  eligible_member: member_b",
        ),
      ),
    ).toContain('does not understand "eligible_member"');
  });
});
