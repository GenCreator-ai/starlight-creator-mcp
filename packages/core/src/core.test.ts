import { mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packManifestSchema, mergePacks, PACK_SCHEMA_VERSION, type MergedPack } from '@starlight-intelligence/creator-packs-spec'
import { generateBestOf } from './loop/best-of.js'
import { routeModel, RoutingError } from './registry/router.js'
import { assertUrlAllowed, FetchGuardError, hostAllowed, isPrivateHost } from './net/fetch-guard.js'
import { resolveInside, SandboxError } from './fs/sandbox.js'
import { ManifestSigner } from './publish/signer.js'
import { detectNumbers, payloadHash } from './publish/manifest.js'
import { JsonlLedger } from './ledger/jsonl.js'
import { SqliteLedger, sqliteAvailable } from './ledger/sqlite.js'
import { createVault } from './vault/index.js'
import { PolarLicense } from './license/polar.js'
import { LocalStorage } from './storage/local.js'
import { AssetStore } from './assets/store.js'
import { PublishService } from './publish/service.js'
import { LocalStagingAdapter } from './publish/local-staging.js'
import { Redactor } from './log.js'
import { ulid } from './ids.js'
import type { ModelRecord } from './types.js'

const models: ModelRecord[] = [
  { id: 'muapi/flux-schnell', provider: 'muapi', modelId: 'flux-schnell', name: 'Flux Schnell', tasks: ['t2i'] },
  { id: 'muapi/nano-banana-pro', provider: 'muapi', modelId: 'nano-banana-pro', name: 'Nano Banana Pro', tasks: ['t2i', 'i2i'] },
  { id: 'openrouter/openai/gpt-image-1', provider: 'openrouter', modelId: 'openai/gpt-image-1', name: 'GPT Image', tasks: ['t2i'] },
  { id: 'muapi/kling-v2', provider: 'muapi', modelId: 'kling-v2', name: 'Kling 2', tasks: ['t2v', 'i2v'] },
]

function merged(registry: Record<string, unknown>): MergedPack {
  return mergePacks([{ dir: '/p', digest: 'a'.repeat(64), manifest: packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'p', name: 'p', version: '1.0.0', license: { type: 'MIT' }, registry }) }], '0.1.0')
}

describe('best-of loop', () => {
  it('returns single attempt when no scoring requested', async () => {
    let calls = 0
    const r = await generateBestOf(async () => ++calls, null, { bestOf: 3 })
    expect(calls).toBe(1)
    expect(r.stoppedBy).toBe('single')
  })
  it('keeps the best of N and caps at 6', async () => {
    const scores = [40, 90, 70, 95, 10, 20, 99, 99]
    let i = 0
    const r = await generateBestOf(async a => a, async v => scores[v - 1] ?? null, { bestOf: 10 })
    expect(r.attempts).toBe(6)
    expect(r.best.value).toBe(4)
    expect(r.best.score).toBe(95)
    i++
    expect(i).toBe(1)
  })
  it('stops early at min_score', async () => {
    const scores = [50, 85, 99]
    const r = await generateBestOf(async a => a, async v => scores[v - 1] ?? null, { bestOf: 1, minScore: 80 })
    expect(r.attempts).toBe(2)
    expect(r.stoppedBy).toBe('threshold')
    expect(r.best.value).toBe(2)
  })
})

