import { resolveField, type UdlDocument } from "@hyperscale0/udl";
export interface UdlCostManifest {
  actions: Record<
    string,
    {
      transfers: number;
      accounts: number;
      invocations: number;
    }
  >;
}
/** Counts sealed instructions after lowering. Prices belong to the executor's tariff. */
export function buildUdlCostManifest(document: UdlDocument): UdlCostManifest {
  const actions: UdlCostManifest["actions"] = {};
  const active = new Set<string>();
  const visit = (
    id: string,
    name: string,
  ): UdlCostManifest["actions"][string] => {
    const key = `${id}.${name}`;
    if (actions[key]) return actions[key];
    if (active.has(key)) throw new Error(`Invocation cycle at ${key}`);
    const instrument = document.instruments.find((item) => item.id === id);
    const action = instrument?.actions[name];
    if (!instrument || !action) throw new Error(`Unknown invocation ${key}`);
    active.add(key);
    const cost = {
      transfers: action.moves.length,
      accounts:
        name === "create"
          ? instrument.fields.filter(
              (field) => field.type === "account" && field.owner === "self",
            ).length
          : 0,
      invocations: 0,
    };
    for (const call of action.invoke ?? []) {
      const ref =
        "reference" in call
          ? resolveField(document, instrument, call.reference, action.input)
          : undefined;
      const targets =
        "instrument" in call
          ? call.instrument
          : "selection" in call
            ? call.selection.instrument
            : ref?.type === "ref"
              ? ref.target
              : [];
      const children = (typeof targets === "string" ? [targets] : targets).map(
        (target) => visit(target, call.action),
      );
      const count =
        "selection" in call
          ? call.selection.limit
          : "instrument" in call
            ? (call.range?.maximum ?? 1)
            : 1;
      // A union selects one target per row. Each meter takes its worst case.
      cost.transfers +=
        count * Math.max(0, ...children.map((child) => child.transfers));
      cost.accounts +=
        count * Math.max(0, ...children.map((child) => child.accounts));
      cost.invocations +=
        count *
        (1 + Math.max(0, ...children.map((child) => child.invocations)));
    }
    active.delete(key);
    actions[key] = cost;
    return cost;
  };
  for (const instrument of document.instruments)
    for (const name of Object.keys(instrument.actions))
      visit(instrument.id, name);
  return { actions };
}
