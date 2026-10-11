import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { JobRecord } from '../types.js'
import type { AssetFilter, AssetRow, Ledger, ManifestRow, MetricObservation, PublicationRow, ScoreRow } from './interface.js'

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assets (sha256 TEXT PRIMARY KEY, kind TEXT, mime TEXT, task TEXT, model TEXT, provider TEXT, score REAL, created_at TEXT, pack_digest TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_created ON assets(created_at);
CREATE INDEX IF NOT EXISTS assets_page ON assets(created_at DESC, sha256);
CREATE TABLE IF NOT EXISTS asset_locations (sha256 TEXT, connector TEXT, uri TEXT, synced_at TEXT, PRIMARY KEY (sha256, connector));
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scores (id TEXT PRIMARY KEY, sha256 TEXT, text_sha TEXT, rubric_id TEXT, created_at TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS scores_sha ON scores(sha256);
CREATE TABLE IF NOT EXISTS manifests (id TEXT PRIMARY KEY, payload_hash TEXT, status TEXT, created_at TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS manifests_hash ON manifests(payload_hash);
CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, manifest_id TEXT, idempotency_key TEXT UNIQUE, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metric_observations (id TEXT PRIMARY KEY, publication_id TEXT, observed_at TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observations_publication ON metric_observations(publication_id, observed_at DESC);
CREATE TABLE IF NOT EXISTS rate_limits (adapter TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS rate_limits_adapter ON rate_limits(adapter, at);
CREATE INDEX IF NOT EXISTS rate_limits_time ON rate_limits(at);
`

interface SqliteDatabase {
  exec(sql: string): void
  function(name: string, fn: (value: unknown) => string): void
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
  close(): void
}

export function sqliteAvailable(): boolean {
  try { process.getBuiltinModule('node:sqlite'); return true } catch { return false }
}

function openDatabase(file: string): SqliteDatabase {
  const mod = process.getBuiltinModule('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase }
  return new mod.DatabaseSync(file)
}

export function matchesAssetFilter(a: AssetRow, f: AssetFilter): boolean {
  if (f.task && a.task !== f.task) return false
  if (f.model && a.model !== f.model) return false
  if (f.kind && a.kind !== f.kind) return false
  if (f.minScore !== undefined && (a.score ?? -1) < f.minScore) return false
  if (f.since && a.createdAt < f.since) return false
  const pack = a.provenance.pack as { id?: string; ids?: string[] } | undefined
  if (f.packId && pack?.id !== f.packId && !pack?.ids?.includes(f.packId)) return false
  if (f.query) {
    const q = f.query.toLowerCase()
    const hay = `${a.prompt ?? ''} ${a.model ?? ''} ${a.sha256}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

export function paginate<T extends { createdAt: string } & Record<string, unknown>>(rows: T[], idKey: keyof T, limit: number, cursor?: string): { items: T[]; nextCursor?: string } {
  assetPageLimit(limit)
  const sorted = [...rows].sort((x, y) => y.createdAt < x.createdAt ? -1 : y.createdAt > x.createdAt ? 1 : String(x[idKey]) < String(y[idKey]) ? -1 : String(x[idKey]) > String(y[idKey]) ? 1 : 0)
  const start = cursor ? sorted.findIndex(r => String(r[idKey]) === cursor) + 1 : 0
  const items = sorted.slice(start, start + limit)
  const last = items[items.length - 1]
  return start + limit < sorted.length && last ? { items, nextCursor: String(last[idKey]) } : { items }
}

export function assetPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('asset page limit must be an integer from 1 to 1000')
  return limit
}

export const MAX_OBSERVATIONS = 10000
export function rateHitCutoff(): string { return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }
export function observationBudget<T>(rows: T[]): T[] {
  if (rows.length > MAX_OBSERVATIONS) throw new RangeError('metric query exceeds 10000 observations; narrow the publication or time window')
  return rows
}

export class SqliteLedger implements Ledger {
  readonly backend = 'sqlite'
  private readonly db: SqliteDatabase

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = openDatabase(file)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA_SQL)
    // Preserve JavaScript Unicode case folding rather than SQLite's ASCII-only lower().
    this.db.function('creator_lower', value => String(value ?? '').toLowerCase())
  }

  private rows<T>(sql: string, ...args: unknown[]): T[] {
    return (this.db.prepare(sql).all(...args) as Array<{ json: string }>).map(r => JSON.parse(r.json) as T)
  }
  private row<T>(sql: string, ...args: unknown[]): T | null {
    const r = this.db.prepare(sql).get(...args) as { json: string } | undefined
    return r ? (JSON.parse(r.json) as T) : null
  }

  upsertAsset(row: AssetRow): void {
    this.db.prepare('INSERT OR REPLACE INTO assets (sha256, kind, mime, task, model, provider, score, created_at, pack_digest, json) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(row.sha256, row.kind, row.mime, row.task ?? null, row.model ?? null, row.provider ?? null, row.score ?? null, row.createdAt, row.packDigest ?? null, JSON.stringify(row))
  }
  getAsset(sha256: string): AssetRow | null { return this.row<AssetRow>('SELECT json FROM assets WHERE sha256 = ?', sha256) }
  findAsset(ref: string): AssetRow | null {
    if (/^[a-f0-9]{64}$/i.test(ref)) return this.getAsset(ref.toLowerCase())
    if (/^[a-f0-9]{8,63}$/i.test(ref)) {
      const hits = this.rows<AssetRow>('SELECT json FROM assets WHERE sha256 LIKE ? LIMIT 2', `${ref.toLowerCase()}%`)
      return hits.length === 1 ? hits[0]! : null
    }
    const job = this.getJob(ref)
    return job?.resultSha256 ? this.getAsset(job.resultSha256) : null
  }
  listAssets(filter: AssetFilter): { assets: AssetRow[]; nextCursor?: string } {
    const limit = assetPageLimit(filter.limit ?? 20)
    const where: string[] = [], args: unknown[] = []
    for (const [value, column] of [[filter.task, 'task'], [filter.model, 'model'], [filter.kind, 'kind']] as const) {
      if (value) { where.push(`${column} = ?`); args.push(value) }
    }
    if (filter.minScore !== undefined) { where.push('COALESCE(score, -1) >= ?'); args.push(filter.minScore) }
    if (filter.since) { where.push('created_at >= ?'); args.push(filter.since) }
    if (filter.packId) {
      where.push("(json_extract(assets.json, '$.provenance.pack.id') = ? OR EXISTS (SELECT 1 FROM json_each(assets.json, '$.provenance.pack.ids') WHERE value = ?))")
      args.push(filter.packId, filter.packId)
    }
    if (filter.query) { where.push("instr(creator_lower(COALESCE(json_extract(json, '$.prompt'), '') || ' ' || COALESCE(model, '') || ' ' || sha256), ?) > 0"); args.push(filter.query.toLowerCase()) }
    const cursor = filter.cursor ? this.getAsset(filter.cursor) : null
    if (cursor && matchesAssetFilter(cursor, filter)) {
      where.push('(created_at < ? OR (created_at = ? AND sha256 > ?))')
      args.push(cursor.createdAt, cursor.createdAt, cursor.sha256)
    }
    const rows = this.rows<AssetRow>(`SELECT json FROM assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, sha256 ASC LIMIT ?`, ...args, limit + 1)
    const assets = rows.slice(0, limit), last = assets[assets.length - 1]
    return rows.length > limit && last ? { assets, nextCursor: last.sha256 } : { assets }
  }
  addLocation(sha256: string, connector: string, uri: string): void {
    this.db.prepare('INSERT OR REPLACE INTO asset_locations (sha256, connector, uri, synced_at) VALUES (?,?,?,?)').run(sha256, connector, uri, new Date().toISOString())
  }
  locations(sha256: string) {
    return (this.db.prepare('SELECT connector, uri, synced_at FROM asset_locations WHERE sha256 = ?').all(sha256) as Array<{ connector: string; uri: string; synced_at: string }>).map(r => ({ connector: r.connector, uri: r.uri, syncedAt: r.synced_at }))
  }

  createJob(job: JobRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO jobs (id, status, created_at, json) VALUES (?,?,?,?)').run(job.id, job.status, job.createdAt, JSON.stringify(job))
  }
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
    const cur = this.getJob(id)
    if (!cur) return null
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
    this.createJob(next)
    return next
  }
  getJob(id: string): JobRecord | null { return this.row<JobRecord>('SELECT json FROM jobs WHERE id = ?', id) }
  listJobs(filter: { status?: string; limit?: number }): JobRecord[] {
    const rows = filter.status ? this.rows<JobRecord>('SELECT json FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?', filter.status, filter.limit ?? 50) : this.rows<JobRecord>('SELECT json FROM jobs ORDER BY created_at DESC LIMIT ?', filter.limit ?? 50)
    return rows
  }

  addScore(row: ScoreRow): void {
    this.db.prepare('INSERT OR REPLACE INTO scores (id, sha256, text_sha, rubric_id, created_at, json) VALUES (?,?,?,?,?,?)').run(row.id, row.sha256 ?? null, row.textSha ?? null, row.rubricId, row.createdAt, JSON.stringify(row))
  }
  scoresFor(ref: { sha256?: string; textSha?: string }): ScoreRow[] {
    if (ref.sha256) return this.rows<ScoreRow>('SELECT json FROM scores WHERE sha256 = ? ORDER BY created_at DESC', ref.sha256)
    if (ref.textSha) return this.rows<ScoreRow>('SELECT json FROM scores WHERE text_sha = ? ORDER BY created_at DESC', ref.textSha)
    return []
  }

  putManifest(row: ManifestRow): void {
    this.db.prepare('INSERT OR REPLACE INTO manifests (id, payload_hash, status, created_at, json) VALUES (?,?,?,?,?)').run(row.id, row.payloadHash, row.status, row.createdAt, JSON.stringify(row))
  }
  getManifest(id: string): ManifestRow | null { return this.row<ManifestRow>('SELECT json FROM manifests WHERE id = ?', id) }
  findManifestByHash(payloadHash: string): ManifestRow | null { return this.row<ManifestRow>('SELECT json FROM manifests WHERE payload_hash = ? ORDER BY created_at DESC LIMIT 1', payloadHash) }
  updateManifest(id: string, patch: Partial<ManifestRow>): ManifestRow | null {
    const cur = this.getManifest(id)
    if (!cur) return null
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
    this.putManifest(next)
    return next
  }
  listManifests(filter: { status?: string; limit?: number }): ManifestRow[] {
    return filter.status ? this.rows<ManifestRow>('SELECT json FROM manifests WHERE status = ? ORDER BY created_at DESC LIMIT ?', filter.status, filter.limit ?? 50) : this.rows<ManifestRow>('SELECT json FROM manifests ORDER BY created_at DESC LIMIT ?', filter.limit ?? 50)
  }

  addPublication(row: PublicationRow): { inserted: boolean; existing?: PublicationRow } {
    const existing = this.row<PublicationRow>('SELECT json FROM publications WHERE idempotency_key = ?', row.idempotencyKey)
    if (existing && existing.status === 'sent') return { inserted: false, existing }
    this.db.prepare('INSERT OR REPLACE INTO publications (id, manifest_id, idempotency_key, json) VALUES (?,?,?,?)').run(existing?.id ?? row.id, row.manifestId, row.idempotencyKey, JSON.stringify({ ...row, id: existing?.id ?? row.id }))
    return { inserted: true }
  }
  publicationsFor(manifestId: string): PublicationRow[] { return this.rows<PublicationRow>('SELECT json FROM publications WHERE manifest_id = ?', manifestId) }
  getPublication(id: string): PublicationRow | null { return this.row<PublicationRow>('SELECT json FROM publications WHERE id = ?', id) }

  addObservation(row: MetricObservation): void {
    this.db.prepare('INSERT OR REPLACE INTO metric_observations (id, publication_id, observed_at, json) VALUES (?,?,?,?)').run(row.id, row.publicationId, row.observedAt, JSON.stringify(row))
  }
  observations(filter: { publicationId?: string; since?: string; until?: string }): MetricObservation[] {
    const where: string[] = [], args: unknown[] = []
    if (filter.publicationId) { where.push('publication_id = ?'); args.push(filter.publicationId) }
    if (filter.since) { where.push('observed_at >= ?'); args.push(filter.since) }
    if (filter.until) { where.push('observed_at <= ?'); args.push(filter.until) }
    return observationBudget(this.rows<MetricObservation>(`SELECT json FROM metric_observations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_at DESC LIMIT ?`, ...args, MAX_OBSERVATIONS + 1))
  }

  recordHit(adapter: string, at: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM rate_limits WHERE at < ?').run(rateHitCutoff())
      this.db.prepare('INSERT INTO rate_limits (adapter, at) VALUES (?,?)').run(adapter, at)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  hitsSince(adapter: string, since: string): number {
    const cutoff = rateHitCutoff()
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE adapter = ? AND at >= ?').get(adapter, since > cutoff ? since : cutoff) as { n: number }
    return Number(r.n)
  }

  close(): void { this.db.close() }
}
