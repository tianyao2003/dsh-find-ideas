/**
 * R1 — a description is capped at 512 characters when it is STORED.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * GitHub does not bound `description`, and repositories abuse it: the worst row
 * measured in the field is 241,896 characters. Only 74 of 817 candidates (9%)
 * exceeded 512, yet those 74 were 97% of an 11 MB cache directory. The render
 * layer already clips to 200 characters for DISPLAY, but clipping at render time
 * leaves the full value in the cache — on disk, and resident in the in-process
 * map. This file pins the storage cap that closes that gap.
 *
 * The three properties that must hold together, and why each is separate:
 *
 *   1. STORAGE IS CAPPED. Over-long descriptions come back at 512, not at full
 *      length. Without this the cache keeps growing.
 *   2. WHITESPACE IS NOT FOLDED. `clipDescription` collapses `\s+` at render
 *      time. Folding earlier would change the input to `similarity()` and break
 *      property 3 for descriptions that were never over the cap.
 *   3. SCORING INPUT IS UNCHANGED below the cap. `similarity()` and
 *      `SUSPICION_QUOTE_CHARS` must see exactly what they saw before, or the
 *      ranking of normal candidates drifts.
 *
 * A test that only asserted (1) would pass while quietly breaking (2) and (3) —
 * that is the failure mode this file is shaped to catch.
 *
 * CACHE PATHS ARE SANDBOXED. `DSH_HOME` is redirected to a scratch directory
 * BEFORE any module is imported, for the reason spelled out in cache.test.mjs:
 * `cache.ts` swallows write failures and degrades to memory-only, so a cache
 * test in an unwritable home would silently test nothing and still report green.
 *
 * Run `npx tsc -p tsconfig.json` first. This file loads the BUILT modules in
 * `lib/`, so a stale `lib/` is a false pass waiting to happen.
 *
 * Run with:  npm test
 * Or directly: node test/cache-description-cap.test.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-description-cap-'))
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

const { searchRepositories } = await load('github.js')
const { cacheGet, cacheSet, cacheClearMemory } = await load('cache.js')
const { similarity, SUSPICION_QUOTE_CHARS } = await load('types.js')

const CAP = 512

const realFetch = globalThis.fetch
const JSON_HEADERS = { 'content-type': 'application/json' }

/** One raw search-API item, with a description of the given length. */
function item(name, description) {
  return {
    full_name: `acme/${name}`,
    html_url: `https://github.com/acme/${name}`,
    owner: { login: 'acme' },
    name,
    description,
    stargazers_count: 100,
    language: 'TypeScript',
    pushed_at: '2026-01-01T00:00:00Z',
    topics: [],
    archived: false,
    fork: false,
  }
}

/** Answer every search request with one page of `items`. */
function stubSearch(items) {
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    if (parsed.pathname !== '/search/repositories') {
      return new Response('{"message":"unexpected path"}', { status: 404, headers: JSON_HEADERS })
    }
    return new Response(JSON.stringify({ total_count: items.length, items }), {
      status: 200,
      headers: JSON_HEADERS,
    })
  }
}

/** Fetch one page through the real code path and return its candidates. */
async function fetchCandidates(items) {
  stubSearch(items)
  const outcome = await searchRepositories('local-first notes', items.length)
  return outcome.candidates
}

// ---------------------------------------------------------------------------
console.log('\n=== D1. a short description is stored verbatim ===')
{
  const honest = 'A local-first markdown note app with offline sync'
  const [candidate] = await fetchCandidates([item('short', honest)])
  check('the candidate survived the fetch', candidate !== undefined)
  check('a short description is unchanged', candidate.description === honest, candidate.description)
  check('no length marker was appended', !candidate.description.includes('描述过长'), candidate.description)
}

// ---------------------------------------------------------------------------
console.log('\n=== D2. the cap is applied at exactly the right length ===')
{
  const atCap = 'x'.repeat(CAP)
  const overCap = 'y'.repeat(CAP + 1)
  const huge = 'z'.repeat(241_896)
  const [a, b, c] = await fetchCandidates([
    item('at-cap', atCap),
    item('over-cap', overCap),
    item('huge', huge),
  ])

  check('exactly 512 characters is NOT truncated', a.description.length === CAP, String(a.description.length))
  check('exactly 512 characters is unchanged', a.description === atCap)
  check('513 characters is truncated to 512', b.description.length === CAP, String(b.description.length))
  check('the 241,896-character row is truncated to 512', c.description.length === CAP, String(c.description.length))
  check('truncation keeps a PREFIX, not a suffix', c.description.startsWith('z'.repeat(CAP)), c.description.slice(0, 8))
  check('truncation adds no ellipsis', !c.description.includes('…'), c.description.slice(-8))
  check('truncation adds no length marker', !c.description.includes('描述过长'), c.description.slice(-8))
}

