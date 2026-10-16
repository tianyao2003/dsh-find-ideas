// R2: the archived share of a pool is VISIBLE, and archived rows are neither
// filtered nor de-weighted.
//
// WHY THIS FILE EXISTS
// --------------------
// The per-row `[已归档]` marker has always been there, and nothing said how many
// rows carried it. That is not a cosmetic gap for this tool: it deliberately
// KEEPS archived repositories, because it looks for prior art and an archived
// repository is often a finished work rather than an abandoned one. So a pool
// where a third of the rows are archived is a normal, useful pool — and a reader
// with only per-row markers has to count them by eye to notice, while a reader
// who assumes the marker means "abandoned" will discount exactly the material
// that was worth keeping.
//
// Two failures are therefore pinned here, and they pull in opposite directions:
//
//   1. The scale must be stated (a count), while the rows stay in the pool and
//      keep their score. A "fix" that dropped archived rows would satisfy the
//      first reading of "show me the archived ones" and destroy the tool.
//   2. "No archived rows" and "nobody measured archived" are DIFFERENT claims.
//      Reporting a measured 0 is fine only if silence is not also used for the
//      unmeasured case, which is the rule `lowStarInPool === null` already
//      established on the long-tail side.
//
// Run with:  npm test
// Or directly: node test/archived-visibility.test.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { renderCandidates, renderRanked } = await load('render.js')
const { rankCandidates, finalScore, STAR_FLOOR } = await load('types.js')

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

// Every field overridable so each test states only what it is about. `archived`
// is NOT defaulted away — `undefined` is a case under test (see T3).
const repo = (full_name, archived, extra = {}) => ({
  full_name,
  url: `https://github.com/${full_name}`,
  owner: full_name.split('/')[0],
  name: full_name.split('/')[1],
  description: 'a plain description',
  stars: 120,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived,
  topics: [],
  ...extra,
})

const rankedRowOf = (row, rank) => ({
  ...row,
  rank,
  relevance: 7,
  stars_rating: 3,
  score: finalScore(7, row.stars),
})

// The count is only trustworthy if it agrees with the markers it summarizes, so
// every assertion below pairs the sentence with the rows actually printed.
//
// Counted per ROW, not per occurrence in the text: the count sentence quotes the
// marker back (`已标 [已归档]`) to say what it is counting, so a whole-text match
// counts that quotation too and reports one more than there are rows. The
// distinction matters — the property under test is "the number equals the number
// of MARKED ROWS", not "the string appears N times".
const markerCount = (text) =>
  text.split('\n').filter((line) => /^\s*\d+\.\s/.test(line) || /^\| \d+ \|/.test(line))
    .filter((line) => line.includes('[已归档]')).length

// ---------------------------------------------------------------------------
console.log('\n=== R2.1 the flat list states the archived share ===')
{
  const pool = [
    repo('a/one', true), repo('b/two', false), repo('c/three', true), repo('d/four', false),
  ]
  const card = renderCandidates('probe idea', pool, null, false, 0)

  check('the card names the archived count', card.includes('本次候选里 2 行是归档仓库'), card.slice(-260))
  check('the count agrees with the markers actually printed',
    markerCount(card) === 2, `${markerCount(card)} marker(s)`)
  check('the marker is still per-row, not replaced by the count',
    card.includes('a/one') && card.includes('[已归档]'), '')
  check('the line says the marker is what it counts', card.includes('已标 [已归档]'), '')
  // The marker is easy to read as "abandoned", which would push a reader to
  // discount a finished work. The count line must carry the opposite reading.
  check('the line explains that archived is not the same as obsolete',
    card.includes('归档不等于过时'), card.slice(-260))
  check('the line keeps the score-it-on-relevance instruction',
    card.includes('不要仅因该标记就判为噪声'), '')
}

// ---------------------------------------------------------------------------
console.log('\n=== R2.2 a measured zero is SILENT, not a reported zero ===')
{
  const card = renderCandidates('probe idea', [repo('a/one', false), repo('b/two', false)], null, false, 0)
  check('no archived line at all when none are archived',
    !card.includes('归档'), card.slice(-200))
  check('and no marker is printed either', markerCount(card) === 0, String(markerCount(card)))

  const table = renderRanked('probe idea', [rankedRowOf(repo('a/one', false), 1)], [], [], [])
  check('the table is silent too when none are archived',
    !table.includes('归档'), table.slice(-200))
}

