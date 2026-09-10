import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UdlDocument } from "@hyperscale0/udl";
import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");

function compileFixture(relativePath: string): UdlDocument {
  const source = readFileSync(join(packageRoot, relativePath), "utf8");
  const result = compile(source, { moduleName: relativePath });
  expect(result.diagnostics).toEqual([]);
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result.artifacts.document as UdlDocument;
}

describe("rotating pool standard library", () => {
  test("unrolls cycle activation gates and companion member contribution obligations", () => {
    const document = compileFixture("test/fixtures/rotating-pool.hsx");
    expect(document.instruments.map((i) => i.id)).toEqual([
      "pool",
      "pool_member_a_contribution",
      "pool_member_b_contribution",
      "pool_member_c_contribution",
    ]);

    const pool = document.instruments.find((i) => i.id === "pool");
    expect(pool).toBeDefined();
    if (!pool) return;

    expect(pool.lifecycle.states).toEqual([
      "forming",
      "cancelled",
      "active_cycle_1",
      "cycle_1_ready",
      "active_cycle_2",
      "cycle_2_ready",
      "active_cycle_3",
      "cycle_3_ready",
      "completed",
    ]);

    expect(pool.actions.ready_cycle_1?.requiresAggregate).toHaveLength(3);
    for (const req of pool.actions.ready_cycle_1?.requiresAggregate ?? []) {
      expect(req.check.kind).toBe("all_in");
      expect(req.statuses).toEqual(["cycle_1_funded", "cycle_1_guaranteed"]);
    }

    const memberA = document.instruments.find(
      (i) => i.id === "pool_member_a_contribution",
    );
    expect(memberA).toBeDefined();
    if (!memberA) return;

    expect(memberA.actions.contribute_cycle_1?.moves?.[0]?.operation).toBe(
      "internal_transfer.create",
    );
    expect(
      memberA.actions.contribute_cycle_1?.moves?.[0]?.bind.destinationAccountId,
    ).toEqual({
      from: "instance",
      path: "refs.escrowAccountId",
    });
    expect(
      memberA.actions.contribute_cycle_1?.moves?.[0]?.bind.sourceAccountId,
    ).toEqual({
      from: "instance",
      path: "fields.memberAAccountId",
    });
  });
});
