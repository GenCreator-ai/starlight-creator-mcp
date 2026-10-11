import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discardBody, guardedFetch, ProviderError, SECRET_NAMES, type FetchPolicy, type GenerationRequest, type ModelRecord, type Provider, type ProviderJob, type Task, type Vault,
} from '@starlight-intelligence/creator-core'

export const MUAPI_HOSTS = ['api.muapi.ai', '*.muapi.ai']

const TASKS: Task[] = ['t2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync']

interface CatalogEntry { id: string; name?: string; endpoint?: string; category?: string; aspect_ratios?: string[]; resolutions?: string[]; durations?: Array<string | number> }

export async function loadMuapiCatalog(file?: string): Promise<ModelRecord[]> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const catalogPath = file ?? path.join(here, '..', 'data', 'models.json')
  const raw = JSON.parse(await readFile(catalogPath, 'utf8')) as Record<string, CatalogEntry[]>
  const byId = new Map<string, ModelRecord>()
  for (const task of TASKS) {
    for (const m of raw[task] ?? []) {
      const existing = byId.get(m.id)
      if (existing) { if (!existing.tasks.includes(task)) existing.tasks.push(task); continue }
      byId.set(m.id, {
        id: `muapi/${m.id}`, provider: 'muapi', modelId: m.id, name: m.name ?? m.id, tasks: [task],
        ...(m.endpoint ? { endpoint: m.endpoint } : {}), ...(m.aspect_ratios ? { aspect_ratios: m.aspect_ratios } : {}), ...(m.resolutions ? { resolutions: m.resolutions } : {}),
        ...(m.durations ? { durations: m.durations.map(Number).filter(n => !Number.isNaN(n)) } : {}),
      })
    }
  }
  return [...byId.values()]
}

export interface MuapiProviderOptions { vault: Vault; fetchPolicy?: FetchPolicy; baseUrl?: string; catalogFile?: string }

