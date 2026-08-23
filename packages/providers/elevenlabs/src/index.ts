import {
  guardedFetch, ProviderError, readBodyLimited, SECRET_NAMES,
  type FetchPolicy, type GenerationRequest, type ModelRecord, type Provider, type ProviderJob, type Vault,
} from '@starlight-intelligence/creator-core'

export const ELEVENLABS_HOST = 'api.elevenlabs.io'

const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2'
const DEFAULT_SFX_MODEL = 'eleven_text_to_sound_v2'
const DEFAULT_MUSIC_MODEL = 'music_v1'
const MAX_AUDIO_BYTES = 100 * 1024 * 1024

// ElevenLabs returns audio synchronously, so every job completes on submit.
const SYNTHETIC: ModelRecord[] = [
  { id: `elevenlabs/${DEFAULT_SFX_MODEL}`, provider: 'elevenlabs', modelId: DEFAULT_SFX_MODEL, name: 'Text to Sound Effects', tasks: ['sfx'] },
  { id: `elevenlabs/${DEFAULT_MUSIC_MODEL}`, provider: 'elevenlabs', modelId: DEFAULT_MUSIC_MODEL, name: 'Eleven Music', tasks: ['music'] },
]

interface ElevenModel { model_id: string; name?: string; can_do_text_to_speech?: boolean }
interface ElevenVoice { voice_id: string; name?: string }

function outputFormat(format: unknown): string {
  return String(format ?? 'mp3') === 'wav' ? 'pcm_44100' : 'mp3_44100_128'
}

function mimeFor(format: string): string {
  return format.startsWith('pcm') || format.startsWith('wav') ? 'audio/wav' : 'audio/mpeg'
}

export interface ElevenLabsProviderOptions { vault: Vault; fetchPolicy?: FetchPolicy; baseUrl?: string; defaultVoiceId?: string }

