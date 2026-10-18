# Database Guidelines

> Persistence patterns and conventions for this project.

---

## Overview

**There is no database.** No ORM, no SQL, no query builder, no migrations, no schema DDL, no transactions, and no database driver. `package.json` declares zero runtime dependencies.

What this project persists is a **JSON disk cache** in `src/cache.ts` (479 lines). It is the only storage of any kind, and it is deliberately weaker than a database in every dimension: it is optional, lossy, best-effort, and allowed to fail at any moment. That weakness is the design.

> "Every failure (missing file, malformed JSON, version drift, expiry) returns `undefined` — the caller refetches. **A cache must never be able to fail a call.**" — `src/cache.ts:354-359`

Anything you would normally look for in this file (indexes, constraints, connection pooling, transaction isolation, migration ordering) does not exist here. The sections below document the persistence surface that does.

---

## Query Patterns

### The two layers

| Layer | Type | TTL | Site |
|-------|------|-----|------|
| In-process | `Map<string, CacheEntry<unknown>>` (`src/cache.ts:167`) | `MEMORY_TTL_MS = 5 * 60 * 1000` (`:35`) | `src/cache.ts:395-402` |
| On-disk | one JSON file per key under `$DSH_HOME/cache/dsh-find-ideas/` | `DISK_TTL_MS = 24 * 60 * 60 * 1000` (`:53`) | `src/cache.ts:406-423` |

A third TTL exists for one caller: `SOURCE_TTL_MS = 10 * 60 * 1000` (`src/cache.ts:118`), passed explicitly by `inspect_projects`.

### The memory layer is bounded by entries; the disk layer by a sweep

Both layers are bounded, but by different mechanisms and against different things — a count ceiling on one side, a time-and-size sweep on the other. Neither is a byte budget for the values themselves.

The in-process `Map` holds at most `MAX_MEMORY_ENTRIES = 64` entries (`src/cache.ts:50`). Writes go through `remember` (`src/cache.ts:180`), which is the only place `memory.set` is called:

```ts
// src/cache.ts:180-189
function remember(key: string, entry: CacheEntry<unknown>): void {
  memory.delete(key)
  memory.set(key, entry)
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}
```

Three rules this encodes, each of which has been violated once already:

1. **`delete` then `set` is the whole LRU.** `Map` iterates in insertion order, so re-inserting a key moves it to the back; eviction takes from the front. No linked list, no dependency — and `dependencies: {}` is a hard constraint here, so `lru-cache` is not an option.
2. **A hit refreshes position but must NOT touch `at`.** Refreshing `at` would turn `MEMORY_TTL_MS` into a sliding window: an entry read every four minutes would never expire, and the TTL would stop meaning "how old is this evidence".
3. **An aged disk entry is served, not backfilled.** `src/cache.ts:417` guards the backfill with `ageMs < MEMORY_TTL_MS`. Without that guard, a 6-minute-old entry (past the memory TTL, inside the 24 h disk TTL) is re-inserted on every read and judged expired on the next one — it cycles in and out forever, the entry count never falls, and the ceiling is decorative.

The ceiling bounds **entries, not bytes**: 64 entries of 1 MB each is still 64 MB resident, and no count-based cap can prevent that. Measured with `node --expose-gc` (`.scratch/heap-ceiling.mjs`): realistic post-R1 payloads (30 candidates × 512-char descriptions, ~20 KB each) cost **1.67 MB** for 64 entries; adversarial ~1.1 MB payloads cost **65.29 MB**. This is acceptable only because the sole writer is the `search` path, which stores `RepoCandidate[]` with `limit` bounded by the caller. **A future caller that caches file contents or issue lists would need a byte cap**, and the place to compute it is before the write — `cacheSet` is already `async`, so one `JSON.stringify(data).length` is affordable there, while estimating on every read is not.

`cacheMemoryStats()` (`src/cache.ts:477`) exposes `{ entries, maxEntries }` so the bound is assertable rather than something a reader has to infer from the code. Eviction costs a hit, never a correct answer: an evicted key falls through to disk, and a key in neither layer is a plain miss.

### The disk layer is reclaimed by an opportunistic sweep

Before this existed, nothing in `src/` ever deleted a cache file. `cacheGetWithMeta` enforced the TTL by *refusing to return* an expired entry; the file stayed. The directory was therefore an append-only log: on the machine this was measured on, 28 of 41 files (6.6 MB of 11.2 MB) were past the 24 h TTL and unreachable, and only a human deleting the directory ever removed them.

`sweepOnce()` (`src/cache.ts:260`) now reclaims three things, in this order:

