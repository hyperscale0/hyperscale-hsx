import { expect, test } from "bun:test";
import {
  canonicalDigest,
  resolveField,
  resolveSubjectRequirement,
  objectActionState,
  objectCreateSchema,
  projectObjectDiscovery,
  validateObjectActionSubject,
} from "@hyperscale0/udl";
import {
  createProviderAdapterRegistry,
  type ProviderAdapter,
} from "@hyperscale0/adl";
import { subjectAdapter } from "../../adl/conformance/subject-adapter.ts";
import { compile } from "../src/compile.ts";
import {
  carsSource,
  objectProgrammeOptions,
  subjectHeader,
} from "./fixtures/object-programme.ts";

function compiled(source = carsSource, options = objectProgrammeOptions) {
  const result = compile(source, options);
  expect(result.diagnostics, "Car must compile before projection").toEqual([]);
  expect(result.artifacts).toBeDefined();
  return result.artifacts!.document;
}

const build = { productBuildId: "conformance-cars", digest: "" };

test("one ADL declaration reaches optional creation and attached-action discovery", async () => {
  const document = compiled();
  const kind = document.objects[0]!;
  const discovery = projectObjectDiscovery(document, {
    ...build,
    digest: await canonicalDigest(document),
  });
  expect(
    kind.fields.find((field) => field.name === "referenceCode"),
    "ADL referenceCode must reach the compiled object",
  ).toEqual({
    name: "referenceCode",
    type: "text",
    minLength: 1,
  });
  expect(
    objectCreateSchema(kind).safeParse({}).success,
    "empty create body must remain valid",
  ).toBe(true);
  const create = discovery.kinds[0]!.createSchema;
  const fields = create.properties!
    .fields as import("@hyperscale0/udl").JsonSchemaDocument;
  expect(fields.properties!.referenceCode).toMatchObject({
    type: "string",
    minLength: 1,
  });
  expect(
    fields.required ?? [],
    "adapter metadata is optional at create",
  ).not.toContain("referenceCode");
  const action = discovery.kinds[0]!.actions[0]!;
  expect(
    action.requirements.map((field) => field.name),
    "ADL referenceCode must reach the attached action",
  ).toEqual(["referenceCode"]);
  expect(objectActionState(action, {}).requiredNow).toEqual(["referenceCode"]);
  expect(
    objectActionState(action, { referenceCode: "synthetic-42" }).requiredNow,
  ).toEqual([]);
});

test("mutation conflicting authored type reports subject_field_conflict", () => {
  const mutation = carsSource.replace(
    "make: text",
    "referenceCode: integer, make: text",
  );
  expect(
    compile(mutation, objectProgrammeOptions).diagnostics.map(
      (item) => item.code,
    ),
    "incompatible authored and adapter types must refuse",
  ).toEqual(["subject_field_conflict"]);
});

test("mutation unknown rename source reports subject_field_unknown", () => {
  const mutation = carsSource.replace(
    "expose check",
    "rename { absent: renamed } expose check",
  );
  const diagnostics = compile(mutation, objectProgrammeOptions).diagnostics;
  expect(
    diagnostics.map((item) => item.code),
    "rename must name a declared subject requirement",
  ).toEqual(["subject_field_unknown"]);
  expect(
    diagnostics.find((item) => item.code === "subject_field_unknown")?.fix,
    "the fix names the declared requirements so the author can pick one",
  ).toMatch(/^rename one of: /);
});

test("mutation missing invocation metadata reports subject_requirement_missing", () => {
  const action = projectObjectDiscovery(compiled(), build).kinds[0]!
    .actions[0]!;
  expect(
    validateObjectActionSubject(action, {}, {}),
    "missing metadata must refuse before dispatch",
  ).toMatchObject([
    {
      code: "subject_requirement_missing",
      action: "check",
      field: "referenceCode",
      origin: "car_verification.check.subject.referenceCode",
    },
  ]);
  expect(
    validateObjectActionSubject(action, { referenceCode: "stored" }, {}),
  ).toEqual([]);
  expect(
    validateObjectActionSubject(
      action,
      { referenceCode: "stored" },
      { referenceCode: "" },
    ),
  ).toMatchObject([{ code: "subject_requirement_missing" }]);
});

