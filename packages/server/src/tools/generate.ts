import * as z from 'zod/v4'
import type { CreatorContext, GenerateInput, Task } from '@starlight-intelligence/creator-core'
import { embedAsset, jobOutOf, scoreOutOf, textLine } from '../content.js'
import { errorResult, toolError } from '../errors.js'
import { generateAudioIn, generateImageIn, generateVideoIn, jobOut, transcribeIn, waitMs } from '../schemas.js'
import { defineTool, GENERATES, READ_ONLY_NET } from '../tool-def.js'

function resolveRef(ctx: CreatorContext, ref: string): string {
  const row = ctx.ledger.findAsset(ref)
  if (!row) throw new Error(`asset ${ref} not found in the ledger; list assets with creator_assets`)
  return row.sha256
}

async function finish(ctx: CreatorContext, out: Awaited<ReturnType<CreatorContext['generate']>>) {
  const result = jobOutOf(ctx, out.job, { route: { model: out.route.model.id, provider: out.route.model.provider, reason: out.route.reason }, ...(out.score ? { score: scoreOutOf(out.score) } : {}), ...(out.candidates?.length ? { candidates: out.candidates } : {}) })
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [textLine(result)]
  if (out.job.resultSha256) { const img = await embedAsset(ctx, out.job.resultSha256); if (img) content.push(img) }
  return { content, structuredContent: result }
}

