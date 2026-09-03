import { describe, expect, it } from "bun:test";
import type { UdlDocument } from "@hyperscale0/udl";
import { compile } from "./compile.ts";

const source = (metadata: string) => `program applications "Applications"
export instrument mechanism() {
  title: "Mechanism";
  summary: "Base mechanism";
  fields {}
  lifecycle { states created; initial created; }
  action create { summary: "Create mechanism"; steps: []; }
}
instrument domain_name = mechanism() ${metadata}`;

describe("instrument application metadata", () => {
  it("merges instrument and action metadata before lowering", () => {
    const result = compile(
      source(`{
        template_id: "escrow";
        title: "Domain name";
        summary: "Named application";
        nav: ["Blueprints", "Named applications"];
        action create { summary: "Create domain name"; public: none; }
      }`),
    );

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "domain_name",
    );
    expect(instrument).toMatchObject({
      actions: { create: { summary: "Create domain name" } },
      id: "domain_name",
      nav: ["Blueprints", "Named applications"],
      summary: "Named application",
      templateId: "escrow",
      title: "Domain name",
    });
    expect(instrument?.actions.create).not.toHaveProperty("publicAction");
  });

  it("rejects mechanics in an application metadata block", () => {
    const result = compile(source("{ fields: { amount: money<SAR>; }; }"));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HSX1507" }),
    );
  });

  it("replaces inherited metadata across accepted alias spellings", () => {
    const result = compile(`program aliases "Aliases"
export instrument mechanism() {
  nav: ["Mechanisms"];
  surface_visibility: internal;
  fields {}
  lifecycle { states created; initial created; }
  action create {
    public_action: "createMechanism";
    steps: [];
  }
}
instrument domain_name = mechanism() {
  navigation: ["Domains"];
  visibility: public;
  action create { public: none; }
}`);

    expect(result.verdict).toBe("valid");
    const document = result.artifacts?.document as UdlDocument | undefined;
    const instrument = document?.instruments.find(
      (candidate) => candidate.id === "domain_name",
    );
    expect(instrument?.nav).toEqual(["Domains"]);
    expect(instrument?.surfaceVisibility).toBe("public");
    expect(instrument?.actions.create).not.toHaveProperty("publicAction");
  });
});
