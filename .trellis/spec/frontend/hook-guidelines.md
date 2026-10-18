# Hook Guidelines

> How hooks are used in this project.

---

## Overview

**Not applicable to this project.** There is no React, no hooks runtime, and no component tree. Nothing under `src/` imports a UI library, and `package.json` declares zero runtime dependencies.

The equivalent concern — "where does reusable stateful behaviour live, and how is it shared?" — is answered in this project by **plain exported functions in their own module**. The three that would be hooks in a component framework:

| Concern | Where it lives | Why it is a module |
|---------|---------------|-------------------|
| Fetching a candidate pool | `src/github.ts` `searchMerged` `:697`, `selectPool` `:1166` | Needed by a tool registration, which no test can reach — see `src/query.ts:1-9` |
| Caching / revalidating | `src/cache.ts` `cacheGet` `:163`, `cacheGetWithMeta` `:186`, `cacheSet` `:224` | Two-layer state with a versioned envelope; see `backend/database-guidelines.md` |
| Deriving a display value | `src/render.ts` `renderCandidates` `:349`, `renderRanked` `:539` et al. | Pure functions, testable without a host |

The project's rule for extracting one of these is stated in `src/select.ts:1-9` and `src/render.ts:1-14`: **logic that a test cannot reach from a tool registration gets extracted into its own module and exported.** That is the same instinct that produces a custom hook, applied without a framework.

---

## Custom Hook Patterns

Not applicable — there are no custom hooks.

The pattern that replaces it: a stateful or rule-bearing unit becomes a module with a pure core and an explicit dependency parameter. `translateIdea(...)` (`src/translate.ts:657`) is the closest thing to a hook in this codebase — it takes its host services as a `TranslateDeps` object (`src/translate.ts:166`) rather than reaching for them, which is exactly why `test/translate.test.mjs` can drive it with a stub and why its header states "No test in this file calls a real model, and none should ever be changed to."

---

## Data Fetching

Not applicable in the framework sense. For the actual fetching rules, see `backend/error-handling.md` and the constants in `src/github.ts`:

- one retry budget per call, shared between the rate-limit path and the network-error path (`src/github.ts:1-17`);
- `TIMEOUT_MS = 8000` (`:203`), `RETRY_DELAY_MS = 1500` (`:204`), `MAX_RETRY_DELAY_MS = 3000` (`:205`), `RETRY_FLOOR_MS = 1000` (`:213`) — a retry is only started when at least `RETRY_DELAY_MS + RETRY_FLOOR_MS` remains;
- a caller-cancelled request is never retried;
- failures are cached for a minute so a retry loop cannot keep burning quota.

---

## Naming Conventions

Not applicable — there is no `use*` convention.

The naming conventions that do apply are in `backend/directory-structure.md` §"Naming Conventions": `render*` for card renderers, `describe*` for cause prose, `explain*` for reader guidance, `find*` for suspicion detectors, `is*` for pure predicates, `SCREAMING_SNAKE_CASE` for constants, and module-private `camelCase` for everything not needed elsewhere.

---

## Common Mistakes

Not applicable in the hook sense. The mistakes that actually occur when sharing stateful behaviour in this project:

- **Letting an optional host service be required.** Reach it with `ctx.get` and degrade; do not declare it in `inject`. "A plugin whose module throws on load takes the whole host down with it, which is a steep price for a missing optional token" (`src/index.ts:153-160`).
- **Letting a cache failure fail the call.** "Every failure (missing file, malformed JSON, version drift, expiry) returns `undefined` — the caller refetches. A cache must never be able to fail a call" (`src/cache.ts:161-166`).
- **Presenting a cached observation as a live one.** `cacheGetWithMeta` (`src/cache.ts:195`) exists precisely so a replay can report the age of its evidence.
- **Defining one fact twice.** See `src/select.ts:11-21` and `src/github.ts:70-79`.
