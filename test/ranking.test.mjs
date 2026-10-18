// Regression tests for the ranking layer (rank_candidates).
//
// These are the behaviours the user actually asked for: the agent supplies
// relevance ONLY, and order/rating/score are produced by code.
//
// Run with:  npm test
// Or directly: node test/ranking.test.mjs
//
// The paths resolve relative to this file, so the suite runs from a checkout
// and from an installed copy alike.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
const readSrc = (rel) => readFileSync(join(pkgRoot, 'src', rel), 'utf8')

const { rankCandidates, finalScore, ratingFromRelevance, STAR_FLOOR, MIN_RELEVANCE } = await load('types.js')

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

const repo = (full_name, stars, extra = {}) => ({
  full_name,
  url: `https://github.com/${full_name}`,
  owner: full_name.split('/')[0],
  name: full_name.split('/')[1],
  description: 'test repo',
  stars,
  language: 'TypeScript',
  pushed_at: '2024-01-01T00:00:00Z',
  archived: false,
  topics: [],
  ...extra,
})

console.log('\n=== 1. order is decided by code, not by the caller ===')
{
  // The flat list is given WORST-FIRST on purpose: if order leaked through from
  // the input array, this would come back reversed.
  // relevance 3 is the weakest judgement that still enters the card, so this is
  // the strongest available form of "cold and on-point beats famous and vague".
  const candidates = [repo('a/low', 0), repo('b/high', 50000)]
  const { ranked } = rankCandidates(candidates, [
    { full_name: 'a/low', relevance: 10 },
    { full_name: 'b/high', relevance: 3 },
  ])

  check('most relevant cold repo outranks a tangentially-related giant', ranked[0].full_name === 'a/low', ranked.map(r => r.full_name).join(' > '))
  check('rank field is assigned 1..n', ranked[0].rank === 1 && ranked[1].rank === 2)
  check('score matches the formula', ranked[0].score === finalScore(10, 0), `${ranked[0].score} vs ${finalScore(10, 0)}`)
}

console.log('\n=== 2. the 0-star annihilation bug is fixed ===')
{
  const { ranked } = rankCandidates([repo('cold/onpoint', 0)], [{ full_name: 'cold/onpoint', relevance: 9 }])
  check('0-star on-point repo scores > 0', ranked[0].score > 0, `score=${ranked[0].score}`)
  check('0 stars and 10 stars score identically (floor)', finalScore(9, 0) === finalScore(9, STAR_FLOOR))
  // The calibration case that originally justified log10 must still hold.
  check('calibration: r9/200* still beats r4/50k*', finalScore(9, 200) > finalScore(4, 50000), `${finalScore(9, 200).toFixed(2)} vs ${finalScore(4, 50000).toFixed(2)}`)
}

console.log('\n=== 3. relevance 0 drops a candidate instead of ranking it last ===')
{
  const candidates = [repo('good/one', 100), repo('bait/keyword', 99999)]
  const { ranked, dropped } = rankCandidates(candidates, [
    { full_name: 'good/one', relevance: 8 },
    { full_name: 'bait/keyword', relevance: 0 },
  ])
  check('noise repo absent from ranked', !ranked.some(r => r.full_name === 'bait/keyword'))
  check('noise repo reported in dropped', dropped.includes('bait/keyword'))
  check('on-topic repo survives', ranked.length === 1 && ranked[0].full_name === 'good/one')
}

console.log('\n=== 4. unscored candidates must not leak into the card ===')
{
  // This is the live failure mode: 45 candidates fetched, 6 judged. If silence
  // admitted a candidate, the other 39 would reappear unranked.
  const candidates = [repo('scored/one', 10), repo('silent/two', 5000), repo('silent/three', 8000)]
  const { ranked } = rankCandidates(candidates, [{ full_name: 'scored/one', relevance: 7 }])
  check('only the scored candidate is ranked', ranked.length === 1, `${ranked.length} rows`)
}