describe('router', () => {
  it('shares a work budget across nonmatching routing intents', () => {
    const m = merged({ intents: Array.from({ length: 16 }, (_, i) => ({ id: `rule-${i}`, task: 't2i', pattern: 'x', preferenceKey: 't2i:high' })) })
    expect(() => routeModel(models, m.registry, { task: 't2i', quality: 'high', prompt: 'a'.repeat(65_536) })).toThrow(/work budget/)
  })
  it('uses pack preferences, intents and pins', () => {
    const m = merged({ preferences: { 't2i:high': ['nano-banana-pro', 'flux'], 't2i:draft': ['flux-schnell'], 't2i:text': ['gpt-image'] }, intents: [{ id: 'text', task: 't2i', pattern: '\\blogo\\b', preferenceKey: 't2i:text' }] })
    expect(routeModel(models, m.registry, { task: 't2i', quality: 'high' }).model.id).toBe('muapi/nano-banana-pro')
    expect(routeModel(models, m.registry, { task: 't2i', quality: 'draft' }).model.id).toBe('muapi/flux-schnell')
    expect(routeModel(models, m.registry, { task: 't2i', quality: 'high', prompt: 'a logo for a bakery' }).model.id).toBe('openrouter/openai/gpt-image-1')
    const pinned = merged({ pins: { t2i: 'muapi/flux-schnell' } })
    expect(routeModel(models, pinned.registry, { task: 't2i', quality: 'high' }).reason).toContain('pin')
  })
  it('fails closed on a hostile pack intent without executing its regex', () => {
    const m = merged({ intents: [{ id: 'hostile', task: 't2i', pattern: '(a+)+b', preferenceKey: 't2i:high' }] })
    expect(() => routeModel(models, m.registry, { task: 't2i', quality: 'high', prompt: 'a'.repeat(1000) })).toThrow(/unsupported pack pattern/)
  })
  it('honours deny lists and rejects unknown explicit models', () => {
    const m = merged({ deny: ['muapi/nano-banana-pro'], preferences: { 't2i:high': ['nano-banana-pro'] } })
    expect(routeModel(models, m.registry, { task: 't2i', quality: 'high' }).model.id).not.toBe('muapi/nano-banana-pro')
    expect(() => routeModel(models, m.registry, { task: 't2i', quality: 'high', explicitModel: 'nope' })).toThrow(RoutingError)
    expect(() => routeModel(models, m.registry, { task: 'tts', quality: 'high' })).toThrow(/tts/)
  })
})

describe('fetch guard', () => {
  it('classifies private hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'foo.local']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['openrouter.ai', '8.8.8.8', 'api.muapi.ai']) expect(isPrivateHost(h), h).toBe(false)
  })
  it('matches wildcard allowlists', () => {
    expect(hostAllowed('cdn.muapi.ai', ['*.muapi.ai'])).toBe(true)
    expect(hostAllowed('muapi.ai', ['*.muapi.ai'])).toBe(true)
    expect(hostAllowed('evil-muapi.ai', ['*.muapi.ai'])).toBe(false)
  })
  it('rejects disallowed and private URLs', async () => {
    await expect(assertUrlAllowed(new URL('https://example.com/x'), { allowHosts: ['openrouter.ai'] })).rejects.toBeInstanceOf(FetchGuardError)
    await expect(assertUrlAllowed(new URL('http://169.254.169.254/latest'), { allowHosts: ['169.254.169.254'] })).rejects.toThrow(/private/)
    await expect(assertUrlAllowed(new URL('file:///etc/passwd'), { allowHosts: [] })).rejects.toThrow(/scheme/)
    await expect(assertUrlAllowed(new URL('http://127.0.0.1:9/x'), { allowHosts: [], allowPrivateHosts: true })).resolves.toBeUndefined()
  })
})

describe('sandbox', () => {
  const root = path.join(os.tmpdir(), 'creator-sandbox-root')
  it('resolves relative paths inside the root', () => {
    expect(resolveInside(root, 'a/b.txt').startsWith(path.resolve(root))).toBe(true)
  })
  it('rejects traversal, absolute and UNC paths', () => {
    expect(() => resolveInside(root, '../x')).toThrow(SandboxError)
    expect(() => resolveInside(root, 'a/../../x')).toThrow(SandboxError)
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(SandboxError)
    expect(() => resolveInside(root, 'C:\\Windows\\x')).toThrow(SandboxError)
    expect(() => resolveInside(root, '\\\\server\\share')).toThrow(SandboxError)
  })
})

describe('signer + manifest', () => {
  it('signs, verifies, and detects tampering', async () => {
    const vault = await createVault({ backend: 'memory' })
    const signer = new ManifestSigner(vault)
    const m = { payload_hash: 'a'.repeat(64), approved_at: '2026-08-22T00:00:00.000Z', expires_at: '2026-09-01T00:00:00.000Z' }
    const sig = await signer.sign(m)
    expect(await signer.verify(m, sig)).toBe(true)
    expect(await signer.verify({ ...m, payload_hash: 'b'.repeat(64) }, sig)).toBe(false)
    expect(await signer.verify(m, 'ff')).toBe(false)
    expect(await signer.fingerprint()).toHaveLength(16)
  })
  it('payload hash is stable and order independent', () => {
    const posts = [{ channel_id: 'x', text: 'hi', assets: [] }]
    const a = payloadHash({ posts, claims: [], packDigest: 'd' })
    const b = payloadHash({ posts: [{ text: 'hi', assets: [], channel_id: 'x' }], claims: [], packDigest: 'd' })
    expect(a).toBe(b)
    expect(payloadHash({ posts, claims: [], packDigest: 'e' })).not.toBe(a)
  })
  it('detects numbers that need evidence', () => {
    expect(detectNumbers('We grew 340% to $1.2m in 3 months')).toEqual(['340%', '$1.2m'])
  })
})

