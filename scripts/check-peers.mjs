/**
 * Guard against the peer range silently ceasing to match the hosts that exist.
 *
 * Every DSH release is a prerelease, and node-semver only lets a prerelease
 * version satisfy a range that carries a prerelease on the *same*
 * major.minor.patch. So the range this package declared before this script
 * existed -- `>=0.1.0-rc.6` -- accepts `0.1.0-rc.6/7/8` and nothing else.
 * Measured against the 32 published `@deepseek-ai/dsh-tools` versions it
 * accepted 3, and it rejected `0.2.0-rc.2` -- which is the version the current
 * host line installs, because `@deepseek-ai/dsh-base@0.2.0-rc.2` pins
 * `dsh-tools` to exactly `0.2.0-rc.2`. A peer range that excludes the host that
 * is running does not warn anybody usefully; it trains people to ignore peer
 * warnings.
 *
 * One comparator cannot reach across a minor boundary, so the range has to name
 * every shipped line. This script keeps that honest: it resolves each current
 * host line from the registry, finds the `dsh-tools` version that line
 * installs, and fails when the declared range does not accept it -- so a new
 * host line is caught the day it ships rather than in a user's bug report.
 *
 * Two deliberate choices, both learned the hard way:
 *
 *  - It reads the registry over `fetch` rather than shelling out to
 *    `npm view`. The `execFile('npm', ...)` form fails on Windows twice over:
 *    `spawn npm ENOENT` (the binary is `npm.cmd`) and, once you correct for
 *    that, `spawn npm.cmd EINVAL` (Node refuses to exec a `.cmd` without a
 *    shell). Both were reproduced before this was written.
 *  - It reads the *host* lines, not `dsh-tools`' own `dist-tags`. That tag
 *    still points at `0.0.1-rc.1`, which no host has shipped for a long time;
 *    what matters is which `dsh-tools` the current hosts pull in.
 *
 * An unreachable registry is not a failure: the check reports `skipped` and
 * exits 0, because a network outage must not look like a bug in this package.
 * Run it from CI, where the registry is reachable.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const semver = require('semver')

const REGISTRY = 'https://registry.npmjs.org'
const HOST = '@deepseek-ai/dsh'
const BASE = '@deepseek-ai/dsh-base'
const TOOLS = '@deepseek-ai/dsh-tools'

/** Host dist-tags that name a line somebody is expected to be running. */
const HOST_TAGS = ['latest', 'next']

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peerRange = pkg.peerDependencies?.[TOOLS]
if (typeof peerRange !== 'string') {
  console.error(`check-peers: package.json declares no ${TOOLS} peer range`)
  process.exit(1)
}

async function packument(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    // The abbreviated document is the one installers get: same `dist-tags` and
    // same per-version `dependencies`, a fraction of the bytes.
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${name}`)
  return res.json()
}

/**
 * One entry per current host line, or undefined when the registry is
 * unreachable. `resolved` is the `dsh-tools` version that line installs.
 */
async function hostLines() {
  try {
    const [host, base, tools] = await Promise.all([packument(HOST), packument(BASE), packument(TOOLS)])
    const toolsVersions = Object.keys(tools.versions ?? {})
    if (toolsVersions.length === 0) throw new Error(`${TOOLS} published no versions`)

    const lines = []
    for (const tag of HOST_TAGS) {
      const dshVersion = host['dist-tags']?.[tag]
      if (typeof dshVersion !== 'string') continue
      if (lines.some((line) => line.dshVersion === dshVersion)) continue

      // The host packages ship lockstep, so dsh-base names the dsh-tools range
      // this line installs.
      const range = base.versions?.[dshVersion]?.dependencies?.[TOOLS]
      if (typeof range !== 'string') {
        lines.push({ tag, dshVersion, range: undefined, resolved: undefined })
        continue
      }
      lines.push({ tag, dshVersion, range, resolved: semver.maxSatisfying(toolsVersions, range) })
    }
    return { lines, toolsVersions }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.log(`check-peers: skipped -- registry unavailable (${detail})`)
    return undefined
  }
}

const registry = await hostLines()
if (registry === undefined) process.exit(0)
const { lines, toolsVersions } = registry

console.log(`peer range: ${peerRange}\n`)

const failures = []
for (const { tag, dshVersion, range, resolved } of lines) {
  if (resolved === null || resolved === undefined) {
    console.log(`  ${HOST}@${tag} (${dshVersion}): dsh-tools ${range ?? '(no dependency declared)'} resolves to nothing published -- skipped`)
    continue
  }
  const ok = semver.satisfies(resolved, peerRange)
  console.log(`  ${HOST}@${tag} (${dshVersion}): dsh-tools ${resolved}${ok ? '  OK' : '  NOT COVERED'}`)
  if (!ok) failures.push(`${dshVersion} -> dsh-tools ${resolved}`)
}

// Published but not yet shipped by a host line: worth saying out loud, and not
// worth failing on. This is what tells you the range needs widening *before*
// the release that would break installs.
const covered = toolsVersions.filter((v) => semver.satisfies(v, peerRange))
const coveredLines = new Set(covered.map((v) => semver.major(v) + '.' + semver.minor(v) + '.' + semver.patch(v)))
const allLines = new Set(toolsVersions.map((v) => semver.major(v) + '.' + semver.minor(v) + '.' + semver.patch(v)))
const uncovered = [...allLines].filter((l) => !coveredLines.has(l) && semver.gte(l, '0.1.0'))
if (uncovered.length > 0) {
  console.log(`\n  note: published lines the peer range does not cover: ${uncovered.join(', ')}`)
  console.log('        not a failure -- no host dist-tag names them yet.')
}

console.log(`\n  ${covered.length}/${toolsVersions.length} published dsh-tools versions accepted`)

if (failures.length > 0) {
  console.error(
    '\ncheck-peers: the declared peer range does not accept a current host line:\n' +
      failures.map((line) => `  - ${line}`).join('\n') +
      `\nAdd the missing line to peerDependencies["${TOOLS}"] in package.json.`,
  )
  process.exit(1)
}

console.log('\ncheck-peers: every current host line is covered')
