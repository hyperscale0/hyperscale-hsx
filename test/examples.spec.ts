import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseUdl,
  serializeUdl,
  type UdlDocument,
  type UdlInstrument,
} from "@hyperscale0/udl";
import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

const packageRoot = join(import.meta.dir, "..");
const examplesRoot = join(packageRoot, "examples");
const stdRoot = join(packageRoot, "std", "money_flows");

function modules(): string[] {
  return readdirSync(stdRoot)
    .filter((file) => file.endsWith(".hsx") && file !== "index.hsx")
    .map((file) => file.slice(0, -4))
    .sort();
}

describe("standard-library examples", () => {
  for (const name of modules()) {
    it(`${name} compiles to its pinned canonical UDL`, () => {
      const directory = join(examplesRoot, name);
      const source = readFileSync(join(directory, `${name}.hsx`), "utf8");
      const pinned = readFileSync(join(directory, `${name}.udl`), "utf8");
      const readme = readFileSync(join(directory, "README.md"), "utf8");
      const result = compile(source, {
        moduleName: `examples/${name}/${name}.hsx`,
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
      expect(result.artifacts).toBeDefined();
      expect(serializeUdl(result.artifacts!.document)).toBe(pinned);
      expect(readme).toContain(`\`${name}\``);
    });
  }

  it("reads the example set from std/money_flows", () => {
    for (const name of modules()) {
      expect(readdirSync(join(examplesRoot, name)).sort()).toEqual([
        "README.md",
        `${name}.hsx`,
        `${name}.udl`,
      ]);
    }
  });
});

function allExampleFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...allExampleFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".hsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("tutorial examples compile cleanly to valid UDL", () => {
  const exampleFiles = readdirSync(examplesRoot)
    .filter((name) => /^0[1-5]-/.test(name))
    .flatMap((name) => allExampleFiles(join(examplesRoot, name)))
    .filter((file) => !file.endsWith("03-diagnostics/corner-shop.hsx"))
    .sort();

  for (const file of exampleFiles) {
    const relativePath = file.slice(packageRoot.length + 1);
    it(`${relativePath} compiles cleanly without diagnostics`, () => {
      const source = readFileSync(file, "utf8");
      const result = compile(source, { moduleName: relativePath });
      expect(result.diagnostics).toEqual([]);
      expect(result.verdict).toBe("valid");
    });
  }
});

