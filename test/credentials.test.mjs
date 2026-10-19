// Behavioural test for the GitHub-token configuration path.
//
// WHAT THIS PINS DOWN
// -------------------
// `src/credentials.ts` writes a secret into the host's credential store. Three
// properties have to hold or the feature is worse than not having it:
//
//   1. THE VALUE NEVER COMES BACK OUT. `describe()` is the status channel and
//      structurally has no value field; every message this module returns is
//      asserted to be token-free, including the failure paths. A leak in an
//      error message is still a leak.
//   2. THE DOCUMENTED HARD RULES ARE HANDLED, NOT DISCOVERED. An empty value is
//      refused BEFORE the store is touched (the real store throws on it, and a
//      throw reads as a backend fault). A read-only, environment-supplied
//      credential produces an explanation instead of an opaque rejection.
//   3. IT DEGRADES HONESTLY. A host with no writable store says so; a store that
//      fails surfaces the underlying reason rather than reporting success.
//
// The stub below is built from the OBSERVED semantics of the real store
// (`@deepseek-ai/dsh-credentials-local`'s LocalCredentialProvider), read from its
// source: resolve -> undefined (not null) on a miss; describe -> never the value;
// set -> rejects an empty string; an inherited value reports writable: false.
//
// WHY THIS MODULE IS NOT A REGISTERED TOOL is documented at the top of
// src/credentials.ts. C4 below asserts the absence, so wiring it up is a visible
// decision rather than an accidental one.
//
// Run with:  npm test
// Or directly: node test/credentials.test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const { configureGitHubToken, credentialServiceOf, GITHUB_TOKEN_REF } = await load('credentials.js')
const mod = await load('index.js')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`)
  }
}

// A short, obviously fake value. Every message assertion greps for it verbatim
// AND for its distinctive prefix, so a truncated echo cannot slip through.
const TOKEN = 'ghp_TESTONLY_do_not_leak_0123456789abcdef'
const PREFIX = 'ghp_TESTONLY'

/** A faithful stand-in for the host credentials service. */
function makeStore({ envValue } = {}) {
  const values = new Map()
  const calls = []
  return {
    calls,
    resolve(ref) {
      calls.push(['resolve', ref])
      if (envValue !== undefined) return Promise.resolve({ value: envValue, source: 'env' })
      const stored = values.get(ref)
      // undefined, not null — the real provider returns void 0 on a miss.
      return Promise.resolve(stored === undefined ? undefined : { value: stored, source: 'file' })
    },
    describe(ref) {
      calls.push(['describe', ref])
      if (envValue !== undefined) return Promise.resolve({ configured: true, source: 'env', writable: false })
      if (values.get(ref) !== undefined) return Promise.resolve({ configured: true, source: 'file', writable: true })
      return Promise.resolve({ configured: false, writable: true })
    },
    set(ref, value) {
      calls.push(['set', ref, value])
      if (value.length === 0) {
        return Promise.reject(new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`))
      }
      if (envValue !== undefined) {
        return Promise.reject(new Error(`credentials-local: "${ref}" is served by a read-only source`))
      }
      values.set(ref, value)
      return Promise.resolve()
    },
  }
}

/** Assert a result object carries no trace of the token anywhere. */
function leakFree(result) {
  const text = JSON.stringify(result)
  return !text.includes(TOKEN) && !text.includes(PREFIX)
}

// ---------------------------------------------------------------------------
console.log('\n=== C1. the happy path stores a token, and stores it once ===')
{
  const store = makeStore()
  const before = await store.describe(GITHUB_TOKEN_REF)
  check('unconfigured before the write', before.configured === false)
  check('reported writable before the write', before.writable === true)

  const result = await configureGitHubToken(store, TOKEN)
  check('the attempt reports success', result.ok === true, result.message)

  const resolved = await store.resolve(GITHUB_TOKEN_REF)
  check('the store resolves the token afterwards', resolved?.value === TOKEN)
  check('the store attributes it to the file', resolved?.source === 'file')

  const after = await store.describe(GITHUB_TOKEN_REF)
  check('describe() reports configured', after.configured === true)
  check('describe() structurally carries no value field',
    !('value' in after), JSON.stringify(after))
  check('set() was called exactly once with the ref',
    store.calls.filter((c) => c[0] === 'set').length === 1, JSON.stringify(store.calls))
}