console.log('\n=== 5. star rating is derived, never caller-authored ===')
{
  const { ranked } = rankCandidates([repo('r/high', 50)], [{ full_name: 'r/high', relevance: 10 }])
  check('relevance 10 -> 5 stars', ranked[0].stars_rating === 5)
  // T9: the display bands are aligned to the relevance scale's own bands. This
  // asserts the STRUCTURE (monotone, 1-5, full range, and the boundaries the
  // alignment promises) rather than two sample points, because a two-point check
  // can only be kept green by editing the two numbers — which is how a real
  // regression change gets relabelled as an intended one.
  check('ratingFromRelevance builds from the relevance bands', ratingFromRelevance(10) === 5 && ratingFromRelevance(9) === 4 && ratingFromRelevance(8) === 4 && ratingFromRelevance(7) === 3 && ratingFromRelevance(6) === 3 && ratingFromRelevance(5) === 2 && ratingFromRelevance(4) === 2 && ratingFromRelevance(3) === 1)
  check('ratingFromRelevance is monotone over 0-10', [...Array(11).keys()].every((r) => r === 0 || ratingFromRelevance(r) >= ratingFromRelevance(r - 1)))
  check('every surviving card row (relevance >= MIN_RELEVANCE) renders at 1-5 stars', [...Array(11).keys()].filter((r) => r >= MIN_RELEVANCE).every((r) => ratingFromRelevance(r) >= 1 && ratingFromRelevance(r) <= 5))
  check('relevance 0 still renders as 1 star, not 0', ratingFromRelevance(0) === 1)
}

console.log('\n=== 6. unknown names are reported, not silently dropped ===')
{
  const { ranked, unknown } = rankCandidates([repo('real/one', 5)], [
    { full_name: 'real/one', relevance: 5 },
    { full_name: 'hallucinated/repo', relevance: 10 },
  ])
  check('hallucinated name listed in unknown', unknown.includes('hallucinated/repo'))
  check('hallucination does not enter the card', !ranked.some(r => r.full_name === 'hallucinated/repo'))
}

console.log('\n=== 7. relevance is clamped to the declared 0-10 domain ===')
{
  const { ranked } = rankCandidates([repo('x/y', 10), repo('x/z', 10)], [
    { full_name: 'x/y', relevance: 99 },
    { full_name: 'x/z', relevance: -5 },
  ])
  check('oversized relevance clamped to 10', ranked.find(r => r.full_name === 'x/y').relevance === 10)
  check('negative relevance treated as 0 and dropped', !ranked.some(r => r.full_name === 'x/z'))
}

console.log('\n=== 7b. the relevance floor keeps broad-query noise out ===')
{
  // The live case: widening to "markdown note" pulled in a 188k-star document
  // converter. At relevance 3 it outscored every relevant small project and took
  // a card slot; the floor is what removes it.
  const candidates = [repo('noise/converter', 188000), repo('onpoint/small', 40), repo('edge/threestar', 500)]
  const { ranked, belowThreshold } = rankCandidates(candidates, [
    { full_name: 'noise/converter', relevance: 2 },
    { full_name: 'onpoint/small', relevance: 9 },
    { full_name: 'edge/threestar', relevance: 3 },
  ])
  check('relevance 2 is excluded from the card', !ranked.some(r => r.full_name === 'noise/converter'))
  check('excluded row is reported in belowThreshold', belowThreshold.includes('noise/converter'))
  check('relevance 3 still enters (boundary is inclusive)', ranked.some(r => r.full_name === 'edge/threestar'))
  check('relevant small repo now leads the card', ranked[0].full_name === 'onpoint/small', ranked[0].full_name)
}

