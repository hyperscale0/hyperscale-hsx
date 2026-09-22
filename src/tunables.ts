import { fail } from "./diagnostics.ts";
import type { Expr } from "./ast.ts";

/** Bounds use UDL units: minor units, basis points and milliseconds. */
export function tunableBounds(
  type: Expr,
): { minimum: number | string; maximum: number | string } | undefined {
  const name =
    type.kind === "call" || type.kind === "type"
      ? type.name
      : type.kind === "name"
        ? type.value
        : "";
  if (name === "money") return { minimum: "0", maximum: "999999999999999999" };
  if (name === "percent") return { minimum: 0, maximum: 10000 };
  if (name === "duration")
    return { minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
  if (name !== "integer") return;
  if (type.kind === "call") {
    const numbers = type.args.map((arg) =>
      arg.kind === "number" ? Number(arg.value) : NaN,
    );
    if (
      numbers.length !== 2 ||
      numbers.some((value) => !Number.isSafeInteger(value)) ||
      numbers[0]! > numbers[1]!
    )
      fail(
        type,
        "integer tunable needs ordered safe integer bounds",
        "write integer(1, 12)",
      );
    return { minimum: numbers[0]!, maximum: numbers[1]! };
  }
  return { minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
}
