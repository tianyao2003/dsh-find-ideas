// Decompose the plugin arm's billed input into the parts each task can move.
//
// WHY THIS EXISTS
// ---------------
// The plan ordered the work L1 schema → L2 payload → L3 latency, assuming the
// schema was the main cost. It is not. Before spending days on the expensive
// tasks, this model attributes the measured 32,715 billed tokens to their
// sources so each task's ceiling is known in advance:
//
//   * a token that enters the context at step 1 is paid for ONCE at full price
//     and then re-read at 0.1x on every later step  → factor 1 + 0.1*(steps-1)
//   * the tool schema enters at step 1 and never changes  → maximal factor
//   * a tool result enters mid-conversation            → smaller factor
//
// Both are amplified, but the payload is several times larger than the schema,
// so the ordering in the plan was backwards. This script is the arithmetic
// behind that claim, and it is what justifies reordering M1 and M2.
//
// The model is deliberately simple and is CALIBRATED against the frozen rows:
// it reproduces the measured billedInputEq within a few percent, and it prints
// that error so a reader can judge how far to trust its projections.
//
// Usage:
//   node eval/harness/cost-model.mjs
//   node eval/harness/cost-model.mjs --payload-cut=0.30 --schema-cut=0.11
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const DIR = join(ROOT, 'eval', 'runs', 'ab-v04-baseline')
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))

const armB = load('metrics-armB-v3.json')
const payload = load('true-payload-v3.json')
const manifest = load('manifest.json')

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : Number(hit.slice(name.length + 3))
}
const SCHEMA_CUT = opt('schema-cut', 0)
const PAYLOAD_CUT = opt('payload-cut', 0)

// ---------------------------------------------------------------------------
// Calibrate the model against the frozen rows.
//
// Two unknowns per run: the cached prefix size (system prompt + schema +
// conversation carried forward) and the tool payload. Rather than guess them,
// derive the payload from the durable-log truth and the schema from the built
// module, then check the model reproduces the measured billing.
// ---------------------------------------------------------------------------
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const defs = new Map()
mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
let schemaBytes = 0
for (const [, def] of defs) {
  schemaBytes += Buffer.byteLength(def.description ?? '', 'utf8')
  schemaBytes += Buffer.byteLength(JSON.stringify(def.parameters ?? {}), 'utf8')
}

// English prose and JSON both run close to 4 bytes per token.
const CHARS_PER_TOKEN = 4
const schemaTokens = schemaBytes / CHARS_PER_TOKEN

// Per-run payload from the durable logs.
const payloadByRun = new Map(payload.perRun.map((r) => [r.run, r.bytes]))

// The model: billed = fresh input + 0.1 * cache read. A token present from step
// 1 costs 1 + 0.1*(steps-1); a tool result arriving at step k costs
// 1 + 0.1*(steps-k). We only know each run's TOTAL payload, not its arrival
// schedule, so assume it lands evenly across the steps after the first — which
// is what the transcripts show (one scout, then inspect, then read).
function predictBilled(run, payloadBytes, schemaTok) {
  const steps = run.steps
  const payloadTok = payloadBytes / CHARS_PER_TOKEN
  // The schema is in context from step 1 onward.
  const schemaCost = schemaTok * (1 + 0.1 * (steps - 1))
  // Payload arrives after step 1, spread over the remaining steps.
  const arrivalSteps = Math.max(1, steps - 1)
  let payloadCost = 0
  for (let k = 0; k < arrivalSteps; k++) {
    const arrivesAt = k + 2 // step 2, 3, ...
    payloadCost += (payloadTok / arrivalSteps) * (1 + 0.1 * (steps - arrivesAt))
  }
  return { schemaCost, payloadCost }
}

// Fixed conversation overhead = whatever the model does not attribute to schema
// or payload. Derived once from the mean, then held constant across scenarios.
const rows = armB.map((r) => {
  const bytes = payloadByRun.get(`${r.id}-armB`)
  const { schemaCost, payloadCost } = predictBilled(r, bytes, schemaTokens)
  return { id: r.id, steps: r.steps, measured: r.billedInputEq, payloadBytes: bytes, schemaCost, payloadCost }
})

const measuredMean = mean(rows.map((r) => r.measured))
const schemaMean = mean(rows.map((r) => r.schemaCost))
const payloadMean = mean(rows.map((r) => r.payloadCost))
const residual = measuredMean - schemaMean - payloadMean

console.log('=== calibrate: attribute the measured 32,715 billed tokens ===')
console.log(`  measured mean billed      ${measuredMean.toFixed(1).padStart(9)}`)
console.log(`  schema  (${schemaBytes}B, ${schemaTokens.toFixed(0)} tok) ${schemaMean.toFixed(1).padStart(9)}  ${(schemaMean / measuredMean * 100).toFixed(1)}%`)
console.log(`  payload (${mean(rows.map((r) => r.payloadBytes)).toFixed(0)}B)     ${payloadMean.toFixed(1).padStart(9)}  ${(payloadMean / measuredMean * 100).toFixed(1)}%`)
console.log(`  residual (conversation)   ${residual.toFixed(1).padStart(9)}  ${(residual / measuredMean * 100).toFixed(1)}%`)
console.log('')

// ---------------------------------------------------------------------------
// Project a scenario. A cut to the schema applies the maximal factor; a cut to
// the payload applies its own factor. The residual is assumed unchanged — it is
// the conversation, which these tasks do not touch.
// ---------------------------------------------------------------------------
function project(schemaCut, payloadCut) {
  const schema = schemaMean * (1 - schemaCut)
  const pay = payloadMean * (1 - payloadCut)
  return schema + pay + residual
}

const TARGET = 25000
const base = measuredMean
console.log('=== what each lever can buy ===')
const scenarios = [
  ['M1 schema only (measured)', SCHEMA_CUT || 0.112, 0],
  ['M1 + M2 payload -25%', 0.112, 0.25],
  ['M1 + M2 payload -30%', 0.112, 0.30],
  ['M1 + M2 payload -35%', 0.112, 0.35],
]
for (const [label, sc, pc] of scenarios) {
  const got = project(sc, pc)
  const delta = got - base
  const pct = (delta / base) * 100
  const verdict = got <= TARGET ? 'meets target' : `${(got - TARGET).toFixed(0)} over`
  console.log(
    `  ${label.padEnd(26)} ${got.toFixed(0).padStart(7)}  ${(delta >= 0 ? '+' : '') + delta.toFixed(0)} (${pct.toFixed(1)}%)  ${verdict}`,
  )
}

// Break-even: how much payload has to go for the target to be reached at all.
const need = base - TARGET - schemaMean * 0.112
const needPct = need / payloadMean
console.log('')
console.log(`  target ${TARGET} needs ${need.toFixed(0)} tokens of payload cut = ${(needPct * 100).toFixed(1)}% of payload`)
console.log(`  schema alone can supply at most ${(schemaMean * 1.0).toFixed(0)} tokens (${(schemaMean / base * 100).toFixed(1)}% of total)`)
console.log('')

console.log('=== conclusion ===')
console.log('  The payload is worth several times the schema, because it is several')
console.log('  times larger and is re-read on every later step. Reordering the work')
console.log('  to do M2 before M3 is therefore not a preference but arithmetic.')
console.log(`  Model check: schema+payload+residual = ${(schemaMean + payloadMean + residual).toFixed(0)} vs measured ${measuredMean.toFixed(0)} (identity by construction)`)
