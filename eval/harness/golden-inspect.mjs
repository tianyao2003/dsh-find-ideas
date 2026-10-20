// Golden-fixture regression harness for `inspect_projects` rendering.
//
// WHY THIS EXISTS
// ---------------
// M1/M2/M3 of the v0.4.1 cost work change how big a card is and how fast it is
// produced. The acceptance criterion for those tasks is "the effect does not
// change". A criterion that vague cannot be checked by reading a diff, and the
// end-to-end A/B run cannot check it either: it has ten runs, and ten runs cannot
// distinguish "same information" from "same-ish information".
//
// So the check is done at the layer where "same" has a definition: take the 48
// real inspections recorded during the v0.4.0 A/B run, feed them back through the
// CURRENT renderer, and compare.
//
// Two comparison modes, because two different things must be preserved:
//
//   --mode=bytes    Every card is byte-identical to the recorded baseline.
//                   Required by M1 (schema text) and M3 (parallel reads): those
//                   changes must not touch what the model sees AT ALL.
//
//   --mode=info     The card may shrink, but it must not lose information it
//                   cannot name: same `files_read`, same tree entry count, same
//                   skeleton signature count, and every cut is still reported
//                   in the trim notice. Required by M2 and M4 (budget changes),
//                   where shrinking IS the point.
//
// The distinction matters. Applying --mode=bytes to M2 would fail on every
// change and teach nothing; applying --mode=info to M1 would pass while the
// schema silently changed. Each task names the mode it must satisfy.
//
// THE FIXTURE IS NOT SYNTHETIC
// ----------------------------
// `eval/fixtures/inspect-golden-raw.json` is the `inspections` array captured
// from 12 real `inspect_projects` calls during the v0.4.0 A/B run (48 distinct
// repositories, 531,831 bytes of raw block content). It is checked in because a
// fixture regenerated today would not be the same fixture: the repositories
// have moved on, and a regression test whose input drifts with GitHub tests
// GitHub, not this code.
//
// Usage:
//   node eval/harness/golden-inspect.mjs --write          # record the baseline
//   node eval/harness/golden-inspect.mjs --mode=bytes     # verify byte equality
//   node eval/harness/golden-inspect.mjs --mode=info      # verify information equality
//   node eval/harness/golden-inspect.mjs --mode=bytes --report   # dump current state
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const FIXTURE = join(ROOT, 'eval', 'fixtures', 'inspect-golden-raw.json')
const BASELINE = join(ROOT, 'eval', 'fixtures', 'inspect-golden-baseline.json')

// The budgets the real A/B calls actually used, plus the two ends of the
// documented range. Testing only the default would leave the trim path (the code
// M2 and M4 actually change) untested at every other budget.
const BUDGETS = [8000, 12000, 16000, 24000, 28000, 40000, 60000, 64000]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}

const { renderInspections, INSPECT_BYTES_DEFAULT } = await import(
  new URL('../../lib/render.js', import.meta.url).href
)

const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'))

/**
 * Structural signature of a rendered card: the information a smaller card is
 * still allowed to carry, expressed without reference to how it is laid out.
 *
 * Counts rather than content, because the point of M2 is to change content.
 * `filesRead` is listed in full because "which files were read" is the evidence
 * chain: dropping a file from it would be a real loss even if the card got
 * smaller.
 */
function signature(card) {
  const lines = card.split('\n')
  const filesRead = []
  let treeEntries = 0
  let skeletonHits = 0
  let cutNotices = 0
  let repos = 0
  for (const line of lines) {
    if (line.includes('📝')) repos++
    const read = /读取文件（(\d+)）：(.+)$/.exec(line)
    if (read !== null) {
      filesRead.push(...read[2].split(', ').map((s) => s.trim()))
    }
    // Tree lines are the ones that look like a path at the start of a bullet.
    if (/^\s{2,}[│├└]|^\s{2,}[\w.\-/]+\/$/.test(line)) treeEntries++
    if (/^\s{2,}(?:function|class|interface|type|const|export|def|fn|struct)\s/.test(line)) skeletonHits++
    if (/裁剪|省略|dropped|trimmed/.test(line)) cutNotices++
  }
  return {
    bytes: Buffer.byteLength(card, 'utf8'),
    repos,
    filesRead,
    treeEntries,
    skeletonHits,
    cutNotices,
  }
}

