import {
  subjectPartyRoles,
  udlMoveSchema,
  type AttachmentPartyBinding,
  type SubjectPartyRole,
  type UdlDocument,
  type UdlInstrument,
} from "@hyperscale0/udl";
import type { Diagnostic, Entry, Expr, InstrumentDecl } from "./ast.ts";
import { fail } from "./diagnostics.ts";

/** An attachment specializes its own instrument; imported definitions stay generic. */
export function applyAttachmentEconomics(
  document: UdlDocument,
  instrument: UdlInstrument,
  parties: Record<string, AttachmentPartyBinding>,
  declarations: Entry[],
  data: (expression: Expr) => unknown,
  records: readonly string[] = [],
): void {
  const selected = new Set<object>();
  for (const declaration of declarations) {
    const selector = declaration.key.slice("economics ".length);
    const [actionName, moveKey, extra] = selector.split(".");
    const action = Object.hasOwn(instrument.actions, actionName!)
      ? instrument.actions[actionName!]
      : undefined;
    if (!action)
      fail(
        declaration,
        `unknown economics action ${actionName}`,
        `choose ${instrument.actionOrder.join(", ")}, before its public alias${records.length ? `, or record.action for a record (${records.join(", ")})` : ""}`,
      );
    const move = moveKey
      ? action.moves.find((move) => move.key === moveKey)
      : action.moves.length === 1
        ? action.moves[0]
        : undefined;
    if (!move || extra)
      fail(
        declaration,
        `economics ${selector} must select one money move`,
        action.moves.length
          ? `choose ${action.moves.map((move) => `${actionName}.${move.key}`).join(", ")}`
          : "choose an action that transfers or reserves money",
      );
    if (move.operation === "internal_transfer.void")
      fail(
        declaration,
        `economics ${selector} cannot classify a void`,
        "declare the purpose on the reservation or its posting",
      );
    if (selected.has(move))
      fail(
        declaration,
        `repeated economics for ${selector}`,
        "declare each money move's purpose once",
      );
    selected.add(move);
    const parsed = udlMoveSchema.safeParse({
      ...move,
      economics: data(declaration.value),
    });
    if (!parsed.success || !parsed.data.economics)
      fail(
        declaration,
        `invalid economics for ${selector}`,
        "declare purpose and sourceParty using the move economics fields",
      );
    const economics = parsed.data.economics;
    if (
      move.economics &&
      (move.economics.purpose !== economics.purpose ||
        move.economics.sourceParty !== economics.sourceParty ||
        move.economics.reversalOf !== economics.reversalOf)
    )
      fail(
        declaration,
        `economics ${selector} conflicts with the instrument's declared purpose`,
        "keep the instrument's economics or choose an unclassified move",
      );
    const source = economics.sourceParty;
    const role = subjectPartyRoles.includes(source as SubjectPartyRole);
    if (!role && document.parties[source]?.kind !== "business")
      fail(
        declaration,
        `unknown economic source party ${source}`,
        "bind sourceParty to owner, actor, operator or a declared business",
      );
    if (
      !Object.values(parties).some((binding) =>
        "role" in binding ? binding.role === source : binding.party === source,
      )
    ) {
      let key = "economicSource";
      for (let index = 2; Object.hasOwn(parties, key); index++)
        key = `economicSource${index}`;
      parties[key] = role
        ? { role: source as SubjectPartyRole }
        : { party: source };
    }
    move.economics = economics;
  }
}

/**
 * A money move an attachment leaves without a purpose books as neither
 * revenue nor a payout. The warning names the economics line to add; its
 * purpose follows the bound parties: earning into the operator, a payout out
 * of it, money passing through otherwise.
 */
export function purposeWarnings(
  document: UdlDocument,
  selectors: ReadonlyMap<string, { prefix: string; root: string }>,
  attaches: ReadonlyMap<
    string,
    { entry: Entry; name: string; template: InstrumentDecl }
  >,
): Diagnostic[] {
  const warnings: Diagnostic[] = [];
  const bindings = new Map(
    document.objects.flatMap((object) =>
      object.attachments.map((item) => [item.instrument, item.parties]),
    ),
  );
  const party = (path: string | undefined) =>
    /^party\.(\w+)$/.exec(path ?? "")?.[1];
  const operator = (name: string | undefined) =>
    name === "operator" || name === "programOperator";
  for (const instrument of document.instruments) {
    const selector = selectors.get(instrument.id);
    const attach = selector && attaches.get(selector.root);
    if (!selector || !attach) continue;
    const parties = bindings.get(instrument.id) ?? {};
    const parameters = attach.template.parameters
      .filter((row) => row.value.kind === "name" && row.value.value === "party")
      .map((row) => row.key);
    // The template's own parameter reads back in the founder's terms.
    const parameter = (name: string) =>
      parameters.find((key) => {
        const binding = parties[key];
        return (
          binding && ("role" in binding ? binding.role : binding.party) === name
        );
      }) ?? name;
    for (const actionName of instrument.actionOrder) {
      const action = instrument.actions[actionName]!;
      for (const move of action.moves) {
        if (
          move.economics ||
          (move.operation !== "internal_transfer.create" &&
            move.operation !== "internal_transfer.reserve")
        )
          continue;
        const path = `${selector.prefix}${actionName}${action.moves.length > 1 ? `.${move.key}` : ""}`;
        const from = party(move.from);
        const to = party(move.to);
        const purpose = operator(to)
          ? "earning"
          : operator(from)
            ? "participant_payout"
            : "pass_through";
        const source = from ? parameter(from) : (parameters[0] ?? "owner");
        warnings.push({
          code: "economic_purpose_missing",
          message: `${attach.name}: ${path} moves money with no declared purpose, so the books will not count it as revenue or a payout`,
          fix: `add economics ${path} { purpose: ${purpose}, sourceParty: ${source} } inside attach ${attach.name}`,
          // Underline `attach <name>`, the line the declaration goes under.
          span: {
            start: attach.entry.span.start,
            end: attach.entry.span.start + `attach ${attach.name}`.length,
          },
        });
      }
    }
  }
  return warnings;
}