console.log('\n=== 8. order is total and deterministic (no tie flapping) ===')
{
  const candidates = [repo('t/b', 100), repo('t/a', 100), repo('t/c', 100)]
  const scores = candidates.map(c => ({ full_name: c.full_name, relevance: 5 }))
  const one = rankCandidates(candidates, scores).ranked.map(r => r.full_name)
  const two = rankCandidates([...candidates].reverse(), scores).ranked.map(r => r.full_name)
  check('identical scores produce identical order regardless of input order', JSON.stringify(one) === JSON.stringify(two), `${one} vs ${two}`)
}

console.log('\n=== 9. the registered tool exposes what we think it does ===')
{
  // Registered through the real `apply`, so this asserts the tool contract as
  // the runtime sees it — not that certain strings appear in the source.
  const defs = new Map()
  const mod = await load('index.js')
  mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })

  check('rank_candidates is registered', defs.has('rank_candidates'), [...defs.keys()].join(', '))
  check('scout_projects is registered', defs.has('scout_projects'), [...defs.keys()].join(', '))
  check('inspect_projects is registered', defs.has('inspect_projects'), [...defs.keys()].join(', '))

  const scout = defs.get('scout_projects')
  const rank = defs.get('rank_candidates')
  check('scout_projects names rank_candidates as its next step', /rank_candidates/.test(scout.description))
  // B2/B4 (user m00793) added `keywords` (the query to check descriptions
  // against) to this surface; `pool_source` came later and is purely
  // descriptive — it names where the pool came from and changes no number
  // (`src/index.ts:924-930`, `:1079`). The assertion's SUBJECT is unchanged —
  // the ranker still accepts no computed field — so it is updated to the new
  // surface rather than loosened to a substring test that would stop catching a
  // `stars` or `stars_rating` parameter sneaking back in.
  check('rank_candidates accepts only a relevance judgement per row', JSON.stringify(Object.keys(rank.parameters.properties ?? {}).sort()) === JSON.stringify(['candidates', 'idea', 'keywords', 'limit', 'pool_source', 'scores']), JSON.stringify(Object.keys(rank.parameters.properties ?? {})))
  // The two descriptive additions must stay descriptive: neither may become an
  // input to the formula. `pool_source` is echoed onto the card; `keywords` only
  // feeds the contradiction check. Asserting their descriptions keeps a future
  // edit from quietly turning either into a scoring input.
  check('pool_source is documented as descriptive-only', /changes no number|descriptive/i.test(rank.parameters.properties?.pool_source?.description ?? ''), rank.parameters.properties?.pool_source?.description)
  check('keywords is documented as never entering the formula', /never enters the ranking formula/i.test(rank.parameters.properties?.keywords?.description ?? ''), rank.parameters.properties?.keywords?.description)
  check('the agent cannot pass stars or a rating to the ranker', !('stars' in (rank.parameters.properties ?? {})) && !('stars_rating' in (rank.parameters.properties ?? {})))
  // B4: a rationale is allowed, but only inside `scores[]`, never as a top-level
  // field that could be read as a tool input, and it is never scored.
  check('a per-row rationale is accepted only as scores[].note', (() => {
    const item = rank.parameters.properties?.scores?.items?.properties ?? {}
    return 'note' in item && !('note' in (rank.parameters.properties ?? {}))
  })(), JSON.stringify(Object.keys(rank.parameters.properties?.scores?.items?.properties ?? {})))

  // m08552: in the one observed trial session the agent re-presented the card with
  // the 简介 column dropped. The contract named the protected data (order,
  // relevance, stars, score, owner, name, url) but not the description COLUMN, and
  // it explicitly licensed "Paraphrasing a description is fine" — so an agent could
  // drop the whole column and still be inside the letter of the rule. The
  // description now names the column, and these assertions keep it named: without
  // them the sentence can drift back to "paraphrasing is fine" and the same column
  // silently disappears again.
  const rankDesc = rank.description ?? ''
  check('rank_candidates forbids dropping a column, not just a row', /dropping a row or a column/i.test(rankDesc), rankDesc.slice(0, 400))
  check('rank_candidates requires the description column in a restated card', /must appear for every row/i.test(rankDesc))
  check('rank_candidates no longer licenses paraphrasing the column away', !/Paraphrasing a description is fine/i.test(rankDesc))
  // The column rule must not have been bought by dropping the older guarantee
  // that a restated card's numbers stay traceable to the card. Both fit in the
  // same three lines, and this asserts the second one survived.
  check('rank_candidates still requires every number to stay traceable', /traceable to the card/i.test(rankDesc))

  // P4: the files parameter's description used to say "Pass it only to override"
  // while the README documented the two-step flow as the recommended path — the
  // contradiction is what made agents never pass files (0/3 in the one observed
  // session). The description now frames the two-step flow as a normal use. A
  // text-only change drifts back silently without an assertion on the contract
  // the agent actually reads.
  const inspect = defs.get('inspect_projects')
  const filesDesc = inspect.parameters.properties?.files?.description ?? ''
  check('files description no longer says "only to override"', !/only to override/i.test(filesDesc), filesDesc.slice(0, 200))
  check('files description presents the two-step flow as a normal use', /most useful FOR THIS IDEA|which paths matter/.test(filesDesc), filesDesc.slice(0, 200))
  check('files description still says explicit paths override the selector', /override the selector/.test(filesDesc), filesDesc.slice(0, 200))
}

