// R3: the query-channel agreement is VISIBLE on the card.
//
// WHY THIS FILE EXISTS
// --------------------
// `selectPool` fuses several query channels (one per planned query, plus the
// long-tail channel) and already knows, for every row it returns, HOW MANY of
// them produced that row. It uses the number to attribute the reserved
// long-tail seats and then discards it on the same line that builds the pool:
// the fused entry carries `sources: Set<number>`, and the projection to plain
// rows throws the set away.
//
// The cost of that discard is a card that cannot distinguish two very different
// situations:
//
//   * a row that three independent queries all returned — corroborated from
//     different angles, and usually the strongest signal a prior-art search can
//     produce, because the queries are deliberately varied;
//   * a row a single query happened to return, which may be an artefact of that
//     query's wording rather than a property of the repository.
//
// Both rendered identically, so the reader had to guess. This file pins the
// three states the field has to keep apart, and the two things it must NOT
// change:
//
//   1. Unmeasured is not zero. A caller-assembled pool never went through
//      `selectPool`, so it carries no count at all — and printing `1` (or `0`)
//      there would invent a measurement. This is the same rule
//      `lowStarInPool === null` already established on the long-tail side and
//      `archivedNote` on the archived side.
//   2. The number is EVIDENCE, not a score input. The formula
//      `relevance × (1 + log10(max(stars, 10) + 1)) / 2` is the centre contract;
//      a row's score, rank and order must be bit-identical whether the field is
//      present, absent, or five.
//
// Run `npx tsc -p tsconfig.json` first: this file loads the BUILT modules in
// `lib/`, so a stale build is a false result in either direction.
//
// Run with:  npm test
// Or directly: node test/channel-visibility.test.mjs
// Never with `node --test` — this file prints its own PASS/FAIL lines.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

// A scratch DSH_HOME so the round-trip below cannot read or write the real cache.
const scratchRoot = join(pkgRoot, '.scratch')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'channel-visibility-'))
process.env.DSH_HOME = scratch

const { renderCandidates, renderRanked } = await load('render.js')
const { rankCandidates, finalScore, STAR_FLOOR } = await load('types.js')
const { selectPool } = await load('github.js')
const { apply } = await load('index.js')
// The host's own validator, not a hand-rolled one: AC9 asks whether the real
// consumer accepts the real producer's output, and a second implementation of
// the schema language would only prove that my reading agrees with itself.
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')

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

const toolDefs = () => {
  const defs = new Map()
  apply({ tools: { register: (def) => defs.set(def.name, def) }, get: () => undefined })
  return defs
}

