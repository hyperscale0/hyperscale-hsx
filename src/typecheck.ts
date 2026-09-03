import {
  deriveUdlActionEffects,
  udlClauseVocabulary,
  type UdlDocument,
  type UdlInstrument,
} from "@hyperscale0/udl";
import type {
  ApplicationScopeDecl,
  ApplyExpr,
  BlockExpr,
  ConstDecl,
  Decl,
  Entry,
  Expr,
  ExposeDecl,
  IdentExpr,
  InstrumentDecl,
  PortDecl,
  Program,
  ProgramDecl,
  Span,
  SubjectDecl,
  UseDecl,
} from "./ast.ts";
import { requiredFields } from "./emit.ts";
import type {
  GeneralCheckResult,
  GeneralDiagnostic,
  HsxType,
  JsonValue,
  TypedAction,
  TypedField,
  TypedInstrument,
  TypedProgram,
  TypedSubject,
} from "./ir.ts";

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONEY_PATTERN = "^[1-9][0-9]{0,17}$";
const OPTIONAL_MONEY_PATTERN = "^(0|[1-9][0-9]{0,17})$";
const MAX_COMPREHENSION_EXPANSIONS = 256;
const NONE_SENTINEL = "__hsx_none__";

export interface GeneralCheckOptions {
  readonly publishedCatalog?: UdlDocument;
}

type ClauseDefinition = (typeof udlClauseVocabulary)[number];

interface ConcreteInstrument {
  readonly aliases: ReadonlyMap<string, Expr>;
  readonly body: BlockExpr;
  readonly generatedPrefix: boolean;
  readonly name: IdentExpr;
  readonly parties: ReadonlySet<string>;
}

const actionClauseBySpelling: ReadonlyMap<string, ClauseDefinition> = new Map(
  udlClauseVocabulary
    .filter((definition) => definition.scope === "action")
    .map((definition) => [definition.spelling, definition]),
);
const instrumentClauseBySpelling: ReadonlyMap<string, ClauseDefinition> =
  new Map(
    udlClauseVocabulary
      .filter((definition) => definition.scope === "instrument")
      .map((definition) => [definition.spelling, definition]),
  );

const minorUnits: Readonly<Record<string, number>> = {
  BHD: 3,
  JPY: 0,
  KWD: 3,
  SAR: 2,
  USD: 2,
};

export function checkGeneralProgram(
  program: Program,
  options: GeneralCheckOptions = {},
): GeneralCheckResult {
  const diagnostics: GeneralDiagnostic[] = [];
  const report = (
    code: string,
    span: Span,
    message: string,
    fix: string,
    severity: "error" | "warning" = "error",
  ): void => {
    diagnostics.push({ code, fix, message, severity, span });
  };

  const headers = program.decls.filter((decl) => decl.kind === "program");
  const header = headers[0];
  const module = program.decls.find((decl) => decl.kind === "module");
  if (!header && !module) {
    report(
      "HSX1000",
      program.span,
      "this file needs one program header or one module declaration",
      'add `program product_name "Product title"`',
    );
  }
  for (const extra of headers.slice(1)) {
    report(
      "HSX1002",
      extra.span,
      "a file declares exactly one program",
      "delete the extra program declaration",
    );
  }
  if (header && !SNAKE_CASE.test(header.name.name)) {
    report(
      "HSX1003",
      header.name.span,
      `program ${header.name.name} is not snake_case`,
      "rename the program with lowercase words joined by underscores",
    );
  }

  const parties = new Set(
    program.decls
      .filter((decl) => decl.kind === "party")
      .map((decl) => decl.name.name),
  );
  const ports = new Map(
    program.decls
      .filter((decl): decl is PortDecl => decl.kind === "port")
      .map((decl) => [decl.name.name, decl]),
  );
  const assetSubjects: TypedSubject[] = program.decls
    .filter((decl) => decl.kind === "asset")
    .map((decl) => ({
      declaredValue: "optional" as const,
      kind: decl.name.name,
      origin: decl.span,
      schema: { additionalProperties: false, properties: {}, type: "object" },
      title: sentenceCase(decl.name.name),
      version: 1,
    }));
  const subjects: TypedSubject[] = [...assetSubjects];
  const subjectKinds = new Set(assetSubjects.map((subject) => subject.kind));
  for (const decl of program.decls.filter(
    (candidate): candidate is SubjectDecl => candidate.kind === "subject",
  )) {
    if (subjectKinds.has(decl.name.name)) {
      report(
        "HSX1008",
        decl.name.span,
        `subject ${decl.name.name} is declared twice`,
        "keep one subject declaration or rename one kind",
      );
      continue;
    }
    const title = stringSlot(decl.body, "title");
    const declaredValue = stringSlot(
      decl.body,
      "declaredValue",
      "declared_value",
    );
    const versionRow = entry(decl.body, "version");
    const version =
      versionRow?.value.kind === "number" && !versionRow.value.raw.includes(".")
        ? Number(versionRow.value.raw)
        : Number.NaN;
    const schemaRow = entry(decl.body, "schema");
    const schema =
      schemaRow?.value.kind === "block"
        ? blockToObject(schemaRow.value, new Map(), diagnostics)
        : undefined;
    if (
      !title ||
      !["none", "optional", "required"].includes(declaredValue ?? "") ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !schema
    ) {
      report(
        "HSX1008",
        decl.span,
        `subject ${decl.name.name} needs title, positive integer version, declared_value, and schema`,
        "declare the complete UDL subject-kind document",
      );
      continue;
    }
    subjectKinds.add(decl.name.name);
    subjects.push({
      declaredValue: declaredValue as TypedSubject["declaredValue"],
      kind: decl.name.name,
      origin: decl.span,
      schema,
      title,
      version,
    });
  }

  const compositionDeclarations = program.decls.filter(
    (declaration) =>
      declaration.kind === "use" || declaration.kind === "expose",
  );
  const authoredInstrumentDeclarations = program.decls.filter(
    (declaration) =>
      declaration.kind === "instrument" ||
      declaration.kind === "instrument_apply",
  );
  if (
    options.publishedCatalog &&
    (compositionDeclarations.length > 0 ||
      authoredInstrumentDeclarations.length === 0)
  ) {
    return checkPublishedProgram(
      program,
      options.publishedCatalog,
      header,
      subjects,
      diagnostics,
      report,
    );
  }
  for (const declaration of compositionDeclarations) {
    report(
      "HSX1018",
      declaration.span,
      "this compiler host did not supply a published instrument catalog",
      "pass the canonical UDL catalog as the publishedCatalog compile option",
    );
  }

  const aliases = new Map(
    program.decls
      .filter((decl) => decl.kind === "type")
      .map((decl) => [decl.name.name, decl.value]),
  );
  checkConstants(program.decls, aliases, diagnostics);

  const templates = new Map<string, InstrumentDecl>();
  for (const decl of program.decls) {
    if (decl.kind !== "instrument") continue;
    const prior = templates.get(decl.name.name);
    if (prior) {
      report(
        "HSX1004",
        decl.name.span,
        `instrument ${decl.name.name} is declared twice`,
        "keep one declaration or rename one instrument",
      );
    } else templates.set(decl.name.name, decl);
  }

  const concrete: ConcreteInstrument[] = [];
  const scopedDeclarations = (
    declarationScope: readonly ApplicationScopeDecl[],
  ) => {
    const scopedAliases = new Map(aliases);
    const scopedConstants = resolveConstants([
      ...program.decls,
      ...declarationScope,
    ]);
    const scopedParties = new Set(parties);
    const scopedPorts = new Map(ports);
    const scopedTemplates = new Map(templates);
    for (const local of declarationScope) {
      if (local.kind === "type")
        scopedAliases.set(local.name.name, local.value);
      if (local.kind === "party") scopedParties.add(local.name.name);
      if (local.kind === "port") scopedPorts.set(local.name.name, local);
      if (local.kind === "instrument") {
        scopedTemplates.set(local.name.name, local);
      }
    }
    checkConstants(declarationScope, scopedAliases, diagnostics);
    return {
      aliases: scopedAliases,
      constants: scopedConstants,
      parties: scopedParties,
      ports: scopedPorts,
      templates: scopedTemplates,
    };
  };
  for (const decl of program.decls) {
    if (
      decl.kind === "instrument" &&
      !decl.hasParameterList &&
      decl.typeParameters.length === 0
    ) {
      const scoped = scopedDeclarations(decl.declarationScope ?? []);
      concrete.push({
        aliases: scoped.aliases,
        body: substituteExpr(decl.body, scoped.constants) as BlockExpr,
        generatedPrefix: false,
        name: decl.name,
        parties: scoped.parties,
      });
    }
    if (decl.kind !== "instrument_apply") continue;
    const application = decl.application;
    const callee = application.callee.parts.at(-1)?.name ?? "";
    const globalTemplate = templates.get(callee);
    const declarationScope = [
      ...new Set([
        ...(globalTemplate?.declarationScope ?? []),
        ...(decl.declarationScope ?? []),
      ]),
    ];
    const scoped = scopedDeclarations(declarationScope);
    const template = scoped.templates.get(callee);
    if (!template) {
      report(
        "HSX1001",
        application.callee.span,
        `instrument function ${callee} is not bound by this module graph`,
        `import ${callee} from its module or declare it before instantiation`,
      );
      continue;
    }
    const body = instantiate(
      template,
      application,
      diagnostics,
      decl.name,
      scoped.ports,
      scoped.parties,
      scoped.aliases,
      scoped.constants,
    );
    if (body) {
      const merged = decl.metadata
        ? mergeApplicationMetadata(body, decl.metadata, diagnostics)
        : body;
      concrete.push(
        ...constructedInstruments(decl.name, merged, diagnostics).map(
          (candidate) => ({
            ...candidate,
            aliases: scoped.aliases,
            parties: scoped.parties,
          }),
        ),
      );
    }
  }

  const allocated = allocateGeneratedPrefixes(concrete);

  const instruments: TypedInstrument[] = [];
  const ids = new Set<string>();
  for (const candidate of allocated) {
    if (ids.has(candidate.name.name)) {
      report(
        "HSX1004",
        candidate.name.span,
        `instrument ${candidate.name.name} is emitted twice`,
        "rename one instrument",
      );
      continue;
    }
    ids.add(candidate.name.name);
    const expandedBody = expandComprehensions(candidate.body, diagnostics);
    const checked = checkInstrument(
      candidate.name,
      expandedBody,
      candidate.parties,
      candidate.aliases,
      diagnostics,
    );
    if (checked) instruments.push(checked);
  }

  crossInstrumentReferenceDiagnostics(instruments, diagnostics);

  if (
    header &&
    instruments.length === 0 &&
    !diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    report(
      "HSX1502",
      header.span,
      `program ${header.name.name} emits no instruments`,
      "declare or instantiate at least one instrument",
    );
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }
  const name = header?.name.name ?? module?.name.parts.at(-1)?.name ?? "module";
  const typed: TypedProgram = {
    instruments,
    kind: "typed_program",
    name,
    origin: program.span,
    subjects,
    title: header?.title?.value ?? sentenceCase(name),
  };
  return { diagnostics, program: typed };
}

function checkPublishedProgram(
  program: Program,
  catalog: UdlDocument,
  header: ProgramDecl | undefined,
  authoredSubjects: readonly TypedSubject[],
  diagnostics: GeneralDiagnostic[],
  report: (
    code: string,
    span: Span,
    message: string,
    fix: string,
    severity?: "error" | "warning",
  ) => void,
): GeneralCheckResult {
  if (!header) {
    return { diagnostics };
  }
  if (!header.title || header.title.value.length === 0) {
    report(
      "HSX1015",
      header.span,
      `composed program ${header.name.name} needs a product title`,
      'write the title after the product id, like `program product_name "Product title"`',
    );
  }
  if (header.name.name.length > 60) {
    report(
      "HSX1015",
      header.name.span,
      "a composed program product id is at most 60 characters",
      "shorten the product id without changing its snake_case spelling",
    );
  }
  if ((header.title?.value.length ?? 0) > 80) {
    report(
      "HSX1015",
      header.title?.span ?? header.span,
      "a composed program title is at most 80 characters",
      "shorten the product title to 80 characters or fewer",
    );
  }

  const authoredInstruments = program.decls.filter(
    (decl) => decl.kind === "instrument" || decl.kind === "instrument_apply",
  );
  for (const declaration of authoredInstruments) {
    report(
      "HSX1022",
      declaration.span,
      "a composed program cannot author an instrument",
      "publish the instrument in the catalog, then select it with use",
    );
  }

  const uses = program.decls.filter(
    (decl): decl is UseDecl => decl.kind === "use",
  );
  if (uses.length === 0) {
    report(
      "HSX1016",
      header.span,
      `composed program ${header.name.name} uses no published instruments`,
      "add at least one `use published_instrument` declaration",
    );
  }
  const catalogById = new Map(
    catalog.instruments.map((instrument) => [instrument.id, instrument]),
  );
  const useById = new Map<string, UseDecl>();
  for (const use of uses) {
    const id = use.instrument.name;
    if (!SNAKE_CASE.test(id)) {
      report(
        "HSX1018",
        use.instrument.span,
        `published instrument id ${id} is not snake_case`,
        "write the published catalog id exactly",
      );
      continue;
    }
    if (useById.has(id)) {
      report(
        "HSX1017",
        use.instrument.span,
        `published instrument ${id} is used twice`,
        "delete the duplicate use declaration",
      );
      continue;
    }
    useById.set(id, use);
    if (!catalogById.has(id)) {
      report(
        "HSX1018",
        use.instrument.span,
        `published instrument ${id} does not exist in this catalog`,
        "choose an instrument id from the supplied published catalog",
      );
    }
  }

  const selected = publishedInstrumentClosure(uses, catalogById);
  const selectedById = new Map(
    selected.map((entry) => [entry.instrument.id, entry]),
  );
  const exposures = program.decls.filter(
    (decl): decl is ExposeDecl => decl.kind === "expose",
  );
  const publicNames = new Map<string, ExposeDecl>();
  const exposedTargets = new Map<string, ExposeDecl>();
  for (const exposure of exposures) {
    const target = `${exposure.instrument.name}.${exposure.action.name}`;
    const explicitlyUsed = useById.has(exposure.instrument.name);
    const instrument = selectedById.get(exposure.instrument.name)?.instrument;
    const action = instrument?.actions[exposure.action.name];
    if (!explicitlyUsed || !instrument || !action) {
      report(
        "HSX1021",
        exposure.span,
        `${target} is not an action on an explicitly used published instrument`,
        "add the matching use declaration and choose one of that instrument's actions",
      );
      continue;
    }
    if (!CAMEL_CASE.test(exposure.publicName.name)) {
      report(
        "HSX1020",
        exposure.publicName.span,
        `public action name ${exposure.publicName.name} is not camelCase`,
        "write a lowercase camelCase public action name",
      );
      continue;
    }
    const priorName = publicNames.get(exposure.publicName.name);
    const priorTarget = exposedTargets.get(target);
    if (priorName || priorTarget) {
      report(
        "HSX1020",
        exposure.span,
        priorTarget
          ? `${target} is exposed more than once`
          : `public action name ${exposure.publicName.name} is declared more than once`,
        "keep one public name for one instrument action",
      );
      continue;
    }
    publicNames.set(exposure.publicName.name, exposure);
    exposedTargets.set(target, exposure);
  }

  const referencedSubjectKinds = new Set(
    selected.flatMap(({ instrument }) => instrument.subject?.kinds ?? []),
  );
  const catalogSubjects = catalog.subjects
    .filter((subject) => referencedSubjectKinds.has(subject.kind))
    .map((subject) =>
      typedPublishedSubject(subject, uses[0]?.span ?? header.span),
    );
  const catalogSubjectKinds = new Set(
    catalogSubjects.map((subject) => subject.kind),
  );
  for (const subject of authoredSubjects) {
    if (!catalogSubjectKinds.has(subject.kind)) continue;
    report(
      "HSX1008",
      subject.origin,
      `subject ${subject.kind} is already supplied by the published catalog`,
      "delete the duplicate subject declaration or use a distinct subject kind",
    );
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { diagnostics };
  }
  const typed: TypedProgram = {
    instruments: selected.map(({ instrument, origin }) => {
      const projected = projectedPublishedInstrument(instrument, exposures);
      return typedPublishedInstrument(
        projected,
        origin,
        exposures.filter(
          (exposure) => exposure.instrument.name === instrument.id,
        ),
      );
    }),
    kind: "typed_program",
    name: header.name.name,
    origin: program.span,
    subjects: [
      ...catalogSubjects,
      ...authoredSubjects.filter(
        (subject) => !catalogSubjectKinds.has(subject.kind),
      ),
    ],
    title: header.title?.value ?? sentenceCase(header.name.name),
  };
  return { diagnostics, program: typed };
}