1. `*.tmp-*` files older than `TMP_STALE_MS = 10 * 60 * 1000` (`src/cache.ts:84`) — orphans left by a process killed between `writeFile` and `rename`.
2. `.json` files older than `DISK_TTL_MS` — provably expired.
3. Enough of the rest, oldest first, to bring the directory under `CACHE_DIR_MAX_BYTES = 64 * 1024 * 1024` (`src/cache.ts:74`).

Four rules, each of which a plausible implementation gets wrong:

1. **Staleness is judged from `mtime`, not from the envelope's `fetchedAt`.** Reading and parsing every envelope to find the timestamp costs 11 MB of I/O to reclaim 6.6 MB — the cleanup would cost more than the space. `cacheSet` writes a temp file and then renames it, and `rename` updates `mtime`, so `mtime` is never earlier than `fetchedAt`: "mtime is old" implies "fetchedAt is old" implies the entry is certainly dead. The converse (fresh `mtime` over an old `fetchedAt`) is left alone, which is the safe direction. Real TTL enforcement stays in `cacheGetWithMeta`.
2. **Expired entries are deleted BEFORE the size cap is computed.** Computing the total first lets a pile of expired garbage trigger the cap and evict fresh entries that were never the problem.
3. **The sweep is throttled and detached.** It runs at most once per hour per process (`SWEEP_INTERVAL_MS`, `src/cache.ts:63`) and `cacheSet` fires it with `void sweepIfDue()` (`src/cache.ts:457`) — never `await`. A `stat` of every file can take hundreds of milliseconds on a slow or network disk, and that must not land on the `scout_projects` hot path. `sweepIfDue` swallows its own failures internally (`src/cache.ts:330`), so the dropped promise cannot become an unhandled rejection; `.catch()` at the call site would not cover a synchronous throw.
4. **`lastSweepAt` is set before the sweep runs, and is not rolled back on failure.** Setting it first stops concurrent writes in one tick from all starting a sweep. Not rolling back stops one unwritable directory from making *every* subsequent write retry the same doomed sweep.

Two consequences worth knowing before changing this code:

- **The throttle is process-wide state starting at 0**, so only the first `cacheSet` of a process is guaranteed to sweep. That is why `test/cache-disk-gc.test.mjs` asserts the automatic path in its first section — later sections can only observe the throttled (no-sweep) case.
- **The sweep only deletes files it recognises.** It skips non-`.json` names and anything that is not a regular file, and it never removes the directory itself or recurses. A directory named `subdir.json` survives.

`cacheSweepNow()` (`src/cache.ts:350`) bypasses the throttle for tests and diagnostics, mirroring `cacheMemoryStats`. Normal operation never calls it.

Measured on a copy of a real cache directory (`.scratch/gc-real-probe.mjs`, 41 files / 11,215,236 B): `removed=28`, `bytesFreed=6,647,153`, leaving 13 files / 4,568,083 B with **0** stale files, **0** survivors modified, and **0** fresh files deleted.


### Read path

```ts
// src/cache.ts:365-368 — value only
export async function cacheGet<T>(key: string, ttlMs: number = DISK_TTL_MS): Promise<T | undefined>

// src/cache.ts:388-392 — value plus the age of the evidence
export async function cacheGetWithMeta<T>(
  key: string,
  ttlMs: number = DISK_TTL_MS,
  snapshot?: string,
): Promise<CacheHit<T> | undefined>
```

`cacheGetWithMeta` checks memory first, with the effective TTL capped at the memory TTL:

```ts
// src/cache.ts:396
if (hit !== undefined && matches(hit.snapshot) && Date.now() - hit.at < Math.min(MEMORY_TTL_MS, ttlMs)) {
```

then falls through to disk, where **every** rejection is a plain `undefined`:

```ts
// src/cache.ts:407-423
const parsed = JSON.parse(await readFile(cachePathFor(key), 'utf8')) as DiskEnvelope<T>
if (parsed?.version !== CACHE_VERSION) return undefined
if (!matches(parsed.snapshot)) return undefined
const at = Date.parse(parsed.fetchedAt) || 0
const ageMs = Date.now() - at
if (ageMs >= ttlMs) return undefined
if (ageMs < MEMORY_TTL_MS) remember(key, { at, data: parsed.data, ... })
return { data: parsed.data, fetchedAt: parsed.fetchedAt, ageMs }
} catch {
  return undefined
}
```

Note `Date.parse(parsed.fetchedAt) || 0`: an unparseable timestamp becomes `0`, which makes `ageMs` enormous and the entry expire. A corrupt timestamp fails closed.

### Write path

```ts
// src/cache.ts:438-461 (abridged)
export async function cacheSet<T>(key: string, data: T, snapshot?: string): Promise<void> {
  remember(key, { at: Date.now(), data, ...(snapshot !== undefined ? { snapshot } : {}) })
  try {
    await mkdir(cacheDir(), { recursive: true })
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(envelope), 'utf8')
    await rename(temp, path)
    void sweepIfDue() // reclaim expired/oversized entries, never awaited
  } catch {
    // Cache writes are best-effort; the next call simply refetches.
  }
}
```