/** A candidate as `scout_projects` returns it. `channels_hit` stays overridable. */
const repo = (full_name, extra = {}) => ({
  full_name,
  url: `https://github.com/${full_name}`,
  owner: full_name.split('/')[0],
  name: full_name.split('/')[1],
  description: 'a plain description',
  stars: 120,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived: false,
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

// Counted per ROW, never over the whole text: the summary sentence quotes the
// marker's own wording, so a whole-text match would count the sentence too.
const rowLines = (text) =>
  text.split('\n').filter((line) => /^\s*\d+\.\s/.test(line) || /^\| \d+ \|/.test(line))
const markerCount = (text) => rowLines(text).filter((line) => line.includes('个查询命中')).length
const dataRows = (card) => card.split('\n').filter((line) => /^\| \d+ \|/.test(line))
const cellsOf = (row) => row.split(/(?<!\\)\|/).length - 2

// ---------------------------------------------------------------------------
console.log('\n=== R3.1 `selectPool` measures the count instead of discarding it ===')
{
  // Two channels, one row in common. The shared row must come back with 2, the
  // single-channel rows with 1 — the number the fusion already computed.
  const channelA = [repo('shared/one', { stars: 900 }), repo('only-a/two', { stars: 800 })]
  const channelB = [repo('shared/one', { stars: 900 }), repo('only-b/three', { stars: 700 })]
  const pool = selectPool([channelA, channelB], 10)
  const byName = new Map(pool.candidates.map((row) => [row.full_name, row.channels_hit]))

  check('the row both channels returned carries 2',
    byName.get('shared/one') === 2, String(byName.get('shared/one')))
  check('a row only one channel returned carries 1',
    byName.get('only-a/two') === 1 && byName.get('only-b/three') === 1,
    `${byName.get('only-a/two')}, ${byName.get('only-b/three')}`)
  check('every pooled row carries a measured count, not an absent one',
    pool.candidates.every((row) => typeof row.channels_hit === 'number'),
    JSON.stringify(pool.candidates.map((row) => row.channels_hit)))
  check('a measured count is never zero, because a pooled row came from some channel',
    pool.candidates.every((row) => row.channels_hit >= 1),
    JSON.stringify(pool.candidates.map((row) => row.channels_hit)))

  // The reserved long-tail path is the second return path in `selectPool`; the
  // count has to be attached there too, or a tail-heavy pool loses it silently.
  const big = Array.from({ length: 12 }, (_, i) => repo(`big/${i}`, { stars: 50000 }))
  const small = Array.from({ length: 6 }, (_, i) => repo(`small/${i}`, { stars: 3 }))
  const tailPool = selectPool([big, small], 10)
  check('the reserved-tail return path also carries the count',
    tailPool.candidates.every((row) => typeof row.channels_hit === 'number'),
    JSON.stringify(tailPool.candidates.map((row) => [row.full_name, row.channels_hit])))
  check('the tail path really did include low-star rows, so the assertion above is not vacuous',
    tailPool.tailIncluded > 0 && tailPool.lowStarInPool > 0,
    JSON.stringify({ tailIncluded: tailPool.tailIncluded, lowStarInPool: tailPool.lowStarInPool }))
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.2 the flat list marks each row with its count ===')
{
  const pool = [
    repo('a/one', { channels_hit: 3 }),
    repo('b/two', { channels_hit: 1 }),
    repo('c/three', { channels_hit: 2 }),
  ]
  const card = renderCandidates('probe idea', pool, null, false, 0)

  check('a corroborated row states 3', card.includes('a/one') && card.includes('[3 个查询命中]'), card)
  check('a single-channel row states 1', card.includes('[1 个查询命中]'), card)
  check('the marker appears on the row line itself, not as a separate section', (() => {
    const line = rowLines(card).find((row) => row.includes('a/one'))
    return line !== undefined && line.includes('[3 个查询命中]')
  })(), rowLines(card).join('\n'))
  check('one marker per row and no more', markerCount(card) === 3, String(markerCount(card)))

  // The summary sentence says HOW MANY rows were corroborated. It is a different
  // fact from the per-row marker: the marker says which rows, the sentence says
  // whether the query set was redundant or complementary.
  check('the card states how many rows two or more queries agreed on',
    card.includes('本次候选里有 2 行由 2 个以上查询同时命中'), card.slice(-300))
  check('the summary agrees with the markers actually printed',
    markerCount(card) === 3 && card.includes('有 2 行'), String(markerCount(card)))
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.3 unmeasured and measured-zero are DIFFERENT texts (AC10) ===')
{
  // The distinction this test exists for. A caller-assembled pool never went
  // through `selectPool`, so nobody counted its rows; rendering that as `1` or
  // `0` would state a measurement that was never taken.
  const unmeasured = renderCandidates('probe idea', [repo('a/one'), repo('b/two')], null, false, 0)
  const measuredZero = renderCandidates('probe idea',
    [repo('a/one', { channels_hit: 0 }), repo('b/two', { channels_hit: 0 })], null, false, 0)

  check('an unmeasured pool renders no count anywhere',
    !unmeasured.includes('查询命中'), unmeasured.slice(-300))
  check('a measured zero IS rendered as zero, not suppressed',
    measuredZero.includes('[0 个查询命中]'), measuredZero.slice(-300))
  check('so the two cards are different texts', unmeasured !== measuredZero, '')
  check('the unmeasured card does not claim "no row was corroborated" either',
    !unmeasured.includes('没有任何一行由 2 个以上查询同时命中'), unmeasured.slice(-300))
  check('the measured-zero card does make that claim',
    measuredZero.includes('没有任何一行由 2 个以上查询同时命中'), measuredZero.slice(-300))

  // A partially measured pool: the count must be stated for what was measured,
  // and the missing rows must be named rather than silently folded in.
  const partial = [repo('a/one', { channels_hit: 3 }), repo('b/two')]
  const partialCard = renderCandidates('probe idea', partial, null, false, 0)
  check('a partially measured pool still reports the rows it could count',
    partialCard.includes('本次候选里有 1 行由 2 个以上查询同时命中'), partialCard.slice(-300))
  check('and it names how many rows went unmeasured',
    partialCard.includes('另有 1 行未测量查询命中数'), partialCard.slice(-300))
  check('and it refuses the reading "so those had one query"',
    partialCard.includes('数据缺失，不等于 1 个查询命中'), partialCard.slice(-300))
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.4 the ranked table marks the rows and stays eight columns (AC12) ===')
{
  const ranked = [
    rankedRowOf(repo('a/one', { channels_hit: 3 }), 1),
    rankedRowOf(repo('b/two', { channels_hit: 1 }), 2),
    rankedRowOf(repo('c/three', { channels_hit: 2 }), 3),
  ]
  const card = renderRanked('probe idea', ranked, [], [], [])

  check('the table marks a corroborated row', card.includes('[3 个查询命中]'), card)
  check('the marker sits in the 项目 cell', (() => {
    const row = dataRows(card).find((line) => line.includes('a/one'))
    if (row === undefined) return false
    const cells = row.split(/(?<!\\)\|/)
    // cells[0] is empty, cells[1] is the rank, cells[2] is 项目.
    return cells[2].includes('[3 个查询命中]')
  })(), dataRows(card).join('\n'))
  check('the table is still exactly eight columns', (() => {
    const rows = dataRows(card)
    return rows.length === 3 && rows.every((row) => cellsOf(row) === 8)
  })(), dataRows(card).map((r) => cellsOf(r)).join(','))
  check('the header is still exactly eight columns',
    card.split('\n').filter((line) => line.startsWith('| # |')).every((line) => cellsOf(line) === 8), '')
  check('the formula line is still present', card.includes('排序与星级均由代码按公式计算'), '')
  check('the board states how many rows were corroborated',
    card.includes('本榜有 2 行由 2 个以上查询同时命中'), card.slice(-300))

  const unmeasured = renderRanked('probe idea', [
    rankedRowOf(repo('a/one'), 1),
  ], [], [], [])
  check('an unmeasured board renders no count', !unmeasured.includes('查询命中'), unmeasured.slice(-200))
  check('and an unmeasured board still renders eight columns',
    dataRows(unmeasured).every((row) => cellsOf(row) === 8), '')
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.5 the count is EVIDENCE, not a score input (AC11) ===')
{
  // Identical inputs except the count. Any difference in score, rank or order
  // would mean the field leaked into the arithmetic the PRD forbids changing.
  const rows = (hit) => [
    repo('alpha/one', { stars: 5000, channels_hit: hit }),
    repo('beta/two', { stars: 5000, channels_hit: hit }),
  ]
  const scores = [
    { full_name: 'alpha/one', relevance: 8 },
    { full_name: 'beta/two', relevance: 8 },
  ]

  const low = rankCandidates(rows(1), scores)
  const high = rankCandidates(rows(5), scores)
  const absent = rankCandidates([repo('alpha/one', { stars: 5000 }), repo('beta/two', { stars: 5000 })], scores)

  check('the score is identical for 1 and 5 hits',
    low.ranked[0].score === high.ranked[0].score, `${low.ranked[0].score} vs ${high.ranked[0].score}`)
  check('the rank is identical for 1 and 5 hits',
    low.ranked.map((r) => r.rank).join(',') === high.ranked.map((r) => r.rank).join(','), '')
  check('the order is identical for 1 and 5 hits',
    low.ranked.map((r) => r.full_name).join(',') === high.ranked.map((r) => r.full_name).join(','),
    low.ranked.map((r) => r.full_name).join(','))
  check('the score is identical whether the field is absent or present',
    absent.ranked[0].score === high.ranked[0].score,
    `${absent.ranked[0].score} vs ${high.ranked[0].score}`)
  check('the score still equals the published formula',
    high.ranked[0].score === finalScore(8, 5000), String(high.ranked[0].score))
  check('the star floor is untouched', STAR_FLOOR === 10, String(STAR_FLOOR))

  // The field is carried through unchanged, and an ABSENT count stays absent —
  // not coerced to 0 or 1 on the way out, or the renderer could not tell the
  // three states apart.
  check('the count is carried through to the ranked row unchanged',
    high.ranked[0].channels_hit === 5, String(high.ranked[0].channels_hit))
  check('an uncounted row does not gain a key on the way out',
    !Object.hasOwn(absent.ranked[0], 'channels_hit'), JSON.stringify(absent.ranked[0]))
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.6 AC9: the producer output feeds the consumer AS-IS ===')
{
  // The round trip, not two schemas validated side by side. `scout_projects`
  // really runs (against a stubbed GitHub), its `candidates` array is passed
  // straight into `rank_candidates`, and the host's own validator is what
  // decides whether each row is acceptable. Two schemas that are separately
  // self-consistent can still disagree about a field; only this catches that.
  const realFetch = globalThis.fetch
  let searchCalls = 0
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (!href.includes('/search/repositories')) return realFetch(url, init)
    searchCalls++
    const items = [
      { full_name: 'round/one', html_url: 'https://github.com/round/one', owner: { login: 'round' }, name: 'one', description: 'a local-first note app', stargazers_count: 4000, language: 'TypeScript', pushed_at: '2026-01-01T00:00:00Z', topics: ['notes'], archived: false, fork: false },
      { full_name: 'round/two', html_url: 'https://github.com/round/two', owner: { login: 'round' }, name: 'two', description: 'another local-first note app', stargazers_count: 3000, language: 'Rust', pushed_at: '2026-01-01T00:00:00Z', topics: ['notes'], archived: false, fork: false },
    ]
    return new Response(JSON.stringify({ total_count: items.length, items }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const defs = toolDefs()
    const scout = defs.get('scout_projects')
    const rank = defs.get('rank_candidates')

    const value = await scout.execute({ idea: 'a local-first note taking app' }, {})
    check('the search actually ran, so the round trip is not vacuous',
      searchCalls > 0 && value.candidates.length > 0, `${searchCalls} search call(s), ${value.candidates.length} row(s)`)

    // The producer's rows must satisfy the producer's own declared output
    // schema — this is where an undeclared field would be rejected.
    const scoutItem = scout.output.schema.properties.candidates.items
    const scoutViolations = value.candidates.flatMap((row, i) =>
      validateJsonSchemaValue(scoutItem, row, `candidates[${i}]`))
    check('every produced row validates against scout_projects output schema as-is',
      scoutViolations.length === 0, JSON.stringify(scoutViolations.slice(0, 3)))

    // ...and the consumer's declared input schema, unchanged, with no mapping.
    const rankItem = rank.parameters.properties.candidates.items
    const rankViolations = value.candidates.flatMap((row, i) =>
      validateJsonSchemaValue(rankItem, row, `candidates[${i}]`))
    check('every produced row validates against rank_candidates input schema as-is',
      rankViolations.length === 0, JSON.stringify(rankViolations.slice(0, 3)))

    // The two declarations must agree field for field, or the round trip above
    // passes only because one side is permissive about the other's extra field.
    check('the two candidate schemas declare the same properties',
      JSON.stringify(Object.keys(scoutItem.properties).sort())
        === JSON.stringify(Object.keys(rankItem.properties).sort()),
      `${JSON.stringify(Object.keys(scoutItem.properties))} vs ${JSON.stringify(Object.keys(rankItem.properties))}`)
    check('the two candidate schemas require the same fields',
      JSON.stringify([...scoutItem.required].sort()) === JSON.stringify([...rankItem.required].sort()),
      `${JSON.stringify(scoutItem.required)} vs ${JSON.stringify(rankItem.required)}`)
    check('channels_hit is declared on both and required on neither',
      scoutItem.properties.channels_hit !== undefined
      && rankItem.properties.channels_hit !== undefined
      && !scoutItem.required.includes('channels_hit')
      && !rankItem.required.includes('channels_hit'),
      JSON.stringify({ scout: scoutItem.properties.channels_hit, rank: rankItem.properties.channels_hit }))

    // The actual call: no mapping, no field stripping.
    const ranked = await rank.execute({
      idea: 'a local-first note taking app',
      candidates: value.candidates,
      scores: value.candidates.map((row) => ({ full_name: row.full_name, relevance: 6 })),
      limit: 10,
    })
    check('the consumer accepts the producer output without any adaptation',
      ranked.ranked.length > 0, JSON.stringify(ranked).slice(0, 200))
    check('the count survives the whole chain into the rendered card', (() => {
      const card = rank.output.render({}, ranked)[0].text
      return card.includes('个查询命中')
    })(), rank.output.render({}, ranked)[0].text.slice(0, 400))

    // The ranked rows must satisfy the declared output schema too, or the host
    // would reject the card even though the card text looks right.
    const rankedItem = rank.output.schema.properties.ranked.items
    const outViolations = ranked.ranked.flatMap((row, i) =>
      validateJsonSchemaValue(rankedItem, row, `ranked[${i}]`))
    check('every ranked row validates against rank_candidates output schema',
      outViolations.length === 0, JSON.stringify(outViolations.slice(0, 3)))
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== R3.7 AC13: no new parameter was added ===')
{
  // The parameter key set is the project's defence against letting a model set
  // its own stars or score. R3 adds a RESULT field, so this set must be
  // unchanged — asserted here as well as in `test/ranking.test.mjs:177`, because
  // the schema edit that added `channels_hit` sits close enough to the parameter
  // block to get it wrong.
  const rank = toolDefs().get('rank_candidates')
  check('the rank_candidates parameter set is unchanged',
    JSON.stringify(Object.keys(rank.parameters.properties).sort())
      === JSON.stringify(['candidates', 'idea', 'keywords', 'limit', 'pool_source', 'scores']),
    JSON.stringify(Object.keys(rank.parameters.properties).sort()))
  check('there is still no stars parameter', rank.parameters.properties.stars === undefined, '')
  check('there is still no stars_rating parameter', rank.parameters.properties.stars_rating === undefined, '')
}

// ---------------------------------------------------------------------------
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