function projectedPublishedInstrument(
  source: UdlInstrument,
  exposures: readonly ExposeDecl[],
): UdlInstrument {
  const publicNameByAction = new Map(
    exposures
      .filter((exposure) => exposure.instrument.name === source.id)
      .map((exposure) => [exposure.action.name, exposure.publicName.name]),
  );
  return {
    ...structuredClone(source),
    actions: Object.fromEntries(
      source.actionOrder.map((name) => {
        const { publicAction: _publicAction, ...privateAction } =
          source.actions[name]!;
        const publicName = publicNameByAction.get(name);
        return [
          name,
          publicName
            ? { ...privateAction, publicAction: publicName }
            : privateAction,
        ];
      }),
    ),
  };
}

function publishedInstrumentClosure(
  uses: readonly UseDecl[],
  catalogById: ReadonlyMap<string, UdlInstrument>,
): readonly { readonly instrument: UdlInstrument; readonly origin: Span }[] {
  const selected: { instrument: UdlInstrument; origin: Span }[] = [];
  const selectedIds = new Set<string>();
  const queue: { id: string; origin: Span }[] = uses.map((use) => ({
    id: use.instrument.name,
    origin: use.span,
  }));
  const idByPrefix = new Map(
    [...catalogById.values()].map((instrument) => [
      instrument.idPrefix,
      instrument.id,
    ]),
  );
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || selectedIds.has(next.id)) continue;
    const instrument = catalogById.get(next.id);
    if (!instrument) continue;
    selectedIds.add(next.id);
    selected.push({ instrument, origin: next.origin });
    for (const dependency of publishedInstrumentDependencies(
      instrument,
      idByPrefix,
    )) {
      if (!selectedIds.has(dependency))
        queue.push({ id: dependency, origin: next.origin });
    }
  }
  return selected;
}

function publishedInstrumentDependencies(
  instrument: UdlInstrument,
  idByPrefix: ReadonlyMap<string, string>,
): readonly string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "instrumentId" || key === "childInstrumentId") &&
        typeof child === "string"
      ) {
        found.add(child);
      }
      visit(child);
    }
  };
  visit(instrument);
  for (const field of Object.values(instrument.fields)) {
    const prefix =
      typeof field.pattern === "string"
        ? /^\^([a-z]{2,8})_\(sandbox\|live\)_/.exec(field.pattern)?.[1]
        : undefined;
    const dependency = prefix ? idByPrefix.get(prefix) : undefined;
    if (dependency) found.add(dependency);
  }
  found.delete(instrument.id);
  return [...found];
}

function typedPublishedInstrument(
  source: UdlInstrument,
  origin: Span,
  exposures: readonly ExposeDecl[],
): TypedInstrument {
  const exposureByAction = new Map(
    exposures.map((exposure) => [exposure.action.name, exposure]),
  );
  const {
    actionOrder,
    actions,
    fields,
    id: _id,
    ...slots
  } = structuredClone(source);
  const requiredFields = new Set(source.required);
  return {
    actions: actionOrder.map((name) => {
      const exposure = exposureByAction.get(name);
      const { publicAction: _publicAction, ...privateAction } = actions[name]!;
      return {
        effects: (privateAction.effects ?? {}) as TypedAction["effects"],
        name,
        origin: exposure?.span ?? origin,
        slots: (exposure
          ? { ...privateAction, publicAction: exposure.publicName.name }
          : privateAction) as unknown as Readonly<Record<string, JsonValue>>,
      };
    }),
    fields: Object.entries(fields).map(([name, schema]) => ({
      name,
      origin,
      required: requiredFields.has(name),
      schema,
      type: { kind: "unknown" },
    })),
    id: source.id,
    origin,
    slots: {
      ...(slots as unknown as Readonly<Record<string, JsonValue>>),
      required: [...source.required],
    },
  };
}

function typedPublishedSubject(
  subject: UdlDocument["subjects"][number],
  origin: Span,
): TypedSubject {
  return {
    declaredValue: subject.declaredValue,
    kind: subject.kind,
    origin,
    schema: structuredClone(subject.schema),
    title: subject.title,
    version: subject.version,
  };
}

// Presentation only. An application may restate how a settlement reads to a
// human or an agent; it may never restate what the settlement does. Both sets
// carry agent_description for the same reason they carry description: it is
// prose about the shape, and the catalog's voice is more concrete than the
// parameterized template's interpolated one.
const applicationMetadataKeys = new Set([
  "action",
  "agent_description",
  "description",
  "nav",
  "navigation",
  "summary",
  "surface_visibility",
  "template_id",
  "title",
  "visibility",
]);
const applicationActionMetadataKeys = new Set([
  "agent_description",
  "description",
  "public",
  "public_action",
  "summary",
]);

function applicationInstrumentMetadataKey(key: string): string {
  if (key === "navigation") return "nav";
  if (key === "visibility") return "surface_visibility";
  return key;
}

function applicationActionMetadataKey(key: string): string {
  return key === "public_action" ? "public" : key;
}

function mergeApplicationMetadata(
  body: BlockExpr,
  metadata: BlockExpr,
  diagnostics: GeneralDiagnostic[],
): BlockExpr {
  let entries = [...body.entries];
  for (const row of metadata.entries) {
    if (!applicationMetadataKeys.has(row.key.name)) {
      diagnostics.push({
        code: "HSX1507",
        fix: "move contract mechanics into the parameterized instrument",
        message: `application metadata cannot replace ${row.key.name}`,
        severity: "error",
        span: row.key.span,
      });
      continue;
    }
    if (row.key.name !== "action") {
      const overlayKey = applicationInstrumentMetadataKey(row.key.name);
      const normalizedRow =
        overlayKey === row.key.name
          ? row
          : { ...row, key: { ...row.key, name: overlayKey } };
      entries = [
        ...entries.filter(
          (candidate) =>
            applicationInstrumentMetadataKey(candidate.key.name) !== overlayKey,
        ),
        normalizedRow,
      ];
      continue;
    }
    const actionName = row.qualifiers[0]?.name;
    const targetIndex = entries.findIndex(
      (candidate) =>
        candidate.key.name === "action" &&
        candidate.qualifiers[0]?.name === actionName,
    );
    const target = entries[targetIndex];
    if (
      !actionName ||
      row.value.kind !== "block" ||
      !target ||
      target.value.kind !== "block"
    ) {
      diagnostics.push({
        code: "HSX1507",
        fix: "name an action declared by the parameterized instrument",
        message: `application metadata action ${actionName ?? "<missing>"} does not exist`,
        severity: "error",
        span: row.span,
      });
      continue;
    }
    const invalid = row.value.entries.find(
      (candidate) => !applicationActionMetadataKeys.has(candidate.key.name),
    );
    if (invalid) {
      diagnostics.push({
        code: "HSX1507",
        fix: "keep only summary, description, agent_description, public, or public_action here",
        message: `application metadata cannot replace action clause ${invalid.key.name}`,
        severity: "error",
        span: invalid.span,
      });
      continue;
    }
    const overlayKeys = new Set(
      row.value.entries.map((entry) =>
        applicationActionMetadataKey(entry.key.name),
      ),
    );
    entries[targetIndex] = {
      ...target,
      value: {
        ...target.value,
        entries: [
          ...target.value.entries.filter(
            (candidate) =>
              !overlayKeys.has(
                applicationActionMetadataKey(candidate.key.name),
              ),
          ),
          ...row.value.entries,
        ],
      },
    };
  }
  return { ...body, entries };
}

function constructedInstruments(
  rootName: IdentExpr,
  body: BlockExpr,
  diagnostics: GeneralDiagnostic[],
): {
  readonly body: BlockExpr;
  readonly generatedPrefix: boolean;
  readonly name: IdentExpr;
}[] {
  const expanded = expandComprehensions(body, diagnostics);
  const construction = entry(expanded, "instruments");
  const root = {
    body: {
      ...expanded,
      entries: expanded.entries.filter((row) => row !== construction),
    },
    generatedPrefix: false,
    name: rootName,
  };
  if (construction?.value.kind !== "block") return [root];
  const companions = construction.value.entries.flatMap((row) => {
    if (row.key.name !== "instrument" || row.value.kind !== "block") {
      diagnostics.push({
        code: "HSX1406",
        fix: 'write `instrument { id: concat(instrument, "_suffix"); ... }` inside the instruments block',
        message:
          "an instruments block contains only fixed instrument constructors",
        severity: "error" as const,
        span: row.span,
      });
      return [];
    }
    const idRow = entry(row.value, "id");
    const id = idRow ? nameText(idRow.value) : "";
    if (!id || id === "invalid_compile_time_name") {
      diagnostics.push({
        code: "HSX1406",
        fix: "give the companion instrument a compile-time id",
        message: "a companion instrument id must resolve at compile time",
        severity: "error" as const,
        span: idRow?.span ?? row.span,
      });
      return [];
    }
    const generated = entry(row.value, "generatedPrefix");
    return [
      {
        body: {
          ...row.value,
          entries: row.value.entries.filter(
            (child) => child !== idRow && child !== generated,
          ),
        },
        generatedPrefix:
          generated?.value.kind === "boolean" && generated.value.value,
        name: {
          kind: "ident" as const,
          name: id,
          span: idRow?.span ?? row.span,
        },
      },
    ];
  });
  return [root, ...companions];
}

function allocateGeneratedPrefixes(
  candidates: readonly ConcreteInstrument[],
): ConcreteInstrument[] {
  const used = new Set(
    candidates
      .filter((candidate) => !candidate.generatedPrefix)
      .map(
        (candidate) =>
          stringSlot(candidate.body, "idPrefix", "id_prefix") ??
          prefixFor(candidate.name.name),
      ),
  );
  let ordinal = 0;
  const next = (): string => {
    while (true) {
      const high = String.fromCharCode(97 + Math.floor(ordinal / 26));
      const low = String.fromCharCode(97 + (ordinal % 26));
      ordinal += 1;
      const candidate = `zz${high}${low}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };
  return candidates.map((candidate) => {
    if (!candidate.generatedPrefix) return candidate;
    const value: Expr = {
      kind: "string",
      span: candidate.name.span,
      value: next(),
    };
    return {
      ...candidate,
      body: {
        ...candidate.body,
        entries: [
          ...candidate.body.entries,
          {
            key: {
              kind: "ident",
              name: "id_prefix",
              span: candidate.name.span,
            },
            qualifiers: [],
            span: candidate.name.span,
            value,
          },
        ],
      },
    };
  });
}

function inferSettlementTypeArgument(
  template: InstrumentDecl,
  rows: ReadonlyMap<string, Expr>,
  typeParameter: string,
): Expr | undefined {
  for (const parameter of template.parameters) {
    const parameterType = parameter.type;
    if (
      parameterType.kind !== "type_apply" ||
      parameterType.callee.name !== "money" ||
      parameterType.args[0]?.kind !== "ident" ||
      parameterType.args[0].name !== typeParameter
    ) {
      continue;
    }
    const value = rows.get(parameter.name.name);
    const valueType = value?.kind === "binding" ? value.type : value;
    if (
      (valueType?.kind === "call" || valueType?.kind === "type_apply") &&
      valueType.callee.name === "money"
    ) {
      return valueType.args[0];
    }
    if (valueType?.kind === "money") return valueType.currency;
  }
  return undefined;
}

function checkConstants(
  decls: readonly Decl[],
  aliases: ReadonlyMap<string, Expr>,
  diagnostics: GeneralDiagnostic[],
): void {
  for (const decl of decls) {
    if (decl.kind !== "const" || !decl.type) continue;
    const expected = typeOf(decl.type, aliases);
    const actual = typeOf(decl.value, aliases);
    if (
      expected.kind === "money" &&
      actual.kind === "money" &&
      expected.currency !== actual.currency
    ) {
      diagnostics.push({
        code: "HSX1101",
        fix: `write a ${expected.currency} literal or change ${decl.name.name}'s declared type`,
        message: `${decl.name.name} is money<${expected.currency}> but receives money<${actual.currency}>; currencies never coerce`,
        severity: "error",
        span: decl.value.span,
      });
    }
    if (decl.value.kind === "money") validateMoneyLiteral(decl, diagnostics);
  }
}

