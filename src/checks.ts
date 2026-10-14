import type { UdlDocument } from "@hyperscale0/udl";
import type { BlockExpr, CheckDecl, Expr, Named } from "./ast.ts";
import { didYouMean, fail } from "./diagnostics.ts";

type Balances = Record<string, string>;
type Values = Record<string, unknown>;
type Expected = { expected?: Balances };
export type CompiledCheckStep = Expected &
  (
    | {
        kind: "clock";
        at: string;
        waitFor?: {
          object: string;
          state: string;
          attachment?: string;
          recordPath?: string;
        };
      }
    | {
        kind: "object";
        id: string;
        objectKind: string;
        owner: string;
        fields?: Values;
      }
    | {
        kind: "action";
        object: string;
        action: string;
        actor?: string;
        input?: Values;
        fields?: Values;
        state?: string;
        status?: number | "absent";
        code?: string;
        remember?: string;
        instance?: string;
      }
    | { kind: "close"; customer: string }
  );
/** A check as the Build carries it; `buildCheckSchema` in contracts parses it. */
export interface CompiledCheck {
  name: string;
  customers: {
    id: string;
    name: string;
    kind?: "organization";
    fund?: string;
  }[];
  bindings?: Record<string, string>;
  steps: CompiledCheckStep[];
  expected: Balances;
  expectedHeld?: string;
  pending?: Record<string, Balances>;
}

// Statement keywords cannot name a customer, since a step opens with its actor.
const reserved = new Set(["customer", "clock", "object", "close", "expect"]);
/** The Product pool's balance name. */
const operator = "operator";

/**
 * Lowers every check against the compiled document. A name the document does
 * not declare fails at the step that wrote it.
 */
export function lowerChecks(
  checks: readonly CheckDecl[],
  document: UdlDocument,
  literal: (expr: Expr) => string | number | boolean,
): CompiledCheck[] {
  const seen = new Set<string>();
  return checks.map((check) => {
    if (seen.has(check.name))
      fail(check, `check "${check.name}" is declared twice`, "rename one");
    seen.add(check.name);
    return lowerCheck(check, document, literal);
  });
}