test("mutation removed registry binding reports subject_adapter_unbound", () => {
  const document = compiled(carsSource, {
    ...objectProgrammeOptions,
    adapterRegistry: {},
  });
  const action = projectObjectDiscovery(document, build).kinds[0]!.actions[0]!;
  expect(
    document.instruments[0]!.actions.check!.subject!.adapters[0]!.snapshot,
  ).toBeNull();
  expect(
    action.availability,
    "undeclared adapter must make its action unavailable",
  ).toMatchObject({
    status: "unavailable",
    code: "subject_adapter_unbound",
  });
  expect(validateObjectActionSubject(action, {}, {})).toMatchObject([
    {
      code: "subject_adapter_unbound",
      action: "check",
    },
  ]);
});

test("ADL refuses ledger accounts as subject metadata", () => {
  const binding = subjectAdapter.operationMap["subject.check"]!;
  const adapter = {
    ...subjectAdapter,
    operationMap: {
      "subject.check": {
        ...binding,
        subjectRequirements: [{ name: "held", type: "account", owner: "self" }],
      },
    },
  } as unknown as ProviderAdapter;
  expect(
    () => createProviderAdapterRegistry()([adapter]),
    "ADL subject declarations must reject ledger accounts",
  ).toThrow(/subjectRequirements/);
});

test("mandatory invocation inherits requirements and unavailable adapters", () => {
  const header = subjectHeader.replace(
    "action check {",
    `action run {
    from: pending, to: checked
    invoke: [{ reference: self, action: check, input: {} }]
  }
  action check {`,
  );
  const options = {
    ...objectProgrammeOptions,
    standardLibrary: { source: () => header },
  };
  const source = carsSource.replace(
    "expose check as check",
    "expose run as run",
  );
  const document = compiled(source, options);
  expect(
    document.instruments[0]!.actions.run!.subject?.requirements.map(
      (requirement) => requirement.field.name,
    ),
    "mandatory invocation must inherit the child's subject requirement",
  ).toEqual(["referenceCode"]);
  const conflicting = header.replace(
    "action run {",
    "action run { subject { referenceCode: integer }",
  );
  const conflict = compile(source, {
    ...options,
    standardLibrary: { source: () => conflicting },
  }).diagnostics[0]!;
  expect(conflict.code).toBe("subject_field_conflict");
  expect(
    conflict.related?.map((origin) =>
      conflicting.slice(origin.span.start, origin.span.end),
    ),
  ).toEqual(["referenceCode: integer", "adapter: verification"]);
  const unbound = compiled(source, { ...options, adapterRegistry: {} });
  expect(
    projectObjectDiscovery(unbound, build).kinds[0]!.actions[0]!.availability,
    "mandatory invocation must inherit the child's unavailable adapter",
  ).toMatchObject({ status: "unavailable", code: "subject_adapter_unbound" });
});

test("the design escrow attachment resolves subject.price through its rename", () => {
  const document = compiled(
    `program p "P"
use escrow
object car "Car" {
  attach sale = escrow.hold {
    payer: actor, payee: owner
    rename { price: salePrice }
    expose fund as sell
  }
}`,
    {},
  );
  const sale = document.instruments.find((item) => item.id === "car_sale")!;
  expect(resolveSubjectRequirement(sale, "price")?.objectField).toBe(
    "salePrice",
  );
  expect(resolveField(document, sale, "subject.price")).toMatchObject({
    name: "salePrice",
    type: "money",
  });
  expect(
    projectObjectDiscovery(
      document,
      build,
    ).kinds[0]!.actions[0]!.requirements.map((field) => field.name),
  ).toEqual(["salePrice"]);
});

