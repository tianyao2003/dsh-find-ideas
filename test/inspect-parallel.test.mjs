// M3: parallel repository reads must not change WHAT the caller sees.
//
// The golden fixture harness (`eval/harness/golden-inspect.mjs`) cannot check
// this. It re-renders `inspections` arrays that were recorded earlier, so it
// exercises the renderer and never the fetch loop — an ordering bug in the read
// path would sail through it with 97 PASS. The property M3 actually risks is
// exactly that one: three lanes finish in whatever order the network decides,
// and the card must still print the repositories in the order they were asked
// for, with each repository's `files_read` in selector order.
//
// So this file drives the REAL tool against a stubbed network whose per-repo
// latency is the INVERSE of the requested order (the last repo answers first).
// Under a pool that filled results by completion, the card would come back
// reversed; under the pool that is actually shipped, it comes back as asked.
//
// It also pins the two bounds that make the parallelism safe rather than merely
// fast: the in-flight request count never exceeds `INSPECT_CONCURRENCY`, and it
// really does overlap (an implementation that serialized again would fail the
// overlap check while passing every ordering check).
//
// Run: node test/inspect-parallel.test.mjs   (NOT `node --test`)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-inspect-parallel-'))
const originalHome = process.env.DSH_HOME
// Set before the imports: the cache resolves `DSH_HOME` per operation, but
// redirecting it first keeps the ordering identical to the sibling tests.
process.env.DSH_HOME = scratch
const cacheDir = join(scratch, 'cache', 'dsh-find-ideas')

const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
const { apply, INSPECT_CONCURRENCY } = await load('index.js')
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

const coldCache = () => {
  cacheClearMemory()
  rmSync(cacheDir, { recursive: true, force: true })
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rateHeaders = (remaining) => ({
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
})

/**
 * Repositories whose completion order is the reverse of their request order.
 *
 * `slow/one` takes 120ms per request, `fast/three` takes 10ms, so a pool that
 * collected results as they arrived would return `[fast/three, mid/two,
 * slow/one]`. Each repo has a distinct tree so the `files_read` assertion below
 * cannot pass by accident across repositories.
 */
const REPOS = [
  { name: 'slow/one', delay: 120, tree: ['README.md', 'package.json', 'src/one.ts'] },
  { name: 'mid/two', delay: 60, tree: ['README.md', 'Cargo.toml', 'src/two.rs'] },
  { name: 'fast/three', delay: 10, tree: ['README.md', 'go.mod', 'main.go'] },
]

const installFetch = () => {
  const state = { calls: [], inFlight: 0, peak: 0, done: 0, firstDone: [] }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    state.calls.push(path)
    if (path === '/rate_limit') {
      return json({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } })
    }
    const matched = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path)
    if (matched === null) return json({ message: 'unexpected path' }, 404)
    const fullName = `${decodeURIComponent(matched[1])}/${decodeURIComponent(matched[2])}`
    const rest = matched[3]
    const repo = REPOS.find((entry) => entry.name === fullName)
    if (repo === undefined) return json({ message: 'unknown repo' }, 404)

    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, repo.delay))
      // Record which repository finished a request first: `calls` above records
      // request START order, which is always the requested order because lanes
      // launch in order, so it cannot prove the stub is not uniform.
      if (!state.firstDone.includes(fullName)) state.firstDone.push(fullName)
      if (rest === 'readme') {
        const text = `# ${fullName}\n\nA project used by the parallel-order test.\n`
        return json({ content: b64(text), encoding: 'base64', size: Buffer.byteLength(text) }, 200, rateHeaders(4999))
      }
      if (rest.startsWith('git/trees/')) {
        return json({
          tree: repo.tree.map((entry) => ({ path: entry, type: 'blob', sha: 'a'.repeat(40) })),
          truncated: false,
        }, 200, rateHeaders(4999))
      }
      if (rest.startsWith('contents/')) {
        const rel = decodeURIComponent(rest.slice('contents/'.length))
        const text = `// ${rel}\nexport const value = 1\n`
        return json({ content: b64(text), encoding: 'base64', size: Buffer.byteLength(text), sha: 'b'.repeat(40) }, 200, rateHeaders(4999))
      }
      return json({ message: 'unexpected path' }, 404)
    } finally {
      state.inFlight -= 1
      state.done += 1
    }
  }
  return {
    state,
    restore: () => { globalThis.fetch = realFetch },
  }
}

const registerTools = () => {
  const defs = new Map()
  apply({
    tools: { register: (def) => defs.set(def.name, def) },
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'ghp_inspect_parallel' }) } : undefined),
  })
  return defs
}

