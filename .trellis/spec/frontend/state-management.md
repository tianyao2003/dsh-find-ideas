# State Management

> How state is managed in this project.

---

## Overview

**Not applicable in the frontend sense.** There is no React, no store, no reducer, no context, and no client-side state of any kind — this project has no browser code.

State does exist in the plugin, in three places, and it is specified in the backend layer:

| Kind of state | Where it lives | Spec |
|---------------|---------------|------|
| In-process cache (a `Map`, per plugin instance) | `src/cache.ts:102` | `backend/database-guidelines.md` |
| On-disk cache (JSON files under `$DSH_HOME/cache/dsh-find-ideas/`) | `src/cache.ts:127-150` | `backend/database-guidelines.md` |
| Per-call state (request counters, deadlines) | `src/index.ts:1616+` | `backend/tool-contracts.md` |

There is no shared mutable state between tool calls other than the cache, and the cache is explicitly allowed to be lost: "A cache must never be able to fail a call" (`src/cache.ts:152-157`).

---

## State Categories

Not applicable — the local/global/server/URL taxonomy is a client-application taxonomy and this project has no client.

The nearest mapping, for a reader arriving from a frontend background:

- **"Local state"** — a value that lives for one tool call: `requestsUsed` in `inspect_projects` (`src/index.ts:1616+`), the `AbortSignal` composed per request (`src/github.ts:364`), the deduped repo list.
- **"Server state"** — GitHub's responses, cached with a TTL and a versioned envelope (`src/cache.ts`).
- **"Derived state"** — everything in `src/render.ts` and the scoring maths in `src/types.ts`. These are pure functions of their inputs, recomputed on every call, never stored.

---

## When to Use Global State

Not applicable. The only cross-call state is the cache, and the rule for promoting something into it is: **only if a re-fetch would cost quota or time, and only if a stale copy cannot make a false claim.**

`SOURCE_TTL_MS = 10 * 60 * 1000` (`src/cache.ts:53`) is that rule applied. The 24-hour default is right for a candidate list ("the set of repositories matching an idea changes slowly") and wrong for `inspect_projects`, because what it caches is file *contents*: "a stale candidate list is mildly wrong… while a stale source read is SPECIFICALLY wrong — it reports a package.json that no longer says what it says, and the whole point of `inspect_projects` is to be the step whose evidence can be trusted."

The `snapshot` stamp (`src/cache.ts:78-83`, `:186-191`) is the second half of the same rule: an entry produced by an older scanner answers a different question, so it is treated as a miss rather than replayed.

---

## Server State

Not applicable in the React Query / SWR sense. The equivalent is `src/cache.ts`, documented in full in `backend/database-guidelines.md`.

---

## Common Mistakes

Not applicable in the state-management sense. The mistakes that actually occur around state in this project:

- **Bumping `CACHE_VERSION` for an optional field.** Only a new **required** field needs a bump; the reasoning is at `src/cache.ts:62-77`.
- **Forgetting to bump it for a required field.** The 1 -> 2 bump exists because `thin === undefined` would have made `hit.thin !== null` true for every old entry, relabelling every clean cached search as short.
- **Recomputing a stored number from the rows instead of reading it back.** The cached path once recomputed `tail_included` as `candidates.filter(c => c.stars <= TAIL_STAR_CEILING).length`, which answers a different question, so the same search reported one number on a cold run and another on a replay (`src/index.ts:857-864`).
- **Replaying a stale observation without saying how old it is.** `cacheGetWithMeta` exists so a replay can report its age.
- **Letting a cache write failure surface.** Writes are best-effort and swallowed; an unwritable directory degrades to memory-only (`src/cache.ts:212-241`).
