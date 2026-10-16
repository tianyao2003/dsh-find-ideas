/**
 * §7 — the diagnostic probe guard must read the SEARCH rate-limit bucket.
 *
 * `probeTermTotals` spends one `/search/repositories` request per term, so it
 * draws on the **search** bucket (10 req/min anonymous, 30 req/min
 * authenticated) and never on the **core** bucket (60/h anonymous, 5000/h
 * authenticated). The guard used to consult core, which was wrong in both
 * directions: a token made the probes unconditional (a token raises CORE, which
 * the probes do not spend), and a spent search bucket was invisible.
 *
 * Every case stubs `globalThis.fetch`, so this file never touches the network.
 * `per_page === 1` identifies a probe: the plan asks for `limit` rows, and every
 * probe asks for exactly one.
 *
 * Run `npx tsc -p tsconfig.json` first. This file loads the BUILT modules in
 * `lib/`, so a stale `lib/` is a false pass waiting to happen.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const {
  searchMerged,
  describeProbeOutcome,
  MAX_TERM_PROBES,
  PROBE_RETRY_RESERVE,
  PROBE_SAFETY_MARGIN,
} = await load('github.js')
const { cacheClearMemory } = await load('cache.js')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-probe-guard-'))
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch

const realFetch = globalThis.fetch
let pass = 0
let fail = 0

function check(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}\n        ${detail}`)
  }
}

/**
 * Three queries, nine distinct terms: the plan calls for the full
 * `MAX_TERM_PROBES` of 3 probes, so the guard's threshold is 3+1+1 = 5.
 */
const PLAN = [
  { query: 'local-first markdown notes', sort: 'stars', role: 'anchor' },
  { query: 'offline knowledge base', sort: 'stars', role: 'precise' },
  { query: 'plain text archive', sort: 'updated', role: 'tail' },
]
const PLAN_TERMS = new Set(PLAN.flatMap(({ query }) => query.split(/\s+/)).filter((term) => term.length > 0))

const ITEMS = [
  {
    full_name: 'acme/notes', html_url: 'https://github.com/acme/notes', owner: { login: 'acme' }, name: 'notes',
    description: 'local-first markdown notes', stargazers_count: 1200, language: 'TypeScript',
    pushed_at: '2026-01-01T00:00:00Z', topics: ['markdown'], archived: false, fork: false,
  },
  {
    full_name: 'acme/base', html_url: 'https://github.com/acme/base', owner: { login: 'acme' }, name: 'base',
    description: 'offline knowledge base', stargazers_count: 40, language: 'Rust',
    pushed_at: '2025-12-01T00:00:00Z', topics: ['notes'], archived: false, fork: false,
  },
]

const JSON_HEADERS = { 'content-type': 'application/json' }

/** The `x-ratelimit-*` triple GitHub sends, for one bucket. */
function rateHeaders(remaining, resetInSeconds = 42) {
  return {
    ...JSON_HEADERS,
    'x-ratelimit-limit': '10',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + resetInSeconds),
  }
}

/**
 * Install a fetch stub and return the recorded calls.
 *
 * `planRemaining` / `probeRemaining` are the search-bucket readings the mock
 * reports, or `undefined` to report NO `x-ratelimit-*` headers at all — the
 * "GitHub told us nothing" case. A `/rate_limit` request is answered with a
 * deliberately AMPLE core reading, so a guard that consulted core instead of the
 * search headers would visibly keep the probes on.
 */
function installFetch({ planRemaining, probeRemaining, probeStatus = 200, items = ITEMS } = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    const perPage = Number(parsed.searchParams.get('per_page'))
    const probe = perPage === 1
    calls.push({
      path: parsed.pathname,
      query: parsed.searchParams.get('q'),
      sort: parsed.searchParams.get('sort'),
      perPage,
      authorization: init?.headers?.authorization ?? null,
    })
    if (parsed.pathname === '/rate_limit') {
      return new Response(
        JSON.stringify({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } }),
        { status: 200, headers: JSON_HEADERS },
      )
    }
    if (parsed.pathname !== '/search/repositories') {
      return new Response('{"message":"unexpected path"}', { status: 404, headers: JSON_HEADERS })
    }
    const reading = probe ? probeRemaining : planRemaining
    const headers = reading === undefined ? JSON_HEADERS : rateHeaders(reading)
    if (probe && probeStatus !== 200) {
      return new Response('{"message":"API rate limit exceeded"}', { status: probeStatus, headers })
    }
    return new Response(
      JSON.stringify({ total_count: items.length, incomplete_results: false, items }),
      { status: 200, headers },
    )
  }
  return calls
}

