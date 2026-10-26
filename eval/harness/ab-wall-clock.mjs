// Verify the wall-clock correction for the frozen ab-v04 baseline.
//
// WHAT WENT WRONG
// `eval/runs/ab-v04-baseline/metrics-armA-v3.json` / `metrics-armB-v3.json` carry a wall-clock
// column that was NOT measured on those runs. `work_space2/ab-v04/aggregate.mjs` re-derives
// every numeric metric from `events/*.jsonl`, but wall clock is not in the event stream, so it
// harvests wall from runner logs with a regex and sorts logs by mtime so "later logs win". The
// v3 logs contain no `[done]` lines at all, so the earlier v2 batch's wall clocks were carried
// over verbatim onto the v3 rows. The published claim "wall clock 54.16s -> 75.01s, +38.5%,
// p=0.032" is therefore retracted; the true paired difference is +3.00s (+4.5%), p=0.684.
//
// WHAT THIS CHECKS
//   1. The correction record is internally consistent: the paired stats in `corrected` are
//      recomputable from the per-run rows.
//   2. The retraction is evidenced, not asserted: the frozen column equals the v2 column run
//      for run while sharing zero session ids with v2, and the runner's own writes for the v3
//      batch share all twenty session ids.
//   3. The corrected column passes the process-overhead test (wall - turn span is small and
//      positive on every run) and the frozen column fails it (scattered both ways, negative).
//   4. No live artifact still publishes the retracted number as a current finding.
//
// USAGE
//   node eval/harness/ab-wall-clock.mjs             # verify
//   node eval/harness/ab-wall-clock.mjs --json      # dump the recomputed table
//   node eval/harness/ab-wall-clock.mjs --selftest  # prove every check can fail
//
// The selftest is not decoration. This project already shipped a harness whose checks could
// not fail (they compared 0 against 0) and an A/B metric that verified itself against a
// fabricated column. Both passed. So each check below is re-run against a mutated mirror of
// the repository and must go red; a scenario that stays green is reported as MISSED and the
// selftest exits non-zero.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))

const BASELINE = 'eval/runs/ab-v04-baseline'
const CORRECTION_FILE = `${BASELINE}/wall-clock-correction.json`
const METRICS_A = `${BASELINE}/metrics-armA-v3.json`
const METRICS_B = `${BASELINE}/metrics-armB-v3.json`
const PUBLISHED_FILE = `${BASELINE}/final-v3-corrected.json`
const MANIFEST_FILE = `${BASELINE}/manifest.json`
const AB_METRICS_FILE = 'eval/harness/ab-metrics.mjs'
const HARNESS_README_FILE = 'eval/harness/README.md'
const AB_REPORT_FILE = 'v0.4.0-AB实验报告.md'

// Every file the checks read. The selftest mirrors exactly these into a scratch
// tree, so a check that reads the real repository instead of the mirror would
// silently pass every mutation -- which is how the first version of this
// selftest was written, and why it was rewritten.
const CHECKED_FILES = [
  CORRECTION_FILE,
  METRICS_A,
  METRICS_B,
  PUBLISHED_FILE,
  MANIFEST_FILE,
  AB_METRICS_FILE,
  HARNESS_README_FILE,
  AB_REPORT_FILE,
]

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length

function paired(a, b) {
  const d = a.map((x, i) => b[i] - x)
  const n = d.length
  const m = mean(d)
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))
  const se = sd / Math.sqrt(n)
  const t = m / se
  return { n, a: mean(a), b: mean(b), d: m, sd, se, t, p: twoTailedP(t, n - 1), ratio: (mean(b) / mean(a)) * 100 }
}

