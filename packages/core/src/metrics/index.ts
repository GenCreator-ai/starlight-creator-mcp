import { readSandboxFile } from '../fs/sandbox.js'
import { ulid } from '../ids.js'
import type { Ledger, MetricObservation } from '../ledger/interface.js'
import type { PublishAdapter } from '../publish/adapter.js'

export const METRIC_FIELDS = ['impressions', 'reach', 'views', 'watchTimeS', 'likes', 'comments', 'replies', 'shares', 'saves', 'linkActions', 'followerDelta'] as const
export type MetricField = (typeof METRIC_FIELDS)[number]

export interface ObservationInput { publicationId: string; observedAt?: string; windowHours?: number; source?: string; metrics: Partial<Record<MetricField, number>>; raw?: Record<string, unknown> }

export class MetricsService {
  constructor(private readonly ledger: Ledger, private readonly adapters: Map<string, PublishAdapter>) {}

  ingestManual(items: ObservationInput[], source = 'manual'): { ingested: number; skipped: number } {
    let ingested = 0; let skipped = 0
    for (const it of items) {
      if (!this.ledger.getPublication(it.publicationId)) { skipped++; continue }
      const row: MetricObservation = { id: ulid(), publicationId: it.publicationId, source: it.source ?? source, observedAt: it.observedAt ?? new Date().toISOString(), ...(it.windowHours ? { windowHours: it.windowHours } : {}), ...it.metrics, ...(it.raw ? { raw: it.raw } : {}) }
      this.ledger.addObservation(row)
      ingested++
    }
    return { ingested, skipped }
  }

  async ingestCsv(csvPath: string, roots: readonly string[] = [process.cwd()]): Promise<{ ingested: number; skipped: number }> {
    const text = (await readSandboxFile(roots, csvPath, 8 * 1024 * 1024)).toString('utf8')
    const [headerLine, ...lines] = text.split(/\r?\n/).filter(l => l.trim())
    if (!headerLine) return { ingested: 0, skipped: 0 }
    const headers = headerLine.split(',').map(h => h.trim())
    const items: ObservationInput[] = []
    for (const line of lines) {
      const cells = line.split(',').map(c => c.trim())
      const rec: Record<string, string> = {}
      headers.forEach((h, i) => { rec[h] = cells[i] ?? '' })
      const publicationId = rec.publication_id ?? rec.publicationId
      if (!publicationId) continue
      const metrics: Partial<Record<MetricField, number>> = {}
      for (const f of METRIC_FIELDS) {
        const snake = f.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
        const v = rec[f] ?? rec[snake]
        if (v !== undefined && v !== '' && Number.isFinite(Number(v))) metrics[f] = Number(v)
      }
      items.push({ publicationId, source: 'csv', ...(rec.observed_at ? { observedAt: rec.observed_at } : {}), metrics })
    }
    return this.ingestManual(items, 'csv')
  }

  async ingestFromAdapter(adapterId: string, publicationIds?: string[]): Promise<{ ingested: number; skipped: number }> {
    const adapter = this.adapters.get(adapterId)
    if (!adapter?.fetchMetrics) throw new Error(`adapter ${adapterId} does not expose metrics`)
    const pubs = (publicationIds ?? []).map(id => this.ledger.getPublication(id)).filter((p): p is NonNullable<typeof p> => !!p && p.status === 'sent')
    let ingested = 0; let skipped = 0
    for (const p of pubs) {
      if (!p.nativeId) { skipped++; continue }
      const raw = await adapter.fetchMetrics(p.nativeId)
      if (!raw) { skipped++; continue }
      const metrics: Partial<Record<MetricField, number>> = {}
      for (const f of METRIC_FIELDS) if (typeof raw[f] === 'number') metrics[f] = raw[f]
      this.ledger.addObservation({ id: ulid(), publicationId: p.id, source: adapterId, observedAt: new Date().toISOString(), ...metrics, raw })
      ingested++
    }
    return { ingested, skipped }
  }

  query(filter: { publicationId?: string; since?: string; until?: string; groupBy?: 'publication' | 'channel' | 'day' | 'source' }): { rows: Array<Record<string, unknown>>; totals: Record<string, number> } {
    const obs = this.ledger.observations(filter)
    const totals: Record<string, number> = {}
    const groups = new Map<string, Record<string, number>>()
    for (const o of obs) {
      const pub = this.ledger.getPublication(o.publicationId)
      const key = filter.groupBy === 'channel' ? pub?.channelId ?? 'unknown' : filter.groupBy === 'day' ? o.observedAt.slice(0, 10) : filter.groupBy === 'source' ? o.source : o.publicationId
      const g = groups.get(key) ?? {}
      for (const f of METRIC_FIELDS) {
        const v = o[f]
        if (typeof v === 'number') { g[f] = (g[f] ?? 0) + v; totals[f] = (totals[f] ?? 0) + v }
      }
      g.observations = (g.observations ?? 0) + 1
      groups.set(key, g)
    }
    return { rows: [...groups.entries()].map(([key, v]) => ({ key, ...v })), totals }
  }
}