const searches = (calls) => calls.filter((call) => call.path === '/search/repositories')
const planCallsOf = (calls) => searches(calls).filter((call) => call.perPage !== 1)
const probeCallsOf = (calls) => searches(calls).filter((call) => call.perPage === 1)

try {
  console.log('\n--- §7.4 headline: core bucket ample, search bucket at 0 → probes skipped ---')
  {
    const calls = installFetch({ planRemaining: 0 })
    const result = await searchMerged(PLAN, 10, {})
    const probes = probeCallsOf(calls)
    const note = describeProbeOutcome(result.probe)

    check('no probe request goes on the wire when the search bucket is empty',
      probes.length === 0, `probe calls=${JSON.stringify(probes.map((call) => call.query))}`)
    check('the plan itself still ran every query',
      planCallsOf(calls).length === PLAN.length, `plan calls=${planCallsOf(calls).length} of ${PLAN.length}`)
    check('only the search endpoint was contacted',
      calls.every((call) => call.path === '/search/repositories'),
      `paths=${JSON.stringify([...new Set(calls.map((call) => call.path))])}`)
    check('the core bucket was never consulted',
      calls.filter((call) => call.path === '/rate_limit').length === 0,
      `rate_limit calls=${calls.filter((call) => call.path === '/rate_limit').length}`)
    check('the guard reports the search bucket as exhausted',
      result.probe.skipped === 'search_quota_exhausted', `skipped=${result.probe.skipped}`)
    check('the reading carried into the report is the SEARCH bucket (0), not core (4999)',
      result.probe.searchRemaining === 0, `searchRemaining=${result.probe.searchRemaining}`)
    check('a known-zero quota is a READING, not an unknown',
      result.probe.skipped !== 'search_quota_unknown' && result.probe.searchRemaining === 0,
      `skipped=${result.probe.skipped} searchRemaining=${result.probe.searchRemaining}`)
    check('the skip names how many probes the plan called for',
      result.probe.planned === MAX_TERM_PROBES, `planned=${result.probe.planned}`)
    check('no per-term count is reported at all',
      result.termTotals.size === 0, `termTotals.size=${result.termTotals.size}`)

    check('the caller-visible note says the probes were skipped',
      note.includes('诊断探针被跳过'), note)
    check('the note says WHY: the search quota is spent',
      note.includes('搜索配额已用尽'), note)
    check('the note does not read as "the terms matched nothing"',
      !note.includes('命中为零') && !note.includes('只有这么多'), note)
    check('the wait offered is the search clock (minutes), never the core clock (hours)',
      note.includes('分钟') && !note.includes('小时'), note)
  }

  console.log('\n--- §7.3 a token must not make the probes unconditional ---')
  {
    const calls = installFetch({ planRemaining: 0 })
    const result = await searchMerged(PLAN, 10, { token: 'ghp_probe_guard_test' })

    check('the token really was sent on the wire',
      calls.some((call) => call.authorization === 'Bearer ghp_probe_guard_test'),
      `authorizations=${JSON.stringify([...new Set(calls.map((call) => call.authorization))])}`)
    check('an empty search bucket still skips the probes when a token is present',
      probeCallsOf(calls).length === 0, `probe calls=${probeCallsOf(calls).length}`)
    check('the skip is still reported as quota exhaustion, not as a token privilege',
      result.probe.skipped === 'search_quota_exhausted', `skipped=${result.probe.skipped}`)
  }

  console.log('\n--- §7.1 an ample search bucket → the probes run, bounded by MAX_TERM_PROBES ---')
  {
    const calls = installFetch({ planRemaining: 30 })
    const result = await searchMerged(PLAN, 10, {})
    const probes = probeCallsOf(calls)

    check('the probes run when the search bucket can pay for them',
      probes.length > 0, `probe calls=${probes.length}`)
    check('the probes are bounded by MAX_TERM_PROBES',
      probes.length <= MAX_TERM_PROBES, `probe calls=${probes.length} MAX_TERM_PROBES=${MAX_TERM_PROBES}`)
    check('every probe asks for exactly one row',
      probes.every((call) => call.perPage === 1), `perPage=${JSON.stringify(probes.map((call) => call.perPage))}`)
    check('every probed term comes from the plan itself',
      probes.every((call) => PLAN_TERMS.has(call.query)), `probed=${JSON.stringify(probes.map((call) => call.query))}`)
    check('a guard-approved run reports no skip',
      result.probe.skipped === null, `skipped=${result.probe.skipped}`)
    check('the report counts what actually went out',
      result.probe.attempted === probes.length, `attempted=${result.probe.attempted} wire=${probes.length}`)
    check('the report says how many probes the plan called for',
      result.probe.planned === MAX_TERM_PROBES, `planned=${result.probe.planned}`)
    check('an ample quota is a real reading, not an unknown',
      result.probe.searchRemaining === 30 && result.probe.skipped !== 'search_quota_unknown',
      `searchRemaining=${result.probe.searchRemaining} skipped=${result.probe.skipped}`)
    check('the counts land in termTotals',
      result.termTotals.size === probes.length, `termTotals.size=${result.termTotals.size} probes=${probes.length}`)
    check('nothing extra is printed when the probes simply ran',
      describeProbeOutcome(result.probe) === '', JSON.stringify(describeProbeOutcome(result.probe)))
  }

  console.log('\n--- §7.1 the threshold is "planned + reserve + margin > remaining" ---')
  {
    const threshold = MAX_TERM_PROBES + PROBE_RETRY_RESERVE + PROBE_SAFETY_MARGIN
    const atCalls = installFetch({ planRemaining: threshold })
    const at = await searchMerged(PLAN, 10, {})
    check(`remaining exactly ${threshold} (planned + reserve + margin) still runs the probes`,
      at.probe.skipped === null && probeCallsOf(atCalls).length > 0,
      `skipped=${at.probe.skipped} probes=${probeCallsOf(atCalls).length}`)

    const belowCalls = installFetch({ planRemaining: threshold - 1 })
    const below = await searchMerged(PLAN, 10, {})
    check(`remaining ${threshold - 1} skips them`,
      below.probe.skipped === 'search_quota_low' && probeCallsOf(belowCalls).length === 0,
      `skipped=${below.probe.skipped} probes=${probeCallsOf(belowCalls).length}`)
  }

  console.log('\n--- §7.1 low but non-zero → skipped, and the note says which number was short ---')
  {
    const calls = installFetch({ planRemaining: 1 })
    const result = await searchMerged(PLAN, 10, {})
    const note = describeProbeOutcome(result.probe)

    check('a low-but-nonzero search bucket skips the probes',
      result.probe.skipped === 'search_quota_low', `skipped=${result.probe.skipped}`)
    check('no probe request is issued',
      probeCallsOf(calls).length === 0, `probe calls=${probeCallsOf(calls).length}`)
    check('the low note names the reading and the probe count it could not cover',
      note.includes('剩余 1 次') && note.includes(`${result.probe.planned} 个探针`), note)
    check('the low note also uses the per-minute search clock',
      note.includes('分钟') && !note.includes('小时'), note)
  }

  console.log('\n--- §7.3 an unreadable quota is reported as unknown, neither 0 nor ample ---')
  {
    // CORRECTED (§7.1, the unknown case). This block previously asserted that an
    // unreadable quota did NOT block the probes, and that the report carried a
    // boolean `quotaUnknown` flag while the probes ran anyway. Both were wrong,
    // and wrong in the direction the guard exists to prevent: spending a budget
    // nobody measured. An unjudged budget is spent as if it were infinite, so the
    // corrected guard refuses it outright and names the reason
    // `search_quota_unknown` — a fourth outcome, not a synonym for either
    // "exhausted" or "fine". The assertions below were inverted to match, and the
    // `quotaUnknown` field no longer exists on `ProbeReport`.
    const calls = installFetch({})
    const result = await searchMerged(PLAN, 10, {})
    const note = describeProbeOutcome(result.probe)

    check('an unreadable quota does not authorise spending: the probes are skipped',
      probeCallsOf(calls).length === 0, `probe calls=${probeCallsOf(calls).length}`)
    check('the report names the unknown-quota reason',
      result.probe.skipped === 'search_quota_unknown', `skipped=${result.probe.skipped}`)
    check('no reading is invented',
      result.probe.searchRemaining === undefined, `searchRemaining=${result.probe.searchRemaining}`)
    check('an unknown quota is not reported as exhausted',
      result.probe.skipped !== 'search_quota_exhausted', `skipped=${result.probe.skipped}`)
    check('an unknown quota is not reported as a low-but-known one either',
      result.probe.skipped !== 'search_quota_low', `skipped=${result.probe.skipped}`)
    check('the note says the quota reading was unavailable',
      note.includes('没有返回可用的搜索配额读数'), note)
    check('the note says the guard could not judge, rather than claiming plenty',
      note.includes('无从判断'), note)
    check('the note does not claim zero remaining',
      !note.includes('剩余 0'), note)
    check('the note does not claim the quota was ample',
      !note.includes('充足') && !note.includes('充裕'), note)
    check('the note distinguishes unknown from a shortfall',
      note.includes('不是「配额不足」'), note)
    check('the note distinguishes unknown from a zero-hit measurement',
      note.includes('不是「检索词命中为零」'), note)
    check('nothing is recorded, so no term can be misread as a zero hit',
      result.termTotals.size === 0, `termTotals.size=${result.termTotals.size}`)
  }

  console.log('\n--- preserved: a failed probe is missing, never zero ---')
  {
    const calls = installFetch({ planRemaining: 30, probeStatus: 403 })
    const result = await searchMerged(PLAN, 10, {})
    const note = describeProbeOutcome(result.probe)

    check('the probes were attempted',
      probeCallsOf(calls).length > 0, `probe calls=${probeCallsOf(calls).length}`)
    check('the first probe failure stops the rest',
      result.probe.attempted === 1, `attempted=${result.probe.attempted} of ${result.probe.planned}`)
    check('a failed probe leaves its term unmeasured, not zero',
      result.termTotals.size === 0, `termTotals.size=${result.termTotals.size}`)
    check('the partial note says the missing terms are unmeasured, not zero',
      note.includes('未测得') && note.includes('不是零命中'), note)
    check('the plan rows survived the probe failure',
      result.candidates.length > 0, `candidates=${result.candidates.length}`)
  }

  console.log('\n--- preserved: the skip changes no row and no order ---')
  {
    const skipCalls = installFetch({ planRemaining: 0 })
    const skipped = await searchMerged(PLAN, 10, {})
    const runCalls = installFetch({ planRemaining: 30 })
    const ran = await searchMerged(PLAN, 10, {})

    check('both runs returned a pool',
      skipped.candidates.length > 0 && skipped.candidates.length === ran.candidates.length,
      `skipped=${skipped.candidates.length} ran=${ran.candidates.length}`)
    check('the rows and their order are identical across the skip',
      JSON.stringify(skipped.candidates) === JSON.stringify(ran.candidates),
      `skipped=${JSON.stringify(skipped.candidates.map((row) => row.full_name))} ran=${JSON.stringify(ran.candidates.map((row) => row.full_name))}`)
    check('the tail reservation is identical too',
      skipped.tailIncluded === ran.tailIncluded, `skipped=${skipped.tailIncluded} ran=${ran.tailIncluded}`)
    check('the per-query totals are identical too',
      JSON.stringify(skipped.totals) === JSON.stringify(ran.totals),
      `skipped=${JSON.stringify(skipped.totals)} ran=${JSON.stringify(ran.totals)}`)
    check('only the diagnostic differs',
      skipped.termTotals.size === 0 && ran.termTotals.size > 0,
      `skipped termTotals=${skipped.termTotals.size} ran termTotals=${ran.termTotals.size}`)
    check('the skip did not silently become extra probe traffic',
      probeCallsOf(skipCalls).length === 0 && probeCallsOf(runCalls).length > 0,
      `skipped probes=${probeCallsOf(skipCalls).length} ran probes=${probeCallsOf(runCalls).length}`)
  }

  console.log('\n--- §7.2 end to end: the caller-visible result carries the reason ---')
  {
    try {
      const { apply } = await load('index.js')
      const calls = installFetch({ planRemaining: 0 })
      const defs = new Map()
      apply({ tools: { register: (def) => defs.set(def.name, def) }, get: () => undefined })
      const scout = defs.get('scout_projects')
      assert.ok(scout !== undefined, 'scout_projects must be registered')
      const out = await scout.execute({ idea: 'local-first markdown notes app', limit: 3 }, {})

      check('the tool issues no probe request when the search bucket is empty',
        probeCallsOf(calls).length === 0, `probe calls=${probeCallsOf(calls).length}`)
      check('the tool still returned rows',
        Array.isArray(out.candidates) && out.candidates.length > 0, `candidates=${out.candidates?.length}`)
      check('the caller-visible result carries the skip reason',
        typeof out.probe_note === 'string' && out.probe_note.includes('搜索配额已用尽'),
        `probe_note=${JSON.stringify(out.probe_note)}`)
      check('the reason is visible without reaching into any internal field',
        typeof out.probe_note === 'string' && out.probe_note.includes('诊断探针被跳过'),
        `probe_note=${JSON.stringify(out.probe_note)}`)
    } catch (error) {
      check('the end-to-end path is reachable', false, `${error?.stack ?? error}`)
    }
  }

  console.log('\n--- constants that §7 must not change ---')
  {
    check('MAX_TERM_PROBES is still 3', MAX_TERM_PROBES === 3, `MAX_TERM_PROBES=${MAX_TERM_PROBES}`)
    check('the guard holds back a retry plus a margin',
      PROBE_RETRY_RESERVE >= 1 && PROBE_SAFETY_MARGIN >= 1,
      `reserve=${PROBE_RETRY_RESERVE} margin=${PROBE_SAFETY_MARGIN}`)
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`)
} finally {
  globalThis.fetch = realFetch
  cacheClearMemory()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(scratch, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