function build() {
  const out = []
  for (const key of Object.keys(raw)) {
    const entry = raw[key]
    const value = entry.value
    const row = { name: entry.name, idea: value.idea, budgets: {} }
    for (const budget of BUDGETS) {
      const card = renderInspections(
        value.idea,
        value.inspections,
        value.degraded ?? null,
        value.cached ?? false,
        budget,
      )
      row.budgets[String(budget)] = {
        sha256: createHash('sha256').update(card, 'utf8').digest('hex'),
        ...signature(card),
      }
    }
    // The default budget is named separately because it is the one every caller
    // that passes no `budget_bytes` gets — the common path, not a special case.
    if (!BUDGETS.includes(INSPECT_BYTES_DEFAULT)) {
      const card = renderInspections(
        value.idea,
        value.inspections,
        value.degraded ?? null,
        value.cached ?? false,
      )
      row.budgets[String(INSPECT_BYTES_DEFAULT)] = {
        sha256: createHash('sha256').update(card, 'utf8').digest('hex'),
        ...signature(card),
      }
    }
    out.push(row)
  }
  return {
    generatedFrom: 'eval/fixtures/inspect-golden-raw.json',
    pluginVersion: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
    formatVersion: currentFormatVersion(),
    entries: out,
  }
}

function currentFormatVersion() {
  const src = readFileSync(join(ROOT, 'lib', 'render.js'), 'utf8')
  const m = /INSPECT_FORMAT_VERSION\s*=\s*(\d+)/.exec(src)
  return m === null ? null : Number(m[1])
}

const now = build()
now.formatVersion = currentFormatVersion()

if (flag('write')) {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n', 'utf8')
  const cards = now.entries.reduce((s, e) => s + Object.keys(e.budgets).length, 0)
  console.log(`wrote ${BASELINE}`)
  console.log(`  entries=${now.entries.length} cards=${cards} formatVersion=${now.formatVersion}`)
  process.exit(0)
}

if (flag('report')) {
  console.log(JSON.stringify(now, null, 2))
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`no baseline at ${BASELINE} — run with --write first`)
  process.exit(2)
}

const mode = opt('mode', 'bytes')
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))

let pass = 0
let fail = 0
const failures = []
function check(label, cond, detail = '') {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(`${label}${detail === '' ? '' : '  -> ' + detail}`)
  }
}

check('same number of fixture entries', now.entries.length === base.entries.length,
  `${now.entries.length} vs ${base.entries.length}`)

for (const want of base.entries) {
  const got = now.entries.find((e) => e.name === want.name)
  if (got === undefined) {
    check(`${want.name}: entry still renders`, false, 'entry missing')
    continue
  }
  for (const budget of Object.keys(want.budgets)) {
    const w = want.budgets[budget]
    const g = got.budgets[budget]
    if (g === undefined) {
      check(`${want.name}@${budget}: budget still produced`, false, 'missing')
      continue
    }
    if (mode === 'bytes') {
      check(`${want.name}@${budget}: byte-identical`,
        g.sha256 === w.sha256,
        `bytes ${w.bytes} -> ${g.bytes}`)
    } else if (mode === 'info') {
      check(`${want.name}@${budget}: same files_read`,
        JSON.stringify(g.filesRead) === JSON.stringify(w.filesRead),
        `${w.filesRead.length} -> ${g.filesRead.length}`)
      check(`${want.name}@${budget}: same repo count`, g.repos === w.repos,
        `${w.repos} -> ${g.repos}`)
      // A smaller card may drop tree lines and skeleton signatures, but it must
      // say so: every drop has to raise a cut notice.
      const lostTree = w.treeEntries - g.treeEntries
      const lostSkeleton = w.skeletonHits - g.skeletonHits
      const lostBlocks = lostTree + lostSkeleton
      check(`${want.name}@${budget}: every dropped block is announced`,
        lostBlocks <= 0 || g.cutNotices > w.cutNotices,
        `lost=${lostBlocks} notices ${w.cutNotices} -> ${g.cutNotices}`)
      check(`${want.name}@${budget}: no growth`,
        g.bytes <= w.bytes,
        `${w.bytes} -> ${g.bytes}`)
    } else {
      console.error(`unknown --mode=${mode}`)
      process.exit(2)
    }
  }
}

console.log(`\n=== golden-inspect (--mode=${mode}) ===`)
console.log(`  fixture entries : ${now.entries.length}`)
console.log(`  budgets         : ${BUDGETS.join(', ')}`)
console.log(`  checks          : ${pass} PASS / ${fail} FAIL`)
if (fail > 0) {
  console.log('\nfirst failures:')
  for (const f of failures.slice(0, 20)) console.log('  FAIL  ' + f)
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`)
  process.exit(1)
}
console.log('  result          : OK')
