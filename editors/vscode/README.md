# HSX for VS Code

Syntax highlighting for `.hsx` files: a TextMate grammar, a language
configuration, and the manifest that binds them. Nothing else: no language
server, no diagnostics in the editor. For diagnostics, run `hsx check`.

The grammar's token classes come from the compiler's lexer and checker, so
what the editor colours and what the compiler recognises stay the same set:
the seven keywords, the ten archetypes the `settlement` module exports, the
party and asset kinds, the four port field types, currency codes, fixed
durations, percents, and comments.

## Install it locally

```bash
ln -s "$(pwd)/editors/vscode" ~/.vscode/extensions/hsx
```

Then restart VS Code and open any file under `examples/`.

## Package it

```bash
cd editors/vscode
npx @vscode/vsce package
```

This extension is not published to the marketplace yet, which is why the
manifest is marked `private`.

## Changing the grammar

The grammar is not the language. If the two disagree, the compiler is right:
`src/lex.ts` for tokens, `src/check.ts` for the archetype and kind names.
Change the compiler first, then the grammar, in that order.
