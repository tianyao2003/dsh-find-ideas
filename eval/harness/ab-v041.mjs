// Reproduce the headline numbers of the v0.4.1 A/B run from frozen inputs.
//
// WHY THIS EXISTS
// ---------------
// The v0.4.1 report (v0.4.1-AB实验报告.md) makes four kinds of claim:
//   1. paired A-vs-B deltas over nine metrics,
//   2. a quality delta from two blind raters,
//   3. an unreachability proof for the 25,000 billed / 50s wall-clock targets,
//   4. behavioural evidence that the M4 recovery paths were used.
// Every one of them is judged against numbers in that report, so every one has
// to be recomputable from checked-in data. Without this script the report is a
// claim about a spreadsheet nobody can open -- which is exactly the failure the
// previous batch shipped when its wall-clock column turned out to have been
// copied from an earlier batch and was retracted in `c3cff7d`.
//
// This script does NOT re-run the experiment. It re-derives the statistics from
// the frozen per-run rows and compares them to what the report published. A
// mismatch means the report and the data disagree.
//
// It also checks the internal identities that the analysis rests on:
//   - billedInputEq = inputTokens + 0.1 * cacheReadTokens, per run;
//   - each payload row is bound to the same sessionId as its metrics row, so
//     payload cannot have been harvested from a different run;
//   - every run started with a cold plugin cache;
//   - quality totals are the sum of their four dimensions;
//   - the schema tax, prefix tax and context-gap decompositions agree with each
//     other (they were produced by three separate scripts).
//
// Usage:
//   node eval/harness/ab-v041.mjs            # verify against the published table
//   node eval/harness/ab-v041.mjs --json     # dump the recomputed table
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const DIR = join(ROOT, 'eval', 'runs', 'ab-v041-baseline')
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))

const armA = load('metrics-armA.json')
const armB = load('metrics-armB.json')
const payload = load('payload-truth.json')
const quality = load('quality-v041.json')
const manifest = load('manifest.json')
const mainTable = load('m5-main-table.json')
const feasibility = load('feasibility.json')
const floorProfile = load('floor-profile.json')
const elasticity = load('payload-elasticity.json')
const wallDecompose = load('wall-decompose.json')
const schemaTax = load('schema-tax.json')
const prefixTax = load('prefix-tax.json')
const contextMechanism = load('context-mechanism.json')
const callSeq = load('call-seq.json')

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

