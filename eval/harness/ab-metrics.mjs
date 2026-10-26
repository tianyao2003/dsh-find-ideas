// Reproduce the headline numbers of the v0.4.0 A/B run from frozen inputs.
//
// WHY THIS EXISTS
// ---------------
// The v0.4.0 report quotes: billed-input-equivalent, tool calls, payload bytes,
// quality score, and error count. Every later task in the v0.4.1 cost work is
// judged as a delta against those numbers, so they have to be recomputable by
// anyone from checked-in data — otherwise "we improved billed input by 24%" is a
// claim about a spreadsheet nobody can open.
//
// Wall clock used to be the sixth metric here and has been removed: the frozen
// `wallClockSec` column was not measured on these runs (see the comment above
// `metrics` below, and eval/runs/ab-v04-baseline/wall-clock-correction.json).
// Its replacement gate is eval/harness/ab-wall-clock.mjs. Removing it makes this
// script verify five metrics instead of six — that is the honest count, not a
// regression.
//
// The inputs are frozen copies of the run's own outputs:
//   eval/runs/ab-v04-baseline/metrics-armA-v3.json   per-run usage, arm A
//   eval/runs/ab-v04-baseline/metrics-armB-v3.json   per-run usage, arm B
//   eval/runs/ab-v04-baseline/quality-v3.json        two raters x 20 outputs
//   eval/runs/ab-v04-baseline/true-payload-v3.json   true payload bytes per call
//   eval/runs/ab-v04-baseline/final-v3-corrected.json the published paired stats
//
// This script does NOT re-run the experiment. It re-derives the same statistics
// from the per-run rows and compares them to the published ones. A mismatch
// means the published number and the data disagree, which is exactly the failure
// mode that produced two wrong claims earlier in this project (a `-28%` that was
// searched for as `28%` and missed, and a payload metric that had been measuring
// the 8192-byte projection clip).
//
// Usage:
//   node eval/harness/ab-metrics.mjs            # verify against published stats
//   node eval/harness/ab-metrics.mjs --json     # dump the recomputed table
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const DIR = join(ROOT, 'eval', 'runs', 'ab-v04-baseline')
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))

const armA = load('metrics-armA-v3.json')
const armB = load('metrics-armB-v3.json')
const quality = load('quality-v3.json')
const payload = load('true-payload-v3.json')
const published = load('final-v3-corrected.json')

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

/** Paired t-test on (b - a), matching the published `paired` rows. */
function paired(a, b) {
  const d = a.map((x, i) => b[i] - x)
  const n = d.length
  const m = mean(d)
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))
  const se = sd / Math.sqrt(n)
  return { n, a: mean(a), b: mean(b), d: m, sd, se, t: se === 0 ? Infinity : m / se }
}

// Pair by idea id. The runner wrote rows in completion order, so the arrays are
// not guaranteed to line up index-for-index — pairing them positionally would
// compare I01 against whatever finished first.
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

// The headline metrics. `billedInputEq` is input + 0.1 * cacheRead, which is the
// provider's own billing model: a cache hit is charged a tenth of a fresh input
// token.
//
// Wall clock is deliberately NOT here. The `wallClockSec` column in
// metrics-arm{A,B}-v3.json was never measured on these runs -- it was carried
// over from an earlier batch by aggregate.mjs, which harvests wall clock from
// runner logs because wall clock is not in the event stream. Pairing it here
// made this script self-consistently verify a number that was never true. The
// retraction, its evidence, and the corrected +3.00s/+4.5% (p=0.684) live in
// wall-clock-correction.json and are checked by eval/harness/ab-wall-clock.mjs.
const metrics = {
  billedInputEq: paired(a((r) => r.billedInputEq), b((r) => r.billedInputEq)),
  toolCalls: paired(a((r) => r.toolCalls), b((r) => r.toolCalls)),
  inputTokens: paired(a((r) => r.inputTokens), b((r) => r.inputTokens)),
  cacheReadTokens: paired(a((r) => r.cacheReadTokens), b((r) => r.cacheReadTokens)),
  steps: paired(a((r) => r.steps), b((r) => r.steps)),
}

