import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createVault, type GenerationRequest } from '@starlight-intelligence/creator-core'
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

let server: Server
const request: GenerationRequest = { task: 't2i', model: { id: 'muapi/fixture', modelId: 'fixture', provider: 'muapi', name: 'Fixture', tasks: ['t2i'] }, prompt: 'fixture', params: {}, sources: [] }
async function fixture(retryAfter: string, succeed: boolean) {
  let requests = 0
  server = createServer((req, res) => {
    req.resume(); requests++
    if (succeed && requests === 2) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ request_id: 'fixture-job' })); return }
    // Intentionally never finish an error body; retries must cancel it rather than read indefinitely.
    res.writeHead(429, { 'retry-after': retryAfter }); res.write('rate limited')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const vault = await createVault({ backend: 'memory', env: {} }); await vault.set('MUAPI_KEY', 'fixture-only')
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { provider: createMuapiProvider({ vault, baseUrl, fetchPolicy: { allowHosts: [], allowPrivateHosts: true } }), requests: () => requests }
}
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
describe('MuAPI rate limiting', () => {
  it('retries 429 with a bounded Retry-After and releases the stalled response body', async () => {
    const { provider, requests } = await fixture('0', true)
    expect(await provider.submit(request)).toMatchObject({ status: 'queued', providerJobId: 'fixture-job' })
    expect(requests()).toBe(2)
  })
  it('stops at three attempts and retains a retryable error', async () => {
    const { provider, requests } = await fixture('0', false)
    await expect(provider.submit(request)).rejects.toMatchObject({ status: 429, retryable: true })
    expect(requests()).toBe(3)
  })
  it('does not retry before a provider delay beyond the local wait budget', async () => {
    const { provider, requests } = await fixture('60', false)
    await expect(provider.submit(request)).rejects.toMatchObject({ status: 429, retryable: true })
    expect(requests()).toBe(1)
  })
  it('reports poll throttling as retryable without holding the body', async () => {
    const { provider, requests } = await fixture('0', false)
    await expect(provider.poll('fixture-job', 't2i')).rejects.toMatchObject({ status: 429, retryable: true })
    expect(requests()).toBe(1)
  })
})
