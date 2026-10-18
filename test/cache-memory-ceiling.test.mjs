// Behavioural tests for the in-process cache ceiling.
//
// WHY THIS FILE EXISTS
// --------------------
// `memory` was a module-level Map that only ever grew: `cacheSet` wrote to it,
// disk hits backfilled into it, and nothing but `cacheClearMemory()` ever
// removed anything. A process that ran for a week accumulated every candidate
// list it had ever fetched, and because the values are parsed JSON rather than
// UTF-8 bytes, the resident cost was larger than the file sizes suggested.
//
// The bound added here is a count ceiling plus LRU ordering, with two rules that
// are easy to get wrong and are therefore asserted directly:
//
//   1. A hit REFRESHES the entry's position but must NOT touch its `at`. If it
//      did, the five-minute memory TTL would become a sliding window and an
//      entry read every few minutes would never expire.
//   2. A disk hit older than the memory TTL must NOT be backfilled. Otherwise a
//      six-minute-old entry cycles in on every read and is immediately judged
//      expired on the next one: the entry count never falls and the ceiling is
//      decorative.
//
// Eviction must never change an ANSWER, only a hit rate. An evicted key falls
// through to disk; a key absent from both is a plain miss.
//
// CACHE PATHS ARE SANDBOXED, same as `cache.test.mjs`: DSH_HOME is redirected to
// a scratch directory BEFORE the module is imported, so these assertions cannot
// pass against the real user cache.
//
// Run with:  npm test
// Or directly: node test/cache-memory-ceiling.test.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

