# Directory Structure

> How this project's code is organized.

---

## Overview

`dsh-find-ideas` is a DeepSeek Harness plugin: one Node ESM package that registers three LLM-facing tools. There is no HTTP server, no database, no UI framework and no frontend build step. The plugin is the whole "backend"; the Markdown card it prints is the whole "frontend" (see `.trellis/spec/frontend/`).

`src/` holds 11 flat modules. There are no subdirectories, no barrel/index re-export file, and no path aliases: every import names the exact module it needs, with an explicit `.ts` extension.

---

## Directory Layout

```
dsh-find-ideas/
├── src/                    # the only directory tsc compiles (rootDir)
│   ├── index.ts            # 103067 B — plugin entry; all three tool registrations
│   ├── query.ts            #  74757 B — search planning + planning-degrade prose
│   ├── github.ts           #  65803 B — HTTP, retry, rate limit, pool selection
│   ├── types.ts            #  47906 B — shared types + pure scoring/ranking maths
│   ├── select.ts           #  43520 B — architecture-file selector (pure)
│   ├── render.ts           #  59548 B — the card renderers (pure string builders)
│   ├── translate.ts        #  35478 B — idea -> English keywords, via an LLM
│   ├── lexicon.ts          #  23955 B — CJK -> English seed table (pure data + lookup)
│   ├── skeleton.ts         #  18988 B — signature scanning over file excerpts (pure)
│   ├── cache.ts            #  19592 B — memory + JSON disk cache
│   └── credentials.ts      #   6543 B — GITHUB_TOKEN write path (deliberately unregistered)
├── test/                   # 30 *.test.mjs files, run as plain node scripts
├── scripts/                # check-peers.mjs, script-env.mjs, readme-sample.mjs
├── lib/                    # tsc output, gitignored — TESTS IMPORT FROM HERE, NOT src/
├── docs/                   # the architecture diagram: HTML, PNG, and its candidate
├── .github/workflows/      # ci.yml — npm ci, then `npm run check` and `npm test`
├── .trellis/               # this spec layer
└── package.json · tsconfig.json · cordis.patch.yml · AGENTS.md · README.md · LICENSE
```

`lib/` is build output and is gitignored. Tests load it rather than `src/`; that indirection has a real failure mode documented in `quality-guidelines.md` §"Testing Requirements".

`README.md` exists and is tracked, and it is the right place to start reading this project. It is not a normative source: when the README and the code disagree, the code and the test suite win. The README is written for a reader arriving from outside; this spec layer is the one the project's own agents are held to.

---

## Module Organization

### The one-way dependency rule

Imports form a DAG. `src/types.ts` is the leaf and imports **nothing** — verified: it is the only module with zero `import` statements of any kind.

| Layer | Module | Intra-project imports |
|-------|--------|----------------------|
| 0 | `types.ts` | **none** |
| 0 | `lexicon.ts` | none |
| 0 | `select.ts` | none |
| 0 | `skeleton.ts` | none |
| 0 | `credentials.ts` | none |
| 0 | `cache.ts` | none (uses only `node:fs/promises`, `node:os`, `node:path`) |
| 1 | `github.ts:19` | `type RepoCandidate` from `./types.ts` |
| 1 | `query.ts:11` | `englishSeeds` from `./lexicon.ts` |
| 2 | `translate.ts:57-58` | `MAX_QUERY_TERMS` from `./query.ts`, `type Degraded` from `./types.ts` |
| 3 | `render.ts:16-20` | `./types.ts`, `TAIL_STAR_CEILING` from `./github.ts`, `./skeleton.ts` |
| 4 | `index.ts:24-30` | `./cache.ts`, `./github.ts`, `./query.ts`, `./select.ts`, `./skeleton.ts`, `./translate.ts`, `./render.ts`, `./types.ts` |

Only `index.ts` is a composition root. Every other module is a library that some other module (or a test) calls directly.

### Why `types.ts` must stay import-free

Because it is the leaf, **a constant cannot live in `types.ts` if computing or justifying it requires a value from a higher layer.** The concrete case:

- `TAIL_STAR_CEILING = 100` lives at `src/github.ts:60`, not in `types.ts`.
- `src/render.ts:19` imports it from `./github.ts`.

`render.ts` is a *presentation* module, yet it reaches into the network module for one number. That is correct here: the number's meaning ("the long tail") is defined by the retrieval strategy in `github.ts`, and moving it to `types.ts` would either invert the dependency or duplicate the definition. `countLowStar` (`src/github.ts:80-81`) follows the same reasoning and is shared by the pool side and the final-list side precisely so the two cannot drift.

### Composition roots and reachability

- `apply(ctx: Context): void` at `src/index.ts:781` is the plugin entry. The three tools are registered inside it (`src/index.ts:782`, `:1223`, `:1508`) and are **not** module exports, so no test can import a tool definition directly — tests call `apply()` with a stub `ctx.tools.register` and capture what it receives.
- `src/credentials.ts` exports a complete, tested function (`configureGitHubToken`, `src/credentials.ts:84`) that `apply()` deliberately does **not** register. The module header (`src/credentials.ts:1-29`) states why: a registered tool appears in every agent's tool list and may be called unprompted, and nothing in the plugin can fence a tool to "only when the user asked". Exposure is left as a deliberate act. `test/credentials.test.mjs` group C4 pins the non-registration ("it is NOT registered as a tool").

