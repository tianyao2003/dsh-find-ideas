# Type Safety

> Type patterns and validation in this project.

---

## Overview

TypeScript in `strict` mode, compiled by `tsc` to `lib/`, with no runtime type library and no code generation. `tsconfig.json` is the whole type-safety configuration — there is no ESLint, no Prettier and no `tsc` plugin.

The type system does three jobs here, in order of how much they matter:

1. **Keep the one-way dependency graph intact.** `src/types.ts` is the leaf; it imports nothing.
2. **Make the tool boundary honest.** `output.schema` is what `defineTool` uses to infer the `execute` return type, and it is also the runtime validation surface the host enforces.
3. **Make the renderers total.** Every renderer takes computed values and returns a string; nothing about them can fail.

The compiler settings that shape the code most:

| Setting | Value | Consequence |
|---------|-------|-------------|
| `strict` | `true` | no implicit `any`, no unchecked null |
| `noUncheckedIndexedAccess` | `true` | indexed access yields `T \| undefined`; every array read is guarded |
| `noImplicitOverride` | `true` | — |
| `verbatimModuleSyntax` | `true` | type-only imports must say `import type` |
| `erasableSyntaxOnly` | `true` | **no enums, no parameter properties, no namespaces** |
| `exactOptionalPropertyTypes` | `false` | `?:` and `\| undefined` are interchangeable |
| `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` | `true` | imports are written `from './types.ts'`; `tsc` rewrites them on emit |
| `declaration` + `declarationMap` + `sourceMap` | `true` | `lib/` ships `.d.ts` and maps |

---

## Type Organization

Types live in **`src/types.ts`** (1053 lines) unless they are private to one module. There is no `types/` directory, no barrel file, and no ambient `.d.ts`.

### The leaf rule

`src/types.ts` imports **nothing** — verified: it has zero `import` statements. This is load-bearing, not incidental. Because it is the leaf, **a value cannot live in `types.ts` if defining it requires something from a higher layer.**

The concrete case: `TAIL_STAR_CEILING = 100` is defined at `src/github.ts:60` and imported by `src/render.ts:19` — a presentation module reaching into the network module for one number. That is correct here, because the number's meaning ("the long tail") is defined by the retrieval strategy. Putting it in `types.ts` would either invert the dependency or duplicate the definition. Full graph in `backend/directory-structure.md`.

### What lives in `types.ts`

| Group | Examples |
|-------|---------|
| Data shapes | `RepoCandidate` `:10`, `Inspection` `:34`, `RankedCandidate` `:174`, `NoiseReport` `:259`, `Suspicion` `:333`, `TermReport` `:242`, `RelevanceInput` `:151` |
| Degradation | `Degraded` `:63` |
| Scoring maths | `ratingFromRelevance` `:94`, `finalScore` `:146`, `STAR_FLOOR` `:103`, `MIN_RELEVANCE` `:310` |
| Ranking | `rankCandidates` `:755`, `candidateIndex` `:400`, `judgementIndex` `:432` |
| Consistency detectors | `findSuspicious` `:474`, `findScoreGaps` `:583`, `findDoubleSided` `:647`, `findNoteEchoes` `:721`, with thresholds `SCORE_GAP_SIMILARITY` `:531`, `SCORE_GAP_RELEVANCE` `:534`, `NOTE_GAP_TERMS` `:537`, `NOTE_GAP_FLOOR` `:540`, `NOTE_MIN_CHARS` `:543`, `SUSPICION_QUOTE_CHARS` `:330` |
| Formatting | `formatStars` `:823`, `formatRating` `:830` |
| Cache keys | `cacheKeyFor` `:859`, `searchCacheKeyFor` `:1023` |
| Version | `SEARCH_PLAN_VERSION = 7` `:987` |

### Module-private types

A type used by one module stays in that module: `CacheEntry` and `DiskEnvelope` (`src/cache.ts:79`, `:102`), `QueryFailure` and `ProbeReport` (`src/github.ts:34`, `:927`), `SignatureHit` (`src/skeleton.ts:67`). Export only what another module or a test needs.

### Types that are structurally forced

Three shapes look like they should be unions or optionals and are not. All three have the same cause: **the schema language has no unions, and `output.schema` is what `defineTool` uses to infer the `execute` return type.**