const params = (o: Record<string, string | number | boolean | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>

export const generateImage = defineTool({
  name: 'creator_generate_image',
  title: 'Generate image',
  description: 'Render a still image with the user\'s own provider keys. Routes to the best model for the loaded pack unless `model` is given; `best_of`/`min_score` run the taste loop (generate → score with the pack rubric → keep the best). Returns a job with the asset sha256 and an inline preview when done within wait_ms; otherwise poll creator_job_status.',
  inputSchema: generateImageIn,
  outputSchema: jobOut,
  annotations: GENERATES,
  async handler(a, ctx) {
    try {
      const sources: GenerateInput['sourceAssets'] = []
      if (a.source_asset) sources.push({ role: 'image', sha256: resolveRef(ctx, a.source_asset) })
      for (const r of a.reference_assets) sources.push({ role: 'reference', sha256: resolveRef(ctx, r) })
      const out = await ctx.generate({ task: a.source_asset ? 'i2i' : 't2i', prompt: a.prompt, ...(a.model ? { model: a.model } : {}), quality: a.quality, ...(a.style ? { style: a.style } : {}), params: params({ aspect_ratio: a.aspect_ratio, resolution: a.resolution }), sourceAssets: sources, ...(a.seed !== undefined ? { seed: a.seed } : {}), bestOf: a.best_of, ...(a.min_score !== undefined ? { minScore: a.min_score } : {}), ...(a.rubric ? { rubric: a.rubric } : {}), waitMs: a.wait_ms })
      return finish(ctx, out)
    } catch (err) { return errorResult(err, 'check creator_models for available ids and creator-mcp doctor for provider keys') }
  },
})

export const generateVideo = defineTool({
  name: 'creator_generate_video',
  title: 'Generate video',
  description: 'Text-to-video, image-to-video (pass source_asset) or lipsync (pass audio_asset + source_asset). Video jobs are asynchronous: the call returns a job id; poll creator_job_status until completed. Clips land in the local asset ledger with provenance.',
  inputSchema: generateVideoIn,
  outputSchema: jobOut,
  annotations: GENERATES,
  async handler(a, ctx) {
    try {
      const sources: GenerateInput['sourceAssets'] = []
      let task: Task = 't2v'
      if (a.audio_asset) { task = 'lipsync'; sources.push({ role: 'audio', sha256: resolveRef(ctx, a.audio_asset) }) }
      if (a.source_asset) { if (task === 't2v') task = 'i2v'; sources.push({ role: 'image', sha256: resolveRef(ctx, a.source_asset) }) }
      if (task === 't2v' && !a.prompt) return toolError('prompt is required for text-to-video', 'pass prompt, or source_asset for image-to-video')
      const out = await ctx.generate({ task, ...(a.prompt ? { prompt: a.prompt } : {}), ...(a.model ? { model: a.model } : {}), quality: a.quality, ...(a.style ? { style: a.style } : {}), params: params({ aspect_ratio: a.aspect_ratio, duration_s: a.duration_s, resolution: a.resolution }), sourceAssets: sources, ...(a.seed !== undefined ? { seed: a.seed } : {}), waitMs: a.wait_ms })
      return finish(ctx, out)
    } catch (err) { return errorResult(err, 'video needs a provider with t2v/i2v models configured (OpenRouter or MuAPI key)') }
  },
})

export const generateAudio = defineTool({
  name: 'creator_generate_audio',
  title: 'Generate audio',
  description: 'Text-to-speech, music or sound effects through the configured audio provider. Returns a job; audio is stored in the ledger.',
  inputSchema: generateAudioIn,
  outputSchema: jobOut,
  annotations: GENERATES,
  async handler(a, ctx) {
    try {
      const prompt = a.kind === 'tts' ? a.text : a.prompt
      if (!prompt) return toolError(`${a.kind} needs ${a.kind === 'tts' ? 'text' : 'prompt'}`)
      const out = await ctx.generate({ task: a.kind, prompt, ...(a.model ? { model: a.model } : {}), params: params({ voice: a.voice, duration_s: a.duration_s, format: a.format }), sourceAssets: [], waitMs: a.wait_ms })
      return finish(ctx, out)
    } catch (err) { return errorResult(err, 'audio needs an audio-capable provider (ElevenLabs or OpenRouter audio models)') }
  },
})

export const transcribe = defineTool({
  name: 'creator_transcribe',
  title: 'Transcribe',
  description: 'Speech-to-text for an audio or video asset in the ledger. Returns the transcript text and stores it as a text asset.',
  inputSchema: transcribeIn,
  outputSchema: jobOut.extend({ transcript: z.string().optional() }),
  annotations: GENERATES,
  async handler(a, ctx) {
    try {
      const out = await ctx.generate({ task: 'stt', ...(a.model ? { model: a.model } : {}), params: params({ language: a.language, diarize: a.diarize }), sourceAssets: [{ role: 'audio', sha256: resolveRef(ctx, a.source_asset) }], waitMs: a.wait_ms })
      const transcript = (out.job.request as { result_text?: string }).result_text
      const result = { ...jobOutOf(ctx, out.job), ...(transcript ? { transcript } : {}) }
      return { content: [textLine(result)], structuredContent: result }
    } catch (err) { return errorResult(err, 'transcription needs a provider with stt models') }
  },
})

export const jobStatus = defineTool({
  name: 'creator_job_status',
  title: 'Job status',
  description: 'Poll a generation job. Optionally wait up to wait_ms for it to finish. After correcting a result-ingest failure, retry_ingest retrieves the same provider job again without submitting a new generation. When completed, returns the asset summary and an inline image preview.',
  inputSchema: z.object({ job_id: z.string(), wait_ms: waitMs.default(0), retry_ingest: z.boolean().default(false) }),
  outputSchema: jobOut,
  annotations: { ...READ_ONLY_NET, readOnlyHint: false },
  async handler(a, ctx) {
    if (a.retry_ingest) await ctx.jobs.retryIngest(a.job_id)
    const job = a.wait_ms > 0 ? await ctx.jobs.waitFor(a.job_id, a.wait_ms) : await ctx.jobs.refresh(a.job_id)
    if (!job) return toolError(`job ${a.job_id} not found`)
    const result = jobOutOf(ctx, job)
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [textLine(result)]
    if (job.resultSha256) { const img = await embedAsset(ctx, job.resultSha256); if (img) content.push(img) }
    return { content, structuredContent: result }
  },
})
