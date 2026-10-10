import { discardBody, guardedFetch, ProviderError, SECRET_NAMES, type FetchPolicy, type ModelRecord, type Provider, type ProviderJob, type TextRequest, type TextResult, type Vault } from '@starlight-intelligence/creator-core'

export const GOOGLE_HOST = 'generativelanguage.googleapis.com'
const DEFAULT_JUDGE = 'gemini-2.5-flash'

export interface GoogleProviderOptions { vault: Vault; fetchPolicy?: FetchPolicy; baseUrl?: string; judgeModel?: string }

export function createGoogleProvider(opts: GoogleProviderOptions): Provider {
  const base = (opts.baseUrl ?? process.env.GOOGLE_GENAI_BASE_URL ?? `https://${GOOGLE_HOST}`).replace(/\/+$/, '')
  const host = new URL(base).hostname
  const policy: FetchPolicy = { allowHosts: [...(opts.fetchPolicy?.allowHosts ?? []), GOOGLE_HOST, host], allowPrivateHosts: opts.fetchPolicy?.allowPrivateHosts ?? false, timeoutMs: 90_000 }
  const key = () => opts.vault.require(SECRET_NAMES.gemini, 'Create a key at aistudio.google.com, then run `creator-mcp setup` or set GEMINI_API_KEY.')

  return {
    id: 'google',
    allowHosts: [GOOGLE_HOST, host],
    capabilities: () => ['chat', 'vision'],
    async isConfigured() { return !!(await opts.vault.resolve(SECRET_NAMES.gemini)) },
    async listModels(): Promise<ModelRecord[]> {
      const res = await guardedFetch(`${base}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': await key() }, policy })
      if (!res.ok) {
        await discardBody(res)
        throw new ProviderError(`google models ${res.status}`, 'google', res.status >= 500, res.status)
      }
      const data = (await res.json()) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }
      return (data.models ?? []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => {
        const id = m.name.replace(/^models\//, '')
        return { id: `google/${id}`, provider: 'google', modelId: id, name: m.displayName ?? id, tasks: ['chat', 'vision'] as ModelRecord['tasks'] }
      })
    },
    async submit() { throw new ProviderError('google provider handles judging only in this version; use openrouter or muapi for generation', 'google') },
    async poll(providerJobId): Promise<ProviderJob> { return { providerJobId, status: 'failed', error: 'unsupported' } },
    async text(req: TextRequest): Promise<TextResult> {
      const model = (req.model ?? opts.judgeModel ?? process.env.CREATOR_JUDGE_MODEL ?? DEFAULT_JUDGE).replace(/^google\//, '')
      const contents = req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.content.map(c => c.type === 'text' ? { text: c.text } : { inlineData: { mimeType: c.mime, data: Buffer.from(c.bytes).toString('base64') } }) }))
      const body = { ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}), contents, generationConfig: { temperature: req.temperature ?? 0, maxOutputTokens: req.maxTokens ?? 1024, ...(req.json ? { responseMimeType: 'application/json' } : {}) } }
      const res = await guardedFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': await key() }, body: JSON.stringify(body), policy })
      if (!res.ok) throw new ProviderError(`google generateContent ${res.status}: ${(await res.text()).slice(0, 200)}`, 'google', res.status >= 500 || res.status === 429, res.status)
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
      return { text, model: `google/${model}` }
    },
  }
}
