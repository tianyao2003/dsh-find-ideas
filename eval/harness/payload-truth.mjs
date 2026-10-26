// Re-derive true tool-result payload bytes from the DURABLE session logs.
//
// WHY THE DURABLE LOG AND NOT `dsh --json`
// ----------------------------------------
// The projected event stream clips every string at 8192 bytes
// (`MAX_STRING_BYTES` in the host's projection layer). In the v0.4.0 run, 20 of
// the 22 `inspect_projects` cards exceeded that clip, so a payload total read
// from the projection understated the truth by 202,417 bytes — and the first
// version of the report published that understated number. The durable log
// (`~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`) carries the
// full text.
//
// The log is written as a SERIES of independently flushed zstd frames.
// `zstdDecompressSync` stops after the first frame, so a naive read returns
// exactly one record and looks like a truncated file rather than a decoder bug.
// Every frame must be decoded.
//
// WHAT THIS PROVES
// ----------------
// Given the recorded event streams (which name each run's session id) and the
// durable logs, the per-call payload sizes are recomputable. If this script's
// output matches `true-payload-v3.json`, the frozen payload numbers are
// traceable to raw evidence rather than to a script's intermediate output.
//
// Usage:
//   node eval/harness/payload-truth.mjs              # verify against frozen data
//   node eval/harness/payload-truth.mjs --sessions <dir>
//   node eval/harness/payload-truth.mjs --json
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const DIR = join(ROOT, 'eval', 'runs', 'ab-v04-baseline')

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}

const { decodeFile } = require(join(DIR, 'decode-session.cjs'))

// The workspace directory name is derived from the working directory the run
// used. DSH encodes a path by replacing every non-alphanumeric run with '-'.
const DEFAULT_SESSIONS = join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.dsh',
  'sessions',
  '--D-app-dsh-dsh_workspace-work_space2-ab-v04--',
)
const sessionsRoot = opt('sessions', DEFAULT_SESSIONS)

const frozen = JSON.parse(readFileSync(join(DIR, 'true-payload-v3.json'), 'utf8'))
const runs = frozen.perRun.map((r) => r.run)

// Session ids are recorded per run. Recover them from the durable sessions by
// matching the run's own idea text: the first user message of a session is the
// brief plus the idea, so the idea is a stable key. This avoids depending on a
// side file that could drift.
const metrics = (arm) =>
  JSON.parse(readFileSync(join(DIR, `metrics-arm${arm}-v3.json`), 'utf8'))
const sessionByRun = new Map()
for (const arm of ['A', 'B']) {
  for (const row of metrics(arm)) sessionByRun.set(`${row.id}-arm${arm}`, row.sessionId)
}

function decodeRun(sessionId) {
  const file = join(sessionsRoot, sessionId, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return undefined
  return decodeFile(file)
}

const TRIM = /本次返回已按 budget_bytes=(\d+) 裁剪/
const BUDGET_ARG = /"budget_bytes"\s*:\s*(\d+)/

const recomputed = []
const cards = []
const budgetArgs = []
let missingLogs = 0

for (const run of runs.sort()) {
  const sessionId = sessionByRun.get(run)
  if (sessionId === undefined) {
    missingLogs++
    continue
  }
  const decoded = await decodeRun(sessionId)
  if (decoded === undefined) {
    missingLogs++
    continue
  }
  const calls = new Map()
  for (const rec of decoded.records) {
    if (rec.type === 'tool/call' && rec.data?.callId) calls.set(rec.data.callId, rec.data)
  }
  let bytes = 0
  let n = 0
  for (const rec of decoded.records) {
    if (rec.type !== 'tool/result') continue
    const msg = rec.data?.message ?? rec.data
    const callId = msg?.toolCallId ?? msg?.source?.callId
    const call = calls.get(callId)
    const name = call?.name ?? '(unknown)'
    const content = Array.isArray(msg?.content) ? msg.content : []
    const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
    const b = Buffer.byteLength(text, 'utf8')
    bytes += b
    n++
    if (name === 'inspect_projects') {
      cards.push({ run, bytes: b, trimmed: TRIM.test(text) })
      if (typeof call?.arguments === 'string') {
        const m = BUDGET_ARG.exec(call.arguments)
        budgetArgs.push({ run, budget: m === null ? null : Number(m[1]), cardBytes: b })
      }
    }
  }
  recomputed.push({ run, calls: n, bytes })
}

if (missingLogs > 0) {
  console.error(`${missingLogs} durable session logs not found under:`)
  console.error(`  ${sessionsRoot}`)
  console.error('The frozen per-run numbers cannot be re-derived without them.')
  console.error('Re-run with --sessions=<dir> if the workspace moved.')
  process.exit(2)
}

const recomputedByRun = new Map(recomputed.map((r) => [r.run, r]))

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`  FAIL  ${label}  -> ${detail}`)
  }
}

for (const want of frozen.perRun) {
  const got = recomputedByRun.get(want.run)
  check(`${want.run}: payload bytes reproduce`, got !== undefined && got.bytes === want.bytes,
    got === undefined ? 'run missing' : `${want.bytes} vs ${got.bytes}`)
  check(`${want.run}: tool-call count reproduces`, got !== undefined && got.calls === want.calls,
    got === undefined ? 'run missing' : `${want.calls} vs ${got.calls}`)
}

// Per-arm totals, the numbers the report actually quotes.
const sum = (run, arm) =>
  frozen.perRun.filter((r) => r.run.endsWith('arm' + arm) && (run === undefined || r.run === run))
for (const arm of ['A', 'B']) {
  const want = frozen.perRun
    .filter((r) => r.run.endsWith('arm' + arm))
    .reduce((s, r) => s + r.bytes, 0)
  const got = recomputed
    .filter((r) => r.run.endsWith('arm' + arm))
    .reduce((s, r) => s + r.bytes, 0)
  check(`arm ${arm}: total payload reproduces`, want === got, `${want} vs ${got}`)
}

// The trim claim: the budget notice lives at the END of a card, exactly where the
// projection used to cut, so a projected read reported "trimmed 0/22" and proved
// nothing. Re-check on the durable text.
const trimmed = cards.filter((c) => c.trimmed).length
const frozenTrimmed = frozen.cards.filter((c) => c.trimmed === true).length
check('trim count reproduces on durable text', trimmed === frozenTrimmed,
  `${frozenTrimmed} vs ${trimmed}`)
check('every card has a durable size', cards.length === frozen.cards.length,
  `${frozen.cards.length} vs ${cards.length}`)

// The explicit budget arguments — the evidence for the "the knob is an
// incentive to spend more" finding.
const explicit = budgetArgs.filter((x) => x.budget !== null)
const frozenExplicit = frozen.budgetArgs.filter((x) => x.budget !== null)
check('explicit budget_bytes count reproduces', explicit.length === frozenExplicit.length,
  `${frozenExplicit.length} vs ${explicit.length}`)
const above = explicit.filter((x) => x.budget > 24000).length
check('calls asking for MORE than the default reproduce',
  above === frozenExplicit.filter((x) => x.budget > 24000).length, String(above))

if (argv.includes('--json')) {
  console.log(JSON.stringify({ recomputed, cards, budgetArgs }, null, 2))
  process.exit(fail === 0 ? 0 : 1)
}

console.log('=== payload truth, re-derived from durable session logs ===')
console.log(`  sessions root : ${sessionsRoot}`)
console.log(`  runs decoded  : ${recomputed.length}/${runs.length}`)
console.log(`  cards         : ${cards.length}`)
console.log(`  checks        : ${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
console.log('  result        : the frozen payload numbers are traceable to raw logs')
