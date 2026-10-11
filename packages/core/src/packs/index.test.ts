import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { PACK_SCHEMA_VERSION } from '@starlight-intelligence/creator-packs-spec'
import { CanonIndex, chunkMarkdown, loadPacks } from './index.js'
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
  it.each([
    { free: [], licensed: false, registry: false, voice: false, canon: false },
    { free: ['registry'], licensed: false, registry: true, voice: false, canon: false },
    { free: ['voice'], licensed: false, registry: false, voice: true, canon: false },
    { free: ['canon'], licensed: false, registry: false, voice: false, canon: true },
    { free: [], licensed: true, registry: true, voice: true, canon: true },
  ])('applies only authorized private rules for free=$free licensed=$licensed', async ({ free, licensed, registry, voice, canon }) => {
    const opts = await fixture()
    const manifest = JSON.parse(await readFile(path.join(dir, 'pack.json'), 'utf8'))
    manifest.offer = { free, paid: ['registry', 'voice', 'canon'].filter(section => !free.includes(section)) }
    manifest.registry = { preferences: { 't2i:high': ['private-model'] }, intents: [{ id: 'private-rule', task: 't2i', pattern: 'private', preferenceKey: 't2i:high' }], deny: ['private-denial'], pins: { t2i: 'private-model' }, providers: { prefer: ['private-provider'] } }
    manifest.voice = { bannedPhrases: ['private-phrase'], principles: ['private-principle'], register: 'private-register', avoid: ['private-avoid'], files: ['canon/locked.md'] }
    manifest.canon.forbiddenPatterns = [{ pattern: 'private-rule', message: 'private-message' }]
    manifest.canon.truthClasses = ['private-truth']
    await writeFile(path.join(dir, 'pack.json'), JSON.stringify(manifest))
    const packs = await loadPacks([dir], '0.1.0', { ...opts, ...(licensed ? { licensedPackIds: new Set(['private-fixture']) } : {}) })
    expect(packs.merged.registry.intents.length > 0).toBe(registry)
    expect(packs.merged.registry.preferences['t2i:high'] !== undefined).toBe(registry)
    expect(packs.merged.registry.deny.length > 0).toBe(registry)
    expect(packs.merged.registry.pins.t2i !== undefined).toBe(registry)
    expect(packs.merged.registry.providers.prefer.length > 0).toBe(registry)
    expect(packs.merged.voice.bannedPhrases.length > 0).toBe(voice)
    expect(packs.merged.voice.principles.length > 0).toBe(voice)
    expect(packs.merged.voice.register !== undefined).toBe(voice)
    expect(packs.merged.voice.avoid.length > 0).toBe(voice)
    expect(packs.merged.voice.files.length > 0).toBe(voice)
    expect(packs.merged.forbiddenPatterns.length > 0).toBe(canon)
    expect(packs.loaded[0]!.manifest.canon.truthClasses.includes('private-truth')).toBe(canon)
    expect(packs.merged.locked.length > 0).toBe(canon)
    expect(packs.merged.entities.length > 0).toBe(canon)
    expect(packs.canon.files().length > 0).toBe(canon)
  })
  it('retains all long canon section text across bounded chunks without splitting a surrogate pair', () => {
    const body = 'x'.repeat(3999) + '\u{1f30d}' + ' useful tail '.repeat(800)
    const chunks = chunkMarkdown(body, 'fixture', 'long.md', false)
    expect(chunks.map(c => c.text).join('')).toBe(body.trim())
    expect(chunks.every(c => c.text.length <= 4000)).toBe(true)
    expect(chunks.some(c => c.text.includes('useful tail'))).toBe(true)
  })
  it('retains declared empty and non-markdown text files independently of search chunks', async () => {
    await fixture()
    await writeFile(path.join(dir, 'canon/empty.md'), ' \n ')
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { paths: ['canon/*', 'canon/*.md'] } })
    const index = await CanonIndex.build(mergePacks([{ dir, manifest, digest: 'a'.repeat(64) }], '0.1.0'))
    expect(index.files()).toContainEqual({ packId: 'fixture', file: 'canon/empty.md', chunks: 0, locked: false })
    expect(index.files()).toContainEqual({ packId: 'fixture', file: 'canon/entities.json', chunks: 0, locked: false })
    expect(index.files().filter(f => f.file === 'canon/locked.md')).toHaveLength(1)
    expect(index.files().find(f => f.file === 'canon/locked.md')?.chunks).toBe(1)
  })
  it('excludes binary matches from the declared text canon resource list', async () => {
    await fixture()
    await writeFile(path.join(dir, 'canon/image.png'), Buffer.from([137, 80, 78, 71, 0, 255]))
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { paths: ['canon/**/*'] } })
    const index = await CanonIndex.build(mergePacks([{ dir, manifest, digest: 'a'.repeat(64) }], '0.1.0'))
    expect(index.files().map(file => file.file)).not.toContain('canon/image.png')
    expect(index.files().map(file => file.file)).toContain('canon/entities.json')
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
