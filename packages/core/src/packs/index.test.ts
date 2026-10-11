import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { PACK_SCHEMA_VERSION } from '@starlight-intelligence/creator-packs-spec'
import { CanonIndex, loadPacks } from './index.js'
import { mergePacks, packManifestSchema } from '@starlight-intelligence/creator-packs-spec'
import { createLogger, Redactor } from '../log.js'

let dir: string
async function fixture() {
  dir = await mkdtemp(path.join(tmpdir(), 'creator-paid-pack-'))
  await mkdir(path.join(dir, 'canon'))
  await writeFile(path.join(dir, 'canon/locked.md'), 'Paid canon fixture')
  await writeFile(path.join(dir, 'canon/entities.json'), JSON.stringify({ people: [{ name: 'Paid fixture' }] }))
  await writeFile(path.join(dir, 'pack.json'), JSON.stringify({ schemaVersion: PACK_SCHEMA_VERSION, id: 'private-fixture', name: 'Private fixture', version: '1.0.0', license: { type: 'Proprietary' }, publicSafe: false, offer: { free: [], paid: ['canon'] }, canon: { locked: 'canon/locked.md', entities: 'canon/entities.json', paths: ['canon/*.md'] } }))
  return { log: createLogger({ redactor: new Redactor(), sink: () => {} }), dev: false }
}
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
describe('private pack free sections', () => {
  it('retains declared empty and non-markdown files independently of search chunks', async () => {
    await fixture()
    await writeFile(path.join(dir, 'canon/empty.md'), ' \n ')
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { paths: ['canon/*', 'canon/*.md'] } })
    const index = await CanonIndex.build(mergePacks([{ dir, manifest, digest: 'a'.repeat(64) }], '0.1.0'))
    expect(index.files()).toContainEqual({ packId: 'fixture', file: 'canon/empty.md', chunks: 0, locked: false })
    expect(index.files()).toContainEqual({ packId: 'fixture', file: 'canon/entities.json', chunks: 0, locked: false })
    expect(index.files().filter(f => f.file === 'canon/locked.md')).toHaveLength(1)
    expect(index.files().find(f => f.file === 'canon/locked.md')?.chunks).toBe(1)
  })
  it('removes locked canon and entity references when canon is not licensed', async () => {
    const opts = await fixture(), packs = await loadPacks([dir], '0.1.0', opts)
    expect(packs.merged.locked).toEqual([])
    expect(packs.merged.entities).toEqual([])
    expect(packs.canon.files()).toEqual([])
  })
  it('preserves canon when the pack is explicitly licensed', async () => {
    const opts = await fixture(), packs = await loadPacks([dir], '0.1.0', { ...opts, licensedPackIds: new Set(['private-fixture']) })
    expect(packs.merged.locked).toHaveLength(1)
    expect(packs.merged.entities).toHaveLength(1)
    expect(packs.canon.files()).toHaveLength(1)
  })
})
