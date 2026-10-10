import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createVault } from '@starlight-intelligence/creator-core'
import { createMuapiProvider } from './index.js'

// Error bodies stall after headers; unread guarded bodies would hold the socket and deadline for the full timeout.
describe('MuAPI releases unread error bodies', () => {
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

  async function provider(base: string) {
    const vault = await createVault({ backend: 'memory' })
    await vault.set('MUAPI_KEY', 'fixture-only')
    return createMuapiProvider({ vault, baseUrl: base, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } })
  }
  const model = { id: 'muapi/fixture', provider: 'muapi', modelId: 'fixture', name: 'fixture', tasks: ['i2v' as const] }

  it('reports a running job for poll 5xx without holding the error body', async () => {
    const muapi = await provider(await fixture((_url, res) => stall(res, 503)))
    expect(await muapi.poll('job-1', 'i2v')).toMatchObject({ status: 'running' })
    await released()
  })

  it('fails source upload errors and releases the body', async () => {
    const muapi = await provider(await fixture((_url, res) => stall(res, 413)))
    const source = { role: 'image' as const, bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', sha256: 'a'.repeat(64) }
    await expect(muapi.submit({ task: 'i2v', model, prompt: 'fixture', params: {}, sources: [source] })).rejects.toMatchObject({ status: 413 })
    await released()
  })

  it('releases each retried 5xx submission body', async () => {
    let calls = 0
    const muapi = await provider(await fixture((_url, res) => { calls++; stall(res, 502) }))
    const pending = expect(muapi.submit({ task: 'i2v', model, prompt: 'fixture', params: {}, sources: [] })).rejects.toMatchObject({ status: 502 })
    await vi.waitFor(() => { expect(calls).toBe(1) })
    await released()
    await pending
    expect(calls).toBe(3)
    await released()
  })
})