### Where logic goes

The recurring pattern, and the reason several modules exist at all: **logic that a test cannot reach from a tool registration gets extracted into its own module.** The headers say so explicitly.

- `src/select.ts:1-9` — "This module exists because the selector went through three rewrites and three real defects while living inside a tool registration, where no test could reach it."
- `src/query.ts:1-9` — "its history is a warning: the plan behind the long-tail fix went through three rewrites with no automated coverage, because it was reachable only through a registered tool. Everything here is exported and tested directly."
- `src/render.ts:1-14` — "a renderer that can only be reached by calling a registered tool cannot be tested at all."

So: a new rule that can be expressed as a pure function of its inputs belongs in a module, exported, with a test that calls it directly. Only wiring, I/O orchestration and the tool schemas belong in `index.ts`.

---

## Naming Conventions

### Files

Single lowercase word, no separators: `cache.ts`, `github.ts`, `lexicon.ts`, `query.ts`, `render.ts`, `select.ts`, `skeleton.ts`, `translate.ts`, `types.ts`, `credentials.ts`, `index.ts`. `index.ts` is the entry point only — it is not a barrel.

### Exported symbols

| Shape | Convention | Examples |
|-------|-----------|----------|
| Types/interfaces | `PascalCase`, no `I` prefix | `RepoCandidate` `src/types.ts:10`, `Degraded` `src/types.ts:72`, `NoiseReport` `src/types.ts:276` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_LIMIT` `src/index.ts:168`, `CACHE_VERSION` `src/cache.ts:32`, `RRF_K` `src/github.ts:668` |
| Version constants | `*_VERSION` | `SEARCH_PLAN_VERSION` `src/types.ts:1008`, `SELECTOR_VERSION` `src/select.ts:305`, `SCANNER_VERSION` `src/skeleton.ts:148` |
| Card renderers | `render*` | `renderCandidates` `src/render.ts:355`, `renderRanked` `src/render.ts:545`, `renderInspections` `src/render.ts:959` |
| Degrade-prose helpers | `describe*` | `describeFailure` `src/github.ts:174`, `describePartialFailure` `src/query.ts:1232`, `describeProbeOutcome` `src/github.ts:967` |
| User-facing explanations | `explain*` | `explainEmpty` `src/render.ts:332`, `explainThinResult` `src/query.ts:1329` |
| Suspicion detectors | `find*` | `findSuspicious` `src/types.ts:491`, `findScoreGaps` `src/types.ts:600`, `findDoubleSided` `src/types.ts:664`, `findNoteEchoes` `src/types.ts:738` |
| Pure predicates | `is*` / `*Failed` | `isDeclarationHit` `src/skeleton.ts:94`, `isTailReachable` `src/query.ts:995`, `translationFailed` `src/translate.ts:288` |
| Private module helpers | `camelCase`, **not exported** | `cacheDir` `src/cache.ts:213`, `cachePathFor` `src/cache.ts:227`, `rateLimitInfo` `src/github.ts:215` |

The `describe*` / `explain*` split is meaningful and worth preserving: `describe*` names a *cause* (a string suitable for a `Degraded.detail`), `explain*` writes *what the reader should do about it*.

### Private-by-default

Only what another module or a test needs is exported. `CACHE_VERSION`, `MEMORY_TTL_MS`, `DISK_TTL_MS`, `MAX_MEMORY_ENTRIES`, `CACHE_DIR_MAX_BYTES`, `SWEEP_INTERVAL_MS`, `TMP_STALE_MS`, `cacheDir`, `cachePathFor`, `remember`, `sweepOnce`, `sweepIfDue`, `CacheEntry` and `DiskEnvelope` are all module-private in `src/cache.ts` — the exported surface is exactly `SOURCE_TTL_MS` (`:118`), `CacheHit` (`:159`), `dshHome` (`:204`), `cacheSweepNow` (`:350`), `cacheGet` (`:365`), `cacheGetWithMeta` (`:388`), `cacheSet` (`:438`), `cacheClearMemory` (`:464`) and `cacheMemoryStats` (`:477`).

The two `cacheSweepNow` / `cacheMemoryStats` exports exist for a single reason each: a bounded resource that no caller can observe is a bound no test can assert. Both are diagnostics — normal operation never calls them, and `sweepIfDue` (`:330`) is the only path that actually runs a sweep in production.

### Test files

`test/<concern>.test.mjs`, one file per concern, each self-contained and independently runnable. Assertions are grouped under labelled sections (`Q1`-`Q7`, `S1`-`S9`, `T1`-`T12`, `C0`-`C5`, `§7.1`-`§7.4`) so a failing run names the rule it broke. `test/run-all.test.mjs` is the only file excluded from discovery.

---

## Examples

- **Pure module with preserved rationale** — `src/select.ts`. Every rule carries the measured failure that produced it (`src/select.ts:11-21` on the `MANIFEST_RE` drift defect).
- **Module extracted for testability** — `src/render.ts`. Positional parameters, no I/O, no imports of anything but types and two constants.
- **Composition root** — `src/index.ts`. Constants at the top (`:161`-`:225`), then `apply()` (`:781`) containing the three registrations in call order.
- **Cache with a versioned envelope** — `src/cache.ts`. See `database-guidelines.md`.
- **Deliberate non-exposure** — `src/credentials.ts`. Read the header before wiring anything up.
