// Behavioural tests for the on-disk cache sweep.
//
// WHY THIS FILE EXISTS
// --------------------
// Nothing in `src/` ever deleted a cache file. `cacheSet` only wrote, and
// `cacheGetWithMeta` enforced the TTL by REFUSING to return an expired entry —
// the file stayed on disk forever. The directory was therefore not a cache but
// an append-only log: on the machine this was measured on, 26 of 41 files
// (6.6 MB of 11.2 MB) were past the 24 h TTL and unreachable, and the only thing
// that ever removed them was a human deleting the directory.
//
// The sweep reclaims three things, and each is asserted separately because each
// has its own way of going wrong:
//
//   1. `*.tmp-*` files older than ten minutes — orphans from a process killed
//      between `writeFile` and `rename`.
//   2. `.json` files older than the disk TTL — provably expired.
//   3. Enough of the rest to bring the directory under 64 MB, oldest first.
//
// Two ordering rules matter and are easy to invert:
//
//   - Expired entries are deleted BEFORE the size cap is computed. Computing the
//     total first lets expired garbage trigger the cap and evict fresh entries.
//   - Staleness is judged from `mtime`, not from the envelope's `fetchedAt`.
//     `cacheSet` renames the temp file into place and rename updates `mtime`, so
//     `mtime` is never earlier than `fetchedAt`: "mtime is old" therefore implies
//     "fetchedAt is old". Reading every envelope to check would cost more I/O
//     than the space it reclaims.
//
// CACHE PATHS ARE SANDBOXED: `DSH_HOME` points at a scratch directory, and each
// section gets its own root so a leftover file cannot make a later assertion
// pass. `dshHome()` reads the environment on every call, so switching roots
// mid-process is legitimate here.
//
// THE FIRST SECTION MUST RUN FIRST. `lastSweepAt` is module state that starts at
// 0, and only the first `cacheSet` of the process is guaranteed to find the
// hourly throttle open. That is the one chance to observe the automatic path, so
// G1 takes it before anything else writes.
//
// Run with:  npm test
// Or directly: node test/cache-disk-gc.test.mjs
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-gc-test-'))
let rootCount = 0

/**
 * Point the cache at a fresh root and create its directory.
 *
 * A new root per section keeps the file counts small enough to reason about
 * exactly, which is the whole point of testing a deleter.
 */
function useRoot() {
  const root = join(scratch, `root-${++rootCount}`)
  process.env.DSH_HOME = root
  const dir = join(root, 'cache', 'dsh-find-ideas')
  mkdirSync(dir, { recursive: true })
  return dir
}

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

const { cacheGet, cacheSet, cacheSweepNow, cacheClearMemory } = await load('cache.js')

const HOUR = 60 * 60 * 1000

/**
 * Plant a file with a chosen name, age and size.
 *
 * The mtime is set explicitly with `utimes` rather than by faking `Date.now`:
 * `test/cache.test.mjs` warns that faking the clock breaks the TTL arithmetic
 * everywhere else, and the sweep reads a real filesystem timestamp anyway.
 */
async function plant(dir, name, ageMs, bytes = 64) {
  const path = join(dir, name)
  const envelope = {
    version: 3,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    data: { pad: 'x'.repeat(Math.max(bytes - 96, 1)) },
  }
  writeFileSync(path, JSON.stringify(envelope), 'utf8')
  const stamp = new Date(Date.now() - ageMs)
  await utimes(path, stamp, stamp)
  return path
}

