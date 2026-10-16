// Conditional bilingual routing: lexical misses trigger English-first ONLY
// when usable Latin keywords exist. These tests check plans and mocked transport,
// not live GitHub relevance or the quality of an agent's translation.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-bilingual-routing-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch
const { buildQueries, planQueries, MAX_QUERIES, isTailReachable } = await load('query.js')
const { englishSeeds } = await load('lexicon.js')
const { MAX_TERM_PROBES } = await load('github.js')
const { cacheSet, cacheGet, cacheClearMemory } = await load('cache.js')
const { searchCacheKeyFor, SEARCH_PLAN_VERSION, TERM_TOTAL_UNKNOWN } = await load('types.js')
const { apply } = await load('index.js')
const realFetch = globalThis.fetch
let pass = 0
function check(label, actual, ...expected) {
  assert.deepEqual(actual, expected.length === 0 ? true : expected[0], label)
  console.log(`  PASS  ${label}`)
  pass++
}
const han = (text) => /\p{Script=Han}/u.test(text)
const unknownIdea = '一个区块链浏览器，支持多链查询和交易追踪'
const keywords = 'blockchain explorer multi-chain transaction tracking'
const chineseQuery = '一个区块链浏览器 支持多链查询和交易追踪'
const englishPlan = [
  { query: 'blockchain explorer', sort: 'stars', role: 'anchor' },
  { query: chineseQuery, sort: 'stars', role: 'precise' },
  { query: 'blockchain explorer multi-chain', sort: 'updated', role: 'tail', tailReason: 'updated' },
]