function resolveConstants(decls: readonly Decl[]): ReadonlyMap<string, Expr> {
  const constants = new Map(
    decls
      .filter((decl): decl is ConstDecl => decl.kind === "const")
      .map((decl) => [decl.name.name, decl.value]),
  );
  for (let pass = 0; pass < constants.size; pass += 1) {
    for (const [name, value] of constants) {
      constants.set(name, substituteExpr(value, constants));
    }
  }
  return constants;
}

function validateMoneyLiteral(
  decl: ConstDecl,
  diagnostics: GeneralDiagnostic[],
): void {
  if (decl.value.kind !== "money") return;
  const precision = minorUnits[decl.value.currency.name] ?? 2;
  const fraction = decl.value.raw.split(".")[1] ?? "";
  if (fraction.length <= precision) return;
  diagnostics.push({
    code: "HSX1102",
    fix: `round the literal to ${precision} minor-unit digit${precision === 1 ? "" : "s"}`,
    message: `${decl.value.currency.name} ${decl.value.raw} has ${fraction.length} decimal places; ${decl.value.currency.name} settles to ${precision}`,
    severity: "error",
    span: decl.value.span,
  });
}

function instantiate(
  template: InstrumentDecl,
  application: ApplyExpr,
  diagnostics: GeneralDiagnostic[],
  instrumentName: IdentExpr,
  ports: ReadonlyMap<string, PortDecl>,
  parties: ReadonlySet<string>,
  aliases: ReadonlyMap<string, Expr>,
  constants: ReadonlyMap<string, Expr>,
): BlockExpr | undefined {
  const partyKeyedParameters = partyKeyedBlockParameters(template, aliases);
  const named = new Map<string, Expr>();
  const positional: Expr[] = [];
  const parameterNames = new Set(
    template.parameters.map((parameter) => parameter.name.name),
  );
  for (const arg of application.args) {
    if (arg.kind !== "binding") {
      positional.push(arg);
      continue;
    }
    if (!parameterNames.has(arg.name.name)) {
      diagnostics.push({
        code: "HSX1012",
        fix: `remove ${arg.name.name} or name one of ${[...parameterNames].join(", ")}`,
        message: `${template.name.name} has no argument named ${arg.name.name}`,
        severity: "error",
        span: arg.name.span,
      });
      continue;
    }
    if (named.has(arg.name.name)) {
      diagnostics.push({
        code: "HSX1013",
        fix: `pass ${arg.name.name} once`,
        message: `${template.name.name} receives ${arg.name.name} more than once`,
        severity: "error",
        span: arg.name.span,
      });
      continue;
    }
    named.set(arg.name.name, arg.type);
  }
  const namedParameterCount = template.parameters.filter((parameter) =>
    named.has(parameter.name.name),
  ).length;
  const maximumPositional = template.parameters.length - namedParameterCount;
  if (positional.length > maximumPositional) {
    diagnostics.push({
      code: "HSX1012",
      fix: `pass at most ${template.parameters.length} arguments`,
      message: `${template.name.name} receives ${application.args.length} arguments but declares ${template.parameters.length}`,
      severity: "error",
      span: application.span,
    });
  }
  const typeArgs =
    application.typeArgs.length > 0
      ? application.typeArgs
      : template.typeParameters.map(
          (parameter) =>
            inferSettlementTypeArgument(template, named, parameter.name.name) ??
            parameter.name,
        );
  if (template.typeParameters.length !== typeArgs.length) {
    diagnostics.push({
      code: "HSX1010",
      fix: `pass ${template.typeParameters.length} type argument${template.typeParameters.length === 1 ? "" : "s"}`,
      message: `${template.name.name} expects ${template.typeParameters.length} type arguments but receives ${application.typeArgs.length}`,
      severity: "error",
      span: application.span,
    });
    return undefined;
  }
  const values = new Map<string, Expr>(constants);
  const missingOptional = new Map<
    string,
    InstrumentDecl["parameters"][number]
  >();
  values.set("instrument", instrumentName);
  const fieldBindings = new Map<
    string,
    { readonly name: IdentExpr; readonly type: Expr }
  >();
  template.typeParameters.forEach((parameter, index) => {
    const value = typeArgs[index];
    if (value) values.set(parameter.name.name, value);
  });
  for (const [name, value] of named) values.set(name, value);
  let position = 0;
  for (const parameter of template.parameters) {
    const value = named.get(parameter.name.name) ?? positional[position++];
    if (!value) {
      if (optionalInner(parameter.type)) {
        values.set(parameter.name.name, booleanExpr(false, parameter.span));
        missingOptional.set(parameter.name.name, parameter);
        continue;
      }
      diagnostics.push({
        code: "HSX1011",
        fix: `pass ${parameter.name.name}: <${typeWords(typeOf(parameter.type, aliases))}>`,
        message: `${template.name.name} needs argument ${parameter.name.name}`,
        severity: "error",
        span: application.span,
      });
      continue;
    }
    const expectedExpr = substituteExpr(
      optionalInner(parameter.type) ?? parameter.type,
      values,
    );
    const expected = typeOf(expectedExpr, aliases);
    const actual = typeOf(value, aliases);
    const nonPartyKeys = partyKeyedParameters.get(parameter.name.name);
    if (nonPartyKeys && value.kind === "block") {
      const declaredParties = [...parties].sort();
      for (const row of value.entries) {
        if (parties.has(row.key.name) || nonPartyKeys.has(row.key.name))
          continue;
        diagnostics.push({
          code: "HSX1001",
          fix:
            declaredParties.length > 0
              ? `replace ${row.key.name} with one of ${declaredParties.join(", ")}`
              : `declare the party named by ${row.key.name}`,
          message: `${parameter.name.name} uses party key ${row.key.name}, which is not declared`,
          severity: "error",
          span: row.key.span,
        });
      }
    }
    if (
      expected.kind === "money" &&
      actual.kind === "money" &&
      expected.currency &&
      actual.currency &&
      expected.currency !== actual.currency
    ) {
      diagnostics.push({
        code: "HSX1101",
        fix: `pass money<${expected.currency}> to ${parameter.name.name}`,
        message: `${parameter.name.name} needs money<${expected.currency}> but receives money<${actual.currency}>`,
        severity: "error",
        span: value.span,
      });
    }
    if (!argumentMatches(expectedExpr, value, parties, ports, aliases)) {
      diagnostics.push({
        code: "HSX1104",
        fix: `pass ${typeWords(expected)} to ${parameter.name.name}`,
        message: `${parameter.name.name} needs ${typeWords(expected)} but receives ${argumentWords(value, aliases)}`,
        severity: "error",
        span: value.span,
      });
    }
    if (value.kind === "binding") {
      fieldBindings.set(parameter.name.name, {
        name: value.name,
        type: value.type,
      });
      values.set(parameter.name.name, value.name);
    } else if (expected.kind !== "party" && value.kind === "ident") {
      fieldBindings.set(parameter.name.name, {
        name: value,
        type: substituteExpr(
          optionalInner(parameter.type) ?? parameter.type,
          values,
        ),
      });
      values.set(parameter.name.name, value);
    } else {
      values.set(parameter.name.name, value);
    }
    if (value.kind === "port_ref") {
      bindPortCompileValues(
        values,
        parameter.name.name,
        value,
        ports,
        diagnostics,
      );
    }
  }
  const selected = selectCompileTimeRows(template.body, values, diagnostics);
  const dependencyDiagnosticStart = diagnostics.length;
  for (const [name, parameter] of missingOptional) {
    if (!referencesIdentifier(selected, name, values)) continue;
    const inner = optionalInner(parameter.type);
    if (!inner) continue;
    diagnostics.push({
      code: "HSX1011",
      fix: `pass ${name}: <${typeWords(typeOf(inner, aliases))}>`,
      message: `${template.name.name} needs argument ${name} for the selected options`,
      severity: "error",
      span: application.span,
    });
  }
  if (diagnostics.length > dependencyDiagnosticStart) return undefined;
  const body = substituteExpr(selected, values) as BlockExpr;
  return {
    ...body,
    entries: body.entries.map((row) => {
      if (row.key.name !== "fields" || row.value.kind !== "block") return row;
      return {
        ...row,
        value: {
          ...row.value,
          entries: row.value.entries.map((field) => {
            const binding = fieldBindings.get(field.key.name);
            return binding
              ? {
                  ...field,
                  key: binding.name,
                  value:
                    field.value.kind === "block"
                      ? {
                          ...field.value,
                          entries: field.value.entries.map((row) =>
                            row.key.name === "type"
                              ? { ...row, value: binding.type }
                              : row,
                          ),
                        }
                      : binding.type,
                }
              : field;
          }),
        },
      };
    }),
  };
}

function referencesIdentifier(
  expr: Expr,
  name: string,
  values: ReadonlyMap<string, Expr>,
): boolean {
  if (expr.kind === "ident") return expr.name === name;
  if (expr.kind === "block") {
    return expr.entries.some(
      (row) =>
        row.key.name !== "let" && referencesIdentifier(row.value, name, values),
    );
  }
  if (expr.kind === "call") {
    if (expr.callee.name === "if_eq") {
      const [left, right, whenEqual, whenDifferent] = expr.args;
      const actualLeft = left ? substituteCompileArgument(left, values) : left;
      const actualRight = right
        ? substituteCompileArgument(right, values)
        : right;
      const selectedBranch =
        actualLeft &&
        actualRight &&
        nameText(actualLeft) === nameText(actualRight)
          ? whenEqual
          : whenDifferent;
      return selectedBranch
        ? referencesIdentifier(selectedBranch, name, values)
        : false;
    }
    return expr.args.some((argument) =>
      referencesIdentifier(argument, name, values),
    );
  }
  if (expr.kind === "type_apply") {
    return expr.args.some((argument) =>
      referencesIdentifier(argument, name, values),
    );
  }
  if (expr.kind === "apply") {
    return (
      expr.args.some((argument) =>
        referencesIdentifier(argument, name, values),
      ) ||
      expr.typeArgs.some((argument) =>
        referencesIdentifier(argument, name, values),
      )
    );
  }
  if (expr.kind === "list") {
    return expr.items.some((item) => referencesIdentifier(item, name, values));
  }
  if (expr.kind === "binding")
    return referencesIdentifier(expr.type, name, values);
  if (expr.kind === "decided_amount") {
    return referencesIdentifier(expr.body, name, values);
  }
  return false;
}

function partyKeyedBlockParameters(
  template: InstrumentDecl,
  aliases: ReadonlyMap<string, Expr>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const partyParameters = new Set(
    template.parameters
      .filter(
        (parameter) =>
          typeOf(optionalInner(parameter.type) ?? parameter.type, aliases)
            .kind === "party",
      )
      .map((parameter) => parameter.name.name),
  );
  const partyListParameters = new Set(
    template.parameters
      .filter((parameter) => {
        const type = resolveAlias(
          optionalInner(parameter.type) ?? parameter.type,
          aliases,
        );
        const item = type.kind === "type_apply" ? type.args[0] : undefined;
        return (
          type.kind === "type_apply" &&
          type.callee.name === "list" &&
          item !== undefined &&
          typeOf(item, aliases).kind === "party"
        );
      })
      .map((parameter) => parameter.name.name),
  );
  const blockParameters = new Set(
    template.parameters
      .filter((parameter) => {
        const type = resolveAlias(
          optionalInner(parameter.type) ?? parameter.type,
          aliases,
        );
        return type.kind === "ident" && type.name === "block";
      })
      .map((parameter) => parameter.name.name),
  );
  const keyed = new Set<string>();
  const nonPartyKeys = new Map<string, Set<string>>();
  const partyBindings = new Set(partyParameters);
  const visit = (expr: Expr): void => {
    if (expr.kind === "call") {
      const [owner, key] = expr.args;
      if (
        expr.callee.name === "get" &&
        owner?.kind === "ident" &&
        key?.kind === "ident" &&
        blockParameters.has(owner.name) &&
        partyBindings.has(key.name)
      ) {
        keyed.add(owner.name);
      }
      expr.args.forEach(visit);
      return;
    }
    if (expr.kind === "type_apply") {
      expr.args.forEach(visit);
      return;
    }
    if (expr.kind === "apply") {
      expr.args.forEach(visit);
      expr.typeArgs.forEach(visit);
      return;
    }
    if (expr.kind === "list") {
      expr.items.forEach(visit);
      return;
    }
    if (expr.kind === "block") {
      for (const row of expr.entries) {
        if (row.key.name === "let") {
          const binding = row.qualifiers[0];
          const value = row.value;
          const aliasesParty =
            value.kind === "ident" && partyBindings.has(value.name);
          const aliasesPartyList =
            value.kind === "ident" && partyListParameters.has(value.name);
          const derivesBlockKeys =
            value.kind === "call" &&
            value.callee.name === "keys_except" &&
            value.args[0]?.kind === "ident" &&
            blockParameters.has(value.args[0].name);
          const indexesPartyList =
            value.kind === "call" &&
            value.callee.name === "at" &&
            value.args[0]?.kind === "ident" &&
            partyListParameters.has(value.args[0].name);
          if (binding && (aliasesPartyList || derivesBlockKeys)) {
            partyListParameters.add(binding.name);
          }
          if (derivesBlockKeys) {
            const owner = value.args[0];
            if (owner?.kind === "ident") {
              const omitted = nonPartyKeys.get(owner.name) ?? new Set<string>();
              for (const argument of value.args.slice(1)) {
                omitted.add(nameText(argument));
              }
              nonPartyKeys.set(owner.name, omitted);
            }
          }
          if (binding && (aliasesParty || indexesPartyList)) {
            partyBindings.add(binding.name);
          }
        }
        visit(row.value);
      }
      return;
    }
    if (expr.kind === "decided_amount") {
      visit(expr.body);
      return;
    }
    if (expr.kind === "binding") visit(expr.type);
  };
  visit(template.body);
  return new Map(
    [...keyed].map((parameter) => [
      parameter,
      nonPartyKeys.get(parameter) ?? new Set<string>(),
    ]),
  );
}

