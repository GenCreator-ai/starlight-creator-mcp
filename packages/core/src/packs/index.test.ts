import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { PACK_SCHEMA_VERSION } from '@starlight-intelligence/creator-packs-spec'
import { loadPacks } from './index.js'
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