// ---------------------------------------------------------------------------
console.log('\n=== D3. whitespace is NOT folded at storage time ===')
{
  // `clipDescription` collapses runs of whitespace and trims at RENDER time.
  // Doing it here would change `similarity()` input for descriptions that were
  // never over the cap — a silent ranking change with no size benefit.
  const multiLine = 'line one\n\nline two\t  spaced'
  const [candidate] = await fetchCandidates([item('whitespace', multiLine)])
  check('newlines survive storage', candidate.description.includes('\n'), JSON.stringify(candidate.description))
  check('tabs survive storage', candidate.description.includes('\t'), JSON.stringify(candidate.description))
  check('runs of spaces survive storage', candidate.description.includes('  '), JSON.stringify(candidate.description))
  check('the value is byte-identical to the input', candidate.description === multiLine, JSON.stringify(candidate.description))
}

// ---------------------------------------------------------------------------
console.log('\n=== D4. scoring input is untouched below the cap ===')
{
  // `similarity()` is character-bigram based and `SUSPICION_QUOTE_CHARS` slices
  // the first 120 characters. For a description under the cap both must see
  // exactly what they saw before this change — that is the whole safety
  // argument for choosing 512 over the 200-character render budget.
  const left = 'A local-first markdown note app with offline sync and a plugin API'
  const right = 'A local-first markdown note taking app, offline sync, plugin API'
  const [a, b] = await fetchCandidates([item('left', left), item('right', right)])

  check('similarity of two short descriptions is unchanged by storage', similarity(a.description, b.description) === similarity(left, right),
    `${similarity(a.description, b.description)} vs ${similarity(left, right)}`)
  check('an under-cap description is byte-identical to the input', a.description === left, JSON.stringify(a.description))

  // 600 characters: comfortably over the 512 cap, and the first 120 of them are
  // what `SUSPICION_QUOTE_CHARS` reads.
  const long = `${'abcdefghij'.repeat(60)} TAIL`
  check('the fixture is over the cap', long.length > CAP, String(long.length))
  const [c] = await fetchCandidates([item('long', long)])
  check('the suspicion quote window still has a full 120 characters to read',
    c.description.length >= SUSPICION_QUOTE_CHARS, String(c.description.length))
  check('the first 120 characters are preserved exactly',
    c.description.slice(0, SUSPICION_QUOTE_CHARS) === long.slice(0, SUSPICION_QUOTE_CHARS))
}

// ---------------------------------------------------------------------------
console.log('\n=== D5. the cap reaches DISK, not just the returned object ===')
{
  cacheClearMemory()
  const huge = 'q'.repeat(200_000)
  const key = 'description-cap-disk-probe'
  const [candidate] = await fetchCandidates([item('disk', huge)])
  check('the fetched candidate is capped', candidate.description.length === CAP)

  // Write through the real cache API with the same shape the tool stores, then
  // read the file back — the point of R1 is the DISK footprint, so asserting on
  // the in-memory object alone would test the wrong layer.
  await cacheSet(key, { candidates: [candidate] })
  const files = readdirSync(cacheDir).filter((name) => name.endsWith('.json'))
  check('exactly one cache file was written', files.length === 1, files.join(','))
  const raw = readFileSync(join(cacheDir, files[0]), 'utf8')
  const stored = JSON.parse(raw)
  check('the stored description is capped', stored.data.candidates[0].description.length === CAP,
    String(stored.data.candidates[0].description.length))
  check('the cache file is small (well under 100 KB)', raw.length < 100_000, String(raw.length))
  check('the envelope records the current version', stored.version === 3, String(stored.version))
}

// ---------------------------------------------------------------------------
console.log('\n=== D6. a version-2 entry is a MISS, a version-3 entry is a HIT ===')
{
  // The 2 -> 3 bump is load-bearing: a version-2 entry holds a description of a
  // different length for the same repository, so mixing the two would make the
  // same query report a different description depending on whether it came from
  // disk or the network — silently, with no error.
  cacheClearMemory()
  const key = 'version-gate-probe'
  await cacheSet(key, { candidates: [] })

  const files = readdirSync(cacheDir).filter((name) => name.endsWith('.json'))
  check('the sentinel entry was written', files.length >= 1, files.join(','))

  // Locate the sentinel's file without guessing: rewrite it in place.
  const target = join(cacheDir, files[files.length - 1])
  const envelope = JSON.parse(readFileSync(target, 'utf8'))

  envelope.version = 2
  const { writeFileSync } = await import('node:fs')
  writeFileSync(target, JSON.stringify(envelope), 'utf8')
  cacheClearMemory()
  check('a version-2 entry reads as a miss', (await cacheGet(key)) === undefined)

  envelope.version = 3
  writeFileSync(target, JSON.stringify(envelope), 'utf8')
  cacheClearMemory()
  const hit = await cacheGet(key)
  check('a version-3 entry reads as a hit', hit !== undefined && hit !== null, JSON.stringify(hit))
}

// ---------------------------------------------------------------------------
console.log('\n=== D7. GATE: the cap is enforced by the real fetch path ===')
{
  // Without this, every assertion above could be satisfied by a stub that never
  // reached `toCandidate`. The gate re-runs the public entry point and checks
  // that the over-long row came back short — if someone removes the cap, this is
  // the assertion that goes red.
  cacheClearMemory()
  const huge = 'w'.repeat(300_000)
  const [candidate] = await fetchCandidates([item('gate', huge)])
  check('the real fetch path applies the cap', candidate.description.length === CAP, String(candidate.description.length))
  check('the capped value is a prefix of the original', huge.startsWith(candidate.description))
}

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