function lowerCheck(
  check: CheckDecl,
  document: UdlDocument,
  literal: (expr: Expr) => string | number | boolean,
): CompiledCheck {
  const customers: CompiledCheck["customers"] = [];
  const bindings: Record<string, string> = {};
  const steps: CompiledCheckStep[] = [];
  const objects = new Map<string, string>();
  const remembered = new Set<string>();
  let final: Pick<CompiledCheck, "expected" | "expectedHeld" | "pending"> =
    undefined!;
  const known = (
    named: Named,
    names: Iterable<string>,
    what: string,
    fix: string,
  ) => {
    const list = [...names];
    if (!list.includes(named.name))
      fail(
        named,
        `${what} ${named.name} is not declared.${didYouMean(named.name, list)}`,
        fix,
      );
    return named.name;
  };
  const customer = (named: Named) =>
    known(
      named,
      customers.map((c) => c.id),
      "customer",
      `declare customer ${named.name} "Name" before this step`,
    );
  const money = (expr: Expr) => {
    if (expr.kind !== "money")
      fail(expr, "expected an amount", "write an amount such as 100 SAR");
    return literal(expr) as string;
  };
  const balanceNames = () => [operator, ...customers.map((c) => c.id)];
  const balanceFix = `name a customer or ${operator}`;
  const balances = (block: BlockExpr) =>
    Object.fromEntries(
      block.entries.map((entry) => [
        known(
          { name: entry.key, span: entry.span },
          balanceNames(),
          "balance",
          balanceFix,
        ),
        money(entry.value),
      ]),
    );
  const value = (expr: Expr): unknown => {
    if (expr.kind === "list") return expr.items.map(value);
    if (expr.kind === "block")
      return Object.fromEntries(
        expr.entries.map((entry) => [entry.key, value(entry.value)]),
      );
    if (expr.kind === "call" && ["agreement", "object"].includes(expr.name)) {
      const [arg] = expr.args;
      if (expr.args.length !== 1 || arg?.kind !== "name")
        fail(expr, `${expr.name} takes one name`, `write ${expr.name}(name)`);
      const name = { name: arg.value, span: arg.span };
      if (expr.name === "agreement")
        known(name, remembered, "agreement", "remember it on an earlier step");
      else
        known(name, objects.keys(), "object", "create it on an earlier step");
      return `$${expr.name}:${arg.value}`;
    }
    return literal(expr);
  };
  const values = (block: BlockExpr) => value(block) as Values;
  const instruments = (object: string) => {
    const declared = document.objects.find((o) => o.id === object)!;
    const ids = new Set(declared.attachments.map((a) => a.instrument));
    return document.instruments.filter((i) => ids.has(i.id));
  };
  for (const statement of check.statements) {
    if (final)
      fail(statement, "expect closes a check", "move this step before expect");
    const expected = statement.balances
      ? { expected: balances(statement.balances) }
      : {};
    switch (statement.kind) {
      case "customer": {
        const { id } = statement;
        if (reserved.has(id.name) || id.name === operator)
          fail(id, `${id.name} cannot name a customer`, "pick another name");
        if (customers.some((c) => c.id === id.name))
          fail(id, `customer ${id.name} is declared twice`, "rename one");
        if (steps.length)
          fail(statement, "customers come before steps", "move it up");
        customers.push({
          id: id.name,
          name: statement.title,
          ...(statement.organization ? { kind: "organization" as const } : {}),
          ...(statement.fund ? { fund: money(statement.fund) } : {}),
        });
        for (const party of statement.binds) {
          const declared = Object.keys(document.parties);
          known(party, declared, "party", "bind a party the program declares");
          if (party.name in bindings)
            fail(party, `party ${party.name} is bound twice`, "bind it once");
          bindings[party.name] = id.name;
        }
        break;
      }
      case "clock": {
        const at = statement.at;
        if (at.kind !== "date")
          fail(at, "a clock step needs a date", "write clock 2031-04-01");
        const until = statement.until;
        let waitFor: Extract<CompiledCheckStep, { kind: "clock" }>["waitFor"];
        if (until) {
          const object = known(
            until.object,
            objects.keys(),
            "object",
            "create it on an earlier step",
          );
          const kind = objects.get(object)!;
          const declared = document.objects.find((o) => o.id === kind)!;
          if (until.attachment)
            known(
              until.attachment,
              declared.attachments.map((a) => a.name),
              `${kind} attachment`,
              `name an attachment of object ${kind}`,
            );
          known(
            until.state,
            instruments(kind).flatMap((i) => i.lifecycle.states),
            "state",
            `name a lifecycle state on object ${kind}`,
          );
          waitFor = {
            object,
            ...(until.recordPath ? { recordPath: until.recordPath } : {}),
            state: until.state.name,
            ...(until.attachment ? { attachment: until.attachment.name } : {}),
          };
        }
        steps.push({
          kind: "clock",
          at: literal(at) as string,
          ...(waitFor ? { waitFor } : {}),
          ...expected,
        });
        break;
      }
      case "object": {
        const { id } = statement;
        if (objects.has(id.name))
          fail(id, `object ${id.name} is created twice`, "rename one");
        const kind = known(
          statement.objectKind,
          document.objects.map((o) => o.id),
          "object kind",
          "name an object the program declares",
        );
        const owner = customer(statement.owner);
        const fieldNames = document.objects
          .find((o) => o.id === kind)!
          .fields.map((f) => f.name);
        for (const entry of statement.fields?.entries ?? [])
          known(
            { name: entry.key, span: entry.span },
            fieldNames,
            `${kind} field`,
            `name a field of object ${kind}`,
          );
        objects.set(id.name, kind);
        steps.push({
          kind: "object",
          id: id.name,
          objectKind: kind,
          owner,
          ...(statement.fields ? { fields: values(statement.fields) } : {}),
          ...expected,
        });
        break;
      }
      case "action": {
        const object = known(
          statement.object,
          objects.keys(),
          "object",
          "create it on an earlier step",
        );
        const kind = objects.get(object)!;
        const exposing = instruments(kind).filter((i) =>
          Object.values(i.actions).some(
            (a) => a.publicAction === statement.action.name,
          ),
        );
        known(
          statement.action,
          exposing.length
            ? [statement.action.name]
            : instruments(kind).flatMap((i) =>
                Object.values(i.actions).flatMap((a) =>
                  a.publicAction ? [a.publicAction] : [],
                ),
              ),
          `${kind} action`,
          `name an action object ${kind} exposes`,
        );
        const actor = statement.actor && customer(statement.actor);
        if (statement.state)
          known(
            statement.state,
            exposing.flatMap((i) => i.lifecycle.states),
            "state",
            `name a state ${statement.action.name} can reach`,
          );
        let status: number | "absent" | undefined;
        if (statement.status) {
          const raw = statement.status;
          status =
            raw.kind === "name" && raw.value === "absent"
              ? "absent"
              : raw.kind === "number" && /^[45]\d\d$/.test(raw.value)
                ? Number(raw.value)
                : fail(raw, "expected a refusal", "write status 409 or absent");
        }
        const instance =
          statement.instance &&
          known(
            statement.instance,
            remembered,
            "agreement",
            "remember it on an earlier step",
          );
        const input = statement.input && values(statement.input);
        const fields = statement.fields && values(statement.fields);
        if (statement.remember) {
          if (remembered.has(statement.remember.name))
            fail(statement.remember, "remembered twice", "rename one");
          remembered.add(statement.remember.name);
        }
        steps.push({
          kind: "action",
          object,
          action: statement.action.name,
          ...(actor ? { actor } : {}),
          ...(input ? { input } : {}),
          ...(fields ? { fields } : {}),
          ...(statement.state ? { state: statement.state.name } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(statement.code ? { code: statement.code } : {}),
          ...(statement.remember ? { remember: statement.remember.name } : {}),
          ...(instance ? { instance } : {}),
          ...expected,
        });
        break;
      }
      case "close":
        steps.push({
          kind: "close",
          customer: customer(statement.customer),
          ...expected,
        });
        break;
      case "expect": {
        if (!steps.length)
          fail(statement, "a check needs a step", "add a step before expect");
        if (!statement.balances)
          fail(statement, "expect needs balances", "write expect balances { }");
        final = {
          expected: balances(statement.balances),
          ...(statement.held ? { expectedHeld: money(statement.held) } : {}),
          ...(statement.pending
            ? {
                pending: Object.fromEntries(
                  statement.pending.entries.map((entry) => {
                    const name = { name: entry.key, span: entry.span };
                    if (entry.value.kind !== "block")
                      fail(entry, "expected balances", "write name { }");
                    const fields = entry.value.entries.map((field) => [
                      field.key,
                      money(field.value),
                    ]);
                    return [
                      known(name, balanceNames(), "balance", balanceFix),
                      Object.fromEntries(fields),
                    ];
                  }),
                ),
              }
            : {}),
        };
        break;
      }
    }
  }
  if (!final)
    fail(check, "a check ends with expect", "write expect balances { }");
  return {
    name: check.name,
    customers,
    ...(Object.keys(bindings).length ? { bindings } : {}),
    steps,
    ...final,
  };
}