// --- Student's t, copied from paired-stats.mjs rather than rewritten ---------
// A hand-rolled incomplete beta is how this project produced a p-value that was
// impossible for its own t (t=1.383 -> p=0.021 at df=9). The implementation below
// is the one that was verified against known table values, and it re-verifies
// itself on every run before any statistic is trusted.
function betacf(a, b, x) {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

function gammaln(x) {
  const cof = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x)
  x -= 1
  let a = cof[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += cof[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function betai(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}

const tTwoSidedP = (t, df) => betai(df / 2, 0.5, df / (df + t * t))

{
  const known = [
    [2.262, 9, 0.05],
    [1.833, 9, 0.1],
    [3.25, 9, 0.01],
    [2.228, 10, 0.05],
    [0.5, 9, 0.6286],
  ]
  for (const [t, df, want] of known) {
    if (Math.abs(tTwoSidedP(t, df) - want) >= 0.002) {
      console.error(`p-value implementation failed its own check at t=${t} df=${df}`)
      process.exit(2)
    }
  }
}

/** Paired t-test on (b - a), matching the published `paired` rows. */
function paired(a, b) {
  const d = a.map((x, i) => b[i] - x)
  const n = d.length
  const m = mean(d)
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))
  const se = sd / Math.sqrt(n)
  const t = se === 0 ? Infinity : m / se
  return { n, a: mean(a), b: mean(b), d: m, sd, se, t, df: n - 1, p: tTwoSidedP(t, n - 1) }
}

// Pair by idea id. Rows were written in completion order, so pairing them
// positionally would compare I01 against whatever finished first.
const byId = (rows) => new Map(rows.map((r) => [r.id, r]))
const aById = byId(armA)
const bById = byId(armB)
const ids = [...aById.keys()].filter((id) => bById.has(id)).sort()
if (ids.length !== armA.length || ids.length !== armB.length) {
  console.error(`pairing failed: A=${armA.length} B=${armB.length} paired=${ids.length}`)
  process.exit(2)
}

const a = (f) => ids.map((id) => f(aById.get(id)))
const b = (f) => ids.map((id) => f(bById.get(id)))

const metrics = {
  inputTokens: paired(a((r) => r.inputTokens), b((r) => r.inputTokens)),
  outputTokens: paired(a((r) => r.outputTokens), b((r) => r.outputTokens)),
  cacheReadTokens: paired(a((r) => r.cacheReadTokens), b((r) => r.cacheReadTokens)),
  billedInputEq: paired(a((r) => r.billedInputEq), b((r) => r.billedInputEq)),
  steps: paired(a((r) => r.steps), b((r) => r.steps)),
  toolCalls: paired(a((r) => r.toolCalls), b((r) => r.toolCalls)),
  wallClockSec: paired(a((r) => r.wallClockSec), b((r) => r.wallClockSec)),
  outBytes: paired(a((r) => r.outBytes), b((r) => r.outBytes)),
}

// Payload comes from the durable session logs, not the --json projection: the
// projection clips every string at 8192 bytes, so it under-reported the previous
// batch by 202,417 bytes. Pair by (arm, id) and bind to the metrics row's
// sessionId below.
const payloadBy = (arm) => new Map(payload.arms[arm].map((r) => [r.id, r]))
const pA = payloadBy('A')
const pB = payloadBy('B')
metrics.payloadBytes = paired(
  ids.map((id) => pA.get(id)?.payloadBytes),
  ids.map((id) => pB.get(id)?.payloadBytes),
)
if (metrics.payloadBytes.a === undefined || Number.isNaN(metrics.payloadBytes.a)) {
  console.error('payload rows missing for some run ids')
  process.exit(2)
}

// Quality: two raters per output, averaged. `totals` is [rater1, rater2].
const scoreFor = (id, arm) => {
  const row = quality.rows.find((r) => r.id === id && r.arm === arm)
  return row === undefined ? undefined : mean(row.totals)
}
const qA = ids.map((id) => scoreFor(id, 'A'))
const qB = ids.map((id) => scoreFor(id, 'B'))
if ([...qA, ...qB].some((x) => x === undefined)) {
  console.error('quality rows missing for some run ids')
  process.exit(2)
}
metrics.quality = paired(qA, qB)

// Reliability is a count, not a mean: any errored run invalidates the arm.
const erroredA = armA.filter((r) => r.code !== 0 || r.outExists !== true).length
const erroredB = armB.filter((r) => r.code !== 0 || r.outExists !== true).length
const retriesA = armA.reduce((s, r) => s + (r.llmRetries ?? 0), 0)
const retriesB = armB.reduce((s, r) => s + (r.llmRetries ?? 0), 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ids, metrics, erroredA, erroredB, retriesA, retriesB }, null, 2))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Verify. Means get 0.5% (rounding); t and p get 0.01, because a t that
// disagrees at all means a different test was run.
// ---------------------------------------------------------------------------
let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    failures.push(`${label}  -> ${detail}`)
    console.log(`  FAIL  ${label}  -> ${detail}`)
  }
}
const near = (x, y, tol) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.max(tol, Math.abs(y) * tol)

// --- 1. per-run integrity ---------------------------------------------------
console.log('=== 1. per-run integrity (20 rows) ===')
check('arm A has 10 runs', armA.length === 10, String(armA.length))
check('arm B has 10 runs', armB.length === 10, String(armB.length))
check('both arms cover the same 10 idea ids', ids.length === 10, ids.join(','))
check('every run exited 0', [...armA, ...armB].every((r) => r.code === 0), 'a run failed')
check('every run produced its output file', [...armA, ...armB].every((r) => r.outExists === true), 'missing output')
check('no run exceeded the 15-call ceiling', [...armA, ...armB].every((r) => r.overBudget === false), 'a run went over budget')
check('no llm retry in either arm', retriesA === 0 && retriesB === 0, `A=${retriesA} B=${retriesB}`)

