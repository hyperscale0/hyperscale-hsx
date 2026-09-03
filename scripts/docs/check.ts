import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildDocs } from "./build.ts";

const packageRoot = join(import.meta.dir, "../..");
export function orphanedStdPages(
  outputs: readonly string[],
  root = packageRoot,
): readonly string[] {
  const expected = new Set(
    outputs
      .filter((path) => path.startsWith("docs/reference/std/"))
      .map((path) => basename(path)),
  );
  return readdirSync(join(root, "docs", "reference", "std"))
    .filter((file) => file.endsWith(".md") && !expected.has(file))
    .sort();
}

if (import.meta.main) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "hsx-docs-"));
  try {
    const outputs = buildDocs(temporaryRoot);
    const stale = outputs.filter(
      (path) =>
        readFileSync(join(packageRoot, path), "utf8") !==
        readFileSync(join(temporaryRoot, path), "utf8"),
    );
    if (stale.length > 0) {
      throw new Error(
        `generated HSX documentation is stale:\n${stale.join("\n")}`,
      );
    }
    const orphans = orphanedStdPages(outputs);
    if (orphans.length > 0) {
      throw new Error(
        `generated HSX standard-library pages have no module:\n${orphans.join("\n")}`,
      );
    }
    console.log(`checked ${outputs.length} generated HSX files`);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
