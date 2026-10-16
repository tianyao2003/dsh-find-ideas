// Evidence-integrity regressions: five counterexamples, one per inherited defect
// fixed in this pass. See `.trellis/tasks/10-15-find-ideas-v01/design.md` §3.6
// (the regression table) and §8.8 / AC11.
//
// Each group is the smallest input that separates the fixed behaviour from the
// old one, and each is written so that REMOVING the fix makes it fail: the
// counterexample and the observable it pins are named in the comment above the
// group. A group that would still pass against the defect is not a regression
// test, so every group also carries an anti-vacuity control — a case that must
// FAIL if the machinery under it never ran (a 429 that was really served, a
// score gap that really fires, a cap that really binds).
//
// Harness conventions follow `test/probe-guard.test.mjs` and `test/cache.test.mjs`:
// a scratch `DSH_HOME` so the real cache is never touched, `globalThis.fetch`
// stubbed with the `x-ratelimit-*` headers a real GitHub response carries, and
// both `cacheClearMemory()` AND a disk wipe between cases — `cacheClearMemory`
// clears only the in-process map, so without the wipe a "cold" case would be
// served by the entry the previous case wrote.
//
// Run: node test/evidence-integrity.test.mjs   (NOT `node --test`)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-evidence-integrity-'))
const originalHome = process.env.DSH_HOME
// Set before the imports below: the cache resolves `DSH_HOME` per operation, but
// redirecting it first keeps the ordering identical to the sibling tests.
process.env.DSH_HOME = scratch
const cacheDir = join(scratch, 'cache', 'dsh-find-ideas')

const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { selectPool } = await load('github.js')
const { rankCandidates, findScoreGaps } = await load('types.js')
const { pickArchitectureFiles } = await load('select.js')
const { apply } = await load('index.js')
const { cacheClearMemory } = await load('cache.js')

let pass = 0
let fail = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== '') console.log(`        ${detail}`)
  }
}

// A true cold start: the in-memory map AND the file the last case wrote.
const coldCache = () => {
  cacheClearMemory()
  rmSync(cacheDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Fixtures for the network-backed groups.
// ---------------------------------------------------------------------------

const README_TEXT = '# Demo\n\nA demo project used by the evidence-integrity test.\n'
// Longer than `INSPECT_BUDGET.shallow.readmeChars` (4000), so the read budget
// really truncates and the level-3 coverage tag really applies.
const LONG_README = `# Long\n\n${'x'.repeat(5000)}\n`

const TREES = {
  'one/alpha': [
    { path: 'README.md', type: 'blob' },
    { path: 'package.json', type: 'blob' },
    { path: 'src/main.ts', type: 'blob' },
    { path: 'src/lib.ts', type: 'blob' },
  ],
  'two/beta': [
    { path: 'README.md', type: 'blob' },
    { path: 'Cargo.toml', type: 'blob' },
    { path: 'src/main.rs', type: 'blob' },
    { path: 'src/lib.rs', type: 'blob' },
  ],
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
// Every real GitHub response carries these; a fixture without them silently
// starves the quota guard and makes the assertions downstream vacuous.
const rateHeaders = (remaining) => ({
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
})

/**
 * Install the fetch stub. `state` is mutable on purpose: the quota and the
 * rate-limited set change mid-group, and `calls` is reset between sub-cases.
 */
const installFetch = (options = {}) => {
  const state = {
    quotaRemaining: options.quotaRemaining ?? 4999,
    limited: new Set(options.limited ?? []),
    readme: options.readme ?? README_TEXT,
    calls: [],
    limited429: 0,
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    state.calls.push(path)
    if (path === '/rate_limit') {
      return json({
        resources: {
          core: {
            limit: 5000,
            remaining: state.quotaRemaining,
            reset: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      })
    }
    const matched = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path)
    if (matched === null) return json({ message: 'unexpected path' }, 404)
    const fullName = `${decodeURIComponent(matched[1])}/${decodeURIComponent(matched[2])}`
    const rest = matched[3]
    if (state.limited.has(fullName)) {
      state.limited429 += 1
      // `retry-after: 0` keeps the transport's one retry on the wire without
      // spending 1.5s of wall clock on it.
      return json({ message: 'API rate limit exceeded' }, 429, { ...rateHeaders(0), 'retry-after': '0' })
    }
    if (rest === 'readme') {
      return json({ content: b64(state.readme), encoding: 'base64', size: Buffer.byteLength(state.readme) }, 200, rateHeaders(4999))
    }
    if (rest.startsWith('git/trees/')) {
      return json({ tree: TREES[fullName] ?? [], truncated: false }, 200, rateHeaders(4999))
    }
    if (rest.startsWith('contents/')) {
      const rel = decodeURIComponent(rest.slice('contents/'.length))
      return json({ content: b64(`// ${rel}\n`), encoding: 'base64', size: 8 }, 200, rateHeaders(4999))
    }
    return json({ message: 'unexpected path' }, 404)
  }
  return {
    state,
    restore: () => { globalThis.fetch = realFetch },
    count: (predicate) => state.calls.filter(predicate).length,
    reset: () => { state.calls.length = 0 },
  }
}

const isReadmeEndpoint = (path) => path.endsWith('/readme')
const isReadmeContents = (path) => /\/contents\/readme\.(md|markdown|rst|txt)$/i.test(path)
const isTreeEndpoint = (path) => path.includes('/git/trees/')

// The tool harness: a fake context whose only job is to register the tools and
// hand back a token, so the inspect path takes its authenticated branch.
const registerTools = () => {
  const defs = new Map()
  apply({
    tools: { register: (def) => defs.set(def.name, def) },
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'ghp_evidence_integrity' }) } : undefined),
  })
  return defs
}

