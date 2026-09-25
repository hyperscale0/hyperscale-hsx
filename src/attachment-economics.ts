import {
  subjectPartyRoles,
  udlMoveSchema,
  type AttachmentPartyBinding,
  type SubjectPartyRole,
  type UdlDocument,
  type UdlInstrument,
} from "@hyperscale0/udl";
import type { Entry, Expr } from "./ast.ts";
import { fail } from "./diagnostics.ts";

/** An attachment specializes its own instrument; imported definitions stay generic. */
export function applyAttachmentEconomics(
  document: UdlDocument,
  instrument: UdlInstrument,
  parties: Record<string, AttachmentPartyBinding>,
  declarations: Entry[],
  data: (expression: Expr) => unknown,
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
        `choose ${instrument.actionOrder.join(", ")}, before its public alias`,
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