console.log('\n=== C2. THE SECURITY PROPERTY: the value never reaches the output ===')
{
  const store = makeStore()
  const result = await configureGitHubToken(store, TOKEN)
  check('the success result is token-free', leakFree(result), JSON.stringify(result).slice(0, 200))
  check('the message is token-free', !result.message.includes(TOKEN) && !result.message.includes(PREFIX))
  check('the message still confirms the save', result.ok === true && /已保存/.test(result.message))
  check('the reported state carries no value',
    result.state === undefined || !('value' in result.state), JSON.stringify(result.state))

  // Failure paths are the easy place to leak, because the reflex is to include
  // the offending input in the error.
  const empty = await configureGitHubToken(makeStore(), '   ')
  check('the empty-input failure is token-free (no input echoed)',
    leakFree(empty) && !JSON.stringify(empty).includes('   '))
  const noStore = await configureGitHubToken(undefined, TOKEN)
  check('the no-store failure is token-free', leakFree(noStore), JSON.stringify(noStore).slice(0, 160))
  const throwing = await configureGitHubToken({
    describe: async () => ({ configured: false, writable: true }),
    set: async () => { throw new Error('credentials-local: the document is not writable (EACCES)') },
  }, TOKEN)
  check('the store-error failure is token-free', leakFree(throwing), JSON.stringify(throwing).slice(0, 160))
}

console.log('\n=== C3. the two documented hard rules are handled, not discovered ===')
{
  // Rule 1: an empty value is refused before the store is touched. The real
  // store THROWS on an empty value; letting it get that far would report a
  // backend fault where the truth is "you sent me nothing".
  const store = makeStore()
  for (const bad of ['', '   ', '\n\t ', '  \r\n ']) {
    const result = await configureGitHubToken(store, bad)
    check(`refuses ${JSON.stringify(bad)}`, result.ok === false)
  }
  check('set() was never reached for any of them',
    !store.calls.some((c) => c[0] === 'set'), JSON.stringify(store.calls))
  check('nothing was stored', (await store.describe(GITHUB_TOKEN_REF)).configured === false)

  // Rule 2: an inherited (launch-environment) value cannot be overwritten. The
  // refusal must name the real cause and point at the real fix, or the user is
  // left retrying a write that cannot succeed.
  const shadowed = makeStore({ envValue: 'from-launch-env' })
  const described = await shadowed.describe(GITHUB_TOKEN_REF)
  check('an env source reports writable:false', described.writable === false)

  const refused = await configureGitHubToken(shadowed, TOKEN)
  check('the attempt is refused rather than thrown', refused.ok === false)
  check('the refusal names the environment as the source',
    /环境变量/.test(refused.message), refused.message)
  check('the refusal gives the actual fix (clear the variable)',
    /清除/.test(refused.message), refused.message)
  check('the refusal does not blame the token itself',
    !/无效|invalid/i.test(refused.message), refused.message)
  check('set() was never called against a read-only source',
    !shadowed.calls.some((c) => c[0] === 'set'), JSON.stringify(shadowed.calls))
  check('the refusal is token-free', leakFree(refused))
}