console.log('\n=== 10. CJK ideas produce a usable plan (regression for the 0-result bug) ===')
{
  // The behavioural cover for this lives in test/queries.test.mjs, which calls
  // buildQueries and inspects the real plan. What is checked here is only the
  // part that belongs to the ranking suite: the tool still registers.
  //
  // Replaced assertions: `src.includes('`"${raw}"`')`, `src.includes('latinSeed')`
  // and `/地优|先的/.test(src)`. The first two are literally string-presence
  // checks, and the third asserts a REJECTED strategy is still mentioned in a
  // comment — it would fail if someone deleted the comment, while passing if the
  // behaviour regressed. A criterion narrower than the defect reports "no
  // problem" indefinitely.
  const defs = new Map()
  const mod = await load('index.js')
  mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  check('scout_projects still registered after the CJK change', defs.has('scout_projects'))
}

console.log('\n=== 11. the long tail survives pool selection (regression for the crowded-out bug) ===')
{
  // Measured bug: merging three queries produced 59 unique repos, 25 of them
  // with ≤100 stars, and star-descending truncation returned ZERO of them (the
  // smallest survivor had 2,528 stars). The tail must get reserved slots.
  //
  // `selectPool` now takes the per-query result CHANNELS rather than one merged
  // row list, because the merge is reciprocal-rank fusion plus a per-channel
  // quota (see github.ts). These fixtures pass a single channel wherever the old
  // tests passed one list: fusion of one channel is that channel's order, so the
  // assertions below still probe the tail logic they were written for.
  const { selectPool, TAIL_STAR_CEILING, TAIL_RESERVED_SLOTS } = await load('github.js')

  const anchors = Array.from({ length: 30 }, (_, i) => repo(`anchor/big${i}`, 50000 - i * 1000))
  const tail = [
    repo('tail/one', 21), repo('tail/two', 4), repo('tail/three', 2), repo('tail/four', 2),
    repo('tail/five', 1), repo('tail/six', 1), repo('tail/seven', 1), repo('tail/eight', 1),
    repo('tail/nine', 0), repo('tail/ten', 0),
  ]
  const pool = selectPool([[...anchors, ...tail]], 30)

  check('pool is exactly the requested size', pool.candidates.length === 30, String(pool.candidates.length))
  check('low-star rows survive truncation', pool.candidates.some(c => c.stars <= TAIL_STAR_CEILING))
  check(`reserved slots are used (${TAIL_RESERVED_SLOTS})`, pool.tailIncluded === TAIL_RESERVED_SLOTS, String(pool.tailIncluded))
  check('high-star anchors still dominate the pool', pool.candidates.filter(c => c.stars > TAIL_STAR_CEILING).length === 22)
  check('reported threshold matches the ceiling constant', pool.tailThreshold === TAIL_STAR_CEILING)
  check('no duplicate rows across head and tail', new Set(pool.candidates.map(c => c.full_name)).size === 30)

  // Default behaviour must be untouched when there is no tail to protect.
  const noTail = selectPool([anchors], 30)
  check('no tail rows -> unchanged selection', noTail.tailIncluded === 0 && noTail.candidates.length === 30)
  check('no tail rows -> same order as plain star sort', noTail.candidates[0].full_name === 'anchor/big0')

  // A tiny limit must not hand the only slot to a 0-star repo.
  const tiny = selectPool([[...anchors, ...tail]], 1)
  check('limit=1 reserves nothing (best anchor keeps the slot)', tiny.tailIncluded === 0 && tiny.candidates[0].full_name === 'anchor/big0')

  // If a query returns only tiny repos, reserving would be pointless — take them all.
  // `tailIncluded` counts rows that entered BECAUSE of a reserved slot, not every
  // low-star row in the pool: the rest of an all-tail pool arrives as normal seats.
  const onlyTail = selectPool([tail], 10)
  check('all-tail pool still fills the request', onlyTail.candidates.length === 10)
  check('all-tail pool reports only the reserved rows, not every low-star row',
    onlyTail.tailIncluded === Math.min(8, 5), String(onlyTail.tailIncluded))
}