try {
  console.log('\n=== L1. a total lexical miss with English keywords changes only the routing ===')
  const planned = planQueries(unknownIdea, keywords)
  check('the English anchor, retained Chinese channel and English tail are exact', planned.queries, englishPlan)
  check('diagnostics still name both unmatched Chinese runs', planned.diagnostics.unknownTerms,
    ['一个区块链浏览器', '支持多链查询和交易追踪'])
  check('both public planner entry points agree', buildQueries(unknownIdea, keywords), planned.queries)
  check('the discarded partial-coverage diagnostic is absent', 'partialTerms' in planned.diagnostics, false)

  const cases = [
    ['一个自托管的照片管理应用，支持人脸识别', 'self-hosted photo management face recognition', 'self-hosted photo'],
    ['一个本地的视频剪辑工具，支持字幕和转场', 'video editor subtitles transitions', 'video editor'],
    ['一个智能家居控制面板，支持语音助手', 'smart home dashboard voice assistant', 'smart home'],
    ['一个开源的邮件客户端，支持多账户和加密', 'open-source email client multi-account encryption', 'open-source email'],
    ['本地优先的笔记应用，支持人脸识别', 'local-first notes face recognition', 'local-first notes'],
  ]
  for (const [idea, hint, anchor] of cases) {
    const p = planQueries(idea, hint)
    check(`${idea}: a lexical miss really exists`, p.diagnostics.unknownTerms.length > 0)
    check(`${idea}: the English broad query leads`, p.queries[0].query, anchor)
    check(`${idea}: the Chinese precise channel survives`, p.queries.some((q) => q.role === 'precise' && han(q.query)))
    check(`${idea}: all three roles survive within budget`, p.queries.map((q) => q.role), ['anchor', 'precise', 'tail'])
    check(`${idea}: the tail is English and updated`, p.queries.some((q) => q.role === 'tail' && q.sort === 'updated' && !han(q.query)))
  }

  console.log('\n=== L2. reverse controls retain the original behaviour ===')
  const knownIdea = '本地优先的 Markdown 笔记应用，支持双向链接'
  const knownHint = 'local-first markdown notes bidirectional links'
  check('the original Q4 bilingual plan is unchanged', buildQueries(knownIdea, knownHint), [
    { query: '本地优先的 笔记应用', sort: 'stars', role: 'anchor' },
    { query: 'local-first markdown', sort: 'stars', role: 'precise' },
    { query: 'local-first markdown notes', sort: 'updated', role: 'tail', tailReason: 'updated' },
  ])
  check('a known idea with no keywords keeps its lexicon-led plan', buildQueries(knownIdea), [
    { query: 'local-first note-taking', sort: 'stars', role: 'anchor' },
    { query: '"本地优先的" markdown', sort: 'stars', role: 'precise' },
    { query: 'note-taking bidirectional', sort: 'stars', role: 'tail', tailReason: 'narrow' },
  ])
  const unknownNoHint = [
    { query: chineseQuery, sort: 'stars', role: 'anchor' },
    { query: '"一个区块链浏览器"', sort: 'stars', role: 'precise' },
    { query: '支持多链查询和交易追踪', sort: 'updated', role: 'tail', tailReason: 'updated' },
  ]
  check('an unknown idea without English keywords is not silently translated', buildQueries(unknownIdea), unknownNoHint)
  for (const hint of ['', '   ', '!!!', 'a']) {
    check(`an unusable hint ${JSON.stringify(hint)} cannot trigger English-first`, buildQueries(unknownIdea, hint), unknownNoHint)
  }
  check('Chinese-only keywords cannot trigger an English anchor', han(buildQueries(unknownIdea, '区块链浏览器 交易追踪')[0].query))
  check('an all-English idea and hint retain the existing plan', buildQueries('a markdown notes app', 'markdown notes bidirectional links'), [
    { query: 'markdown notes', sort: 'stars', role: 'anchor' },
    { query: 'markdown notes bidirectional links', sort: 'stars', role: 'precise' },
    { query: 'markdown notes bidirectional', sort: 'updated', role: 'tail', tailReason: 'updated' },
  ])
  // Skipped characters do not imply a missing search concept. Conversely, a run
  // can match a known concept while still containing an unrecognised feature.
  // Pin both boundaries: unknownTerms is NOT semantic-completeness detection.
  check('filler characters do not produce a partial warning', englishSeeds(['一个本地优先的待办事项管理工具']).unknown, [])
  check('known concepts surrounded by filler keep the Chinese-first layout',
    buildQueries('一个本地优先的待办事项管理工具', 'local-first todo management')[0].query,
    '一个本地优先的待办事项管理工具')
  const partialRun = '本地优先的笔记应用支持人脸识别'
  check('a known substring can hide an unmatched feature in the same run', planQueries(partialRun).diagnostics.unknownTerms, [])
  check('that lexical limitation does not trigger a fabricated partial signal', buildQueries(partialRun, 'local-first notes face recognition')[0].query, partialRun)

  console.log('\n=== L3. short and mixed hints remain legal ===')
  for (const hint of ['explorer', 'blockchain explorer', '区块链 blockchain explorer multi-chain', 'BLOCKCHAIN explorer blockchain multi-chain']) {
    const p = buildQueries(unknownIdea, hint)
    check(`${hint}: English anchor leads`, p[0].role === 'anchor' && !han(p[0].query))
    check(`${hint}: Chinese channel is preserved`, p.some((q) => q.role === 'precise' && han(q.query)))
    check(`${hint}: an updated English tail survives`, p.some((q) => q.role === 'tail' && q.sort === 'updated' && !han(q.query)))
    check(`${hint}: query budget and pair uniqueness hold`, p.length <= MAX_QUERIES && new Set(p.map((q) => `${q.sort}|${q.query}`)).size === p.length)
    check(`${hint}: every tail obeys the reachability guard`, p.every(isTailReachable))
  }
  check('a one-term hint reissues the English anchor with updated ordering', buildQueries(unknownIdea, 'explorer')[2],
    { query: 'explorer', sort: 'updated', role: 'tail', tailReason: 'updated' })
  check('planning remains deterministic with English keywords', buildQueries(unknownIdea, keywords), englishPlan)

  console.log('\n=== L4. the registered tool uses the new plan and ignores plan-6 disk cache ===')
  check('the search plan version was bumped for this routing change', SEARCH_PLAN_VERSION > 6)
  const defs = new Map()
  apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  const scout = defs.get('scout_projects')
  const args = { idea: unknownIdea, keywords, limit: 3 }
  const previousKey = searchCacheKeyFor(unknownIdea, keywords, 3, false, 6)
  const currentKey = searchCacheKeyFor(unknownIdea, keywords, 3, false)
  await cacheSet(previousKey, { candidates: [], tailIncluded: 0, incomplete: false, thin: null })
  cacheClearMemory()
  check('the old-plan entry is actually readable from disk', (await cacheGet(previousKey)) !== undefined)
  check('the current key misses the old-plan entry', await cacheGet(currentKey), undefined)

  // The mock records EVERY search request, including B6's per-term diagnostic
  // probes. `per_page` is the discriminator: the plan asks for `limit` rows,
  // a probe asks for exactly 1 (`src/github.ts:812`). Keeping both in one list
  // and splitting them here is what lets the next assertions say which calls
  // the ORDER contract covers — previously the deepEqual compared the whole
  // list against the three plan steps, so adding the probes turned a passing
  // contract into a failure without the contract itself changing.
  const calls = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.origin, 'https://api.github.com', 'all fetches are intercepted; no live network fallback')
    assert.equal(parsed.pathname, '/search/repositories')
    calls.push({
      query: parsed.searchParams.get('q'),
      sort: parsed.searchParams.get('sort'),
      perPage: Number(parsed.searchParams.get('per_page')),
    })
    // A real GitHub search response always carries the rate-limit headers, and
    // §7's probe guard reads them (`src/github.ts:1010`): with no
    // `x-ratelimit-remaining` the guard cannot judge the search budget and
    // deliberately skips the probes rather than spending a quota nobody
    // measured. This fixture used to omit them, which quietly starved the
    // guard and made every probe assertion below vacuous instead of failing.
    // Reporting a healthy budget keeps this file's focus on query routing; the
    // unknown-quota branch is pinned in test/probe-guard.test.mjs §7.3.
    return new Response(JSON.stringify({
      total_count: 1,
      incomplete_results: false,
      items: [{ full_name: 'fresh/explorer', html_url: 'https://github.com/fresh/explorer',
        owner: { login: 'fresh' }, name: 'explorer', description: 'blockchain explorer',
        stargazers_count: 12, language: 'TypeScript', pushed_at: '2026-01-01T00:00:00Z',
        topics: ['blockchain'], archived: false, fork: false }],
    }), { status: 200, headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': String(Math.max(0, 30 - calls.length)),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
    } })
  }
  const cold = await scout.execute(args, {})
  check('the first tool call fetches rather than serving old rows', cold.cached, false)

  // The order contract covers the PLAN calls only. Scoping it here is not a
  // loosening: the probe calls are asserted separately below, so a probe that
  // displaced or reordered a plan call still fails.
  const planCalls = calls.filter((c) => c.perPage !== 1)
  const probeCalls = calls.filter((c) => c.perPage === 1)
  check('the tool issues the exact new query order', planCalls.map(({ query, sort }) => ({ query, sort })), englishPlan.map(({ query, sort }) => ({ query, sort })))
  check('the plan calls are the first requests, not interleaved with probes', calls.slice(0, planCalls.length).every((c) => c.perPage !== 1))
  check('the cold call contains fresh rows', cold.candidates.map((c) => c.full_name), ['fresh/explorer'])

  // §3.4 / B6: the probes were "noise the test did not expect" — now they are
  // asserted behaviour. Three properties make them safe to run: they are
  // bounded, they only ever ask for one row, and every term they probe is a
  // term the plan actually sent (so a probe cannot widen the search surface).
  // NOTE: this file's `check(label, actual, expected)` has no detail slot —
  // the third argument is the EXPECTED value, so every assertion here must
  // compare against a real value (or omit it to compare against `true`).
  check('the probes are bounded by MAX_TERM_PROBES', probeCalls.length <= MAX_TERM_PROBES)
  check('at least one probe ran, so this guard is not vacuous', probeCalls.length > 0)
  const planTerms = new Set(englishPlan.flatMap(({ query }) => query.split(/\s+/)).filter((t) => t.length > 0))
  check('every probed term comes from the plan itself', probeCalls.every((c) => planTerms.has(c.query)))
  check('every probe asks for a single row', probeCalls.every((c) => c.perPage === 1))
  check('the probes never change the pool', cold.candidates.map((c) => c.full_name), ['fresh/explorer'])
  const afterCold = calls.length
  check('the cold phase is exactly plan calls plus probes', afterCold, planCalls.length + probeCalls.length)
  // The probe totals reach the card as diagnostics, and each probed term must
  // be reported with the count the probe returned — not silently dropped.
  // `execute` returns the value BEFORE `output.schema` conversion, so an
  // unmeasured term travels as TERM_TOTAL_UNKNOWN (-1) here rather than null
  // (`src/index.ts:602-605`, `:634-638`).
  const measured = cold.query_terms.filter((t) => t.total !== TERM_TOTAL_UNKNOWN)
  check('the probed terms are reported on the cold card', measured.map((t) => t.term).sort(), [...new Set(probeCalls.map((c) => c.query))].sort())
  check('every measured term carries the count its probe returned', measured.every((t) => t.total === 1))
  check('the plan terms no probe covered are reported as unknown', cold.query_terms.filter((t) => t.total === TERM_TOTAL_UNKNOWN).length > 0)
  // The absent-measurement rule: a term nobody probed must not read as "matches
  // nothing". This is the assertion that keeps -1 from decaying into 0.
  check('no term is ever reported as matching zero', cold.query_terms.every((t) => t.total !== 0))
  check('the lexical gap is still reported', cold.degraded.detail.includes('词表未覆盖'))
  check('the note acknowledges supplied keywords', cold.degraded.detail.includes('已使用'))
  cacheClearMemory()
  const warm = await scout.execute(args, {})
  check('the second tool call replays the new disk cache', warm.cached)
  // The replay must add NO requests of any kind — neither plan calls nor
  // probes. Asserting the exact count rather than "no more plan calls" is what
  // keeps a replayed probe (which would spend quota for a diagnostic the card
  // says is unsaved) from passing unnoticed.
  check('replay makes no further search requests at all', calls.length, afterCold)
  check('replay issues no plan calls', calls.filter((c) => c.perPage !== 1).length, planCalls.length)
  check('replay issues no probes', calls.filter((c) => c.perPage === 1).length, probeCalls.length)
  check('the new cold and replayed rows agree', warm.candidates, cold.candidates)
  check('replay retains the lexical gap note', warm.degraded.detail.includes('词表未覆盖'))
  check('neither path emits the removed partial warning',
    [cold, warm].every((r) => r.degraded.reason !== 'lexicon_partial' && !r.degraded.detail.includes('词表只覆盖了一部分')))
  check('the old cache was orphaned, not destroyed', (await cacheGet(previousKey)) !== undefined)
  console.log(`\n${pass} PASS / 0 FAIL`)
} finally {
  globalThis.fetch = realFetch
  cacheClearMemory()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  // scratch is the exact directory returned by mkdtempSync above, never a user path.
  rmSync(scratch, { recursive: true, force: true })
}