// Cold cache is the whole basis of the "cold start" claim.
check(
  'every run started with a cold plugin cache',
  [...armA, ...armB].every((r) => r.cacheBeforeRun?.remaining === 0),
  'a run reused a warm cache',
)

// billedInputEq must equal input + 0.1 * cacheRead on every row; the rows are
// integers, so allow 1 token of rounding.
const billedOff = [...armA, ...armB].filter(
  (r) => Math.abs(r.billedInputEq - (r.inputTokens + 0.1 * r.cacheReadTokens)) > 1,
)
check('billedInputEq = input + 0.1*cacheRead on all 20 rows', billedOff.length === 0, `${billedOff.length} rows off`)

const sessions = [...armA, ...armB].map((r) => r.sessionId)
check('every run recorded a sessionId', sessions.every((s) => typeof s === 'string' && s.length > 0), 'missing sessionId')
check('all 20 sessionIds are distinct', new Set(sessions).size === 20, `${new Set(sessions).size} distinct`)

// The 15-call ceiling is a real constraint on arm A, not a nominal one: the
// report's non-comparability note depends on it.
const aCalls = armA.map((r) => r.toolCalls).sort((x, y) => x - y)
check('arm A used >= 14 calls in 8 of 10 runs', aCalls.filter((c) => c >= 14).length === 8, aCalls.join(','))
check('arm A hit the ceiling exactly in 4 runs', aCalls.filter((c) => c === 15).length === 4, aCalls.join(','))

// --- 2. payload binding -----------------------------------------------------
console.log('\n=== 2. payload is bound to the run that produced it ===')
const pOff = []
for (const [arm, rows, pmap] of [
  ['A', armA, pA],
  ['B', armB, pB],
]) {
  for (const r of rows) {
    const p = pmap.get(r.id)
    if (p === undefined || p.sessionId !== r.sessionId) pOff.push(`${r.id}-arm${arm}`)
  }
}
check('each payload row shares its metrics row sessionId', pOff.length === 0, pOff.join(','))
check(
  'payload entry count matches run count in both arms',
  payload.arms.A.length === 10 && payload.arms.B.length === 10,
  `A=${payload.arms.A.length} B=${payload.arms.B.length}`,
)
check(
  'payloadBytes equals the sum of its tool results',
  [...payload.arms.A, ...payload.arms.B].every((r) => r.payloadBytes === r.toolResultBytes),
  'a row disagrees with itself',
)
// The projection is the --json view. It must be smaller than the truth on every
// run, which is why the report refuses to quote it.
check(
  'the --json projection understates every run',
  [...payload.arms.A, ...payload.arms.B].every((r) => r.projection < r.payloadBytes),
  'a projection was not smaller',
)

const bCards = payload.arms.B.flatMap((r) => r.cards)
check('arm B returned 15 cards', bCards.length === 15, String(bCards.length))
check('5 of the 15 cards were trimmed', bCards.filter((c) => c.trimmed === true).length === 5, 'trim count changed')
check('arm A returned no cards', payload.arms.A.every((r) => r.cards.length === 0), 'arm A has cards')

// --- 3. headline paired statistics vs the manifest --------------------------
console.log('\n=== 3. published paired statistics ===')
const PUB = manifest.published
for (const key of Object.keys(metrics)) {
  const got = metrics[key]
  const row = PUB[key]
  if (row === undefined) {
    check(`${key}: published row exists`, false, 'missing from manifest.json published{}')
    continue
  }
  check(`${key}: mean A`, near(got.a, row.a, 0.005), `${got.a.toFixed(2)} vs ${row.a}`)
  check(`${key}: mean B`, near(got.b, row.b, 0.005), `${got.b.toFixed(2)} vs ${row.b}`)
  check(`${key}: paired d`, near(got.d, row.d, 0.005), `${got.d.toFixed(2)} vs ${row.d}`)
  check(`${key}: paired t`, Math.abs(got.t - row.t) <= 0.01, `${got.t.toFixed(4)} vs ${row.t}`)
  check(`${key}: paired p`, Math.abs(got.p - row.p) <= 0.01, `${got.p.toFixed(5)} vs ${row.p}`)
}

