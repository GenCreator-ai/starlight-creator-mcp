import type { AssetStore } from '../assets/store.js'
import { ulid } from '../ids.js'
import type { AssetRow, Ledger } from '../ledger/interface.js'
import type { Logger } from '../log.js'
import { discardBody, guardedFetch, readBodyLimited, type FetchPolicy } from '../net/fetch-guard.js'
import { ProviderError } from '../provider/interface.js'
import type { ProviderRegistry } from '../provider/registry.js'
import type { GenerationRequest, JobRecord, ProviderJob, ProviderResult, Task } from '../types.js'

export interface JobManagerOptions {
  ledger: Ledger
  providers: ProviderRegistry
  assets: AssetStore
  fetchPolicy: FetchPolicy
  maxAssetBytes: number
  log: Logger
  substrateVersion: string
}

export interface SubmitInput {
  request: GenerationRequest
  provenance: { pack?: { ids: string[]; digest: string }; style?: string; license?: { pack_license?: string } }
  route: { model: string; provider: string; reason: string }
  requestSummary: Record<string, unknown>
}

export class JobManager {
  constructor(private readonly o: JobManagerOptions) {}

  async submit(input: SubmitInput): Promise<JobRecord> {
    const provider = this.o.providers.get(input.request.model.provider)
    const now = new Date().toISOString()
    const job: JobRecord = {
      id: ulid(), provider: provider.id, providerJobId: '', task: input.request.task, model: input.request.model.id,
      status: 'queued', request: { ...input.requestSummary, provenance: input.provenance }, createdAt: now, updatedAt: now, route: input.route,
      ...(input.provenance.pack?.digest ? { packDigest: input.provenance.pack.digest } : {}),
    }
    this.o.ledger.createJob(job)
    let pj: ProviderJob
    try {
      pj = await provider.submit(input.request)
    } catch (err) {
      return this.o.ledger.updateJob(job.id, { status: 'failed', error: (err as Error).message })!
    }
    const updated = this.o.ledger.updateJob(job.id, { providerJobId: pj.providerJobId, status: pj.status === 'completed' ? 'running' : pj.status, ...(pj.error ? { error: pj.error } : {}) })!
    if (pj.status === 'completed' && pj.result) return this.ingestResult(updated, pj)
    if (pj.status === 'failed') return this.o.ledger.updateJob(job.id, { status: 'failed', error: pj.error ?? 'provider reported failure' })!
    return updated
  }

  async refresh(jobId: string): Promise<JobRecord | null> {
    const job = this.o.ledger.getJob(jobId)
    if (!job) return null
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return job
    if (!job.providerJobId) return job
    const provider = this.o.providers.get(job.provider)
    let pj: ProviderJob
    try {
      pj = await provider.poll(job.providerJobId, job.task)
    } catch (err) {
      this.o.log.warn('poll failed', { job: jobId, error: (err as Error).message })
      if (err instanceof ProviderError && !err.retryable) return this.o.ledger.updateJob(jobId, { status: 'failed', error: err.message })
      return job
    }
    if (pj.status === 'failed' || pj.status === 'cancelled') return this.o.ledger.updateJob(jobId, { status: pj.status, error: pj.error ?? `provider reported ${pj.status}` })
    if (pj.status === 'completed' && pj.result) return this.ingestResult(job, pj)
    return this.o.ledger.updateJob(jobId, { status: 'running' })
  }

  async waitFor(jobId: string, waitMs: number): Promise<JobRecord | null> {
    const deadline = Date.now() + waitMs
    let delay = 1000
    let job = await this.refresh(jobId)
    while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.min(delay, Math.max(deadline - Date.now(), 0))))
      delay = Math.min(delay * 1.5, 5000)
      job = await this.refresh(jobId)
    }
    return job
  }

  private async ingestResult(job: JobRecord, pj: ProviderJob): Promise<JobRecord> {
    const result = pj.result as ProviderResult
    const rows: AssetRow[] = []
    let text: string | undefined
    try {
      for (const out of result.outputs) {
        const bytes = out.kind === 'text' && typeof out.text === 'string' ? Buffer.from(out.text, 'utf8') : out.bytes ?? (out.url ? await this.download(out.url, job.provider) : null)
        if (!bytes) continue
        if (bytes.byteLength > this.o.maxAssetBytes) throw new Error('provider output exceeds byte limit')
        if (out.kind === 'text' && text === undefined) text = Buffer.from(bytes).toString('utf8')
        const prov = (job.request as { provenance?: SubmitInput['provenance'] }).provenance ?? {}
        const summary = job.request as Record<string, unknown>
        rows.push(await this.o.assets.ingest({
          bytes, mime: out.mime,
          dimensions: { ...(out.width ? { width: out.width } : {}), ...(out.height ? { height: out.height } : {}), ...(out.durationS ? { durationS: out.durationS } : {}) },
          provenance: {
            job_id: job.id, provider: job.provider, model: job.model, task: job.task,
            ...(typeof summary.prompt === 'string' ? { prompt: summary.prompt } : {}),
            ...(typeof summary.negative_prompt === 'string' ? { negative_prompt: summary.negative_prompt } : {}),
            ...(summary.params && typeof summary.params === 'object' ? { params: summary.params as Record<string, string | number | boolean> } : {}),
            ...(out.seed !== undefined ? { seed: out.seed } : typeof summary.seed === 'number' ? { seed: summary.seed } : {}),
            ...(Array.isArray(summary.source_assets) ? { source_assets: summary.source_assets as string[] } : {}),
            ...(pj.costUsd !== undefined ? { cost_usd: pj.costUsd } : result.costUsd !== undefined ? { cost_usd: result.costUsd } : {}),
            ...(pj.isByok !== undefined ? { is_byok: pj.isByok } : {}),
            ...(prov.pack ? { pack: prov.pack } : {}), ...(prov.style ? { style: prov.style } : {}), ...(prov.license ? { license: prov.license } : {}),
            origin: { kind: 'generated' },
          },
        }))
      }
    } catch (err) {
      return this.o.ledger.updateJob(job.id, { status: 'failed', error: `result ingest failed: ${(err as Error).message}` })!
    }
    const first = rows[0]
    return this.o.ledger.updateJob(job.id, {
      status: 'completed', ...(first ? { resultSha256: first.sha256 } : {}), candidates: rows.map(r => ({ sha256: r.sha256 })),
      ...(pj.costUsd !== undefined ? { costUsd: pj.costUsd } : result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), ...(text ? { request: { ...job.request, result_text: text } } : {}),
    })!
  }

  private async download(url: string, providerId: string): Promise<Uint8Array> {
    const provider = this.o.providers.get(providerId)
    const host = new URL(url).hostname
    const policy: FetchPolicy = { ...this.o.fetchPolicy, allowHosts: [...this.o.fetchPolicy.allowHosts, ...provider.allowHosts, host], maxBytes: this.o.maxAssetBytes, timeoutMs: 120_000 }
    const res = await guardedFetch(url, { policy })
    if (!res.ok) {
      await discardBody(res)
      throw new Error(`download ${host} returned ${res.status}`)
    }
    return readBodyLimited(res, this.o.maxAssetBytes)
  }

  taskOf(jobId: string): Task | null { return this.o.ledger.getJob(jobId)?.task ?? null }
}