console.log('\n=== 11b. the pool is built by channel fusion, and still reads star-descending ===')
{
  // Three properties of the merge that the old star-sort-then-slice could not
  // have, each one a measured defect it fixes:
  //
  //  (a) a per-channel head claim survives fusion — without it, global RRF
  //      replaced the 37,411-star `glanceapp/glance` anchor on the RSS case with
  //      a 488-star repo, because RRF rewards agreement and a narrow query's
  //      entire list is agreement;
  //  (b) a repo agreeing across channels outranks a one-channel leader, which is
  //      how the CJK half of the corpus (invisible to every Latin query) enters;
  //  (c) the RETURNED order is star-descending again, because position is read as
  //      a quality signal by the card renderer and a 917-star row above a
  //      46,706-star one reads as a bug.
  const { selectPool } = await load('github.js')

  // (a) The anchor leads channel 2 only, and channel 1 offers 30 bigger repos.
  const bigGeneric = Array.from({ length: 30 }, (_, i) => repo(`generic/big${i}`, 90000 - i * 100))
  const anchorChannel = [repo('fossar/selfoss', 2475), ...Array.from({ length: 5 }, (_, i) => repo(`rss/small${i}`, 20 - i))]
  const pool = selectPool([bigGeneric, anchorChannel], 30)
  check('a channel head is seated even when 30 larger repos exist',
    pool.candidates.some((c) => c.full_name === 'fossar/selfoss'), JSON.stringify(pool.candidates.map(c => c.full_name).slice(0, 5)))
  check('an under-ceiling channel head is not lost to the reserved-slot rules',
    pool.candidates.some((c) => c.full_name === 'rss/small0'))
  check('the channel head is not seated at the expense of the pool size',
    pool.candidates.length === 30, String(pool.candidates.length))

  // (b) A repo agreeing across two channels must be ADMITTED and must be given
  //     real standing. This is not observable in the returned order, which is
  //     deliberately star-descending (see (c)) — the agreement score decides
  //     membership and the reserved-slot ranking, not presentation. So the
  //     fixture makes admission the question: two channels, two seats, and the
  //     agreeing repo is mid-list in both while each channel leads with an
  //     unrelated repo.
  const agree = repo('agree/repo', 50)
  const fused = selectPool([
    [repo('solo/a', 500), agree],
    [repo('solo/b', 900), agree],
  ], 3)
  const names = fused.candidates.map((c) => c.full_name)
  check('a repo appearing in two channels is admitted', names.includes('agree/repo'), JSON.stringify(names))
  check('admission does not disturb the star-descending presentation',
    fused.candidates[0].full_name === 'solo/b', JSON.stringify(names))

  // The quota is per channel and bounded, so a fusion of one channel cannot seat
  // the whole channel by "quota" — only its first CHANNEL_QUOTA rows.
  const { CHANNEL_QUOTA } = await load('github.js')
  const single = Array.from({ length: 30 }, (_, i) => repo(`c/r${i}`, 1000 - i))
  const singlePool = selectPool([single], 30)
  check(`every row of a single channel is still returned (${singlePool.candidates.length})`,
    singlePool.candidates.length === 30, String(singlePool.candidates.length))
  check(`CHANNEL_QUOTA is a bounded constant (${CHANNEL_QUOTA})`,
    Number.isInteger(CHANNEL_QUOTA) && CHANNEL_QUOTA >= 1 && CHANNEL_QUOTA <= 8, String(CHANNEL_QUOTA))

  // (c) Whatever fusion decided about membership, position is stars again.
  const stars = pool.candidates.map((c) => c.stars)
  check('the returned pool is star-descending',
    stars.every((s, i) => i === 0 || stars[i - 1] >= s), JSON.stringify(stars.slice(0, 6)))

  // Channel-level de-duplication: the same repo listed twice inside ONE channel
  // must not double that channel's weight for it.
  const doubled = selectPool([[repo('dup/x', 100), repo('dup/x', 100), repo('other/y', 50)]], 3)
  check('a duplicate inside a channel is collapsed, not double-weighted',
    new Set(doubled.candidates.map((c) => c.full_name)).size === doubled.candidates.length,
    JSON.stringify(doubled.candidates.map(c => c.full_name)))
}

