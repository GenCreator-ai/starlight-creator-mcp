import type { AssetRow, CreatorContext, JobRecord, Score } from '@starlight-intelligence/creator-core'
import type * as z from 'zod/v4'
import type { assetSummary, jobOut, scoreOut } from './schemas.js'

export const EMBED_LIMIT = 5 * 1024 * 1024

export type AssetSummaryOut = z.infer<typeof assetSummary>
export type ScoreOut = z.infer<typeof scoreOut>
export type JobOut = z.infer<typeof jobOut>

export function summarizeAsset(ctx: CreatorContext, a: AssetRow): AssetSummaryOut {
  return {
    sha256: a.sha256, mime: a.mime, bytes: a.bytes, kind: a.kind, created_at: a.createdAt,
    ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}), ...(a.durationS ? { duration_s: a.durationS } : {}),
    ...(a.task ? { task: a.task } : {}), ...(a.model ? { model: a.model } : {}), ...(a.provider ? { provider: a.provider } : {}), ...(a.prompt ? { prompt: a.prompt } : {}),
    ...(a.score !== undefined ? { score: a.score } : {}), ...(a.jobId ? { job_id: a.jobId } : {}), ...(a.localPath ? { local_path: a.localPath } : {}),
    locations: ctx.ledger.locations(a.sha256).map(l => ({ connector: l.connector, uri: l.uri })),
  }
}

export function scoreOutOf(s: Score): ScoreOut {
  return { score: s.score, dims: s.dims, strengths: s.strengths, weaknesses: s.weaknesses, ship_decision: s.shipDecision, rubric_id: s.rubricId, judge: s.judge, ...(s.autoFailed ? { auto_failed: s.autoFailed } : {}) }
}

export function jobOutOf(ctx: CreatorContext, job: JobRecord, extra: Partial<JobOut> = {}): JobOut {
  const asset = job.resultSha256 ? ctx.ledger.getAsset(job.resultSha256) : null
  const nextStep = job.status === 'queued' || job.status === 'running' ? `call creator_job_status with job_id ${job.id}`
    : job.status === 'failed' && job.providerJobId && job.error?.startsWith('result ingest failed:') ? `correct the retrieval or storage error, explicitly configure any verified media host and restart the context, then call creator_job_status with job_id ${job.id} and retry_ingest true; this submits no new generation`
      : job.status === 'failed' ? 'adjust the prompt or model and retry; creator_models lists alternatives' : undefined
  return {
    job_id: job.id, status: job.status, ...(asset ? { asset: summarizeAsset(ctx, asset) } : {}), ...(job.score ? { score: scoreOutOf(job.score) } : {}),
    ...(job.candidates?.length ? { candidates: job.candidates } : {}), ...(job.route ? { route: job.route } : {}), ...(job.costUsd !== undefined ? { cost_usd: job.costUsd } : {}),
    ...(job.error ? { error: job.error } : {}), ...(nextStep ? { next_step: nextStep } : {}), ...extra,
  }
}

export async function embedAsset(ctx: CreatorContext, sha256: string): Promise<{ type: 'image'; data: string; mimeType: string } | null> {
  const row = ctx.ledger.getAsset(sha256)
  if (!row || row.kind !== 'image' || row.bytes > EMBED_LIMIT) return null
  const data = await ctx.assets.bytes(sha256)
  if (!data) return null
  return { type: 'image', data: Buffer.from(data.bytes).toString('base64'), mimeType: data.mime }
}

export function textLine(obj: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(obj) }
}