describe('ledger', () => {
  const backends: Array<[string, () => Promise<JsonlLedger | SqliteLedger>]> = [['jsonl', async () => new JsonlLedger(path.join(await mkdtemp(path.join(os.tmpdir(), 'ledger-')), 'l.jsonl'))]]
  if (sqliteAvailable()) backends.push(['sqlite', async () => new SqliteLedger(path.join(await mkdtemp(path.join(os.tmpdir(), 'ledger-')), 'l.db'))])
  for (const [name, open] of backends) {
    it(`${name}: assets, jobs, publications are idempotent by key`, async () => {
      const l = await open()
      const sha = 'c'.repeat(64)
      l.upsertAsset({ sha256: sha, mime: 'image/png', bytes: 10, kind: 'image', createdAt: '2026-08-22T00:00:00Z', task: 't2i', prompt: 'a red fox', provenance: {} })
      expect(l.findAsset(sha.slice(0, 10))?.sha256).toBe(sha)
      expect(l.listAssets({ query: 'fox' }).assets).toHaveLength(1)
      expect(l.listAssets({ task: 't2v' }).assets).toHaveLength(0)
      const now = new Date().toISOString()
      l.createJob({ id: 'j1', provider: 'muapi', providerJobId: 'p1', task: 't2i', model: 'm', status: 'queued', request: {}, createdAt: now, updatedAt: now })
      expect(l.updateJob('j1', { status: 'completed', resultSha256: sha })?.status).toBe('completed')
      expect(l.findAsset('j1')?.sha256).toBe(sha)
      const first = l.addPublication({ id: 'p1', manifestId: 'm1', channelId: 'c', adapter: 'local', idempotencyKey: 'k', status: 'sent', nativeId: 'n1' })
      const second = l.addPublication({ id: 'p2', manifestId: 'm1', channelId: 'c', adapter: 'local', idempotencyKey: 'k', status: 'sent', nativeId: 'n2' })
      expect(first.inserted).toBe(true)
      expect(second.inserted).toBe(false)
      expect(second.existing?.nativeId).toBe('n1')
      l.recordHit('postiz', now)
      expect(l.hitsSince('postiz', new Date(Date.now() - 1000).toISOString())).toBe(1)
      l.close()
    })
  }
})

describe('license (fake Polar)', () => {
  let server: Server
  let base = ''
  let mode: 'granted' | 'revoked' | 'down' = 'granted'
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (mode === 'down') { req.socket.destroy(); return }
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (mode === 'revoked') { res.statusCode = 404; res.end('{}'); return }
        res.end(JSON.stringify({ status: 'granted', benefit_id: 'ben_1', expires_at: null, activation: null, echo: JSON.parse(body) }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => server.close())

  async function make(now: () => Date) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lic-'))
    const vault = await createVault({ backend: 'memory' })
    const signer = new ManifestSigner(vault)
    return new PolarLicense({ home, signer, fetchPolicy: { allowHosts: [], allowPrivateHosts: true }, baseUrl: base, now })
  }

  it('requires an online validation before any offline grace', async () => {
    mode = 'down'
    const lic = await make(() => new Date('2026-08-22T00:00:00Z'))
    const r = await lic.validate({ key: 'polar_' + 'x'.repeat(30), organizationId: 'org', packsByBenefit: { ben_1: ['arcanea'] } })
    expect(r.valid).toBe(false)
    expect(r.source).toBe('none')
  })
  it('grants online, then honours a 14-day offline grace, then expires it', async () => {
    let t = new Date('2026-08-22T00:00:00Z')
    mode = 'granted'
    const lic = await make(() => t)
    const online = await lic.validate({ key: 'k1', organizationId: 'org', packsByBenefit: { ben_1: ['arcanea'] } })
    expect(online).toMatchObject({ valid: true, source: 'online', packs: ['arcanea'] })
    mode = 'down'
    t = new Date('2026-08-30T00:00:00Z')
    const offline = await lic.validate({ key: 'k1', packsByBenefit: { ben_1: ['arcanea'] }, refresh: true })
    expect(offline).toMatchObject({ valid: true, source: 'cache' })
    t = new Date('2026-09-10T00:00:00Z')
    const expired = await lic.validate({ key: 'k1', packsByBenefit: { ben_1: ['arcanea'] }, refresh: true })
    expect(expired.valid).toBe(false)
    expect(expired.reason).toMatch(/grace/)
  })
  it('a different key cannot reuse the cache', async () => {
    mode = 'granted'
    const lic = await make(() => new Date('2026-08-22T00:00:00Z'))
    await lic.validate({ key: 'k1', organizationId: 'org', packsByBenefit: {} })
    mode = 'down'
    const other = await lic.validate({ key: 'k2', organizationId: 'org', packsByBenefit: {} })
    expect(other.valid).toBe(false)
  })
  it('revoked keys are not valid', async () => {
    mode = 'revoked'
    const lic = await make(() => new Date('2026-08-22T00:00:00Z'))
    const r = await lic.validate({ key: 'k3', organizationId: 'org', packsByBenefit: {} })
    expect(r.valid).toBe(false)
    expect(r.status).toBe('revoked')
  })
})