export function createElevenLabsProvider(opts: ElevenLabsProviderOptions): Provider {
  const base = (opts.baseUrl ?? process.env.ELEVENLABS_BASE_URL ?? `https://${ELEVENLABS_HOST}`).replace(/\/+$/, '')
  const host = new URL(base).hostname
  const policy: FetchPolicy = {
    allowHosts: [...(opts.fetchPolicy?.allowHosts ?? []), ELEVENLABS_HOST, host],
    allowPrivateHosts: opts.fetchPolicy?.allowPrivateHosts ?? false,
    timeoutMs: 180_000,
    maxBytes: MAX_AUDIO_BYTES,
  }
  const key = () => opts.vault.require(SECRET_NAMES.elevenlabs, 'Create a key at elevenlabs.io, then run `creator-mcp setup` or set ELEVENLABS_API_KEY.')
  const headers = async (json = true) => ({ 'xi-api-key': await key(), ...(json ? { 'Content-Type': 'application/json' } : {}) })

  let cachedVoice: string | null = null

  async function resolveVoice(requested?: unknown): Promise<string> {
    const asked = typeof requested === 'string' && requested.trim() ? requested.trim() : null
    if (asked) return asked
    const configured = opts.defaultVoiceId ?? process.env.ELEVENLABS_VOICE_ID
    if (configured) return configured
    if (cachedVoice) return cachedVoice
    const res = await guardedFetch(`${base}/v1/voices`, { headers: await headers(false), policy })
    if (!res.ok) throw new ProviderError(`elevenlabs voices ${res.status}; pass voice explicitly or set ELEVENLABS_VOICE_ID`, 'elevenlabs', res.status >= 500, res.status)
    const data = (await res.json()) as { voices?: ElevenVoice[] }
    const first = data.voices?.[0]?.voice_id
    if (!first) throw new ProviderError('your ElevenLabs account has no voices; add one or pass voice explicitly', 'elevenlabs')
    cachedVoice = first
    return first
  }

  async function audioJob(url: string, body: Record<string, unknown>, format: string): Promise<ProviderJob> {
    const res = await guardedFetch(url, { method: 'POST', headers: await headers(), body: JSON.stringify(body), policy })
    if (!res.ok) throw new ProviderError(`elevenlabs ${new URL(url).pathname} ${res.status}: ${(await res.text()).slice(0, 200)}`, 'elevenlabs', res.status >= 500 || res.status === 429, res.status)
    const bytes = await readBodyLimited(res, MAX_AUDIO_BYTES)
    if (!bytes.byteLength) throw new ProviderError('elevenlabs returned an empty audio body', 'elevenlabs')
    return {
      providerJobId: `inline-${Date.now()}`,
      status: 'completed',
      result: { outputs: [{ bytes, mime: res.headers.get('content-type')?.split(';')[0] ?? mimeFor(format), kind: 'audio' }] },
    }
  }

  return {
    id: 'elevenlabs',
    allowHosts: [ELEVENLABS_HOST, host],
    capabilities: () => ['tts', 'music', 'sfx'],
    async isConfigured() { return !!(await opts.vault.resolve(SECRET_NAMES.elevenlabs)) },

    async listModels(): Promise<ModelRecord[]> {
      const models: ModelRecord[] = [...SYNTHETIC]
      try {
        const res = await guardedFetch(`${base}/v1/models`, { headers: await headers(false), policy })
        if (res.ok) {
          const list = (await res.json()) as ElevenModel[]
          for (const m of list) {
            if (m.can_do_text_to_speech === false) continue
            models.push({ id: `elevenlabs/${m.model_id}`, provider: 'elevenlabs', modelId: m.model_id, name: m.name ?? m.model_id, tasks: ['tts'] })
          }
        }
      } catch { /* fall back to the synthetic default below */ }
      if (!models.some(m => m.tasks.includes('tts'))) {
        models.push({ id: `elevenlabs/${DEFAULT_TTS_MODEL}`, provider: 'elevenlabs', modelId: DEFAULT_TTS_MODEL, name: 'Eleven Multilingual v2', tasks: ['tts'] })
      }
      return models
    },

    async submit(req: GenerationRequest): Promise<ProviderJob> {
      const p = req.params
      const format = outputFormat(p.format)
      if (req.task === 'tts') {
        if (!req.prompt) throw new ProviderError('text is required for speech', 'elevenlabs')
        const voice = await resolveVoice(p.voice)
        const body: Record<string, unknown> = { text: req.prompt, model_id: req.model.modelId === DEFAULT_MUSIC_MODEL ? DEFAULT_TTS_MODEL : req.model.modelId }
        if (typeof p.language === 'string') body.language_code = p.language
        return audioJob(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`, body, format)
      }
      if (req.task === 'sfx') {
        if (!req.prompt) throw new ProviderError('prompt is required for sound effects', 'elevenlabs')
        const body: Record<string, unknown> = { text: req.prompt, model_id: DEFAULT_SFX_MODEL, output_format: format }
        // the API accepts 0.5-30s; anything else is left to auto-detection
        const d = Number(p.duration_s)
        if (Number.isFinite(d) && d >= 0.5 && d <= 30) body.duration_seconds = d
        return audioJob(`${base}/v1/sound-generation`, body, format)
      }
      if (req.task === 'music') {
        if (!req.prompt) throw new ProviderError('prompt is required for music', 'elevenlabs')
        const body: Record<string, unknown> = { prompt: req.prompt, output_format: format }
        const d = Number(p.duration_s)
        if (Number.isFinite(d)) body.music_length_ms = Math.min(Math.max(Math.round(d * 1000), 3000), 600_000)
        return audioJob(`${base}/v1/music/compose`, body, format)
      }
      throw new ProviderError(`elevenlabs handles tts, sfx and music; not ${req.task}`, 'elevenlabs')
    },

    async poll(providerJobId: string): Promise<ProviderJob> {
      // every ElevenLabs call completes on submit; a poll can only mean the result was already ingested
      return { providerJobId, status: 'completed', result: { outputs: [] } }
    },
  }
}
