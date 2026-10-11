import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { JobRecord } from '../types.js'
import type { AssetFilter, AssetRow, Ledger, ManifestRow, MetricObservation, PublicationRow, ScoreRow } from './interface.js'
import { matchesAssetFilter, observationBudget, paginate } from './sqlite.js'

type Op = { t: 'asset'; r: AssetRow } | { t: 'loc'; r: { sha256: string; connector: string; uri: string; syncedAt: string } } | { t: 'job'; r: JobRecord } | { t: 'score'; r: ScoreRow } | { t: 'manifest'; r: ManifestRow } | { t: 'pub'; r: PublicationRow } | { t: 'obs'; r: MetricObservation } | { t: 'hit'; r: { adapter: string; at: string } }

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
export interface JsonlLimits { maxJournalBytes?: number; maxRecordBytes?: number }

export class JsonlLedger implements Ledger {
  readonly backend = 'jsonl'
  private assets = new Map<string, AssetRow>()
  private locs = new Map<string, Map<string, { connector: string; uri: string; syncedAt: string }>>()
  private jobs = new Map<string, JobRecord>()
  private scores = new Map<string, ScoreRow>()
  private manifests = new Map<string, ManifestRow>()
  private pubs = new Map<string, PublicationRow>()
  private obs = new Map<string, MetricObservation>()
  private hits: Array<{ adapter: string; at: string }> = []
  private journalBytes = 0
  private readonly maxJournalBytes: number
  private readonly maxRecordBytes: number

  constructor(readonly file: string | null, limits: JsonlLimits = {}) {
    this.maxJournalBytes = limits.maxJournalBytes ?? MAX_JOURNAL_BYTES
    this.maxRecordBytes = limits.maxRecordBytes ?? MAX_RECORD_BYTES
    if (!Number.isSafeInteger(this.maxJournalBytes) || this.maxJournalBytes < 1 || this.maxJournalBytes > MAX_JOURNAL_BYTES ||
        !Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1 || this.maxRecordBytes > MAX_RECORD_BYTES) throw new RangeError('JSONL limits exceed supported journal/record budgets')
    if (file && existsSync(file)) {
      const fd = openSync(file, 'r'), decoder = new StringDecoder('utf8'), chunk = Buffer.alloc(64 * 1024)
      let pending = ''
      const consume = (line: string) => {
        if (Buffer.byteLength(line) > this.maxRecordBytes) throw new RangeError('JSONL record exceeds byte budget')
        if (!line.trim()) return
        let op: Op
        try { op = JSON.parse(line) as Op } catch { throw new Error('JSONL ledger contains invalid JSON; preserve the file and restore or repair it before reopening') }
        if (!op || !['asset', 'loc', 'job', 'score', 'manifest', 'pub', 'obs', 'hit'].includes(op.t) || !op.r || typeof op.r !== 'object') throw new Error('JSONL ledger contains an invalid operation')
        this.apply(op, false)
      }
      try {
        for (;;) {
          const read = readSync(fd, chunk, 0, Math.min(chunk.length, this.maxJournalBytes - this.journalBytes + 1), null)
          if (!read) break
          this.journalBytes += read
          if (this.journalBytes > this.maxJournalBytes) throw new RangeError('JSONL journal exceeds byte budget; preserve it and migrate to SQLite before reopening')
          pending += decoder.write(chunk.subarray(0, read))
          let end: number
          while ((end = pending.indexOf('\n')) !== -1) { consume(pending.slice(0, end)); pending = pending.slice(end + 1) }
          if (Buffer.byteLength(pending) > this.maxRecordBytes) throw new RangeError('JSONL record exceeds byte budget')
        }
        consume(pending + decoder.end())
      } finally { closeSync(fd) }
    }
  }

  private apply(op: Op, persist = true): void {
    if (persist) {
      const line = `${JSON.stringify(op)}\n`, bytes = Buffer.byteLength(line)
      if (bytes - 1 > this.maxRecordBytes) throw new RangeError('JSONL record exceeds byte budget')
      if (this.journalBytes + bytes > this.maxJournalBytes) throw new RangeError('JSONL journal exceeds byte budget; preserve it and migrate to SQLite')
      if (this.file) {
        mkdirSync(path.dirname(this.file), { recursive: true })
        appendFileSync(this.file, line)
      }
      // Publish in-memory state only after the append succeeds.
      this.journalBytes += bytes
    }
    switch (op.t) {
      case 'asset': this.assets.set(op.r.sha256, op.r); break
      case 'loc': { const m = this.locs.get(op.r.sha256) ?? new Map(); m.set(op.r.connector, op.r); this.locs.set(op.r.sha256, m); break }
      case 'job': this.jobs.set(op.r.id, op.r); break
      case 'score': this.scores.set(op.r.id, op.r); break
      case 'manifest': this.manifests.set(op.r.id, op.r); break
      case 'pub': this.pubs.set(op.r.id, op.r); break
      case 'obs': this.obs.set(op.r.id, op.r); break
      case 'hit': this.hits.push(op.r); break
    }
  }

