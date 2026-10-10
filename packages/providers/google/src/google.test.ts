import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createVault } from '@starlight-intelligence/creator-core'
import { createGoogleProvider } from './index.js'

// Error bodies stall after headers; unread guarded bodies would hold the socket and deadline for the full timeout.
describe('Google releases unread error bodies', () => {
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

  it.each([401, 403, 500])('model listing %s', async status => {
    const base = await fixture((_url, res) => stall(res, status))
    const vault = await createVault({ backend: 'memory' })
    await vault.set('GEMINI_API_KEY', 'fixture-only')
    const provider = createGoogleProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
    await expect(provider.listModels()).rejects.toMatchObject({ status })
    await released()
  })
})
