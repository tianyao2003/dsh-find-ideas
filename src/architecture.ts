export type ArchitectureConfidence = 'observed' | 'heuristic' | 'unknown'

export interface ArchitectureEvidence {
  path: string
  start_line: number
  end_line: number
  evidence: string
  confidence: ArchitectureConfidence
}

export interface ArchitectureDependency {
  manifest: string
  ecosystem: string
  name: string
  kind: 'runtime' | 'development' | 'unknown'
  evidence: ArchitectureEvidence
}

export interface ArchitectureSnapshot {
  entry_points: ArchitectureEvidence[]
  dependencies: ArchitectureDependency[]
  routes_commands: ArchitectureEvidence[]
  data_models: ArchitectureEvidence[]
  call_chain: ArchitectureEvidence[]
  external_boundaries: ArchitectureEvidence[]
  test_behaviors: ArchitectureEvidence[]
  unknowns: string[]
}

interface ReadableFile {
  path: string
  text: string
  ok: boolean
  read_truncated?: boolean
}

interface TreeLike {
  entries: Array<{ path: string; type?: string }>
  truncated?: boolean
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|rb|php|vue|svelte|sql)$/i
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|deps\.edn|project\.clj|mix\.exs)$/i
const TEST_RE = /(^|\/)(tests?|specs?|__tests__|e2e)(\/|$)|(^|[._-])(tests?|specs?)([._-]|$)/i
const ENTRY_RE = /(^|\/)(main|program|index|app|server|entry|handler|start)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|rb|php|vue|svelte)$/i
const EXTERNAL_IMPORT_RE = /(from\s+['"][^'"]+['"]|require\(\s*['"][^'"]+['"]\s*\)|import\s+[\w*{},\s]+\s+from\s+['"][^'"]+['"])/

function evidence(path: string, line: number, text: string, confidence: ArchitectureConfidence = 'observed'): ArchitectureEvidence {
  return {
    path,
    start_line: line,
    end_line: line,
    evidence: text.replace(/\s+/g, ' ').trim().slice(0, 220),
    confidence,
  }
}

function linesOf(file: ReadableFile): string[] {
  return file.text.split('\n')
}

function isManifest(path: string): boolean {
  return MANIFEST_RE.test(path)
}

function ecosystem(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('package.json')) return 'node'
  if (lower.endsWith('pyproject.toml') || lower.endsWith('requirements.txt')) return 'python'
  if (lower.endsWith('go.mod')) return 'go'
  if (lower.endsWith('cargo.toml')) return 'rust'
  if (lower.endsWith('pom.xml') || lower.endsWith('build.gradle') || lower.endsWith('build.gradle.kts')) return 'jvm'
  if (lower.endsWith('composer.json')) return 'php'
  if (lower.endsWith('deps.edn') || lower.endsWith('project.clj')) return 'clojure'
  return 'unknown'
}

function addUnknown(snapshot: ArchitectureSnapshot, section: string, reason: string): void {
  snapshot.unknowns.push(section + ': ' + reason)
}