  upsertAsset(row: AssetRow): void { this.apply({ t: 'asset', r: row }) }
  getAsset(sha256: string): AssetRow | null { return this.assets.get(sha256) ?? null }
  findAsset(ref: string): AssetRow | null {
    if (/^[a-f0-9]{64}$/i.test(ref)) return this.getAsset(ref.toLowerCase())
    if (/^[a-f0-9]{8,63}$/i.test(ref)) { const hits = [...this.assets.keys()].filter(k => k.startsWith(ref.toLowerCase())); return hits.length === 1 ? this.assets.get(hits[0]!)! : null }
    const job = this.jobs.get(ref)
    return job?.resultSha256 ? this.getAsset(job.resultSha256) : null
  }
  listAssets(filter: AssetFilter) {
    const all = [...this.assets.values()].filter(a => matchesAssetFilter(a, filter))
    const { items, nextCursor } = paginate(all as Array<AssetRow & Record<string, unknown>>, 'sha256', filter.limit ?? 20, filter.cursor)
    return nextCursor ? { assets: items, nextCursor } : { assets: items }
  }
  addLocation(sha256: string, connector: string, uri: string): void { this.apply({ t: 'loc', r: { sha256, connector, uri, syncedAt: new Date().toISOString() } }) }
  locations(sha256: string) { return [...(this.locs.get(sha256)?.values() ?? [])] }
  createJob(job: JobRecord): void { this.apply({ t: 'job', r: job }) }
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null { const cur = this.jobs.get(id); if (!cur) return null; const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }; this.createJob(next); return next }
  getJob(id: string): JobRecord | null { return this.jobs.get(id) ?? null }
  listJobs(filter: { status?: string; limit?: number }): JobRecord[] { return [...this.jobs.values()].filter(j => !filter.status || j.status === filter.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, filter.limit ?? 50) }
  addScore(row: ScoreRow): void { this.apply({ t: 'score', r: row }) }
  scoresFor(ref: { sha256?: string; textSha?: string }): ScoreRow[] { return [...this.scores.values()].filter(s => (ref.sha256 && s.sha256 === ref.sha256) || (ref.textSha && s.textSha === ref.textSha)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  putManifest(row: ManifestRow): void { this.apply({ t: 'manifest', r: row }) }
  getManifest(id: string): ManifestRow | null { return this.manifests.get(id) ?? null }
  findManifestByHash(payloadHash: string): ManifestRow | null { return [...this.manifests.values()].filter(m => m.payloadHash === payloadHash).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null }
  updateManifest(id: string, patch: Partial<ManifestRow>): ManifestRow | null { const cur = this.manifests.get(id); if (!cur) return null; const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }; this.putManifest(next); return next }
  listManifests(filter: { status?: string; limit?: number }): ManifestRow[] { return [...this.manifests.values()].filter(m => !filter.status || m.status === filter.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, filter.limit ?? 50) }
  addPublication(row: PublicationRow) {
    const existing = [...this.pubs.values()].find(p => p.idempotencyKey === row.idempotencyKey)
    if (existing && existing.status === 'sent') return { inserted: false, existing }
    this.apply({ t: 'pub', r: { ...row, id: existing?.id ?? row.id } })
    return { inserted: true }
  }
  publicationsFor(manifestId: string): PublicationRow[] { return [...this.pubs.values()].filter(p => p.manifestId === manifestId) }
  getPublication(id: string): PublicationRow | null { return this.pubs.get(id) ?? null }
  addObservation(row: MetricObservation): void { this.apply({ t: 'obs', r: row }) }
  observations(filter: { publicationId?: string; since?: string; until?: string }): MetricObservation[] {
    return observationBudget([...this.obs.values()].filter(o => (!filter.publicationId || o.publicationId === filter.publicationId) && (!filter.since || o.observedAt >= filter.since) && (!filter.until || o.observedAt <= filter.until))).sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  }
  recordHit(adapter: string, at: string): void { this.apply({ t: 'hit', r: { adapter, at } }) }
  hitsSince(adapter: string, since: string): number { return this.hits.filter(h => h.adapter === adapter && h.at >= since).length }
  close(): void { /* nothing to flush */ }
}
