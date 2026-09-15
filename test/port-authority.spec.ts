import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { UdlDocument } from "@hyperscale0/udl";
import { compile } from "./compile.ts";

const literalGate = (port = "") => `program literal_gate "Literal gate"
party buyer: person
party arbiter: business
instrument escrow(gate: condition) {
  title: "Escrow";
  agent_description: "Hold funds in escrow until arbitration resolves.";
  fields {}
  lifecycle { states held settled; initial held; on settle: held -> settled; }
  parties { payer: buyer; decider: arbiter; }
  action create {
    agent_description: "Open the escrow hold before arbitration.";
    steps: [];
  }
  action settle {
    agent_description: "Settle the escrow hold once arbitration completes.";
    steps: []; moves: []; ${port}
  }
}
port arbitrate { allowed: [arbiter] }
instrument sale = escrow(gate: port arbitrate)`;

describe("declared port authority", () => {
  it("binds a consumed gate on a literally named action and rejects an unused gate", () => {
    const unused = compile(`${literalGate()}
instrument sibling {
  agent_description: "A sibling instrument for review tests.";
  fields {}
  lifecycle { states created; initial created; on review: created -> created; }
  action create {
    agent_description: "Create a sibling record.";
    steps: [];
  }
  action review {
    agent_description: "Review the sibling record.";
    steps: []; port { allowed_parties: arbitrate_allowed; }
  }
}`);
    expect(unused.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1024" }),
    );
    expect(unused.artifacts).toBeUndefined();
    const gated = compile(
      literalGate()
        .replace("action settle {", "when(gate) { action settle {")
        .replace("\n}\nport arbitrate", "\n} }\nport arbitrate"),
    );
    expect(gated.verdict).toBe("valid");
    const document = gated.artifacts?.document as UdlDocument | undefined;
    expect(
      document?.instruments[0]?.actions.settle?.port?.allowedParties,
    ).toEqual(["decider"]);
    const clock = compile(
      literalGate("port { allowed_parties: gate_allowed; }")
        .replace("fields {}", "fields { dueAt: date; }")
        .replace(
          "on settle: held -> settled;",
          "on settle: held -> settled; on expire: held -> settled;",
        )
        .replace(
          "\n}\nport arbitrate",
          "\nwhen(gate) { action expire { due { field: dueAt; } steps: []; } }\n}\nport arbitrate",
        ),
    );
    expect(clock.verdict).toBe("valid");
  });

  it("preserves a mandate's declared account authority and rejects overrides", () => {
    const source = readFileSync(
      new URL("./fixtures/mandated-obligation.hsx", import.meta.url),
      "utf8",
    ).replace("allowed: [repayment_source]", "allowed: [recipient]");
    const result = compile(source);
    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const obligation = document?.instruments.find(
      (instrument) => instrument.actions.repay !== undefined,
    );
    expect(
      obligation?.actions.repay?.port?.allowedParties.map(
        (party) => obligation.parties?.[party],
      ),
    ).toEqual(["recipientAccountId"]);

    const overridden = compile(
      literalGate('port { allowed_parties: ["payer"]; }')
        .replace("action settle {", "when(gate) { action settle {")
        .replace("\n}\nport arbitrate", "\n} }\nport arbitrate"),
    );
    expect(overridden.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1024",
        message: expect.stringContaining(
          "does not preserve the allowed parties",
        ),
      }),
    );
    expect(overridden.artifacts).toBeUndefined();
  });

  it("preserves claim authority in the security deposit deadline branch", () => {
    const result = compile(`program deposit "Deposit"
import { security_deposit } from "std/money_flows"
party renter: person
party owner: business
settlement hold = security_deposit {
  payer: renter
  holder: owner
  amount: depositAmount: money(SAR)
  deadline: expiresAt
  claim: port assess_damage
}
port assess_damage { allowed: [owner] }`);
    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const hold = document?.instruments[0];
    expect(
      hold?.actions.claim?.port?.allowedParties.map(
        (party) => hold.parties?.[party],
      ),
    ).toEqual(["ownerAccountId"]);
  });

  it("rejects a declared port that reaches no action in a plain instrument", () => {
    const result = compile(`program plain "Plain"
party buyer: person
port approve { allowed: [buyer] }
instrument invoice {
  title: "Invoice";
  fields {}
  lifecycle { states pending approved; initial pending; on approve: pending -> approved; }
  action create { steps: []; }
  action approve { steps: []; moves: []; }
}`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1024" }),
    );
    expect(result.artifacts).toBeUndefined();
  });

  it("rejects undeclared parties at an unwired port declaration", () => {
    const source = `program unwired "Unwired"
port arbitrate { allowed: [missing_party] }
instrument invoice {
  title: "Invoice";
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`;
    const result = compile(source);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HSX1024",
        line: 2,
        message: expect.stringContaining("missing_party"),
      }),
    );
    expect(result.artifacts).toBeUndefined();
  });

  it("binds a plain money action through capture_input after a sibling consumes the port", () => {
    const result = compile(`program capture_authority "Capture authority"
party arbiter: business
port arbitrate { allowed: [arbiter]; shape { evidence: text; } }
instrument escrow {
  agent_description: "Hold funds in escrow until arbitration resolves.";
  fields { currency: text; evidence { type: text; optional: true; } }
  lifecycle { states held settled; initial held; on review: held -> held; on settle: held -> settled; }
  action create {
    agent_description: "Open an escrow record.";
    steps: [];
  }
  action review {
    agent_description: "Review submitted evidence.";
    steps: []; port { allowed_parties: arbitrate_allowed; }
  }
  action settle {
    agent_description: "Settle the escrow after review.";
    input { type: object; additional_properties: false; properties { evidence { type: string; } } required: ["evidence"]; }
    capture_input { for item in keys(arbitrate_fields) { [item]: item; } }
    moves: [{ amount: "refs.amount"; from: "refs.sourceAccountId"; to: "refs.destinationAccountId"; }];
    steps: [];
  }
}`);
    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const escrow = document?.instruments[0];
    expect(
      escrow?.actions.settle?.port?.allowedParties.map(
        (party) => escrow.parties?.[party],
      ),
    ).toEqual(["arbiterAccountId"]);
  });
});
