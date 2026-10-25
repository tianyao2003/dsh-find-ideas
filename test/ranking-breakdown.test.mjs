import { apply } from '../lib/index.js'
import { deriveRelevance, finalScore, rankCandidates } from '../lib/types.js'

const defs = new Map()
apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
const rank = defs.get('rank_candidates')
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

console.log('\n=== RB1. dimensions derive relevance deterministically ===')
const fullInput = {
  full_name: 'x/y',
  dimensions: { problem_fit: 5, workflow_fit: 4, technical_fit: 3, borrowability: 5 },
  evidence_level: 'source',
}
const full = deriveRelevance(fullInput)
check('weighted result is integer 0-10', full.relevance === 8)
check('known dimensions are preserved', full.breakdown.problem_fit === 5 && full.breakdown.workflow_fit === 4 && full.breakdown.technical_fit === 3)
check('borrowability is separate', full.breakdown.borrowability === 5)
check('source evidence with all dimensions is high confidence', full.breakdown.confidence === 'high')
check('same input yields same result', JSON.stringify(deriveRelevance(fullInput)) === JSON.stringify(full))

console.log('\n=== RB2. unknown dimensions are not zeros ===')
const partial = deriveRelevance({
  full_name: 'x/y',
  dimensions: { problem_fit: 5, workflow_fit: null, technical_fit: null, borrowability: null },
  evidence_level: 'metadata',
})
check('known weight is renormalized', partial.relevance === 10)
check('unknown stays null', partial.breakdown.workflow_fit === null && partial.breakdown.technical_fit === null)
check('partial evidence is low confidence', partial.breakdown.confidence === 'low')
const measuredZero = deriveRelevance({
  full_name: 'x/y',
  dimensions: { problem_fit: 0, workflow_fit: 0, technical_fit: 0 },
  evidence_level: 'metadata',
})
check('measured zero remains zero', measuredZero.relevance === 0)
check('unknown and zero differ', JSON.stringify(partial.breakdown) !== JSON.stringify(measuredZero.breakdown))

console.log('\n=== RB3. legacy input remains compatible ===')
const legacy = deriveRelevance({ full_name: 'x/y', relevance: 7, note: 'legacy' })
check('legacy relevance is preserved', legacy.relevance === 7)
check('legacy source is explicit', legacy.breakdown.source === 'legacy')
check('legacy dimensions are unknown', legacy.breakdown.problem_fit === null && legacy.breakdown.borrowability === null)
const candidate = {
  full_name: 'x/y', url: 'https://github.com/x/y', owner: 'x', name: 'y',
  description: 'a local-first note app', stars: 100, language: 'TypeScript',
  pushed_at: '2026-01-01T00:00:00Z', archived: false, topics: [],
}
const ranked = rankCandidates([candidate], [{
  full_name: 'x/y',
  dimensions: { problem_fit: 5, workflow_fit: 4, technical_fit: 3, borrowability: 4 },
  evidence_level: 'readme',
}])
check('dimensions-only input reaches the ranker', ranked.ranked[0]?.relevance === 8)
check('breakdown reaches the ranked row', ranked.ranked[0]?.relevance_breakdown?.source === 'dimensions')
check('stars formula remains unchanged', ranked.ranked[0]?.score === finalScore(8, 100))

console.log('\n=== RB4. schema and card expose the breakdown without changing table columns ===')
const scoreProps = rank.parameters.properties.scores.items.properties
check('dimensions is accepted inside score rows', scoreProps.dimensions !== undefined)
check('legacy relevance is optional', !(rank.parameters.properties.scores.items.required ?? []).includes('relevance'))
check('ranked output declares the breakdown', rank.output.schema.properties.ranked.items.properties.relevance_breakdown !== undefined)
const value = await rank.execute({
  idea: 'a local-first note app',
  candidates: [candidate],
  scores: [{
    full_name: 'x/y',
    dimensions: { problem_fit: 5, workflow_fit: 4, technical_fit: 3, borrowability: 4 },
    evidence_level: 'readme',
    note: 'same problem and workflow, technical evidence from README',
  }],
}, {})
const card = rank.output.render({}, value)[0].text
check('card contains a compact dimension section', card.includes('【相关性维度】'))
check('card retains the eight-column table', (card.match(/\| # \| 项目 \| 最近更新 \| relevance \| stars \| 得分 \| 语言 \| 简介 \|/g) ?? []).length === 1)
check('card never renders undefined', !card.includes('undefined'))

console.log('\n' + passed + ' PASS / ' + failed + ' FAIL')
if (failed > 0) process.exit(1)