Three conventions worth copying if this ever becomes a real store:

1. **Atomic write.** Temp file named with the pid, then `rename`. A crash mid-write cannot leave half-written JSON that would poison later reads.
2. **Swallowed failure.** An unwritable directory degrades to memory-only rather than failing the tool call.
3. **Maintenance rides along, detached.** The sweep is triggered only after a successful write and is dropped with `void`, so it can never delay or fail the write it follows. Note that a `void` call inside the `try` still contributes to it only synchronously — the promise it returns is not awaited, so a rejection there would escape this `catch`, which is exactly why `sweepIfDue` catches internally.

### Key naming

Keys are **not** table names. They are strings built by the caller and hashed into filenames:

```ts
// src/types.ts:1044-1052
export function searchCacheKeyFor(idea, keywords, limit, authenticated = false, plan = SEARCH_PLAN_VERSION): CacheKey {
  return `${cacheKeyFor(idea)}|kw:${kw}|n:${limit}|auth:${authenticated ? 1 : 0}|p:${plan}`
}
```

`cachePathFor` (`src/cache.ts:227-236`) turns that into a filename: a slug (non-alphanumerics collapsed to `-`, trimmed, `.slice(0, 48)`) plus a djb2 hash over UTF-16 code units rendered in base 36.

```
${slug || 'idea'}-${hash.toString(36)}.json
```

The hash is not decoration: "Ideas are arbitrary user text, so the key is hashed rather than embedded — otherwise a long idea or one containing `..` or path separators would escape the cache directory or exceed filename limits" (`src/cache.ts:217-226`).

