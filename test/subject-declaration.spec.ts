import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

describe("subject declarations", () => {
  it("lowers the complete UDL subject document", () => {
    const result = compile(`program vehicles "Vehicles"
subject vehicle {
  title: "Vehicle";
  version: 2;
  declared_value: required;
  schema: {
    type: "object";
    additionalProperties: false;
    properties: {
      vin: { type: "string"; minLength: 11; maxLength: 17; };
      "policy_number": { type: "string"; };
    };
    required: ["vin", "policy_number"];
  };
}
instrument listing {
  fields {}
  lifecycle { states created; initial created; }
  action create { steps: []; }
}`);

    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      subjects: [
        {
          declaredValue: "required",
          kind: "vehicle",
          schema: {
            additionalProperties: false,
            properties: {
              policy_number: { type: "string" },
              vin: { maxLength: 17, minLength: 11, type: "string" },
            },
            required: ["vin", "policy_number"],
            type: "object",
          },
          title: "Vehicle",
          version: 2,
        },
      ],
    });
  });

  it("reports an incomplete subject at its declaration", () => {
    const result = compile(`program broken "Broken"
subject vehicle { title: "Vehicle"; }
instrument listing { fields {}; lifecycle { states created; initial created; }; action create { steps: []; }; }`);

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1008", line: 2 }),
    );
  });
});