// The m5-main-table.json file is the same computation written independently.
// If the two disagree, one of them has a bug -- that is the point of keeping it.
// It covers the nine metrics but not quality (that came from a separate script),
// so compare only the keys it actually publishes.
const mtByKey = new Map(mainTable.rows.map((r) => [r.key, r]))
const mtOff = Object.keys(metrics).filter((key) => {
  const mt = mtByKey.get(key)
  return mt !== undefined && Math.abs(mt.t - metrics[key].t) > 0.01
})
check('m5-main-table.json agrees with this recomputation', mtOff.length === 0, mtOff.join(','))
check(
  'm5-main-table.json covers every metric except quality',
  mainTable.rows.length === Object.keys(metrics).length - 1,
  `${mainTable.rows.length} rows vs ${Object.keys(metrics).length - 1} expected`,
)

// --- 4. quality -------------------------------------------------------------
console.log('\n=== 4. quality (two blind raters, 16-point scale) ===')
const rubric = quality.rubric
check('rubric dimensions sum to 16', rubric.dim1 + rubric.dim2 + rubric.dim3 + rubric.dim4 === rubric.total, JSON.stringify(rubric))
check('20 scored outputs', quality.rows.length === 20, String(quality.rows.length))
check(
  'every total is the sum of its four dimensions',
  quality.rows.every((r) => r.totals.every((t) => t === r.dims.dim1[0] + r.dims.dim2[0] + r.dims.dim3[0] + r.dims.dim4[0] ||
    t === r.dims.dim1[1] + r.dims.dim2[1] + r.dims.dim3[1] + r.dims.dim4[1])),
  'a total does not add up',
)
check(
  'every score is an integer inside its dimension cap',
  quality.rows.every((r) =>
    Object.entries(r.dims).every(([dim, pair]) =>
      pair.every((v) => Number.isInteger(v) && v >= 0 && v <= rubric[dim]),
    ),
  ),
  'a score is out of range',
)

// dim4 sign test: B beats A on 4 ideas, ties on 6, loses on 0.
const dim4ByIdea = ids.map((id) => {
  const ra = quality.rows.find((r) => r.id === id && r.arm === 'A')
  const rb = quality.rows.find((r) => r.id === id && r.arm === 'B')
  return mean(rb.dims.dim4) - mean(ra.dims.dim4)
})
const bWins = dim4ByIdea.filter((d) => d > 0).length
const aWins = dim4ByIdea.filter((d) => d < 0).length
const ties = dim4ByIdea.filter((d) => d === 0).length
check(
  'dim4 sign test reproduces (4 B-wins / 0 A-wins / 6 ties)',
  bWins === 4 && aWins === 0 && ties === 6,
  `${bWins}/${aWins}/${ties}`,
)
check('dim4 sign test p = 0.125', Math.abs(quality.dim4SignTest.p - 0.125) < 1e-9, String(quality.dim4SignTest.p))

// --- 5. the unreachability proof -------------------------------------------
console.log('\n=== 5. the 25,000 / 50s targets are unreachable ===')
const TARGET_BILLED = manifest.targets.billedInputEq
const TARGET_WALL_MS = manifest.targets.wallClockSec * 1000

// (a) absolute lower bound: context never grows beyond the step-1 prompt.
const floorBilled = feasibility.measured.B.steps * (feasibility.measured.B.newPerStep + 0.1 * feasibility.promptFloor.B)
check(
  `absolute lower bound (${floorBilled.toFixed(1)}) exceeds the target (${TARGET_BILLED})`,
  floorBilled > TARGET_BILLED,
  `${floorBilled.toFixed(1)} vs ${TARGET_BILLED}`,
)
check(
  'the frozen feasibility.json agrees with the recomputed lower bound',
  Math.abs(feasibility.billedLowerBound - floorBilled) < 1,
  `${feasibility.billedLowerBound} vs ${floorBilled.toFixed(2)}`,
)