| Shape | Declaration | Why |
|-------|------------|-----|
| `Degraded.reason` | `string` (`src/types.ts:72-77`) | the reason vocabulary cannot be a union in a schema position |
| `Suspicion.kind` | `string` (`src/types.ts:350-376`) | same |
| `Suspicion.against` | `string`, empty-string sentinel rather than `?` | same |
| `RankedCandidate.note` | `note?: string` (`src/types.ts:183-239`) | this one *is* optional in the schema (`src/index.ts:1372`), deliberately: a score with no stated reason is a real case |

Do not "improve" the first three into unions without first checking whether `output.schema` can express the change.

### Sentinels instead of absence

The schema language has no `null` in a number position, so an unmeasured term total travels as `TERM_TOTAL_UNKNOWN = -1` (`src/types.ts:257`) and is converted back at the render boundary:

```ts
// src/index.ts:944-951
value.query_terms.map((entry) => ({
  term: entry.term,
  total: entry.total < 0 ? null : entry.total,
  verdict: entry.verdict === 'carrying' ? ('carrying' as const) : ('selective' as const),
})) as TermReport[],
```

The encoding is spelled out in exactly **one** place; the renderer only ever sees a `TermReport` whose `total` is `number | null`. The distinction the sentinel protects is real: `0` means "the term matched nothing on its own", while `-1` means "nobody measured this term". Conflating them is a correctness bug, not a cosmetic one.

---

## Validation

There is **no runtime validation library** — no Zod, no Yup, no io-ts, no `ajv`. Validation happens at two boundaries instead.

### Boundary 1: the tool schema

The host validates every call against the tool's `parameters` and every result against `output.schema`. This is the real runtime gate, and it is written by hand as plain JSON-schema-shaped objects (`src/index.ts:795-825`, `:827-934`, `:1249-1328`, `:1330-1430`, `:1539-1576`, `:1578-1619`).

Two conventions make that schema trustworthy:

- **`additionalProperties: false` on every output-schema root and every nested object** — 13 sites (`src/index.ts:829`, `:838`, `:893`, `:924`, `:1267`, `:1291`, `:1332`, `:1341`, `:1388`, `:1407`, `:1580`, `:1591`, `:1610`). An undeclared field is rejected rather than silently dropped.
- **A field must be declared in the schema *and* passed through `render`.** Declaring it in one place only is the real `note` defect: it was accepted as input and read by the renderer but never declared in the output schema, so it was dropped in between and the caller-note block could never be non-empty (`src/index.ts:1364-1371`).

Parameter validation that the code performs itself, rather than trusting the caller:

```ts
const limit = Math.max(1, Math.min(args.limit ?? 20, MAX_LIMIT))   // src/index.ts, both search and rank
```

"The limit is a parameter, but it is clamped rather than trusted: an unbounded limit turns one call into an unbounded response, and the caller has no way to know where the edge is" (`src/index.ts:168`).

### Boundary 2: model output

`src/translate.ts` is the only module that consumes text produced by a model, and it validates rather than trusts it: `translationFailed(outcome: TranslateOutcome): boolean` (`:288`) is the predicate callers branch on, `termBudget(keywords: string)` (`:610`) bounds what a translation may contribute, and `MAX_KEYWORDS_CHARS = 120` (`:203`) bounds its length. A failed translation degrades; it never reaches the card as an exception.

`test/translate.test.mjs:164` pins the outcome key set:

```js
JSON.stringify(Object.keys(outcome).sort()) === '["degraded","keywords","source"]'
```

---

## Common Patterns

### `as` casts only at boundaries

A schema-shaped value arriving as `unknown`-ish, or a generic cache read, is the only place a cast appears. All sites:

| Site | Cast |
|------|------|
| `src/index.ts:1454`, `:1457` | `args.candidates as RepoCandidate[]`, `args.scores as RelevanceInput[]` |
| `src/index.ts:1466-1468` | the same, passed to the three detectors |
| `src/index.ts:951`, `:1624` | render-boundary coercions: `as TermReport[]`, `as Inspection[]` |
| `src/cache.ts:244`, `:250` | `hit.data as T`, `JSON.parse(...) as DiskEnvelope<T>` |
| `src/credentials.ts:66` | `get.call(ctx, 'credentials') as CredentialService \| undefined` |
| `src/github.ts:471` | `item.owner as Record<string, unknown> \| undefined` |

