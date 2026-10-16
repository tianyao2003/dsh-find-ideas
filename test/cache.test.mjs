// Behavioural tests for the cache key and the two cache TTLs.
//
// WHY THIS FILE EXISTS
// --------------------
// The README claimed `npm test` "validates the ranking layer, the cache-key
// shape, and the package manifest" — but the test directory contained ZERO
// cache assertions. That claim was false when it was written. These tests make
// it true, by promoting the assertions that previously lived in the
// out-of-package probes (.probe-b1/b2/b3.mjs) into the shipped suite.
//
// The three defects covered here all failed the SAME way: the cache was not
// wrong about what it stored, it was answering a slightly different question
// than the caller asked — plausibly, silently, and with `cached: true` that
// made it look correct.
//   B1  the key omitted auth state, so a thin anonymous result was served to a
//       caller that had since configured a token (GitHub throttles anonymous
//       callers by SILENTLY RETURNING FEWER ROWS, not by erroring)
//   B2  the key omitted the query-plan version, so rows from an old plan were
//       served as the new plan's answer after the query builder changed
//   B3  source files were cached for 24 h, which is fine for "which repos
//       exist" and wrong for "what does this code say"
//
// CACHE PATHS ARE SANDBOXED. The plugin writes under <DSH_HOME>/cache/, and
// `cache.ts` swallows write failures to degrade to memory-only. In a sandbox
// where the real DSH_HOME is not writable, a cache test would silently test
// only the in-memory layer and still report green. So DSH_HOME is redirected to
// a scratch directory first — this must happen BEFORE the module is imported,
// because `dshHome()` reads the variable at call time but the import order is
// what keeps the test honest about which directory it used.
//
// Run with:  npm test
// Or directly: node test/cache.test.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

// Redirect the cache to a scratch directory before anything reads DSH_HOME.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-cache-test-'))
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

const { searchCacheKeyFor, SEARCH_PLAN_VERSION } = await load('types.js')
const { cacheGet, cacheSet, cacheClearMemory, SOURCE_TTL_MS } = await load('cache.js')

// ---------------------------------------------------------------------------
console.log('\n=== C0. GATE: the disk layer is actually reachable ===')
{
  // Without this gate every later assertion would pass against the in-memory
  // map alone, and a broken disk path would look healthy. Same trap that made
  // three earlier probe rounds report green while testing nothing: the cache
  // degrades to memory silently by design.
  const gateKey = 'gate-probe-sentinel-that-no-other-assertion-uses'
  await cacheSet(gateKey, ['gate'])
  const files = readdirSync(cacheDir)
  check('cacheSet writes a file to disk', files.length > 0, `dir=${cacheDir}`)

  // Field names matter: the envelope is { version, fetchedAt, data }, and
  // `fetchedAt` is an ISO string, not a numeric `at`. Reading it back is the
  // only way to know — three earlier probe rounds failed by assuming the shape.
  const onDisk = JSON.parse(readFileSync(join(cacheDir, files[0]), 'utf8'))
  check(
    'the on-disk envelope has the real shape',
    typeof onDisk === 'object' && onDisk !== null && typeof onDisk.version === 'number' && typeof onDisk.fetchedAt === 'string' && 'data' in onDisk,
    JSON.stringify(onDisk).slice(0, 120),
  )
  check('the envelope timestamp parses as a real time', Number.isFinite(Date.parse(onDisk.fetchedAt)), onDisk.fetchedAt)

  cacheClearMemory()
  const afterClear = await cacheGet(gateKey)
  check('after clearing memory the value still comes back', Array.isArray(afterClear) && afterClear[0] === 'gate', JSON.stringify(afterClear))
  check('so subsequent assertions exercise the disk layer', files.length > 0)
}

// ---------------------------------------------------------------------------
console.log('\n=== C1. the key covers every input that changes what is fetched ===')
{
  const base = searchCacheKeyFor('a note app', 'markdown notes', 30, false)

  check('key differs when the idea differs', searchCacheKeyFor('a different app', 'markdown notes', 30, false) !== base)
  check('key differs when keywords differ', searchCacheKeyFor('a note app', 'other terms', 30, false) !== base)
  check('key differs when limit differs', searchCacheKeyFor('a note app', 'markdown notes', 10, false) !== base)
  check('key differs when auth state differs', searchCacheKeyFor('a note app', 'markdown notes', 30, true) !== base)
  check('identical inputs give an identical key', searchCacheKeyFor('a note app', 'markdown notes', 30, false) === base)
  check('an absent keywords hint is its own key', searchCacheKeyFor('a note app', undefined, 30, false) !== base)
}

// ---------------------------------------------------------------------------
console.log('\n=== C2. B1 regression: a thin anonymous result is not replayed to a token holder ===')
{
  // Measured live: the SAME query returned 30 rows once, HTTP 403 another time,
  // and a plausible-looking 2 rows a third time. GitHub does not error when it
  // throttles an anonymous caller — it returns fewer rows. So an anonymous run
  // that got 2 rows must never satisfy an authenticated lookup.
  const idea = 'b1 anonymous thin result must not be reused'
  const keyAnon = searchCacheKeyFor(idea, 'markdown notes', 30, false)
  const keyAuth = searchCacheKeyFor(idea, 'markdown notes', 30, true)

  await cacheSet(keyAnon, [{ full_name: 'thin/one' }, { full_name: 'thin/two' }])

  check('the two key states are genuinely different', keyAnon !== keyAuth)
  const authHit = await cacheGet(keyAuth)
  check('the authenticated lookup MISSES the anonymous entry', authHit === undefined || authHit === null, `got ${authHit?.length} rows`)
  const anonHit = await cacheGet(keyAnon)
  check('the anonymous entry is still there for anonymous callers', Array.isArray(anonHit) && anonHit.length === 2, JSON.stringify(anonHit))
}