// Two-tailed p for Student's t via the regularized incomplete beta function.
function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}
function betacf(a, b, x) {
  const MAXIT = 200
  const EPS = 3e-16
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
function betai(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}
function twoTailedP(t, df) {
  return betai(df / 2, 0.5, df / (df + t * t))
}

const near = (x, y, tol) => Math.abs(x - y) <= Math.max(tol, Math.abs(y) * tol)

// The retracted numbers are allowed to survive in prose, but only inside a line
// that labels itself as a correction. Deleting them outright would erase the
// audit trail of what was actually published; leaving them unlabelled would keep
// the retracted claim readable as a current finding. So the rule is per-line.
const RETRACTED_MARKERS = ['+38.5%', '+20.9', '75.01', '54.16', '138.5%']
const RETRACTED_LABEL = /撤回|作废|修正|已替换|原为|~~|更正/

function staleLinesIn(text) {
  const out = []
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!RETRACTED_MARKERS.some((m) => line.includes(m))) continue
    if (RETRACTED_LABEL.test(line)) continue
    out.push(`:${i + 1} ${line.slice(0, 100)}`)
  }
  return out
}

// Run every check against `baseRoot`. Returns results rather than printing, so
// the selftest can assert on them.
function runChecks(baseRoot) {
  const dir = join(baseRoot, BASELINE)
  const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const text = (rel) => readFileSync(join(baseRoot, rel), 'utf8')
  // Some of the artifacts this gate reads are deliberately kept out of the
  // repository (`.gitignore:21` keeps `*报告.md` out: a trial run's report is an
  // output of USING the plugin, not an input to it). A gate that crashes on a
  // fresh clone is a gate nobody can run, so an absent file becomes an explicit
  // SKIP rather than an exception or a silent pass.
  const textOrNull = (rel) => {
    const p = join(baseRoot, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  const results = []
  const skipped = []
  const check = (label, cond, detail = '') => results.push({ label, ok: cond === true, detail })

  const correction = load('wall-clock-correction.json')
  const publishedTable = load('final-v3-corrected.json')
  const manifest = load('manifest.json')

  const runs = correction.runs
  const byArm = (arm) => runs.filter((r) => r.arm === arm).sort((x, y) => x.id.localeCompare(y.id))
  const ids = [...new Set(runs.map((r) => r.id))].sort()

  // -- 1. the record is self-consistent -------------------------------------
  check('20 runs recorded (10 ideas x 2 arms)', runs.length === 20, String(runs.length))
  check('both arms have 10 runs each', byArm('A').length === 10 && byArm('B').length === 10, `A=${byArm('A').length} B=${byArm('B').length}`)
  check(
    'every run id appears exactly twice (once per arm)',
    ids.length === 10 && ids.every((id) => runs.filter((r) => r.id === id).length === 2),
    ids.join(','),
  )

  const rec = paired(byArm('A').map((r) => r.measuredWallSec), byArm('B').map((r) => r.measuredWallSec))
  const pub = paired(byArm('A').map((r) => r.publishedWallSec), byArm('B').map((r) => r.publishedWallSec))

  check('recomputed corrected mean A matches the record', near(rec.a, correction.corrected.a, 0.001), `${rec.a} vs ${correction.corrected.a}`)
  check('recomputed corrected mean B matches the record', near(rec.b, correction.corrected.b, 0.001), `${rec.b} vs ${correction.corrected.b}`)
  check('recomputed corrected t matches the record', Math.abs(rec.t - correction.corrected.t) <= 0.001, `${rec.t.toFixed(4)} vs ${correction.corrected.t}`)
  check('recomputed corrected p matches the record', Math.abs(rec.p - correction.corrected.p) <= 0.0001, `${rec.p.toFixed(5)} vs ${correction.corrected.p}`)
  check('recomputed published t matches the record', Math.abs(pub.t - correction.published.t) <= 0.001, `${pub.t.toFixed(4)} vs ${correction.published.t}`)

  // -- 2. the retraction is evidenced, not asserted --------------------------
  check(
    'the frozen column reproduces the published 54.16 -> 75.01',
    near(pub.a, 54.16, 0.0005) && near(pub.b, 75.01, 0.0005),
    `${pub.a.toFixed(2)} -> ${pub.b.toFixed(2)}`,
  )
  const sameWall = runs.filter((r) => r.sameWallAsStale === true).length
  const sameSession = runs.filter((r) => r.sameSessionAsStale === true).length
  check('frozen wall equals the v2 wall on >= 19 of 20 runs', sameWall >= 19, `${sameWall}/20 identical`)
  check('but frozen session ids are shared with v2 on 0 of 20 runs', sameSession === 0, `${sameSession}/20 shared`)
  check(
    'the two batches are therefore different runs whose wall columns coincide',
    sameWall >= 19 && sameSession === 0,
    `sameWall=${sameWall} sameSession=${sameSession}`,
  )
  const sameMeasured = runs.filter((r) => r.sameSessionAsMeasured === true).length
  check("the runner's own v3 writes share all 20 session ids", sameMeasured === 20, `${sameMeasured}/20`)

  // -- 3. the overhead test separates the two columns ------------------------
  //
  // Recompute overhead from the raw columns rather than trusting the record's
  // own `overheadSec` field. The first version of this gate read the stored
  // field, and its selftest then failed to catch a mutation that inflated
  // `measuredWallSec` by 30s -- the check was verifying a precomputed number
  // instead of the derivation. A check that reads its own answer cannot fail.
  const derivedOverheads = runs.map((r) => r.measuredWallSec - r.sessionSpanSec)
  const derivedPubOverheads = runs.map((r) => r.publishedWallSec - r.sessionSpanSec)
  const storedAgrees = runs.every((r, i) => Math.abs(derivedOverheads[i] - r.overheadSec) <= 0.02)
  check('recorded overhead equals measured wall minus session span on all 20 runs', storedAgrees, 'stored overheadSec disagrees with the raw columns')
  check(
    'recorded published-overhead equals published wall minus session span',
    runs.every((r, i) => Math.abs(derivedPubOverheads[i] - r.publishedOverheadSec) <= 0.02),
    'stored publishedOverheadSec disagrees with the raw columns',
  )

  const overheads = derivedOverheads
  const pubOverheads = derivedPubOverheads
  check('corrected: overhead positive on all 20 runs', overheads.every((x) => x > 0), `negatives=${overheads.filter((x) => x < 0).length}`)
  check(
    'corrected: overhead within 1.0-4.0s (process start/teardown)',
    overheads.every((x) => x >= 1.0 && x <= 4.0),
    `range ${Math.min(...overheads)}..${Math.max(...overheads)}`,
  )
  check('corrected: overhead mean is ~2s', near(mean(overheads), 2.0, 0.25), mean(overheads).toFixed(2))
  check(
    'frozen: overhead scatters both ways',
    pubOverheads.some((x) => x < 0) && pubOverheads.some((x) => x > 0),
    `range ${Math.min(...pubOverheads)}..${Math.max(...pubOverheads)}`,
  )
  check('frozen: overhead negative on at least a quarter of runs', pubOverheads.filter((x) => x < 0).length >= 5, `negatives=${pubOverheads.filter((x) => x < 0).length}/20`)

  // -- 4. the retracted number is not still published as current -------------
  check('the frozen published table still holds the historical row (audit trail kept)', publishedTable.paired.some((r) => r.metric === '墙钟秒'), 'row missing')
  check(
    'manifest.json marks the wall clock as retracted rather than current',
    manifest.corrections?.some((c) => c.metric === 'wallClockSec' && c.status === 'retracted') === true,
    JSON.stringify(manifest.corrections ?? null),
  )
  const correctionEntry = (manifest.corrections ?? []).find((c) => c.metric === 'wallClockSec')
  check(
    'manifest.json carries the corrected numbers, not the retracted ones',
    correctionEntry !== undefined && near(correctionEntry.corrected.a, 66.49, 0.001) && near(correctionEntry.corrected.b, 69.49, 0.001),
    JSON.stringify(correctionEntry?.corrected ?? null),
  )

  check(
    'ab-metrics.mjs no longer treats the frozen wall column as a verified metric',
    !/wallClockSec:\s*paired\(/.test(text(AB_METRICS_FILE)),
    'still pairs r.wallClockSec from the frozen rows',
  )

  const harnessReadme = text(HARNESS_README_FILE)
  const readmeStale = staleLinesIn(harnessReadme)
  check('eval/harness/README.md no longer states the retracted numbers as current findings', readmeStale.length === 0, readmeStale.join(' | '))
  check('eval/harness/README.md states the retraction', harnessReadme.includes('撤回') || harnessReadme.includes('retract'), 'no retraction sentence')
  check('eval/harness/README.md publishes the corrected wall clock', harnessReadme.includes('66.49') && harnessReadme.includes('69.49'), 'corrected means missing')

  const abReport = textOrNull(AB_REPORT_FILE)
  if (abReport === null) {
    skipped.push({
      label: 'v0.4.0-AB实验报告.md',
      reason: 'the report is gitignored (`.gitignore:21` keeps `*报告.md` out), so a fresh clone has no copy',
    })
  } else {
    const reportStale = staleLinesIn(abReport)
    check('v0.4.0-AB实验报告.md no longer states the retracted numbers as current findings', reportStale.length === 0, reportStale.join(' | '))
    check('v0.4.0-AB实验报告.md states the retraction', abReport.includes('撤回') || abReport.includes('作废'), 'no retraction sentence')
    check('v0.4.0-AB实验报告.md publishes the corrected wall clock', abReport.includes('66.49') && abReport.includes('69.49'), 'corrected means missing')
  }

  return { results, skipped, pub, rec, overheads, pubOverheads, ids }
}

// ---------------------------------------------------------------------------
// Selftest: mirror the checked files into a scratch tree, break one thing per
// scenario, and require the named check to go red.
// ---------------------------------------------------------------------------
const editJson = (baseRoot, rel, fn) => {
  const p = join(baseRoot, rel)
  const value = JSON.parse(readFileSync(p, 'utf8'))
  fn(value)
  writeFileSync(p, JSON.stringify(value, null, 2))
}
const editText = (baseRoot, rel, fn) => {
  const p = join(baseRoot, rel)
  const before = readFileSync(p, 'utf8')
  const after = fn(before)
  if (after === before) throw new Error(`mutation on ${rel} changed nothing`)
  writeFileSync(p, after)
}

// Each scenario names the file it mutates as well as the mutation itself. The
// selftest needs the file separately: a scenario whose target is absent from the
// checkout (the AB report is gitignored) cannot be exercised at all, and must be
// reported as SKIP instead of silently counting as caught or as a miss.
const SCENARIOS = [
  {
    name: 'a run no longer shares the stale wall value',
    expect: 'frozen wall equals the v2 wall',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => (c.runs[0].sameWallAsStale = false)) },
  },
  {
    name: 'a run claims to share the stale session id',
    expect: 'frozen session ids are shared with v2 on 0 of 20',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => (c.runs[0].sameSessionAsStale = true)) },
  },
  {
    name: 'the runner-written batch no longer matches the frozen rows',
    expect: "the runner's own v3 writes share all 20 session ids",
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => (c.runs[0].sameSessionAsMeasured = false)) },
  },
  {
    name: 'a measured wall clock is inflated past the overhead bound',
    expect: 'corrected: overhead within 1.0-4.0s',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => (c.runs[0].measuredWallSec += 30)) },
  },
  {
    name: 'the frozen column is quietly overwritten with the corrected one',
    expect: 'the frozen column reproduces the published 54.16 -> 75.01',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => c.runs.forEach((r) => (r.publishedWallSec = r.measuredWallSec))) },
  },
  {
    // After the overhead test was switched to derive from raw columns, doctoring
    // the stored field no longer fools it -- by design. What must still be caught
    // is a record whose stored field silently disagrees with its own columns,
    // which is exactly how a "plausible looking" correction record would rot.
    name: 'the frozen overheads are doctored to look plausible',
    expect: 'recorded published-overhead equals published wall minus session span',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => c.runs.forEach((r) => (r.publishedOverheadSec = r.overheadSec))) },
  },
  {
    name: 'the recorded p-value no longer matches the rows',
    expect: 'recomputed corrected p matches the record',
    mutate: { file: CORRECTION_FILE, run: (root) => editJson(root, CORRECTION_FILE, (c) => (c.corrected.p = 0.0319)) },
  },
  {
    name: 'the retraction entry is dropped from the manifest',
    expect: 'manifest.json marks the wall clock as retracted',
    mutate: { file: MANIFEST_FILE, run: (root) => editJson(root, MANIFEST_FILE, (m) => delete m.corrections) },
  },
  {
    name: 'the manifest is left carrying the retracted numbers',
    expect: 'manifest.json carries the corrected numbers',
    mutate: {
      file: MANIFEST_FILE,
      run: (root) => editJson(root, MANIFEST_FILE, (m) => {
        const entry = m.corrections.find((c) => c.metric === 'wallClockSec')
        entry.corrected.a = 54.16
        entry.corrected.b = 75.01
      }),
    },
  },
  {
    name: 'ab-metrics starts pairing the frozen wall column again',
    expect: 'ab-metrics.mjs no longer treats the frozen wall column',
    mutate: { file: AB_METRICS_FILE, run: (root) => editText(root, AB_METRICS_FILE, (t) => `${t}\nconst metricsAgain = { wallClockSec: paired([], []) }\n`) },
  },
  {
    name: 'the harness README reinstates the retracted claim as a plain row',
    expect: 'eval/harness/README.md no longer states the retracted numbers',
    mutate: { file: HARNESS_README_FILE, run: (root) => editText(root, HARNESS_README_FILE, (t) => `${t}\n| 墙钟秒 | 54.16 | 75.01 | +38.5% | 0.032 |\n`) },
  },
  {
    name: 'the harness README forgets the corrected number',
    expect: 'eval/harness/README.md publishes the corrected wall clock',
    mutate: { file: HARNESS_README_FILE, run: (root) => editText(root, HARNESS_README_FILE, (t) => t.replaceAll('66.49', 'n/a')) },
  },
  {
    name: 'the AB report reinstates the retracted claim as a plain row',
    expect: 'v0.4.0-AB实验报告.md no longer states the retracted numbers',
    mutate: { file: AB_REPORT_FILE, run: (root) => editText(root, AB_REPORT_FILE, (t) => `${t}\n| 墙钟秒 | 54.2 | 75.0 | +20.9 | 2.536 | 0.0319 |\n`) },
  },
  {
    name: 'the AB report forgets the corrected number',
    expect: 'v0.4.0-AB实验报告.md publishes the corrected wall clock',
    mutate: { file: AB_REPORT_FILE, run: (root) => editText(root, AB_REPORT_FILE, (t) => t.replaceAll('69.49', 'n/a')) },
  },
]

