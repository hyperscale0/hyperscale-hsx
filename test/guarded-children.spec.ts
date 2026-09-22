import { expect, test } from "bun:test";
import {
  objectActionState,
  objectActionSelf,
  projectObjectDiscovery,
  validateObjectActionSubject,
} from "@hyperscale0/udl";
import { compile } from "../src/compile.ts";

function programme(
  guard = "subject.enabled",
  operator = "==",
  literal = "true",
) {
  return `program guarded "Guarded"
object car "Cars" { attach review = review { expose check as check } }
instrument review() {
 fields { enabled: boolean = false }
 lifecycle { states: [pending, checked], initial: pending }
 action create {}
 action check {
  from: pending, to: checked
  subject { enabled: boolean, price: money }
  input { chosen: boolean }
  invoke: [{ instrument: child, action: create, input: {},
    guard: { kind: compare, left: { field: ${guard} }, operator: "${operator}", right: { literal: ${literal} } } }]
 }
 records { child: {
  fields {}
  lifecycle { states: [pending, finished], initial: pending }
  action create { actor: { parent: parent }, subject { referenceCode: text } }
  action finish { from: pending, to: finished }
 } }
}`;
}
function project(source = programme()) {
  const result = compile(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.artifacts).toBeDefined();
  const document = result.artifacts!.document;
  const action = projectObjectDiscovery(document, {
    productBuildId: "guarded",
    digest: "",
  }).kinds[0]!.actions.find((action) => action.name === "check");
  expect(action).toBeDefined();
  return { document, action: action! };
}

// WITNESS-GUARDED-PROJECTION: restore `if (call.guard) continue` in propagation.
test("WITNESS-GUARDED-PROJECTION retains the guard and suppresses only known false requirements", () => {
  const { document, action } = project();
  expect(
    document.instruments[0]!.actions.check!.subject!.requirements.find(
      (r) => r.field.name === "referenceCode",
    ),
  ).toMatchObject({
    when: [
      [
        {
          instrument: "car_review",
          action: "check",
          guard: {
            kind: "compare",
            left: { field: "subject.enabled" },
            operator: "==",
            right: { literal: true },
          },
        },
      ],
    ],
  });
  expect(action.requirementConditions?.referenceCode).toBeDefined();
  expect(
    objectActionState(action, { enabled: false, price: "100" }).requiredNow,
  ).toEqual([]);
  expect(
    objectActionState(action, { enabled: true, price: "100" }).requiredNow,
  ).toEqual(["referenceCode"]);
  expect(objectActionState(action, { price: "100" }).requiredNow).toEqual([
    "enabled",
    "referenceCode",
  ]);
  expect(
    validateObjectActionSubject(
      action,
      { enabled: true, price: "100" },
      { referenceCode: "receipt-1" },
    ),
  ).toEqual([]);
});

// WITNESS-GUARD-CONTEXT: remove self/input resolution or money conversion from requirementPossible.
test("WITNESS-GUARD-CONTEXT resolves known self and input values and compares money numerically", () => {
  for (const root of ["self.enabled", "input.chosen"]) {
    const { action } = project(programme(root));
    const fields = { enabled: true, price: "100" };
    expect(objectActionState(action, fields).requiredNow).toEqual([
      "referenceCode",
    ]);
    expect(
      objectActionState(action, fields, {
        self: { enabled: false },
        input: { chosen: false },
      }).requiredNow,
    ).toEqual([]);
  }
  const { action } = project(programme("subject.price", ">", '"9"'));
  expect(
    objectActionState(action, { enabled: false, price: "10" }).requiredNow,
  ).toEqual(["referenceCode"]);
  expect(
    objectActionState(action, { enabled: false, price: "8" }).requiredNow,
  ).toEqual([]);
});

// WITNESS-CHILD-ATTACHMENT: restore the empty child expose map with child public-action deletion.
test("WITNESS-CHILD-ATTACHMENT projects child servicing with an explicit attachment parent", () => {
  const { document } = project();
  expect(document.objects[0]!.attachments).toContainEqual({
    name: "review_child",
    parent: "review",
    instrument: "car_review_child",
    parties: {},
  });
  const actions = projectObjectDiscovery(document, {
    productBuildId: "guarded",
    digest: "",
  }).kinds[0]!.actions;
  const finish = actions.find(
    (action) =>
      action.instrument === "car_review_child" && action.action === "finish",
  );
  expect(finish).toBeDefined();
  expect(finish!.target).toEqual({
    kind: "attachment",
    attachment: "review_child",
  });
  expect(
    actions.some(
      (action) =>
        action.instrument === "car_review_child" && action.action === "create",
    ),
  ).toBe(false);
});

// WITNESS-GUARD-ALTERNATIVES: drop the merge of a second conditional invocation path.
test("WITNESS-GUARD-ALTERNATIVES keeps either route and lets an unconditional requirement win", () => {
  const source = programme().replace(
    "action check {",
    `action check {
      invoke: [{ instrument: child, action: create, input: {},
        guard: { kind: compare, left: { field: input.chosen }, operator: "==", right: { literal: true } } }]`,
  );
  const { action } = project(source);
  const fields = { enabled: false, price: "100" };
  expect(action.requirementConditions?.referenceCode).toHaveLength(2);
  expect(
    objectActionState(action, fields, { input: { chosen: true } }).requiredNow,
  ).toEqual(["referenceCode"]);
  expect(
    objectActionState(action, fields, { input: { chosen: false } }).requiredNow,
  ).toEqual([]);
  const unconditional = project(
    source.replace(
      "enabled: boolean, price: money",
      "enabled: boolean, price: money, referenceCode: text",
    ),
  ).action;
  expect(unconditional.requirementConditions?.referenceCode).toBeUndefined();
  expect(
    objectActionState(unconditional, fields, { input: { chosen: false } })
      .requiredNow,
  ).toEqual(["referenceCode"]);
});

// WITNESS-GUARD-WRITES: retain a field that action.set overwrites in objectActionSelf.
test("WITNESS-GUARD-WRITES does not suppress a branch from a value overwritten before invocation", () => {
  const { document, action } = project(
    programme("self.enabled")
      .replace("enabled: boolean = false", "enabled: boolean")
      .replace(
        "action check {",
        "action check { set: { enabled: { literal: true } }",
      ),
  );
  expect(
    objectActionState(
      action,
      { enabled: false, price: "100" },
      {
        self: objectActionSelf(document.instruments[0]!, "check", {
          enabled: false,
        }),
      },
    ).requiredNow,
  ).toEqual(["referenceCode"]);
});