function bindPortCompileValues(
  values: Map<string, Expr>,
  binding: string,
  value: Extract<Expr, { readonly kind: "port_ref" }>,
  ports: ReadonlyMap<string, PortDecl>,
  diagnostics: GeneralDiagnostic[],
): void {
  const port = ports.get(value.name.name);
  if (!port) {
    diagnostics.push({
      code: "HSX1008",
      fix: `declare port ${value.name.name} { allowed: [...]; } or correct the port name`,
      message: `decision port ${value.name.name} is not declared`,
      severity: "error",
      span: value.name.span,
    });
    return;
  }
  const allowed = port ? entry(port.body, "allowed")?.value : undefined;
  const shape = entry(port.body, "shape")?.value ?? {
    entries: [],
    kind: "block",
    span: port.body.span,
  };
  if (allowed) values.set(`${binding}_allowed`, allowed);
  values.set(`${binding}_fields`, shape);
  if (value.within) values.set(`${binding}_within`, value.within);
  if (value.deadline) values.set(`${binding}_deadline`, value.deadline);
}

function substituteExpr(expr: Expr, values: ReadonlyMap<string, Expr>): Expr {
  if (expr.kind === "ident") {
    return values.get(expr.name) ?? substituteName(expr, values);
  }
  if (expr.kind === "string") {
    return {
      ...expr,
      value: expr.value.replaceAll(
        /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
        (_, name) => {
          const value = values.get(String(name));
          if (value?.kind === "ident") return value.name;
          if (value?.kind === "number") return value.raw;
          if (value?.kind === "string") return value.value;
          if (value?.kind === "percent") return `${value.raw}%`;
          if (value?.kind === "binding") return value.name.name;
          if (value?.kind === "port_ref") return value.name.name;
          return `{${String(name)}}`;
        },
      ),
    };
  }
  if (expr.kind === "block") {
    return {
      ...expr,
      entries: expr.entries.map((entry) => {
        const nestedValues = entry.iteration
          ? new Map(
              [...values].filter(
                ([name]) => name !== entry.iteration?.binding.name,
              ),
            )
          : values;
        return {
          ...entry,
          ...(entry.iteration
            ? {
                iteration: {
                  ...entry.iteration,
                  bound: substituteExpr(entry.iteration.bound, values),
                },
              }
            : {}),
          key: substituteName(entry.key, nestedValues),
          qualifiers: entry.qualifiers.map((qualifier, index) => {
            const value = nestedValues.get(qualifier.name);
            const fixed = fixedQualifier(entry.key.name, qualifier.name, index);
            return !fixed && value
              ? nameFromValue(qualifier, value)
              : substituteName(qualifier, nestedValues);
          }),
          value: substituteExpr(entry.value, nestedValues),
        };
      }),
    };
  }
  if (expr.kind === "list") {
    return {
      ...expr,
      items: expr.items.map((item) => substituteExpr(item, values)),
    };
  }
  if (expr.kind === "type_apply") {
    return {
      ...expr,
      args: expr.args.map((arg) => substituteExpr(arg, values)),
    };
  }
  if (expr.kind === "call") {
    const hasUnbound = expr.args.some((arg) =>
      hasUnboundCompileIdentifier(arg, values),
    );
    const substituted = {
      ...expr,
      args: expr.args.map((arg) => substituteCompileArgument(arg, values)),
    };
    const structural = new Set([
      "at",
      "get",
      "keys",
      "keys_except",
      "kind",
      "len",
      "values",
    ]).has(expr.callee.name);
    return hasUnbound && !structural
      ? substituted
      : (evaluateCompileTimeCall(substituted, !hasUnbound) ?? substituted);
  }
  if (expr.kind === "apply") {
    return {
      ...expr,
      args: expr.args.map((arg) => substituteExpr(arg, values)),
      typeArgs: expr.typeArgs.map((arg) => substituteExpr(arg, values)),
    };
  }
  if (expr.kind === "binding") {
    return { ...expr, type: substituteExpr(expr.type, values) };
  }
  if (expr.kind === "decided_amount") {
    return { ...expr, body: substituteExpr(expr.body, values) as BlockExpr };
  }
  return expr;
}

function substituteCompileArgument(
  expr: Expr,
  values: ReadonlyMap<string, Expr>,
): Expr {
  if (expr.kind !== "ident") return substituteExpr(expr, values);
  const value = values.get(expr.name);
  if (!value) return expr;
  if (value.kind === "ident" || value.kind === "port_ref") {
    return { kind: "string", span: value.span, value: nameText(value) };
  }
  return value;
}

function hasUnboundCompileIdentifier(
  expr: Expr,
  values: ReadonlyMap<string, Expr>,
): boolean {
  if (expr.kind === "ident") return !values.has(expr.name);
  if (expr.kind === "call" || expr.kind === "type_apply") {
    return expr.args.some((arg) => hasUnboundCompileIdentifier(arg, values));
  }
  if (expr.kind === "list") {
    return expr.items.some((item) => hasUnboundCompileIdentifier(item, values));
  }
  return false;
}

function optionalInner(type: Expr): Expr | undefined {
  return type.kind === "type_apply" &&
    type.callee.name === "optional" &&
    type.args.length === 1
    ? type.args[0]
    : undefined;
}

function resolveAlias(
  expr: Expr,
  aliases: ReadonlyMap<string, Expr>,
  seen: ReadonlySet<string> = new Set(),
): Expr {
  if (expr.kind !== "ident") return expr;
  const alias = aliases.get(expr.name);
  if (!alias || seen.has(expr.name)) return expr;
  return resolveAlias(alias, aliases, new Set([...seen, expr.name]));
}

function argumentMatches(
  expectedExpression: Expr,
  actualExpression: Expr,
  parties: ReadonlySet<string>,
  ports: ReadonlyMap<string, PortDecl>,
  aliases: ReadonlyMap<string, Expr>,
): boolean {
  const expected = resolveAlias(expectedExpression, aliases);
  const actual =
    actualExpression.kind === "binding"
      ? resolveAlias(actualExpression.type, aliases)
      : actualExpression;
  if (expected.kind === "type_apply") {
    if (expected.callee.name === "list") {
      const itemType = expected.args[0];
      return Boolean(
        itemType &&
        actual.kind === "list" &&
        actual.items.every((item) =>
          argumentMatches(itemType, item, parties, ports, aliases),
        ),
      );
    }
    if (expected.callee.name === "optional") {
      const inner = expected.args[0];
      return Boolean(
        inner && argumentMatches(inner, actual, parties, ports, aliases),
      );
    }
  }
  const expectedType = typeOf(expected, aliases);
  const actualType = typeOf(actual, aliases);
  switch (expectedType.kind) {
    case "money":
      return actualType.kind === "money";
    case "party":
      return actual.kind === "ident";
    case "condition":
      return actual.kind === "port_ref";
    case "text":
      return actual.kind === "string" || actual.kind === "ident";
    case "date":
      return actualType.kind === "date" || actual.kind === "ident";
    case "bps":
      return actualType.kind === "bps" || actual.kind === "percent";
    case "percent":
      return actual.kind === "percent";
    case "integer":
    case "boolean":
    case "account":
      return actualType.kind === expectedType.kind;
    case "ref":
      return (
        actualType.kind === "ref" || actualExpression.kind === "settlement_ref"
      );
    case "unknown":
      if (expected.kind !== "ident") return false;
      if (expected.name === "unknown") return true;
      return (
        expected.name === "block" &&
        (actual.kind === "block" || actual.kind === "decided_amount")
      );
  }
}

function argumentWords(
  expression: Expr,
  aliases: ReadonlyMap<string, Expr>,
): string {
  if (expression.kind === "list") return "list";
  if (expression.kind === "block") return "block";
  if (expression.kind === "port_ref") return "decision port";
  return typeWords(typeOf(expression, aliases));
}

function booleanExpr(value: boolean, span: Span): Expr {
  return { kind: "boolean", span, value };
}

function selectCompileTimeRows(
  block: BlockExpr,
  values: ReadonlyMap<string, Expr>,
  diagnostics: GeneralDiagnostic[],
): BlockExpr {
  const entries: Entry[] = [];
  const locals = new Map(values);
  for (const row of block.entries) {
    if (row.key.name === "let") {
      const binding = row.qualifiers[0];
      if (binding) locals.set(binding.name, substituteExpr(row.value, locals));
      entries.push(row);
      continue;
    }
    if (row.key.name === "unsupported") {
      const value = substituteExpr(row.value, locals);
      if (value.kind !== "block") {
        diagnostics.push({
          code: "HSX1405",
          fix: "give unsupported a block with code, message, and fix rows",
          message: "unsupported needs a fixed diagnostic block",
          severity: "error",
          span: row.span,
        });
        continue;
      }
      const diagnosticValue = (name: string): string | undefined => {
        const entry = value.entries.find(
          (candidate) => candidate.key.name === name,
        );
        return entry ? nameText(entry.value) : undefined;
      };
      diagnostics.push({
        code: diagnosticValue("code") ?? "HSX1110",
        fix:
          diagnosticValue("fix") ??
          "choose a supported compile-time parameter combination",
        message:
          diagnosticValue("message") ??
          "this compile-time parameter combination is not supported",
        severity: "error",
        span: row.span,
      });
      continue;
    }
    if (
      row.key.name !== "when" &&
      row.key.name !== "when_not" &&
      row.key.name !== "when_eq"
    ) {
      entries.push({
        ...row,
        value:
          row.value.kind === "block" && !row.iteration
            ? selectCompileTimeRows(row.value, locals, diagnostics)
            : row.value,
      });
      continue;
    }
    const subject = row.qualifiers[0];
    const actual = subject ? locals.get(subject.name) : undefined;
    let include = false;
    if (row.key.name === "when_eq") {
      const expected = row.qualifiers[1];
      include = Boolean(
        actual && expected && nameText(actual) === expected.name,
      );
    } else {
      include = compileTimeTruthy(actual);
      if (row.key.name === "when_not") include = !include;
    }
    if (row.value.kind !== "block") {
      diagnostics.push({
        code: "HSX1405",
        fix: "give the compile-time condition a body in braces",
        message: `${row.key.name} needs a fixed block to select`,
        severity: "error",
        span: row.span,
      });
      continue;
    }
    if (include) {
      entries.push(
        ...selectCompileTimeRows(row.value, locals, diagnostics).entries,
      );
    }
  }
  return { ...block, entries };
}

function compileTimeTruthy(value: Expr | undefined): boolean {
  if (!value) return false;
  if (value.kind === "string" && value.value === NONE_SENTINEL) return false;
  if (value.kind === "boolean") return value.value;
  if (value.kind === "number") return Number(value.raw) !== 0;
  if (value.kind === "list") return value.items.length > 0;
  if (value.kind === "block") return value.entries.length > 0;
  return true;
}