// ---------------------------------------------------------------------------
console.log('\n=== R2.3 unmeasured is DISTINGUISHABLE from a measured zero ===')
{
  // The distinction this test exists for: a row that never carried `archived`
  // must not be counted as `false`. Reading it as false would assert "this
  // repository is not archived" about a fact nobody supplied.
  const unknown = [repo('a/one', false), repo('b/two', false)]
  delete unknown[0].archived
  delete unknown[1].archived

  const unmeasured = renderCandidates('probe idea', unknown, null, false, 0)
  const measuredZero = renderCandidates('probe idea', [repo('a/one', false), repo('b/two', false)], null, false, 0)

  check('the unmeasured card says the count could not be taken',
    unmeasured.includes('无法统计归档数量'), unmeasured.slice(-260))
  check('it names how many rows were missing the field',
    unmeasured.includes('2 行缺少 archived 字段'), unmeasured.slice(-260))
  check('it refuses the reading "so there are none"',
    unmeasured.includes('数据缺失，不等于没有归档仓库'), unmeasured.slice(-260))
  check('the two cards are therefore different texts', unmeasured !== measuredZero, '')
  check('the measured-zero card reports no count at all',
    !measuredZero.includes('无法统计') && !measuredZero.includes('0 行是归档'), measuredZero.slice(-200))

  // A partial pool: some rows measured, some not, and the measured ones say
  // "archived". The count must still be stated rather than withheld.
  const partial = [repo('a/one', true), repo('b/two', false)]
  delete partial[1].archived
  const partialCard = renderCandidates('probe idea', partial, null, false, 0)
  check('a partial pool still reports the archived rows it could see',
    partialCard.includes('本次候选里 1 行是归档仓库'), partialCard.slice(-260))
}

// ---------------------------------------------------------------------------
console.log('\n=== R2.4 the ranked table states the archived share of the board ===')
{
  const ranked = [
    rankedRowOf(repo('a/one', true), 1),
    rankedRowOf(repo('b/two', false), 2),
    rankedRowOf(repo('c/three', true), 3),
  ]
  const card = renderRanked('probe idea', ranked, [], [], [])

  check('the table card names the archived count', card.includes('本榜 2 行是归档仓库'), card.slice(-260))
  check('the count agrees with the markers printed in the table',
    markerCount(card) === 2, `${markerCount(card)} marker(s)`)
  check('the table is still exactly eight columns', (() => {
    const rows = card.split('\n').filter((line) => /^\| \d+ \|/.test(line))
    return rows.length === 3 && rows.every((row) => row.split(/(?<!\\)\|/).length === 10)
  })(), '')
  check('the formula line is still present and still last before the count',
    card.includes('排序与星级均由代码按公式计算，不可由模型指定。'), '')

  const empty = renderRanked('probe idea', [], [], [], [])
  check('an empty board reports nothing about archives', !empty.includes('归档'), '')
}

// ---------------------------------------------------------------------------
console.log('\n=== R2.5 archived rows are NOT filtered and NOT de-weighted (AC8) ===')
{
  // The counter-example the PRD asks for: identical inputs except `archived`.
  // Same relevance, same stars — so any difference in score or membership would
  // be the archived flag leaking into the arithmetic.
  const base = (archived) => [
    repo('archived/one', archived, { stars: 5000 }),
    repo('live/two', false, { stars: 5000 }),
  ]
  const scores = [
    { full_name: 'archived/one', relevance: 8 },
    { full_name: 'live/two', relevance: 8 },
  ]

  const withArchived = rankCandidates(base(true), scores)
  const withoutArchived = rankCandidates(base(false), scores)

  check('an archived row is still on the board',
    withArchived.ranked.some((r) => r.full_name === 'archived/one'),
    withArchived.ranked.map((r) => r.full_name).join(', '))
  check('it is not silently dropped into any exclusion list',
    withArchived.dropped.length === 0 && withArchived.belowThreshold.length === 0
    && withArchived.unknown.length === 0,
    JSON.stringify({ dropped: withArchived.dropped, below: withArchived.belowThreshold, unknown: withArchived.unknown }))
  check('its score is IDENTICAL to the same row with archived=false',
    withArchived.ranked[0].score === withoutArchived.ranked[0].score,
    `${withArchived.ranked[0].score} vs ${withoutArchived.ranked[0].score}`)
  check('the score still equals the published formula',
    withArchived.ranked[0].score === finalScore(8, 5000), String(withArchived.ranked[0].score))
  check('the flag is carried through to the row unchanged',
    withArchived.ranked[0].archived === true && withoutArchived.ranked[0].archived === false, '')
  check('the archived flag does not reorder equal-scored rows by itself', (() => {
    // Same score and same stars, so the tie-break is `full_name` — which is the
    // rule that applied before this change too.
    const order = (rows) => rows.map((r) => r.full_name).join(',')
    const flipped = rankCandidates(
      [repo('live/two', false, { stars: 5000 }), repo('archived/one', true, { stars: 5000 })],
      scores,
    )
    return order(withArchived.ranked) === order(flipped.ranked)
  })(), '')

  // And the star floor is untouched by this work: `finalScore` is the centre
  // contract the PRD forbids changing.
  check('the star floor is unchanged', STAR_FLOOR === 10, String(STAR_FLOOR))
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
