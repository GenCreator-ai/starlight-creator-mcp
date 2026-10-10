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
