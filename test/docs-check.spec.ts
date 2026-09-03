import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orphanedStdPages } from "../scripts/docs/check.ts";

describe("HSX generated documentation check", () => {
  it("refuses a standard-library page with no source module", () => {
    const root = mkdtempSync(join(tmpdir(), "hsx-docs-check-"));
    try {
      const stdRoot = join(root, "docs", "reference", "std");
      mkdirSync(stdRoot, { recursive: true });
      writeFileSync(join(stdRoot, "active.md"), "# Active\n");
      writeFileSync(join(stdRoot, "orphaned.md"), "# Orphaned\n");

      expect(orphanedStdPages(["docs/reference/std/active.md"], root)).toEqual([
        "orphaned.md",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