export function createMuapiProvider(opts: MuapiProviderOptions): Provider {
  const base = (opts.baseUrl ?? process.env.MUAPI_BASE_URL ?? 'https://api.muapi.ai').replace(/\/+$/, '')
  const host = new URL(base).hostname
  const policy: FetchPolicy = { allowHosts: [...(opts.fetchPolicy?.allowHosts ?? []), ...MUAPI_HOSTS, host], allowPrivateHosts: opts.fetchPolicy?.allowPrivateHosts ?? false, timeoutMs: 60_000 }
  let catalog: ModelRecord[] | null = null

  const key = () => opts.vault.require(SECRET_NAMES.muapi, 'Get a key at muapi.ai, then run `creator-mcp setup` or set MUAPI_KEY.')
  const headers = async (json = true) => ({ 'x-api-key': await key(), ...(json ? { 'Content-Type': 'application/json' } : {}) })

  async function upload(bytes: Uint8Array, mime: string, name: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), name)
    const res = await guardedFetch(`${base}/api/v1/upload_file`, { method: 'POST', headers: await headers(false), body: form, policy })
    if (!res.ok) {
      await discardBody(res)
      throw new ProviderError(`muapi upload failed: ${res.status}`, 'muapi', res.status === 429 || res.status >= 500, res.status)
    }
    const data = (await res.json()) as { url?: string; file_url?: string; data?: { url?: string } }
    const url = data.url ?? data.file_url ?? data.data?.url
    if (!url) throw new ProviderError('muapi upload returned no url', 'muapi')
    return url
  }

  async function submitOnce(endpoint: string, payload: Record<string, unknown>): Promise<{ requestId: string | null; raw: Record<string, unknown> }> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await guardedFetch(`${base}/api/v1/${endpoint}`, { method: 'POST', headers: await headers(), body: JSON.stringify(payload), policy })
      if (res.status === 429 || res.status >= 500) {
        await discardBody(res)
        lastErr = new ProviderError(`muapi ${endpoint} ${res.status}`, 'muapi', true, res.status)
        if (attempt === 3) break
        const retryAfter = res.headers.get('retry-after')
        const parsed = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
        const delay = Number.isNaN(parsed) ? 500 * attempt : Math.max(0, parsed)
        // A longer provider delay is returned to the caller instead of retrying too early or blocking indefinitely.
        if (delay > 2000) throw lastErr
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (!res.ok) throw new ProviderError(`muapi ${endpoint} failed: ${res.status} ${(await res.text()).slice(0, 200)}`, 'muapi', false, res.status)
      const raw = (await res.json()) as Record<string, unknown>
      return { requestId: (raw.request_id as string | undefined) ?? (raw.id as string | undefined) ?? null, raw }
    }
    throw lastErr instanceof Error ? lastErr : new ProviderError(`muapi ${endpoint} failed`, 'muapi')
  }

  function outputsFrom(data: Record<string, unknown>, task: Task): ProviderJob['result'] {
    const urls: string[] = []
    const push = (v: unknown) => { if (typeof v === 'string' && /^https?:\/\//.test(v)) urls.push(v) }
    if (Array.isArray(data.outputs)) for (const o of data.outputs) { if (typeof o === 'string') push(o); else if (o && typeof o === 'object') push((o as { url?: string }).url) }
    push(data.url); push((data.output as { url?: string } | undefined)?.url); if (typeof data.output === 'string') push(data.output)
    push((data.video as { url?: string } | undefined)?.url); push((data.image as { url?: string } | undefined)?.url)
    const kind = task === 't2i' || task === 'i2i' ? 'image' : 'video'
    return { outputs: [...new Set(urls)].map(url => ({ url, mime: kind === 'image' ? 'image/png' : 'video/mp4', kind })) }
  }

  return {
    id: 'muapi',
    allowHosts: [...MUAPI_HOSTS, host],
    capabilities: () => TASKS,
    async isConfigured() { return !!(await opts.vault.resolve(SECRET_NAMES.muapi)) },
    async listModels() { return (catalog ??= await loadMuapiCatalog(opts.catalogFile)) },
    async submit(req: GenerationRequest): Promise<ProviderJob> {
      const endpoint = req.model.endpoint ?? req.model.modelId
      const payload: Record<string, unknown> = { prompt: req.prompt, ...req.params }
      if (req.negativePrompt) payload.negative_prompt = req.negativePrompt
      if (req.seed !== undefined) payload.seed = req.seed
      for (const s of req.sources) {
        const url = await upload(s.bytes, s.mime, `${s.sha256.slice(0, 12)}.${s.mime.split('/')[1] ?? 'bin'}`)
        if (s.role === 'image') payload.image_url = url
        else if (s.role === 'video') payload.video_url = url
        else if (s.role === 'audio') payload.audio_url = url
        else { const refs = (payload.reference_image_urls as string[] | undefined) ?? []; refs.push(url); payload.reference_image_urls = refs }
      }
      const cleaned = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined && v !== null && v !== ''))
      const { requestId, raw } = await submitOnce(endpoint, cleaned)
      if (!requestId) {
        const result = outputsFrom(raw, req.task)
        if (result?.outputs.length) return { providerJobId: `inline-${Date.now()}`, status: 'completed', result }
        throw new ProviderError('muapi returned neither request_id nor outputs', 'muapi')
      }
      return { providerJobId: requestId, status: 'queued' }
    },
    async poll(providerJobId: string, task: Task): Promise<ProviderJob> {
      const res = await guardedFetch(`${base}/api/v1/predictions/${encodeURIComponent(providerJobId)}/result`, { headers: await headers(false), policy })
      if (res.status === 429) { await discardBody(res); throw new ProviderError('muapi poll rate limited', 'muapi', true, 429) }
      if (res.status >= 500) { await discardBody(res); return { providerJobId, status: 'running' } }
      if (!res.ok) throw new ProviderError(`muapi poll ${res.status}: ${(await res.text()).slice(0, 160)}`, 'muapi', false, res.status)
      const data = (await res.json()) as Record<string, unknown>
      const status = String(data.status ?? '').toLowerCase()
      if (['completed', 'succeeded', 'success'].includes(status)) return { providerJobId, status: 'completed', result: outputsFrom(data, task) }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { providerJobId, status: 'failed', error: String(data.error ?? 'generation failed') }
      return { providerJobId, status: status === 'queued' || status === 'pending' ? 'queued' : 'running' }
    },
  }
}