function evaluateCompileTimeCall(
  expr: Extract<Expr, { readonly kind: "call" }>,
  resolveMissing = true,
): Expr | undefined {
  const [first, second, third, fourth] = expr.args;
  const number = (value: Expr | undefined): number | undefined => {
    if (value?.kind === "percent") return value.bps;
    if (value?.kind !== "number" || value.raw.includes(".")) return undefined;
    const parsed = Number(value.raw);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const numeric = (value: number): Expr => ({
    kind: "number",
    raw: String(value),
    span: expr.span,
  });
  const text = (value: string): Expr => ({
    kind: "string",
    span: expr.span,
    value,
  });
  const a = number(first);
  const b = number(second);
  switch (expr.callee.name) {
    case "add":
      return a === undefined || b === undefined ? undefined : numeric(a + b);
    case "sub":
      return a === undefined || b === undefined ? undefined : numeric(a - b);
    case "mul":
      return a === undefined || b === undefined ? undefined : numeric(a * b);
    case "div_floor":
      return a === undefined || b === undefined || b === 0
        ? undefined
        : numeric(Math.floor(a / b));
    case "mod":
      return a === undefined || b === undefined || b === 0
        ? undefined
        : numeric(a % b);
    case "min":
      return a === undefined || b === undefined
        ? undefined
        : numeric(Math.min(a, b));
    case "lt":
      return a === undefined || b === undefined
        ? undefined
        : numeric(a < b ? 1 : 0);
    case "len":
      return first?.kind === "list"
        ? numeric(first.items.length)
        : first?.kind === "block"
          ? numeric(first.entries.length)
          : first?.kind === "boolean" && !first.value
            ? numeric(0)
            : undefined;
    case "at": {
      const index = number(second);
      if (index === undefined) return undefined;
      if (first?.kind === "list") return first.items[index - 1];
      if (first?.kind === "block") return first.entries[index - 1]?.value;
      return undefined;
    }
    case "get": {
      const key = second ? nameText(second) : "";
      if (!key || key === "invalid_compile_time_name") return undefined;
      const body = first?.kind === "decided_amount" ? first.body : first;
      if (body?.kind !== "block") {
        return resolveMissing
          ? { kind: "string", span: expr.span, value: NONE_SENTINEL }
          : undefined;
      }
      const value = body.entries.find((row) => row.key.name === key)?.value;
      if (value || !resolveMissing) return value;
      return { kind: "string", span: expr.span, value: NONE_SENTINEL };
    }
    case "keys":
      return first?.kind === "block" || first?.kind === "decided_amount"
        ? {
            items: (first.kind === "decided_amount"
              ? first.body
              : first
            ).entries.map((row) => ({ ...row.key })),
            kind: "list",
            span: expr.span,
          }
        : undefined;
    case "values":
      return first?.kind === "block"
        ? {
            items: first.entries.map((row) => row.value),
            kind: "list",
            span: expr.span,
          }
        : undefined;
    case "keys_except": {
      if (first?.kind !== "block") return undefined;
      const omitted = new Set(expr.args.slice(1).map(nameText));
      return {
        items: first.entries
          .filter((row) => !omitted.has(row.key.name))
          .map((row) => ({ ...row.key })),
        kind: "list",
        span: expr.span,
      };
    }
    case "kind":
      return first
        ? text(
            first.kind === "string" && first.value === NONE_SENTINEL
              ? "none"
              : first.kind,
          )
        : undefined;
    case "basis_points":
      return first?.kind === "percent" ? numeric(first.bps) : undefined;
    case "names": {
      const count = number(second);
      if (!first || count === undefined || count < 0 || !third)
        return undefined;
      return {
        items: Array.from({ length: count }, (_, index) =>
          text(`${nameText(first)}${index + 1}${nameText(third)}`),
        ),
        kind: "list",
        span: expr.span,
      };
    }
    case "suffix_each":
      return first?.kind === "list" && second
        ? {
            items: first.items.map((item) =>
              text(`${camel(nameText(item))}${nameText(second)}`),
            ),
            kind: "list",
            span: expr.span,
          }
        : undefined;
    case "concat_lists":
      return expr.args.every((arg) => arg.kind === "list")
        ? {
            items: expr.args.flatMap((arg) =>
              arg.kind === "list" ? arg.items : [],
            ),
            kind: "list",
            span: expr.span,
          }
        : undefined;
    case "concat":
      return text(expr.args.map(nameText).join(""));
    case "camel":
      return first ? text(camel(nameText(first))) : undefined;
    case "title":
      return first ? text(titleize(nameText(first))) : undefined;
    case "sentence":
      return first ? text(sentenceCase(nameText(first))) : undefined;
    case "percent_text": {
      const basisPoints = number(first);
      if (basisPoints === undefined) return undefined;
      const whole = Math.trunc(basisPoints / 100);
      const fraction = basisPoints % 100;
      const decimal =
        fraction === 0
          ? ""
          : fraction % 10 === 0
            ? `.${fraction / 10}`
            : `.${String(fraction).padStart(2, "0")}`;
      return text(`${whole}${decimal}%`);
    }
    case "words":
      return first ? text(nameText(first).replaceAll("_", " ")) : undefined;
    case "prefix":
      return first ? text(prefixFor(nameText(first))) : undefined;
    case "owner":
      return first?.kind === "settlement_ref"
        ? text(first.owner.name)
        : undefined;
    case "member":
      return first?.kind === "settlement_ref"
        ? text(first.member.name)
        : undefined;
    case "scale_duration": {
      if (!first || b === undefined) return undefined;
      const match = /^P([0-9]+)([DWMY])$/.exec(nameText(first));
      if (!match) return undefined;
      const amount = Number(match[1]) * b;
      return match[2] === "W"
        ? text(`P${amount * 7}D`)
        : text(`P${amount}${match[2]}`);
    }
    case "if_eq":
      return first && second && nameText(first) === nameText(second)
        ? third
        : fourth;
    default:
      return undefined;
  }
}

function substituteName(
  name: IdentExpr,
  values: ReadonlyMap<string, Expr>,
): IdentExpr {
  return {
    ...name,
    name: name.name.replaceAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g, (whole, key) => {
      const value = values.get(String(key));
      return value ? nameText(value) : String(whole);
    }),
  };
}

function fixedQualifier(
  key: string,
  qualifier: string,
  index: number,
): boolean {
  if (["action", "when", "when_not", "when_eq"].includes(key)) return true;
  if (key === "on" && index === 0) return true;
  const normalizedKey = key.replaceAll("_", " ");
  return udlClauseVocabulary.some(
    (definition) =>
      definition.spelling === `${normalizedKey} ${qualifier}` ||
      definition.spelling ===
        `${normalizedKey} ${qualifier.replaceAll("_", " ")}`,
  );
}

function nameFromValue(origin: IdentExpr, value: Expr): IdentExpr {
  return { ...origin, name: nameText(value) };
}

function nameText(value: Expr): string {
  if (value.kind === "binding") return value.name.name;
  if (value.kind === "ident") return value.name;
  if (value.kind === "number") return value.raw;
  if (value.kind === "string") return value.value;
  if (value.kind === "percent") return `${value.raw}%`;
  if (value.kind === "port_ref") return value.name.name;
  if (value.kind === "settlement_ref")
    return `${value.owner.name}.${value.member.name}`;
  return "invalid_compile_time_name";
}

function expandComprehensions(
  block: BlockExpr,
  diagnostics: GeneralDiagnostic[],
): BlockExpr {
  const budget = { used: 0 };
  const expand = (
    current: BlockExpr,
    inherited: ReadonlyMap<string, Expr> = new Map(),
  ): BlockExpr => {
    const entries: Entry[] = [];
    const locals = new Map(inherited);
    for (const row of current.entries) {
      if (row.key.name === "let") {
        const binding = row.qualifiers[0];
        if (!binding) {
          diagnostics.push({
            code: "HSX1405",
            fix: "write `let(name): <compile-time value>`",
            message: "a compile-time binding needs one name",
            severity: "error",
            span: row.span,
          });
          continue;
        }
        locals.set(binding.name, substituteExpr(row.value, locals));
        continue;
      }
      if (
        row.key.name === "when" ||
        row.key.name === "when_not" ||
        row.key.name === "when_eq"
      ) {
        const subject = row.qualifiers[0];
        const actual = subject ? locals.get(subject.name) : undefined;
        const expected = row.qualifiers[1];
        let include =
          row.key.name === "when_eq"
            ? Boolean(actual && expected && nameText(actual) === expected.name)
            : compileTimeTruthy(actual);
        if (row.key.name === "when_not") include = !include;
        if (include && row.value.kind === "block") {
          entries.push(...expand(row.value, locals).entries);
        }
        continue;
      }
      if (!row.iteration) {
        const substituted: Entry = {
          ...row,
          key: substituteName(row.key, locals),
          qualifiers: row.qualifiers.map((qualifier, index) => {
            const value = locals.get(qualifier.name);
            const fixed = fixedQualifier(row.key.name, qualifier.name, index);
            return !fixed && value
              ? nameFromValue(qualifier, value)
              : substituteName(qualifier, locals);
          }),
          value: substituteExpr(row.value, locals),
        };
        entries.push({
          ...substituted,
          value:
            substituted.value.kind === "block"
              ? expand(substituted.value, locals)
              : substituted.value,
        });
        continue;
      }
      if (row.value.kind !== "block") continue;
      const bound = substituteExpr(row.iteration.bound, locals);
      const values = finiteIterationValues(bound);
      if (!values) {
        diagnostics.push({
          code: "HSX1403",
          fix: "pass an integer literal or a literal finite list as the comprehension bound",
          message: `comprehension bound for ${row.iteration.binding.name} is not known at compile time`,
          severity: "error",
          span: bound.span,
        });
        continue;
      }
      if (budget.used + values.length > MAX_COMPREHENSION_EXPANSIONS) {
        diagnostics.push({
          code: "HSX1404",
          fix: `reduce the fixed expansion to at most ${MAX_COMPREHENSION_EXPANSIONS} rows`,
          message: `bounded comprehensions expand past the ${MAX_COMPREHENSION_EXPANSIONS}-row compiler limit`,
          severity: "error",
          span: bound.span,
        });
        continue;
      }
      budget.used += values.length;
      for (const value of values) {
        const substitutions = new Map<string, Expr>([
          ...locals,
          [row.iteration.binding.name, value],
        ]);
        const body = substituteExpr(row.value, substitutions);
        if (body.kind === "block")
          entries.push(...expand(body, substitutions).entries);
      }
    }
    return { ...current, entries };
  };
  return expand(block);
}

function finiteIterationValues(bound: Expr): readonly Expr[] | undefined {
  if (bound.kind === "call") {
    const evaluated = evaluateCompileTimeCall(bound);
    return evaluated ? finiteIterationValues(evaluated) : undefined;
  }
  if (bound.kind === "list") return bound.items;
  if (bound.kind !== "number" || bound.raw.includes(".")) return undefined;
  const count = Number(bound.raw);
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  return Array.from(
    { length: count },
    (_, index): Expr => ({
      kind: "number",
      raw: String(index + 1),
      span: bound.span,
    }),
  );
}

function checkInstrument(
  name: IdentExpr,
  body: BlockExpr,
  parties: ReadonlySet<string>,
  aliases: ReadonlyMap<string, Expr>,
  diagnostics: GeneralDiagnostic[],
): TypedInstrument | undefined {
  if (!SNAKE_CASE.test(name.name)) {
    diagnostics.push({
      code: "HSX1003",
      fix: "rename the instrument with lowercase words joined by underscores",
      message: `instrument ${name.name} is not snake_case`,
      severity: "error",
      span: name.span,
    });
  }
  const fieldsEntry = entry(body, "fields");
  const fields =
    fieldsEntry?.value.kind === "block"
      ? checkFields(fieldsEntry.value, aliases, diagnostics)
      : [];
  if (!fieldsEntry) {
    diagnostics.push({
      code: "HSX1503",
      fix: "add a fields { ... } block, even when it is empty",
      message: `instrument ${name.name} has no fields block`,
      severity: "error",
      span: name.span,
    });
  }
  const fieldNames = new Set(fields.map((field) => field.name));
  if (
    fields.some((field) => field.type.kind === "money") &&
    !fieldNames.has("currency")
  ) {
    fields.push({
      name: "currency",
      origin: fieldsEntry?.span ?? name.span,
      required: true,
      schema: {
        description: "ISO 4217 currency code",
        maxLength: 3,
        minLength: 3,
        pattern: "^[A-Z]{3}$",
        type: "string",
      },
      type: { kind: "text" },
    });
    fieldNames.add("currency");
  }
  const endpointFields = new Map<string, string>();
  for (const field of fields) {
    if (field.type.kind === "account")
      endpointFields.set(field.name, field.name);
  }
  const slots: Record<string, JsonValue> = {};
  const partiesEntry = entry(body, "parties");
  if (partiesEntry?.value.kind === "block") {
    const roleObject = blockToObject(
      partiesEntry.value,
      new Map(),
      diagnostics,
    );
    for (const [role, value] of Object.entries(roleObject)) {
      if (typeof value !== "string") continue;
      if (fieldNames.has(value)) {
        endpointFields.set(role, value);
        endpointFields.set(value, value);
        continue;
      }
      if (parties.has(value)) {
        const field = `${camel(value)}AccountId`;
        roleObject[role] = field;
        endpointFields.set(role, field);
        endpointFields.set(value, field);
        if (!fieldNames.has(field)) {
          fields.push({
            name: field,
            origin: partiesEntry.span,
            required: true,
            schema: {
              description: `The ${value.replaceAll("_", " ")} account`,
              pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
              type: "string",
              "x-hyperscale-reference-filter": {
                column: "role",
                values: ["customer_balance"],
              },
            },
            type: { kind: "account" },
          });
          fieldNames.add(field);
        }
        continue;
      }
      diagnostics.push({
        code: "HSX1001",
        fix: "bind the role to a declared party or field",
        message: `party role refers to ${String(value)}, which is not declared`,
        severity: "error",
        span:
          partiesEntry.value.entries.find((entry) => entry.key.name === role)
            ?.value.span ?? partiesEntry.span,
      });
    }
    slots.parties = roleObject;
  }
  const actionEntries = body.entries.filter(
    (candidate) =>
      candidate.key.name === "action" && candidate.value.kind === "block",
  );
  const actionNames = new Set(
    actionEntries.map((candidate) => candidate.qualifiers[0]?.name ?? ""),
  );
  const holdDestinations = new Map<string, string>();
  for (const actionEntry of actionEntries) {
    if (actionEntry.value.kind !== "block") continue;
    for (const move of friendlyMoveRows(actionEntry.value)) {
      if (move.operation === "post" && move.from && move.to) {
        const destination = endpointFields.get(move.to);
        if (destination) holdDestinations.set(move.from, destination);
      }
    }
  }
  for (const actionEntry of actionEntries) {
    if (actionEntry.value.kind !== "block") continue;
    for (const move of friendlyMoveRows(actionEntry.value)) {
      for (const endpoint of [move.from, move.to]) {
        if (
          !endpoint ||
          endpoint.startsWith("refs.") ||
          endpointFields.has(endpoint) ||
          holdDestinations.has(endpoint)
        ) {
          continue;
        }
        const field = `${camel(endpoint)}AccountId`;
        endpointFields.set(endpoint, field);
        if (!fieldNames.has(field)) {
          fields.push({
            name: field,
            origin: actionEntry.span,
            required: true,
            schema: {
              pattern: "^acct_(sandbox|live)_[a-z0-9]{8,64}$",
              type: "string",
            },
            type: { kind: "account" },
          });
          fieldNames.add(field);
        }
      }
    }
  }
  const actions = actionEntries.flatMap((candidate) => {
    const actionName = candidate.qualifiers[0];
    if (!actionName || candidate.value.kind !== "block") return [];
    return [
      checkAction(
        actionName,
        candidate.value,
        fields,
        name.name,
        endpointFields,
        holdDestinations,
        diagnostics,
      ),
    ];
  });
  if (!actionNames.has("create")) {
    diagnostics.push({
      code: "HSX1504",
      fix: 'add action create { summary: "Create ..."; steps: [] }',
      message: `instrument ${name.name} has no create action`,
      severity: "error",
      span: name.span,
    });
  }

  const lifecycleEntry = entry(body, "lifecycle");
  const lifecycle =
    lifecycleEntry?.value.kind === "block"
      ? checkLifecycle(
          name.name,
          lifecycleEntry.value,
          actionNames,
          diagnostics,
        )
      : undefined;
  if (!lifecycle) {
    diagnostics.push({
      code: "HSX1402",
      fix: "add lifecycle { states ...; initial ...; on ...; }",
      message: `instrument ${name.name} has no valid lifecycle`,
      severity: "error",
      span: name.span,
    });
  }

  for (const row of body.entries) {
    if (
      row.key.name === "fields" ||
      row.key.name === "lifecycle" ||
      row.key.name === "parties" ||
      row.key.name === "action"
    )
      continue;
    if (row.key.name === "required") {
      const explicit = exprToJsonForUdlSlot(row.value, "required", diagnostics);
      const checked = checkRequiredFields(
        explicit,
        fields,
        row.span,
        diagnostics,
      );
      if (checked) slots.required = checked;
      continue;
    }
    const spelling = clauseSpelling(row, instrumentClauseBySpelling);
    const definition = instrumentClauseBySpelling.get(spelling);
    if (definition?.scope === "instrument") {
      setClause(
        slots,
        definition.target,
        definition.cardinality,
        exprToJsonForUdlSlot(row.value, definition.target, diagnostics),
        definition.spelling,
        row.span,
        diagnostics,
      );
      continue;
    }
    if (!definition && row.key.name !== "required") {
      diagnostics.push({
        code: "HSX1501",
        fix: "use a clause exported by the targeted UDL definition set",
        message: `instrument clause ${spelling} does not exist in the targeted UDL vocabulary`,
        severity: "error",
        span: row.key.span,
      });
    }
  }
  if (lifecycle) {
    slots.lifecycle = lifecycle.value;
    if (Object.keys(lifecycle.parked).length > 0) {
      slots.callerParkedStates = lifecycle.parked;
    }
  }
  slots.idPrefix ??=
    stringSlot(body, "idPrefix", "id_prefix") ?? prefixFor(name.name);
  slots.summary ??= `${titleize(name.name)} instrument`;
  slots.title ??= titleize(name.name);
  linearityDiagnostics(actionEntries, diagnostics);

  return { actions, fields, id: name.name, origin: name.span, slots };
}

