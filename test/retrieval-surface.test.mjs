// The retrieval-surface claim must match what GitHub's search actually does.
//
// THE DEFECT THIS PINS DOWN
// -------------------------
// `RETRIEVAL_SURFACE` told every caller that repository search "matches the
// repository NAME and DESCRIPTION only" and that a project described only in its
// README "is unreachable by any query, however precise". Both halves were wrong,
// in opposite directions:
//
//   * TOPICS are searched too, and were omitted — so the boundary was stated too
//     narrowly, and a caller could conclude a `topic:` query was out of bounds.
//   * `in:readme` DOES reach README text — so "unreachable by any query" was
//     false, and the one remedy that exists was never named.
//
// Four other sites carried the mirror-image error, putting README INTO the
// default surface ("GitHub 仓库搜索对名称、描述、README 做多词 AND 匹配"). That
// overstates the default surface, so an empty result set reads as a thin corpus
// rather than as a surface that never covered the project.
//
// WHAT THE MEASUREMENT SAYS (docs.github.com, "Searching for repositories")
// -------------------------------------------------------------------------
//   "With the `in` qualifier you can restrict your search to the repository
//    name, repository description, repository topics, contents of the README
//    file, or any combination of these. When you omit this qualifier, only the
//    repository name, description, and topics are searched."
//
// and, separately: "Besides using `in:readme`, it's not possible to find
// repositories by searching for specific content within the repository."
//
// `in:readme` widens rather than sharpens — measured on six terms, the
// `in:readme` result set was 1.7x to 413x the unqualified one — and it does NOT
// guarantee exhaustiveness: `cordiverse` is present in a README that
// `in:readme` failed to return. So the remedy must be stated WITH its limit;
// asserting only the good half would trade one overclaim for another.
//
// WHY A TEST AND NOT JUST THE EDIT
// --------------------------------
// This text is prose in five places and no test read any of them, so the wrong
// version survived many rounds. Prose drifts back silently; these assertions are
// what make the correction stick.
//
// Run with:  npm test
// Or directly: node test/retrieval-surface.test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)
const readSrc = (rel) => readFileSync(join(pkgRoot, 'src', rel), 'utf8')

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

const mod = await load('index.js')
const { RETRIEVAL_SURFACE } = mod
const { describePlanFailure } = await load('query.js')
const { explainEmpty } = await load('render.js')

const defs = new Map()
mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })

console.log('\n=== 1. the boundary is stated in all three tool descriptions, identically ===')
{
  // One constant, three placements. The original comment promised the copies
  // would not drift; these assertions are what actually hold that.
  const readers = ['scout_projects', 'rank_candidates', 'inspect_projects']
  for (const tool of readers) {
    const desc = defs.get(tool)?.description ?? ''
    check(`${tool} carries the retrieval-surface boundary`, desc.includes(RETRIEVAL_SURFACE), desc.slice(0, 120))
  }

  const occurrences = readers.map((t) => (defs.get(t)?.description ?? '').split(RETRIEVAL_SURFACE).length - 1)
  check('the boundary is stated exactly once per description', occurrences.every((n) => n === 1), JSON.stringify(occurrences))
}

console.log('\n=== 2. the default surface names all three searched fields ===')
{
  check('the boundary names NAME', /NAME/.test(RETRIEVAL_SURFACE))
  check('the boundary names DESCRIPTION', /DESCRIPTION/.test(RETRIEVAL_SURFACE))
  // The omission that made the original statement wrong.
  check('the boundary names TOPICS as part of the default surface', /NAME, DESCRIPTION and TOPICS/.test(RETRIEVAL_SURFACE), RETRIEVAL_SURFACE)
  check('the boundary still says the default surface excludes README bodies', /does NOT index README bodies/.test(RETRIEVAL_SURFACE))
}

console.log('\n=== 3. the in:readme remedy is named, WITH its limit ===')
{
  check('the boundary names the in:readme qualifier', RETRIEVAL_SURFACE.includes('in:readme'))

  // The counter-example half. `in:readme` measured as a WIDER net (up to 413x
  // the unqualified result set) that still misses a term present in the README
  // it was pointed at, so a statement that only says "use in:readme" would
  // overclaim in the opposite direction. The hedge is the assertion.
  check('the boundary does not claim in:readme sharpens the search',
    /widens the net rather than sharpening/.test(RETRIEVAL_SURFACE), RETRIEVAL_SURFACE)
  check('the boundary does not promise in:readme is exhaustive',
    /does not guarantee exhaustiveness/.test(RETRIEVAL_SURFACE), RETRIEVAL_SURFACE)

  // The exact sentence that was false. `in:readme` IS a query, so "any query"
  // cannot stand.
  check('the boundary no longer says README-only projects are unreachable by ANY query',
    !/unreachable by any query/i.test(RETRIEVAL_SURFACE), RETRIEVAL_SURFACE)
}