// (b) structural floor: even the shortest usable tool sequence misses.
//
// Three counterfactuals were computed and only two of them are bounds:
//   linear          - scale new tokens and steps together -> a LOWER bound
//   payloadFixed    - keep every new token, shrink only residency -> the
//                     defensible middle estimate, also above the target
//   truncate        - chop the run at step 5 -> BELOW the target, but it is not
//                     an upper bound: step 5 would then carry payload that only
//                     arrived later, so it deletes tokens the work needs. It is
//                     checked as an underestimate, not as a floor.
const cf = floorProfile.counterfactuals
check(
  `structural floor band [${Math.min(cf.linear, cf.payloadFixedLower).toFixed(0)}, ${Math.max(cf.linear, cf.payloadFixedLower).toFixed(0)}] lies above the target`,
  cf.linear > TARGET_BILLED && cf.payloadFixedLower > TARGET_BILLED,
  JSON.stringify(cf),
)
check(
  'the truncated counterfactual is an underestimate, not a floor (it falls below the linear bound)',
  cf.truncate < cf.linear,
  `truncate=${cf.truncate.toFixed(1)} linear=${cf.linear.toFixed(1)}`,
)
check(
  'the truncate counterfactual is the only one that misses the target, and it is excluded',
  cf.truncate < TARGET_BILLED && cf.linear > TARGET_BILLED && cf.payloadFixedLower > TARGET_BILLED,
  `truncate=${cf.truncate.toFixed(1)} target=${TARGET_BILLED}`,
)

// (c) elasticity: even an inspect_projects that returns nothing misses.
const inspectEmpty = elasticity.scenarios.find((s) => s.label.includes('inspect_projects returns nothing'))
check(
  'even an empty inspect_projects misses the target',
  inspectEmpty !== undefined && inspectEmpty.billed > TARGET_BILLED,
  inspectEmpty === undefined ? 'scenario missing' : inspectEmpty.billed.toFixed(1),
)

// (d) wall clock: model time alone, with all tool latency set to zero.
const wallFloor = wallDecompose.perArm.B.steps * wallDecompose.perArm.B.modelMs
check(
  `model time alone (${wallFloor.toFixed(0)}ms) exceeds the 50s target with zero tool latency`,
  wallFloor > TARGET_WALL_MS,
  `${wallFloor.toFixed(0)} vs ${TARGET_WALL_MS}`,
)
check(
  'arm B never came in under 50s',
  armB.every((r) => r.wallClockSec * 1000 > TARGET_WALL_MS),
  `min ${Math.min(...armB.map((r) => r.wallClockSec))}s`,
)

// --- 6. cross-checks between the independently-written analyses -------------
console.log('\n=== 6. the three analyses agree with each other ===')

// schema-tax: the plugin's four tools serialized alone vs the full tool array.
const hA = schemaTax.headerByArm.A
const hB = schemaTax.headerByArm.B
check('arm B carries exactly 4 more tools than arm A', hB.n - hA.n === 4, `${hA.n} -> ${hB.n}`)
check('the 4 extra tools are the plugin tools', hB.pluginCount === 4 && hA.pluginCount === 0, `${hA.pluginCount}/${hB.pluginCount}`)
// The plugin array serializes with its own 2 brackets and 3 commas; inside the
// full array the brackets are already counted on both sides, leaving 4 commas.
check(
  'full-array delta equals the plugin schema minus its array brackets',
  hB.total - hA.total === schemaTax.taxBytes - 1,
  `${hB.total - hA.total} vs ${schemaTax.taxBytes - 1}`,
)

// prefix-tax: the schema tax in tokens, measured from step-1 prompts.
const taxTokens = prefixTax.meanPrompt.B - prefixTax.meanPrompt.A
check(
  'prefix tax in tokens equals B minus A step-1 prompt',
  Math.abs(prefixTax.taxTokens - taxTokens) < 0.5,
  `${prefixTax.taxTokens} vs ${taxTokens.toFixed(1)}`,
)
check(
  'bytes per token is the schema bytes over the measured token delta',
  Math.abs(prefixTax.bytesPerToken - schemaTax.taxBytes / taxTokens) < 0.01,
  `${prefixTax.bytesPerToken.toFixed(4)} vs ${(schemaTax.taxBytes / taxTokens).toFixed(4)}`,
)
check(
  'the tax costs stepsB * 0.1 * taxTokens billed-eq per run',
  Math.abs(prefixTax.billedPerRun - feasibility.measured.B.steps * 0.1 * taxTokens) < 1,
  `${prefixTax.billedPerRun.toFixed(1)}`,
)