describe("standard library family witnesses", () => {
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

  function getInstrument(document: UdlDocument, id: string): UdlInstrument {
    const found = document.instruments.find((i) => i.id === id);
    if (!found) throw new Error(`missing instrument ${id}`);
    return found;
  }

  it("fractional percentages emit numeric basis points", () => {
    const source = readFileSync(
      join(import.meta.dir, "fixtures", "fractional-bps.hsx"),
      "utf8",
    );
    const result = compile(source);
    if (!result.artifacts) {
      throw new Error(
        result.diagnostics.map((item) => item.message).join("\n"),
      );
    }
    const actual = serializeUdl(result.artifacts.document);
    const document = parseUdl(actual);
    expect(
      document.instruments[0]?.feeRules?.map((fee) => fee.rule),
    ).toContainEqual({ bps: 150, kind: "bps" });
  });

  it("weighted distribution emits its parent and entitlement instruments", () => {
    const document = compileFixture("test/fixtures/weighted-distribution.hsx");
    expect(document.instruments.map((i) => i.id)).toEqual([
      "proceeds",
      "proceeds_entitlement",
    ]);
    const proceeds = getInstrument(document, "proceeds");
    expect(proceeds.lifecycle.states).toEqual(["open", "snapshotted"]);
    const entitlement = getInstrument(document, "proceeds_entitlement");
    expect(entitlement.lifecycle.states).toEqual(["recorded", "paid"]);
    expect(entitlement.actions.payout?.distribute?.amountRef).toBe(
      "payoutShare",
    );
  });

  it("policy disbursement emits submitted parent and approved amount child", () => {
    const document = compileFixture("test/fixtures/policy-disbursement.hsx");
    const disbursement = getInstrument(document, "disbursement");
    const child = getInstrument(document, "disbursement_approved_amount");
    expect(disbursement.lifecycle.states).toEqual(["submitted", "denied"]);
    expect(child.lifecycle.states).toEqual(["created", "approved", "paid"]);
    expect(child.actions.approve?.requiresExposure).toBeDefined();
  });

  it("installment obligation unrolls parent obligation and companion installment payments", () => {
    const document = compileFixture("test/fixtures/installment-obligation.hsx");
    expect(document.instruments.map((i) => i.id)).toEqual([
      "obligation",
      "obligation_installment_1_payment",
      "obligation_installment_2_payment",
      "obligation_installment_3_payment",
    ]);
    const obligation = getInstrument(document, "obligation");
    expect(obligation.lifecycle.states).toEqual([
      "draft",
      "approved",
      "active",
      "installment_1_delinquent",
      "installment_2_delinquent",
      "installment_3_delinquent",
      "written_off",
      "repaid",
    ]);
  });

  it("settlement batch emits parent with signed sum calculation and companion adjustments", () => {
    const source = readFileSync(
      join(import.meta.dir, "fixtures/settlement-batch.hsx"),
      "utf8",
    );
    const result = compile(source, {
      moduleName: "test/fixtures/settlement-batch.hsx",
    });
    expect(result.diagnostics).toEqual([]);
    if (!result.artifacts) throw new Error("settlement batch did not compile");
    const document = result.artifacts.document as UdlDocument;
    expect(document.instruments.map((i) => i.id)).toEqual([
      "payout_batch",
      "payout_batch_capture_entry",
      "payout_batch_credit_adjustment",
      "payout_batch_debit_adjustment",
    ]);
    const batch = getInstrument(document, "payout_batch");
    expect(batch.actions.calculate?.signedSum).toBeDefined();
  });

  it("comic swap preserves atomic swap semantics with two-sided funding and dispute window", () => {
    const document = compileFixture("test/fixtures/comic-swap.hsx");
    const trade = getInstrument(document, "trade");
    expect(trade.distinctParties).toBe(true);
    expect(trade.lifecycle.states).toEqual([
      "created",
      "abandoned",
      "funded",
      "cancelled",
      "released",
      "settled",
      "clawed_back",
    ]);
  });

  it("conditional disbursement deny honors port input shape and role mapping", () => {
    const source = `program test_disbursement "Test disbursement"
import { conditional_disbursement } from "std/money_flows"

party source_firm: business
party claimant: person

settlement claim_payout = conditional_disbursement {
  source: source_firm
  destination: claimant
  cap: maxPayout: money(SAR)
  amount: approvedSum: money(SAR)
  decision: port review_claim
  reopen_policy: refuse
  recovery_policy: separate_transfer
}

port review_claim {
  allowed: [source_firm, claimant]
  shape { rejectionCode: text }
}`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document as UdlDocument;
    const disbursement = getInstrument(document, "claim_payout");
    expect(disbursement.actions.deny?.input?.required).toEqual([
      "rejectionCode",
    ]);
    expect(disbursement.actions.deny?.port?.allowedParties).toEqual([
      "payer",
      "beneficiary",
    ]);
  });

  it("premium forward endorsement honors port input shape and role mapping", () => {
    const source = `program test_premium "Test premium"
import { premium_forward } from "std/money_flows"

party insured: person
party insurer: business

settlement policy_forward = premium_forward {
  payer: insured
  carrier: insurer
  amount: premiumTotal: money(SAR)
  bind: port bind_policy
  commission: 5%
  policy_ref: policyReference
  renewal_due: renewalDate
  endorsement: port add_rider
}

port bind_policy {
  allowed: [insured, insurer]
  shape { bindEvidence: text }
}

port add_rider {
  allowed: [insurer]
  shape { riderDetails: text }
}`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document as UdlDocument;
    const policy = getInstrument(document, "policy_forward");
    expect(policy.actions.add_rider?.input?.required).toEqual(["riderDetails"]);
    expect(policy.actions.add_rider?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
  });

  it("swap dispute honors port input shape and role mapping", () => {
    const source = `program test_swap "Test swap"
import { swap } from "std/money_flows"

party party_a: person
party party_b: person

settlement atomic_trade = swap {
  between: [party_a, party_b]
  amounts {
    party_a: sideAPays: money(SAR)
    party_b: sideBPays: money(SAR)
  }
  fees {
    party_a: sideAFee: money(SAR)
    party_b: sideBFee: money(SAR)
  }
  release: port confirm_trade
  dispute: port dispute_trade within P7D
}

port confirm_trade {
  allowed: [party_a, party_b]
}

port dispute_trade {
  allowed: [party_b]
  shape { disputeReason: text }
}`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document as UdlDocument;
    const trade = getInstrument(document, "atomic_trade");
    expect(trade.actions.dispute?.input?.required).toEqual(["disputeReason"]);
    expect(trade.actions.dispute?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
  });

  it("scheduled until honors port input shape and role mapping", () => {
    const source = `program test_scheduled "Test scheduled"
import { scheduled } from "std/money_flows"

party subscriber: person
party provider: business

settlement subscription = scheduled {
  mode: obligation
  payer: subscriber
  payee: provider
  debtor: subscriber
  amount: monthlyFee: money(SAR)
  every: P1M
  first_due: firstDueAt
  until: port terminate_plan
  month_end: clamp_to_last_day
  period_liability: one_open
  termination_drain: terminate_plan
  mandate: port mandate_agree
}

port mandate_agree {
  allowed: [subscriber]
  shape { mandateRef: text }
}

port terminate_plan {
  allowed: [provider]
  shape { cancelReason: text }
}`;
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    const document = result.artifacts?.document as UdlDocument;
    const plan = getInstrument(document, "subscription");
    expect(plan.actions.terminate_plan?.input?.required).toEqual([
      "cancelReason",
    ]);
    expect(plan.actions.terminate_plan?.port?.allowedParties).toEqual([
      "beneficiary",
    ]);
  });
});