// ---------------------------------------------------------------------------
console.log('\n=== C3. B2 regression: the query-plan version is part of the key ===')
{
  // The tool never sends the user's text to GitHub — it derives a plan. Change
  // how the plan is built and every old entry stayed "valid", so the previous
  // plan's rows were served as the new plan's answer.
  const idea = 'b2 plan version must participate'
  const current = searchCacheKeyFor(idea, 'markdown notes', 30, false)
  const previousPlan = searchCacheKeyFor(idea, 'markdown notes', 30, false, SEARCH_PLAN_VERSION - 1)

  check('the current plan version is encoded in the key', current.endsWith(`|p:${SEARCH_PLAN_VERSION}`), current)
  check('a different plan version gives a different key', current !== previousPlan, `${current} vs ${previousPlan}`)

  await cacheSet(previousPlan, [{ full_name: 'old/plan-result' }])
  const hit = await cacheGet(current)
  check('rows written under the OLD plan are not served under the new one', hit === undefined || hit === null, `got ${JSON.stringify(hit)}`)
  const oldHit = await cacheGet(previousPlan)
  check('the old entry is orphaned, not destroyed', Array.isArray(oldHit) && oldHit[0].full_name === 'old/plan-result', JSON.stringify(oldHit))
}

// ---------------------------------------------------------------------------
console.log('\n=== C4. B3 regression: source reads expire in minutes, listings in hours ===')
{
  // A stale candidate list is mildly wrong; a stale source read is wrong in a
  // specific way — `files_read` asserts "this is what the code says", and a
  // day-old copy can make that assertion false.
  check('SOURCE_TTL_MS is 10 minutes', SOURCE_TTL_MS === 10 * 60 * 1000, String(SOURCE_TTL_MS))
  check('SOURCE_TTL_MS is shorter than the listing TTL', SOURCE_TTL_MS < 24 * 60 * 60 * 1000)

  // Age an envelope by rewriting it with a backdated timestamp — the real
  // scenario is "a copy was stored yesterday and is read today".
  //
  // Do NOT fake the clock by replacing Date.now: `cacheSet` stamps its envelope
  // with `new Date()`, which does not consult `Date.now`, so a replaced clock
  // fools the read side and not the write side and every case reports age 0.
  // That mistake cost four probe rounds.
  //
  // The file must also be located WITHOUT guessing. An earlier version of this
  // test aged "the last file in the directory" and silently aged someone else's
  // envelope, so the read stayed fresh and the assertion looked like a product
  // bug. Identify the file by writing a unique payload and finding the envelope
  // that contains it.
  const findEnvelopeFor = (payload) => {
    for (const name of readdirSync(cacheDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(cacheDir, name), 'utf8'))
        if (JSON.stringify(parsed.data) === JSON.stringify(payload)) return join(cacheDir, name)
      } catch {
        // Not a readable envelope; skip it.
      }
    }
    return undefined
  }

  const marker = ['b3-aging-marker']
  const keyShape = searchCacheKeyFor('b3 aging probe', 'markdown notes', 30, false)
  await cacheSet(keyShape, marker)
  const target = findEnvelopeFor(marker)
  check('the envelope for this key was located on disk', target !== undefined, `looked in ${cacheDir}`)

  const writeAged = (ms) => {
    cacheClearMemory()
    const existing = JSON.parse(readFileSync(target, 'utf8'))
    writeFileSync(target, JSON.stringify({ ...existing, fetchedAt: new Date(Date.now() - ms).toISOString() }))
  }

  writeAged(2 * 60 * 1000)
  const freshSource = await cacheGet(keyShape, SOURCE_TTL_MS)
  check('a 2-minute-old source read is served', Array.isArray(freshSource) && freshSource[0] === 'b3-aging-marker', JSON.stringify(freshSource))

  writeAged(11 * 60 * 1000)
  const staleSource = await cacheGet(keyShape, SOURCE_TTL_MS)
  check('an 11-minute-old source read is expired', staleSource === undefined || staleSource === null, JSON.stringify(staleSource))

  const staleButListing = await cacheGet(keyShape)
  check('the SAME 11-minute-old entry is still valid as a listing', Array.isArray(staleButListing), 'the two paths must use different TTLs')

  writeAged(6 * 60 * 60 * 1000)
  check('a 6-hour-old source read is expired', (await cacheGet(keyShape, SOURCE_TTL_MS)) === undefined)
  check('a 6-hour-old listing is still served', Array.isArray(await cacheGet(keyShape)))
}

// ---------------------------------------------------------------------------
console.log('\n=== C5. a corrupt envelope degrades, it does not throw ===')
{
  const marker = ['corrupt-envelope-marker']
  const key = searchCacheKeyFor('corrupt envelope probe', undefined, 30, false)
  await cacheSet(key, marker)

  let target
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(cacheDir, name), 'utf8'))
      if (JSON.stringify(parsed.data) === JSON.stringify(marker)) target = join(cacheDir, name)
    } catch {
      // Unreadable envelope; skip.
    }
  }
  check('the envelope for this key was located', target !== undefined)

  writeFileSync(target, '{ this is not json')
  cacheClearMemory()

  let threw = false
  let value
  try {
    value = await cacheGet(key)
  } catch {
    threw = true
  }
  check('a corrupt cache file does not throw', !threw)
  check('a corrupt cache file reads as a miss', value === undefined || value === null, JSON.stringify(value))
}

// ---------------------------------------------------------------------------
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