console.log('\n=== 4. the four prose sites that overstated the default surface are corrected ===')
{
  // These said README was AND-matched by a bare query, which the docs deny.
  const query = readSrc('query.ts')
  const render = readSrc('render.ts')

  for (const [name, text] of [['query.ts', query], ['render.ts', render]]) {
    check(`src/${name} no longer puts README in the default surface`,
      !/名称、描述、README/.test(text))
    check(`src/${name} names topics in the default surface instead`,
      /名称、描述、topics/.test(text))
  }

  // The STOPWORDS doc comment, in English and easy to miss.
  check('the STOPWORDS comment names topics, not README',
    /AND-matches across name, description and topics/.test(query), 'src/query.ts')

  // Both copies of the thin-result sentence must agree: `explainThinResult` and
  // `describeReplayedThinness` hold the same sentence, and correcting one only
  // would leave the cached and live paths describing different surfaces.
  const copies = (query.match(/名称、描述、topics 做多词 AND 匹配/g) ?? []).length
  check('both copies of the thin-result sentence were corrected together', copies === 2, `${copies} copy/copies`)
  check('no copy of the thin-result sentence still says README',
    !/名称、描述、README 做多词/.test(query))
}

console.log('\n=== 5. the plan-failure note offers in:readme without losing its field list ===')
{
  // The note that fires when the planner throws. Its field list ("名称、描述与
  // topics") was already CORRECT before this change — the gap was that it named
  // no remedy for a project described only in its README. Both halves matter:
  // the field list is what the note is for, the remedy is what was missing.
  const note = describePlanFailure(new Error('query plan: tail slot has no tailReason'), undefined)
  check('the note names in:readme as the wider-coverage remedy', note.includes('in:readme'), note)
  check('the note keeps its correct field list', note.includes('名称、描述与 topics'), note)
  check('the note does not claim README is covered by a bare query',
    note.includes('不覆盖 README 正文'), note)
  // The hedge travels with the remedy here too, for the same measured reason.
  check('the note carries the in:readme limit', note.includes('不保证穷尽'), note)

  // The pre-existing contract this note must not lose. The full set lives in
  // test/plan-failure.test.mjs; these two are the ones this edit could break.
  check('the note still says no search was issued', note.includes('没有发起任何检索'))
  check('the note still refuses to claim there are no related projects', note.includes('不代表没有相关项目'))
}

console.log('\n=== 6. the empty-result explanation matches the corrected surface ===')
{
  // `explainEmpty` is the text a user sees when a search returns nothing, which
  // is exactly the moment the surface claim decides whether "nothing exists" or
  // "this query never looked there" is the honest reading.
  const empty = explainEmpty(null)
  check('the empty-result note does not put README in the default surface',
    !/名称、描述、README/.test(empty), empty)
  check('the empty-result note names topics in the default surface',
    /名称、描述、topics/.test(empty), empty)
  check('the empty-result note still explains the narrowness mechanism',
    empty.includes('多词 AND 匹配'), empty)
}

console.log('\n=== 7. a plan failure is not a network failure ===')
{
  // Measured on the A/B arm: a Han-only idea with no Latin `keywords` rendered
  // the refusal and then the GENERIC tail — "这是网络或代理问题" — which sends
  // the reader to check the network for a failure that never opened a socket.
  // The generic branch is the default for every unclassified reason, so the
  // plan_failed case needs its own branch and this is what holds it.
  const plan = explainEmpty({ reason: 'plan_failed', detail: '拒绝执行：请提供 keywords。' })
  check('the plan-failure note says the search never started',
    plan.includes('检索没有开始'), plan)
  check('the plan-failure note denies the network explanation',
    plan.includes('这不是网络问题'), plan)
  check('the plan-failure note does NOT claim a network or proxy problem',
    !plan.includes('网络或代理问题'), plan)
  check('the plan-failure note still carries the underlying detail',
    plan.includes('请提供 keywords'), plan)

  // The neighbouring classified branch must not have been absorbed by the new
  // one: rate_limited has its own remedy and its own sentence.
  const limited = explainEmpty({ reason: 'rate_limited', detail: '配额耗尽。' })
  check('the rate-limited note still names the quota', limited.includes('配额问题'), limited)

  // And the genuinely unclassified reason must KEEP the network reading — that
  // branch exists for exactly the failures that did reach the wire.
  const generic = explainEmpty({ reason: 'something_else', detail: '连接被重置。' })
  check('an unclassified failure keeps the network reading',
    generic.includes('网络或代理问题'), generic)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