function checkRequiredFields(
  value: JsonValue,
  fields: readonly TypedField[],
  span: Span,
  diagnostics: GeneralDiagnostic[],
): readonly string[] | undefined {
  const report = (message: string, fix: string): void => {
    diagnostics.push({
      code: "HSX1023",
      fix,
      message,
      severity: "error",
      span,
    });
  };
  if (!Array.isArray(value)) {
    report(
      "required must be a list of field names",
      "write required as a list, such as [amount, currency]",
    );
    return undefined;
  }

  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const seen = new Set<string>();
  let valid = true;
  for (const item of value) {
    if (typeof item !== "string") {
      valid = false;
      report(
        "required contains a value that is not a field name",
        "keep only declared non-optional field names in required",
      );
      continue;
    }
    if (seen.has(item)) {
      valid = false;
      report(
        `required names ${item} more than once`,
        `keep one ${item} entry in required`,
      );
      continue;
    }
    seen.add(item);
    const field = fieldByName.get(item);
    if (!field) {
      valid = false;
      report(
        `required names unknown field ${item}`,
        "name a declared non-optional field in required",
      );
      continue;
    }
    if (!field.required) {
      valid = false;
      report(
        `required names optional field ${item}`,
        `remove ${item} from required or make the field non-optional`,
      );
    }
  }
  return valid ? value : undefined;
}

function checkFields(
  block: BlockExpr,
  aliases: ReadonlyMap<string, Expr>,
  diagnostics: GeneralDiagnostic[],
): TypedField[] {
  const result: TypedField[] = [];
  const names = new Set<string>();
  for (const row of block.entries) {
    const name = camel(row.key.name);
    if (!CAMEL_CASE.test(name)) {
      diagnostics.push({
        code: "HSX1005",
        fix: "rename the field in lower camelCase",
        message: `field ${row.key.name} is not lower camelCase`,
        severity: "error",
        span: row.key.span,
      });
    }
    if (names.has(name)) {
      diagnostics.push({
        code: "HSX1004",
        fix: `keep one ${name} field`,
        message: `field ${name} is declared twice`,
        severity: "error",
        span: row.key.span,
      });
      continue;
    }
    names.add(name);
    let typeExpr = row.value;
    let description: string | undefined;
    let required = true;
    let extra: Record<string, JsonValue> = {};
    if (row.value.kind === "block") {
      const typeRow = entry(row.value, "type");
      if (typeRow) typeExpr = typeRow.value;
      const desc = entry(row.value, "description") ?? entry(row.value, "desc");
      if (desc?.value.kind === "string") description = desc.value.value;
      const optional = entry(row.value, "optional");
      if (optional?.value.kind === "boolean") required = !optional.value.value;
      extra = blockToObject(
        {
          ...row.value,
          entries: row.value.entries.filter(
            (item) =>
              !["type", "description", "desc", "optional"].includes(
                item.key.name,
              ),
          ),
        },
        new Map(),
        diagnostics,
      );
    }
    const type = typeOf(typeExpr, aliases);
    const fixedMoneyIssue = invalidFixedMoneyBinding(typeExpr);
    if (fixedMoneyIssue) {
      diagnostics.push({
        code: "HSX1103",
        fix: `write ${name} as money(SAR, 2500) with a positive safe integer in minor units`,
        message: `field ${name} ${fixedMoneyIssue}`,
        severity: "error",
        span: typeExpr.span,
      });
    }
    if (
      (typeExpr.kind === "ident" && typeExpr.name === "ref") ||
      (type.kind === "ref" && !type.target)
    ) {
      diagnostics.push({
        code: "HSX1007",
        fix: "declare the target instrument as ref<instrument_id>",
        message: `field ${name} declares ref without an instrument target`,
        severity: "error",
        span: typeExpr.span,
      });
    }
    const structuralType = Object.hasOwn(extra, "items")
      ? "array"
      : Object.hasOwn(extra, "properties") ||
          Object.hasOwn(extra, "additionalProperties")
        ? "object"
        : undefined;
    const schema = {
      ...schemaFor(type, required),
      ...extra,
      ...(structuralType ? { type: structuralType } : {}),
      ...(description ? { description } : {}),
    };
    result.push({ name, origin: row.span, required, schema, type });
  }
  return result;
}

function checkLifecycle(
  instrument: string,
  block: BlockExpr,
  actions: ReadonlySet<string>,
  diagnostics: GeneralDiagnostic[],
):
  | {
      readonly parked: Record<string, JsonValue>;
      readonly value: Record<string, JsonValue>;
    }
  | undefined {
  const statesRows = block.entries.filter((row) => row.key.name === "states");
  const initialRow = entry(block, "initial");
  const states = statesRows.flatMap((row) =>
    row.value.kind === "list"
      ? row.value.items.flatMap((item) =>
          item.kind === "ident"
            ? [item.name]
            : item.kind === "string"
              ? [item.value]
              : [],
        )
      : [],
  );
  const initial =
    initialRow?.value.kind === "ident"
      ? initialRow.value.name
      : initialRow?.value.kind === "string"
        ? initialRow.value.value
        : "";
  if (states.length === 0 || !initial) return undefined;
  const stateSet = new Set(states);
  if (!stateSet.has(initial)) {
    diagnostics.push({
      code: "HSX1001",
      fix: `add ${initial} to the states row or choose a declared initial state`,
      message: `lifecycle initial state ${initial} is not declared by ${instrument}`,
      severity: "error",
      span: initialRow?.span ?? block.span,
    });
  }
  const transitions: Record<string, JsonValue> = {};
  const parked: Record<string, JsonValue> = {};
  for (const row of block.entries) {
    if (row.key.name === "parked") {
      const state = row.qualifiers[0]?.name;
      if (state && row.value.kind === "string") parked[state] = row.value.value;
      continue;
    }
    if (row.key.name !== "on") continue;
    const action = row.qualifiers[0]?.name ?? "";
    const from = row.qualifiers.slice(1).map((item) => item.name);
    const to =
      row.value.kind === "ident"
        ? row.value.name
        : row.value.kind === "string"
          ? row.value.value
          : "";
    if (!actions.has(action)) {
      diagnostics.push({
        code: "HSX1001",
        fix: `declare action ${action} { ... } or remove its transition`,
        message: `lifecycle transition names action ${action}, which ${instrument} does not declare`,
        severity: "error",
        span: row.span,
      });
    }
    for (const state of [...from, to]) {
      if (stateSet.has(state)) continue;
      diagnostics.push({
        code: "HSX1001",
        fix: `add ${state} to states or correct the transition`,
        message: `lifecycle transition ${action} refers to undeclared state ${state}`,
        severity: "error",
        span: row.span,
      });
    }
    transitions[action] = { from, to };
  }
  return { parked, value: { initial, states, transitions } };
}

function checkAction(
  name: IdentExpr,
  body: BlockExpr,
  fields: readonly TypedField[],
  instrumentId: string,
  endpointFields: ReadonlyMap<string, string>,
  holdDestinations: ReadonlyMap<string, string>,
  diagnostics: GeneralDiagnostic[],
): TypedAction {
  const slots: Record<string, JsonValue> = {};
  let omitsPublicAction = false;
  const fieldNames = new Set(fields.map((field) => field.name));
  for (const row of body.entries) {
    if (["for", "while", "loop", "recurse"].includes(row.key.name)) {
      diagnostics.push({
        code: "HSX1401",
        fix: "use a bounded comprehension over list<T, N> or a declared finite schedule",
        message: `${row.key.name} is unbounded; every HSX action must terminate at compile time`,
        severity: "error",
        span: row.key.span,
      });
      continue;
    }
    if (
      row.key.name === "public" &&
      row.qualifiers.length === 0 &&
      row.value.kind === "ident" &&
      row.value.name === "none"
    ) {
      omitsPublicAction = true;
      continue;
    }
    const spelling = clauseSpelling(row, actionClauseBySpelling);
    const definition = actionClauseBySpelling.get(spelling);
    if (definition?.scope === "action" && spelling === "notify") {
      const role = row.qualifiers[0]?.name;
      const channel = row.qualifiers[1]?.name;
      if (role && channel) {
        const notification = { channel, role };
        setClause(
          slots,
          definition.target,
          definition.cardinality,
          notification,
          definition.spelling,
          row.span,
          diagnostics,
        );
      }
      continue;
    }
    if (definition?.scope === "action") {
      const rawValue = exprToJsonForUdlSlot(
        row.value,
        definition.target,
        diagnostics,
      );
      const moveOffset = Array.isArray(slots.moves) ? slots.moves.length : 0;
      const value =
        definition.target === "moves"
          ? normalizeMoves(
              rawValue,
              name.name,
              instrumentId,
              fields,
              endpointFields,
              holdDestinations,
              diagnostics,
              row.span,
              moveOffset,
            )
          : rawValue;
      setClause(
        slots,
        definition.target,
        definition.cardinality,
        value,
        definition.spelling,
        row.span,
        diagnostics,
      );
      continue;
    }
    diagnostics.push({
      code: "HSX1501",
      fix: "use a clause exported by the targeted UDL definition set",
      message: `action clause ${spelling} does not exist in the targeted UDL vocabulary`,
      severity: "error",
      span: row.key.span,
    });
  }
  slots.summary ??= `${titleize(name.name)} ${fields.length === 1 ? (fields[0]?.name ?? "instrument") : "instrument"}`;
  slots.steps ??= [];
  slots.moves ??= [];
  if (omitsPublicAction && slots.publicAction !== undefined) {
    diagnostics.push({
      code: "HSX1506",
      fix: "keep either `public: none` or `public action: actionName`",
      message: `action ${name.name} both omits and names its public action`,
      severity: "error",
      span: name.span,
    });
  }
  if (
    !omitsPublicAction &&
    slots.publicAction === undefined &&
    slots.due === undefined &&
    slots.reconcile === undefined
  ) {
    slots.publicAction = camel(`${name.name}_${instrumentId}`);
  }
  bindFieldReferences(slots, fieldNames, name, diagnostics);
  const effects = deriveUdlActionEffects(slots, udlClauseVocabulary);
  if (Object.keys(effects).length > 0) {
    slots.effects = effects as unknown as JsonValue;
  } else {
    delete slots.effects;
  }
  return { effects, name: name.name, origin: name.span, slots };
}

function normalizeMoves(
  value: JsonValue,
  action: string,
  instrumentId: string,
  fields: readonly TypedField[],
  endpointFields: ReadonlyMap<string, string>,
  holdDestinations: ReadonlyMap<string, string>,
  diagnostics: GeneralDiagnostic[],
  span: Span,
  offset = 0,
): JsonValue {
  if (!Array.isArray(value)) return value;
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return value.map((candidate, index) => {
    if (!isJsonObject(candidate) || candidate.bind !== undefined)
      return candidate;
    const amount =
      typeof candidate.amount === "string" ? candidate.amount : undefined;
    const from =
      typeof candidate.from === "string" ? candidate.from : undefined;
    const to = typeof candidate.to === "string" ? candidate.to : undefined;
    const operationName =
      typeof candidate.operation === "string" ? candidate.operation : "create";
    if (!amount || !from || !to) return candidate;
    const operation = `internal_transfer.${operationName}`;
    const key =
      typeof candidate.key === "string"
        ? candidate.key
        : `${action}_${offset + index + 1}`;
    if (operationName === "post" || operationName === "void") {
      return {
        bind: {
          transferId: { from: "instance", path: "refs.reservationId" },
        },
        key,
        operation,
      };
    }
    const sourcePath = from.startsWith("refs.")
      ? from
      : endpointFields.get(from)
        ? `fields.${endpointFields.get(from)}`
        : undefined;
    const destinationEndpoint =
      operationName === "reserve"
        ? (holdDestinations.get(to) ?? endpointFields.get(to))
        : endpointFields.get(to);
    const destinationPath = to.startsWith("refs.")
      ? to
      : destinationEndpoint
        ? `fields.${destinationEndpoint}`
        : undefined;
    if (!sourcePath || !destinationPath) {
      const missing = !sourcePath ? from : to;
      diagnostics.push({
        code: "HSX1001",
        fix: `bind ${missing} in the instrument parties block`,
        message: `action ${action} moves money through ${missing}, which has no bound account field`,
        severity: "error",
        span,
      });
      return candidate;
    }
    const amountPath = amount.includes(".") ? amount : `fields.${amount}`;
    const move: Record<string, JsonValue> = {
      bind: {
        amount: { from: "instance", path: amountPath },
        currency: { from: "instance", path: "fields.currency" },
        destinationAccountId: {
          from: "instance",
          path: destinationPath,
        },
        sourceAccountId: {
          from: "instance",
          path: sourcePath,
        },
        "metadata.instrumentId": { from: "const", value: instrumentId },
        "metadata.instrumentInstanceId": {
          from: "instance",
          path: "instrumentInstanceId",
        },
        "metadata.phase": { from: "const", value: action },
        productId: { from: "instance", path: "productId" },
      },
      key,
      operation,
    };
    if (operationName === "reserve") {
      move.capture = {
        [camel(`${action}_${key}_transfer_id`)]: "transferId",
      };
    } else if (operationName === "create") {
      move.capture = {
        [camel(`${action}_${key}_transfer_id`)]: "transferId",
      };
    }
    if (
      !amountPath.startsWith("refs.") &&
      !fieldByName.has(amountPath.replace(/^fields\./, ""))
    ) {
      diagnostics.push({
        code: "HSX1001",
        fix: `declare the money field named by ${amount}`,
        message: `action ${action} moves ${amount}, which is not a declared money field`,
        severity: "error",
        span,
      });
    }
    return move;
  });
}