function addManifestDependencies(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok || !isManifest(file.path)) return
  const kind = ecosystem(file.path)
  if (file.path.toLowerCase().endsWith('package.json')) {
    try {
      const parsed = JSON.parse(file.text) as Record<string, unknown>
      for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        const values = parsed[bucket]
        if (values === null || typeof values !== 'object' || Array.isArray(values)) continue
        for (const name of Object.keys(values as Record<string, unknown>).slice(0, 80)) {
          const line = file.text.split('\n').findIndex((lineText) => lineText.includes(JSON.stringify(name))) + 1
          snapshot.dependencies.push({
            manifest: file.path,
            ecosystem: kind,
            name,
            kind: bucket === 'devDependencies' ? 'development' : 'runtime',
            evidence: evidence(file.path, Math.max(1, line), bucket + ': ' + name),
          })
        }
      }
    } catch {
      addUnknown(snapshot, 'dependencies', file.path + ' is not valid JSON in the returned window')
    }
    return
  }

  const dependencyLines = linesOf(file).map((line, index) => ({ line, index: index + 1 })).filter(({ line }) =>
    /^\s*(require|implementation|api|compile|runtimeOnly|testImplementation)\s*[\s(:]/i.test(line) ||
    /^\s*[\w@./-]+([=<>~!]|:\s*[\w"'])/.test(line),
  )
  for (const item of dependencyLines.slice(0, 80)) {
    const name = item.line.trim().replace(/^[\s"'([{]+|[\s"',)\]}]+$/g, '').slice(0, 140)
    if (name.length === 0) continue
    snapshot.dependencies.push({
      manifest: file.path,
      ecosystem: kind,
      name,
      kind: /test/i.test(item.line) ? 'development' : 'runtime',
      evidence: evidence(file.path, item.index, item.line),
    })
  }
}

function addEntryPoints(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok) return
  const lines = linesOf(file)
  if (ENTRY_RE.test(file.path)) snapshot.entry_points.push(evidence(file.path, 1, 'conventional entry path: ' + file.path, 'heuristic'))
  if (isManifest(file.path)) {
    for (const key of ['main', 'module', 'bin', 'exports', 'scripts']) {
      const index = lines.findIndex((line) => new RegExp("[\\\"']?" + key + "[\\\"']?\\s*:").test(line))
      if (index >= 0) snapshot.entry_points.push(evidence(file.path, index + 1, lineAt(lines, index), 'observed'))
    }
  }
}

function lineAt(lines: string[], index: number): string {
  return lines[index] ?? ''
}

function addRoutesCommands(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok) return
  for (const [index, line] of linesOf(file).entries()) {
    if (/\b(?:app|router|server)\.(get|post|put|patch|delete|use|route)\s*\(/i.test(line)) {
      snapshot.routes_commands.push(evidence(file.path, index + 1, line))
    } else if (/\b(?:program|command|cli|app)\.command\s*\(/i.test(line) || /\b(?:defineTool|register)\s*\(/.test(line)) {
      snapshot.routes_commands.push(evidence(file.path, index + 1, line))
    } else if (/\b(?:@app\.(get|post)|@router\.(get|post)|cobra\.Command|click\.command|typer\.command)\b/i.test(line)) {
      snapshot.routes_commands.push(evidence(file.path, index + 1, line))
    }
  }
}

function addDataModels(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok) return
  for (const [index, line] of linesOf(file).entries()) {
    if (/^\s*(export\s+)?(interface|type|class|struct|enum)\s+[A-Za-z_]\w*/.test(line) ||
      /^\s*(class|@dataclass)\s+[A-Za-z_]\w*/.test(line) ||
      /^\s*CREATE\s+TABLE\s+/i.test(line) ||
      /\b(BaseModel|dataclass)\b/.test(line)) {
      snapshot.data_models.push(evidence(file.path, index + 1, line))
    }
  }
}

function addExternalBoundaries(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok) return
  for (const [index, line] of linesOf(file).entries()) {
    if (/https?:\/\/[^\s'")]+/.test(line) || /\b(fetch|axios|requests\.|http\.|reqwest|resty)\b/.test(line) ||
      /\b(process\.env|os\.environ|std::env|os\.Getenv)\b/.test(line) ||
      EXTERNAL_IMPORT_RE.test(line) && /\b(openai|anthropic|stripe|github|postgres|mysql|redis|sqlite|kafka|aws|azure|gcp)\b/i.test(line)) {
      snapshot.external_boundaries.push(evidence(file.path, index + 1, line))
    }
  }
}

function addTests(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok || !TEST_RE.test(file.path)) return
  for (const [index, line] of linesOf(file).entries()) {
    if (/\b(describe|suite|test|it|specify)\s*\(/.test(line) || /^\s*(def test_|func Test|#\[test\])/.test(line)) {
      snapshot.test_behaviors.push(evidence(file.path, index + 1, line))
    }
  }
  if (snapshot.test_behaviors.every((item) => item.path !== file.path)) {
    snapshot.test_behaviors.push(evidence(file.path, 1, 'test file observed: ' + file.path, 'heuristic'))
  }
}

function addCallChains(snapshot: ArchitectureSnapshot, file: ReadableFile): void {
  if (!file.ok) return
  const lines = linesOf(file)
  const imports = lines
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => EXTERNAL_IMPORT_RE.test(line) || /^\s*(import|from)\s+/.test(line))
  const boundary = snapshot.external_boundaries.filter((item) => item.path === file.path)
  const firstImport = imports[0]
  const firstBoundary = boundary[0]
  if (ENTRY_RE.test(file.path) && firstImport !== undefined) {
    snapshot.call_chain.push(evidence(file.path, firstImport.index, 'entry ' + file.path + ' -> imported module: ' + firstImport.line, 'observed'))
  }
  if (ENTRY_RE.test(file.path) && firstBoundary !== undefined) {
    snapshot.call_chain.push(evidence(file.path, firstBoundary.start_line, 'entry ' + file.path + ' -> external boundary: ' + firstBoundary.evidence, 'heuristic'))
  }
}

export function extractArchitecture(files: ReadableFile[], tree?: TreeLike): ArchitectureSnapshot {
  const snapshot: ArchitectureSnapshot = {
    entry_points: [],
    dependencies: [],
    routes_commands: [],
    data_models: [],
    call_chain: [],
    external_boundaries: [],
    test_behaviors: [],
    unknowns: [],
  }
  for (const file of files) {
    addEntryPoints(snapshot, file)
    addManifestDependencies(snapshot, file)
    addRoutesCommands(snapshot, file)
    addDataModels(snapshot, file)
    addExternalBoundaries(snapshot, file)
    addTests(snapshot, file)
  }
  for (const file of files) addCallChains(snapshot, file)

  if (tree?.truncated === true) addUnknown(snapshot, 'tree', 'GitHub truncated the tree; absence of a path is not evidence of absence')
  if (tree !== undefined && tree.entries.length === 0) addUnknown(snapshot, 'tree', 'no tree entries were available')
  if (snapshot.entry_points.length === 0) addUnknown(snapshot, 'entry_points', 'no entry evidence in the files returned')
  if (snapshot.dependencies.length === 0) addUnknown(snapshot, 'dependencies', 'no direct dependency declaration was readable')
  if (snapshot.routes_commands.length === 0) addUnknown(snapshot, 'routes_commands', 'no route or command registration was observed')
  if (snapshot.data_models.length === 0) addUnknown(snapshot, 'data_models', 'no model declaration was observed')
  if (snapshot.call_chain.length === 0) addUnknown(snapshot, 'call_chain', 'no conservative two-hop chain was observed')
  if (snapshot.external_boundaries.length === 0) addUnknown(snapshot, 'external_boundaries', 'no external boundary was observed')
  if (snapshot.test_behaviors.length === 0) addUnknown(snapshot, 'test_behaviors', 'no test behavior was observed')
  return snapshot
}

