# Typing without TypeScript

Types live in **JSDoc comments inside the existing `.js` files**. There are no `.ts` files, no build step and no new runtime
dependency: the code that ships is exactly the code that is written. The TypeScript compiler is used only as a *checker* (a linter
that understands JSDoc), run on demand and never imported by the engine.

## Why

The engine is built from buses, contracts and many small modules that talk through plain objects. The bugs that cost the most time here
were shape mismatches that tests did not exercise (a wrong field on an envelope, a value that can be `null` on one path, an inherited
property treated as a lookup key). A checker finds this class of bug at the keyboard instead of in the browser.

It paid off immediately on the first pass:

- `stme:constructor` resolved through `Object.prototype` and turned into a bogus module URL (fixed, with a regression test).
- A "home domain" type that was too narrow was rejected by the existing tests, which exposed that services can register callers too.
- Places where a value could be `null` but was dereferenced (`meta`, `pending`, `hudUi`) were made explicit.

## How it works

1. **Opt in per file** with `// @ts-check` as the very first line. A file without it is not checked at all.
2. **Strict mode, no exceptions.** `jsconfig.json` sets `strict: true`. A file that opts in must pass with zero errors; there is no
   "allow implicit any" escape hatch and no `// @ts-ignore` in checked files. If a type is hard to express, fix the design or use a
   narrow, commented cast (see below).
3. **Gradual.** `checkJs` is `false` globally, so unchecked files cannot break `npm run typecheck`. The ratchet only goes one way: once a
   file is opted in it stays at zero errors.

```bash
npm run typecheck            # checks every file that opted in; exit code != 0 on any error
npm run typecheck:progress   # how many files opted in, and where the remaining errors are (easiest files first)
```

Both commands fetch the compiler with `npx` on first use (network needed once). Nothing is added to `package.json` dependencies.

Editors that understand JSDoc (VS Code, WebStorm) pick up `jsconfig.json` and show the same errors and hover types while you type.

## Where the types are

Types are `@typedef`s in **code-free `.js` files** next to the code that owns them. Import them with `import()` types:

| File | What it defines |
|---|---|
| `libraries/shared/bus-types.js` | `Envelope`, `Host`, `Engine`, buses, Gates, `RightsConfig`, `RightsCore`, `Domain` |
| `cores/ui/ui-types.js` | `Signal`, `UiNode`, `UiProps` (typed `on:*` DOM handlers), `UiChild` |
| `libraries/core/module-types.js` | module header/meta, `Analysis`, runner/installer/registry shapes |

```js
// @ts-check
/** @typedef {import('../shared/bus-types.js').Host} Host */
/** @template [T=any] @typedef {import('../../cores/ui/ui-types.js').Signal<T>} Signal */
```

A types file ends with `export {};` so it is a module, contains no logic, and is never executed for its own sake.

## Writing annotations

- **Merge the description and the tags into one block.** The description comment and the `@param`/`@returns` tags must be a single
  `/** ... */` directly above the function, otherwise editors show only the nearest block. Put `@typedef`s at the top of the file, not
  between a description and its function.
- **Prefer precise unions over `any`.** `Envelope<T>` is `{ ok: true, value: T } | { ok: false, error }`; `Analysis` is a union where
  `ok: true` guarantees `meta` and `hash` exist. Narrow with `if (!result.ok) return ...` instead of casting.
- **Default `any` is deliberate and rare.** Today it appears for contract `params` and for `Envelope` values, because there is no
  per-contract type map yet. It is a documented gap, not a style choice.
- **Treat data from outside as `unknown`.** Parsed JSON, storage values and GitHub responses are checked, not assumed
  (`buildVerifiedEntries(listing: unknown)`, filters in `installer.load()`).
- **Casts are a last resort and must say why.** Use `/** @type {X} */ (value)` only where the compiler cannot know something the code
  guarantees, and keep a short comment. Prefer a type guard or restructuring the code.
- **Do not widen a type to silence an error.** First ask whether the error is a real bug (it often is).
- **Optional vs required options.** If an options object has required fields, do not give the parameter a `= {}` default.

Common patterns:

```js
/** @type {Map<string, Entry>} */                 // empty collections need an explicit type
const byId = new Map();

/**
 * @template T
 * @param {() => T[]} items
 * @param {(item: T) => UiNode} renderItem
 * @returns {Signal<UiNode[]>}
 */

/** @type {GateAccessor['subscribe']} */          // reuse a member type instead of repeating it
function subscribe(contract, options, callback) { ... }
```

## Adding a file to the checked set

1. Run `npm run typecheck:progress` and pick a file with few errors, ideally one that the already-typed code imports.
2. Add `// @ts-check` as the first line and run `npm run typecheck`.
3. Fix errors from the inside out: shared typedefs first, then function signatures, then locals that the checker cannot infer
   (empty arrays/maps, `let x = null`).
4. Run the tests for that area, and for a UI/engine change check it in the test SillyTavern (port 8010).
5. If the checker found a real bug, fix it and add a regression test (and confirm the test fails on the old code).

Suggested order: leaf libraries (`libraries/core`), then the services, then Cores that already consume typed buses, and the large
Cores (`memory-graph`, `sync`, `ui`) last, split into smaller files first (see the 300-line rule in `CONVENTIONS.md`).

## Status

Checked today (zero errors under `strict`): the module runtime (`libraries/core/module-*`, `semver`, `cores/runner/*`,
`harness/module-runtime.js`, `harness/module-registry.js`), the connectivity layer (`event-bus`, `contract-bus`, `request`, `gate`,
`network-gate`, `engine`, `cores/rights`), `module-kit`, the UI primitives (`reactive`, `tree`), all widgets in `widgets.js`, and the
Modules card and installer panel. `npm run typecheck:progress` prints the current numbers.

## Known gaps

- **Contracts are untyped.** The bus does not know that `storage.settings.get` takes `{ namespace, key, fallback }` and returns a
  given shape. A contract map (name → params/result) would give typed `request()` calls; it is the most valuable next step and
  should be introduced contract by contract, not all 280 at once.
- **Tests are not type-checked** (`tests/` is excluded) — they intentionally pass partial stubs.
- **Modules from the catalog** are plain JS that cannot be checked by the engine; they can opt in themselves, and the catalog
  README can recommend `// @ts-check` plus the typedefs above.