/**
 * A move whose payer and payee resolve to one party pays nobody. `actor` is
 * whoever runs the attachment's create, so a create bound to a party pins it:
 * in money.schedule the payee runs create, and `payer: actor` is the payee.
 * Without a pinned create, `actor` against `operator` is the company paying
 * itself whenever the company runs create; that is only known at run time.
 */
export function samePartyMoves(
  document: UdlDocument,
  selectors: ReadonlyMap<string, { prefix: string; root: string }>,
  attaches: ReadonlyMap<
    string,
    { entry: Entry; name: string; template: InstrumentDecl }
  >,
): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const bindings = new Map(
    document.objects.flatMap((object) =>
      object.attachments.map((item) => [item.instrument, item.parties]),
    ),
  );
  const party = (path: string | undefined) =>
    /^party\.(\w+)$/.exec(path ?? "")?.[1];
  const normal = (name: string) =>
    name === "programOperator" ||
    document.parties[name]?.role === "program_operator"
      ? "operator"
      : name;
  const seen = new Set<string>();
  for (const instrument of document.instruments) {
    const selector = selectors.get(instrument.id);
    const attach = selector && attaches.get(selector.root);
    if (!selector || !attach) continue;
    const parties = bindings.get(selector.root) ?? {};
    // The template's own parameter, as the founder bound it.
    const parameter = (name: string) =>
      Object.entries(parties).find(([, binding]) =>
        [name, normal(name)].includes(
          normal("role" in binding ? binding.role : binding.party),
        ),
      )?.[0];
    const spell = (name: string) => {
      const key = parameter(name);
      return key && key !== name ? `${key}: ${name}` : name;
    };
    const creator = document.instruments.find(
      (item) => item.id === selector.root,
    )?.actions.create?.actor;
    const pinned =
      typeof creator === "object" && "party" in creator
        ? normal(creator.party)
        : undefined;
    const runsCreate = pinned && pinned !== "actor" ? pinned : undefined;
    for (const actionName of instrument.actionOrder) {
      for (const move of instrument.actions[actionName]!.moves) {
        const from = "from" in move ? party(move.from) : undefined;
        const to = "to" in move ? party(move.to) : undefined;
        if (!from || !to) continue;
        const payer = normal(from);
        const payee = normal(to);
        const resolve = (name: string) =>
          name === "actor" && runsCreate ? runsCreate : name;
        const key = `${attach.name}:${payer}:${payee}`;
        if (seen.has(key)) continue;
        const path = `${selector.prefix}${actionName}`;
        const span = {
          start: attach.entry.span.start,
          end: attach.entry.span.start + `attach ${attach.name}`.length,
        };
        if (resolve(payer) === resolve(payee)) {
          seen.add(key);
          const via =
            payer !== payee
              ? ` ${parameter(runsCreate!) ?? runsCreate} runs create, so actor is ${runsCreate}.`
              : "";
          errors.push({
            code: "same_party_move",
            message: `${attach.name}: ${path} moves money from ${spell(from)} to ${spell(to)}, and both are ${resolve(payer)}.${via} A party cannot pay itself.`,
            fix: `Bind the paying and receiving parties to different roles, such as ${parameter(from) ?? "payer"}: owner and ${parameter(to) ?? "payee"}: operator for a customer paying the company.`,
            span,
          });
        } else if (
          // A template's own programOperator leg, such as a fee, is the
          // template's design; warn on the founder's operator binding.
          !runsCreate &&
          [from, to].includes("actor") &&
          [from, to].includes("operator")
        ) {
          seen.add(key);
          warnings.push({
            code: "same_party_move",
            message: `${attach.name}: ${path} moves money from ${spell(from)} to ${spell(to)}. When the company runs create itself, actor is the company and it pays itself.`,
            fix: `Run create on behalf of a customer, or bind ${parameter("actor") ?? "the paying party"}: owner if the record's owner pays.`,
            span,
          });
        }
      }
    }
  }
  return { errors, warnings };
}
