import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== ".git"
      ) {
        results.push(...findMarkdownFiles(full));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

export function brokenDocLinks(root = packageRoot): readonly string[] {
  const issues: string[] = [];
  const searchDirs = [join(root, "docs"), join(root, "skills")];
  const mdFiles = searchDirs.flatMap((dir) =>
    existsSync(dir) ? findMarkdownFiles(dir) : [],
  );
  if (existsSync(join(root, "README.md"))) {
    mdFiles.push(join(root, "README.md"));
  }

  const markdownLinkRegex = /\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  const githubRepoPrefix =
    "https://github.com/hyperscale0/hyperscale-hsx/blob/main/";
  const githubTreePrefix =
    "https://github.com/hyperscale0/hyperscale-hsx/tree/main/";

  for (const file of mdFiles) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(markdownLinkRegex)) {
      const rawTarget = match[1] ?? "";
      if (rawTarget.startsWith(githubRepoPrefix)) {
        const subpath = rawTarget.slice(githubRepoPrefix.length).split("#")[0]!;
        if (!existsSync(join(root, subpath))) {
          issues.push(
            `${relative(root, file)}: broken repo link -> ${rawTarget}`,
          );
        }
      } else if (rawTarget.startsWith(githubTreePrefix)) {
        const subpath = rawTarget.slice(githubTreePrefix.length).split("#")[0]!;
        if (!existsSync(join(root, subpath))) {
          issues.push(
            `${relative(root, file)}: broken repo link -> ${rawTarget}`,
          );
        }
      } else if (
        !/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) &&
        !rawTarget.startsWith("#")
      ) {
        const targetPath = rawTarget.split("#")[0]!;
        if (targetPath && !existsSync(join(dirname(file), targetPath))) {
          issues.push(
            `${relative(root, file)}: broken relative link -> ${rawTarget}`,
          );
        }
      }
    }
  }
  return issues;
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
    const broken = brokenDocLinks(packageRoot);
    if (broken.length > 0) {
      throw new Error(
        `documentation links target non-existent files:\n${broken.join("\n")}`,
      );
    }
    console.log(
      `checked ${outputs.length} generated HSX files and verified documentation links`,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