try {
  const defs = registerTools()
  const inspect = defs.get('inspect_projects')
  const rankTool = defs.get('rank_candidates')

  // =========================================================================
  console.log('\n=== G1. RRF decides the remainder seats, not insertion order ===')
  {
    // Defect 1. The counterexample from §3.6: `shared/x` sits at index 3 of BOTH
    // channels, so its fused RRF score is 1/63 + 1/63 and it is the only row in
    // two channels; `a/a2` and `b/b3` are each in one channel at a worse rank.
    // The two channels' quota seats (CHANNEL_QUOTA = 2) take four of the five
    // seats, so the fifth is decided by RRF — and the old code filled it from
    // `[...quota, ...fused.keys()]` in insertion order, which put `a/a2` (index
    // 2 of channel 0) ahead of `shared/x` and dropped the one row that two
    // independent queries agreed on.
    const row = (full_name, stars = 200) => ({
      full_name,
      url: `https://github.com/${full_name}`,
      owner: full_name.split('/')[0],
      name: full_name.split('/')[1],
      description: 'a fast static site generator for markdown notes',
      stars,
      language: 'TypeScript',
      pushed_at: '2024-01-01T00:00:00.000Z',
      archived: false,
      topics: [],
    })
    const channels = [
      [row('a/a0'), row('a/a1'), row('a/a2'), row('shared/x')],
      [row('b/b0'), row('b/b1'), row('shared/x'), row('b/b3')],
    ]

    const wide = selectPool(channels, 5)
    const wideNames = wide.candidates.map((candidate) => candidate.full_name)
    const narrow = selectPool(channels, 4)
    const narrowNames = narrow.candidates.map((candidate) => candidate.full_name)

    // Anti-vacuity: the pool was really built and the cap really binds. If the
    // implementation ignored `limit` and returned everything, `narrow` would
    // contain `shared/x` and the next check would fail rather than pass by luck.
    check('the fused pool fills the requested five seats',
      wide.candidates.length === 5, JSON.stringify(wideNames))
    check('both channels keep their quota seats',
      ['a/a0', 'a/a1', 'b/b0', 'b/b1'].every((name) => wideNames.includes(name)),
      JSON.stringify(wideNames))
    check('the cap really binds at four seats',
      narrow.candidates.length === 4 && !narrowNames.includes('shared/x'),
      JSON.stringify(narrowNames))
    // At 200 stars every row is above TAIL_STAR_CEILING, so the tail stage is
    // inert and membership here is purely the quota-plus-RRF decision.
    check('the tail reserve is inert at this star count',
      wide.tailIncluded === 0 && wide.lowStarInPool === 0,
      `tailIncluded=${wide.tailIncluded} lowStarInPool=${wide.lowStarInPool}`)
    check('the row both channels agree on wins the fifth seat',
      wideNames.includes('shared/x'), JSON.stringify(wideNames))
    check('the single-channel runner-up loses that seat',
      !wideNames.includes('a/a2') && !wideNames.includes('b/b3'), JSON.stringify(wideNames))
  }

  // =========================================================================
  console.log('\n=== G2. one repository is one candidate, in the rank and in the diagnostics ===')
  {
    // Defect 2. The same repository supplied twice under two spellings used to
    // produce two card rows, while every diagnostic — keyed by lowercase
    // `full_name` — saw one. The mirror image is the false conflict: two rows
    // that finally score the same were reported as a suspicious score gap.
    const candidate = (full_name, description = 'a fast static site generator for markdown notes') => ({
      full_name,
      url: `https://github.com/${full_name}`,
      owner: full_name.split('/')[0],
      name: full_name.split('/')[1],
      description,
      stars: 200,
      language: 'TypeScript',
      pushed_at: '2024-01-01T00:00:00.000Z',
      archived: false,
      topics: [],
    })
    const scoreGaps = (suspicious) => (suspicious ?? []).filter((entry) => entry.kind === 'score_gap')

    check('the rank_candidates tool is registered', rankTool !== undefined, [...defs.keys()].join(', '))
    if (rankTool !== undefined) {
      const duplicated = await rankTool.execute({
        idea: 'candidate identity',
        candidates: [candidate('Dup/Repo'), candidate('dup/repo')],
        scores: [{ full_name: 'Dup/Repo', relevance: 9 }, { full_name: 'dup/repo', relevance: 4 }],
      }, {})
      check('the same repository under two spellings yields one row',
        duplicated.total === 1 && duplicated.ranked.length === 1,
        JSON.stringify(duplicated.ranked.map((entry) => entry.full_name)))
      check('the surviving row keeps the identity the caller supplied first',
        duplicated.ranked[0]?.full_name.toLowerCase() === 'dup/repo',
        JSON.stringify(duplicated.ranked.map((entry) => entry.full_name)))
      check('both judgements were matched to that one candidate',
        duplicated.unknown.length === 0, JSON.stringify(duplicated.unknown))
      check('a repository cannot be reported as conflicting with itself',
        scoreGaps(duplicated.suspicious).length === 0, JSON.stringify(duplicated.suspicious))

      const tied = await rankTool.execute({
        idea: 'candidate identity',
        candidates: [candidate('one/alpha'), candidate('two/beta')],
        scores: [{ full_name: 'one/alpha', relevance: 9 }, { full_name: 'two/beta', relevance: 9 }],
      }, {})
      check('two distinct repositories both scoring nine are both ranked',
        tied.total === 2 && tied.ranked.every((entry) => entry.relevance === 9),
        JSON.stringify(tied.ranked.map((entry) => `${entry.full_name}:${entry.relevance}`)))
      check('two distinct repositories both scoring nine are not a diagnostic conflict',
        scoreGaps(tied.suspicious).length === 0, JSON.stringify(tied.suspicious))

      // Anti-vacuity control: the score-gap diagnostic must still fire on a real
      // gap (9 vs 4 is exactly the SCORE_GAP_RELEVANCE = 5 threshold), otherwise
      // the two checks above would pass merely because nothing ever fires.
      const gapped = await rankTool.execute({
        idea: 'candidate identity',
        candidates: [candidate('one/alpha'), candidate('two/beta')],
        scores: [{ full_name: 'one/alpha', relevance: 9 }, { full_name: 'two/beta', relevance: 4 }],
      }, {})
      const fired = scoreGaps(gapped.suspicious)
      check('a real five-point gap between distinct repositories is still reported',
        fired.length === 1 && fired[0].full_name === 'two/beta' && fired[0].against === 'one/alpha',
        JSON.stringify(gapped.suspicious))

      // The same claim at the function the tool delegates to, so the group does
      // not depend on the tool wrapper alone.
      const direct = findScoreGaps(
        [candidate('Dup/Repo'), candidate('dup/repo')],
        [{ full_name: 'Dup/Repo', relevance: 9 }, { full_name: 'dup/repo', relevance: 4 }],
      )
      check('the shared view reports no gap for a duplicated repository',
        direct.length === 0, JSON.stringify(direct))
      const directTied = rankCandidates(
        [candidate('one/alpha'), candidate('two/beta')],
        [{ full_name: 'one/alpha', relevance: 9 }, { full_name: 'two/beta', relevance: 9 }],
      )
      check('the shared view keeps two distinct repositories as two rows',
        directTied.ranked.length === 2 && new Set(directTied.ranked.map((entry) => entry.full_name.toLowerCase())).size === 2,
        JSON.stringify(directTied.ranked.map((entry) => entry.full_name)))

      // The duplicate must not be counted twice as a *counterpart* either. With a
      // third, genuinely distant repository in the pool, a second view of the same
      // candidate reports one conflict as two — naming the same repository under
      // both spellings. The duplicate-only fixture above cannot see this: with a
      // single candidate left after dedupe there are no pairs to walk, so the
      // check passes whether or not a second view exists.
      const duplicatePool = [candidate('Dup/Repo'), candidate('dup/repo'), candidate('two/beta')]
      const duplicateScores = [
        { full_name: 'Dup/Repo', relevance: 9 },
        { full_name: 'dup/repo', relevance: 9 },
        { full_name: 'two/beta', relevance: 3 },
      ]
      const amplified = findScoreGaps(duplicatePool, duplicateScores)
      check('a duplicated repository is named once as a conflicting counterpart',
        amplified.length === 1 && amplified[0].against.toLowerCase() === 'dup/repo',
        JSON.stringify(amplified.map((entry) => `${entry.full_name}:${entry.relevance}:vs:${entry.against}`)))
      const amplifiedTool = await rankTool.execute({
        idea: 'candidate identity',
        candidates: duplicatePool,
        scores: duplicateScores,
      }, {})
      check('the tool reports that conflict once, not once per spelling',
        scoreGaps(amplifiedTool.suspicious).length === 1,
        JSON.stringify(scoreGaps(amplifiedTool.suspicious).map((entry) => `${entry.full_name}:vs:${entry.against}`)))
    }
  }

  // =========================================================================
  console.log('\n=== G3. a cache hit cannot wash a partial batch into a clean success ===')
  {
    // Defect 3. A batch where the second repository was rate-limited was cached
    // as a plain array of rows, and the replay returned `degraded: null` — the
    // caller could not tell a complete answer from one repository's worth of it.
    // The second half is the ordering: the old code refused on an exhausted
    // quota BEFORE looking in the cache, so a perfectly good cached answer
    // became unreachable exactly when the network was unavailable.
    check('the inspect_projects tool is registered', inspect !== undefined, [...defs.keys()].join(', '))
    if (inspect !== undefined) {
      // -- 3a: the partial batch survives the replay -------------------------
      coldCache()
      const net = installFetch({ limited: ['two/beta'] })
      try {
        net.reset()
        const first = await inspect.execute({ idea: 'cache honesty', repos: ['one/alpha', 'two/beta'], depth: 'shallow' }, {})
        check('the cold call really read the first repository',
          first.cached === false && first.inspections.some((item) => item.full_name === 'one/alpha' && item.ok),
          JSON.stringify(first.inspections.map((item) => `${item.full_name}:${item.ok}`)))
        check('the cold call really put requests on the wire',
          net.state.calls.length > 0 && net.count(isTreeEndpoint) === 1,
          JSON.stringify(net.state.calls))
        check('the second repository was really rate-limited by the fixture',
          net.state.limited429 > 0, `429s=${net.state.limited429}`)
        check('the cold call reports the partial batch',
          first.degraded !== null && first.degraded.reason === 'partial' && /two\/beta/.test(first.degraded.detail),
          JSON.stringify(first.degraded))

        const beforeReplay = net.state.calls.length
        const replay = await inspect.execute({ idea: 'cache honesty', repos: ['one/alpha', 'two/beta'], depth: 'shallow' }, {})
        check('the replay is served from the cache and not the network',
          replay.cached === true && net.state.calls.length === beforeReplay,
          `cached=${replay.cached} extra=${net.state.calls.length - beforeReplay}`)
        check('the replay does NOT report a clean success',
          replay.degraded !== null, JSON.stringify(replay.degraded))
        check('the replay keeps reporting the partial batch',
          replay.degraded?.reason === 'partial', JSON.stringify(replay.degraded))
        check('the replay names the repository the cache has no result for',
          /two\/beta/.test(replay.degraded?.detail ?? ''), JSON.stringify(replay.degraded))
        check('the replay returns the rows the cache actually holds',
          replay.inspections.length === 1 && replay.inspections[0].full_name === 'one/alpha',
          JSON.stringify(replay.inspections.map((item) => item.full_name)))
      } finally {
        net.restore()
      }

      // -- 3b: a usable cache is consulted before the quota refusal ----------
      coldCache()
      const quota = installFetch({})
      try {
        quota.reset()
        const warm = await inspect.execute({ idea: 'quota ordering', repos: ['one/alpha'], depth: 'shallow' }, {})
        check('the warm call populated the cache from the network',
          warm.cached === false && warm.inspections.length === 1 && quota.state.calls.length > 0,
          `cached=${warm.cached} calls=${quota.state.calls.length}`)

        quota.state.quotaRemaining = 0
        const beforeCached = quota.state.calls.length
        const underZeroQuota = await inspect.execute({ idea: 'quota ordering', repos: ['one/alpha'], depth: 'shallow' }, {})
        check('an exhausted quota still serves a valid cache entry',
          underZeroQuota.cached === true && underZeroQuota.inspections.length === 1,
          JSON.stringify({ cached: underZeroQuota.cached, degraded: underZeroQuota.degraded }))
        check('the cached answer costs no request at all',
          quota.state.calls.length === beforeCached,
          `extra=${quota.state.calls.length - beforeCached}`)

        // Anti-vacuity control: under the SAME exhausted quota an uncached
        // request set is still refused, so the check above proves the ordering
        // and not a refusal path that stopped working.
        const refused = await inspect.execute({ idea: 'quota ordering', repos: ['one/alpha', 'two/beta'], depth: 'shallow' }, {})
        check('the same exhausted quota still refuses an uncached request',
          refused.cached === false && refused.degraded?.reason === 'quota_exceeded',
          JSON.stringify({ cached: refused.cached, degraded: refused.degraded }))
      } finally {
        quota.restore()
      }
    }
  }

  // =========================================================================
  console.log('\n=== G4. the README is read once per repository per inspect ===')
  {
    // Defect 4. The root README occupies slot 1, and the per-slot read loop used
    // to fetch it again through the contents endpoint: one extra request per
    // repository, and the second truncation was untagged. The honest count is
    // one `/readme` request per repository per inspect and ZERO contents
    // requests for it — the already-read text is reused for slot 1.
    coldCache()
    const net = installFetch({})
    try {
      net.reset()
      const one = await inspect.execute({ idea: 'readme reuse', repos: ['one/alpha'], depth: 'shallow' }, {})
      check('the inspect really ran against the stub',
        one.cached === false && net.count(isTreeEndpoint) === 1,
        JSON.stringify(net.state.calls))
      check('a shallow inspect of one repository reads the README exactly once',
        net.count(isReadmeEndpoint) === 1, JSON.stringify(net.state.calls))
      check('the README slot costs no second contents request',
        net.count(isReadmeContents) === 0, JSON.stringify(net.state.calls))
      check('the README really occupies a slot',
        one.inspections[0]?.files_read.includes('README.md') === true,
        JSON.stringify(one.inspections[0]?.files_read))
      check('the reported request count equals the requests actually made',
        one.requests_used === net.state.calls.length,
        `reported=${one.requests_used} wire=${net.state.calls.length}`)

      // The count scales with the number of repositories, not with the number of
      // slots: two repositories read the README twice, never four times.
      coldCache()
      net.reset()
      const two = await inspect.execute({ idea: 'readme reuse', repos: ['one/alpha', 'two/beta'], depth: 'shallow' }, {})
      check('two repositories read the README exactly twice',
        net.count(isReadmeEndpoint) === 2, JSON.stringify(net.state.calls))
      check('neither repository falls back to the contents endpoint for it',
        net.count(isReadmeContents) === 0, JSON.stringify(net.state.calls))
      check('both repositories report their own README',
        two.inspections.length === 2 && two.inspections.every((item) => item.files_read.includes('README.md')),
        JSON.stringify(two.inspections.map((item) => item.files_read)))
      check('the reported request count stays honest across two repositories',
        two.requests_used === net.state.calls.length,
        `reported=${two.requests_used} wire=${net.state.calls.length}`)

      // A README larger than the read budget is still read once: truncation must
      // not be answered with a second request, and both truncation levels must be
      // tagged so the reader can tell a clipped file from a whole one.
      coldCache()
      net.reset()
      net.state.readme = LONG_README
      const long = await inspect.execute({ idea: 'readme reuse', repos: ['one/alpha'], depth: 'shallow' }, {})
      check('an over-budget README is still read exactly once',
        net.count(isReadmeEndpoint) === 1 && net.count(isReadmeContents) === 0,
        JSON.stringify(net.state.calls))
      check('an over-budget README still occupies its slot',
        long.inspections[0]?.files_read.includes('README.md') === true,
        JSON.stringify(long.inspections[0]?.files_read))
      check('the read-budget truncation is tagged in the summary',
        /文件长于 4000 字符的读取预算，已截断/.test(long.inspections[0]?.tree_summary ?? ''),
        (long.inspections[0]?.tree_summary ?? '').slice(0, 200))
      check('the excerpt-window truncation is tagged in the summary',
        /本摘录只含开头 1200 字符，其后内容未展示/.test(long.inspections[0]?.tree_summary ?? ''),
        (long.inspections[0]?.tree_summary ?? '').slice(0, 200))
    } finally {
      net.restore()
    }
  }

  // =========================================================================
  console.log('\n=== G5. the selector generalises past the Tauri sample ===')
  {
    // Defect 5. The selector was tuned on a Tauri repository: platform-shell and
    // tooling directories were DELETED rather than charged, so an Android tree
    // and a Python CLI tree kept a README and a manifest and answered "what is
    // this built on?" with no source at all. The measured trees from §4.5 are
    // reused verbatim; the cap is `shallow.maxFiles` (4), the production value.
    const tree = (paths) => paths.map((path) => ({ path, type: 'blob' }))
    const isSource = (path) => /\.(ts|tsx|js|jsx|mjs|cjs|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|ex|exs|erl|hs|ml|scala|clj|cljs|cljc|edn|vue|svelte|dart|lua|sh|ps1|sql)$/i.test(path)

    const ANDROID_TREE = ['README.md', 'build.gradle.kts', 'android/app/src/main/java/App.java', 'android/app/src/main/java/Service.java']
    const PYTHON_CLI_TREE = ['README.md', 'package.json', 'scripts/main.py', 'scripts/tool.py']
    const TAURI_TREE = ['README.md', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/src/main.rs', 'src-tauri/src/lib.rs', 'src/main.ts', 'src/App.vue', 'src/components/Editor.vue']

    const android = pickArchitectureFiles(tree(ANDROID_TREE), 4)
    check('the Android tree keeps a Java source slot',
      android.some((path) => path.endsWith('.java')), JSON.stringify(android))
    check('the Android tree still keeps its README',
      android.includes('README.md'), JSON.stringify(android))
    check('the Android pick respects the cap',
      android.length === 4, JSON.stringify(android))

    const pycli = pickArchitectureFiles(tree(PYTHON_CLI_TREE), 4)
    check('the Python CLI tree keeps a Python source slot',
      pycli.some((path) => path.endsWith('.py')), JSON.stringify(pycli))
    check('the Python CLI pick respects the cap',
      pycli.length === 4, JSON.stringify(pycli))

    const tauri = pickArchitectureFiles(tree(TAURI_TREE), 4)
    check('the in-sample Tauri tree still keeps a source slot',
      tauri.some(isSource), JSON.stringify(tauri))

    // The zero-source fallback on its own. Slots 1 and 4 are prose BY
    // CONSTRUCTION and slot 3 needs an entry-point NAME, which `Engine.java` is
    // not, so without the fallback this tree spends all four slots on README,
    // manifest and two docs — the exact failure the group above measures. The
    // fallback must SPEND a taken slot, never append a fifth file.
    const FALLBACK_TREE = ['README.md', 'package.json', 'docs/architecture.md', 'docs/overview.md', 'scripts/deep/Engine.java']
    const fallback = pickArchitectureFiles(tree(FALLBACK_TREE), 4)
    check('the zero-source fallback spends a prose slot on code',
      fallback.some(isSource), JSON.stringify(fallback))
    check('the fallback never evicts the root README',
      fallback.includes('README.md'), JSON.stringify(fallback))
    check('the fallback evicts rather than appending a fifth file',
      fallback.length === 4, JSON.stringify(fallback))
    // And it does not invent code: a repository that really is prose keeps its
    // honest pick.
    check('a prose-only repository still invents no source path',
      !pickArchitectureFiles(tree(['README.md', 'package.json']), 4).some(isSource),
      JSON.stringify(pickArchitectureFiles(tree(['README.md', 'package.json']), 4)))
  }
} finally {
  cacheClearMemory()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
