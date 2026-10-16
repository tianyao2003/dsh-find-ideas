// Behavioural test for what a REPLAYED search result says about itself.
//
// THE FIRST DEFECT THIS PINS DOWN
// -------------------------------
// `degraded` was never stored in the candidate cache. A cache hit returned
// `degraded: null` unconditionally, so the SECOND call for the same idea came
// back looking clean even when the first call had failed two of its three
// queries. The card said "2/3 个查询失败，只包含高 star 项目" once and then
// stopped saying it, while the rows were unchanged — still missing whatever the
// failed queries would have found.
//
// That is exactly what the P1 tail warning exists to prevent, undone on the
// second call. The fix separates two kinds of fact:
//   - the failure TEXT describes one fetch at one moment, so it is NOT replayed;
//   - INCOMPLETENESS is a property of the stored rows, so it IS stored and the
//     wording is regenerated for the replay.
//
// THE SECOND DEFECT, SAME SHAPE, ONE LAYER OUT (groups R4/R5)
// ----------------------------------------------------------
// The fix above stored `incomplete` but not WHICH shortfall the fetch had, so a
// short-but-complete result still replayed as clean. Worse, the note it dropped
// was the actionable one: a vocabulary-gap (`lexicon_miss`) note tells the caller
// to supply English `keywords`, and it disappeared on the retry — the moment the
// caller is deciding what to change.
//
// The split is the same one, applied to thinness:
//   - the NUMBERS behind a short result ("2 个，配额只剩 1 次") are not replayed;
//   - the KIND of shortfall (`quota` / `narrow`) is a property of the stored rows
//     and is, except for `quota`'s `remaining`, not re-derivable at all;
//   - the vocabulary gap needs no stored field, because `unknownTerms` is derived
//     from the idea before the cache is consulted.
//
// Run with:  npm test
// Or directly: node test/replay.test.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Redirect the cache before importing anything that touches it. `cache.ts`
// resolves $DSH_HOME lazily, but doing this first is the only way to be sure the
// test is not reading the developer's real cache.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-replay-'))
process.env.DSH_HOME = scratch

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { cacheClearMemory } = await load('cache.js')
const { describeReplayedIncompleteness, describeReplayedThinness, explainThinResult, thinResultKind } = await load('query.js')
const mod = await load('index.js')

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

function activate() {
  const defs = new Map()
  mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  return defs.get('scout_projects')
}

// ---------------------------------------------------------------------------
console.log('\n=== R1. the replay note makes a weaker claim than the live note ===')
{
  // The live note names the query count and lists each failure. The replay note
  // must NOT, because it did not attempt anything — asserting "2/3 failed" on a
  // replay is a fabricated fact about the present call.
  const live = describeReplayedIncompleteness()

  check('the replay note says the rows are incomplete',
    live.includes('不完整'), live.slice(0, 60))
  check('the replay note does not claim a query count',
    !/\d+\s*\/\s*\d+/.test(live), live)
  check('the replay note does not claim a query failed just now',
    !/个查询失败/.test(live), live)
  check('the replay note still warns that low-star rows may be missing',
    live.includes('低 star'), live)
  check('the replay note says the incompleteness is not evidence of absence',
    live.includes('不代表不存在相关项目'), live)
  check('the replay note attributes the state to the cache, not to this call',
    live.includes('缓存'), live)
}

