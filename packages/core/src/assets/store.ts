import { sha256Hex } from '@starlight-intelligence/creator-packs-spec'
import type { AssetRow, Ledger } from '../ledger/interface.js'
import { extForMime, kindForMime, sniffMime, type StorageConnector } from '../storage/interface.js'
import type { LocalStorage } from '../storage/local.js'
import { buildProvenance, type Provenance } from './provenance.js'

export interface AssetStoreOptions { ledger: Ledger; local: LocalStorage; connectors: Map<string, StorageConnector>; substrateVersion: string }

export interface IngestInput {
  bytes: Uint8Array
  mime?: string
  provenance: Omit<Provenance, 'schema' | 'created_at' | 'sha256' | 'mime' | 'bytes' | 'substrate_version'>
  dimensions?: { width?: number; height?: number; durationS?: number }
}

class AssetDigestError extends Error {}

export class AssetStore {
  constructor(private readonly o: AssetStoreOptions) {}

  get local(): LocalStorage { return this.o.local }

  private verifiedBytes(sha256: string, bytes: Uint8Array, connector: string): Uint8Array {
    // Copy before the check so a connector cannot mutate a shared buffer during caching.
    const owned = Uint8Array.from(bytes)
    if (sha256Hex(owned) !== sha256) throw new AssetDigestError(`asset digest mismatch from ${connector}`)
    return owned
  }

  async ingest(input: IngestInput): Promise<AssetRow> {
    const sha256 = sha256Hex(input.bytes)
    const mime = input.mime && input.mime !== 'application/octet-stream' ? input.mime.split(';')[0]!.trim() : sniffMime(input.bytes)
    const ext = extForMime(mime)
    const existing = this.o.ledger.getAsset(sha256)
    if (existing && (await this.o.local.exists(sha256, ext))) return existing
    const stored = await this.o.local.put(sha256, input.bytes, { mime, ext })
    const provenance = buildProvenance({ ...input.provenance, sha256, mime, bytes: input.bytes.byteLength, substrate_version: this.o.substrateVersion })
    await this.o.local.writeSidecar(sha256, provenance)
    const row: AssetRow = {
      sha256, mime, bytes: input.bytes.byteLength, kind: kindForMime(mime), createdAt: provenance.created_at,
      ...(input.dimensions?.width ? { width: input.dimensions.width } : {}), ...(input.dimensions?.height ? { height: input.dimensions.height } : {}), ...(input.dimensions?.durationS ? { durationS: input.dimensions.durationS } : {}),
      ...(provenance.task && provenance.task !== 'import' ? { task: provenance.task } : {}), ...(provenance.model ? { model: provenance.model } : {}), ...(provenance.provider ? { provider: provenance.provider } : {}),
      ...(provenance.prompt ? { prompt: provenance.prompt } : {}), ...(provenance.job_id ? { jobId: provenance.job_id } : {}),
      localPath: this.o.local.pathFor(sha256, ext), provenance: provenance as unknown as Record<string, unknown>, ...(provenance.pack?.digest ? { packDigest: provenance.pack.digest } : {}),
    }
    this.o.ledger.upsertAsset(row)
    this.o.ledger.addLocation(sha256, 'local', stored.uri)
    return row
  }

  async bytes(sha256: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const row = this.o.ledger.getAsset(sha256)
    if (!row) return null
    const ext = extForMime(row.mime)
    const local = await this.o.local.get(sha256, ext)
    let corruption: AssetDigestError | undefined
    if (local) {
      try { return { bytes: this.verifiedBytes(sha256, local, 'local'), mime: row.mime } }
      catch (error) {
        if (!(error instanceof AssetDigestError)) throw error
        corruption = error
      }
    }
    for (const loc of this.o.ledger.locations(sha256)) {
      const c = this.o.connectors.get(loc.connector)
      if (!c || c.id === 'local') continue
      const b = await c.get(sha256, ext)
      if (b) {
        let verified: Uint8Array
        try { verified = this.verifiedBytes(sha256, b, c.id) }
        catch (error) {
          if (!(error instanceof AssetDigestError)) throw error
          corruption ??= error
          continue
        }
        await this.o.local.put(sha256, verified, { mime: row.mime, ext })
        return { bytes: verified, mime: row.mime }
      }
    }
    if (corruption) throw corruption
    return null
  }

  async setScore(sha256: string, rubricId: string, score: number): Promise<void> {
    const row = this.o.ledger.getAsset(sha256)
    if (!row) return
    const prov = row.provenance as unknown as Provenance
    prov.rubric_scores = [...(prov.rubric_scores ?? []).filter(r => r.rubric_id !== rubricId), { rubric_id: rubricId, score }]
    await this.o.local.writeSidecar(sha256, prov)
    this.o.ledger.upsertAsset({ ...row, score: Math.max(row.score ?? 0, score), provenance: prov as unknown as Record<string, unknown> })
  }

  async sync(sha256: string, connectorId: string): Promise<{ uri: string; connector: string }> {
    const c = this.o.connectors.get(connectorId)
    if (!c) throw new Error(`storage connector ${connectorId} is not configured; available: ${[...this.o.connectors.keys()].join(', ')}`)
    const data = await this.bytes(sha256)
    if (!data) throw new Error(`asset ${sha256} has no retrievable bytes`)
    const ext = extForMime(data.mime)
    const stored = await c.put(sha256, data.bytes, { mime: data.mime, ext })
    this.o.ledger.addLocation(sha256, c.id, stored.uri)
    return stored
  }

  async publicUrl(sha256: string): Promise<string | null> {
    const row = this.o.ledger.getAsset(sha256)
    if (!row) return null
    const ext = extForMime(row.mime)
    for (const loc of this.o.ledger.locations(sha256)) {
      const c = this.o.connectors.get(loc.connector)
      if (c?.publicUrl) { const u = await c.publicUrl(sha256, ext); if (u) return u }
    }
    return null
  }

  async reindexFromSidecars(listSidecars: () => Promise<Provenance[]>): Promise<number> {
    let n = 0
    for (const p of await listSidecars()) {
      const ext = extForMime(p.mime)
      if (!(await this.o.local.exists(p.sha256, ext))) continue
      const existing = this.o.ledger.getAsset(p.sha256)
      if (existing) continue
      this.o.ledger.upsertAsset({ sha256: p.sha256, mime: p.mime, bytes: p.bytes, kind: kindForMime(p.mime), createdAt: p.created_at, ...(p.task && p.task !== 'import' ? { task: p.task } : {}), ...(p.model ? { model: p.model } : {}), ...(p.provider ? { provider: p.provider } : {}), ...(p.prompt ? { prompt: p.prompt } : {}), localPath: this.o.local.pathFor(p.sha256, ext), provenance: p as unknown as Record<string, unknown>, ...(p.rubric_scores?.length ? { score: Math.max(...p.rubric_scores.map(r => r.score)) } : {}) })
      n++
    }
    return n
  }
}
