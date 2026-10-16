// Stage 2 regression test: the agent-plan arm must stay comparable to the frozen
// Stage 1 baseline, and the shipped planner must still produce the plans the
// baseline depended on.
//
// WHAT THIS FREEZES AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------
// Frozen (regression risk is real):
//   S1. `buildQueries` still produces the exact Stage 1 plans for all 8 cases. If
//       the static planner changes, the Stage 1 baseline stops being a control and
//       any later comparison silently compares against a moved goalpost.
//   S2. The agent plan file still parses, still covers all 8 cases, and still
//       obeys the plugin's own limits (<= MAX_QUERIES steps, valid sort values).
//   S3. The Stage 2 report's headline numbers are recomputable from the two frozen
//       runs, so the conclusion cannot drift away from its evidence.
//
// NOT frozen:
//   - The agent plans themselves. They are model output; freezing them would turn
//     one sample into a permanent contract.
//   - The agent-pool relevance scores in eval/agent-relevance.json. Those are the
//     main agent's judgements; a later reader must be free to disagree and rescore,
//     which is why they live in a data file rather than inside this test.
//
// Offline: reads only files on disk, opens no sockets.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const baseDir = join(root, 'eval', 'runs', 'baseline-2026-10-10T07-22-48-244Z')
const agentDir = join(root, 'eval', 'runs', 'agent-stage2')

let passed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) { passed += 1; return }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---------------------------------------------------------------------------
// Both arms this file compares live under `eval/runs/`, and this repository has
// no `eval/` directory at all. The port carried this TEST FILE over from the
// predecessor plugin; it did not carry the runs it replays. A checkout
// therefore has neither arm, and reading them would throw ENOENT — reporting a
// missing fixture as a broken pipeline.
//
// This used to say the fixtures were absent because `eval/runs/` "is gitignored
// by design (see .gitignore)". That was true of the predecessor repository,
// whose .gitignore does ignore `eval/runs/`; it is false here, because this
// .gitignore does not mention `eval` at all. The skip was correct either way,
// but the stated reason sent a reader to an ignore rule that does not exist
// rather than to the real gap — the fixtures were never ported.
//
// Skip loudly instead, and name the claims that went unchecked, so nobody reads
// a green CI run as "the Stage 1 / Stage 2 comparison still holds".
const REQUIRED_FIXTURES = [
  join(baseDir, 'snapshot.json'),
  join(baseDir, 'key.json'),
  join(baseDir, 'judge-annotations.json'),
  join(agentDir, 'snapshot.json'),
  join(agentDir, 'stage2-report.json'),
]
const absent = REQUIRED_FIXTURES.filter((p) => !existsSync(p))
if (absent.length > 0) {
  // Tell the aggregate runner this file did not run, so it cannot be counted as
  // a pass (see test/run-all.test.mjs).
  if (process.env.DSH_SKIP_MARKER) writeFileSync(process.env.DSH_SKIP_MARKER, 'skipped\n')
  console.log('stage2.test: SKIPPED — the frozen Stage 1 / Stage 2 runs are not on disk')
  for (const p of absent) console.log('  missing: ' + p.slice(root.length).replace(/\\/g, '/'))
  console.log('  reason : this repository has no eval/ directory — the fixtures were never ported')
  console.log('  NOT verified by this skip:')
  console.log('    S1  the static planner still produces the frozen Stage 1 plans')
  console.log('    S2  the agent plan file is structurally valid and covers all 8 cases')
  console.log('    S3  the Stage 2 headline numbers are recomputable from frozen data')
  console.log('  To run it: regenerate the runs, then `npm test`.')
  process.exit(0)
}

const suite = readJson(join(root, 'eval', 'cases.json'))
const { buildQueries, MAX_QUERIES } = await import(pathToFileURL(join(root, 'lib', 'query.js')).href)