function friendlyMoveRows(body: BlockExpr): readonly {
  readonly from?: string;
  readonly operation?: string;
  readonly to?: string;
}[] {
  const moves = entry(body, "moves")?.value;
  if (moves?.kind !== "list") return [];
  return moves.items.flatMap((item) => {
    if (item.kind !== "block") return [];
    const from = stringSlot(item, "from");
    const operation = stringSlot(item, "operation");
    const to = stringSlot(item, "to");
    return [
      {
        ...(from ? { from } : {}),
        ...(operation ? { operation } : {}),
        ...(to ? { to } : {}),
      },
    ];
  });
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bindFieldReferences(
  slots: Readonly<Record<string, JsonValue>>,
  fields: ReadonlySet<string>,
  action: IdentExpr,
  diagnostics: GeneralDiagnostic[],
): void {
  const externalFieldSlot = (path: readonly string[]): boolean => {
    const key = path.at(-1);
    return (
      (path.includes("requiresAggregate") && key === "refField") ||
      (path.includes("requiresAggregate") && key === "amountField") ||
      (path.includes("signedSum") && key === "refField") ||
      (path.includes("signedSum") && key === "amountField") ||
      (path.includes("remainder") && key === "refField") ||
      (path.includes("remainder") && key === "amountField") ||
      (path.includes("requiresExposure") && key === "capField") ||
      (path.includes("reconcile") &&
        path.includes("exception") &&
        ["amountField", "reasonField", "refField"].includes(key ?? ""))
    );
  };
  const visit = (value: JsonValue, path: readonly string[] = []): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) =>
        visit(child, [...path, childKey]),
      );
      return;
    }
    const key = path.at(-1) ?? "";
    if (
      typeof value === "string" &&
      key.endsWith("Field") &&
      !externalFieldSlot(path) &&
      !fields.has(value)
    ) {
      diagnostics.push({
        code: "HSX1001",
        fix: `declare field ${value} or correct ${key}`,
        message: `action ${action.name} refers to field ${value}, which does not exist`,
        severity: "error",
        span: action.span,
      });
    }
  };
  visit(slots as unknown as JsonValue);
}

function crossInstrumentReferenceDiagnostics(
  instruments: readonly TypedInstrument[],
  diagnostics: GeneralDiagnostic[],
): void {
  const byId = new Map(
    instruments.map((instrument) => [instrument.id, instrument]),
  );
  const report = (
    owner: TypedInstrument,
    span: Span,
    message: string,
    fix: string,
  ): void => {
    diagnostics.push({
      code: "HSX1007",
      fix,
      message: `${owner.id}: ${message}`,
      severity: "error",
      span,
    });
  };
  const fieldIn = (instrument: TypedInstrument, name: string) =>
    instrument.fields.find((field) => field.name === name);
  const statesOf = (instrument: TypedInstrument): ReadonlySet<string> => {
    const lifecycle = jsonObject(instrument.slots.lifecycle);
    return new Set(
      Array.isArray(lifecycle?.states)
        ? lifecycle.states.filter(
            (state): state is string => typeof state === "string",
          )
        : [],
    );
  };

  for (const owner of instruments) {
    for (const field of owner.fields) {
      if (field.type.kind !== "ref" || !field.type.target) continue;
      if (!byId.has(field.type.target)) {
        report(
          owner,
          field.origin,
          `field ${field.name} has ref<${field.type.target}>, but that instrument does not exist`,
          `declare instrument ${field.type.target} or correct the ref target`,
        );
      }
    }

    for (const invariant of jsonObjects(owner.slots.aggregateInvariants)) {
      const childId = invariant.childInstrumentId;
      if (typeof childId !== "string") continue;
      const child = byId.get(childId);
      if (!child) {
        report(
          owner,
          owner.origin,
          `aggregate invariant refers to instrument ${childId}, which does not exist`,
          `declare instrument ${childId} or correct childInstrumentId`,
        );
        continue;
      }
      const childRefField = invariant.childRefField;
      if (typeof childRefField === "string") {
        const field = fieldIn(child, childRefField);
        if (
          !field ||
          field.type.kind !== "ref" ||
          (field.type.target !== undefined && field.type.target !== owner.id)
        ) {
          report(
            owner,
            owner.origin,
            `${childId}.${childRefField} is not ref<${owner.id}>`,
            `declare ${childId}.${childRefField} as ref<${owner.id}> or correct childRefField`,
          );
        }
      }
      const childField = invariant.childField;
      if (
        typeof childField === "string" &&
        fieldIn(child, childField)?.type.kind !== "money"
      ) {
        report(
          owner,
          owner.origin,
          `${childId}.${childField} is not declared money`,
          `declare ${childId}.${childField} as money<C> or correct childField`,
        );
      }
      const childStates = statesOf(child);
      for (const status of Array.isArray(invariant.childStatuses)
        ? invariant.childStatuses
        : []) {
        if (typeof status === "string" && !childStates.has(status)) {
          report(
            owner,
            owner.origin,
            `${childId} has no lifecycle state ${status}`,
            `add ${status} to ${childId} or correct childStatuses`,
          );
        }
      }
      const parentField = invariant.parentField;
      const parent =
        typeof parentField === "string"
          ? fieldIn(owner, parentField)
          : undefined;
      if (
        typeof parentField === "string" &&
        (!parent ||
          (invariant.count === true
            ? parent.type.kind !== "integer"
            : parent.type.kind !== "money"))
      ) {
        const expected = invariant.count === true ? "integer" : "money<C>";
        report(
          owner,
          owner.origin,
          `${owner.id}.${parentField} is not declared ${expected}`,
          `declare ${owner.id}.${parentField} as ${expected} or correct parentField`,
        );
      }
    }

    const checkRelation = (
      action: TypedAction,
      relation: Readonly<Record<string, JsonValue>>,
      targetKey: "childInstrumentId" | "instrumentId",
      checkAmountField = true,
    ): void => {
      const targetId = relation[targetKey];
      if (typeof targetId !== "string") return;
      const target = byId.get(targetId);
      if (!target) {
        report(
          owner,
          action.origin,
          `action ${action.name} refers to instrument ${targetId}, which does not exist`,
          `declare instrument ${targetId} or correct ${targetKey}`,
        );
        return;
      }
      const refField = relation.refField;
      if (typeof refField === "string") {
        const field = fieldIn(target, refField);
        if (!field) {
          report(
            owner,
            action.origin,
            `${targetId}.${refField} does not exist`,
            `declare ${refField} on ${targetId} as ref<${owner.id}> or correct the clause`,
          );
        } else if (
          field.type.kind !== "ref" ||
          (field.type.target !== undefined && field.type.target !== owner.id)
        ) {
          report(
            owner,
            action.origin,
            `${targetId}.${refField} has ${typeWords(field.type)}; this relation needs ref<${owner.id}>`,
            `change ${targetId}.${refField} to ref<${owner.id}>`,
          );
        }
      }
      const check = jsonObject(relation.check);
      const amountField = relation.amountField ?? check?.amountField;
      if (
        checkAmountField &&
        typeof amountField === "string" &&
        relation.path !== "refs"
      ) {
        const field = fieldIn(target, amountField);
        if (!field || field.type.kind !== "money") {
          report(
            owner,
            action.origin,
            `${targetId}.${amountField} is not declared money`,
            `declare ${targetId}.${amountField} as money<C> or correct the clause`,
          );
        }
      }
      const targetField = check?.targetField;
      if (
        typeof targetField === "string" &&
        fieldIn(owner, targetField)?.type.kind !== "money"
      ) {
        report(
          owner,
          action.origin,
          `${owner.id}.${targetField} is not declared money`,
          `declare ${owner.id}.${targetField} as money<C> or correct the aggregate target`,
        );
      }
      const statuses = relation.statuses;
      if (Array.isArray(statuses)) {
        const targetStates = statesOf(target);
        for (const status of statuses) {
          if (typeof status === "string" && !targetStates.has(status)) {
            report(
              owner,
              action.origin,
              `${targetId} has no lifecycle state ${status}`,
              `add ${status} to ${targetId} or correct the clause status`,
            );
          }
        }
      }
    };

    for (const action of owner.actions) {
      for (const gate of jsonObjects(action.slots.requiresRefs)) {
        const fieldName = gate.field;
        if (typeof fieldName !== "string") continue;
        const field = fieldIn(owner, fieldName);
        if (!field || field.type.kind !== "ref" || !field.type.target) continue;
        const target = byId.get(field.type.target);
        if (!target) continue;
        const statuses = Array.isArray(gate.statuses) ? gate.statuses : [];
        const targetStates = statesOf(target);
        for (const status of statuses) {
          if (typeof status === "string" && !targetStates.has(status)) {
            report(
              owner,
              action.origin,
              `${field.type.target} has no lifecycle state ${status}`,
              `correct requires refs statuses for ${fieldName}`,
            );
          }
        }
      }
      for (const relation of jsonObjects(action.slots.requiresAggregate)) {
        checkRelation(action, relation, "instrumentId");
      }
      for (const relation of jsonObjects(action.slots.requiresExposure)) {
        const childId = relation.childInstrumentId;
        if (typeof childId === "string" && childId !== owner.id) {
          report(
            owner,
            action.origin,
            `requires exposure names child ${childId}, but the action belongs to ${owner.id}`,
            `set childInstrumentId to ${owner.id}`,
          );
        }
        const amountField = relation.amountField;
        if (
          typeof amountField === "string" &&
          fieldIn(owner, amountField)?.type.kind !== "money"
        ) {
          report(
            owner,
            action.origin,
            `${owner.id}.${amountField} is not declared money`,
            `declare ${amountField} as money<C> or correct requires exposure`,
          );
        }
        const anchorField = relation.anchorField;
        const anchor =
          typeof anchorField === "string"
            ? fieldIn(owner, anchorField)
            : undefined;
        if (
          typeof anchorField === "string" &&
          (!anchor || anchor.type.kind !== "ref" || !anchor.type.target)
        ) {
          report(
            owner,
            action.origin,
            `${owner.id}.${anchorField} is not a typed cross-instrument ref`,
            `declare ${anchorField} as ref<parent_instrument>`,
          );
        } else if (anchor?.type.target) {
          const parent = byId.get(anchor.type.target);
          const capField = relation.capField;
          if (
            parent &&
            typeof capField === "string" &&
            fieldIn(parent, capField)?.type.kind !== "money"
          ) {
            report(
              owner,
              action.origin,
              `${parent.id}.${capField} is not declared money`,
              `declare ${parent.id}.${capField} as money<C> or correct requires exposure`,
            );
          }
        }
      }
      const signedSum = jsonObject(action.slots.signedSum);
      for (const relation of jsonObjects(signedSum?.sources)) {
        checkRelation(action, relation, "instrumentId");
      }
      const remainder = jsonObject(action.slots.remainder);
      for (const relation of jsonObjects(remainder?.collected)) {
        checkRelation(action, relation, "instrumentId");
      }
      for (const reconcile of jsonObjects(action.slots.reconcile)) {
        const exception = jsonObject(reconcile.exception);
        if (!exception) continue;
        checkRelation(action, exception, "childInstrumentId", false);
        const childId = exception.childInstrumentId;
        if (typeof childId !== "string") continue;
        const child = byId.get(childId);
        if (!child) continue;
        const required = new Set(requiredFields(child));
        for (const [key, expectedKind, expectedWords] of [
          ["amountField", "money", "money<C>"],
          ["reasonField", "text", "text"],
        ] as const) {
          const fieldName = exception[key];
          if (typeof fieldName !== "string") continue;
          const field = fieldIn(child, fieldName);
          if (!field) {
            report(
              owner,
              action.origin,
              `reconcile exception ${key} names ${childId}.${fieldName}, which does not exist`,
              `declare ${childId}.${fieldName} as ${expectedWords} or correct ${key}`,
            );
          } else if (field.type.kind !== expectedKind) {
            report(
              owner,
              action.origin,
              `reconcile exception ${key} names ${childId}.${fieldName}, which has ${typeWords(field.type)}; expected ${expectedWords}`,
              `change ${childId}.${fieldName} to ${expectedWords} or correct ${key}`,
            );
          } else if (!field.required || !required.has(fieldName)) {
            report(
              owner,
              action.origin,
              `reconcile exception ${key} names ${childId}.${fieldName}, which is optional; exception fields must be required`,
              `add ${childId}.${fieldName} to the child required list or correct ${key}`,
            );
          } else if (key === "reasonField") {
            const constraint =
              field.schema.pattern !== undefined
                ? "pattern"
                : field.schema.format !== undefined
                  ? "format"
                  : field.schema.enum !== undefined
                    ? "enum"
                    : field.schema.const !== undefined
                      ? "const"
                      : undefined;
            if (constraint) {
              const article = constraint === "enum" ? "an" : "a";
              report(
                owner,
                action.origin,
                `reason field ${childId}.${fieldName} carries ${article} ${constraint} constraint; reason fields must be unconstrained text`,
                `remove the ${constraint} constraint from ${childId}.${fieldName} or correct reasonField`,
              );
            }
          }
        }
      }
    }
  }
}

function jsonObject(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return value !== undefined && isJsonObject(value) ? value : undefined;
}

