import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = await mkdtemp(join(tmpdir(), 'dsh-prior-'))
process.env.DSH_HOME = home
const { recordPrior, priorContextFor, PRIOR_MAX_RECORDS, PRIOR_MAX_BYTES, ideaHash } = await import('../lib/prior.js')
let passed = 0
let failed = 0
function check(name, value, detail = '') {
  if (value) { passed += 1; console.log('  PASS  ' + name) }
  else { failed += 1; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')) }
}
console.log('\n=== PH1. bounded prior history ===')
check('idea hash is deterministic', ideaHash('  A   Note App ') === ideaHash('a note app'))
check('idea hash does not contain raw idea', !ideaHash('secret idea').includes('secret'))
await recordPrior('owner/repo', 'a local note app', 'seen')
await recordPrior('owner/repo', 'a local note app', 'inspected', 'a'.repeat(40), ['package.json'])
let rows = await priorContextFor(['owner/repo'])
check('exact repo history is returned', rows.length === 1 && rows[0].repo === 'owner/repo')
check('seen count increments', rows[0].seen_count === 2)
check('inspected count increments', rows[0].inspected_count === 1)
const priorPath = join(home, 'cache', 'dsh-find-ideas', 'prior.json')
const raw = JSON.parse(await readFile(priorPath, 'utf8'))
check('raw idea text is not persisted', !JSON.stringify(raw).includes('local note app'))
check('source path metadata is bounded', raw.records[0].last_paths.length === 1)
console.log('\n=== PH2. cap and corruption degrade safely ===')
for (let i = 0; i < PRIOR_MAX_RECORDS + 10; i += 1) await recordPrior('owner/repo-' + i, 'idea ' + i, 'seen')
const capped = JSON.parse(await readFile(priorPath, 'utf8'))
check('record count stays bounded', capped.records.length <= PRIOR_MAX_RECORDS)
check('file stays bounded', Buffer.byteLength(JSON.stringify(capped), 'utf8') <= PRIOR_MAX_BYTES)
await writeFile(priorPath, '{broken', 'utf8')
check('corrupt history reads as empty', (await priorContextFor(['owner/repo'])).length === 0)
await rm(home, { recursive: true, force: true })
console.log('\n' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) process.exit(1)

