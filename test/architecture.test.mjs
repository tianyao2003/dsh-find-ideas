import { extractArchitecture } from '../lib/architecture.js'
let passed = 0
let failed = 0
function check(name, value, detail = '') {
  if (value) {
    passed += 1
    console.log('  PASS  ' + name)
  } else {
    failed += 1
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''))
  }
}
const files = [
  { path: 'package.json', ok: true, text: JSON.stringify({ main: 'src/index.ts', dependencies: { express: '^5', zod: '^4' }, devDependencies: { vitest: '^3' } }) },
  { path: 'src/index.ts', ok: true, text: [
    "import express from 'express'",
    "import { User } from './model'",
    "const app = express()",
    "app.get('/users', handler)",
    "export interface User { id: string }",
    "const client = fetch('https://api.example.com/users')",
  ].join('\n') },
  { path: 'src/model.ts', ok: true, text: 'export interface User { id: string }' },
  { path: 'tests/users.test.ts', ok: true, text: "describe('users', () => { it('lists users', () => {}) })" },
]
const snapshot = extractArchitecture(files, { entries: files.map((file) => ({ path: file.path })), truncated: false })
console.log('\n=== AR1. architecture evidence is structured and traceable ===')
check('entry point is detected', snapshot.entry_points.some((item) => item.path === 'src/index.ts'))
check('manifest dependency is detected', snapshot.dependencies.some((item) => item.name === 'express'))
check('development dependency is separated', snapshot.dependencies.some((item) => item.name === 'vitest' && item.kind === 'development'))
check('route registration is detected', snapshot.routes_commands.some((item) => item.evidence.includes("app.get")))
check('data model is detected', snapshot.data_models.some((item) => item.evidence.includes('interface User')))
check('external boundary is detected', snapshot.external_boundaries.some((item) => item.evidence.includes('https://api.example.com')))
check('test behavior is detected', snapshot.test_behaviors.some((item) => item.evidence.includes('it(')))
check('call chain is conservative', snapshot.call_chain.every((item) => item.confidence === 'observed' || item.confidence === 'heuristic'))
check('every evidence item has a path and line', [...snapshot.entry_points, ...snapshot.routes_commands, ...snapshot.data_models, ...snapshot.external_boundaries, ...snapshot.test_behaviors, ...snapshot.call_chain].every((item) => item.path && item.start_line > 0))
check('unknown list is empty when every section has evidence', snapshot.unknowns.length === 0, JSON.stringify(snapshot.unknowns))

console.log('\n=== AR2. unknown and truncation are explicit ===')
const empty = extractArchitecture([{ path: 'src/unknown.xyz', ok: true, text: 'plain prose' }], { entries: [], truncated: true })
check('unknown sections are reported', empty.unknowns.some((item) => item.startsWith('entry_points:')))
check('tree truncation is reported', empty.unknowns.some((item) => item.startsWith('tree:')))
check('no section claims absence as a measured zero', !JSON.stringify(empty).includes('= 0'))
check('unsupported file does not create fake route evidence', empty.routes_commands.length === 0)

console.log('\n' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) process.exit(1)