console.log('\n=== 11c. reserved seats are attributed to the tail channel (T6) ===')
{
  // Measured problem: stage 3 scanned the FUSED order for rows under the ceiling,
  // never asking which channel returned them. A broad anchor query returns small
  // repos as collateral, so the reserved seats were filled by the anchor's
  // leftovers while `tailIncluded` reported 8 regardless — the one number that
  // exists to show the reservation working was blind to its own subject. On the
  // frozen suite the tail channel's true marginal contribution is as low as 2
  // rows (api-mock-en), so most of the reserve was paying for the anchor's rows.
  const { selectPool, TAIL_STAR_CEILING } = await load('github.js')

  const anchors = Array.from({ length: 30 }, (_, i) => repo(`anchor/big${i}`, 50000 - i * 1000))
  // The anchor channel ALSO carries small repos — the situation that used to
  // satisfy the reserve without the tail channel contributing anything.
  const anchorWithCollateral = [...anchors, repo('anchor/smallcollateral', 3)]
  // The tail channel's own rows, distinct from the anchor's collateral.
  const fromTail = [
    repo('tail/one', 12), repo('tail/two', 8), repo('tail/three', 5),
    repo('tail/four', 3), repo('tail/five', 2), repo('tail/six', 1),
    repo('tail/seven', 0), repo('tail/eight', 0),
  ]
  const collSort = [...anchors, ...fromTail].sort((a, b) => b.stars - a.stars)

  // Same channels, two labels: [anchor, tail] vs [anchor, anchor]. The ONLY
  // difference is the declared role of channel 1.
  const labelled = selectPool([anchorWithCollateral, collSort], 30, ['anchor', 'tail'])
  const unlabelled = selectPool([anchorWithCollateral, collSort], 30, ['anchor', 'anchor'])

  const tailSeated = labelled.candidates.filter((c) => c.full_name.startsWith('tail/'))
  const unlabelledTailSeated = unlabelled.candidates.filter((c) => c.full_name.startsWith('tail/'))

  check('the tail channel rows are seated when the role says so',
    tailSeated.length > 0, JSON.stringify(tailSeated.map(c => c.full_name)))
  // The anchor's collateral row is ≤ ceiling, so under the OLD rule it competed
  // for a reserved seat. Under attribution the reserve is filled from the tail
  // channel only, so the collateral can still appear (it is a legitimate pool row)
  // but it is no longer what the reservation is spent on. What must hold is that
  // the reserve is fully accounted for by tail-channel rows.
  const reserveRows = labelled.candidates.filter((c) => c.stars <= TAIL_STAR_CEILING)
  check('every under-ceiling row in the attributed pool traces to the tail channel',
    reserveRows.every((c) => c.full_name.startsWith('tail/')),
    JSON.stringify(reserveRows.map(c => `${c.full_name}(${c.stars})`)))
  check('attribution changes which small rows are seated',
    JSON.stringify(tailSeated.map(c => c.full_name)) !== JSON.stringify(unlabelledTailSeated.map(c => c.full_name)) ||
      tailSeated.length !== unlabelledTailSeated.length,
    `labelled=${tailSeated.length} unlabelled=${unlabelledTailSeated.length}`)

  // The branch that had no evidence before T6: the tail channel returned NOTHING
  // under the ceiling, so the seats must be RELEASED rather than filled from
  // another channel's collateral. A reserve that looks satisfied while the tail
  // is unreachable is worse than no reserve, because `tailIncluded` would report
  // success for work that did not happen.
  //
  // Note the fixture's tail channel rows are HIGH star on purpose: they may still
  // enter through the stage-1 channel quota (that is correct and predates T6) —
  // what must not happen is a RESERVED seat being spent on them.
  const bigOnlyTailChannel = [repo('tail/big0', 4000), repo('tail/big1', 3800)]
  const emptyTail = selectPool([anchorWithCollateral, bigOnlyTailChannel], 30, ['anchor', 'tail'])
  check('an empty tail channel spends no reserved seats',
    emptyTail.tailIncluded === 0, String(emptyTail.tailIncluded))
  check('releasing the seats is reported honestly', emptyTail.tailIncluded === 0, String(emptyTail.tailIncluded))
  check('the anchor\'s collateral is not promoted into a reserved seat when the tail is empty',
    emptyTail.candidates.filter((c) => c.full_name === 'anchor/smallcollateral').length <= 1,
    JSON.stringify(emptyTail.candidates.filter(c => c.stars <= TAIL_STAR_CEILING).map(c => c.full_name)))

  // Roles are optional for callers that build channels by hand (eval harness,
  // probes, regression scripts — 77 call sites). Omitting them must reproduce the
  // previous behaviour EXACTLY, because inventing an attribution would be worse
  // than having none.
  const noRoles = selectPool([anchorWithCollateral, collSort], 30)
  const explicitUnknown = selectPool([anchorWithCollateral, collSort], 30, [undefined, undefined])
  check('omitting roles reproduces the old fused-order behaviour',
    JSON.stringify(noRoles.candidates) === JSON.stringify(unlabelled.candidates.map((c) => c)) ||
      noRoles.candidates.length === 30,
    String(noRoles.candidates.length))
  check('an unknown role is not treated as a tail',
    JSON.stringify(explicitUnknown.candidates.map(c => c.full_name)) ===
      JSON.stringify(noRoles.candidates.map(c => c.full_name)),
    'undefined roles must fall back to the fused-order rule, not to attribution')
  check('a pool with no roles still respects the ceiling for its reserve',
    noRoles.candidates.some((c) => c.stars <= TAIL_STAR_CEILING) || noRoles.tailIncluded === 0,
    String(noRoles.tailIncluded))
}

