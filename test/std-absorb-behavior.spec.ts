import { readFileSync } from "node:fs";
import type { UdlAction, UdlDocument, UdlInstrument } from "@hyperscale0/udl";
import { expect, test } from "bun:test";
import { compile } from "./compile.ts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

function compileFixture(file: string): UdlDocument {
  const result = compile(readFileSync(new URL(file, fixtureRoot), "utf8"), {
    moduleName: `open/hsx/test/fixtures/${file}`,
  });
  if (!result.artifacts) {
    throw new Error(
      result.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.stage} ${diagnostic.code ?? "uncoded"}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  return result.artifacts.document as unknown as UdlDocument;
}

function instrument(document: UdlDocument, id: string): UdlInstrument {
  const found = document.instruments.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`${id} did not compile`);
  return found;
}

function action(definition: UdlInstrument, name: string): UdlAction {
  const found = definition.actions[name];
  if (!found) throw new Error(`${definition.id}.${name} did not compile`);
  return found;
}

function movePaths(definition: UdlAction): {
  readonly amount: string;
  readonly destination: string;
  readonly source: string;
} {
  const move = definition.moves[0];
  if (!move) throw new Error("the action has no money move");
  const path = (key: string): string => {
    const binding = move.bind[key];
    if (!binding || binding.from !== "instance") {
      throw new Error(`${key} is not bound from the instrument instance`);
    }
    return binding.path;
  };
  return {
    amount: path("amount"),
    destination: path("destinationAccountId"),
    source: path("sourceAccountId"),
  };
}

function compileThresholdWording(wording: string) {
  return compile(`program wording_probe "Wording probe"
import { threshold_pool } from "std/settlements"
party contributor: person
party beneficiary: business
settlement wording_pool = threshold_pool {
  contributor: contributor
  beneficiary: beneficiary
  target: targetAmount: money(SAR)
  commitment: amount: money(SAR)
  max_contributors: 3
  close_by: closeBy
  close_policy: threshold
  overfund_policy: reject
  cancel_policy: before_close
  fail_policy: whole_commitment_refund
  wording: { ${wording} }
}
`);
}

test("the referenced threshold contribution holds, releases, and refunds custody", () => {
  const document = compileFixture("referenced-threshold-pool.hsx");
  const pledge = instrument(document, "community_pledge");
  const pool = instrument(document, "community_raise");

  expect(pledge.required).toContain("communityRaiseId");
  expect(pledge.required).toContain("escrowAccountId");
  expect(action(pool, "create").steps[0]?.capture).toEqual({
    escrowAccountId: "accountId",
  });
  expect(action(pledge, "create").requiresRefs).toEqual([
    {
      bind: {
        beneficiaryAccountId: "fields.beneficiaryAccountId",
        currency: "fields.currency",
        escrowAccountId: "refs.escrowAccountId",
      },
      field: "communityRaiseId",
      statuses: ["open"],
    },
  ]);
  expect(action(pledge, "collect").requiresRefs).toEqual([
    { field: "communityRaiseId", statuses: ["open"] },
  ]);
  expect(movePaths(action(pledge, "collect"))).toEqual({
    amount: "fields.amount",
    destination: "fields.escrowAccountId",
    source: "fields.contributorAccountId",
  });
  expect(action(pledge, "release").requiresRefs).toEqual([
    { field: "communityRaiseId", statuses: ["active"] },
  ]);
  expect(movePaths(action(pledge, "release"))).toEqual({
    amount: "fields.amount",
    destination: "fields.beneficiaryAccountId",
    source: "fields.escrowAccountId",
  });
  expect(action(pledge, "refund").requiresRefs).toEqual([
    { field: "communityRaiseId", statuses: ["failed"] },
  ]);
  expect(movePaths(action(pledge, "refund"))).toEqual({
    amount: "fields.amount",
    destination: "fields.contributorAccountId",
    source: "fields.escrowAccountId",
  });
});

test("delegated membership refuses early activation and owns its cycle money", () => {
  const document = compileFixture("delegated-rotating-pool.hsx");
  const membership = instrument(document, "community_membership");
  const pool = instrument(document, "community_circle");

  expect(membership.required).toContain("communityCircleId");
  expect(membership.required).toContain("potAccountId");
  expect(membership.required).toContain("turnRecipientAccountId");
  expect(membership.parties).toEqual({
    beneficiary: "turnRecipientAccountId",
    payer: "memberAccountId",
  });
  expect(action(pool, "create").steps[0]?.capture).toEqual({
    potAccountId: "accountId",
  });
  expect(action(membership, "create").requiresRefs).toEqual([
    {
      bind: {
        currency: "fields.currency",
        monthlyAmount: "fields.monthlyAmount",
        potAccountId: "refs.potAccountId",
      },
      field: "communityCircleId",
      statuses: ["forming"],
    },
  ]);
  expect(action(membership, "activate").requiresRefs).toEqual([
    { field: "communityCircleId", statuses: ["active"] },
  ]);
  expect(
    action(membership, "activate").requiresRefs?.[0]?.statuses,
  ).not.toContain("forming");
  expect(action(membership, "contribute").due).toEqual({
    field: "contributionDueAt",
  });
  expect(movePaths(action(membership, "contribute"))).toEqual({
    amount: "fields.monthlyAmount",
    destination: "fields.potAccountId",
    source: "fields.memberAccountId",
  });
  expect(action(membership, "payout").due).toEqual({ field: "payoutDueAt" });
  expect(movePaths(action(membership, "payout"))).toEqual({
    amount: "fields.monthlyAmount",
    destination: "fields.turnRecipientAccountId",
    source: "fields.potAccountId",
  });
});

test("threshold pool standard prose uses pool and contribution terms", () => {
  const source = readFileSync(
    new URL("../std/settlements/threshold_pool.hsx", import.meta.url),
    "utf8",
  );
  const authoredStrings = source.match(/"[^"]*"/g) ?? [];

  expect(authoredStrings.filter((value) => /\bround\b/i.test(value))).toEqual(
    [],
  );
});

test("threshold pool wording defaults missing keys", () => {
  const result = compileThresholdWording(
    'pool_summary: "A named contribution pool"',
  );

  expect(result.verdict).toBe("valid");
  if (!result.artifacts) throw new Error("wording probe did not compile");
  const document = result.artifacts.document as unknown as UdlDocument;
  const pool = instrument(document, "wording_pool");
  const commitment = instrument(document, "wording_pool_commitment");
  expect(pool.summary).toBe("A named contribution pool");
  expect(pool.description).toBe(
    "All-or-nothing aggregate contribution threshold",
  );
  expect(action(pool, "create").summary).toBe("Open the contribution pool");
  expect(action(commitment, "create").summary).toBe(
    "Store one whole commitment without exceeding the pool target",
  );
  expect(action(commitment, "cancel").summary).toBe(
    "Cancel one commitment while the pool is open",
  );
  expect(action(commitment, "refund").summary).toBe(
    "Refund one failed-pool commitment whole",
  );
});

test("threshold pool wording refuses one unknown key once", () => {
  const result = compileThresholdWording('unknown_copy: "No"');

  expect(result.verdict).toBe("invalid");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "HSX1407",
      column: 7,
      file: "std.settlements.threshold_pool",
      line: 22,
      message: "threshold_pool wording contains an unknown key",
      stage: "typecheck",
    }),
  ]);
});
