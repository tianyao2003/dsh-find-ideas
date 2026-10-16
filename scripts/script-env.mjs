// Where the package is, and how to get a token, for scripts in this directory.
//
// WHY THIS FILE EXISTS
// --------------------
// A set of verification scripts used to hardcode one developer's profile
// directory and `.credentials.yaml` path under their home directory.
// That made them unrunnable anywhere else, and a verification script that cannot
// run on a fresh checkout is not verification — it is a note about one machine at
// one moment.
//
// The machine-specific facts are exactly two, so they are resolved in one place
// rather than seven:
//
//   1. WHERE THE PLUGIN IS. These scripts live in the package's own `scripts/`,
//      so the package root is simply this file's parent. Scripts that
//      deliberately test the *installed* copy still need the profile path, but
//      now they ASK for it and get a clear error when it is absent, instead of
//      failing on a hardcoded path that belongs to one person's laptop.
//
//   2. WHETHER A TOKEN EXISTS. The token only raises the search quota; it is not
//      a correctness input for the selection checks. Scripts that merely pass one
//      through now work anonymously. Scripts that genuinely require an
//      authenticated run say so and skip loudly rather than silently reporting a
//      weaker result as a pass.
//
// Usage:
//   import { pkgRoot, loadPlugin, loadPackageFile, readToken, dshHome } from './script-env.mjs'

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This directory (`<pkg>/scripts`) — this file's own location. */
export const scriptsRoot = dirname(fileURLToPath(import.meta.url))

/** The package under test, resolved by path rather than by install. */
export const pkgRoot = join(scriptsRoot, '..')

/** The DSH home directory: the real one unless DSH_HOME overrides it. */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return home ? join(home, '.dsh') : ''
}

/**
 * Read GITHUB_TOKEN from the credentials file, if there is one.
 *
 * @returns the token, or `undefined`. Never throws: a machine without a
 *   credentials file is a normal machine, not an error.
 */
export function readToken() {
  try {
    const home = dshHome()
    if (home === '') return undefined
    const file = join(home, '.credentials.yaml')
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8')
    // The refs block is a flat `NAME: value` mapping. Handles a quoted value too.
    const line = text.split(/\r?\n/).find((l) => /^\s*GITHUB_TOKEN\s*:/.test(l))
    if (line === undefined) return undefined
    const raw = line.slice(line.indexOf(':') + 1).trim()
    const unquoted = raw.replace(/^["']|["']$/g, '')
    return unquoted.length > 0 ? unquoted : undefined
  } catch {
    return undefined
  }
}

/**
 * Load the plugin from the workspace checkout (the source under test).
 *
 * This is what a script should use unless it is specifically testing the
 * INSTALLED copy — see `loadInstalled` for that.
 *
 * @returns the plugin module.
 */
export function loadPlugin() {
  const entry = join(pkgRoot, 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(
      `No build at ${entry}. Run "npm run build" in ${pkgRoot} first — ` +
        'the scripts test the compiled output, not the TypeScript source.',
    )
  }
  return import(pathToFileURL(entry).href)
}

/**
 * Load any file relative to the package root.
 *
 * @param rel - path inside the package, e.g. `lib/github.js`.
 */
export function loadPackageFile(rel) {
  const target = join(pkgRoot, rel)
  if (!existsSync(target)) {
    throw new Error(`Missing ${target}. Run "npm run build" in ${pkgRoot} first.`)
  }
  return import(pathToFileURL(target).href)
}

/**
 * Locate the INSTALLED copy of the plugin through a DSH profile.
 *
 * Only the scripts that test the installed path should call this. Everything
 * else should use `loadPlugin`, which needs nothing but this checkout.
 *
 * @param profileName - profile to resolve through, default `desktop`.
 * @returns the module.
 */
export function loadInstalled(profileName = 'desktop') {
  const home = dshHome()
  if (home === '') {
    throw new Error('Cannot find a DSH home: set DSH_HOME or ensure USERPROFILE/HOME is set.')
  }
  const profile = join(home, 'profiles', profileName)
  if (!existsSync(profile)) {
    throw new Error(
      `No DSH profile at ${profile}.\n` +
        '  This script checks an INSTALLED plugin. Either install dsh-find-ideas into ' +
        `that profile, or pass a different profile name.`,
    )
  }
  const require_ = createRequire(join(profile, 'package.json'))
  let resolved
  try {
    resolved = require_.resolve('dsh-find-ideas')
  } catch {
    throw new Error(
      `dsh-find-ideas is not installed in profile "${profileName}" (${profile}).\n` +
        '  Install it there first, or use loadPlugin() to test this checkout instead.',
    )
  }
  return import(pathToFileURL(resolved).href)
}

/**
 * Build the `credentials` service stub the plugin expects.
 *
 * The plugin resolves the token through `ctx.get('credentials').resolve(ref)`,
 * so a stub must honour that shape exactly: returning `{ value }` for the ref it
 * was given and `undefined` for anything else.
 *
 * @param token - the token to hand out, or `undefined` for an anonymous run.
 * @returns a service object suitable for a fake context.
 */
export function credentialStub(token) {
  return {
    resolve: async (ref) =>
      ref === 'GITHUB_TOKEN' && token !== undefined ? { value: token } : undefined,
  }
}

/**
 * Build a fake plugin context that registers tools into a Map.
 *
 * @param options - `token` to expose a credential, `tools` to collect definitions.
 * @returns the context, plus the Map it fills.
 */
export function fakeContext({ token } = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    get: (name) => (name === 'credentials' ? credentialStub(token) : undefined),
  }
  return { ctx, tools }
}
