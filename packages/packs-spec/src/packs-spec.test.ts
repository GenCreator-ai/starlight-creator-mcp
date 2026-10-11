import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACK_SCHEMA_VERSION, packManifestSchema } from './schema.js'
import { validatePackDir } from './validate.js'
import { loadPack } from './load.js'
import { mergePacks, PackResolutionError } from './merge.js'
import { lintText } from './canon-lint.js'
import { sha256CanonicalJson } from './hash.js'

const STARTER = path.resolve(fileURLToPath(import.meta.url), '../../../../packs/starter')

function manifest(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: PACK_SCHEMA_VERSION, id: 'alpha', name: 'Alpha', version: '1.0.0', license: { type: 'MIT' }, ...overrides }
}

async function tmpPack(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pack-'))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  return dir
}

describe('pack schema', () => {
  it('accepts a minimal manifest and fills defaults', () => {
    const m = packManifestSchema.parse(manifest())
    expect(m.publicSafe).toBe(true)
    expect(m.registry.preferences).toEqual({})
    expect(m.canon.truthClasses).toEqual(['locked', 'soft', 'proposed'])
  })
  it('rejects rubric weights that do not sum to 100', () => {
    const r = packManifestSchema.safeParse(manifest({ rubrics: [{ id: 'x', kind: 'image', dimensions: [{ id: 'a', weight: 50 }], thresholds: { ship: 80, focused_pass: 60, draft: 40 } }] }))
    expect(r.success).toBe(false)
  })
  it('rejects absolute and traversal paths', () => {
    expect(packManifestSchema.safeParse(manifest({ canon: { locked: '../secrets.md' } })).success).toBe(false)
    expect(packManifestSchema.safeParse(manifest({ canon: { locked: 'C:/x.md' } })).success).toBe(false)
  })
})

describe('starter pack', () => {
  it('validates and loads with a stable digest', async () => {
    const v = await validatePackDir(STARTER)
    expect(v.issues.filter(i => i.level === 'error')).toEqual([])
    expect(v.ok).toBe(true)
    const a = await loadPack(STARTER)
    const b = await loadPack(STARTER)
    expect(a.digest).toBe(b.digest)
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('validate', () => {
  it('reports missing referenced files', async () => {
    const dir = await tmpPack({ 'pack.json': JSON.stringify(manifest({ prompts: [{ id: 'p', path: 'prompts/p.md' }] })) })
    const v = await validatePackDir(dir)
    expect(v.ok).toBe(false)
    expect(v.issues[0]?.message).toContain('prompts/p.md')
  })
})

describe('merge', () => {
  const base = (id: string, extra: Record<string, unknown>) => ({ dir: `/packs/${id}`, digest: 'd'.repeat(64), manifest: packManifestSchema.parse(manifest({ id, ...extra })) })

  it('later pack replaces preference lists per key and keeps untouched keys', () => {
    const arcanea = base('arcanea', { registry: { preferences: { 't2i:high': ['a1'], 't2v:high': ['v1'] } }, rubrics: [{ id: 'visual', kind: 'image', default: true, dimensions: [{ id: 'a', weight: 100 }], thresholds: { ship: 80, focused_pass: 60, draft: 40 } }] })
    const author = base('author-os', { registry: { preferences: { 't2i:high': ['b1'] } }, rubrics: [{ id: 'writing', kind: 'text', default: true, dimensions: [{ id: 'a', weight: 100 }], thresholds: { ship: 90, focused_pass: 82, draft: 70 } }], publishing: { requireRubric: 'writing', minScore: 82 } })
    const m = mergePacks([arcanea, author], '0.1.0')
    expect(m.registry.preferences['t2i:high']).toEqual(['b1'])
    expect(m.registry.preferences['t2v:high']).toEqual(['v1'])
    expect(m.defaultRubric.image).toBe('visual')
    expect(m.defaultRubric.text).toBe('writing')
    expect(m.publishing.requireRubric).toBe('writing')
    expect(m.publishing.minScore).toBe(82)
    expect(m.packs.map(p => p.id)).toEqual(['arcanea', 'author-os'])
  })

  it('orders by extends and detects cycles', () => {
    const a = base('a', { extends: ['b'] })
    const b = base('b', {})
    expect(mergePacks([a, b], '0.1.0').packs.map(p => p.id)).toEqual(['b', 'a'])
    const c = base('c', { extends: ['d'] })
    const d = base('d', { extends: ['c'] })
    expect(() => mergePacks([c, d], '0.1.0')).toThrow(PackResolutionError)
  })

  it('enforces canon semver requirements', () => {
    const arcanea = base('arcanea', { version: '1.2.0' })
    const anime = base('anime-legends', { requires: { canon: { arcanea: '>=1.0.0' } } })
    expect(() => mergePacks([anime], '0.1.0')).toThrow(/arcanea/)
    expect(mergePacks([arcanea, anime], '0.1.0').packs).toHaveLength(2)
    const old = base('arcanea', { version: '0.9.0' })
    expect(() => mergePacks([old, anime], '0.1.0')).toThrow(/loaded arcanea@0.9.0/)
  })

  it('unions banned phrases case-insensitively', () => {
    const a = base('a', { voice: { bannedPhrases: ['Unlock', 'disrupt'] } })
    const b = base('b', { voice: { bannedPhrases: ['unlock', '10x'] } })
    expect(mergePacks([a, b], '0.1.0').voice.bannedPhrases).toEqual(['Unlock', 'disrupt', '10x'])
  })
})

describe('canon lint', () => {
  it('finds forbidden patterns with excerpts', () => {
    const m = mergePacks([{ dir: '/p', digest: 'x'.repeat(64), manifest: packManifestSchema.parse(manifest({ canon: { forbiddenPatterns: [{ pattern: '11th\\s+gate|gate\\s+11', message: 'There are exactly 10 Gates.' }] } })) }], '0.1.0')
    const r = lintText('She opened the 11th gate at dawn.', m)
    expect(r.ok).toBe(false)
    expect(r.findings[0]?.message).toBe('There are exactly 10 Gates.')
    expect(r.findings[0]?.excerpt).toContain('11th gate')
  })
})

describe('pack-driven entity vocabulary', () => {
  const merged = mergePacks([], '0.1.0')
  const entities = { byType: { projects: [{ name: 'Atlas', aliases: ['North'] }], regions: [{ name: 'West', aliases: [] }] }, names: new Set(['atlas', 'north', 'west']) }
  it('finds unknown names using the loaded types, including singular labels', () => {
    expect(lintText('Project Atlas, project North, Region South.', merged, entities).unknownEntities).toEqual(['South'])
  })
  it('does not inject another brand vocabulary into an unrelated pack', () => {
    expect(lintText('Guardian Jane entered House Stone through Gate Nine.', merged, entities).ok).toBe(true)
  })
})

describe('canonical hash', () => {
  it('is key-order independent', () => {
    expect(sha256CanonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(sha256CanonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }))
  })
})
