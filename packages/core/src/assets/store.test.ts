import { mkdtemp, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetStore } from './store.js'
import { JsonlLedger } from '../ledger/jsonl.js'
import { LocalStorage } from '../storage/local.js'
import type { StorageConnector } from '../storage/interface.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(remoteBytes: Uint8Array | null) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'creator-integrity-')); roots.push(home)
  const local = new LocalStorage(path.join(home, 'assets'))
  const ledger = new JsonlLedger(path.join(home, 'ledger.jsonl'))
  const connector: StorageConnector = { id: 'fixture', get: vi.fn(async () => remoteBytes), put: vi.fn(async () => ({ uri: 'fixture:asset', connector: 'fixture' })), exists: async () => true, stat: async () => ({ ok: true, detail: 'synthetic' }) }
  const assets = new AssetStore({ ledger, local, connectors: new Map([['fixture', connector]]), substrateVersion: '0.1.0' })
  const original = Buffer.from('original synthetic asset')
  const row = await assets.ingest({ bytes: original, mime: 'text/plain', provenance: { task: 'import' } })
  ledger.addLocation(row.sha256, connector.id, 'fixture:asset')
  return { assets, local, row, original, connector }
}
describe('content-addressed asset reads', () => {
  it('rejects remote corruption before caching, returning or synchronizing it', async () => {
    const { assets, local, row, connector } = await fixture(Buffer.from('tampered synthetic asset'))
    await unlink(local.pathFor(row.sha256, 'txt'))
    await expect(assets.bytes(row.sha256)).rejects.toThrow(/digest mismatch/)
    expect(await local.exists(row.sha256, 'txt')).toBe(false)
    await expect(assets.sync(row.sha256, connector.id)).rejects.toThrow(/digest mismatch/)
    expect(connector.put).not.toHaveBeenCalled()
  })
  it('rejects corrupted local bytes without silently falling through to remote', async () => {
    const { assets, local, row, connector } = await fixture(null)
    await local.put(row.sha256, Buffer.from('tampered local asset'), { mime: row.mime, ext: 'txt' })
    await expect(assets.bytes(row.sha256)).rejects.toThrow(/digest mismatch/)
    expect(connector.get).not.toHaveBeenCalled()
  })
  it('owns connector bytes before an asynchronous cache write', async () => {
    const shared = Buffer.from('original synthetic asset')
    const { assets, local, row, original } = await fixture(shared)
    await unlink(local.pathFor(row.sha256, 'txt'))
    const put = local.put.bind(local)
    vi.spyOn(local, 'put').mockImplementation(async (sha, bytes, meta) => {
      shared.fill(0)
      return put(sha, bytes, meta)
    })
    expect((await assets.bytes(row.sha256))?.bytes).toEqual(new Uint8Array(original))
    expect(await local.get(row.sha256, 'txt')).toEqual(new Uint8Array(original))
  })
  it('caches verified remote bytes and preserves missing-asset behavior', async () => {
    const { assets, local, row, original } = await fixture(Buffer.from('original synthetic asset'))
    await unlink(local.pathFor(row.sha256, 'txt'))
    expect(await assets.bytes(row.sha256)).toEqual({ bytes: new Uint8Array(original), mime: row.mime })
    expect(await local.get(row.sha256, 'txt')).toEqual(new Uint8Array(original))
    expect(await assets.bytes('0'.repeat(64))).toBeNull()
  })
})
