import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createVault } from '@starlight-intelligence/creator-core'
import { createOpenRouterProvider } from './index.js'

// Error bodies stall after headers; unread guarded bodies would hold the socket and deadline for the full timeout.
describe('OpenRouter releases unread error bodies', () => {
  let server: Server | undefined
  let sockets = new Set<unknown>()
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    server = undefined
  })
  async function fixture(handler: (url: string, res: import('node:http').ServerResponse, base: string) => void): Promise<string> {
    const live = sockets = new Set()
    server = createServer((req, res) => {
      live.add(req.socket)
      req.socket.once('close', () => { live.delete(req.socket) })
      req.resume()
      handler(req.url ?? '/', res, `http://127.0.0.1:${(server!.address() as { port: number }).port}`)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const stall = (res: import('node:http').ServerResponse, status: number) => { res.writeHead(status, { 'content-type': 'application/json' }); res.write('{"error":') }
  const released = () => vi.waitFor(() => { expect(sockets.size).toBe(0) }, { timeout: 1000 })

  it('does not advertise unsupported speech tasks from audio catalog modalities', async () => {
    const base = await fixture((_url, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [
        { id: 'audio-only', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
        { id: 'mixed', architecture: { input_modalities: ['audio', 'text'], output_modalities: ['audio', 'text'] } },
      ] }))
    })
    const vault = await createVault({ backend: 'memory', env: {} })
    await vault.set('OPENROUTER_API_KEY', 'fixture-only')
    const provider = createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    expect(await provider.listModels()).toMatchObject([{ id: 'openrouter/mixed', tasks: ['chat'] }])
    expect(provider.capabilities()).not.toContain('tts')
    expect(provider.capabilities()).not.toContain('stt')
  })

  it('recovers a cross-origin video through the authenticated API proxy without contacting its host', async () => {
    let requests = 0
    const external = createServer((req, res) => { requests++; req.resume(); res.end('video') })
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
    try {
      const media = `http://127.0.0.1:${(external.address() as { port: number }).port}/content`
      const base = await fixture((url, res) => {
        if (url === '/api/v1/videos/vid/content?index=0') { res.setHeader('content-type', 'video/mp4'); res.end('video'); return }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'completed', unsigned_urls: [media] }))
      })
      server!.on('request', req => { if (req.url?.includes('/content?')) expect(req.headers.authorization).toBe('Bearer fixture-only') })
      const vault = await createVault({ backend: 'memory', env: {} })
      await vault.set('OPENROUTER_API_KEY', 'fixture-only')
      const provider = createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: ['127.0.0.1'], allowPrivateHosts: true } })
      expect((await provider.poll('vid', 't2v')).result?.outputs?.[0]?.bytes).toEqual(new Uint8Array(Buffer.from('video')))
      expect(requests).toBe(0)
    } finally { external.closeAllConnections(); await new Promise<void>(resolve => external.close(() => resolve())) }
  })
  it('preserves multiple external output indices through the documented content proxy', async () => {
    const paths: string[] = []
    const base = await fixture((url, res) => {
      paths.push(url)
      if (url.includes('/content?')) { res.setHeader('content-type', 'video/mp4'); res.end(url.endsWith('=0') ? 'first' : 'second'); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'completed', unsigned_urls: ['https://storage.example.com/first.mp4', 'https://storage.example.com/second.mp4'] }))
    })
    const vault = await createVault({ backend: 'memory', env: {} }); await vault.set('OPENROUTER_API_KEY', 'fixture-only')
    const provider = createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    const result = await provider.poll('vid', 't2v')
    expect(result.result?.outputs?.map(output => Buffer.from(output.bytes!).toString())).toEqual(['first', 'second'])
    expect(paths).toEqual(['/api/v1/videos/vid', '/api/v1/videos/vid/content?index=0', '/api/v1/videos/vid/content?index=1'])
  })
  it('preserves authorization on same-origin video content', async () => {
    let authorized = false
    const base = await fixture((url, res, origin) => {
      res.setHeader('content-type', url === '/content' ? 'video/mp4' : 'application/json')
      if (url === '/content') { authorized = true; res.end('video'); return }
      res.end(JSON.stringify({ status: 'completed', unsigned_urls: [`${origin}/content`] }))
    })
    server!.on('request', (req) => { if (req.url === '/content') expect(req.headers.authorization).toBe('Bearer fixture-only') })
    const vault = await createVault({ backend: 'memory', env: {} })
    await vault.set('OPENROUTER_API_KEY', 'fixture-only')
    expect((await createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } }).poll('vid', 't2v')).result?.outputs).toHaveLength(1)
    expect(authorized).toBe(true)
  })
  it.each(['failed', 'expired', 'cancelled'])('stops polling a terminal %s video job', async status => {
    const base = await fixture((_url, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status })) })
    const vault = await createVault({ backend: 'memory', env: {} }); await vault.set('OPENROUTER_API_KEY', 'fixture-only')
    const provider = createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    expect(await provider.poll('vid', 't2v')).toMatchObject({ status: status === 'cancelled' ? 'cancelled' : 'failed' })
  })
  it('fails a video download error without holding the body', async () => {
    const base = await fixture((url, res, origin) => {
      if (url === '/api/v1/videos/vid') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'completed', unsigned_urls: [`${origin}/content`] })); return }
      stall(res, 500)
    })
    const vault = await createVault({ backend: 'memory' })
    await vault.set('OPENROUTER_API_KEY', 'fixture-only')
    const provider = createOpenRouterProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    await expect(provider.poll('vid', 't2v')).rejects.toMatchObject({ status: 500 })
    await released()
  })
})