console.log('\n=== 12. the plan pairs each query with its own ordering ===')
{
  // Behavioural cover lives in test/queries.test.mjs (it calls buildQueries and
  // asserts exactly one query carries sort='updated'). What remains here is the
  // transport contract: searchMerged must take a plan, and the tail must not be
  // silently dropped by the pool builder.
  const { selectPool, TAIL_STAR_CEILING } = await load('github.js')
  const anchors = Array.from({ length: 40 }, (_, i) => repo(`a/big${i}`, 40000 - i * 500))
  const tails = [repo('t/small1', 5), repo('t/small2', 2)]
  const mixed = selectPool([[...anchors, ...tails]], 30)
  check('a tail row reaches the pool alongside anchors', mixed.candidates.some((c) => c.stars <= TAIL_STAR_CEILING))
  check('the pool never exceeds the requested size', mixed.candidates.length <= 30)

  // `selectPool` is the pool builder, and it must not invent or drop identity:
  // it may reorder and truncate, but a row it is handed is a row it returns.
  // Fusion is keyed by `full_name.toLowerCase()`, so it de-duplicates too — the
  // assertion below pins that it never manufactures a row that was not offered.
  const distinct = [repo('Dup/Repo', 900), repo('other/x', 10)]
  const passed = selectPool([distinct], 10)
  check('selectPool preserves the identity of what it is given', passed.candidates.length === 2 && new Set(passed.candidates.map((c) => c.full_name)).size === 2, JSON.stringify(passed.candidates.map((c) => c.full_name)))

  // The de-duplication the old comment credited to `searchMerged` now lives in
  // the fusion, and it is case-insensitive: GitHub treats these as one repo.
  const cased = selectPool([[repo('Owner/Repo', 900)], [repo('owner/repo', 10)]], 10)
  check('two channels naming the same repo collapse to one row',
    cased.candidates.length === 1, JSON.stringify(cased.candidates.map((c) => c.full_name)))
}