Note the two directions of the cache cast: `cacheSet<T>` is generic and writes whatever it is given, so `cacheGet<T>`'s `as T` is a claim by the *caller*, not a proof. That is why the envelope carries a version and why every mismatch returns `undefined`.

### Generic functions

Only the cache is generic, and only because it stores three unrelated shapes (`CachedSearch`, `CachedInspection`, and whatever a future caller needs):

```ts
export async function cacheGet<T>(key: string, ttlMs?: number): Promise<T | undefined>
export async function cacheGetWithMeta<T>(key: string, ttlMs?: number, snapshot?: string): Promise<CacheHit<T> | undefined>
export async function cacheSet<T>(key: string, data: T, snapshot?: string): Promise<void>
```

### Discriminating on a string field

Because `Degraded.reason` is a `string`, callers compare against literals rather than narrowing a union:

```ts
// src/render.ts:332-352 (shape)
if (degraded === null) { /* success, no matches */ }
else if (degraded.reason === 'rate_limited') { /* quota */ }
else { /* network or proxy */ }
```

The vocabulary is closed by convention and enumerated in `backend/error-handling.md`; a new reason must be added there and to whatever branches on it.

### `verbatimModuleSyntax`

Type-only imports say so explicitly: `import type { RepoCandidate } from './types.ts'` (`src/github.ts:19`), `import type { Degraded } from './types.ts'` (`src/translate.ts:58`). Mixed imports inline the marker: `import { EXCERPT_WINDOW_CHARS, MAX_HITS_PER_FILE, isDeclarationHit, type SignatureHit } from './skeleton.ts'` (`src/render.ts:20`).

### Import extensions

Every intra-project import ends in `.ts` — `from './types.ts'`, not `'./types.js'` and not `'./types'`. This is required by `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, and `tsc` rewrites the specifier on emit.

### Appending parameters

A renderer's positional signature is extended by **appending**, never inserting, so every existing call keeps its meaning. `renderCandidates`' `lowStarInPool: number | null = null` (`src/render.ts:355-372`) is the worked example, and its `null` case is a type-safety rule, not a default: `null` means the caller did not report the population, which is not the same as reporting zero — "Defaulting to 0 would have made every such call assert 'this pool held no small projects', a claim about a measurement the caller never took" (`src/render.ts:363-370`).

---

## Forbidden Patterns

| Forbidden | Reason | Enforced by |
|-----------|--------|-------------|
| `any` | Defeats the strictness the whole config exists for. Verified: zero occurrences in `src/`. | `tsc` (`strict`, and no `any` is written) |
| `@ts-ignore` / `@ts-expect-error` | Verified: zero occurrences in `src/`. A suppression is a type bug left in place. | review; `tsc` |
| `as unknown as` | Verified: zero occurrences. A double cast is a claim with no evidence behind it. | review |
| Non-null assertion (`!`) on indexed access | `noUncheckedIndexedAccess` is on deliberately; guard the read instead. | `tsc` |
| `enum`, parameter properties, `namespace` | `erasableSyntaxOnly: true` — TypeScript syntax must be erasable. | `tsc` (`tsconfig.json:18`) |
| Importing without the `.ts` extension | The emit config requires it. | `tsc` (`tsconfig.json:19-20`) |
| A value import in `src/types.ts` | `types.ts` is the leaf; adding an import there breaks the one-way rule and invites a cycle. | review; `backend/directory-structure.md` |
| Putting a constant in `types.ts` that needs a value from a higher layer | Forces either a cycle or a duplicated definition. | review; `TAIL_STAR_CEILING` is the worked example |
| A union type in an `output.schema` position | The schema language has no unions; `Degraded.reason` and `Suspicion.kind` are `string` for this reason. | the schema definition itself |
| Defaulting an unmeasured value to `0` | `0` is a measurement; absence is not. | `test/diagnostics-honesty.test.mjs` |
| Declaring an output field in the schema but not passing it through `render` | It is dropped in between; this is the real `note` defect. | `test/declaration-honesty.test.mjs`, `test/evidence-chain.test.mjs:119` |
| Trusting `props.x.required` at runtime | The framework hoists it into the parent's `required` array. | `test/diagnostics-honesty.test.mjs:348-352` |
