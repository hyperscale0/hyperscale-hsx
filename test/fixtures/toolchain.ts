import {
  defaultToolchain,
  toolchain,
  type AdapterBindingTarget,
  type Toolchain,
} from "../../src/toolchain.ts";

/**
 * The default toolchain with test headers and adapters added. A header string
 * is keyed by its `header NAME` line; a `[name, source]` pair names it.
 */
export function testToolchain(
  headers: readonly (string | readonly [string, string])[] = [],
  adapters: Readonly<Record<string, AdapterBindingTarget>> = {},
): Toolchain {
  const std = new Map(defaultToolchain.std);
  for (const header of headers) {
    if (typeof header !== "string") {
      std.set(header[0], header[1]);
      continue;
    }
    const name = /^\s*header\s+([a-z][a-z0-9_]*)/m.exec(header)?.[1];
    if (!name) throw new Error("A test header needs a header line");
    std.set(name, header);
  }
  return toolchain({
    ...defaultToolchain,
    std,
    adapters: { ...defaultToolchain.adapters, ...adapters },
  });
}
