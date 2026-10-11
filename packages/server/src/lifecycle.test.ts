import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { CanonIndex, CreatorContext, JsonlLedger, configSchema, createVault } from '@starlight-intelligence/creator-core'
import { mergePacks, PACK_SCHEMA_VERSION, packManifestSchema } from '@starlight-intelligence/creator-packs-spec'
import { createCreatorServer } from './create-server.js'
import { serveCreatorHttp } from './http.js'

let home: string
const contexts: CreatorContext[] = []
const servers: import('node:http').Server[] = []
async function context() {
  home ??= await mkdtemp(path.join(tmpdir(), 'creator-lifecycle-'))
  vi.stubEnv('CREATOR_MCP_HOME', home)
  const ctx = await CreatorContext.create({ config: configSchema.parse({}), vault: await createVault({ backend: 'memory', env: {} }), ledger: new JsonlLedger(null), packs: [], providers: () => [] })
  contexts.push(ctx)
  return ctx
}
const options = { name: 'fixture', version: '0.1.0', packs: [], providers: () => [] }
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.close()
  if (home) await rm(home, { recursive: true, force: true })
  home = undefined!
})
describe('owned Creator context lifecycle', () => {
  it('denies linked and oversized local asset imports through HTTP tools', async () => {
    const ctx = await context(), outside = path.join(home, 'outside')
    await mkdir(ctx.assets.local.root, { recursive: true })
    await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private fixture')
    await symlink(outside, path.join(ctx.assets.local.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(ctx.assets.local.root, 'large.txt'), 'oversized fixture')
    ctx.config.policy.maxAssetBytes = 4
    const running = await serveCreatorHttp({ ...options, context: ctx }, { port: 0 }); servers.push(running.server)
    for (const import_path of ['linked/private.txt', 'large.txt']) {
      const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'creator_asset_sync', arguments: { import_path } } }) })
      const body = await response.text(), dataLine = body.split('\n').find(line => line.startsWith('data:'))
      expect(JSON.parse(dataLine ? dataLine.slice(5) : body).result.isError).toBe(true)
    }
    expect(ctx.ledger.listAssets({ limit: 10 }).assets).toEqual([])
  })
  it('applies pack file containment and byte caps to creator_pack_info templates', async () => {
    const ctx = await context(), pack = path.join(home, 'pack'), outside = path.join(home, 'outside')
    await mkdir(pack); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private fixture')
    await symlink(outside, path.join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(pack, 'large.md'), Buffer.alloc(8 * 1024 * 1024 + 1))
    ctx.merged.templates.set('linked', { packId: 'fixture', dir: pack, path: 'linked/private.txt', kind: 'text', tags: [] })
    ctx.merged.templates.set('large', { packId: 'fixture', dir: pack, path: 'large.md', kind: 'text', tags: [] })
    const running = await serveCreatorHttp({ ...options, context: ctx }, { port: 0 }); servers.push(running.server)
    for (const template of ['linked', 'large']) {
      const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'creator_pack_info', arguments: { section: 'templates', template } } }) })
      const body = await response.text(), dataLine = body.split('\n').find(line => line.startsWith('data:'))
      expect(JSON.parse(dataLine ? dataLine.slice(5) : body).result.isError).toBe(true)
      expect(body).not.toContain('private fixture')
    }
  })
  it('returns an injected STT transcript and persists its actual text asset', async () => {
    const ctx = await context()
    ctx.providers.register({ id: 'fixture-stt', allowHosts: [], capabilities: () => ['stt'], isConfigured: async () => true,
      listModels: async () => [{ id: 'fixture-stt/transcript', provider: 'fixture-stt', modelId: 'transcript', name: 'Fixture transcript', tasks: ['stt'] }],
      submit: async () => ({ providerJobId: 'fixture-stt-job', status: 'completed', result: { outputs: [{ kind: 'text', text: 'Fixture transcript', mime: 'text/plain' }] } }),
      poll: async () => { throw new Error('completed fixture must not poll') } })
    const audio = await ctx.assets.ingest({ bytes: Buffer.from('audio fixture'), mime: 'audio/wav', provenance: { task: 'import' } })
    const running = await serveCreatorHttp({ ...options, context: ctx }, { port: 0 }); servers.push(running.server)
    const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'creator_transcribe', arguments: { source_asset: audio.sha256, model: 'fixture-stt/transcript' } } }) })
    const body = await response.text(), dataLine = body.split('\n').find(line => line.startsWith('data:'))
    const result = JSON.parse(dataLine ? dataLine.slice(5) : body).result
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent.transcript).toBe('Fixture transcript')
    expect(result.structuredContent.asset?.kind).toBe('text')
    expect(Buffer.from((await ctx.assets.bytes(result.structuredContent.asset.sha256))!.bytes).toString()).toBe('Fixture transcript')
  })
  it('reads declared empty and non-markdown canon through HTTP resources', async () => {
    const ctx = await context(), pack = path.join(home, 'pack')
    await mkdir(path.join(pack, 'canon'), { recursive: true })
    const documents = [['empty.md', ''], ['data.json', '{"fixture":true}']]
    for (const [name, text] of documents) await writeFile(path.join(pack, 'canon', name!), text!)
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { paths: ['canon/*'] } })
    ctx.packs.merged = mergePacks([{ dir: pack, manifest, digest: 'a'.repeat(64) }], '0.1.0')
    ctx.packs.canon = await CanonIndex.build(ctx.packs.merged)
    const running = await serveCreatorHttp({ ...options, context: ctx }, { port: 0 }); servers.push(running.server)
    for (const [name, text] of documents) {
      const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `pack://fixture/canon/canon/${name}` } }) })
      const body = await response.text(), dataLine = body.split('\n').find(line => line.startsWith('data:'))
      const message = JSON.parse(dataLine ? dataLine.slice(5) : body)
      expect(message.error).toBeUndefined()
      expect(message.result.contents[0].text).toBe(text)
    }
  })
  it('closes allocated contexts once on explicit server close', async () => {
    const ctx = await context(), closed = vi.spyOn(ctx, 'close')
    vi.spyOn(CreatorContext, 'create').mockResolvedValue(ctx)
    const { server } = await createCreatorServer(options)
    await server.close(); await server.close()
    expect(closed).toHaveBeenCalledTimes(1)
  })
  it('preserves a caller-owned context', async () => {
    const ctx = await context(), closed = vi.spyOn(ctx, 'close')
    const { server } = await createCreatorServer({ ...options, context: ctx })
    await server.close()
    expect(closed).not.toHaveBeenCalled()
  })
  it('closes an allocated context if prompt registration fails', async () => {
    const ctx = await context(), closed = vi.spyOn(ctx, 'close')
    ctx.merged.prompts.set('missing', { packId: 'fixture', dir: home, path: 'missing.md' })
    vi.spyOn(CreatorContext, 'create').mockResolvedValue(ctx)
    await expect(createCreatorServer(options)).rejects.toThrow()
    expect(closed).toHaveBeenCalledTimes(1)
  })
  it('releases each legacy HTTP request context after its response body ends', async () => {
    const allocated: CreatorContext[] = []
    for (let i = 0; i < 3; i++) allocated.push(await context())
    const closed = allocated.map(ctx => vi.spyOn(ctx, 'close'))
    const create = vi.spyOn(CreatorContext, 'create')
    for (const ctx of allocated) create.mockResolvedValueOnce(ctx)
    const running = await serveCreatorHttp(options, { port: 0 }); servers.push(running.server)
    for (let i = 0; i < 3; i++) {
      const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '0.0.0' } } }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('serverInfo')
      await vi.waitFor(() => expect(closed[i]).toHaveBeenCalledTimes(1))
    }
    expect(create).toHaveBeenCalledTimes(3)
  })
  it('awaits asynchronous owned cleanup during HTTP shutdown', async () => {
    const ctx = await context(), originalClose = ctx.close.bind(ctx)
    let finished = false
    vi.spyOn(ctx, 'close').mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); await originalClose(); finished = true })
    vi.spyOn(CreatorContext, 'create').mockResolvedValue(ctx)
    const running = await serveCreatorHttp(options, { port: 0 })
    servers.push(running.server)
    const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '0.0.0' } } }) })
    await response.text(); await running.close()
    expect(finished).toBe(true)
  })
  it('denies outward pack resource links and undeclared canon through the HTTP protocol', async () => {
    const ctx = await context(), pack = path.join(home, 'pack'), outside = path.join(home, 'outside')
    await mkdir(pack); await mkdir(outside); await writeFile(path.join(outside, 'private.md'), 'private fixture')
    await symlink(outside, path.join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { locked: 'linked/private.md' }, templates: [{ id: 'linked', path: 'linked/private.md' }], rubrics: [{ id: 'linked', kind: 'text', promptFile: 'linked/private.md', dimensions: [{ id: 'quality', weight: 100 }], thresholds: { ship: 80, focused_pass: 60, draft: 40 } }] })
    ctx.packs.merged = mergePacks([{ dir: pack, manifest, digest: 'a'.repeat(64) }], '0.1.0')
    const running = await serveCreatorHttp({ ...options, context: ctx }, { port: 0 }); servers.push(running.server)
    for (const [uri, message] of [
      ['pack://fixture/canon/linked/private.md', 'path escapes pack directory via link'],
      ['pack://fixture/templates/linked', 'path escapes pack directory via link'],
      ['pack://fixture/rubrics/linked', 'path escapes pack directory via link'],
      ['pack://fixture/canon/pack.json', 'canon file not declared'],
      ['pack://other/rubrics/linked', 'not found'],
    ]) {
      const response = await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }) })
      const body = await response.text()
      expect(body).toContain(message)
      expect(body).not.toContain('private fixture')
    }
  })
  it('rejects prompt links changed after pack loading', async () => {
    const ctx = await context()
    const pack = path.join(home, 'pack'), outside = path.join(home, 'outside')
    await mkdir(pack); await mkdir(outside); await writeFile(path.join(outside, 'private.md'), 'private fixture')
    await symlink(outside, path.join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    ctx.merged.prompts.set('linked', { packId: 'fixture', dir: pack, path: 'linked/private.md' })
    await expect(createCreatorServer({ ...options, context: ctx })).rejects.toThrow('path escapes pack directory via link')
  })
})
