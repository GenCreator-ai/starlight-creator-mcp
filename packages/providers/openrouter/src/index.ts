import {
  discardBody, guardedFetch, ProviderError, SECRET_NAMES, type FetchPolicy, type GenerationRequest, type ModelRecord, type Provider, type ProviderJob, type Task, type TextRequest, type TextResult, type Vault,
} from '@starlight-intelligence/creator-core'

export const OPENROUTER_HOST = 'openrouter.ai'
const DEFAULT_JUDGE = 'google/gemini-2.5-flash'

interface ORModel { id: string; name?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; pricing?: Record<string, string | number>; supported_resolutions?: string[]; supported_aspect_ratios?: string[] }

function tasksFor(m: ORModel): Task[] {
  const inMods = m.architecture?.input_modalities ?? ['text']
  const outMods = m.architecture?.output_modalities ?? ['text']
  const tasks = new Set<Task>()
  if (outMods.includes('text')) { tasks.add('chat'); if (inMods.includes('image')) tasks.add('vision') }
  if (outMods.includes('image')) { tasks.add('t2i'); if (inMods.includes('image')) tasks.add('i2i') }
  if (outMods.includes('video')) { tasks.add('t2v'); if (inMods.includes('image')) tasks.add('i2v') }
  // Advertise only tasks implemented by submit/text; audio modalities alone
  // do not establish a working speech generation or transcription adapter.
  return [...tasks]
}

function toRecord(m: ORModel): ModelRecord {
  const price = m.pricing?.image ?? m.pricing?.prompt
  return {
    id: `openrouter/${m.id}`, provider: 'openrouter', modelId: m.id, name: m.name ?? m.id, tasks: tasksFor(m),
    ...(m.supported_aspect_ratios ? { aspect_ratios: m.supported_aspect_ratios } : {}), ...(m.supported_resolutions ? { resolutions: m.supported_resolutions } : {}),
    ...(price !== undefined && !Number.isNaN(Number(price)) ? { pricing: { unit: 'per_unit', usd: Number(price) } } : {}),
  }
}

export interface OpenRouterProviderOptions { vault: Vault; fetchPolicy?: FetchPolicy; baseUrl?: string; judgeModel?: string; appName?: string }

