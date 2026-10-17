import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const stdRoot = join(packageRoot, "std");

/** The std headers by name and the package version, for the default toolchain. */
export function generateStdBundleCode(): string {
  const { version } = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  const headers = readdirSync(stdRoot)
    .filter((name) => name.endsWith(".hsx"))
    .sort()
    .map(
      (name) =>
        `  [${JSON.stringify(name.slice(0, -4))}, ${JSON.stringify(readFileSync(join(stdRoot, name), "utf8"))}],`,
    );
  return [
    "",
    `export const HSX_VERSION = ${JSON.stringify(version)};`,
    "",
    "export const BUNDLED_STD_HEADERS: ReadonlyMap<string, string> = new Map<string, string>([",
    ...headers,
    "]);",
    "",
  ].join("\n");
}