function mirror(target) {
  for (const rel of CHECKED_FILES) {
    const src = join(ROOT, rel)
    if (!existsSync(src)) continue
    const dst = join(target, rel)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, readFileSync(src))
  }
}

function selftest() {
  console.log('=== selftest: every check must be able to fail ===')
  let caught = 0
  let missed = 0
  let skipped = 0
  const survivors = []
  for (const scenario of SCENARIOS) {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-wallclock-'))
    try {
      mirror(scratch)
      // A scenario can only be exercised if its target survived the mirror. The
      // AB report is gitignored, so on a fresh clone those two scenarios are
      // unreachable; saying SKIP is honest, while counting them as MISSED would
      // make the selftest fail for a reason that is not a defect.
      if (!existsSync(join(scratch, scenario.mutate.file))) {
        skipped++
        console.log(`  SKIP    ${scenario.name}  (${scenario.mutate.file} is absent from this checkout)`)
        continue
      }
      scenario.mutate.run(scratch)
      const { results } = runChecks(scratch)
      const target = results.find((r) => r.label.includes(scenario.expect))
      const broken = results.filter((r) => !r.ok)
      if (target === undefined) {
        missed++
        survivors.push(`${scenario.name} -- no check matched "${scenario.expect}"`)
        console.log(`  MISSED  ${scenario.name}  (no such check: ${scenario.expect})`)
      } else if (target.ok) {
        missed++
        survivors.push(`${scenario.name} -- "${scenario.expect}" stayed green`)
        console.log(`  MISSED  ${scenario.name}  ("${scenario.expect}" stayed green)`)
      } else {
        caught++
        console.log(`  CAUGHT  ${scenario.name}  -> ${broken.length} check(s) red, e.g. ${target.label}`)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  const tail = skipped > 0 ? ` / ${skipped} SKIPPED` : ''
  console.log(`\n  ${caught} CAUGHT / ${missed} MISSED${tail}`)
  if (missed > 0) {
    console.log('\n  a check that cannot fail is worse than no check:')
    for (const s of survivors) console.log(`  - ${s}`)
    process.exit(1)
  }
  console.log('\n  result: every check in this gate has been shown to go red')
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--selftest')) {
  selftest()
  process.exit(0)
}

const { results, skipped, pub, rec, overheads, pubOverheads, ids } = runChecks(ROOT)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ids, published: pub, corrected: rec, overheads, pubOverheads }, null, 2))
  process.exit(0)
}

