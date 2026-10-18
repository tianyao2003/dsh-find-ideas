/**
 * Two-layer cache (in-process + on-disk) for GitHub search results.
 *
 * `DSH_HOME` resolution mirrors the established harness convention:
 * `$DSH_HOME` when set and non-blank (blank means unset), else `~/.dsh`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Bump when the on-disk shape changes, so stale entries are ignored.
 *
 * 1 -> 2: `CachedSearch` gained a `thin` field, recording why a fetch came back
 * short. The bump is load-bearing, not bookkeeping. Without it an entry written
 * by version 1 is read back with `thin === undefined`, and the replay path's
 * `hit.thin !== null` test would be TRUE for every one of them — relabelling
 * every clean cached search as a short one. Ignoring the old entries costs one
 * re-fetch per distinct idea; reading them costs a wrong answer that looks
 * right, which is the trade this constant exists to make.
 *
 * 2 -> 3: `RepoCandidate.description` is now capped at 512 characters when it is
 * stored (`MAX_STORED_DESCRIPTION_CHARS` in `github.ts`), so a version-2 entry
 * holds a description of a different length for the same repository. Mixing the
 * two would make the same query report a different description depending on
 * whether it came from disk or from the network — and it would do so silently,
 * with the "（描述过长，原长 N 字符）" marker reporting 241,896 one day and 512
 * the next for an unchanged row. Same trade as 1 -> 2: one re-fetch per distinct
 * idea buys a consistent answer.
 */
const CACHE_VERSION = 3

/** In-process hits are cheap but short-lived. */
const MEMORY_TTL_MS = 5 * 60 * 1000

/** Disk survives restarts; a day balances freshness against rate-limit budget. */
const DISK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Disk TTL for repository source reads, which age far faster than "which repos
 * exist".
 *
 * The 24h default is right for a candidate list: the set of repositories
 * matching an idea changes slowly, and a day of hits is a day of saved quota.
 * It is wrong for `inspect_projects`, because what it caches is file CONTENTS —
 * a README, a manifest, a few source files. Those change whenever the project
 * ships, and 24 hours makes an inspection silently describe last week's code
 * with no marker saying so.
 *
 * The asymmetry that decides this: a stale candidate list is mildly wrong (you
 * see a repo that was renamed), while a stale source read is SPECIFICALLY wrong
 * — it reports a package.json that no longer says what it says, and the whole
 * point of `inspect_projects` is to be the step whose evidence can be trusted.
 * `files_read` makes the claim "this is what the code says"; a day-old copy can
 * quietly make that claim false.
 *
 * 10 minutes still absorbs the real repeat pattern (re-reading the same repo
 * while drafting a plan, and repeated calls within one turn) while keeping the
 * worst case close to "the code as of a few minutes ago".
 */
export const SOURCE_TTL_MS = 10 * 60 * 1000

interface CacheEntry<T> {
  at: number
  data: T
  /** Producer stamp this entry was written under, when one was given. */
  snapshot?: string
}

/**
 * On-disk wrapper around one cached value.
 *
 * `snapshot` is optional and is NOT version-bumped into existence, which is worth
 * spelling out because the absence of a bump looks like an oversight.
 *
 * A new REQUIRED field would need a `CACHE_VERSION` bump: an entry written before
 * the field existed reads back with it `undefined`, and any `!== expected` test
 * would then pass for every stale entry — the 1 -> 2 bump exists for exactly that
 * failure. An optional field does not have that shape. The dangerous direction is
 * "old entry, new reader": here the new reader passes a `snapshot` and the old
 * entry has none, so it is rejected and refetched. The harmless direction —
 * "stamped entry, old reader" — cannot happen, because the reader is the code
 * being changed. So stale entries cost one re-fetch, never a wrong answer, and
 * the whole cache does not need to be thrown away for one field.
 */
interface DiskEnvelope<T> {
  version: number
  fetchedAt: string
  snapshot?: string
  data: T
}

/**
 * A cache read that kept the metadata, for callers that must report how old the
 * evidence is rather than just consume it.
 *
 * `cacheGet` throws this away on purpose: most callers only want the value. The
 * inspection cache is the exception — it serves file CONTENTS, and a replay that
 * cannot say "this is a 4-minute-old read" would be presenting a snapshot as a
 * live observation.
 */
export interface CacheHit<T> {
  data: T
  /** ISO 8601 timestamp of the write this hit came from. */
  fetchedAt: string
  /** Milliseconds elapsed since that write, measured at this read. */
  ageMs: number
}

const memory = new Map<string, CacheEntry<unknown>>()

/** `~` / `~/` / `~\` against the OS home, matching the host's own expansion. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home directory.
 *
 * A blank `DSH_HOME` counts as unset rather than as the literal empty path.
 *
 * @returns absolute path to the harness home.
 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return resolve(expandHome(fromEnv.trim()))
  }
  return join(homedir(), '.dsh')
}

/** Directory holding this plugin's cache files. */
function cacheDir(): string {
  return join(dshHome(), 'cache', 'dsh-find-ideas')
}

