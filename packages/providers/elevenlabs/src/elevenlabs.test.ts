import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createVault, type GenerationRequest } from '@starlight-intelligence/creator-core'
import { createElevenLabsProvider } from './index.js'

describe('ElevenLabs HTTP contract', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    server = undefined
  })
  async function fixture(handler: Parameters<typeof createServer>[0], limits: { timeoutMs?: number; maxBytes?: number } = {}) {
    server = createServer(handler)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const vault = await createVault({ backend: 'memory' })
    await vault.set('ELEVENLABS_API_KEY', 'fixture-only')
    return createElevenLabsProvider({
      vault, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      fetchPolicy: { allowHosts: [], allowPrivateHosts: true, ...limits }, defaultVoiceId: 'voice',
    })
  }
  function request(task: 'tts' | 'sfx' | 'music', format = 'mp3'): GenerationRequest {
    return { task, model: { id: 'elevenlabs/music_v1', provider: 'elevenlabs', modelId: task === 'tts' ? 'eleven_multilingual_v2' : 'music_v1', name: 'fixture', tasks: [task] }, prompt: 'fixture', params: { format, duration_s: 12 }, sources: [] }
  }
  it('uses the documented music route and query format, not the mirrored legacy mock', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const provider = await fixture((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        calls.push({ path: req.url!, body: JSON.parse(raw) })
        if (req.url !== '/v1/music?output_format=mp3_44100_128') { res.statusCode = 404; res.end(); return }
        res.setHeader('content-type', 'audio/mpeg'); res.end(Buffer.from('ID3fixture'))
      })
    })
    expect((await provider.submit(request('music'))).status).toBe('completed')
    expect(calls).toEqual([{ path: '/v1/music?output_format=mp3_44100_128', body: { prompt: 'fixture', model_id: 'music_v1', music_length_ms: 12000 } }])
  })
  it('requests native speech WAV and preserves RIFF bytes with WAV MIME', async () => {
    const wav = Buffer.from('524946462600000057415645666d7420100000000100010044ac0000885801000200100064617461020000000000', 'hex')
    const provider = await fixture((req, res) => {
      expect(req.url).toBe('/v1/text-to-speech/voice?output_format=wav_44100')
      res.setHeader('content-type', 'application/octet-stream'); res.end(wav)
    })
    const output = (await provider.submit(request('tts', 'wav'))).result!.outputs[0]!
    expect(output.mime).toBe('audio/wav')
    expect(Buffer.from(output.bytes!)).toEqual(wav)
  })
  it('places sound-effect formats in the query and refuses undocumented WAV before generation', async () => {
    let calls = 0
    const provider = await fixture((req, res) => {
      calls++
      expect(req.url).toBe('/v1/sound-generation?output_format=mp3_44100_128')
      res.setHeader('content-type', 'audio/mpeg'); res.end('ID3fixture')
    })
    await provider.submit(request('sfx'))
    await expect(provider.submit(request('sfx', 'wav'))).rejects.toThrow('does not support WAV')
    await expect(provider.submit(request('music', 'wav'))).rejects.toThrow('does not support WAV')
    expect(calls).toBe(1)
  })
  it.each([401, 429, 500])('reports model HTTP %s instead of synthetic success', async status => {
    const provider = await fixture((_req, res) => { res.statusCode = status; res.end('{}') })
    await expect(provider.listModels()).rejects.toMatchObject({ status })
  })
  it.each(['{}', '[{}]', 'not json'])('rejects malformed model reply %s and recovers', async reply => {
    let body = reply
    const provider = await fixture((_req, res) => { res.end(body) })
    await expect(provider.listModels()).rejects.toThrow()
    body = '[{"model_id":"eleven_multilingual_v2","can_do_text_to_speech":true}]'
    expect((await provider.listModels()).some(m => m.tasks.includes('tts'))).toBe(true)
  })
  it('rejects HTTP failures, empty audio, JSON, and PCM mislabeled WAV', async () => {
    let status = 503
    let body = 'failure'
    let mime = 'text/plain'
    const provider = await fixture((_req, res) => { res.statusCode = status; res.setHeader('content-type', mime); res.end(body) })
    await expect(provider.submit(request('tts'))).rejects.toMatchObject({ status: 503 })
    status = 200; body = ''; mime = 'audio/mpeg'
    await expect(provider.submit(request('tts'))).rejects.toThrow('empty audio')
    body = '{}'; mime = 'application/json'
    await expect(provider.submit(request('tts'))).rejects.toThrow('non-audio')
    body = 'raw PCM'; mime = 'audio/wav'
    await expect(provider.submit(request('tts', 'wav'))).rejects.toThrow('invalid WAV')
    mime = 'application/octet-stream'
    await expect(provider.submit(request('tts'))).rejects.toThrow('invalid MP3')
  })
  it('bounds stalled models and oversize chunked audio', async () => {
    let stall = true
    const provider = await fixture((_req, res) => {
      if (stall) res.write('[')
      else { res.setHeader('content-type', 'audio/mpeg'); res.write('ID3'); res.end('too many bytes') }
    }, { timeoutMs: 30, maxBytes: 8 })
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'timeout' })
    stall = false
    await expect(provider.submit(request('tts'))).rejects.toMatchObject({ code: 'too_large' })
  })
  it('surfaces network failures during lookup', async () => {
    const vault = await createVault({ backend: 'memory' })
    await vault.set('ELEVENLABS_API_KEY', 'fixture-only')
    const provider = createElevenLabsProvider({ vault, baseUrl: 'http://127.0.0.1:1', fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    await expect(provider.listModels()).rejects.toThrow()
  })
})