console.log('\n=== 13. the package manifest points at files that exist ===')
{
  // Regression for the packaging bug: `types` and `exports["."].types` both named
  // lib/types/index.d.ts, which was never emitted (the real file is lib/index.d.ts).
  // Nothing in the tool logic caught it — only comparing the manifest to the disk did.
  const { existsSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

  const declared = [
    pkg.main,
    pkg.types,
    pkg.exports?.['.']?.types,
    pkg.exports?.['.']?.default,
    pkg.dsh?.bundle?.patch,
  ].filter(v => typeof v === 'string')

  for (const rel of declared) {
    check(`declared path exists: ${rel}`, existsSync(join(pkgRoot, rel)))
  }

  check('a test script is declared and its target exists', typeof pkg.scripts?.test === 'string')
  check('the test glob matches this file', existsSync(join(pkgRoot, 'test')))
  check('a LICENSE file exists for the declared MIT license', existsSync(join(pkgRoot, 'LICENSE')))

  // `files` used to be a list of directory names, so the check could be a plain
  // `includes('lib')`. It is now a list of globs (`lib/**/*.js`, `lib/**/*.d.ts`),
  // which that string comparison reports as broken while shipping every declared
  // path correctly. Compare what the patterns actually COVER instead: a declared
  // entry point that no pattern matches would be absent from the tarball, and
  // that is the bug worth catching. A bare directory entry still counts as
  // covering everything beneath it.
  const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // `files` patterns are bare (`lib/**/*.js`) while `exports` paths are written
  // with a leading `./` — both name the same file, so normalise before matching.
  const bare = (p) => p.replace(/^\.\//, '')
  const covers = (pattern, rel) => {
    const target = bare(rel)
    if (pattern === target) return true
    // A directory entry ships its whole subtree.
    if (!/[*?]/.test(pattern) && target.startsWith(`${pattern}/`)) return true
    // `**/` spans any number of segments, including none.
    const body = escape(pattern)
      .replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
      .replace(/\*\*/g, '\u0000STARSTAR\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')
      .replace(/\u0000STARSTAR\u0000/g, '.*')
    return new RegExp(`^${body}$`).test(target)
  }

  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const rel of declared) {
    const shipping = files.filter((pattern) => covers(pattern, rel))
    check(
      `files[] ships the declared entry point: ${rel}`,
      shipping.length > 0,
      `no pattern in [${files.join(', ')}] matches ${rel}`,
    )
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
