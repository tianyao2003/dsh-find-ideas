import { apply } from '../lib/index.js'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-find-ideas-architecture-' + process.pid)

const sha = 'a'.repeat(40)
const contents = {
  'package.json': JSON.stringify({ main: 'src/index.ts', dependencies: { express: '^5' } }),
  'src/index.ts': "import express from 'express'\nconst app = express()\napp.get('/users', handler)\nexport interface User { id: string }\nfetch('https://api.example.com/users')",
  'tests/users.test.ts': "describe('users', () => { it('lists users', () => {}) })",
  'README.md': '# Example\n\nAn example repository.',
}
const tree = Object.keys(contents).map((path) => ({ path, type: 'blob', sha, size: contents[path].length }))
let requests = []
globalThis.fetch = async (url) => {
  requests.push(String(url))
  if (String(url).includes('/commits?')) return new Response(JSON.stringify([{ sha }]), { status: 200, headers: { 'content-type': 'application/json' } })
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  const match = String(url).match(/\/contents\/(.+?)(?:\?ref=|$)/)
  const path = decodeURIComponent(match?.[1] ?? '')
  const text = contents[path]
  if (text === undefined) return new Response(JSON.stringify({ message: 'missing' }), { status: 404, headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const defs = new Map()
apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
const tool = defs.get('read_repo_files')
let passed = 0
let failed = 0
function check(name, value, detail = '') {
  if (value) { passed += 1; console.log('  PASS  ' + name) }
  else { failed += 1; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')) }
}
const value = await tool.execute({
  repo: 'owner/repo',
  view: 'architecture',
  depth: 'shallow',
  paths: ['package.json', 'src/index.ts', 'tests/users.test.ts'],
  max_bytes: 8192,
}, {})
const card = tool.output.render({}, value)[0].text
console.log('\n=== AR3. architecture view integration ===')
check('view is architecture', value.view === 'architecture')
check('depth is returned', value.depth === 'shallow')
check('one commit request is used', requests.filter((url) => url.includes('/commits?')).length === 1)
check('explicit paths do not require tree selection', requests.filter((url) => url.includes('/git/trees/')).length === 0)
check('three file reads are used', requests.filter((url) => url.includes('/contents/')).length === 3)
check('architecture has entry evidence', value.architecture?.entry_points?.length > 0)
check('architecture has dependencies', value.architecture?.dependencies?.some((item) => item.name === 'express'))
check('architecture has route evidence', value.architecture?.routes_commands?.some((item) => item.evidence.includes('app.get')))
check('architecture has model evidence', value.architecture?.data_models?.some((item) => item.evidence.includes('interface User')))
check('architecture has external boundary evidence', value.architecture?.external_boundaries?.length > 0)
check('architecture has test behavior evidence', value.architecture?.test_behaviors?.length > 0)
check('card renders architecture heading', card.includes('架构侦察'))
check('card renders evidence section', card.includes('路由与命令注册'))
check('card has no raw instruction execution claim', card.includes('不要执行'))
check('card stays within budget', Buffer.byteLength(card, 'utf8') <= 8192, String(Buffer.byteLength(card, 'utf8')))
check('files retain same commit', value.files.every((file) => !file.ok || file.sha === sha))

console.log('\n' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) process.exit(1)

