import type { Diagnostic, Entry, Expr, InstrumentDecl } from "./ast.ts";
import { parseHeader } from "./header-source.ts";

/**
 * The binding rule. An attach block binds a customer party parameter to
 * `customer`, and the compiler places it on the record's `owner` or its
 * `actor` before the instrument lowers. An unbound parameter whose default is
 * `party(person)` is a customer too, unless a declared party or subject role
 * shares its name and binds it.
 *
 * 1. A customer the create of an entry action names binds `actor`: they start
 *    an agreement on a record they do not own. Any other customer of that
 *    attachment binds `owner`.
 * 2. Two customers in one attachment: the one its create names starts it and
 *    binds `actor`, else the only one whose account money leaves. The other
 *    owns the record. In escrow.hold the buyer starts and the seller owns the
 *    bike. When neither says, as in money.swap, a role written by hand stands,
 *    a `customer` beside it takes the other role, and two `customer` rows
 *    place the header's first party on `actor`.
 * 3. Any other customer binds by whose object it is. An object marked
 *    `belongs_to: company` is the company's, such as a fleet car or shop
 *    stock, so its customers bind `actor`. Any other object is its
 *    customer's, who binds `owner`. One parameter name on several
 *    attachments is that one customer. Two names some std template takes as
 *    two of its parties, such as a seller on a listing and a buyer on an
 *    order, never compile: the author lists the create the non-owner starts
 *    in `entryActions`, or marks the object `belongs_to: company`.
 *
 * In rules 1 and 2 an `owner` or `actor` written by hand must agree. A lone one
 * written by hand stays as written.
 */
export const customerBinding = "customer";

type Role = "owner" | "actor";

export interface CustomerSite {
  name: string;
  entry: Entry;
  template: InstrumentDecl;
  /** The attach block's tunable rows. */
  rows: Entry[];
  /** Header action name to public name. */
  exposed: ReadonlyMap<string, string>;
}

const typeOf = (parameter: Entry) =>
  parameter.value.kind === "default" ? parameter.value.type : parameter.value;

function isPartyParameter(parameter: Entry) {
  const type = typeOf(parameter);
  return type.kind === "name"
    ? type.value === "party"
    : (type.kind === "type" || type.kind === "call") && type.name === "party";
}

const optional = (parameter: Entry) => {
  const type = typeOf(parameter);
  return (type.kind === "type" || type.kind === "call") && !!type.optional;
};

const personDefault = (parameter: Entry) =>
  parameter.value.kind === "default" &&
  parameter.value.value.kind === "call" &&
  parameter.value.value.name === "party" &&
  parameter.value.value.args.length === 1 &&
  parameter.value.value.args[0]!.kind === "name" &&
  parameter.value.value.args[0]!.value === "person";

const named = (expr: Expr | undefined) =>
  expr?.kind === "name" ? expr.value : undefined;

const row = (block: Expr | undefined, key: string) =>
  block?.kind === "block"
    ? block.entries.find((entry) => entry.key === key)?.value
    : undefined;

/** The party parameter the header's create names as its actor. */
function creator(template: InstrumentDecl) {
  const create = template.body.entries.find(
    (entry) => entry.key === "action create",
  )?.value;
  return named(row(row(create, "actor"), "party"));
}

/** Party parameters whose own account some move takes money out of, in the
 * instrument's actions or its records' actions (`from self.payer` there). */
function payers(template: InstrumentDecl, keys: ReadonlySet<string>) {
  const found = new Set<string>();
  const walk = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "list") expr.items.forEach(walk);
    if (expr.kind !== "block") return;
    for (const entry of expr.entries) {
      if (entry.key === "moves") {
        const items =
          entry.value.kind === "list" ? entry.value.items : [entry.value];
        for (const item of items) {
          const from = named(row(item, "from"))?.replace(/^self\./, "");
          if (from && keys.has(from)) found.add(from);
        }
      } else walk(entry.value);
    }
  };
  const actions = (entries: readonly Entry[]) => {
    for (const entry of entries)
      if (entry.key.startsWith("action ")) walk(entry.value);
      else if (entry.key === "records" && entry.value.kind === "block")
        for (const record of entry.value.entries)
          if (record.value.kind === "block") actions(record.value.entries);
  };
  actions(template.body.entries);
  return found;
}

const sidesCache = new WeakMap<ReadonlyMap<string, string>, Set<string>>();

/** Pairs of party names some std template takes as two of its parties, as
 * escrow.hold's payer and payee or marketplace.reservation's buyer and seller,
 * written `a b` in both orders. */
function catalogSides(std: ReadonlyMap<string, string>) {
  let sides = sidesCache.get(std);
  if (sides) return sides;
  sides = new Set();
  for (const [name, source] of std)
    for (const decl of parseHeader(source, name).decls) {
      if (decl.kind !== "instrument") continue;
      const keys = decl.parameters.filter(isPartyParameter).map((p) => p.key);
      for (const left of keys)
        for (const right of keys)
          if (left !== right) sides.add(`${left} ${right}`);
    }
  sidesCache.set(std, sides);
  return sides;
}

interface Customer {
  key: string;
  row: Entry | undefined;
  written: Role | undefined;
  expected: Role | undefined;
  reason: string;
}

/**
 * Places every `customer` binding and checks hand-written `owner` and `actor`
 * against the rule. Returns the rows to compile each attach with.
 */
