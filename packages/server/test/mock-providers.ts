import { createServer, type Server } from 'node:http'

export const MP3_STUB = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(64, 7)])

export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

export interface MockState { muapiCalls: Array<{ endpoint: string; body: unknown }>; orCalls: Array<{ path: string; body: unknown }>; elevenCalls: Array<{ path: string; body: unknown }>; judgeScores: number[]; videoPolls: number }

export async function startMockProviders(): Promise<{ server: Server; url: string; state: MockState }> {
  const state: MockState = { muapiCalls: [], orCalls: [], elevenCalls: [], judgeScores: [], videoPolls: 0 }
  const pending = new Map<string, number>()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      const url = new URL(req.url ?? '/', 'http://localhost')
      const json = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
      if (url.pathname === '/api/v1/models') return json(200, { data: [
        { id: 'google/gemini-2.5-flash', name: 'Gemini Flash', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
        { id: 'openai/gpt-image-1', name: 'GPT Image', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
        { id: 'google/veo-3.1', name: 'Veo 3.1', architecture: { input_modalities: ['text', 'image'], output_modalities: ['video'] } },
      ] })
      if (url.pathname === '/api/v1/chat/completions') {
        state.orCalls.push({ path: url.pathname, body })
        const score = state.judgeScores.shift() ?? 88
        return json(200, { model: 'google/gemini-2.5-flash', choices: [{ message: { content: JSON.stringify({ dims: { composition: score, lighting: score, color: score, 'subject-clarity': score, artifacts: 100 - score, truth: score, clarity: score, voice: score, structure: score }, strengths: ['clear subject'], weaknesses: ['flat light'], auto_failed: [] }) } }], usage: { cost: 0.0001 } })
      }
      if (url.pathname === '/api/v1/images') {
        state.orCalls.push({ path: url.pathname, body })
        return json(200, { data: [{ b64_json: Buffer.concat([PNG_1x1, Buffer.from([state.orCalls.length])]).toString('base64'), media_type: 'image/png' }], usage: { cost: 0.02, is_byok: true } })
      }
      if (url.pathname === '/api/v1/videos' && req.method === 'POST') { state.orCalls.push({ path: url.pathname, body }); pending.set('vid_1', 0); return json(202, { id: 'vid_1', polling_url: '/api/v1/videos/vid_1', status: 'pending' }) }
      if (url.pathname === '/api/v1/videos/vid_1') { state.videoPolls++; const n = (pending.get('vid_1') ?? 0) + 1; pending.set('vid_1', n); return json(200, n < 2 ? { id: 'vid_1', status: 'in_progress' } : { id: 'vid_1', status: 'completed', unsigned_urls: [`http://localhost:${(server.address() as { port: number }).port}/api/v1/videos/vid_1/content`], usage: { cost: 0.5, is_byok: false } }) }
      if (url.pathname === '/api/v1/videos/vid_1/content') { res.setHeader('content-type', 'video/mp4'); res.end(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4])); return }
      // --- ElevenLabs ---
      if (url.pathname === '/v1/models') return json(200, [{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true }])
      if (url.pathname === '/v1/voices') return json(200, { voices: [{ voice_id: 'voice_mock_1', name: 'Mock Voice' }] })
      if (url.pathname.startsWith('/v1/text-to-speech/') || url.pathname === '/v1/sound-generation' || url.pathname === '/v1/music/compose') {
        state.elevenCalls.push({ path: url.pathname, body })
        res.setHeader('content-type', 'audio/mpeg')
        res.end(MP3_STUB)
        return
      }
      const mu = /^\/api\/v1\/(.+)$/.exec(url.pathname)
      if (mu && req.method === 'POST' && !mu[1]!.startsWith('predictions')) { state.muapiCalls.push({ endpoint: mu[1]!, body }); return json(200, { request_id: `req_${state.muapiCalls.length}` }) }
      const poll = /^\/api\/v1\/predictions\/(.+)\/result$/.exec(url.pathname)
      if (poll) return json(200, { status: 'completed', outputs: [`http://localhost:${(server.address() as { port: number }).port}/cdn/${poll[1]}.png`] })
      if (url.pathname.startsWith('/cdn/')) { res.setHeader('content-type', 'image/png'); res.end(Buffer.concat([PNG_1x1, Buffer.from(url.pathname)])); return }
      json(404, { error: `mock: no route for ${req.method} ${url.pathname}` })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { server, url, state }
}