`DSH_HOME` resolution (`src/cache.ts:204-210`) mirrors the host convention: `$DSH_HOME` when set and non-blank (blank counts as unset), else `~/.dsh`, with `~`, `~/` and `~\` expanded.

---

## Migrations

There is no migration system. The single mechanism is a version constant that **invalidates** rather than upgrades:

```ts
// src/cache.ts:32
const CACHE_VERSION = 3
```

It is module-private — not exported, not settable, not readable from outside. The only migration story is "old entries are ignored and refetched".

### The rule

> **A new REQUIRED field in the cached shape needs a `CACHE_VERSION` bump. An optional field does not.**

The reasoning is at `src/cache.ts:127-142`, and it is worth reading in full before touching the envelope:

- A new **required** field is dangerous because an entry written before the field existed reads back with it `undefined`, and "any `!== expected` test would then pass for every stale entry".
- An optional field does not have that shape. The dangerous direction is "old entry, new reader": the new reader passes a `snapshot` and the old entry has none, so it is rejected and refetched. The harmless direction — "stamped entry, old reader" — cannot happen, because the reader is the code being changed.
- Conclusion: "So stale entries cost one re-fetch, never a wrong answer, and the whole cache does not need to be thrown away for one field."

### The bumps that happened, and why they were load-bearing

Version 1 -> 2, because `CachedSearch` gained a `thin` field:

> "The bump is load-bearing, not bookkeeping. Without it an entry written by version 1 is read back with `thin === undefined`, and the replay path's `hit.thin !== null` test would be TRUE for every one of them — relabelling every clean cached search as a short one. Ignoring the old entries costs one re-fetch per distinct idea; reading them costs a wrong answer that looks right, which is the trade this constant exists to make." — `src/cache.ts:12-21`

Version 2 -> 3, because `RepoCandidate.description` is now capped at 512 characters when stored (`MAX_STORED_DESCRIPTION_CHARS`, `src/github.ts:450`). A version-2 entry holds a different description length for the same repository, so the same query would report a different description depending on whether it came from disk or from the network — silently, with the "（描述过长，原长 N 字符）" marker reporting 241,896 one day and 512 the next for an unchanged row. Same trade: one re-fetch per distinct idea buys a consistent answer.

Note what that second bump is **not**. No field was added or removed and the shape is identical. It exists because the *stored values* changed meaning, which is a third trigger beside the two the rule above names:

| Change | Bump? | Why |
|--------|-------|-----|
| New required field | **Yes** | Old entries read it back as `undefined`; `!== expected` tests pass for every stale entry |
| New optional field | No | Old entries are rejected by the `snapshot` check and refetched; the dangerous direction cannot happen |
| Stored value changes meaning or range | **Yes** | The shape is unchanged, so nothing catches the drift — old and new values mix and are reported as if identical |

**This is the pattern to follow.** A version bump here is not "clear the cache"; it is the difference between a cheap re-fetch and a plausible wrong answer.

### Producer stamps (`snapshot`)

A second, finer invalidation axis exists alongside the version: an optional `snapshot` string recording **which producer** wrote the entry.

```ts
// src/cache.ts:143-148
interface DiskEnvelope<T> {
  version: number
  fetchedAt: string
  snapshot?: string
  data: T
}
```

The rule (`src/cache.ts:388-393`): when a caller passes a `snapshot`, an entry stamped with anything else — **including an entry written before stamping existed** — is treated as a miss.

> "a cached inspection produced by an older scanner answers a different question than the one being asked, and silently replaying it would attribute the old scanner's silence to the new one. Re-fetching is the honest outcome." — `src/cache.ts:376-381`

The stamps in use are the producer version constants: `SELECTOR_VERSION` (`src/select.ts:305`) and `SCANNER_VERSION` (`src/skeleton.ts:148`), combined at `src/index.ts:1725` and `:1878` as `` `sel:${SELECTOR_VERSION}:scan:${SCANNER_VERSION}` ``.

There is a third version constant that is **not** a cache version and must not be confused with one: `SEARCH_PLAN_VERSION = 7` (`src/types.ts:1008`) versions the *search strategy*, and it participates in the cache **key** (`src/types.ts:1044-1052`), not the envelope. `CACHE_VERSION` versions the on-disk *shape*. Bump the wrong one and you either fail to invalidate or you throw away a day of quota for nothing.

---

## Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Cache directory | `join(dshHome(), 'cache', '<package-name>')` | `~/.dsh/cache/dsh-find-ideas/` (`src/cache.ts:213-215`) |
| Cache file | `<slug>-<base36 hash>.json` | `local-first-note-app-1a2b3c.json` (`src/cache.ts:227-236`) |
| Cache key | pipe-delimited `k:v` segments | `…|kw:…|n:20|auth:0|p:7` (`src/types.ts:1044-1052`) |
| Envelope fields | `camelCase` | `version`, `fetchedAt`, `snapshot`, `data` (`src/cache.ts:143-148`) |
| Timestamps | ISO 8601 **string** on disk, epoch **number** in memory | `fetchedAt: string` vs `CacheEntry.at: number` |
| Version constants | `SCREAMING_SNAKE_CASE`, suffixed `_VERSION` | `CACHE_VERSION`, `SELECTOR_VERSION`, `SCANNER_VERSION`, `SEARCH_PLAN_VERSION` |
| TTL constants | `SCREAMING_SNAKE_CASE`, suffixed `_TTL_MS`, expressed as arithmetic | `MEMORY_TTL_MS = 5 * 60 * 1000` |
| Temp file | `<path>.tmp-<pid>` | `src/cache.ts:443` |

Note the deliberate asymmetry in timestamp representation: the in-memory entry stores `at` as a number because it is compared arithmetically on every read, while the disk envelope stores an ISO string because a human may open the file. `cacheGetWithMeta` converts between them.

---

## Common Mistakes

| Mistake | Why it is wrong | Where |
|---------|----------------|-------|
| Adding a required field without bumping `CACHE_VERSION` | Stale entries read it back as `undefined`; `!== expected` tests then pass for every one of them | `src/cache.ts:12-31`, `:127-142` |
| Bumping `CACHE_VERSION` for an optional field | Throws away a day of saved quota for a change that is already safe | `src/cache.ts:130-141` |
| Confusing `CACHE_VERSION` with `SEARCH_PLAN_VERSION` | One versions the disk shape, the other the search strategy and the cache *key* | `src/cache.ts:32` vs `src/types.ts:1008` |
| Recomputing a stored number from the rows instead of reading it back | The cached path once recomputed `tail_included` as `candidates.filter(c => c.stars <= TAIL_STAR_CEILING).length` — a different question — so the same search reported one number cold and another on replay | `src/index.ts:862-869` |
| Letting a cache failure fail the call | A cache is an optimisation; the correct degradation is a refetch | `src/cache.ts:354-359` |
| Writing the disk file in place | A crash mid-write leaves half-written JSON that poisons every later read | `src/cache.ts:426-432` |
| Storing a source read under the 24h default | File *contents* change whenever the project ships; a day-old copy silently describes last week's code | `src/cache.ts:96-117` |
| Presenting a cached observation as a live one | A replay must be able to say how old its evidence is — hence `cacheGetWithMeta` and `CacheHit.ageMs` | `src/cache.ts:150-165`, `:370-381` |
| Replaying an entry produced by an older scanner | It answers a different question; the silence of the old scanner would be attributed to the new one | `src/cache.ts:376-381` |
| Embedding user text directly in a filename | A long idea, or one containing `..` or a path separator, escapes the cache directory or exceeds filename limits | `src/cache.ts:217-226` |
| Assuming the cache directory exists | It is created on write with `recursive: true`, and its absence is not an error | `src/cache.ts:441` |