describe('publish service (local staging)', () => {
  it('prepare -> approve -> publish with idempotent re-run and refusals', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pub-'))
    const vault = await createVault({ backend: 'memory' })
    const ledger = new JsonlLedger(null)
    const local = new LocalStorage(path.join(home, 'assets'))
    const assets = new AssetStore({ ledger, local, connectors: new Map([['local', local]]), substrateVersion: '0.1.0' })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const asset = await assets.ingest({ bytes: png, provenance: { origin: { kind: 'imported_file' } } })
    expect(asset.mime).toBe('image/png')
    const signer = new ManifestSigner(vault)
    const adapters = new Map([['local', new LocalStagingAdapter(path.join(home, 'outbox'))]])
    const svc = new PublishService({ ledger, assets, signer, adapters })
    const pack = merged({})
    const prep = await svc.prepare({ posts: [{ channel_id: 'outbox', text: 'We unlock 10x growth in 30 days', assets: [asset.sha256] }], claims: [{ text: '10x growth', type: 'numerical', status: 'proposed' }] }, { ...pack, voice: { ...pack.voice, bannedPhrases: ['unlock'] } })
    expect(prep.warnings.some(w => w.includes('blocked'))).toBe(true)
    expect(prep.warnings.some(w => w.includes('banned phrase'))).toBe(true)
    const again = await svc.prepare({ posts: [{ channel_id: 'outbox', text: 'We unlock 10x growth in 30 days', assets: [asset.sha256] }], claims: [{ text: '10x growth', type: 'numerical', status: 'proposed' }] }, pack)
    expect(again.reused).toBe(true)
    expect(again.manifest.id).toBe(prep.manifest.id)
    await expect(svc.publish(prep.manifest.id, { dryRun: false })).rejects.toThrow(/approve/)
    const bad = await svc.approve(prep.manifest.id, 'zzzzzzzz', 'cli')
    expect(bad.ok).toBe(false)
    const ok = await svc.approve(prep.manifest.id, prep.manifest.payload_hash.slice(0, 8), 'cli')
    expect(ok.ok).toBe(true)
    const dry = await svc.publish(prep.manifest.id, { dryRun: true })
    expect(dry.outcomes[0]?.status).toBe('dry_run')
    const sent = await svc.publish(prep.manifest.id, { dryRun: false })
    expect(sent.outcomes[0]?.status).toBe('sent')
    expect(sent.manifest.status).toBe('sent')
    const resent = await svc.publish(prep.manifest.id, { dryRun: false })
    expect(resent.outcomes[0]?.nativeId).toBe(sent.outcomes[0]?.nativeId)
    const row = ledger.getManifest(prep.manifest.id)!
    ledger.putManifest({ ...row, manifest: { ...(row.manifest as Record<string, unknown>), posts: [{ channel_id: 'outbox', text: 'tampered', assets: [] }] } })
    await expect(svc.publish(prep.manifest.id, { dryRun: false })).rejects.toThrow(/hash mismatch|changed/)
  })
})

describe('misc', () => {
  it('ulid is monotonic and 26 chars', () => {
    const a = ulid(1000); const b = ulid(1000); const c = ulid(1001)
    expect(a).toHaveLength(26)
    expect(b > a).toBe(true)
    expect(c > b).toBe(true)
  })
  it('redactor hides known and shaped secrets', () => {
    const r = new Redactor()
    r.add('supersecretvalue123')
    expect(r.redact('key=supersecretvalue123 and sk-abcdefghijklmnopqrstuv')).toBe('key=[redacted] and [redacted]')
  })
})
