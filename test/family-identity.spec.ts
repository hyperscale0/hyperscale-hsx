import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertValidUdl } from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";

const fixtureHeader = `header fixture
instrument facility {
  familyRevision: 1
  fields {}
  lifecycle { states: [active], initial: active }
  action create {}
  records {
    tranche: {
      fields {
        facility: ref<parent>
      }
      lifecycle { states: [active], initial: active }
      action create {}
      action touch { from: active, to: active }
    }
    custom_tranche: {
      familyRevision: 3
      fields {}
      lifecycle { states: [active], initial: active }
      action create {}
    }
  }
}

instrument standalone {
  familyRevision: 2
  fields {}
  lifecycle { states: [active], initial: active }
  action create {}
  action touch { from: active, to: active }
}
`;

function compileFixture(source: string) {
  return compile(source, {
    standardLibrary: {
      source: (name) =>
        name === "fixture"
          ? fixtureHeader
          : readFileSync(
              new URL(`../std/${name}.hsx`, import.meta.url),
              "utf8",
            ),
    },
  });
}

test("Two attachments of same declaration emit distinct instrument IDs but identical family tuples", () => {
  const source = `program dual_attachments "Dual"
use fixture
party client: person
object facility_pool "FacilityPool" {
  attach alpha = fixture.facility { expose create as create_alpha }
  attach beta = fixture.facility { expose create as create_beta }
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(() => assertValidUdl(doc)).not.toThrow();

  const alpha = doc.instruments.find((i) => i.id === "facility_pool_alpha");
  const beta = doc.instruments.find((i) => i.id === "facility_pool_beta");
  expect(alpha).toBeDefined();
  expect(beta).toBeDefined();
  expect(alpha!.id).not.toEqual(beta!.id);
  expect(alpha!.family).toEqual({
    module: "fixture",
    exportPath: "facility",
    revision: 1,
  });
  expect(beta!.family).toEqual({
    module: "fixture",
    exportPath: "facility",
    revision: 1,
  });

  const alphaTranche = doc.instruments.find(
    (i) => i.id === "facility_pool_alpha_tranche",
  );
  const betaTranche = doc.instruments.find(
    (i) => i.id === "facility_pool_beta_tranche",
  );
  expect(alphaTranche).toBeDefined();
  expect(betaTranche).toBeDefined();
  expect(alphaTranche!.id).not.toEqual(betaTranche!.id);
  expect(alphaTranche!.family).toEqual({
    module: "fixture",
    exportPath: "facility.tranche",
    revision: 1,
  });
  expect(betaTranche!.family).toEqual({
    module: "fixture",
    exportPath: "facility.tranche",
    revision: 1,
  });

  const customTranche = doc.instruments.find(
    (i) => i.id === "facility_pool_alpha_custom_tranche",
  );
  expect(customTranche).toBeDefined();
  expect(customTranche!.family).toEqual({
    module: "fixture",
    exportPath: "facility.custom_tranche",
    revision: 3,
  });
});

test("Authoring family resolves without concrete instrument ID in source", () => {
  const source = `program resolution "Resolution"
use fixture
party client: person
object loan "Loan" {
  attach fac = fixture.facility { expose create as create_fac }
}
instrument tracker {
  fields {
    boundTranche: {
      family: fixture.facility.tranche
    }
    boundFacility: {
      family: fixture.facility
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
  action check {
    from: active, to: active
    invoke: [
      {
        selection: {
          family: fixture.facility.tranche,
          reference: "facility",
          anchor: self.boundFacility,
          states: [active],
          limit: 1
        },
        action: touch,
        input: {}
      }
    ]
  }
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(() => assertValidUdl(doc)).not.toThrow();

  const tracker = doc.instruments.find((i) => i.id === "tracker");
  expect(tracker).toBeDefined();

  const refField = tracker!.fields.find((f) => f.name === "boundTranche");
  expect(refField).toBeDefined();
  expect(refField!.type).toEqual("ref");
  if (refField!.type === "ref") {
    expect(refField!.target).toEqual("loan_fac_tranche");
    expect(refField!.targetFamily).toEqual({
      module: "fixture",
      exportPath: "facility.tranche",
      revision: 1,
    });
  }

  const checkAction = tracker!.actions.check;
  expect(checkAction).toBeDefined();
  expect(checkAction!.invoke).toBeDefined();
  const inv = checkAction!.invoke![0]!;
  expect("selection" in inv).toBe(true);
  if ("selection" in inv) {
    expect(inv.selection.instrument).toEqual("loan_fac_tranche");
    expect(inv.selection.family).toEqual({
      module: "fixture",
      exportPath: "facility.tranche",
      revision: 1,
    });
  }
});

test("Compilation refuses when selection.family does not match resolved target", () => {
  const source = `program mismatch_selection "MismatchSelection"
use fixture
party client: person
object loan "Loan" {
  attach standalone_inst = fixture.standalone { expose create as create_standalone }
}
instrument inspector {
  fields {}
  lifecycle { states: [active], initial: active }
  action create {}
  action inspect {
    from: active, to: active
    invoke: [
      {
        selection: {
          instrument: loan_standalone_inst,
          family: fixture.facility.tranche,
          reference: "parent",
          anchor: self.id,
          states: [active],
          limit: 1
        },
        action: touch,
        input: {}
      }
    ]
  }
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(
    result.diagnostics.some(
      (d) =>
        d.code === "HSX1001" &&
        d.message.includes("does not match expected family"),
    ),
  ).toBe(true);
});

test("Compilation refuses when targetFamily does not match reference target", () => {
  const source = `program mismatch_target "MismatchTarget"
use fixture
party client: person
object loan "Loan" {
  attach standalone_inst = fixture.standalone { expose create as create_standalone }
}
instrument validator {
  fields {
    wrongRef: {
      target: loan_standalone_inst,
      targetFamily: fixture.facility.tranche
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(
    result.diagnostics.some(
      (d) =>
        d.code === "HSX1001" &&
        d.message.includes("does not match expected family"),
    ),
  ).toBe(true);
});

test("Standard financing family resolution works with standard library", () => {
  const source = `program std_financing "StdFinancing"
use escrow
use financing
object contract "Contract" {
  fields { make: text }
  attach sale = escrow.hold { payer: actor, payee: owner, expose fund as sell }
  attach limits = financing.limits { borrower: actor, per_borrower: 60000 SAR }
  attach ceiling = financing.portfolio_limit { limit: 1500000 SAR }
  attach plan = financing.installments {
    borrower: actor, capital: operator, share: 25%
    months: 3, profit: 2.5%, funds: sale, limits: limits, portfolio: ceiling
    expose create as finance
  }
}
instrument slice_picker {
  fields {
    primarySlice: {
      family: financing.installments.slice
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(() => assertValidUdl(doc)).not.toThrow();

  const planInst = doc.instruments.find((i) => i.id === "contract_plan");
  expect(planInst).toBeDefined();
  expect(planInst!.family).toEqual({
    module: "financing",
    exportPath: "installments",
    revision: 1,
  });

  const sliceInst = doc.instruments.find((i) => i.id === "contract_plan_slice");
  expect(sliceInst).toBeDefined();
  expect(sliceInst!.family).toEqual({
    module: "financing",
    exportPath: "installments.slice",
    revision: 1,
  });

  const picker = doc.instruments.find((i) => i.id === "slice_picker");
  expect(picker).toBeDefined();
  const f = picker!.fields.find((f) => f.name === "primarySlice");
  expect(f).toBeDefined();
  expect(f!.type).toEqual("ref");
  if (f!.type === "ref") {
    expect(f!.target).toEqual("contract_plan_slice");
    expect(f!.targetFamily).toEqual({
      module: "financing",
      exportPath: "installments.slice",
      revision: 1,
    });
  }
});

test("Attached child record with underscore in identifier resolves family from declaration map", () => {
  // Mutation: rebuild export path with replaceAll("_", ".") so custom_tranche resolves to custom.tranche.
  const source = `program child_record_underscore "ChildRecordUnderscore"
use fixture
party client: person
object facility_pool "FacilityPool" {
  attach alpha = fixture.facility { expose create as create_alpha }
}
instrument custom_tracker {
  fields {
    boundCustomTranche: {
      target: facility_pool_alpha_custom_tranche
      family: fixture.facility.custom_tranche
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(() => assertValidUdl(doc)).not.toThrow();

  const tracker = doc.instruments.find((i) => i.id === "custom_tracker");
  expect(tracker).toBeDefined();
  const refField = tracker!.fields.find((f) => f.name === "boundCustomTranche");
  expect(refField).toBeDefined();
  expect(refField!.type).toEqual("ref");
  if (refField!.type === "ref") {
    expect(refField!.target).toEqual("facility_pool_alpha_custom_tranche");
    expect(refField!.targetFamily).toEqual({
      module: "fixture",
      exportPath: "facility.custom_tranche",
      revision: 3,
    });
  }
});

test("Reference field blocks accept an explicit union target list", () => {
  // Mutation: call text() unconditionally on reference target block.
  const source = `program union_target_list "UnionTargetList"
use fixture
party client: person
object facility_pool "FacilityPool" {
  attach alpha = fixture.facility { expose create as create_alpha }
  attach beta = fixture.facility { expose create as create_beta }
}
instrument union_tracker {
  fields {
    bothTranches: {
      target: [facility_pool_alpha_tranche, facility_pool_beta_tranche]
      family: fixture.facility.tranche
    }
  }
  lifecycle { states: [active], initial: active }
  action create {}
}
`;
  const result = compileFixture(source);
  expect(result.diagnostics).toEqual([]);
  const doc = result.artifacts!.document;
  expect(() => assertValidUdl(doc)).not.toThrow();

  const tracker = doc.instruments.find((i) => i.id === "union_tracker");
  expect(tracker).toBeDefined();
  const refField = tracker!.fields.find((f) => f.name === "bothTranches");
  expect(refField).toBeDefined();
  expect(refField!.type).toEqual("ref");
  if (refField!.type === "ref") {
    expect(refField!.target).toEqual([
      "facility_pool_alpha_tranche",
      "facility_pool_beta_tranche",
    ]);
    expect(refField!.targetFamily).toEqual({
      module: "fixture",
      exportPath: "facility.tranche",
      revision: 1,
    });
  }
});