// ---------------------------------------------------------------------------
// S1 — the static planner keeps the SHAPE the Stage 1 recording was made under.
//
// This block used to assert `S1 buildQueries unchanged`: the current plan had to
// match the recording query for query AND slot for slot. That is the same
// assertion `test/baseline.test.mjs` carried as `plan is unchanged`, and it fails
// the same way: the plan is the layer under deliberate development, so every
// improvement turns it red and the fix is to retype the expected strings. An
// assertion you must edit whenever the thing it guards improves is not a guard.
//
// Two separate facts were being conflated, and they are now checked separately:
//
//  1. The RECORDED plan is a fact about the recording. It is pinned as such in
//     test/baseline.test.mjs B1 (budget and ordering), and the recording still
//     replays against it there via the `replaying` flag in B3.
//  2. Today's planner must still produce a well-formed plan: three roles, each
//     present exactly once, the tail carrying sort=updated, and no duplicate
//     `${sort}|${query}` pair. Those are design invariants: they survive query
//     text changing, and a regression violates them.
//
// Slot POSITION is deliberately not asserted. It changed on purpose when roles
// were named (the anchor now leads, so the pool's head is the widest channel),
// and it is exactly the property that has no behavioural meaning on its own.
// ---------------------------------------------------------------------------
const baseSnapshot = readJson(join(baseDir, 'snapshot.json'))
check('S1 snapshot has 8 cases', baseSnapshot.cases.length === 8, `got ${baseSnapshot.cases.length}`)

const seenRoles = new Set()
for (const c of baseSnapshot.cases) {
  const idea = c.input.idea
  const keywords = c.input.keywords === null ? '' : c.input.keywords
  const plan = buildQueries(idea, keywords)

  check(`S1 ${c.input.id} has exactly one anchor`,
    plan.filter((p) => p.role === 'anchor').length === 1,
    plan.map((p) => `${p.role}:${p.query}`).join(' | '))
  check(`S1 ${c.input.id} has exactly one tail`,
    plan.filter((p) => p.role === 'tail').length === 1,
    plan.map((p) => `${p.role}:${p.query}`).join(' | '))
  // The tail's contract is REACHING THE LONG TAIL, and it states which of the two
  // mechanisms it uses (see TailReason in src/query.ts). This used to assert
  // `sort=updated` literally, which pinned the mechanism and would have rejected
  // the measured `narrow` case where both orderings return the identical set
  // (26 rows, 88.5% under 100 stars) and only permute it.
  check(`S1 ${c.input.id} every tail states its reason`,
    plan.filter((p) => p.role === 'tail').every((p) => p.tailReason === 'updated' || p.tailReason === 'narrow'),
    plan.filter((p) => p.role === 'tail').map((p) => `${p.query}:${p.tailReason}`).join(' | '))
  check(`S1 ${c.input.id} an 'updated' tail must actually use sort=updated`,
    plan.filter((p) => p.tailReason === 'updated').every((p) => p.sort === 'updated'),
    plan.filter((p) => p.tailReason === 'updated').map((p) => `${p.query}:${p.sort}`).join(' | '))
  check(`S1 ${c.input.id} has no duplicate sort+query pair`,
    new Set(plan.map((p) => `${p.sort}|${p.query}`)).size === plan.length,
    plan.map((p) => `${p.sort}|${p.query}`).join(' ; '))
  check(`S1 ${c.input.id} within MAX_QUERIES`, plan.length <= MAX_QUERIES, `got ${plan.length}`)
  for (const step of plan) seenRoles.add(step.role)
}
check('S1 across the suite the planner exercises all three roles', seenRoles.size === 3, [...seenRoles].join(','))

// ---------------------------------------------------------------------------
// S2 — the agent plan file is structurally valid and covers every case.
// ---------------------------------------------------------------------------
const agentSnapshot = readJson(join(agentDir, 'snapshot.json'))
const planIds = agentSnapshot.cases.map((c) => c.input.id).sort()
const suiteIds = suite.cases.map((c) => c.id).sort()
check('S2 agent run covers exactly the suite cases', JSON.stringify(planIds) === JSON.stringify(suiteIds),
  `agent ${planIds.join(',')} vs suite ${suiteIds.join(',')}`)

for (const c of agentSnapshot.cases) {
  check(`S2 ${c.input.id} has at least one step`, c.plan.length >= 1, `got ${c.plan.length}`)
  check(`S2 ${c.input.id} within MAX_QUERIES`, c.plan.length <= MAX_QUERIES, `got ${c.plan.length}`)
  for (const step of c.plan) {
    check(`S2 ${c.input.id} non-empty query`, typeof step.query === 'string' && step.query.trim().length > 0)
    check(`S2 ${c.input.id} valid sort`, step.sort === 'stars' || step.sort === 'updated', `got ${step.sort}`)
    // The suite has measured that these qualifiers destroy recall; a plan that
    // reintroduced them would invalidate the comparison rather than win it.
    check(`S2 ${c.input.id} uses no rejected qualifier`, !/\b(in:|topic:|language:|stars:)/.test(step.query), step.query)
  }
  check(`S2 ${c.input.id} collected a full pool`, c.pool.candidates.length === suite.poolLimit, `got ${c.pool.candidates.length}`)
  check(`S2 ${c.input.id} had no failed channel`, c.channels.every((ch) => ch.status === 'ok'),
    c.channels.filter((ch) => ch.status !== 'ok').map((ch) => ch.query).join(','))
  const stars = c.pool.candidates.map((r) => r.stars)
  check(`S2 ${c.input.id} pool is star-descending`, stars.every((s, i) => i === 0 || stars[i - 1] >= s))
}