console.log('\n=== R2. a cache hit reports incompleteness instead of claiming to be clean ===')
{
  // Force `searchMerged` to fail one of the three queries, so the first call is
  // incomplete and gets cached, then call again and inspect the REPLAY.
  const { apply: _unused } = mod
  const scout = activate()

  const realFetch = globalThis.fetch
  let searchCalls = 0
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/search/repositories')) {
      searchCalls++
      // Fail only the long-tail query (sort=updated), leaving a pool of high-star
      // rows with no tail — the exact shape P1-7 made visible.
      if (href.includes('sort=updated')) {
        return new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: {
            'x-ratelimit-limit': '10',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        })
      }
      return new Response(JSON.stringify({
        total_count: 2,
        items: [
          { full_name: 'big/one', html_url: 'https://github.com/big/one', owner: { login: 'big' }, name: 'one', description: 'a markdown note app', stargazers_count: 50000, language: 'TypeScript', pushed_at: '2026-01-01T00:00:00Z', topics: ['markdown'], archived: false, fork: false },
          { full_name: 'big/two', html_url: 'https://github.com/big/two', owner: { login: 'big' }, name: 'two', description: 'another markdown note app', stargazers_count: 40000, language: 'Rust', pushed_at: '2026-01-01T00:00:00Z', topics: ['notes'], archived: false, fork: false },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }

  try {
    cacheClearMemory()
    const first = await scout.execute({ idea: 'markdown notes bidirectional links unique-run-one' }, {})
    const coldSearchCalls = searchCalls

    check('the first (cold) call reports the failure with its detail',
      first.degraded !== null && first.degraded.reason === 'partial', JSON.stringify(first.degraded))
    check('the cold note names the failed query count',
      first.degraded !== null && /\d+\s*\/\s*\d+/.test(first.degraded.detail), first.degraded?.detail?.slice(0, 60))
    check('the cold call cached its rows', first.candidates.length > 0, String(first.candidates.length))

    const second = await scout.execute({ idea: 'markdown notes bidirectional links unique-run-one' }, {})

    check('the second call is served from cache', second.cached === true, String(second.cached))
    check('the second call still advertises that the rows are incomplete',
      second.degraded !== null && second.degraded.reason === 'partial', JSON.stringify(second.degraded))
    check('the replayed note does not fabricate a query count',
      second.degraded !== null && !/\d+\s*\/\s*\d+/.test(second.degraded.detail), second.degraded?.detail?.slice(0, 60))
    check('the replayed rows are identical to the cold rows',
      JSON.stringify(second.candidates) === JSON.stringify(first.candidates))

    // The replay must issue NO new search. Asserting an exact total would be
    // wrong: `github.ts:297` retries a 403 once, so the failing tail query costs
    // two requests, and the cold call is 4 rather than 3. Measure the delta
    // across the replay instead — that is the property being tested, and it does
    // not depend on how many attempts a failed query happens to take.
    check('the replay issued no new search request', searchCalls === coldSearchCalls, `${coldSearchCalls} -> ${searchCalls}`)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n=== R3. a complete cached result is NOT labelled incomplete ===')
{
  const scout = activate()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/search/repositories')) {
      return new Response(JSON.stringify({
        total_count: 1,
        items: [
          { full_name: 'ok/only', html_url: 'https://github.com/ok/only', owner: { login: 'ok' }, name: 'only', description: 'markdown notes with bidirectional links', stargazers_count: 1234, language: 'Go', pushed_at: '2026-01-01T00:00:00Z', topics: ['notes'], archived: false, fork: false },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }

  try {
    cacheClearMemory()
    const cold = await scout.execute({ idea: 'a clean complete run marker-zzz' }, {})
    const warm = await scout.execute({ idea: 'a clean complete run marker-zzz' }, {})

    // `thin_result` is not incompleteness — it says the queries were narrow. It
    // is stored alongside the rows rather than recomputed, because the `quota`
    // half of the rule reads `remaining`, which exists only at fetch time (see
    // R4). The point of this group is the `incomplete` flag, so assert that
    // specifically rather than asserting `degraded === null`.
    check('the clean cold call is not marked partial',
      cold.degraded === null || cold.degraded.reason !== 'partial', JSON.stringify(cold.degraded?.reason))
    check('the clean replay is served from cache', warm.cached === true, String(warm.cached))
    check('a complete cached result is NOT labelled incomplete',
      warm.degraded === null || warm.degraded.reason !== 'partial', JSON.stringify(warm.degraded?.reason))
    check('the replay does not carry the replay-incompleteness wording',
      warm.degraded === null || !warm.degraded.detail.includes('来自缓存，且当初的抓取并未取全'),
      warm.degraded?.detail?.slice(0, 60))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n=== R4. a SHORT result stays short-looking on the replay ===')
{
  // THE DEFECT THIS PINS DOWN
  // -------------------------
  // `CachedSearch` stored `incomplete` but not which kind of shortfall the fetch
  // had, so the replay path could only ever say "partial" or nothing. Measured on
  // `一个给独立开发者用的客户反馈收集工具`: the first call reported `thin_result`
  // plus a `lexicon_miss` note, and the second call — served from cache — reported
  // `degraded: null` while returning the same 2 rows. A 2-candidate pool was
  // presented as a clean result on the retry, which is exactly when the caller is
  // deciding whether to change the query.
  //
  // Two halves are checked here: the shortfall KIND survives, and the
  // vocabulary-gap note survives — the latter without any stored field at all,
  // since `unknownTerms` is derived from the idea before the cache is consulted.
  const scout = activate()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/search/repositories')) {
      return new Response(JSON.stringify({
        total_count: 1,
        items: [
          { full_name: 'thin/only', html_url: 'https://github.com/thin/only', owner: { login: 'thin' }, name: 'only', description: 'unrelated project', stargazers_count: 8, language: 'Go', pushed_at: '2026-01-01T00:00:00Z', topics: [], archived: false, fork: false },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url, init)
  }

  try {
    cacheClearMemory()
    // Pure-Chinese and outside the lexicon. `keywords` is supplied because step 2
    // refuses a Chinese idea without Latin terms before any plan is built, and this
    // group is about the REPLAY, not about the refusal — the refusal has its own
    // coverage in plan-failure.test.mjs. The idea text is the one the defect was
    // measured on.
    const idea = '一个给独立开发者用的客户反馈收集工具'
    const keywords = 'customer feedback collection tool for indie developers'
    const cold = await scout.execute({ idea, keywords }, {})
    const warm = await scout.execute({ idea, keywords }, {})

    check('the cold call is short and says so',
      cold.degraded !== null && cold.degraded.reason === 'thin_result', JSON.stringify(cold.degraded?.reason))
    check('the cold call cached a short pool', cold.candidates.length > 0, String(cold.candidates.length))
    // Step 2 requires `keywords` here, and supplying them gives the plan an
    // English channel — so the missing-channel note must NOT appear. The old
    // assertion used this case as its example of that note, which is no longer
    // reachable from a call that has keywords. What still must hold is the
    // property that assertion was protecting: the note is keyed on the PLAN, so a
    // plan WITH an English channel never carries it, on the cold call or the
    // replay. (The note's positive case is covered in plan-failure.test.mjs.)
    check('a plan with an English channel carries no missing-channel note',
      cold.degraded === null || !cold.degraded.detail.includes('没有任何英文检索通道'),
      cold.degraded?.detail?.slice(0, 60))

    check('the replay is served from cache', warm.cached === true, String(warm.cached))
    check('the replayed rows are identical to the cold rows',
      JSON.stringify(warm.candidates) === JSON.stringify(cold.candidates))
    // The regression: this was `degraded: null`.
    check('a short cached result is STILL reported as short',
      warm.degraded !== null && warm.degraded.reason === 'thin_result', JSON.stringify(warm.degraded?.reason))
    check('the replayed thin note is the replay wording, not the live one',
      warm.degraded !== null && warm.degraded.detail.includes('来自缓存'), warm.degraded?.detail?.slice(0, 60))
    check('the replayed plan keeps its English channel, so no missing-channel note',
      warm.degraded === null || !warm.degraded.detail.includes('没有任何英文检索通道'),
      warm.degraded?.detail?.slice(0, 60))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n=== R5. the replay thin note makes a weaker claim than the live one ===')
{
  // Same shape as R1: the live note names numbers, the replay note must not,
  // because those numbers belonged to a fetch that is not happening now.
  const liveQuota = explainThinResult(2, 20, 1, false)
  const replayQuota = describeReplayedThinness('quota')
  const replayNarrow = describeReplayedThinness('narrow')

  check('the live quota note names the remaining count',
    liveQuota !== null && liveQuota.includes('只剩 1 次'), liveQuota?.slice(0, 60))
  check('the replay quota note does not name a remaining count',
    !/只剩\s*\d+\s*次/.test(replayQuota), replayQuota)
  check('the replay quota note attributes the state to the cache',
    replayQuota.includes('缓存'), replayQuota)
  check('the replay narrow note attributes the state to the cache',
    replayNarrow.includes('缓存'), replayNarrow)
  check('the replay narrow note still explains the AND rule',
    replayNarrow.includes('AND'), replayNarrow)

  // The rule itself must have ONE definition, so the two readers cannot drift:
  // the kind stored by the cold path and the wording shown by it come from the
  // same call.
  check('the quota case classifies as quota, not narrow',
    thinResultKind(2, 20, 1, false) === 'quota', String(thinResultKind(2, 20, 1, false)))
  check('a short but complete fetch classifies as narrow',
    thinResultKind(2, 20, 50, false) === 'narrow', String(thinResultKind(2, 20, 50, false)))
  check('a full fetch classifies as neither',
    thinResultKind(20, 20, 50, true) === null, String(thinResultKind(20, 20, 50, true)))
  check('the live wording is null exactly when the kind is null',
    (explainThinResult(20, 20, 50, true) === null) === (thinResultKind(20, 20, 50, true) === null))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
rmSync(scratch, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
