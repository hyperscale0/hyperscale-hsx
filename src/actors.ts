import type {
  AttachmentPartyBinding,
  UdlAction,
  UdlInstrument,
} from "@hyperscale0/udl";

/**
 * The actor rule. An action of a program instrument with party parameters that
 * names no actor gets one from its money and its record, never from words:
 *
 * 1. A follow action stays `caller`: the engine runs it for whoever changed
 *    the field it follows.
 * 2. An action no expose line names that another action invokes stays
 *    `caller`: it runs inside the chain whoever started it.
 * 3. An action with a `due` instant that no expose line names and that takes
 *    no subject or input is the clock's.
 * 4. An action whose money leaves a party's own account is that party's, due
 *    or not. Money going back to the same party spends nothing.
 * 5. A due step someone presses or records is the company's, never the party
 *    who missed the time.
 * 6. Create is the party bound to `actor`, since that role means whoever runs
 *    create, or else the party bound to `owner`, whose record it is.
 * 7. Anything else is the company's: its own payouts, every release of money
 *    the record holds, refunds to the payer included, and every step that
 *    moves no money.
 *
 * An explicit actor always wins.
 */
export type RuledActor =
  | { readonly actor: UdlAction["actor"] }
  | { readonly spenders: readonly string[] };

/** The company's own party in every program. */
const COMPANY = "programOperator";

/** Whose an account path is: a party's own account or a holding of the record. */
function accountOf(
  instrument: UdlInstrument,
  path: string,
): { party: string } | { holding: string } | undefined {
  if (path.startsWith("party.")) return { party: path.slice(6) };
  const name = /^self\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path)?.[1];
  const field = name
    ? instrument.fields.find((candidate) => candidate.name === name)
    : undefined;
  if (field?.type !== "account" || typeof field.owner !== "string")
    return undefined;
  return field.owner === "self" ? { holding: name! } : { party: field.owner };
}

/** The source and destination of a move, a posted reservation by its own. */
function endpoints(
  instrument: UdlInstrument,
  move: UdlAction["moves"][number],
): { from: string; to: string } | undefined {
  if ("from" in move) return { from: move.from, to: move.to };
  if (move.operation !== "internal_transfer.post") return undefined;
  for (const action of Object.values(instrument.actions))
    for (const reserve of action.moves)
      if (
        reserve.operation === "internal_transfer.reserve" &&
        `self.${reserve.capture}` === move.transfer
      )
        return { from: reserve.from, to: reserve.to };
  return undefined;
}

/** Who can reach an action besides the rule: an expose line or an invoke. */
export interface ActionReach {
  readonly exposed: boolean;
  readonly invoked: boolean;
}

/**
 * A due action the clock runs: no one presses it, nothing invokes it, and the
 * clock supplies no subject or input.
 */
export function clockRuled(action: UdlAction, reach: ActionReach): boolean {
  return (
    action.due !== undefined &&
    action.follows === undefined &&
    !reach.exposed &&
    !reach.invoked &&
    !action.input.length &&
    !action.subject?.requirements.length &&
    !action.subject?.adapters.length
  );
}

export function ruledActor(
  instrument: UdlInstrument,
  name: string,
  action: UdlAction,
  parties: Readonly<Record<string, AttachmentPartyBinding>> | undefined,
  reach: ActionReach,
): RuledActor {
  if (action.follows !== undefined) return { actor: "caller" };
  if (reach.invoked && !reach.exposed) return { actor: "caller" };
  if (clockRuled(action, reach)) return { actor: "clock" };
  const spenders = new Set<string>();
  for (const move of action.moves) {
    const ends = endpoints(instrument, move);
    if (!ends) continue;
    const source = accountOf(instrument, ends.from);
    if (!source || !("party" in source)) continue;
    const target = accountOf(instrument, ends.to);
    if (!(target && "party" in target && target.party === source.party))
      spenders.add(source.party);
  }
  if (spenders.size > 1) return { spenders: [...spenders].sort() };
  const [spender] = spenders;
  if (spender) return { actor: { party: spender } };
  if (action.due) return { actor: { party: COMPANY } };
  if (name === "create") {
    const roles = new Set(
      Object.values(parties ?? {}).flatMap((binding) =>
        "role" in binding ? [binding.role] : [],
      ),
    );
    if (roles.has("actor")) return { actor: { party: "actor" } };
    if (roles.has("owner")) return { actor: { party: "owner" } };
  }
  return { actor: { party: COMPANY } };
}