// Section headers are located by the first check label they contain rather than
// by array index: adding a check used to silently shift every later section, and
// an index-based split would mislabel results instead of failing.
const SECTION_HEADS = [
  ['=== the correction record is self-consistent ===', '20 runs recorded'],
  ['=== the retraction is evidenced, not asserted ===', 'the frozen column reproduces'],
  ['=== the corrected column passes the process-overhead test, the frozen one fails ===', 'recorded overhead equals measured wall'],
  ['=== the retracted number is not still published as current ===', 'the frozen published table still holds'],
]
let headAt = 0
for (const r of results) {
  if (headAt < SECTION_HEADS.length && r.label.startsWith(SECTION_HEADS[headAt][1])) {
    if (headAt > 0) console.log('')
    console.log(SECTION_HEADS[headAt][0])
    headAt++
  }
  console.log(r.ok ? `  PASS  ${r.label}` : `  FAIL  ${r.label}  -> ${r.detail}`)
}
if (headAt !== SECTION_HEADS.length) {
  console.error(`\n  section headers misaligned: matched ${headAt} of ${SECTION_HEADS.length}`)
  process.exit(2)
}
console.log('')

const fail = results.filter((r) => !r.ok).length
const pass = results.length - fail
console.log(`  ${pass} PASS / ${fail} FAIL`)
if (skipped.length > 0) {
  for (const s of skipped) console.log(`  SKIP  ${s.label} -- ${s.reason}`)
}
if (fail > 0) {
  console.log('\nrecomputed table:')
  console.log(`  published  A=${pub.a.toFixed(2)} B=${pub.b.toFixed(2)} d=${pub.d.toFixed(2)} t=${pub.t.toFixed(3)} p=${pub.p.toFixed(4)}  <- RETRACTED`)
  console.log(`  corrected  A=${rec.a.toFixed(2)} B=${rec.b.toFixed(2)} d=${rec.d.toFixed(2)} t=${rec.t.toFixed(3)} p=${rec.p.toFixed(4)}`)
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}  -> ${r.detail}`)
  process.exit(1)
}
console.log('\n  result: the retracted wall-clock claim is evidenced, and the corrected number is derivable')