const namesIn = (dir) => readdirSync(dir).sort()
const sizeOf = (dir) => readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
console.log('\n=== G1. the sweep rides along after a write, and is throttled ===')
{
  // MUST be the first section: this is the only cacheSet in the process whose
  // hourly throttle is guaranteed open, so it is the only place the automatic
  // path can be observed at all.
  const dir = useRoot()
  await plant(dir, 'stale-one-aaaa.json', 48 * HOUR)
  check('the planted entry exists before the write', namesIn(dir).length === 1, namesIn(dir).join(','))

  await cacheSet('trigger-key', { marker: 'trigger' })
  await wait(300) // sweepIfDue is deliberately not awaited, so give it a turn

  check('a write swept the expired entry without being asked', !namesIn(dir).includes('stale-one-aaaa.json'), namesIn(dir).join(','))
  check('the entry the write just created survived', namesIn(dir).some((name) => name.startsWith('trigger-key-')), namesIn(dir).join(','))

  // The throttle is now closed for the rest of this process, which makes the
  // negative case observable: another expired file, another write, no sweep.
  await plant(dir, 'stale-two-bbbb.json', 48 * HOUR)
  await cacheSet('second-trigger', { marker: 'second' })
  await wait(300)
  check('a second write within the hour does NOT sweep again', namesIn(dir).includes('stale-two-bbbb.json'), namesIn(dir).join(','))

  const forced = await cacheSweepNow()
  check('cacheSweepNow ignores the throttle', !namesIn(dir).includes('stale-two-bbbb.json'), namesIn(dir).join(','))
  check('and reports what it removed', forced.removed >= 1, JSON.stringify(forced))
  check('and how many bytes that freed', forced.bytesFreed > 0, JSON.stringify(forced))
}

