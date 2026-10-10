import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobManager } from './jobs/manager.js'
import { PolarLicense } from './license/polar.js'
import { PostizAdapter } from './publish/postiz.js'
import { ManifestSigner } from './publish/signer.js'
import { createVault } from './vault/index.js'

// Each error response stalls after its headers. Unless the caller cancels the guarded body, the
// socket and the guarded deadline stay alive for the full provider timeout (15-120 s).
describe('guarded callers release unread error bodies', () => {
  let server: Server | undefined
  let home: string | undefined
  let sockets = new Set<unknown>()
  let requests = 0
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    if (home) await rm(home, { recursive: true, force: true })
    server = undefined; home = undefined; requests = 0
  })
  async function stalling(status: (url: string) => number): Promise<string> {
    const live = sockets = new Set()
    server = createServer((req, res) => {
      requests++
      live.add(req.socket)
      req.socket.once('close', () => { live.delete(req.socket) })
      req.resume()
      res.writeHead(status(req.url ?? '/'), { 'content-type': 'application/json' })
      res.write('{"error":')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const released = () => vi.waitFor(() => { expect(sockets.size).toBe(0) }, { timeout: 1000 })
  const policy = { allowHosts: [], allowPrivateHosts: true }

  it.each([401, 403, 404, 500])('Polar validate %s', async status => {
    const base = await stalling(() => status)
    home = await mkdtemp(path.join(os.tmpdir(), 'creator-polar-'))
    const license = new PolarLicense({ home, signer: new ManifestSigner(await createVault({ backend: 'memory' })), fetchPolicy: policy, baseUrl: base })
    const result = await license.validate({ key: 'fixture-key', organizationId: 'org', packsByBenefit: {} })
    expect(result.valid).toBe(false)
    await released()
  })

  it('Polar activation failure', async () => {
    const base = await stalling(() => 422)
    home = await mkdtemp(path.join(os.tmpdir(), 'creator-polar-'))
    const license = new PolarLicense({ home, signer: new ManifestSigner(await createVault({ backend: 'memory' })), fetchPolicy: policy, baseUrl: base })
    expect(await license.activate('fixture-key', 'org')).toBeNull()
    await released()
  })

  it('Postiz channel fallback, upload, and metrics failures', async () => {
    const base = await stalling(() => 502)
    const postiz = new PostizAdapter({ apiUrl: base, apiKey: 'fixture-key', fetchPolicy: policy })
    await expect(postiz.listChannels()).rejects.toThrow('502')
    expect(requests).toBe(2)
    await released()
    expect(await postiz.uploadFromUrl('https://cdn.example.com/a.png')).toBeNull()
    await released()
    expect(await postiz.fetchMetrics('post-1')).toBeNull()
    await released()
  })

  it('job output download failure', async () => {
    const base = await stalling(() => 500)
    const manager = new JobManager({
      providers: { get: () => ({ allowHosts: [] }) }, fetchPolicy: policy, maxAssetBytes: 1024,
    } as unknown as ConstructorParameters<typeof JobManager>[0])
    const download = (manager as unknown as { download(url: string, provider: string): Promise<Uint8Array> }).download.bind(manager)
    await expect(download(`${base}/output.png`, 'fixture')).rejects.toThrow('returned 500')
    await released()
  })
})