export function placeCustomers(
  sites: readonly CustomerSite[],
  entryActions: ReadonlySet<string>,
  company: boolean,
  /** The object's name, for the sibling-customer refusal. */
  object: string,
  /** The std headers, whose templates say which names are two sides. */
  std: ReadonlyMap<string, string>,
  /** A key an unbound parameter binds by name, a declared party or a subject role. */
  byName: (key: string) => boolean,
): { rows: Map<CustomerSite, Entry[]>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const placed = new Map<CustomerSite, Customer[]>();
  for (const site of sites) {
    const parameters = site.template.parameters.filter(isPartyParameter);
    const customers: Customer[] = [];
    for (const parameter of parameters) {
      const written = site.rows.find((item) => item.key === parameter.key);
      const value = named(written?.value);
      if (
        value === customerBinding ||
        value === "owner" ||
        value === "actor" ||
        (!written &&
          personDefault(parameter) &&
          !optional(parameter) &&
          !byName(parameter.key))
      )
        customers.push({
          key: parameter.key,
          row: written,
          written: value === "owner" || value === "actor" ? value : undefined,
          expected: undefined,
          reason: "",
        });
    }
    if (customers.length > 2) {
      diagnostics.push({
        code: "customer_binding_rule",
        message: `${site.name} binds ${customers.length} customers: ${customers.map((item) => item.key).join(", ")}. An agreement has two customer sides, the record's owner and the customer who starts it.`,
        fix: "Bind a declared business or operator for every other party.",
        span: site.entry.span,
      });
      continue;
    }
    const starts = creator(site.template);
    const create = site.exposed.get("create");
    const entry = create !== undefined && entryActions.has(create);
    const keys = new Set(customers.map((item) => item.key));
    const paying = [...payers(site.template, keys)];
    const starter =
      starts && keys.has(starts)
        ? starts
        : customers.length === 2 && paying.length === 1
          ? paying[0]
          : undefined;
    for (const customer of customers) {
      if (entry) {
        customer.expected = customer.key === starts ? "actor" : "owner";
        customer.reason =
          customer.key === starts
            ? `Entry action ${create} lets ${customer.key} start ${site.name} on a record they do not own`
            : `Entry action ${create} starts ${site.name} for ${starts ?? "another customer"}`;
      } else if (customers.length === 2) {
        if (!starter) {
          const other = customers.find((item) => item !== customer)!;
          if (!customer.written)
            customer.expected = other.written
              ? other.written === "actor"
                ? "owner"
                : "actor"
              : customer === customers[0]
                ? "actor"
                : "owner";
          continue;
        }
        customer.expected = customer.key === starter ? "actor" : "owner";
        customer.reason =
          starter === starts
            ? `In ${site.name}, create runs for ${starter}`
            : `In ${site.name}, ${starter} is the customer who pays in`;
      }
    }
    placed.set(site, customers);
  }
  // Whose object it is (rule 3). A lone owner or actor written by hand stays
  // as written, so only `customer` is placed.
  const owners = new Map<string, CustomerSite>();
  for (const [site, customers] of placed)
    if (
      customers.length === 1 &&
      !customers[0]!.expected &&
      !customers[0]!.written
    ) {
      customers[0]!.expected = company ? "actor" : "owner";
      if (!company && !owners.has(customers[0]!.key))
        owners.set(customers[0]!.key, site);
    }
  // One name on several attachments is one person. Two names that some std
  // template takes as two of its parties, such as a seller on a listing and a
  // buyer on an order, are the two sides of a deal. Both would bind owner, so
  // the compiler refuses to pick a side.
  const sides = catalogSides(std);
  const names = [...owners.keys()];
  const second = names.find((name, index) =>
    names.slice(0, index).some((first) => sides.has(`${first} ${name}`)),
  );
  if (second) {
    const first = names.find((name) => sides.has(`${name} ${second}`))!;
    const [a, b] = [first, second].map((key) => ({
      key,
      site: owners.get(key)!,
    })) as [
      { key: string; site: CustomerSite },
      { key: string; site: CustomerSite },
    ];
    const creates = [a.site, b.site].flatMap((site) => {
      const create = site.exposed.get("create");
      return create ? [create] : [];
    });
    diagnostics.push({
      code: "customer_binding_rule",
      message: `${object}: ${a.key} on ${a.site.name} and ${b.key} on ${b.site.name} are customers no rule places, so both would bind owner and one person would take both sides of the money.`,
      fix: `List in entryActions the create of the attachment the non-owner starts${creates.length ? ` (${creates.join(" or ")})` : ", exposing it first"}, so that customer binds actor. If the company owns ${object}, mark it \`belongs_to: company\` instead.`,
      span: b.site.entry.span,
    });
  }
  const rows = new Map<CustomerSite, Entry[]>();
  for (const [site, customers] of placed) {
    const out = [...site.rows];
    for (const customer of customers) {
      const span = customer.row?.value.span ?? site.entry.span;
      if (customer.written) {
        if (!customer.expected || customer.written === customer.expected)
          continue;
        diagnostics.push({
          code: "customer_binding_rule",
          message: `${site.name}: \`${customer.key}: ${customer.written}\` breaks the binding rule. ${customer.reason}, so ${customer.key} ${customer.expected === "actor" ? "starts it and binds actor" : "owns the record and binds owner"}.`,
          fix: `Write \`${customer.key}: customer\`; the compiler places it on ${customer.expected}.`,
          span,
        });
        continue;
      }
      if (!customer.expected) continue;
      const value: Expr = {
        kind: "name",
        value: customer.expected,
        span,
      };
      if (customer.row) {
        out[out.indexOf(customer.row)] = { ...customer.row, value };
      } else out.push({ key: customer.key, value, span });
    }
    rows.set(site, out);
  }
  return { rows, diagnostics };
}