// Redirect the cache to a scratch directory before anything reads DSH_HOME.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-ceiling-test-'))
process.env.DSH_HOME = scratch
const cacheDir = join(scratch, 'cache', 'dsh-find-ideas')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`)
  }
}

const { cacheGet, cacheSet, cacheGetWithMeta, cacheClearMemory, cacheMemoryStats } = await load('cache.js')

/**
 * Delete the on-disk file for a key, leaving memory untouched.
 *
 * This is the only way to ask "is this key resident?" from outside the module
 * without exporting the Map itself: if the value still comes back with the disk
 * copy gone, it was in memory. Counting entries cannot answer it, because a
 * disk read backfills and then evicts, leaving the count unchanged.
 */
function dropDiskFile(key) {
  const slug = key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'idea'
  const files = readdirSync(cacheDir).filter((name) => name.startsWith(`${slug}-`))
  for (const name of files) rmSync(join(cacheDir, name))
  return files.length
}

/** Rewrite the `fetchedAt` of a key's on-disk envelope, so it looks older. */
function ageDiskFile(key, ageMs) {
  const slug = key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'idea'
  const name = readdirSync(cacheDir).find((entry) => entry.startsWith(`${slug}-`))
  if (name === undefined) throw new Error(`no disk file for ${key}`)
  const path = join(cacheDir, name)
  const envelope = JSON.parse(readFileSync(path, 'utf8'))
  envelope.fetchedAt = new Date(Date.now() - ageMs).toISOString()
  writeFileSync(path, JSON.stringify(envelope), 'utf8')
}

// ---------------------------------------------------------------------------
console.log('\n=== D1. the ceiling holds ===')
{
  cacheClearMemory()
  const start = cacheMemoryStats()
  check('a fresh process holds nothing', start.entries === 0, JSON.stringify(start))
  check('the ceiling is 64', start.maxEntries === 64, JSON.stringify(start))

  for (let i = 0; i < 100; i++) await cacheSet(`ceiling-key-${i}`, { i })
  const after = cacheMemoryStats()
  check('writing 100 distinct keys leaves exactly 64 resident', after.entries === 64, JSON.stringify(after))
  check('the ceiling is not exceeded by a single write', after.entries <= after.maxEntries, JSON.stringify(after))
}

// ---------------------------------------------------------------------------
console.log('\n=== D2. eviction takes the least recently used, and a read refreshes ===')
{
  cacheClearMemory()
  for (let i = 0; i < 64; i++) await cacheSet(`lru-${i}`, { i })

  // Reading 0 must move it to the back of the insertion order.
  await cacheGet('lru-0')

  // This write overflows by one, so the front of the order is evicted. Without
  // the refresh that would be lru-0; with it, lru-1.
  await cacheSet('lru-64', { i: 64 })
  check('still exactly 64 resident after the overflow', cacheMemoryStats().entries === 64)

  // Decisive residency probes: remove the disk copy first, so a value that still
  // comes back can only have come from memory.
  dropDiskFile('lru-0')
  const kept = await cacheGet('lru-0')
  check('the recently read key survived eviction', kept?.i === 0, JSON.stringify(kept))

  dropDiskFile('lru-1')
  const evicted = await cacheGet('lru-1')
  check('the least recently used key was the one evicted', evicted === undefined, JSON.stringify(evicted))
}

// ---------------------------------------------------------------------------
console.log('\n=== D3. eviction costs a hit, never a correct answer ===')
{
  cacheClearMemory()
  for (let i = 0; i < 64; i++) await cacheSet(`correct-${i}`, { i, marker: `value-${i}` })

  // Overflow so correct-0 is evicted.
  await cacheSet('correct-64', { i: 64, marker: 'value-64' })

  const fromDisk = await cacheGet('correct-0')
  check('an evicted key is still readable from disk', fromDisk?.marker === 'value-0', JSON.stringify(fromDisk))
  check('and it comes back with the same value, not a re-fetch', fromDisk?.i === 0, JSON.stringify(fromDisk))

  const missing = await cacheGet('never-written-at-all')
  check('a key absent from both layers is a plain miss', missing === undefined)
}

// ---------------------------------------------------------------------------
console.log('\n=== D4. an entry older than the memory TTL is not backfilled ===')
{
  cacheClearMemory()
  await cacheSet('aged-entry', { marker: 'aged' })
  ageDiskFile('aged-entry', 6 * 60 * 1000) // six minutes: past memory TTL, inside disk TTL
  cacheClearMemory()

  const first = await cacheGet('aged-entry')
  check('a six-minute-old entry is still served (disk TTL is 24h)', first?.marker === 'aged', JSON.stringify(first))
  check('and it is NOT put back into memory', cacheMemoryStats().entries === 0, JSON.stringify(cacheMemoryStats()))

  const second = await cacheGet('aged-entry')
  check('a second read still returns the value', second?.marker === 'aged', JSON.stringify(second))
  check('and the count still has not grown', cacheMemoryStats().entries === 0, JSON.stringify(cacheMemoryStats()))
}

// ---------------------------------------------------------------------------
console.log('\n=== D5. refreshing a hit does not extend its lifetime ===')
{
  cacheClearMemory()
  await cacheSet('stable-at', { marker: 'stable' })

  const first = await cacheGetWithMeta('stable-at')
  const second = await cacheGetWithMeta('stable-at')
  check('two reads report the same write timestamp', first?.fetchedAt === second?.fetchedAt, `${first?.fetchedAt} vs ${second?.fetchedAt}`)
  check('the reported age grows rather than resetting', (second?.ageMs ?? -1) >= (first?.ageMs ?? 0), `${first?.ageMs} -> ${second?.ageMs}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== D6. cacheClearMemory still empties the map ===')
{
  await cacheSet('clear-a', 1)
  await cacheSet('clear-b', 2)
  check('entries before clearing', cacheMemoryStats().entries >= 2, JSON.stringify(cacheMemoryStats()))
  cacheClearMemory()
  check('entries after clearing is zero', cacheMemoryStats().entries === 0, JSON.stringify(cacheMemoryStats()))
  const afterClear = await cacheGet('clear-a')
  check('and the value still comes back from disk', afterClear === 1, JSON.stringify(afterClear))
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
rmSync(scratch, { recursive: true, force: true })
