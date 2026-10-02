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
- [ ] A grammar, checker, or lowering change comes with a spec under `test/` that shows one admitted and one refused program. A change without one is a change nobody can defend later.
- [ ] A change to emitted UDL still passes `validateUdl` and updates every spec that pins that output.
- [ ] A user-visible change is in `CHANGELOG.md`.
- [ ] New syntax updates its compiler vocabulary source and `docs/README.md`.

Before the merge the maintainer who asked for this change sends the CLA;
nothing merges until it is signed. CONTRIBUTING.md says why.
