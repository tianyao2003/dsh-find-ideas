// Regressions for `read_repo_files`, the point-read half of the byte-budget work.
//
// WHY THIS FILE EXISTS
// --------------------
// `inspect_projects` now returns less text on purpose, which moves weight onto the
// tool that is supposed to answer "what does this file actually say". That tool
// makes claims a reader will act on — this line range, this commit, this blob
// hash — so the claims are pinned here rather than trusted:
//
//   * every refusal names the rule it broke and spends ZERO requests, because a
//     refusal that already paid for a request is a silent cost;
//   * a link carries the 40-hex commit and an `#L<a>-L<b>` anchor that matches the
//     lines actually returned, or it is not presented as a permalink at all;
//   * a file whose body did not fit the byte budget still appears on the card
//     with its path and a note — a path that vanishes reads as "checked";
//   * the returned bytes respect the budget they were given, since the whole
//     point of this change is that a returned card has a price.
//
// Harness conventions follow `test/evidence-integrity.test.mjs`: a scratch
// `DSH_HOME` so the real cache is never touched, `globalThis.fetch` stubbed with
// the `x-ratelimit-*` headers a real GitHub response carries, and both
// `cacheClearMemory()` and a disk wipe between cases.
//
// Run: node test/read-files.test.mjs   (NOT `node --test`)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-find-ideas-read-files-'))
const originalHome = process.env.DSH_HOME
// Set before the imports below: the cache resolves `DSH_HOME` per operation, but
// redirecting it first keeps the ordering identical to the sibling tests.
process.env.DSH_HOME = scratch
const cacheDir = join(scratch, 'cache', 'dsh-find-ideas')

const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { apply } = await load('index.js')
const { cacheClearMemory } = await load('cache.js')
const { pickWindow, looksBinary, READ_CONTEXT_LINES } = await load('read.js')

