/**
 * §8.10 / AC12 — the diagnostics must not claim more than they measured.
 *
 * Every other test in this suite asks "is the number right?". This one asks a
 * different question: **does the card say what the number is a number OF, and
 * does it admit when there is no number at all?**
 *
 * Four ways a card can overstate its evidence, each measured on the real tool:
 *
 *   D1  a query term that was never probed must read 「未测」, a term that was
 *       probed and matched nothing must read 「solo 无命中」. A bare `0` for the
 *       second invites "this word is useless"; showing nothing for the first
 *       invites "the term was checked and was fine".
 *   D2  a cache replay carries no probe counts. Printing nothing there is
 *       indistinguishable from a clean bill of health, so it must say the
 *       diagnostic was not saved.
 *   D3  a failed TAIL query must be reported as 「长尾通道覆盖未知」. The old
 *       wording claimed the returned rows were all high-star, which a failed
 *       channel cannot establish — an anchor-only plan was measured returning
 *       three 5★ repositories.
 *   D4  §7.6: the low-star count of the POOL and of the FINAL LIST are separate
 *       numbers. The scoring formula is unchanged by the user's ruling, so a
 *       small project can be in the pool, scored honestly, and still be pushed
 *       out of the card. One number cannot express that, and the difference
 *       between the two IS the measurement.
 *
 * Run `npx tsc -p tsconfig.json` first. This file loads the BUILT modules in
 * `lib/`, so a stale `lib/` is a false pass waiting to happen.
 *
 * Run with:  node test/diagnostics-honesty.test.mjs
 * Never with `node --test` — this file prints its own PASS/FAIL lines.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

// A scratch DSH_HOME keeps this file's cache entries out of the real profile and
// out of every other test file's way.
const scratchRoot = join(pkgRoot, '.scratch')
mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(join(scratchRoot, 'diagnostics-honesty-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch

const { apply } = await load('index.js')
const { renderCandidates } = await load('render.js')
const { countLowStar, describeProbeOutcome, describeUnavailableProbeDiagnostic, TAIL_STAR_CEILING } =
  await load('github.js')
const { describePartialFailure } = await load('query.ts'.replace('.ts', '.js'))
const { cacheClearMemory } = await load('cache.js')

// The coverage block's TITLE LINE, verbatim. Asserting on the bare phrase
// 「查询词覆盖」 is not enough: the cache-replay note names the block in order to
// say it is absent (「因此下面没有「查询词覆盖」区块」), so a substring test would
// fail on the very sentence that admits the omission.
const COVERAGE_HEADER = '查询词覆盖（每个词单独在 GitHub 上检索时命中多少仓库）：'

const realFetch = globalThis.fetch
let pass = 0
let fail = 0

function check(label, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

const row = (full_name, stars, n) => ({
  full_name,
  url: `https://github.com/${full_name}`,
  owner: full_name.split('/')[0],
  name: full_name.split('/')[1],
  description: `stub row ${n}`,
  stars,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  archived: false,
  topics: [],
})

const githubRow = (full_name, stars, n) => ({
  full_name,
  html_url: `https://github.com/${full_name}`,
  owner: { login: full_name.split('/')[0] },
  name: full_name.split('/')[1],
  description: `stub row ${n}`,
  stargazers_count: stars,
  language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z',
  topics: ['stub'],
  archived: false,
  fork: false,
})

const toolDefs = () => {
  const defs = new Map()
  apply({ tools: { register: (def) => defs.set(def.name, def) }, get: () => undefined })
  return defs
}

const renderOf = (def, value) => def.output.render({}, value)[0].text

try {
  const defs = toolDefs()
  const scout = defs.get('scout_projects')
  const rank = defs.get('rank_candidates')

  // =========================================================================
  console.log('\n=== D1. a measured zero and an unmeasured term are different claims ===')
  {
    // The three states, side by side in ONE card, so the assertion is about the
    // distinction rather than about three separate strings existing somewhere.
    const card = renderCandidates(
      'diagnostics probe',
      [row('some/repo', 10, 1)],
      null,
      false,
      0,
      [
        { term: 'matched-nothing', total: 0, verdict: 'carrying' },
        { term: 'never-probed', total: -1, verdict: 'selective' },
        { term: 'matched-wide', total: 12345, verdict: 'selective' },
      ],
      '',
    )

    check('a term probed and matching nothing is labelled as a measured zero',
      card.includes('0（solo 无命中）'), card)
    check('a term that was never probed is labelled unmeasured',
      card.includes('未知（未测得）'), card)
    check('the two states are rendered differently, not both as 0',
      card.includes('0（solo 无命中）') && card.includes('未知（未测得）'), card)
    check('a bare zero is never printed as the whole answer for a term',
      !/·\s*matched-nothing\s*→\s*0\s*$/m.test(card), card)
    check('a measured count still renders as a count',
      card.includes('matched-wide') && /12\.3k|12345/.test(card), card)
    check('the coverage block says it is a breadth heuristic, not semantic force',
      card.includes('基数启发式') && card.includes('不是语义约束力'), card)

    // The whole block is omitted when NOTHING was measured — that is D2's job to
    // explain, and the two must not both fire.
    const noneMeasured = renderCandidates(
      'diagnostics probe',
      [row('some/repo', 10, 1)],
      null,
      false,
      0,
      [{ term: 'never-probed', total: -1, verdict: 'selective' }],
      '',
    )
    check('with no measured term the coverage block is omitted entirely',
      !noneMeasured.includes(COVERAGE_HEADER), noneMeasured)
  }

  // =========================================================================
  console.log('\n=== D2. a cache replay admits the diagnostic was not saved ===')
  {
    // End to end through the real tool: cold run fills the cache, the second
    // identical call is served from it. Only the replay is asserted on — the
    // cold run is the control that proves the note is about the CACHE and not
    // about this search.
    const items = [
      githubRow('cache/alpha', 50000, 1),
      githubRow('cache/beta', 40000, 2),
      githubRow('cache/gamma', 7, 3),
    ]
    let fetches = 0
    globalThis.fetch = async (url) => {
      const parsed = new URL(typeof url === 'string' ? url : String(url?.url ?? url))
      const perPage = Number(parsed.searchParams.get('per_page'))
      fetches += 1
      const slice = items.slice(0, perPage === 1 ? 1 : perPage)
      return new Response(
        JSON.stringify({ total_count: slice.length, incomplete_results: false, items: slice }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '30',
            'x-ratelimit-remaining': '25',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        },
      )
    }

    cacheClearMemory()
    rmSync(join(scratch, 'cache'), { recursive: true, force: true })
    const args = { idea: 'a local-first markdown notes app', keywords: 'markdown notes', limit: 3 }

    const cold = await scout.execute(args, {})
    const coldFetches = fetches
    const replay = await scout.execute(args, {})

    check('the cold run really hit the network', coldFetches > 0, `fetches=${coldFetches}`)
    check('the second call is served from the cache', replay.cached === true, `cached=${replay.cached}`)
    check('the replay made no request at all', fetches === coldFetches, `${coldFetches} -> ${fetches}`)
    check('the cold run reports a real probe outcome, not the cache note',
      cold.probe_note !== describeUnavailableProbeDiagnostic(), cold.probe_note)
    check('the replay says the diagnostic was not saved',
      replay.probe_note.includes('诊断未保存'), replay.probe_note)
    check('the replay does not imply the terms came back clean',
      replay.probe_note.includes('不代表检索词都有效'), replay.probe_note)
    check('the replay carries no per-term counts to be misread',
      Array.isArray(replay.query_terms) && replay.query_terms.length === 0,
      JSON.stringify(replay.query_terms))

    // The note must reach the CARD, not just the return value — the card is what
    // the reader sees, and this is the wiring that was missing.
    const replayed = renderOf(scout, replay)
    check('the cache note is printed on the card', replayed.includes('诊断未保存'), replayed)
    // The note itself names the missing block, so asserting on the phrase
    // 「查询词覆盖」 would fail on the very sentence that admits the absence.
    // The HEADER is the thing that must be absent.
    check('the card has no coverage block to contradict it',
      !replayed.includes(COVERAGE_HEADER), replayed)
    check('the note only mentions the block to say it is missing',
      replayed.includes(COVERAGE_HEADER) === false && replayed.includes('没有「查询词覆盖」区块'), replayed)

    // A skipped probe is a budget fact and must be worded as one. This is the
    // §7.2 half of the same honesty rule.
    const exhausted = describeProbeOutcome({ skipped: 'search_quota_exhausted', planned: 3, attempted: 0, searchRemaining: 0 })
    check('an exhausted search bucket explains why the probes were skipped',
      exhausted.includes('搜索配额已用尽'), exhausted)
    check('an unknown quota is reported as unknown, not as plentiful',
      describeProbeOutcome({ skipped: 'search_quota_unknown', planned: 3, attempted: 0 }).includes('配额未知'),
      describeProbeOutcome({ skipped: 'search_quota_unknown', planned: 3, attempted: 0 }))
    check('an unknown quota is explicitly not "zero hits"',
      describeProbeOutcome({ skipped: 'search_quota_unknown', planned: 3, attempted: 0 }).includes('未测'),
      describeProbeOutcome({ skipped: 'search_quota_unknown', planned: 3, attempted: 0 }))
  }

  // =========================================================================
  console.log('\n=== D3. a failed tail channel is "coverage unknown", not "all high-star" ===')
  {
    const plan = [
      { query: 'local-first markdown notes', sort: 'stars', role: 'anchor' },
      { query: 'offline knowledge base', sort: 'stars', role: 'precise' },
      { query: 'plain text archive', sort: 'updated', role: 'tail' },
    ]
    const detail = describePartialFailure(plan, ['plain text archive: 403'], true, ['tail'])

    check('the tail failure is reported as unknown coverage',
      detail.includes('长尾通道覆盖未知'), detail)
    check('it names WHICH population went uncovered',
      detail.includes(`star ≤ ${TAIL_STAR_CEILING} 的小项目`) || detail.includes('star ≤ 100 的小项目'), detail)
    check('it does not claim the returned rows are all high-star',
      !detail.includes('只包含高 star'), detail)
    check('it says the rows in hand cannot answer the question',
      detail.includes('无从判断'), detail)
    check('it does not turn "uncovered" into "absent"',
      detail.includes('不代表不存在相关的小项目'), detail)

    // A non-tail failure must NOT get the tail warning: the note is about the
    // channel that failed, and borrowing it for an anchor failure would be a
    // claim about a lane that ran fine.
    const anchorOnly = describePartialFailure(plan, ['local-first markdown notes: 403'], true, ['anchor'])
    check('an anchor-only failure does not borrow the tail warning',
      !anchorOnly.includes('长尾通道覆盖未知'), anchorOnly)
  }

  // =========================================================================
  console.log('\n=== D4. §7.6 — the pool count and the final-list count are separate ===')
  {
    // The case §7.6 names: three low-star rows are IN the pool, all scored the
    // same relevance as the giants, and the formula pushes every one of them out
    // of a 3-row card. Before this change the card reported only `kept`, so the
    // reader saw "3 projects" with no way to tell that 3 more had just been
    // displaced.
    const candidates = [
      row('giant/one', 50000, 1),
      row('giant/two', 40000, 2),
      row('giant/three', 30000, 3),
      row('small/one', 5, 4),
      row('small/two', 2, 5),
      row('small/three', 0, 6),
    ]
    const scores = candidates.map((c) => ({ full_name: c.full_name, relevance: 5 }))
    const result = await rank.execute({ idea: 'diagnostics probe', candidates, scores, limit: 3 })

    check('the pool really contained the low-star rows',
      result.noise.low_star_in_pool === 3, JSON.stringify(result.noise))
    check('none of them survived into the card',
      result.noise.low_star_in_kept === 0, JSON.stringify(result.noise))
    check('the two counts are therefore different — the loss is visible',
      result.noise.low_star_in_pool !== result.noise.low_star_in_kept, JSON.stringify(result.noise))
    check('the pool count is computed with the shared definition',
      result.noise.low_star_in_pool === countLowStar(candidates), JSON.stringify(result.noise))
    check('the final count is computed with the same shared definition',
      result.noise.low_star_in_kept === countLowStar(result.ranked), JSON.stringify(result.noise))
    check('the low-star rows really are absent from the ranked list',
      !result.ranked.some((r) => r.full_name.startsWith('small/')),
      result.ranked.map((r) => r.full_name).join(', '))

    const card = renderOf(rank, result)
    check('the card prints both counts', card.includes('候选池里 star ≤ 100 的小项目 3 个')
      && card.includes('进入最终榜 0 个'), card)
    check('the card names the displaced rows as a number',
      card.includes('其中 3 个在池里但没进榜'), card)
    check('the card states the formula was NOT changed', card.includes('公式本身未改动'), card)
    check('the card warns the ranking is not the whole pool',
      card.includes('不要把本榜当作全集'), card)

    // The opposite case: when nothing is displaced the warning must NOT fire,
    // or it would cry loss on every healthy card.
    const keptAll = await rank.execute({
      idea: 'diagnostics probe',
      candidates: [row('small/one', 5, 1), row('small/two', 2, 2)],
      scores: [{ full_name: 'small/one', relevance: 5 }, { full_name: 'small/two', relevance: 5 }],
      limit: 10,
    })
    const keptCard = renderOf(rank, keptAll)
    check('both low-star rows survive when the limit allows it',
      keptAll.noise.low_star_in_pool === 2 && keptAll.noise.low_star_in_kept === 2,
      JSON.stringify(keptAll.noise))
    check('no displacement warning when nothing was displaced',
      !keptCard.includes('没进榜'), keptCard)

    // A pool with no low-star rows at all: the long-tail line must be silent
    // rather than reporting a zero the reader would read as a finding.
    const noTail = await rank.execute({
      idea: 'diagnostics probe',
      candidates: [row('giant/one', 50000, 1), row('giant/two', 40000, 2)],
      scores: [{ full_name: 'giant/one', relevance: 5 }, { full_name: 'giant/two', relevance: 5 }],
      limit: 10,
    })
    check('a pool with no low-star rows reports zero on both counts',
      noTail.noise.low_star_in_pool === 0 && noTail.noise.low_star_in_kept === 0,
      JSON.stringify(noTail.noise))
    check('and prints no long-tail line at all',
      !renderOf(rank, noTail).includes('长尾：'), renderOf(rank, noTail))
  }

  // =========================================================================
  console.log('\n=== D5. the search side reports the pool population, and the schema declares it ===')
  {
    // `low_star_in_pool` must be part of the tool's declared OUTPUT, not only of
    // its return value: the schema is what the host shows, and an undeclared
    // field is invisible to any reader that goes through it.
    const props = scout.output.schema.properties ?? {}
    // The framework hoists a property-level `required: true` into a top-level
    // `required` array, so the flag is NOT on the property object at runtime.
    // Checking `props.x.required` would fail against a schema that is in fact
    // correct — assert where the requirement actually lands.
    const required = scout.output.schema.required ?? []
    check('scout_projects declares low_star_in_pool in its output schema',
      props.low_star_in_pool !== undefined, JSON.stringify(Object.keys(props)))
    check('it is a required integer, like its tail_included sibling',
      props.low_star_in_pool?.type === 'integer'
      && required.includes('low_star_in_pool') && required.includes('tail_included'),
      `prop=${JSON.stringify(props.low_star_in_pool ?? null)} required=${JSON.stringify(required)}`)
    check('the old reservation count is still declared too',
      props.tail_included !== undefined, JSON.stringify(Object.keys(props)))

    const noiseSchema = rank.output.schema.properties?.noise ?? {}
    const rankProps = noiseSchema.properties ?? {}
    const noiseRequired = noiseSchema.required ?? []
    check('rank_candidates declares both §7.6 counts',
      rankProps.low_star_in_pool !== undefined && rankProps.low_star_in_kept !== undefined,
      JSON.stringify(Object.keys(rankProps)))
    check('both are required integers',
      rankProps.low_star_in_pool?.type === 'integer' && rankProps.low_star_in_kept?.type === 'integer'
      && noiseRequired.includes('low_star_in_pool') && noiseRequired.includes('low_star_in_kept'),
      `props=${JSON.stringify(rankProps)} required=${JSON.stringify(noiseRequired)}`)

    // The card distinguishes an UNMEASURED population from a measured zero. A
    // caller that never took the measurement must not have one invented.
    const unmeasured = renderCandidates(
      'diagnostics probe',
      [row('small/one', 5, 1), row('giant/one', 9000, 2)],
      null, false, 1, [], '',
    )
    check('an unmeasured population falls back to the reservation wording',
      unmeasured.includes('（已为其保留槽位）'), unmeasured)
    check('an unmeasured population is not reported as a count of zero',
      !unmeasured.includes('候选池里 0 个'), unmeasured)

    const measured = renderCandidates(
      'diagnostics probe',
      [row('small/one', 5, 1), row('giant/one', 9000, 2)],
      null, false, 1, [], '', 1,
    )
    check('a measured population is reported as the pool count',
      measured.includes('候选池里 1 个是 star ≤ 100 的小项目'), measured)
    check('the reservation is reported as a subset of the population',
      measured.includes('其中 1 个由保留槽位入选'), measured)
    check('a measured population of zero with no reservation prints nothing',
      !renderCandidates('diagnostics probe', [row('giant/one', 9000, 1)], null, false, 0, [], '', 0)
        .includes('star ≤ 100 的小项目'),
      'the long-tail line should be silent when there is no tail')
  }
} finally {
  globalThis.fetch = realFetch
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
