import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './cache.ts'

export const PRIOR_VERSION = 1
export const PRIOR_MAX_RECORDS = 256
export const PRIOR_MAX_BYTES = 64 * 1024

export interface PriorRecord {
  repo: string
  first_seen: string
  last_seen: string
  seen_count: number
  inspected_count: number
  last_ref: string
  last_paths: string[]
  idea_hashes: string[]
}

export interface PriorContext {
  repo: string
  seen_count: number
  inspected_count: number
  last_seen: string
}

interface PriorEnvelope {
  version: number
  records: PriorRecord[]
}

function priorPath(): string {
  return join(dshHome(), 'cache', 'dsh-find-ideas', 'prior.json')
}

function normalizeIdea(idea: string): string {
  return idea.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400)
}

export function ideaHash(idea: string): string {
  return createHash('sha256').update(normalizeIdea(idea), 'utf8').digest('hex')
}

function validRecord(value: unknown): value is PriorRecord {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<PriorRecord>
  return typeof item.repo === 'string' &&
    typeof item.first_seen === 'string' &&
    typeof item.last_seen === 'string' &&
    Number.isInteger(item.seen_count) &&
    Number.isInteger(item.inspected_count) &&
    typeof item.last_ref === 'string' &&
    Array.isArray(item.last_paths) &&
    Array.isArray(item.idea_hashes)
}

async function readRecords(): Promise<PriorRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(priorPath(), 'utf8')) as Partial<PriorEnvelope>
    if (parsed.version !== PRIOR_VERSION || !Array.isArray(parsed.records)) return []
    return parsed.records.filter(validRecord).slice(0, PRIOR_MAX_RECORDS)
  } catch {
    return []
  }
}

async function writeRecords(records: PriorRecord[]): Promise<void> {
  try {
    const path = priorPath()
    await mkdir(join(dshHome(), 'cache', 'dsh-find-ideas'), { recursive: true })
    const envelope: PriorEnvelope = { version: PRIOR_VERSION, records: records.slice(0, PRIOR_MAX_RECORDS) }
    const text = JSON.stringify(envelope)
    if (Buffer.byteLength(text, 'utf8') > PRIOR_MAX_BYTES) return
    const temp = path + '.tmp-' + process.pid
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch {
    // Prior history is best effort and must never fail a GitHub call.
  }
}

export async function priorContextFor(repoNames: readonly string[]): Promise<PriorContext[]> {
  const wanted = new Set(repoNames.map((repo) => repo.toLowerCase()))
  const records = await readRecords()
  return records
    .filter((record) => wanted.has(record.repo.toLowerCase()))
    .map((record) => ({
      repo: record.repo,
      seen_count: record.seen_count,
      inspected_count: record.inspected_count,
      last_seen: record.last_seen,
    }))
}

export async function recordPrior(
  repo: string,
  idea: string,
  kind: 'seen' | 'inspected' | 'read',
  ref = '',
  paths: readonly string[] = [],
): Promise<void> {
  const now = new Date().toISOString()
  const hash = ideaHash(idea)
  const records = await readRecords()
  const index = records.findIndex((record) => record.repo.toLowerCase() === repo.toLowerCase())
  const existing = index >= 0 ? records[index] : undefined
  const next: PriorRecord = existing === undefined
    ? {
        repo,
        first_seen: now,
        last_seen: now,
        seen_count: 0,
        inspected_count: 0,
        last_ref: '',
        last_paths: [],
        idea_hashes: [],
      }
    : { ...existing }
  next.last_seen = now
  next.seen_count += 1
  if (kind === 'inspected' || kind === 'read') next.inspected_count += 1
  if (ref.length > 0) next.last_ref = ref
  next.last_paths = [...new Set(paths)].slice(0, 8)
  next.idea_hashes = [...new Set([...next.idea_hashes, hash])].slice(-8)
  if (index >= 0) records.splice(index, 1)
  records.unshift(next)
  await writeRecords(records)
}