// Payload bytes come from the durable session logs, not the projected event
// stream: the projection clips every string at 8192 bytes, and 20 of the 22
// cards in this run exceeded that, so the projected total understated the true
// payload by 202,417 bytes.
const payloadByRun = new Map(payload.perRun.map((r) => [r.run, r.bytes]))
const payloadA = ids.map((id) => payloadByRun.get(`${id}-armA`))
const payloadB = ids.map((id) => payloadByRun.get(`${id}-armB`))
if ([...payloadA, ...payloadB].some((x) => x === undefined)) {
  console.error('payload rows missing for some run ids')
  process.exit(2)
}
metrics.payloadBytes = paired(payloadA, payloadB)

// Quality: two raters per output, averaged. The published table reports the
// mean total per arm over the 20 paired outputs (10 ideas x 2 arms).
const scoreFor = (id, arm) => {
  const row = quality.rows.find((r) => r.id === id && r.arm === arm)
  if (row === undefined) return undefined
  const totals = quality.raters.map((rater) => row[rater].total)
  return mean(totals)
}
const qA = ids.map((id) => scoreFor(id, 'A'))
const qB = ids.map((id) => scoreFor(id, 'B'))
if ([...qA, ...qB].some((x) => x === undefined)) {
  console.error('quality rows missing for some run ids')
  process.exit(2)
}
metrics.quality = paired(qA, qB)

// Reliability is a count, not a mean: any errored run invalidates the arm.
const erroredA = armA.filter((r) => r.errored === true).length
const erroredB = armB.filter((r) => r.errored === true).length
const retriesA = armA.reduce((s, r) => s + (r.llmRetries ?? 0), 0)
const retriesB = armB.reduce((s, r) => s + (r.llmRetries ?? 0), 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ids, metrics, erroredA, erroredB, retriesA, retriesB }, null, 2))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Verify against the published table. The tolerance is deliberately loose for
// means (0.5%) and tight for p-values (0.01), because a mean that disagrees by
// 0.5% is rounding while a p-value that disagrees at all means a different test
// was run.
// ---------------------------------------------------------------------------
const PUBLISHED = new Map(published.paired.map((row) => [row.metric, row]))
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

console.log('=== reproduce the six headline numbers ===')
console.log(`  paired runs: ${ids.length}`)

const near = (x, y, tol) => Math.abs(x - y) <= Math.max(tol, Math.abs(y) * tol)

// The published file names its metrics in Chinese; map them here rather than
// re-keying the frozen data, so the check is against the report as published.
const CN = {
  billedInputEq: '计费输入当量',
  toolCalls: '工具调用次数',
  inputTokens: '输入 token',
  cacheReadTokens: '缓存读取 token',
  steps: '步数',
  payloadBytes: '工具结果载荷字节',
  quality: '质量总分（满分 16）',
}

for (const [key, got] of Object.entries(metrics)) {
  const row = PUBLISHED.get(CN[key])
  if (row === undefined) {
    check(`${key}: published row exists`, false, `no "${CN[key]}" in final-v3-corrected.json`)
    continue
  }
  check(`${key}: mean A`, near(got.a, row.a, 0.005), `${got.a.toFixed(2)} vs ${row.a}`)
  check(`${key}: mean B`, near(got.b, row.b, 0.005), `${got.b.toFixed(2)} vs ${row.b}`)
  check(`${key}: paired p`, Math.abs(got.t - row.t) <= 0.01, `t ${got.t.toFixed(4)} vs ${row.t}`)
}

check('arm A: no errored run', erroredA === 0, String(erroredA))
check('arm B: no errored run', erroredB === 0, String(erroredB))
check('arm A: no llm retry', retriesA === 0, String(retriesA))
check('arm B: no llm retry', retriesB === 0, String(retriesB))

console.log(`\n  ${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('\nrecomputed table:')
  for (const [key, got] of Object.entries(metrics)) {
    console.log(
      `  ${key.padEnd(16)} A=${got.a.toFixed(1).padStart(9)} B=${got.b.toFixed(1).padStart(9)}` +
        ` d=${got.d.toFixed(1).padStart(8)} t=${got.t.toFixed(3).padStart(7)}`,
    )
  }
  process.exit(1)
}
console.log('\n  result: the published numbers are derivable from the frozen rows')
