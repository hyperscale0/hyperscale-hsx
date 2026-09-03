import { expect, it } from "bun:test";

it("packs public runtime and documentation files without repository-only lanes", async () => {
  const process = Bun.spawn(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const [{ files }] = JSON.parse(stdout) as [
    { readonly files: readonly { readonly path: string }[] },
  ];
  const paths = files.map((file) => file.path);
  for (const required of [
    "docs/guide/01-first-program.md",
    "docs/reference/grammar.md",
    "examples/cost-table.json",
    "skills/hsx/SKILL.md",
    "std/settlements/held_payment.hsx",
  ]) {
    expect(paths).toContain(required);
  }
  for (const excluded of ["test/", "editors/", ".github/"]) {
    expect(paths.some((path) => path.startsWith(excluded))).toBe(false);
  }
});
