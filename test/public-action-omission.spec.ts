import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";
import type { UdlDocument } from "@hyperscale0/udl";

const source = (
  actionBody: string,
) => `program private_actions "Private actions"
instrument private_job {
  fields {}
  lifecycle { states created complete; initial created; on finish: created -> complete; }
  action create { steps: []; }
  action finish { ${actionBody}; steps: []; moves: []; }
}`;

describe("public action omission", () => {
  it("consumes public: none before default public-action synthesis", () => {
    const result = compile(source("public: none"));

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    expect(document?.instruments[0]?.actions.finish).not.toHaveProperty(
      "publicAction",
    );
  });

  it("rejects an opt-out combined with a public name", () => {
    const result = compile(
      source("public: none; public_action: finishPrivateJob"),
    );

    expect(result.verdict).toBe("invalid");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1506" }),
    );
  });
});