// ---------------------------------------------------------------------------
// S3 — the headline conclusion is recomputable from frozen data.
// ---------------------------------------------------------------------------
// NOTE ON `aggregate_7_scorable_cases`
// ------------------------------------
// This block used to live inside stage2-report.json as a hand-maintained field,
// and the two checks below compared a live recomputation against it. That made
// the frozen claim an INPUT to the test rather than an output of it: running the
// generator (eval/stage2-report.mjs, which never wrote that key) silently
// destroyed it, and the suite went red for a reason that had nothing to do with
// the pipeline. The claim is now DERIVED here, from inputs the generator cannot
// clobber, so the assertion keeps its teeth and loses its fragility.
const report = readJson(join(agentDir, 'stage2-report.json'))
check('S3 report covers 8 cases', report.cases.length === 8, `got ${report.cases.length}`)

// db-migrate-en must be identified as unmeasurable rather than quietly averaged in.
const dbm = report.cases.find((c) => c.id === 'db-migrate-en')
check('S3 db-migrate-en baseline card is below the card limit (unmeasurable)',
  dbm.baseline.card.length < suite.cardLimit, `got ${dbm.baseline.card.length}`)
check('S3 db-migrate-en agent card has no judge-labelled rows',
  dbm.agent.cardJudge.unlabelled === dbm.agent.card.length,
  `${dbm.agent.cardJudge.unlabelled} of ${dbm.agent.card.length}`)

// Recompute the 7-case strictP@10 from the per-case cards and the frozen judge
// labels. This is the claim the report used to state; deriving it here means a
// regenerated report cannot invalidate the test by dropping a key.
const baseKey = readJson(join(baseDir, 'key.json'))
const baseJudge = readJson(join(baseDir, 'judge-annotations.json'))
const nameById = new Map(baseKey.rows.map((r) => [r.id, r.full_name]))
const judgeBy = new Map()
for (const row of baseJudge.rows) judgeBy.set(nameById.get(row.id), row.label)

const scorable = report.cases.filter((c) => c.id !== 'db-migrate-en')
const strict = scorable.map((c) => c.agent.card.filter((r) => judgeBy.get(r.full_name) === 'yes').length / suite.cardLimit)
const recomputed = strict.reduce((a, b) => a + b, 0) / strict.length
// The frozen value this used to be checked against (0.714, i.e. 5 of 7 cases at
// 10/10) is kept as a literal on purpose: it is the number a report was published
// with, and a live derivation that agrees with it is what makes the claim
// auditable. If the pipeline changes, this literal is what tells you the
// published number moved.
const PUBLISHED_7CASE_STRICT_P10 = 0.714
check('S3 recomputed 7-case strictP@10 still matches the published headline',
  Math.abs(recomputed - PUBLISHED_7CASE_STRICT_P10) < 0.01,
  `recomputed ${recomputed.toFixed(4)} vs published ${PUBLISHED_7CASE_STRICT_P10} — `
  + `if this is an intended pipeline change, the published headline in docs/ needs updating too`)

// The claim "the agent plan reaches repositories the baseline never fetched" is the
// reason the two rulers disagree; assert the overlap is genuinely partial.
let overlap = 0
let agentOnly = 0
for (const c of agentSnapshot.cases) {
  const bc = baseSnapshot.cases.find((x) => x.input.id === c.input.id)
  const baseNames = new Set(bc.pool.candidates.map((r) => r.full_name.toLowerCase()))
  for (const row of c.pool.candidates) {
    if (baseNames.has(row.full_name.toLowerCase())) overlap += 1
    else agentOnly += 1
  }
}
check('S3 agent plans reach a substantially different repository population',
  agentOnly >= 100, `only ${agentOnly} of ${overlap + agentOnly} rows are new`)

if (failures.length > 0) {
  console.error(`stage2.test: ${failures.length} FAILED, ${passed} passed`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`stage2.test: ${passed} assertions passed`)
