// Self-test for the golden-inspect harness: proves the checks can FAIL.
//
// WHY THIS EXISTS
// ---------------
// The first version of `golden-inspect.mjs` had three checks that could not fail:
//   - `repos` counted `📝`, but section headers print `📦` (always 0 vs 0);
//   - `skeletonHits` used a regex that never matched a declaration row (0 vs 0);
//   - `no growth` was written as a size invariant, but a *better* renderer produces
//     a smaller untrimmed card, so the trim ladder stops one rung earlier and the
//     final card is legitimately larger. It failed on exactly the 25 cards the
//     baseline had over-trimmed and passed on nothing else — an inverted check.
// All three reported PASS. A harness whose checks cannot go red does not certify
// anything; it only makes a green line.
//
// So this script plants real regressions into the built renderer, runs the harness,
// and requires each one to be caught. Two mechanisms count as caught:
//   - the pattern guard (`assertPatternsStillMatch`) exits 2 when a signature
//     pattern stops matching the renderer at all — the mutation removed the very
//     bytes the pattern looks for;
//   - a specific check goes FAIL — the mutation changed a count without zeroing it.
// The guard preempts the checks, so every check also gets a mutation that leaves
// the pattern matching and only perturbs the data.
//
// Usage: node eval/harness/golden-inspect-selftest.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const TARGET = join(ROOT, 'lib', 'render.js')
const HARNESS = join(HERE, 'golden-inspect.mjs')

const original = readFileSync(TARGET, 'utf8')

function runHarness() {
  try {
    const out = execFileSync(process.execPath, [HARNESS, '--mode=info'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

const READ_FILES_LINE = "lines.push(`   读取文件（${item.files_read.length}）：${item.files_read.length > 0 ? item.files_read.map(escapeUntrusted).join(', ') : '（无）'}`);"
const SECTION_LINE = 'lines.push(`📦 ${escapeUntrusted(item.full_name)}`);'
const CUT_GUARD = 'if (cutLines.length > 0) {'
const ATTEMPT = 'const attempt = () => {'
const SKELETON_PUSH = 'lines.push(...quotedBlock(skeleton));'

const MUTATIONS = [
  // Guard-level: the bytes a signature pattern looks for are gone entirely.
  {
    name: 'remove the read-files line entirely',
    apply: (src) => src.replace(READ_FILES_LINE, '// removed by the self-test'),
    kind: 'guard',
    why: 'filesRead would silently become an empty list on every card',
  },
  {
    name: 'rename the section marker 📦 -> 📝',
    apply: (src) => src.replace(SECTION_LINE, 'lines.push(`📝 ${escapeUntrusted(item.full_name)}`);'),
    kind: 'guard',
    why: 'this is the exact defect the original harness had',
  },
  // Check-level: the pattern still matches somewhere, only the data is wrong.
  {
    name: 'truncate files_read to its first entry',
    apply: (src) => src.replace(
      READ_FILES_LINE,
      "lines.push(`   读取文件（${item.files_read.length}）：${item.files_read.slice(0, 1).map(escapeUntrusted).join(', ')}`);",
    ),
    kind: 'check',
    expect: 'same files_read',
  },
  {
    name: 'print every section header twice',
    apply: (src) => src.replace(SECTION_LINE, SECTION_LINE + '\n            ' + SECTION_LINE),
    kind: 'check',
    expect: 'every inspected repo still has a section',
  },
  {
    name: 'silently swallow the cut notices',
    apply: (src) => src.replace(CUT_GUARD, 'if (cutLines.length > 9999) {'),
    kind: 'check',
    expect: 'every dropped block is announced',
  },
  {
    name: 'ignore the budget and never trim',
    apply: (src) => src.replace(ATTEMPT, 'const attempt = () => { if (true) return { text: compose(view(), []), fits: true };'),
    kind: 'check',
    expect: 'within budget, or says it cannot fit',
  },
  {
    name: 'drop the skeleton block of a single repo',
    apply: (src) => src.replace(
      SKELETON_PUSH,
      "if (!item.full_name.startsWith('NVIDIA-AI-Blueprints/pdf-to-podcast')) lines.push(...quotedBlock(skeleton));",
    ),
    kind: 'check',
    expect: 'structural evidence not reduced',
  },
]

const results = []
try {
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(original)
    if (mutated === original) {
      results.push({ name: mutation.name, verdict: 'NOT APPLIED', detail: 'the source text moved; fix the mutation' })
      continue
    }
    writeFileSync(TARGET, mutated, 'utf8')
    const run = runHarness()
    if (mutation.kind === 'guard') {
      const caught = run.code === 2 && run.out.includes('no longer describe the renderer')
      results.push({
        name: mutation.name,
        verdict: caught ? 'CAUGHT (guard)' : 'NOT CAUGHT',
        detail: caught ? mutation.why : `exit=${run.code}; expected the pattern guard to refuse`,
      })
    } else {
      const line = run.out.split('\n').find((l) => l.startsWith('  FAIL  ') && l.includes(mutation.expect))
      results.push({
        name: mutation.name,
        verdict: line === undefined ? 'NOT CAUGHT' : 'CAUGHT (check)',
        detail: line === undefined
          ? `exit=${run.code}; expected a FAIL line containing "${mutation.expect}"`
          : line.trim(),
      })
    }
  }
} finally {
  // Always restore, even on Ctrl-C: leaving a mutated build behind would poison
  // every later measurement in this checkout.
  writeFileSync(TARGET, original, 'utf8')
}

console.log('=== golden-inspect self-test: can the checks fail? ===')
let allCaught = true
for (const result of results) {
  if (result.verdict === 'NOT CAUGHT' || result.verdict === 'NOT APPLIED') allCaught = false
  console.log(`${result.verdict.padEnd(16)} ${result.name}`)
  console.log(`${''.padEnd(16)} ${result.detail.slice(0, 160)}`)
}

const restored = runHarness()
console.log('')
console.log(`restored build: exit=${restored.code} (must be 0)`)
console.log(`  ${restored.out.trim().split('\n').filter((l) => l.includes('checks') || l.includes('result')).map((l) => l.trim()).join(' | ')}`)

if (!allCaught || restored.code !== 0) {
  console.log('\nVERDICT: the harness is not trustworthy yet')
  process.exit(1)
}
console.log('\nVERDICT: every planted regression was caught; the restored build is green')
