# HSX for VS Code

This extension adds syntax highlighting, standard-library snippets, language
server diagnostics, and formatting for `.hsx` files.

The language client runs `hsx lsp` over stdio. Install the compiler binary
globally:

```sh
npm i -g @hyperscale0/hsx
```

## Settings

- `hsx.serverPath`: Path to the `hsx` executable. Defaults to `hsx`. The extension reads this setting at activation, and a window reload applies a change.

## Build

Typecheck the source with strict tsc, then build the bundle to `dist/extension.js`:

```sh
npm run typecheck
npm run build
```

## Install the CI artifact

Download `hsx.vsix` from the Editor workflow artifact, then run:

```sh
code --install-extension hsx.vsix
```

You can also package the extension from this directory:

```sh
bunx @vscode/vsce package --out hsx.vsix
```

The team has no `hyperscale0` Visual Studio Marketplace publisher account, so
CI builds the file but does not publish it.