const creationSource = `program p "P"
object car "Car" {
  attach review = review { expose check as check, expose approve as approve }
}
instrument review() {
  fields { note: text }
  lifecycle { states: [pending, checked, approved], initial: pending }
  action create { input { token: text } }
  action check { from: pending, to: checked, subject { note: text } }
  action approve { from: checked, to: approved }
}`;

function creationProjection(source = creationSource) {
  return projectObjectDiscovery(compiled(source, {}), build).kinds[0]!;
}

test("complete creation overlap retains the action requirement on existing attachments", () => {
  const check = creationProjection().actions[0]!;
  expect(check.creationOnlyNames).toEqual([]);
  expect(objectActionState(check, {}, { attached: true }).requiredNow).toEqual([
    "note",
  ]);
  expect(
    validateObjectActionSubject(check, {}, {}, { attached: true }),
  ).toMatchObject([{ code: "subject_requirement_missing", field: "note" }]);
});

test("creation-only fields permit omission but validate supplied values after attachment", () => {
  const check = creationProjection(
    creationSource.replace(", subject { note: text }", ""),
  ).actions[0]!;
  expect(
    validateObjectActionSubject(check, {}, {}, { attached: true }),
  ).toEqual([]);
  expect(
    validateObjectActionSubject(check, {}, { note: 123 }, { attached: true }),
  ).toMatchObject([{ code: "subject_requirement_missing", field: "note" }]);
});

test("projection deduplicates repeated creation requirements", () => {
  const document = compiled(creationSource, {});
  const requirements =
    document.instruments[0]!.actions.create!.subject!.requirements;
  requirements.push(requirements[0]!);
  const check = projectObjectDiscovery(document, build).kinds[0]!.actions[0]!;
  expect(check.creationRequirements?.map((field) => field.name)).toEqual([
    "note",
  ]);
  expect(check.requirements.map((field) => field.name)).toEqual(["note"]);
});

test("only initial transitions inherit creation requirements and hidden inputs stay private", () => {
  const kind = creationProjection(
    creationSource.replace(", subject { note: text }", ""),
  );
  expect(kind.actions[0]!.requirements.map((field) => field.name)).toEqual([
    "note",
  ]);
  expect(kind.actions[1]!.requirements).toEqual([]);
  expect(kind.actions[0]!.inputSchema.properties).toEqual({});
  expect(
    compile(
      creationSource.replace("from: pending, to: checked, ", ""),
      {},
    ).diagnostics.map((issue) => issue.message),
  ).toContain("action check needs from and to");
});

const listSource = `program p "P"
object car "Car" {
  attach bundle = bundle { expose link as link }
}
instrument bundle() {
  fields { reviews: list(ref<bundle>, 5) }
  lifecycle { states: [active], initial: active }
  action create {}
  action link { from: active, to: active }
}`;

test("attachment reference list renames refuse until their mapping can execute", () => {
  const renamed = listSource.replace(
    "expose link",
    "rename { reviews: carReviews } expose link",
  );
  expect(compile(renamed, {}).diagnostics.map((issue) => issue.code)).toContain(
    "subject_field_unknown",
  );
});

test("optional attachment lists allow omission and validate supplied members", () => {
  const document = compiled(listSource, {});
  // UDL supports optional lists; HSX call-type syntax does not yet express them.
  document.instruments[0]!.fields[0]!.optional = true;
  const action = projectObjectDiscovery(document, build).kinds[0]!.actions[0]!;
  expect(action.inputSchema.properties).toEqual({});
  expect(objectActionState(action, {}).requiredNow).toEqual([]);
  expect(validateObjectActionSubject(action, {}, {})).toEqual([]);
  expect(
    validateObjectActionSubject(action, {}, { reviews: [123] }),
  ).toMatchObject([{ code: "subject_requirement_missing", field: "reviews" }]);
});