export function createOpenRouterProvider(opts: OpenRouterProviderOptions): Provider {
  const base = (opts.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai').replace(/\/+$/, '')
  const host = new URL(base).hostname
  const policy: FetchPolicy = { allowHosts: [...(opts.fetchPolicy?.allowHosts ?? []), OPENROUTER_HOST, host], allowPrivateHosts: opts.fetchPolicy?.allowPrivateHosts ?? false, timeoutMs: 120_000 }
  const key = () => opts.vault.require(SECRET_NAMES.openrouter, 'Create a key at openrouter.ai/keys, then run `creator-mcp setup` or set OPENROUTER_API_KEY.')
  const headers = async () => ({ Authorization: `Bearer ${await key()}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/frankxai/starlight-creator-mcp', 'X-Title': opts.appName ?? 'creator-mcp' })

  async function json<T>(url: string, init: RequestInit): Promise<T> {
    const res = await guardedFetch(url, { ...init, headers: { ...(await headers()), ...(init.headers as Record<string, string> | undefined) }, policy })
    if (!res.ok) throw new ProviderError(`openrouter ${new URL(url).pathname} ${res.status}: ${(await res.text()).slice(0, 240)}`, 'openrouter', res.status >= 500 || res.status === 429, res.status)
    return (await res.json()) as T
  }

  const b64ToBytes = (b64: string) => new Uint8Array(Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64'))
  const dataUrl = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

  return {
    id: 'openrouter',
    allowHosts: [OPENROUTER_HOST, host],
    capabilities: () => ['chat', 'vision', 't2i', 'i2i', 't2v', 'i2v'],
    async isConfigured() { return !!(await opts.vault.resolve(SECRET_NAMES.openrouter)) },
    async listModels() {
      const data = await json<{ data: ORModel[] }>(`${base}/api/v1/models`, { method: 'GET' })
      return data.data.map(toRecord).filter(m => m.tasks.length)
    },
    async submit(req: GenerationRequest): Promise<ProviderJob> {
      const refs = req.sources.filter(s => s.role === 'image' || s.role === 'reference').map(s => ({ type: 'image_url', image_url: { url: dataUrl(s.bytes, s.mime) } }))
      const p = req.params
      if (req.task === 't2i' || req.task === 'i2i') {
        const body: Record<string, unknown> = { model: req.model.modelId, prompt: req.prompt ?? '', n: 1, ...(p.aspect_ratio ? { aspect_ratio: p.aspect_ratio } : {}), ...(p.resolution ? { resolution: p.resolution } : {}), ...(p.size ? { size: p.size } : {}), ...(p.output_format ? { output_format: p.output_format } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}), ...(refs.length ? { input_references: refs } : {}) }
        const data = await json<{ data: Array<{ b64_json?: string; url?: string; media_type?: string }>; usage?: { cost?: number; is_byok?: boolean } }>(`${base}/api/v1/images`, { method: 'POST', body: JSON.stringify(body) })
        const outputs = data.data.map(d => ({ mime: d.media_type ?? 'image/png', kind: 'image' as const, ...(d.b64_json ? { bytes: b64ToBytes(d.b64_json) } : {}), ...(d.url ? { url: d.url } : {}) }))
        return { providerJobId: `inline-${Date.now()}`, status: 'completed', result: { outputs, ...(data.usage?.cost !== undefined ? { costUsd: data.usage.cost } : {}), ...(data.usage?.is_byok !== undefined ? { isByok: data.usage.is_byok } : {}) } }
      }
      if (req.task === 't2v' || req.task === 'i2v') {
        const body: Record<string, unknown> = { model: req.model.modelId, prompt: req.prompt ?? '', ...(p.duration_s ? { duration: p.duration_s } : p.duration ? { duration: p.duration } : {}), ...(p.resolution ? { resolution: p.resolution } : {}), ...(p.aspect_ratio ? { aspect_ratio: p.aspect_ratio } : {}), ...(p.generate_audio !== undefined ? { generate_audio: p.generate_audio } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}), ...(refs.length ? { frame_images: refs.map(r => ({ ...r, frame: 'first' })) } : {}) }
        const data = await json<{ id: string; status: string }>(`${base}/api/v1/videos`, { method: 'POST', body: JSON.stringify(body) })
        return { providerJobId: data.id, status: 'queued' }
      }
      throw new ProviderError(`openrouter provider does not handle task ${req.task}`, 'openrouter')
    },
    async poll(providerJobId: string): Promise<ProviderJob> {
      if (providerJobId.startsWith('inline-')) return { providerJobId, status: 'completed', result: { outputs: [] } }
      const data = await json<{ status: string; unsigned_urls?: string[]; usage?: { cost?: number; is_byok?: boolean }; error?: { message?: string } | string }>(`${base}/api/v1/videos/${encodeURIComponent(providerJobId)}`, { method: 'GET' })
      if (data.status === 'failed') return { providerJobId, status: 'failed', error: typeof data.error === 'string' ? data.error : data.error?.message ?? 'video generation failed' }
      if (data.status !== 'completed') return { providerJobId, status: data.status === 'pending' ? 'queued' : 'running' }
      const urls = data.unsigned_urls?.length ? data.unsigned_urls : [`${base}/api/v1/videos/${encodeURIComponent(providerJobId)}/content`]
      const auth = await headers()
      const outputs = []
      for (const url of urls) {
        const res = await guardedFetch(url, { headers: { Authorization: auth.Authorization }, policy: { ...policy, maxBytes: 512 * 1024 * 1024 } })
        if (!res.ok) {
          await discardBody(res)
          throw new ProviderError(`openrouter video download ${res.status}`, 'openrouter', res.status >= 500, res.status)
        }
        outputs.push({ bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4', kind: 'video' as const })
      }
      return { providerJobId, status: 'completed', result: { outputs, ...(data.usage?.cost !== undefined ? { costUsd: data.usage.cost } : {}), ...(data.usage?.is_byok !== undefined ? { isByok: data.usage.is_byok } : {}) } }
    },
    async text(req: TextRequest): Promise<TextResult> {
      const model = req.model ?? opts.judgeModel ?? process.env.CREATOR_JUDGE_MODEL ?? DEFAULT_JUDGE
      const messages: Array<Record<string, unknown>> = []
      if (req.system) messages.push({ role: 'system', content: req.system })
      for (const m of req.messages) messages.push({ role: m.role, content: m.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image_url', image_url: { url: dataUrl(c.bytes, c.mime) } }) })
      const body = { model, messages, temperature: req.temperature ?? 0, max_tokens: req.maxTokens ?? 1024, ...(req.json ? { response_format: { type: 'json_object' } } : {}) }
      const data = await json<{ model?: string; choices: Array<{ message: { content: string | Array<{ type: string; text?: string }> } }>; usage?: { cost?: number } }>(`${base}/api/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) })
      const content = data.choices[0]?.message.content
      const text = typeof content === 'string' ? content : (content ?? []).map(c => c.text ?? '').join('')
      return { text, model: data.model ?? model, ...(data.usage?.cost !== undefined ? { costUsd: data.usage.cost } : {}) }
    },
  }
}