// ---------------------------------------------------------------------------
console.log('\n=== G2. expired entries go, fresh ones stay ===')
{
  const dir = useRoot()
  await plant(dir, 'expired-cccc.json', 48 * HOUR)
  await plant(dir, 'fresh-dddd.json', 1 * HOUR)
  await plant(dir, 'nearly-eeee.json', 23 * HOUR)

  const result = await cacheSweepNow()
  check('the 48-hour-old entry was removed', !namesIn(dir).includes('expired-cccc.json'), namesIn(dir).join(','))
  check('the 1-hour-old entry survived', namesIn(dir).includes('fresh-dddd.json'), namesIn(dir).join(','))
  check('the 23-hour-old entry survived, it is inside the TTL', namesIn(dir).includes('nearly-eeee.json'), namesIn(dir).join(','))
  check('exactly one file was removed', result.removed === 1, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
console.log('\n=== G3. orphaned temp files are reclaimed, live ones are not ===')
{
  const dir = useRoot()
  // A crash between writeFile and rename leaves `${path}.tmp-${pid}` behind.
  await plant(dir, 'abandoned-ffff.json.tmp-1234', 2 * HOUR)
  await plant(dir, 'inflight-gggg.json.tmp-5678', 30 * 1000) // 30 seconds: could be a live write
  await plant(dir, 'fresh-hhhh.json', 1 * HOUR)

  const result = await cacheSweepNow()
  check('the two-hour-old orphan was removed', !namesIn(dir).includes('abandoned-ffff.json.tmp-1234'), namesIn(dir).join(','))
  check('the 30-second-old temp file was left alone', namesIn(dir).includes('inflight-gggg.json.tmp-5678'), namesIn(dir).join(','))
  check('the fresh entry was left alone', namesIn(dir).includes('fresh-hhhh.json'), namesIn(dir).join(','))
  check('exactly one file was removed', result.removed === 1, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
console.log('\n=== G4. only this plugin\'s own files are touched ===')
{
  const dir = useRoot()
  await plant(dir, 'stale-iiii.json', 48 * HOUR)
  // A file someone else put here, and a directory that merely looks like an
  // entry. Neither is this cache's to delete.
  writeFileSync(join(dir, 'notes.txt'), 'do not delete me', 'utf8')
  const old = new Date(Date.now() - 48 * HOUR)
  await utimes(join(dir, 'notes.txt'), old, old)
  mkdirSync(join(dir, 'subdir.json'))

  const result = await cacheSweepNow()
  check('the expired .json was removed', !namesIn(dir).includes('stale-iiii.json'), namesIn(dir).join(','))
  check('an unrelated .txt file was not', namesIn(dir).includes('notes.txt'), namesIn(dir).join(','))
  check('a directory named like an entry was not', namesIn(dir).includes('subdir.json'), namesIn(dir).join(','))
  check('exactly one file was removed', result.removed === 1, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
console.log('\n=== G5. a missing cache directory is not an error ===')
{
  const root = join(scratch, 'root-never-created')
  process.env.DSH_HOME = root
  // Deliberately NOT created.
  const result = await cacheSweepNow()
  check('sweeping a directory that does not exist reports nothing removed', result.removed === 0, JSON.stringify(result))
  check('and frees nothing', result.bytesFreed === 0, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
console.log('\n=== G6. the size cap evicts oldest-first and stops as soon as it can ===')
{
  const dir = useRoot()
  const MAX = 64 * 1024 * 1024
  const COUNT = 70
  const EACH = 1024 * 1024

  // 70 MB in 70 files, mtimes staggered so file 0 is the oldest.
  const sizes = []
  for (let i = 0; i < COUNT; i++) {
    const path = await plant(dir, `bulk-${String(i).padStart(3, '0')}.json`, (COUNT - i) * 60 * 1000, EACH)
    sizes.push(statSync(path).size)
  }
  const before = sizeOf(dir)
  check('the directory is over budget before the sweep', before > MAX, `${before} vs ${MAX}`)

  const result = await cacheSweepNow()
  const after = sizeOf(dir)
  const survivors = namesIn(dir)

  check('the directory is within budget afterwards', after <= MAX, `${after} vs ${MAX}`)
  check('it did not simply empty the directory', after > MAX - Math.max(...sizes), `${after} vs ${MAX}`)
  check('the number removed matches the number of files that vanished', result.removed === COUNT - survivors.length, `${result.removed} vs ${COUNT - survivors.length}`)

  // Oldest-first is the property that matters: the entries closest to expiring
  // are the ones worth sacrificing. The oldest N are gone, the newest survive.
  const removedIndexes = []
  const keptIndexes = []
  for (let i = 0; i < COUNT; i++) {
    const name = `bulk-${String(i).padStart(3, '0')}.json`
    ;(survivors.includes(name) ? keptIndexes : removedIndexes).push(i)
  }
  check('the oldest entries are the ones that went', removedIndexes.every((i) => i < Math.min(...keptIndexes)), `removed ${removedIndexes.join(',')} kept from ${Math.min(...keptIndexes)}`)
  check('a contiguous oldest-first prefix was removed', removedIndexes.length === 0 || removedIndexes[removedIndexes.length - 1] === removedIndexes.length - 1, removedIndexes.join(','))
}

// ---------------------------------------------------------------------------
console.log('\n=== G7. a write survives the sweep path, and the cache stays usable ===')
{
  const dir = useRoot()
  await plant(dir, 'ancient-jjjj.json', 72 * HOUR)
  cacheClearMemory()

  // G1 already consumed this process's hourly throttle, so this write will not
  // sweep — and that is the documented behaviour, not a gap: the throttle is
  // process-wide state that starts closed after the first sweep. Asserting it
  // here keeps the "the sweep is throttled, not per-write" claim honest.
  await cacheSet('survives-sweep', { marker: 'intact' })
  await wait(300)

  check('the write completed', namesIn(dir).some((name) => name.startsWith('survives-sweep-')), namesIn(dir).join(','))
  check('the throttle kept this write from sweeping', namesIn(dir).includes('ancient-jjjj.json'), namesIn(dir).join(','))

  // The dropped promise in `cacheSet` must not be able to reject unhandled: if
  // it could, this process would have died before reaching this line.
  const forced = await cacheSweepNow()
  check('a forced sweep still reclaims the expired entry', !namesIn(dir).includes('ancient-jjjj.json'), namesIn(dir).join(','))
  check('and the directory holds exactly the new entry', namesIn(dir).length === 1, namesIn(dir).join(','))
  check('the forced sweep reported the removal', forced.removed === 1, JSON.stringify(forced))

  const again = await cacheSweepNow()
  check('a second sweep is a no-op on a clean directory', again.removed === 0, JSON.stringify(again))

  const back = await cacheGet('survives-sweep')
  check('the cache still answers after being swept', back?.marker === 'intact', JSON.stringify(back))
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
rmSync(scratch, { recursive: true, force: true })
