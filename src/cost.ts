import type { UdlDocument } from "@hyperscale0/udl";
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
  for (const instrument of document.instruments)
    for (const [name, action] of Object.entries(instrument.actions)) {
      actions[`${instrument.id}.${name}`] = {
        transfers: action.moves.length,
        accounts:
          name === "create"
            ? instrument.fields.filter(
                (f) => f.type === "account" && f.owner === "self",
              ).length
            : 0,
        invocations: (action.invoke ?? []).reduce(
          (sum, call) => sum + ("selection" in call ? call.selection.limit : 1),
          0,
        ),
      };
    }
  return { actions };
}