console.log('\n=== C4. it is NOT registered as a tool (the exposure decision stays open) ===')
{
  // Registering it would put it in every agent's tool list, where it can be
  // called without the user asking. This asserts the current, deliberate
  // absence — if someone wires it up, this test fails loudly and they must
  // justify the change rather than inherit it.
  const defs = new Map()
  mod.apply({ tools: { register: (d) => defs.set(d.name, d) }, get: () => undefined })
  const names = [...defs.keys()]
  check('apply() registers the pipeline tools and nothing else',
    names.length === 4, names.join(', '))
  check('no token-configuring tool is exposed',
    !names.some((n) => /token|credential|configure/i.test(n)), names.join(', '))
  check('the four registered tools are the expected ones',
    ['scout_projects', 'rank_candidates', 'inspect_projects', 'read_repo_files'].every((n) => defs.has(n)), names.join(', '))
  check('the credential service is not part of the static inject list',
    !(mod.inject ?? []).includes('credentials'),
    JSON.stringify(mod.inject))
}

console.log('\n=== C5. service lookup tolerates every shape a host can present ===')
{
  const store = makeStore()
  const viaGet = credentialServiceOf({ get: (n) => (n === 'credentials' ? store : undefined) })
  check('finds the service through ctx.get', viaGet === store)
  check('returns undefined when the service is absent', credentialServiceOf({ get: () => undefined }) === undefined)
  check('returns undefined when there is no get at all', credentialServiceOf({}) === undefined)
  check('returns undefined for a null context', credentialServiceOf(null) === undefined)
  check('returns undefined for a primitive context', credentialServiceOf('credentials') === undefined)
  check('ignores a non-object service', credentialServiceOf({ get: () => 'nope' }) === undefined)
}

console.log('\n=== C6. a host without a writable store degrades honestly ===')
{
  const cases = [
    ['no service at all', undefined],
    ['a read-only service', { resolve: async () => undefined }],
    ['a service whose set is not a function', { set: 'nope' }],
  ]
  for (const [label, service] of cases) {
    const result = await configureGitHubToken(service, TOKEN)
    check(`${label}: reports it cannot save`, result.ok === false && /没有可写的凭据存储/.test(result.message))
    check(`${label}: suggests the environment-variable alternative`, /环境变量/.test(result.message))
    check(`${label}: does not echo the token`, leakFree(result))
  }

  const failing = await configureGitHubToken({
    describe: async () => ({ configured: false, writable: true }),
    set: async () => { throw new Error('credentials-local: the document is not writable (EACCES)') },
  }, TOKEN)
  check('a store error is surfaced, not swallowed',
    failing.ok === false && /EACCES/.test(failing.message), failing.message)
  check('a store error is not reported as success', failing.ok !== true)
}

console.log('\n=== C7. surrounding input is trimmed rather than stored verbatim ===')
{
  // Pasted tokens arrive with stray whitespace; the credential store would keep
  // it, and a token with a trailing newline fails authentication in a way that
  // looks like a bad token.
  const store = makeStore()
  await configureGitHubToken(store, `  ${TOKEN}\n`)
  const resolved = await store.resolve(GITHUB_TOKEN_REF)
  check('the stored value is the trimmed token', resolved?.value === TOKEN, JSON.stringify(resolved?.value))
  check('no surrounding whitespace was persisted',
    resolved?.value === resolved?.value?.trim())
}

console.log('\n=== C8. the ref matches the one the pipeline reads ===')
{
  // credentials.ts declares GITHUB_TOKEN_REF independently of index.ts so the
  // module stays host-free. If the two ever drift, the tool would write one
  // reference and every search would read another — a silent, total no-op.
  const indexSrc = readFileSync(join(pkgRoot, 'src', 'index.ts'), 'utf8')
  const declared = indexSrc.match(/GITHUB_TOKEN_REF\s*=\s*'([^']+)'/)?.[1]
  check('index.ts declares a token ref', typeof declared === 'string', String(declared))
  check('both modules agree on the reference name',
    declared === GITHUB_TOKEN_REF, `index=${declared} credentials=${GITHUB_TOKEN_REF}`)
  check('the ref is the host-conventional name',
    GITHUB_TOKEN_REF === 'GITHUB_TOKEN', GITHUB_TOKEN_REF)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
console.log(pass + fail === 0 ? '' : `\n=== ${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} ===`)
process.exit(fail === 0 ? 0 : 1)
