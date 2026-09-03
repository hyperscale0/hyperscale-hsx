Requested by a Hyperscale maintainer in issue #___. Unsolicited pull requests
are closed with a pointer to CONTRIBUTING.md.

## What this changes

One paragraph. What was wrong or missing, and what the change does about it.

## How it was verified

Paste real output, not a claim.

```
bun test
```

## Checklist

- [ ] `bun run check` passes locally (typecheck plus the full suite).
- [ ] A grammar, checker, or lowering change comes with a fixture under `test/fixtures/`. A change without a fixture is a change nobody can defend later.
- [ ] A change to emitted UDL updates its canonical fixture and keeps the UDL package's format law.
- [ ] A user-visible change is in `CHANGELOG.md` under Unreleased.
- [ ] New syntax updates its compiler vocabulary source, then `bun run docs:build` and `bun run docs:check` pass.

Before the merge the maintainer who asked for this change sends the CLA;
nothing merges until it is signed. CONTRIBUTING.md says why.