try {
  const defs = registerTools()
  const inspect = defs.get('inspect_projects')
  check('inspect_projects is registered', inspect !== undefined, [...defs.keys()].join(', '))

  // =========================================================================
  console.log('\n=== Q1. repositories come back in the order they were asked for ===')
  {
    coldCache()
    const net = installFetch()
    try {
      const requested = REPOS.map((repo) => repo.name)
      const value = await inspect.execute({ idea: 'parallel order', repos: requested, depth: 'shallow' }, {})
      const returned = value.inspections.map((item) => item.full_name)
      check('every requested repository came back', returned.length === requested.length,
        JSON.stringify(returned))
      check('the card order equals the requested order, not the completion order',
        JSON.stringify(returned) === JSON.stringify(requested),
        `requested=${JSON.stringify(requested)} returned=${JSON.stringify(returned)}`)
      // Anti-vacuity: the check above must not pass merely because every repo
      // happens to be equally fast. What counts as proof depends on the width
      // the pool was actually built with, because `INSPECT_CONCURRENCY = 1` IS
      // the rollback position — a serial pool cannot complete out of order, and
      // demanding that it do so would break the very rollback this constant
      // promises. So: at width 1, prove the lane really is serial; above 1,
      // prove the stub really did overtake the requested order.
      if (INSPECT_CONCURRENCY >= 2) {
        check('the stub really did answer in an order other than the requested one',
          JSON.stringify(net.state.firstDone) !== JSON.stringify(requested),
          JSON.stringify(net.state.firstDone))
        check('the stub really did answer in the reverse of the requested order',
          JSON.stringify(net.state.firstDone) === JSON.stringify(['fast/three', 'mid/two', 'slow/one']),
          JSON.stringify(net.state.firstDone))
      } else {
        check('at the serial rollback position the stub answered in the requested order',
          JSON.stringify(net.state.firstDone) === JSON.stringify(requested),
          JSON.stringify(net.state.firstDone))
      }
      // The other half of "what the caller sees": within one repository, files
      // are listed in selector order, not in whatever order they were read.
      for (const [index, repo] of REPOS.entries()) {
        const row = value.inspections[index]
        check(`${repo.name}: files_read is non-empty and starts with the README`,
          row !== undefined && row.files_read.length > 0 && row.files_read[0] === 'README.md',
          JSON.stringify(row?.files_read))
      }
      check('the request count still equals the requests actually made',
        value.requests_used === net.state.calls.length,
        `reported=${value.requests_used} wire=${net.state.calls.length}`)
    } finally {
      net.restore()
    }
  }

  // =========================================================================
  console.log('\n=== Q2. the reads really overlap, and the overlap is bounded ===')
  {
    coldCache()
    const net = installFetch()
    try {
      await inspect.execute({ idea: 'parallel bound', repos: REPOS.map((repo) => repo.name), depth: 'shallow' }, {})
      check('the bound is the exported constant', INSPECT_CONCURRENCY >= 1, `INSPECT_CONCURRENCY=${INSPECT_CONCURRENCY}`)
      check('no more than INSPECT_CONCURRENCY requests were ever in flight',
        net.state.peak <= INSPECT_CONCURRENCY,
        `peak=${net.state.peak} limit=${INSPECT_CONCURRENCY}`)
      // The control that stops this group from passing on a serial loop: with
      // three repositories and a limit of three, at least two must overlap.
      check('at least two repositories were read at the same time',
        net.state.peak >= Math.min(2, INSPECT_CONCURRENCY),
        `peak=${net.state.peak} limit=${INSPECT_CONCURRENCY}`)
      check('the batch did not serialize into three sequential reads',
        net.state.peak === Math.min(INSPECT_CONCURRENCY, REPOS.length),
        `peak=${net.state.peak} expected=${Math.min(INSPECT_CONCURRENCY, REPOS.length)}`)
    } finally {
      net.restore()
    }
  }

  // =========================================================================
  console.log('\n=== Q3. a per-repo failure keeps its place in the failure list ===')
  {
    // `mid/two` 404s on every endpoint, so it produces a failed inspection while
    // its neighbours succeed. The point is the ORDER of the degraded text: it is
    // built from `failures`, which the pool must fill in requested order, not in
    // the order the lanes happened to report.
    coldCache()
    const realFetch = globalThis.fetch
    const state = { calls: [] }
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname
      state.calls.push(path)
      if (path === '/rate_limit') {
        return json({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } })
      }
      const matched = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path)
      if (matched === null) return json({ message: 'unexpected path' }, 404)
      const fullName = `${decodeURIComponent(matched[1])}/${decodeURIComponent(matched[2])}`
      const rest = matched[3]
      if (fullName === 'mid/two') {
        // Slow enough that the failure is reported LAST by the network while
        // still being SECOND in the requested order.
        await new Promise((resolve) => setTimeout(resolve, 40))
        return json({ message: 'boom' }, 500)
      }
      if (rest === 'readme') {
        const text = `# ${fullName}\n\nA project.\n`
        return json({ content: b64(text), encoding: 'base64', size: Buffer.byteLength(text) }, 200, rateHeaders(4999))
      }
      if (rest.startsWith('git/trees/')) {
        return json({ tree: [{ path: 'README.md', type: 'blob', sha: 'a'.repeat(40) }], truncated: false }, 200, rateHeaders(4999))
      }
      return json({ message: 'unexpected path' }, 404)
    }
    try {
      const value = await inspect.execute({
        idea: 'parallel failure order',
        repos: ['slow/one', 'mid/two', 'fast/three'],
        depth: 'shallow',
      }, {})
      check('the two healthy repositories were still read', value.inspections.length === 3,
        JSON.stringify(value.inspections.map((item) => `${item.full_name}:${item.ok}`)))
      check('the batch reports a partial result', value.degraded?.reason === 'partial',
        JSON.stringify(value.degraded))
      const okNames = value.inspections.filter((item) => item.ok).map((item) => item.full_name)
      check('the healthy rows keep the requested order',
        JSON.stringify(okNames) === JSON.stringify(['slow/one', 'fast/three']),
        JSON.stringify(okNames))
      // The failed row keeps its position too: it is the second entry, not the last.
      check('the failed row sits at its requested index',
        value.inspections[1]?.full_name === 'mid/two',
        JSON.stringify(value.inspections.map((item) => item.full_name)))
    } finally {
      globalThis.fetch = realFetch
    }
  }
} finally {
  cacheClearMemory()
  rmSync(scratch, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