// context-mechanism: the gap splits into a fixed prompt part and an accumulated part.
const ctxGap = contextMechanism.ctxPerStep.B - contextMechanism.ctxPerStep.A
check(
  'context gap equals its two components',
  Math.abs(contextMechanism.gap.prompt + contextMechanism.gap.accumulated - ctxGap) < 0.5 &&
    Math.abs(contextMechanism.gap.total - ctxGap) < 0.5,
  JSON.stringify(contextMechanism.gap),
)

// The central mechanism claim: payload barely explains resident context.
check(
  'payload explains almost none of the resident context (R2 < 0.05)',
  elasticity.fit.ctxPerStep.r2 < 0.05,
  String(elasticity.fit.ctxPerStep.r2),
)
check(
  'payload explains most of the per-step new tokens (R2 > 0.8)',
  elasticity.fit.newPerStep.r2 > 0.8,
  String(elasticity.fit.newPerStep.r2),
)

// --- 7. behavioural evidence for M4 ----------------------------------------
console.log('\n=== 7. M4 recovery paths were actually used ===')
const seqCalls = new Map(callSeq.runs.map((r) => [`${r.id}-arm${r.arm}`, r.calls]))
const seqOff = [...armA, ...armB].filter((r) => seqCalls.get(`${r.id}-arm${r.arm}`) !== r.toolCalls)
check('call-seq.json reproduces every run\'s tool-call count', seqOff.length === 0, `${seqOff.length} rows off`)

const trimmedRuns = callSeq.runs.filter((r) => r.arm === 'B' && r.sequence.some((s) => s.trimmed === true))
check('5 arm-B runs saw a trimmed card', trimmedRuns.length === 5, String(trimmedRuns.length))
// After M4 deleted the "call again with a bigger budget" path, recovery can only
// be point reads or fewer repos. Neither may be a second inspect on the same
// repo set with a larger budget.
const repairedByBiggerBudget = callSeq.runs.filter(
  (r) => r.arm === 'B' && r.sequence.filter((s) => s.name === 'inspect_projects').length > 1 && r.sequence.some((s) => s.trimmed === true),
)
check(
  'no run repaired a trimmed card by re-calling inspect_projects',
  repairedByBiggerBudget.length === 0,
  repairedByBiggerBudget.map((r) => r.id).join(','),
)
const usedPointReads = trimmedRuns.filter((r) => r.sequence.some((s) => s.name === 'read_repo_files'))
const acceptedTrim = trimmedRuns.filter((r) => !r.sequence.some((s) => s.name === 'read_repo_files'))
check(
  'every trimmed run either point-read or accepted the trim',
  usedPointReads.length + acceptedTrim.length === trimmedRuns.length,
  `${usedPointReads.length}+${acceptedTrim.length} != ${trimmedRuns.length}`,
)
check('at least one trimmed run used read_repo_files to recover', usedPointReads.length >= 1, String(usedPointReads.length))

// --- summary ---------------------------------------------------------------
console.log(`\n  ${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('\nrecomputed table:')
  for (const [key, got] of Object.entries(metrics)) {
    console.log(
      `  ${key.padEnd(16)} A=${got.a.toFixed(1).padStart(9)} B=${got.b.toFixed(1).padStart(9)}` +
        ` d=${got.d.toFixed(1).padStart(8)} t=${got.t.toFixed(3).padStart(7)} p=${got.p.toFixed(4).padStart(7)}`,
    )
  }
  console.log('\nfailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n  result: the report\'s numbers are derivable from the frozen rows,')
console.log('          and the two targets are unreachable by arithmetic, not by opinion')