function jsonObjects(
  value: JsonValue | undefined,
): readonly Readonly<Record<string, JsonValue>>[] {
  if (Array.isArray(value)) return value.filter(isJsonObject);
  const object = jsonObject(value);
  return object ? [object] : [];
}

function linearityDiagnostics(
  actionEntries: readonly Entry[],
  diagnostics: GeneralDiagnostic[],
): void {
  const clauses = actionEntries.flatMap((action) => {
    if (action.value.kind !== "block") return [];
    return action.value.entries.flatMap((row) => {
      const spelling = clauseSpelling(row, actionClauseBySpelling);
      const definition = actionClauseBySpelling.get(spelling);
      return definition?.scope === "action"
        ? [{ definition, row, spelling }]
        : [];
    });
  });
  const sinks = clauses.filter(
    ({ definition }) =>
      "linearSink" in definition && definition.linearSink === true,
  );
  for (const producer of clauses) {
    const names = linearOutputNames(producer.row, producer.definition);
    for (const name of names) {
      const uses = sinks.reduce(
        (count, sink) => count + countIdentifier(sink.row.value, name),
        0,
      );
      if (uses === 0) {
        diagnostics.push({
          code: "HSX1202",
          fix: `route ${name} with moves, payout, distribution, a fee assignment, or an explicit remainder sink`,
          message: `money ${name} produced by ${producer.spelling} is never consumed`,
          severity: "error",
          span: producer.row.span,
        });
      } else if (uses > 1) {
        diagnostics.push({
          code: "HSX1201",
          fix: `leave exactly one sink for ${name}`,
          message: `money ${name} is consumed ${uses} times; each money value must be consumed exactly once`,
          severity: "error",
          span: producer.row.span,
        });
      }
    }
  }
}

function linearOutputNames(
  row: Entry,
  definition: ClauseDefinition,
): readonly string[] {
  if (!("linearOutputs" in definition) || !definition.linearOutputs) return [];
  const spellingQualifierCount = definition.spelling.split(" ").length - 1;
  const explicitBinding = row.qualifiers.slice(spellingQualifierCount).at(-1);
  if (explicitBinding) return [explicitBinding.name];
  return definition.linearOutputs
    .flatMap((path) => {
      const value = exprAtPath(row.value, path.split("."));
      if (value?.kind === "ident") return [value.name];
      if (value?.kind === "string") return [value.value];
      if (value?.kind === "path") return [value.parts.at(-1)?.name ?? ""];
      return [];
    })
    .filter((name) => name.length > 0);
}

function exprAtPath(expr: Expr, path: readonly string[]): Expr | undefined {
  if (path.length === 0) return expr;
  const block = expr.kind === "decided_amount" ? expr.body : expr;
  if (block.kind !== "block") return undefined;
  const [head, ...tail] = path;
  const row = block.entries.find(
    (candidate) => camel(candidate.key.name) === camel(head ?? ""),
  );
  return row ? exprAtPath(row.value, tail) : undefined;
}

function countIdentifier(expr: Expr, name: string): number {
  if (expr.kind === "ident") return expr.name === name ? 1 : 0;
  if (expr.kind === "string")
    return expr.value === name || expr.value.endsWith(`.${name}`) ? 1 : 0;
  if (expr.kind === "path") return expr.parts.at(-1)?.name === name ? 1 : 0;
  if (expr.kind === "settlement_ref") return expr.member.name === name ? 1 : 0;
  if (expr.kind === "list")
    return expr.items.reduce(
      (sum, item) => sum + countIdentifier(item, name),
      0,
    );
  if (expr.kind === "block")
    return expr.entries.reduce(
      (sum, row) => sum + countIdentifier(row.value, name),
      0,
    );
  if (expr.kind === "call" || expr.kind === "type_apply") {
    return expr.args.reduce(
      (sum, item) => sum + countIdentifier(item, name),
      0,
    );
  }
  if (expr.kind === "apply") {
    return [...expr.args, ...expr.typeArgs].reduce(
      (sum, item) => sum + countIdentifier(item, name),
      0,
    );
  }
  if (expr.kind === "binding") return countIdentifier(expr.type, name);
  if (expr.kind === "decided_amount") return countIdentifier(expr.body, name);
  return 0;
}

function clauseSpelling(
  row: Entry,
  vocabulary: ReadonlyMap<string, (typeof udlClauseVocabulary)[number]>,
): string {
  const key = row.key.name.replaceAll("_", " ");
  const first = row.qualifiers[0]?.name;
  if (!first) return key;
  const candidates = [
    `${key} ${first}`,
    `${key} ${first.replaceAll("_", " ")}`,
  ];
  return candidates.find((candidate) => vocabulary.has(candidate)) ?? key;
}

function setClause(
  target: Record<string, JsonValue>,
  path: string,
  cardinality: "one" | "many" | undefined,
  value: JsonValue,
  spelling: string,
  span: Span,
  diagnostics: GeneralDiagnostic[],
): void {
  const [head, tail] = path.split(".");
  if (!head) return;
  if (!tail) {
    const resolved = clauseValue(
      target[head],
      cardinality,
      value,
      spelling,
      span,
      diagnostics,
    );
    if (resolved !== undefined) target[head] = resolved;
    return;
  }
  const nested =
    target[head] &&
    typeof target[head] === "object" &&
    !Array.isArray(target[head])
      ? { ...(target[head] as Record<string, JsonValue>) }
      : {};
  const resolved = clauseValue(
    nested[tail],
    cardinality,
    value,
    spelling,
    span,
    diagnostics,
  );
  if (resolved !== undefined) nested[tail] = resolved;
  target[head] = nested;
}

function clauseValue(
  current: JsonValue | undefined,
  cardinality: "one" | "many" | undefined,
  value: JsonValue,
  spelling: string,
  span: Span,
  diagnostics: GeneralDiagnostic[],
): JsonValue | undefined {
  if (cardinality === "many") {
    const next = Array.isArray(value) ? value : [value];
    return Array.isArray(current) ? [...current, ...next] : next;
  }
  if (current === undefined) return value;
  diagnostics.push({
    code: "HSX1505",
    fix: `keep one ${spelling} clause`,
    message: `${spelling} is a single-valued UDL clause and appears more than once`,
    severity: "error",
    span,
  });
  return undefined;
}

function entry(block: BlockExpr, ...names: string[]): Entry | undefined {
  return block.entries.find((candidate) => names.includes(candidate.key.name));
}

function stringSlot(block: BlockExpr, ...names: string[]): string | undefined {
  const found = entry(block, ...names)?.value;
  if (found?.kind === "string") return found.value;
  if (found?.kind === "ident") return found.name;
  return undefined;
}

function blockToObject(
  block: BlockExpr | undefined,
  substitutions: ReadonlyMap<string, Expr>,
  diagnostics: GeneralDiagnostic[],
): Record<string, JsonValue> {
  if (!block) return {};
  const result: Record<string, JsonValue> = {};
  for (const row of block.entries) {
    const value = substituteExpr(row.value, substitutions);
    if (twoArgumentMoneyCall(value)) {
      diagnostics.push({
        code: "HSX1104",
        fix: "bind money(CUR, amount) to a declared field whose UDL schema can carry const",
        message: `UDL slot ${camel(row.key.name)} cannot carry a fixed money binding`,
        severity: "error",
        span: row.value.span,
      });
      continue;
    }
    result[row.key.quoted ? row.key.name : camel(row.key.name)] = exprToJson(
      value,
      diagnostics,
    );
  }
  return result;
}

function exprToJsonForUdlSlot(
  expr: Expr,
  slot: string,
  diagnostics: GeneralDiagnostic[],
): JsonValue {
  if (twoArgumentMoneyCall(expr)) {
    diagnostics.push({
      code: "HSX1104",
      fix: "bind money(CUR, amount) to a declared field whose UDL schema can carry const",
      message: `UDL slot ${slot} cannot carry a fixed money binding`,
      severity: "error",
      span: expr.span,
    });
  }
  if (slot === "callerParkedStates" && expr.kind === "block") {
    return Object.fromEntries(
      expr.entries.map((row) => [
        row.key.name,
        exprToJson(row.value, diagnostics),
      ]),
    );
  }
  return exprToJson(expr, diagnostics);
}

function exprToJson(expr: Expr, diagnostics: GeneralDiagnostic[]): JsonValue {
  switch (expr.kind) {
    case "boolean":
      return expr.value;
    case "string":
      return expr.value;
    case "number": {
      if (expr.raw.includes(".")) {
        diagnostics.push({
          code: "HSX1103",
          fix: "use an integer, percent, bps, or currency-indexed money literal",
          message: `${expr.raw} is a free decimal; HSX has no float type`,
          severity: "error",
          span: expr.span,
        });
        return expr.raw;
      }
      return Number(expr.raw);
    }
    case "percent":
      return expr.bps;
    case "money": {
      const precision = minorUnits[expr.currency.name] ?? 2;
      const [whole = "0", fraction = ""] = expr.raw.split(".");
      if (fraction.length > precision) {
        diagnostics.push({
          code: "HSX1102",
          fix: `round the literal to ${precision} minor-unit digits`,
          message: `${expr.currency.name} ${expr.raw} is finer than ${expr.currency.name} minor units`,
          severity: "error",
          span: expr.span,
        });
      }
      return `${whole}${fraction.padEnd(precision, "0")}`.replace(
        /^0+(?=\d)/,
        "",
      );
    }
    case "ident":
      return expr.name;
    case "path":
      return expr.parts.map((part) => part.name).join(".");
    case "settlement_ref":
      return `${expr.owner.name}.${expr.member.name}`;
    case "list":
      return expr.items.map((item) => exprToJson(item, diagnostics));
    case "block":
      return blockToObject(expr, new Map(), diagnostics);
    case "call":
      return `${expr.callee.name}(${expr.args.map((arg) => String(exprToJson(arg, diagnostics))).join(",")})`;
    case "type_apply":
      return `${expr.callee.name}<${expr.args.map((arg) => String(exprToJson(arg, diagnostics))).join(",")}>`;
    case "binding":
      return exprToJson(expr.type, diagnostics);
    case "decided_amount":
      return blockToObject(expr.body, new Map(), diagnostics);
    case "port_ref":
      return expr.name.name;
    case "apply":
      return `${expr.callee.parts.map((part) => part.name).join(".")}()`;
  }
}

function typeOf(
  expr: Expr,
  aliases: ReadonlyMap<string, Expr> = new Map(),
  seen: ReadonlySet<string> = new Set(),
): HsxType {
  if (expr.kind === "binding") return typeOf(expr.type, aliases, seen);
  if (expr.kind === "money") {
    return { currency: expr.currency.name, kind: "money" };
  }
  if (expr.kind === "type_apply" || expr.kind === "call") {
    const kind = expr.callee.name;
    const argument = expr.args[0];
    const name =
      argument?.kind === "ident"
        ? argument.name
        : argument?.kind === "string"
          ? argument.value
          : undefined;
    if (kind === "money") {
      const amount = expr.args[1];
      const fixedAmount =
        expr.args.length === 2 &&
        amount?.kind === "number" &&
        /^[1-9][0-9]{0,17}$/.test(amount.raw) &&
        Number.isSafeInteger(Number(amount.raw))
          ? amount.raw
          : undefined;
      return {
        ...(name ? { currency: name } : {}),
        ...(fixedAmount ? { fixedAmount } : {}),
        kind: "money",
      };
    }
    if (kind === "account")
      return { ...(name ? { currency: name } : {}), kind: "account" };
    if (kind === "ref" || kind === "id")
      return { kind: "ref", ...(name ? { target: name } : {}) };
  }
  if (expr.kind === "ident") {
    const alias = aliases.get(expr.name);
    if (alias && !seen.has(expr.name)) {
      return typeOf(alias, aliases, new Set([...seen, expr.name]));
    }
    if (CURRENCY.test(expr.name))
      return { currency: expr.name, kind: "unknown" };
    if (
      [
        "boolean",
        "account",
        "bps",
        "condition",
        "date",
        "integer",
        "party",
        "percent",
        "ref",
        "text",
      ].includes(expr.name)
    )
      return { kind: expr.name as HsxType["kind"] };
  }
  if (expr.kind === "percent") return { kind: "percent" };
  if (expr.kind === "boolean") return { kind: "boolean" };
  if (expr.kind === "number" && !expr.raw.includes("."))
    return { kind: "integer" };
  return { kind: "unknown" };
}

function schemaFor(
  type: HsxType,
  required: boolean,
): Record<string, JsonValue> {
  switch (type.kind) {
    case "money":
      return type.fixedAmount
        ? {
            const: type.fixedAmount,
            pattern: MONEY_PATTERN,
            type: "string",
          }
        : {
            pattern: required ? MONEY_PATTERN : OPTIONAL_MONEY_PATTERN,
            type: "string",
          };
    case "bps":
    case "percent":
      return { maximum: 10_000, minimum: 0, type: "integer" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { format: "hyperscale-date-time", type: "string" };
    case "ref":
      return { type: "string" };
    default:
      return { type: "string" };
  }
}

function invalidFixedMoneyBinding(expr: Expr): string | undefined {
  const candidate = twoArgumentMoneyCall(expr);
  if (!candidate) return undefined;
  const amount = candidate.args[1];
  if (
    candidate.args.length === 2 &&
    amount?.kind === "number" &&
    /^[1-9][0-9]{0,17}$/.test(amount.raw) &&
    Number.isSafeInteger(Number(amount.raw))
  ) {
    return undefined;
  }
  return "fixes money to an invalid amount; this UDL field slot accepts one fixed minor-unit integer";
}

function twoArgumentMoneyCall(
  expr: Expr,
): Extract<Expr, { readonly kind: "call" }> | undefined {
  const candidate = expr.kind === "binding" ? expr.type : expr;
  return candidate.kind === "call" &&
    candidate.callee.name === "money" &&
    candidate.args.length >= 2
    ? candidate
    : undefined;
}

function typeWords(type: HsxType): string {
  return type.currency ? `${type.kind}<${type.currency}>` : type.kind;
}

function camel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function prefixFor(value: string): string {
  const parts = value.split("_");
  return parts.length > 1
    ? parts
        .map((part) => part[0] ?? "")
        .join("")
        .slice(0, 8)
    : value.slice(0, 4);
}

function titleize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}
