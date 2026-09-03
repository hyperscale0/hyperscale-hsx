# Two-instrument reading session, 2026-09-02

The reader worked only inside the HSX public export. It read the README, skill,
guide, grammar, types, and generated standard-library pages.

## First run

Attempts: 3. Result: environment refusal before language checking.

```text
$ hsx check reading-test.hsx
zsh: command not found: hsx
exit 127

$ npm exec --offline --package=. -- hsx check reading-test.hsx
sh: hsx: command not found
exit 127

$ bun run src/cli.ts check reading-test.hsx
SyntaxError: Export named 'udlEffectKinds' not found in the cached UDL beta package
exit 1
```

The public docs did not distinguish the installed command from the source
checkout command. The provisional pre-publication clone also resolved an old
UDL package. The README and first-program guide now name the exact checkout
command. The rerun used the local UDL rc.1 package already proved by the
exporter.

## Rerun after the docs repair

Attempts: 1. Result: accepted with no diagnostics.

```text
$ bun run bin/hsx.ts check reading-test.hsx
[no diagnostics]
exit 0
```

The accepted program is in
[`2026-09-02-two-instruments.hsx`](./2026-09-02-two-instruments.hsx).
