// Evidence probe: why does dsh-idea-scout's test/bilingual-routing.test.mjs:144 fail?
//
// Finding (2026-10-15): the assertion is STALE, not a behavior defect.
//   planQueries() emits 3 queries; the tool issues those exact 3 calls FIRST,
//   then 3 more term probes (B6 diagnostics), so assert.deepEqual(calls, plan)
//   fails on the extra 3.
//
// Run: node research/probe-bilingual-routing-calls.mjs
// Requires: D:\workspace\work_space2\dsh-idea-scout with lib/ built.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = 'D:/workspace/work_space2/dsh-idea-scout'
const load = (rel) => import(pathToFileURL(join(root, 'lib', rel)).href)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-probe-br-'))
process.env.DSH_HOME = scratch

const { planQueries } = await load('query.js')
const { apply } = await load('index.js')

const unknownIdea = '一个区块链浏览器，支持多链查询和交易追踪'
const keywords = 'blockchain explorer multi-chain transaction tracking'

const planned = planQueries(unknownIdea, keywords)
console.log('=== PLAN (planQueries) ===')
for (const q of planned.queries) console.log('  ', JSON.stringify({ query: q.query, sort: q.sort, role: q.role }))

const defs = new Map()
apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
const scout = defs.get('scout_projects')

const calls = []
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url))
  calls.push({ query: parsed.searchParams.get('q'), sort: parsed.searchParams.get('sort') })
  return new Response(JSON.stringify({
    total_count: 1,
    incomplete_results: false,
    items: [{
      full_name: 'fresh/explorer', html_url: 'https://github.com/fresh/explorer',
      owner: { login: 'fresh' }, name: 'explorer', description: 'blockchain explorer',
      stargazers_count: 12, language: 'TypeScript', pushed_at: '2026-01-01T00:00:00Z',
      topics: ['blockchain'], archived: false, fork: false,
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const cold = await scout.execute({ idea: unknownIdea, keywords, limit: 3 }, {})

console.log('\n=== CALLS ACTUALLY ISSUED ===')
for (const c of calls) console.log('  ', JSON.stringify(c))

console.log('\n=== EXPECTED (plan mapped to {query,sort}) ===')
for (const q of planned.queries) console.log('  ', JSON.stringify({ query: q.query, sort: q.sort }))

const expected = planned.queries.map((q) => ({ query: q.query, sort: q.sort }))
console.log('\ncached =', cold.cached, '| callCount =', calls.length, '(expected', expected.length + ')')
console.log('PLAN IS A PREFIX OF CALLS:', JSON.stringify(calls.slice(0, expected.length)) === JSON.stringify(expected))
console.log('EXTRA CALLS (term probes):', JSON.stringify(calls.slice(expected.length)))
console.log('=> the assertion compares ALL calls, so the 3 extra probes make it fail.')

rmSync(scratch, { recursive: true, force: true })
