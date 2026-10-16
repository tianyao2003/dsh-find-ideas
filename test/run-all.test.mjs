// Runs every test file in test/ and aggregates the totals.
//
// `node --test` is the natural tool, but this project's sandbox has, in earlier
// rounds, refused to spawn child processes with piped stdio while `node --test`
// spawns one child per file. Running the files sequentially through spawnSync
// with `stdio: 'inherit'` avoids forwarding pipes altogether. If a spawn is
// refused, the runner reports it as a failure rather than silently passing.
//
// SKIPPED IS NOT PASSED
// ---------------------
// Two files (baseline, stage2) replay FROZEN eval runs, and `eval/runs/` is
// not in this repository — so on a fresh clone they cannot run and they skip
// themselves rather than throwing ENOENT. Counting a skip as a pass would let
// this line print "8/8 passed" on a machine where the two evidence-integrity
// suites never executed, which is exactly the kind of claim this repository
// exists to stop making. So each child is handed a marker path; if it writes
// the marker, it is counted as skipped and reported separately.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs') && name !== 'run-all.test.mjs')
  .sort()

const skipDir = mkdtempSync(join(tmpdir(), 'dsh-skips-'))
let failed = 0
let skipped = 0
const skippedNames = []

for (const file of files) {
  const marker = join(skipDir, `${file}.skip`)
  const result = spawnSync(process.execPath, [join(here, file)], {
    stdio: 'inherit',
    env: { ...process.env, DSH_SKIP_MARKER: marker },
  })
  const ok = result.status === 0
  if (!ok) {
    failed++
    if (result.error) console.log(`  (spawn of ${file} failed: ${result.error.message})`)
    continue
  }
  // A file may only claim "skipped" by exiting 0 AND leaving the marker.
  if (existsSync(marker)) {
    skipped++
    skippedNames.push(file)
  }
}

rmSync(skipDir, { recursive: true, force: true })

const ran = files.length - failed - skipped
console.log(`\n${ran}/${files.length} test files passed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
if (skipped > 0) {
  console.log(`  skipped (fixture absent, NOT verified): ${skippedNames.join(', ')}`)
}
process.exit(failed === 0 ? 0 : 1)
