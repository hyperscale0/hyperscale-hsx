import { describe, expect, it } from "bun:test";
import { compile } from "./compile.ts";

describe("update state lists", () => {
  it("keeps lifecycle shorthand inside lifecycle blocks", () => {
    const result = compile(`program records "Records"
instrument record {
  title: "Record";
  summary: "A record";
  id_prefix: "rec";
  fields { memo: string; }
  lifecycle {
    states draft final;
    initial draft;
    on finalize: draft -> final;
  }
  update {
    fields: ["memo"];
    states: ["draft"];
  }
  action create { summary: "Create a record"; steps: []; }
  action finalize { summary: "Finalize a record"; steps: []; moves: []; }
}`);

    expect(result.diagnostics).toEqual([]);
    expect(result.verdict).toBe("valid");
    expect(result.artifacts?.document).toMatchObject({
      instruments: [
        {
          lifecycle: {
            initial: "draft",
            states: ["draft", "final"],
            transitions: {
              finalize: { from: ["draft"], to: "final" },
            },
          },
          update: { fields: ["memo"], states: ["draft"] },
        },
      ],
    });
  });
});
