import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { validatePackDir } from './validate.js'
import { compilePackGlob, computePackDigest } from './load.js'
import { loadEntities } from './canon-lint.js'
import { mergePacks } from './merge.js'
import { readPackText } from './files.js'
import { PACK_SCHEMA_VERSION, packManifestSchema } from './schema.js'

let dir: string
async function fixture() {
  dir = await mkdtemp(path.join(tmpdir(), 'creator-pack-boundary-'))
  const pack = path.join(dir, 'pack'), outside = path.join(dir, 'outside')
  await mkdir(pack); await mkdir(outside)
  await writeFile(path.join(outside, 'private.json'), JSON.stringify({ people: [{ name: 'Private fixture' }] }))
  await symlink(outside, path.join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { entities: 'linked/private.json' } })
  await writeFile(path.join(pack, 'pack.json'), JSON.stringify(manifest))
  return { pack, outside, manifest }
}
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
describe('pack file boundaries', () => {
  it('validates literal bracket and brace canon filenames rather than treating them as globs', async () => {
    const { pack } = await fixture()
    await writeFile(path.join(pack, 'pack.json'), JSON.stringify({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { paths: ['missing[1].md', 'missing{1}.md'] } }))
    expect((await validatePackDir(pack)).ok).toBe(false)
    await writeFile(path.join(pack, 'missing[1].md'), 'fixture'); await writeFile(path.join(pack, 'missing{1}.md'), 'fixture')
    expect((await validatePackDir(pack)).ok).toBe(true)
  })
  it('binds nested init contents and additions to the pack digest', async () => {
    const { pack } = await fixture()
    await mkdir(path.join(pack, 'init/nested'), { recursive: true })
    await writeFile(path.join(pack, 'init/nested/AGENTS.md'), 'original fixture')
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, init: { dir: 'init' } })
    const original = await computePackDigest(pack, manifest)
    await writeFile(path.join(pack, 'init/nested/AGENTS.md'), 'changed fixture')
    const changed = await computePackDigest(pack, manifest)
    expect(changed).not.toBe(original)
    await writeFile(path.join(pack, 'init/extra.json'), '{}')
    expect(await computePackDigest(pack, manifest)).not.toBe(changed)
  })
  it('rejects links anywhere in a digested init tree', async () => {
    const { pack, outside } = await fixture()
    await mkdir(path.join(pack, 'init'))
    await symlink(outside, path.join(pack, 'init/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, init: { dir: 'init' } })
    await expect(computePackDigest(pack, manifest)).rejects.toThrow(/link|regular/i)
  })
  it('rejects an outward directory link during validation', async () => {
    const { pack } = await fixture()
    const validation = await validatePackDir(pack)
    expect(validation.ok).toBe(false)
    expect(validation.issues.some(i => i.path === 'canon.entities' && i.level === 'error')).toBe(true)
  })
  it('does not digest or load entities through a link even for direct API callers', async () => {
    const { pack, manifest } = await fixture()
    await expect(computePackDigest(pack, manifest)).rejects.toThrow(/pack|outside|escape/i)
    const merged = mergePacks([{ dir: pack, manifest, digest: 'a'.repeat(64) }], '0.1.0')
    await expect(loadEntities(merged)).rejects.toThrow(/pack|outside|escape/i)
    expect(await readFile(path.join(dir, 'outside/private.json'), 'utf8')).toContain('Private fixture')
  })
  it('reads a regular contained file and rejects an oversized pack file', async () => {
    const { pack } = await fixture()
    await writeFile(path.join(pack, 'safe.md'), 'safe fixture')
    expect(await readPackText(pack, 'safe.md')).toBe('safe fixture')
    await writeFile(path.join(pack, 'large.md'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(readPackText(pack, 'large.md')).rejects.toThrow('8 MiB')
  })
  it('matches nested canon globs without executing pack-supplied regex', () => {
    const matches = compilePackGlob('canon/**/*.md')
    expect(matches('canon/one.md')).toBe(true)
    expect(matches('canon/nested/two.md')).toBe(true)
    expect(matches('canon/nested/two.txt')).toBe(false)
    expect(compilePackGlob('canon\\**\\*.md')('canon\\nested\\two.md')).toBe(true)
    expect(compilePackGlob('*.md')('nested/a.md')).toBe(false)
    expect(compilePackGlob('*a'.repeat(100) + 'z')('a'.repeat(4096))).toBe(false)
    expect(() => compilePackGlob('../**')).toThrow()
    expect(() => compilePackGlob('x'.repeat(513))).toThrow()
  })
  it('rejects Windows rooted paths and alternate data streams on every platform', () => {
    for (const locked of ['\\server\\private.json', '\\\\server\\share\\private.json', 'canon/file.md:stream']) {
      expect(packManifestSchema.safeParse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon: { locked } }).success).toBe(false)
    }
  })
})