/**
 * Filesystem-safe path for one cache key.
 *
 * Ideas are arbitrary user text, so the key is hashed rather than embedded —
 * otherwise a long idea or one containing `..` or path separators would escape
 * the cache directory or exceed filename limits.
 *
 * @param key - normalized cache key.
 * @returns absolute file path.
 */
function cachePathFor(key: string): string {
  const slug = key
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  // djb2 over UTF-16 code units: short, stable, no crypto import needed.
  let hash = 5381
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0
  return join(cacheDir(), `${slug || 'idea'}-${hash.toString(36)}.json`)
}

/**
 * Read a cached value, preferring memory then disk.
 *
 * Every failure (missing file, malformed JSON, version drift, expiry) returns
 * `undefined` — the caller refetches. A cache must never be able to fail a call.
 *
 * @param key - normalized cache key.
 * @param ttlMs - disk lifetime for this entry; defaults to {@link DISK_TTL_MS}.
 *   Source reads pass a much shorter one.
 * @returns the cached value, or `undefined` on miss.
 */
export async function cacheGet<T>(key: string, ttlMs: number = DISK_TTL_MS): Promise<T | undefined> {
  const hit = await cacheGetWithMeta<T>(key, ttlMs)
  return hit?.data
}

/**
 * Read a cached value and keep the metadata that {@link cacheGet} discards.
 *
 * Two callers need this and they need it for the same reason: they are about to
 * present the value as evidence, and evidence has an age.
 *
 * `snapshot` is the producer stamp described on {@link DiskEnvelope}. When the
 * caller passes one, an entry stamped with anything else — including an entry
 * written before stamping existed — is treated as a MISS. That is the whole
 * point: a cached inspection produced by an older scanner answers a different
 * question than the one being asked, and silently replaying it would attribute
 * the old scanner's silence to the new one. Re-fetching is the honest outcome.
 *
 * @param key - normalized cache key.
 * @param ttlMs - disk lifetime for this entry.
 * @param snapshot - optional producer stamp the entry must match.
 * @returns the cached value with its timestamp, or `undefined` on miss.
 */
export async function cacheGetWithMeta<T>(
  key: string,
  ttlMs: number = DISK_TTL_MS,
  snapshot?: string,
): Promise<CacheHit<T> | undefined> {
  const matches = (stamp: string | undefined): boolean => snapshot === undefined || stamp === snapshot

  const hit = memory.get(key)
  if (hit !== undefined && matches(hit.snapshot) && Date.now() - hit.at < Math.min(MEMORY_TTL_MS, ttlMs)) {
    return { data: hit.data as T, fetchedAt: new Date(hit.at).toISOString(), ageMs: Date.now() - hit.at }
  }

  try {
    const parsed = JSON.parse(await readFile(cachePathFor(key), 'utf8')) as DiskEnvelope<T>
    if (parsed?.version !== CACHE_VERSION) return undefined
    if (!matches(parsed.snapshot)) return undefined
    const at = Date.parse(parsed.fetchedAt) || 0
    const ageMs = Date.now() - at
    if (ageMs >= ttlMs) return undefined
    memory.set(key, { at, data: parsed.data, ...(parsed.snapshot !== undefined ? { snapshot: parsed.snapshot } : {}) })
    return { data: parsed.data, fetchedAt: parsed.fetchedAt, ageMs }
  } catch {
    return undefined
  }
}

/**
 * Persist a value to both layers.
 *
 * The disk write is atomic (temp file + rename) so a crash mid-write cannot
 * leave a half-written JSON file that would poison later reads. Failures are
 * swallowed: an unwritable cache directory degrades to memory-only.
 *
 * @param key - normalized cache key.
 * @param data - lossless-JSON value to store.
 * @param snapshot - optional producer stamp, recorded so a later reader can
 *   refuse entries its producer would no longer stand behind.
 */
export async function cacheSet<T>(key: string, data: T, snapshot?: string): Promise<void> {
  memory.set(key, { at: Date.now(), data, ...(snapshot !== undefined ? { snapshot } : {}) })
  try {
    await mkdir(cacheDir(), { recursive: true })
    const path = cachePathFor(key)
    const temp = `${path}.tmp-${process.pid}`
    const envelope: DiskEnvelope<T> = {
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      ...(snapshot !== undefined ? { snapshot } : {}),
      data,
    }
    await writeFile(temp, JSON.stringify(envelope), 'utf8')
    await rename(temp, path)
  } catch {
    // Cache writes are best-effort; the next call simply refetches.
  }
}

/** Drop every in-process entry. Used by tests. */
export function cacheClearMemory(): void {
  memory.clear()
}
