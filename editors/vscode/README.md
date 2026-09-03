# HSX for VS Code

This extension adds syntax highlighting and standard-library snippets for
`.hsx` files. It has no language server. Run `hsx check` for diagnostics.

The documentation generator reads `KEYWORDS`, `PUNCT`, the UDL clause
vocabulary, and the current `std/settlements` files. It writes the TextMate
grammar and snippets from those sources.

## Install the CI artifact

Download `hsx.vsix` from the Editor workflow artifact, then run:

```sh
code --install-extension hsx.vsix
```

You can also package the extension from this directory:

```sh
bunx @vscode/vsce package --no-dependencies --out hsx.vsix
```

The team has no `hyperscale0` Visual Studio Marketplace publisher account, so
CI builds the file but does not publish it.
