# HSX

Read the [language reference](docs/README.md).

Run `bun run build` to build this package and `bun run check` to check it.

## Browser language service

Import `highlight` and `describe` from `@hyperscale0/hsx/language`, or
`@hyperscale0/hsx/language` in the workspace. The entry has no Node imports and
needs no editor framework. The playground uses it as you type and shows
explanations when you point at the highlighted program or move the editor cursor.

```ts
import { highlight, describe } from "@hyperscale0/hsx/language";

const source = 'program shop "Shop"\nuse escrow';
const spans = highlight(source);
const hover = describe(source, source.indexOf("escrow"));
```

Both functions accept incomplete source. Highlights are sorted, non-overlapping
spans with half-open UTF-16 offsets. Whitespace has no span. Hover returns `null`
for whitespace, unknown names and offsets outside a token. Highlight classes
separate keywords, headers, instruments, actions, parties, roles, fields,
parameters, types, states, money, numbers, percentages, durations, dates,
strings, comments, operators, punctuation and other names.

Header explanations, signatures, parameter defaults and bounds, states and action
actors come from the same header manifest used by the compiler's consumers.
Local explanations use the program's declarations. One keyword table owns the
business explanations. Bounds retain UDL units, which are minor currency units,
basis points and milliseconds for money, percentages and durations.

Pass an optional `StandardLibrary` as the last argument to either function to
resolve your own headers. Failed or incomplete headers keep lexical colouring.
Local declaration resolution uses the parser when the document parses; incomplete
documents retain token colouring, party declarations, imports and standard
attachment parameters and actions. The service retains only the latest bundled
library document and a bounded cache of header metadata. Returned values can be
modified without changing later results.

## Sample programs

The [sample index](docs/examples.md) lists fifteen programs. Twelve introduce
the standard headers through small businesses: tutoring, freelance work, used
devices, prepaid workshops, tuition lending, community lending, device cover,
collections, travel, employee cards, a savings circle and equipment loan reports.
The authored repair approval example builds its lifecycle and evidence requirements directly. The two longer-standing examples show a minimal financed car sale and servicing
with late charges and reminders.

```ts
import { examples, type HsxExample } from "@hyperscale0/hsx/examples";

const sample: HsxExample = examples[0]!;
const spans = highlight(sample.source);
```

Use `@hyperscale0/hsx/examples` inside the workspace. Each record has `id`, `title`,
`summary`, `headers` and `source`. The ID is the filename without `.hsx`, the title
is the program's display name, and headers follow its `use` declarations in source
order. The summary joins the leading `//` comments with spaces. Put the business
summary before the program declaration; later comments explain individual choices.
The array is sorted by filename and imports no filesystem or compiler code.

Add an `.hsx` file to `examples/`, then run `bun run generate`. It writes the
example bundle and sample index alongside the standard-library outputs. Package
preparation also creates both bundles for a fresh checkout. `bun run check`
compiles every file, checks that the generated example bytes match the source,
and exercises highlighting and hover at every sample offset. A stale bundle
fails the check; regenerate after an example edit.

The insurance and travel samples name ADL adapter bindings. Compilation preserves
unbound declarations, but Product creation and recomposition reject unresolved
or changed adapter dependencies during Build admission. Execution checks the
frozen declaration too, including adapter unavailability after a Build was saved. Dates, agreement inputs and declared business parties still
need values when the product runs. A compiled sample is not a connected provider
or a funded agreement.