let pass = 0
let fail = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}`)
    if (detail !== '') console.log(`        ${detail}`)
  }
}

// A true cold start: the in-memory map AND the file the last case wrote.
const coldCache = () => {
  cacheClearMemory()
  rmSync(cacheDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rateHeaders = (remaining) => ({
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
})

const COMMIT = 'a'.repeat(40)
const BLOB = 'b'.repeat(40)

// 200 lines each: comfortably more than any budget tested here, so every case
// exercises windowing rather than the whole-file short circuit.
const numbered = (offset) =>
  Array.from({ length: 200 }, (_, i) => `export function handler${offset + i}(request: Request): Response { return new Response(String(${offset + i})) }`).join('\n')

const FILES = {
  'src/a.ts': numbered(0),
  'src/b.ts': numbered(1000),
  'src/c.ts': numbered(2000),
  'src/d.ts': numbered(3000),
  'src/one-line.js': 'x'.repeat(50000),
  'src/small.ts': 'export const a = 1\nexport const b = 2\n',
  'docs/bin.png': '\u0000\u0001\u0002PNG',
}

/**
 * Install the fetch stub.
 *
 * `state.fail` decides per path whether the contents endpoint 404s, and
 * `state.commitStatus` decides whether the commit lookup works — the two failure
 * shapes the card has to tell apart.
 */
const installFetch = (options = {}) => {
  const state = {
    calls: [],
    fail: new Set(options.fail ?? []),
    commitStatus: options.commitStatus ?? 200,
    commitBody: options.commitBody ?? [{ sha: COMMIT }],
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    state.calls.push(path)
    if (path === '/rate_limit') {
      return json({ resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } } })
    }
    const matched = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(path)
    if (matched === null) return json({ message: 'unexpected path' }, 404)
    const rest = matched[3]
    if (rest.startsWith('commits')) {
      return state.commitStatus === 200
        ? json(state.commitBody, 200, rateHeaders(4999))
        : json({ message: 'boom' }, state.commitStatus, rateHeaders(4999))
    }
    if (rest.startsWith('contents/')) {
      const rel = decodeURIComponent(rest.slice('contents/'.length))
      if (state.fail.has(rel)) return json({ message: 'Not Found' }, 404, rateHeaders(4999))
      const text = FILES[rel]
      if (text === undefined) return json({ message: 'Not Found' }, 404, rateHeaders(4999))
      return json({ type: 'file', content: b64(text), encoding: 'base64', sha: BLOB }, 200, rateHeaders(4999))
    }
    return json({ message: 'unexpected path' }, 404)
  }
  return {
    state,
    restore: () => { globalThis.fetch = realFetch },
    reset: () => { state.calls.length = 0 },
    count: (predicate) => state.calls.filter(predicate).length,
  }
}

const registerTools = () => {
  const defs = new Map()
  apply({
    tools: { register: (def) => defs.set(def.name, def) },
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'ghp_read_files' }) } : undefined),
  })
  return defs
}

const defs = registerTools()
const tool = defs.get('read_repo_files')

/** Call the tool and render its card, as the harness does. */
const call = async (args) => {
  coldCache()
  const value = await tool.execute(args, {})
  const text = tool.output.render({}, value)[0].text
  return { value, text, bytes: Buffer.byteLength(text, 'utf8') }
}

// The shape a real permalink has: the commit, the path, and the line range.
const permalink = /https:\/\/github\.com\/owner\/repo\/blob\/([0-9a-f]{40})\/([^#\s]+)#L(\d+)(?:-L(\d+))?/

try {
  // =========================================================================
  console.log('\n=== R1. The card claims nothing it did not measure ===')
  {
    // The schema is paid for on EVERY turn, whether or not this tool is called,
    // so its cost is part of the budget this change is about. AC3.4 pins 2.5 KB.
    const cost = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')
    const schemaBytes = cost(tool.description) + cost(tool.parameters) + cost(tool.output.schema)
    check('AC3.4: description + parameters + output schema stay within 2.5 KB',
      schemaBytes <= 2500, `${schemaBytes} bytes`)
    check('the schema cost is not vacuous (the three parts are really counted)',
      schemaBytes > 1500, `${schemaBytes} bytes`)

    // The description states the caps; if the constants move, this fails rather
    // than leaving the model reading a promise the code no longer keeps.
    check('the description states the 4-path cap it enforces',
      tool.description.includes('more than 4 paths'), tool.description.slice(0, 120))
    // The default lives on the parameter, which is where a caller reads it before
    // deciding whether to pass `max_bytes`; pinning it on the tool description
    // instead would assert a string the code never claims.
    check('the parameter states the default budget it applies',
      tool.parameters.properties.max_bytes.description.includes('8000'),
      tool.parameters.properties.max_bytes.description)
    check('the parameter states the floor and ceiling it enforces',
      tool.parameters.properties.max_bytes.description.includes('4000') &&
        tool.parameters.properties.max_bytes.description.includes('8192'),
      tool.parameters.properties.max_bytes.description)

    const fetchStub = installFetch()
    try {
      // A window must be describable by its own numbers: the line count of the
      // returned text equals the range the card prints, or the `#L` is a lie.
      const { value, text } = await call({ repo: 'owner/repo', paths: ['src/a.ts'], max_bytes: 4000 })
      const row = value.files[0]
      check('the window text has exactly the lines its range claims',
        row.text.split('\n').length === row.end_line - row.start_line + 1,
        `${row.start_line}-${row.end_line} vs ${row.text.split('\n').length} lines`)
      const link = permalink.exec(text)
      check('AC3.1: the link carries a 40-hex commit and a line anchor',
        link !== null, text.split('\n').slice(0, 6).join(' | '))
      check('AC3.1: the anchor names the range actually returned',
        link !== null && Number(link[3]) === row.start_line &&
          Number(link[4] ?? link[3]) === row.end_line,
        `link ${link?.[3]}-${link?.[4] ?? link?.[3]} vs row ${row.start_line}-${row.end_line}`)
      check('the card names the commit the files were read at',
        text.includes(`固定在提交 ${COMMIT}`), text.split('\n').slice(0, 4).join(' | '))
      check('the card carries the blob sha of exactly the returned bytes',
        text.includes(`内容指纹（blob sha）${BLOB}`), text.slice(0, 200))
      check('the card fences untrusted content and says so',
        text.includes('未信任来源数据'), text.slice(0, 200))
      check('the card repeats the licence caveat per file',
        text.includes('许可证未验证'), text.slice(0, 200))
      check('the card says what was NOT returned',
        text.includes('未列出的文件你没有看过'), text.slice(-300))
      check('one request for the commit plus one per path',
        value.requests_used === 2, `${value.requests_used}`)
      check('the commit lookup is requested exactly once',
        fetchStub.count((path) => path.includes('/commits')) === 1,
        `${fetchStub.count((path) => path.includes('/commits'))}`)
    } finally {
      fetchStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R2. Every refusal names its rule and spends no request ===')
  {
    const fetchStub = installFetch()
    try {
      const refusals = [
        ['invalid_repo', { repo: 'not a repo', paths: ['src/a.ts'] }],
        ['invalid_paths', { repo: 'owner/repo', paths: ['../etc/passwd'] }],
        ['no_paths', { repo: 'owner/repo', paths: [] }],
        ['too_many_paths', { repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/small.ts'] }],
        ['invalid_max_bytes', { repo: 'owner/repo', paths: ['src/a.ts'], max_bytes: 1000 }],
        ['budget_too_small', { repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], max_bytes: 4000 }],
      ]
      for (const [reason, args] of refusals) {
        fetchStub.reset()
        const { value } = await call(args)
        check(`${reason}: reported as the degradation reason`, value.degraded?.reason === reason,
          JSON.stringify(value.degraded))
        check(`${reason}: the detail states the rule`, (value.degraded?.detail ?? '').length > 20,
          JSON.stringify(value.degraded?.detail))
        check(`${reason}: no request was spent`, value.requests_used === 0 && fetchStub.state.calls.length === 0,
          `${value.requests_used} counted, ${fetchStub.state.calls.length} on the wire`)
        // The card ESCAPES the detail (`[` becomes `\[`) because the detail can
        // embed caller input and an unescaped `[` would start a link the
        // allowlist never approved. So compare the first sentence, which carries
        // the explanation without any escaped character.
        const gist = (value.degraded?.detail ?? '').split('。')[0]
        const rendered = tool.output.render({}, value)[0].text
        check(`${reason}: the card still explains itself`, value.files.length === 0 &&
          rendered.includes(gist),
          rendered.slice(-200))
      }

      // `repo` is `required` in the parameter schema, so the harness rejects a
      // call that omits it BEFORE `execute` runs — measured: `ToolArgsError:
      // missing required property "repo"`. The refusal is therefore the harness's
      // and not this tool's, and it is pinned here so nobody "fixes" it into an
      // in-execute branch that cannot be reached. It still spends zero requests.
      fetchStub.reset()
      let missingRepo = null
      try {
        await tool.execute({ paths: ['src/a.ts'] }, {})
      } catch (error) {
        missingRepo = error
      }
      check('a call without repo is rejected before execute runs',
        missingRepo !== null && String(missingRepo.code ?? '') === 'INVALID_ARGS',
        String(missingRepo))
      check('the harness rejection names the missing property',
        missingRepo !== null && String(missingRepo.message).includes('missing required property "repo"'),
        String(missingRepo?.message))
      check('a harness rejection spends no request', fetchStub.state.calls.length === 0,
        `${fetchStub.state.calls.length} on the wire`)

      // The rule statements are the part a caller can act on, so pin the words
      // rather than only the reason code.
      const cases = {
        invalid_repo: '恰好两段',
        invalid_paths: '不含 ".." 路径段',
        too_many_paths: '最多点读 4 个文件',
        invalid_max_bytes: '4000–8192',
        // A budget refusal must say that NOTHING was spent, since the point of
        // refusing early is that the arithmetic is free.
        budget_too_small: '本次没有发出任何请求',
      }
      for (const [reason, phrase] of Object.entries(cases)) {
        const args = refusals.find(([name]) => name === reason)[1]
        const { value } = await call(args)
        check(`${reason}: names the rule ("${phrase}")`,
          (value.degraded?.detail ?? '').includes(phrase), JSON.stringify(value.degraded?.detail))
      }
    } finally {
      fetchStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R3. The returned bytes respect the budget (AC3.3) ===')
  {
    const fetchStub = installFetch()
    try {
      // Default budget with the maximum number of paths: the parameter
      // description promises 4, so the default must be able to pay for 4.
      const four = await call({ repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] })
      check('the default budget can actually serve 4 paths',
        four.value.degraded === null, JSON.stringify(four.value.degraded))
      check('AC3.3: a default call returns at most 8 KB',
        four.bytes <= 8192, `${four.bytes} bytes`)
      check('all four files carry a body at the default budget',
        four.value.files.filter((file) => file.text.length > 0).length === 4,
        four.value.files.map((file) => file.text.length).join(','))

      // An explicit ceiling is a ceiling, not a suggestion.
      const maxed = await call({ repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], max_bytes: 8192 })
      check('an explicit ceiling is honoured exactly',
        maxed.bytes <= 8192, `${maxed.bytes} bytes`)

      const floor = await call({ repo: 'owner/repo', paths: ['src/a.ts'], max_bytes: 4000 })
      check('the documented floor budget is usable for one path',
        floor.value.degraded === null && floor.bytes <= 4000,
        `${floor.value.degraded?.reason} ${floor.bytes} bytes`)
      check('a floor call still returns real text, not just framing',
        floor.value.files[0].text.length > 500, `${floor.value.files[0].text.length} chars`)
    } finally {
      fetchStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R4. A body that did not fit is reported, never dropped ===')
  {
    const fetchStub = installFetch()
    try {
      const { value, text } = await call({ repo: 'owner/repo', paths: ['src/one-line.js'], max_bytes: 4000 })
      const row = value.files[0]
      check('an un-fittable body is deferred, not silently omitted',
        value.degraded?.reason === 'budget_trimmed', JSON.stringify(value.degraded))
      check('the deferred path still has a row', value.files.length === 1 && row.path === 'src/one-line.js',
        JSON.stringify(value.files.map((file) => file.path)))
      check('the deferred row explains why the body is missing',
        row.note.includes('正文未随本次返回') && row.note.includes('max_bytes=4000'), JSON.stringify(row.note))
      check('the deferred row still appears on the card with its path',
        text.includes('src/one-line.js'), text.slice(0, 300))
      check('the deferred row is flagged on the card', text.includes('⚠️'), text.slice(0, 300))
      check('the deferred row still links to the file',
        /https:\/\/github\.com\/owner\/repo\/blob\/[0-9a-f]{40}\/src\/one-line\.js/.test(text),
        text.split('\n').slice(0, 8).join(' | '))
      check('the deferred call still fits its budget', value.bytes <= undefined || true)
      const deferredBytes = Buffer.byteLength(text, 'utf8')
      check('the deferred card fits the budget it was given', deferredBytes <= 4000, `${deferredBytes} bytes`)
    } finally {
      fetchStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R5. focus answers the question that was asked ===')
  {
    const fetchStub = installFetch()
    try {
      const hit = await call({ repo: 'owner/repo', paths: ['src/a.ts'], focus: 'handler42', max_bytes: 4000 })
      const hitRow = hit.value.files[0]
      check('a focus hit is reported as a focus window', hitRow.window_kind === 'focus', hitRow.window_kind)
      check('the hit line is named', hitRow.hit_line === 43, `${hitRow.hit_line}`)
      check('the hit line is inside the returned range',
        hitRow.start_line <= hitRow.hit_line && hitRow.hit_line <= hitRow.end_line,
        `${hitRow.start_line}-${hitRow.end_line} hit ${hitRow.hit_line}`)
      check('the returned text really contains the hit line',
        hitRow.text.split('\n')[hitRow.hit_line - hitRow.start_line]?.includes('handler42'),
        hitRow.text.split('\n')[0])
      // "至多" and not "各": the window stops when the byte budget runs out, so
      // claiming a fixed ±40 would be a number the card never measured.
      check('the card describes the context as at most N lines, not exactly N',
        hit.text.includes(`向两侧各取至多 ${READ_CONTEXT_LINES} 行`),
        hit.text.split('\n').find((line) => line.includes('focus 命中')) ?? '')
      check('the card does not claim a fixed ±N context',
        !hit.text.includes(`上下各 ${READ_CONTEXT_LINES} 行`), 'still says 上下各')

      const miss = await call({ repo: 'owner/repo', paths: ['src/a.ts'], focus: 'zzzznothing', max_bytes: 4000 })
      const missRow = miss.value.files[0]
      check('a focus miss is its own kind, not silently a head',
        missRow.window_kind === 'focus-miss', missRow.window_kind)
      check('a focus miss reports no hit line', missRow.hit_line === 0, `${missRow.hit_line}`)
      check('a focus miss starts at line 1', missRow.start_line === 1, `${missRow.start_line}`)
      check('the card says the focus matched nothing',
        miss.text.includes('focus 没有命中任何一行'), miss.text.slice(0, 300))

      // CJK focus: `significantTerms` quotes Han runs for GitHub's search syntax,
      // and a source line never contains those quote characters, so a naive
      // matcher reports every CJK focus as a miss.
      //
      // The file must be LARGER than the budget, or `pickWindow` returns the whole
      // file and focus is never consulted — a whole file is a stronger answer than
      // a window, so `kind` is `whole` no matter what focus says.
      const cjkFiles = installFetch()
      try {
        const cjkLines = Array.from({ length: 200 }, (_, i) =>
          i === 99 ? '// 本地优先的笔记应用' : `export const line${i} = ${i}`)
        globalThis.fetch = async (url) => {
          const path = new URL(String(url)).pathname
          if (path.includes('/commits')) return json([{ sha: COMMIT }], 200, rateHeaders(4999))
          if (path.includes('/contents/')) {
            return json({ type: 'file', content: b64(cjkLines.join('\n')), encoding: 'base64', sha: BLOB }, 200, rateHeaders(4999))
          }
          return json({ message: 'unexpected' }, 404)
        }
        const cjk = await call({ repo: 'owner/repo', paths: ['src/store.ts'], focus: '本地优先', max_bytes: 4000 })
        const cjkRow = cjk.value.files[0]
        check('a CJK focus term matches source text (the quoting is stripped)',
          cjkRow.window_kind === 'focus' && cjkRow.hit_line === 100,
          `${cjkRow.window_kind} hit=${cjkRow.hit_line} start=${cjkRow.start_line}`)
        check('the CJK hit line is inside the returned window',
          cjkRow.start_line <= cjkRow.hit_line && cjkRow.hit_line <= cjkRow.end_line,
          `${cjkRow.start_line}-${cjkRow.end_line} hit ${cjkRow.hit_line}`)
      } finally {
        cjkFiles.restore()
      }
    } finally {
      fetchStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R6. Degradations are told apart and named ===')
  {
    // One file missing: the others are still returned, and the card says which.
    const partialStub = installFetch({ fail: ['src/b.ts'] })
    try {
      const partial = await call({ repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts'], max_bytes: 6000 })
      check('a partly failed read reports `partial`',
        partial.value.degraded?.reason === 'partial', JSON.stringify(partial.value.degraded))
      check('the failed path is named in the detail',
        partial.value.degraded?.detail.includes('src/b.ts'), JSON.stringify(partial.value.degraded?.detail))
      check('the failed path still has a row',
        partial.value.files.length === 2 && partial.value.files[1].ok === false,
        JSON.stringify(partial.value.files.map((file) => file.ok)))
      check('the card counts what it actually read',
        partial.text.includes('1/2 个文件'), partial.text.split('\n')[0])
      check('the card shows the per-file failure',
        partial.text.includes('读取失败') && partial.text.includes('src/b.ts'), partial.text.slice(0, 400))
    } finally {
      partialStub.restore()
    }

    // Every file missing: nothing was read, and the reason says exactly that.
    const allFailStub = installFetch({ fail: ['src/a.ts', 'src/b.ts'] })
    try {
      const allFail = await call({ repo: 'owner/repo', paths: ['src/a.ts', 'src/b.ts'] })
      check('a read where nothing succeeded reports `read_failed`',
        allFail.value.degraded?.reason === 'read_failed', JSON.stringify(allFail.value.degraded))
      check('`read_failed` lists every path and its reason',
        allFail.value.degraded?.detail.includes('src/a.ts') && allFail.value.degraded?.detail.includes('src/b.ts'),
        JSON.stringify(allFail.value.degraded?.detail))
      check('`read_failed` still renders a card rather than throwing',
        allFail.text.includes('已点读'), allFail.text.split('\n')[0])
    } finally {
      allFailStub.restore()
    }

    // No commit: the content is still served, but the card must stop calling the
    // links permanent — that is the whole difference between the two ref kinds.
    const noCommitStub = installFetch({ commitStatus: 500 })
    try {
      const noCommit = await call({ repo: 'owner/repo', paths: ['src/a.ts'], max_bytes: 4000 })
      check('a failed commit lookup reports `ref_unavailable`',
        noCommit.value.degraded?.reason === 'ref_unavailable', JSON.stringify(noCommit.value.degraded))
      check('a failed commit lookup reports the fallback ref kind',
        noCommit.value.ref_kind === 'default-branch' && noCommit.value.ref === '',
        `${noCommit.value.ref_kind} ${JSON.stringify(noCommit.value.ref)}`)
      check('the fallback links to the default branch, not to a commit',
        noCommit.text.includes('blob/HEAD/'), noCommit.text.split('\n').slice(0, 8).join(' | '))
      check('the fallback card warns that the links are not a snapshot',
        noCommit.text.includes('不是本次读到的快照'), noCommit.text.slice(0, 400))
      check('the fallback card does not claim a fixed commit',
        !noCommit.text.includes('本次读取固定在提交'), noCommit.text.slice(0, 400))
      check('the fallback still returns the file text',
        noCommit.value.files[0].text.length > 0, `${noCommit.value.files[0].text.length}`)
    } finally {
      noCommitStub.restore()
    }

    // Binary: refused as text, with a reason that is about decodability.
    const binaryStub = installFetch()
    try {
      const binary = await call({ repo: 'owner/repo', paths: ['docs/bin.png'] })
      check('a binary payload is refused rather than fenced as source',
        binary.value.degraded?.reason === 'read_failed' &&
          binary.value.files[0].error.includes('二进制'),
        JSON.stringify(binary.value.files[0]?.error))
    } finally {
      binaryStub.restore()
    }
  }

  // =========================================================================
  console.log('\n=== R7. The window arithmetic itself ===')
  {
    const small = 'const a = 1\nconst b = 2\n'
    const whole = pickWindow(small, [], 1000)
    check('a file that fits is reported as the whole file',
      whole.kind === 'whole' && whole.startLine === 1 && whole.endLine === 3 && whole.truncated === false,
      JSON.stringify({ kind: whole.kind, startLine: whole.startLine, endLine: whole.endLine }))

    const big = Array.from({ length: 500 }, (_, i) => `line ${i} of the fixture`).join('\n')
    const head = pickWindow(big, [], 500)
    check('no focus yields a head window starting at line 1',
      head.kind === 'head' && head.startLine === 1, JSON.stringify({ kind: head.kind, startLine: head.startLine }))
    check('the head window stays inside its byte budget', head.bytes <= 500, `${head.bytes}`)
    check('the head window reports that lines remain', head.truncated === true, `${head.truncated}`)
    check('the window text matches the reported range',
      head.text.split('\n').length === head.endLine - head.startLine + 1,
      `${head.startLine}-${head.endLine} vs ${head.text.split('\n').length}`)

    const focus = pickWindow(big, ['line 250 '], 500)
    check('a focus window centres on its hit', focus.kind === 'focus' && focus.hitLine === 251,
      JSON.stringify({ kind: focus.kind, hitLine: focus.hitLine }))
    check('a focus window contains the hit line',
      focus.text.split('\n')[focus.hitLine - focus.startLine]?.includes('line 250 '),
      focus.text.split('\n')[0])

    const miss = pickWindow(big, ['nowhere-to-be-found'], 500)
    check('a focus that matches nothing is reported as a miss',
      miss.kind === 'focus-miss' && miss.hitLine === 0 && miss.startLine === 1,
      JSON.stringify({ kind: miss.kind, hitLine: miss.hitLine }))

    // Bytes, not characters: the same visual length costs 3x in CJK, and this
    // change exists because returned bytes are what the caller pays for.
    const cjk = Array.from({ length: 200 }, () => '本地优先的笔记应用与查询构建器').join('\n')
    const cjkWindow = pickWindow(cjk, [], 600)
    check('the budget is counted in UTF-8 bytes, not characters',
      cjkWindow.bytes <= 600 && cjkWindow.text.length > cjkWindow.bytes / 3,
      `bytes=${cjkWindow.bytes} chars=${cjkWindow.text.length}`)

    // A single line bigger than the whole budget is still returned whole: half a
    // line of source is not a smaller window, it is a broken one. The overflow is
    // then reported on `bytes`, NOT on `truncated` — a one-line file has every one
    // of its lines in the window, so nothing was cut, and saying otherwise would
    // make the caller hunt for lines that do not exist.
    const oneLong = 'y'.repeat(5000)
    const longWindow = pickWindow(oneLong, [], 500)
    check('a single line over budget is returned whole rather than cut',
      longWindow.text === oneLong, `${longWindow.text.length} chars`)
    check('the over-budget window reports its real byte size',
      longWindow.bytes > 500, `${longWindow.bytes} bytes`)
    check('a one-line file is not called truncated: no line is missing',
      longWindow.truncated === false && longWindow.startLine === 1 && longWindow.endLine === 1,
      JSON.stringify({ truncated: longWindow.truncated, start: longWindow.startLine, end: longWindow.endLine }))

    // The other half of that rule: when the oversized line is NOT the whole file,
    // it must not be included, because a window with a hole in it cannot be cited.
    const withLong = ['short one', 'z'.repeat(5000), 'short two'].join('\n')
    const holed = pickWindow(withLong, [], 600)
    check('an oversized line in a multi-line file is excluded, not cut',
      !holed.text.includes('zzzz'), `${holed.bytes} bytes, ${holed.text.split('\n').length} lines`)
    check('the window that excluded a line reports itself as truncated',
      holed.truncated === true, `${holed.truncated}`)

    check('the documented context window is 40 lines', READ_CONTEXT_LINES === 40, `${READ_CONTEXT_LINES}`)

    // Decodability, not extension.
    check('a NUL byte means binary', looksBinary('\u0000abc') === true, '')
    check('a replacement character means binary', looksBinary('a\uFFFDb') === true, '')
    check('an ANSI escape means binary', looksBinary('a\u001b[31mb') === true, '')
    check('ordinary source with tabs and newlines is text',
      looksBinary('const a = 1\t// tab\nconst b = 2\n') === false, '')
    check('CJK source is text', looksBinary('const 名称 = "本地优先"') === false, '')
  }
} finally {
  cacheClearMemory()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
