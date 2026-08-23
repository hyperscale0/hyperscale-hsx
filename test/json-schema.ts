/**
 * A JSON Schema 2020-12 validator covering exactly the keywords
 * `spec/hsx-ir.schema.json` uses, and nothing else.
 *
 * Why hand-written: this package has zero runtime dependencies and keeps
 * them at zero, so pulling a validator in for one spec test would be the
 * most expensive line in the tree. The subset is small and closed. To keep
 * it honest, `unsupported keyword` throws instead of passing quietly, so a
 * keyword added to the schema without support here fails the spec test
 * rather than silently going unchecked.
 */

const SUPPORTED = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "propertyNames",
  "required",
  "title",
  "type",
]);

type Schema = Record<string, unknown>;

export interface ValidationError {
  readonly message: string;
  readonly path: string;
}

/** Every place `value` disagrees with `schema`. Empty means valid. */
export function validate(
  schema: Schema,
  value: unknown,
): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  check(schema, value, "", schema, errors);
  return errors;
}

function check(
  schema: Schema,
  value: unknown,
  path: string,
  root: Schema,
  errors: ValidationError[],
): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      throw new Error(`unsupported keyword "${keyword}" at ${path || "#"}`);
    }
  }

  const fail = (message: string): void => {
    errors.push({ message, path: path || "#" });
  };

  if (typeof schema.$ref === "string") {
    check(resolve(root, schema.$ref), value, path, root, errors);
    return;
  }

  if (schema.type !== undefined && !hasType(value, schema.type as string)) {
    fail(`expected ${schema.type as string}, got ${describe(value)}`);
    return;
  }
  if (schema.const !== undefined && !same(value, schema.const)) {
    fail(`expected ${JSON.stringify(schema.const)}, got ${describe(value)}`);
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((one) => same(value, one))
  ) {
    fail(
      `expected one of ${JSON.stringify(schema.enum)}, got ${describe(value)}`,
    );
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = (schema.oneOf as Schema[]).filter(
      (branch) => validateAgainst(branch, value, root).length === 0,
    );
    if (matched.length !== 1) {
      fail(`expected exactly one oneOf branch to match, ${matched.length} did`);
      return;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = (schema.anyOf as Schema[]).some(
      (branch) => validateAgainst(branch, value, root).length === 0,
    );
    if (!matched) {
      fail(`matched no anyOf branch (got ${describe(value)})`);
      return;
    }
  }

  if (typeof value === "string") {
    checkString(schema, value, fail);
    return;
  }
  if (typeof value === "number") {
    checkNumber(schema, value, fail);
    return;
  }
  if (Array.isArray(value)) {
    checkArray(schema, value, path, root, errors, fail);
    return;
  }
  if (isRecord(value)) {
    checkObject(schema, value, path, root, errors, fail);
  }
}

function checkString(
  schema: Schema,
  value: string,
  fail: (message: string) => void,
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    fail(`shorter than minLength ${schema.minLength}`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    fail(`longer than maxLength ${schema.maxLength} (${value.length})`);
  }
  if (
    typeof schema.pattern === "string" &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    fail(`does not match ${schema.pattern}: ${JSON.stringify(value)}`);
  }
}

function checkNumber(
  schema: Schema,
  value: number,
  fail: (message: string) => void,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    fail(`below minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    fail(`above maximum ${schema.maximum}`);
  }
}

function checkArray(
  schema: Schema,
  value: readonly unknown[],
  path: string,
  root: Schema,
  errors: ValidationError[],
  fail: (message: string) => void,
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    fail(`fewer than minItems ${schema.minItems}`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    fail(`more than maxItems ${schema.maxItems} (${value.length})`);
  }
  if (isRecord(schema.items)) {
    value.forEach((item, index) => {
      check(schema.items as Schema, item, `${path}[${index}]`, root, errors);
    });
  }
}

function checkObject(
  schema: Schema,
  value: Record<string, unknown>,
  path: string,
  root: Schema,
  errors: ValidationError[],
  fail: (message: string) => void,
): void {
  const keys = Object.keys(value);
  if (
    typeof schema.minProperties === "number" &&
    keys.length < schema.minProperties
  ) {
    fail(`fewer than minProperties ${schema.minProperties}`);
  }
  if (
    typeof schema.maxProperties === "number" &&
    keys.length > schema.maxProperties
  ) {
    fail(`more than maxProperties ${schema.maxProperties}`);
  }
  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (!(name in value)) fail(`missing required property "${name}"`);
  }

  const properties = (schema.properties as Record<string, Schema>) ?? {};
  for (const [name, child] of Object.entries(value)) {
    const childPath = `${path}.${name}`;
    if (isRecord(schema.propertyNames)) {
      check(
        schema.propertyNames as Schema,
        name,
        `${childPath} (key)`,
        root,
        errors,
      );
    }
    const property = properties[name];
    if (property) {
      check(property, child, childPath, root, errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push({
        message: `unexpected property "${name}"`,
        path: path || "#",
      });
      continue;
    }
    if (isRecord(schema.additionalProperties)) {
      check(
        schema.additionalProperties as Schema,
        child,
        childPath,
        root,
        errors,
      );
    }
  }
}

function validateAgainst(
  schema: Schema,
  value: unknown,
  root: Schema,
): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  check(schema, value, "", root, errors);
  return errors;
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref "${ref}"`);
  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) throw new Error(`unresolvable $ref "${ref}"`);
    current = current[segment];
  }
  if (!isRecord(current)) throw new Error(`unresolvable $ref "${ref}"`);
  return current;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      throw new Error(`unsupported type "${type}"`);
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const json = JSON.stringify(value);
  return json === undefined ? typeof value : json.slice(0, 60);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
