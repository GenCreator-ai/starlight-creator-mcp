import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JsonlLedger } from './jsonl.js'
import { SqliteLedger } from './sqlite.js'
import type { AssetRow, Ledger } from './interface.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const asset = (id: number, pack: Record<string, unknown> = { ids: ['wanted'], digest: 'fixture' }): AssetRow => ({
  sha256: id.toString(16).padStart(64, '0'), kind: 'image', mime: 'image/png', bytes: 16,
  createdAt: '2026-10-10T00:00:00.000Z', prompt: 'ÉCLAIR 100%_literal', model: 'fixture/image', task: 't2i',
  provenance: { pack },
})

describe.each(['jsonl', 'sqlite'] as const)('%s asset query semantics', backend => {
  const open = (): Ledger => backend === 'jsonl' ? new JsonlLedger(null) : new SqliteLedger(':memory:')
  it('filters generated multi-pack provenance and legacy single-pack provenance', () => {
    const ledger = open()
    try {
      ledger.upsertAsset(asset(1))
      ledger.upsertAsset(asset(2, { ids: ['other'] }))
      ledger.upsertAsset(asset(3, { id: 'wanted' }))
      expect(ledger.listAssets({ packId: 'wanted' }).assets.map(a => a.sha256)).toEqual([asset(1).sha256, asset(3).sha256])
      expect(ledger.listAssets({ packId: 'missing' }).assets).toHaveLength(0)
    } finally { ledger.close() }
  })
  it('paginates equal timestamps deterministically and preserves Unicode literal search', () => {
    const ledger = open()
    try {
      for (const id of [4, 2, 3, 1]) ledger.upsertAsset(asset(id))
      const first = ledger.listAssets({ query: 'éclair 100%_', limit: 2 })
      expect(first.assets.map(a => a.sha256)).toEqual([asset(1).sha256, asset(2).sha256])
      const second = ledger.listAssets({ query: 'éclair 100%_', limit: 2, cursor: first.nextCursor })
      expect(second.assets.map(a => a.sha256)).toEqual([asset(3).sha256, asset(4).sha256])
      expect(second.nextCursor).toBeUndefined()
      expect(ledger.listAssets({ cursor: 'missing', limit: 2 }).assets).toEqual(first.assets)
      expect(ledger.listAssets({ query: "' OR 1=1 --" }).assets).toHaveLength(0)
    } finally { ledger.close() }
  })
  it('rejects unbounded pages rather than materializing or silently truncating them', () => {
    const ledger = open()
    try {
      for (const limit of [0, -1, 1001, Infinity, 1.5]) expect(() => ledger.listAssets({ limit })).toThrow(/limit/)
    } finally { ledger.close() }
  })
  it('rejects oversized metric queries while retaining complete narrower results', () => {
    const ledger = open()
    try {
      for (let i = 0; i < 10001; i++) ledger.addObservation({ id: String(i), publicationId: i === 0 ? 'wanted' : 'other', source: 'fixture', observedAt: '2026-10-10T00:00:00.000Z' })
      expect(() => ledger.observations({})).toThrow(/10000/)
      expect(ledger.observations({ publicationId: 'wanted' })).toHaveLength(1)
    } finally { ledger.close() }
  })
  it('retains recent throttle hits and excludes expired hits from historical queries', () => {
    const ledger = open(), now = Date.now()
    try {
      ledger.recordHit('fixture', new Date(now - 36 * 60 * 60 * 1000).toISOString())
      ledger.recordHit('fixture', new Date(now - 30 * 60 * 1000).toISOString())
      ledger.recordHit('other', new Date(now - 20 * 60 * 1000).toISOString())
      expect(ledger.hitsSince('fixture', new Date(now - 48 * 60 * 60 * 1000).toISOString())).toBe(1)
      expect(ledger.hitsSince('fixture', new Date(now - 60 * 60 * 1000).toISOString())).toBe(1)
      expect(ledger.hitsSince('other', new Date(now - 60 * 60 * 1000).toISOString())).toBe(1)
    } finally { ledger.close() }
  })
})

it('SQLite applies filters and pagination before decoding unrelated rows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-page-')); roots.push(root)
  const file = path.join(root, 'ledger.db'), ledger = new SqliteLedger(file)
  try {
    for (const id of [1, 2, 3]) ledger.upsertAsset(asset(id))
    const sqlite = process.getBuiltinModule('node:sqlite') as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } }
    const raw = new sqlite.DatabaseSync(file)
    try { raw.exec("INSERT INTO assets (sha256,created_at,json) VALUES ('unrelated','2000-01-01','invalid json'); INSERT INTO metric_observations (id,publication_id,observed_at,json) VALUES ('unrelated','other','2000-01-01','invalid json')") } finally { raw.close() }
    expect(ledger.listAssets({ limit: 2 }).assets).toHaveLength(2)
    expect(ledger.observations({ publicationId: 'wanted' })).toHaveLength(0)
  } finally { ledger.close() }
})

describe('bounded JSONL replay and append', () => {
  it('does not charge disk journal quotas to an ephemeral ledger', () => {
    const ledger = new JsonlLedger(null, { maxJournalBytes: 1, maxRecordBytes: 1 })
    try {
      for (let i = 0; i < 20; i++) ledger.upsertAsset({ ...asset(1), prompt: `replacement ${i}` })
      expect(ledger.getAsset(asset(1).sha256)?.prompt).toBe('replacement 19')
      expect(ledger.listAssets({}).assets).toHaveLength(1)
    } finally { ledger.close() }
  })
  it('replays UTF-8 across chunk boundaries and rejects excess journal/record bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-budget-')); roots.push(root)
    const file = path.join(root, 'ledger.jsonl')
    const original = { ...asset(1), prompt: 'é'.repeat(40000) }
    const ledger = new JsonlLedger(file)
    ledger.upsertAsset(original); ledger.close()
    const reopened = new JsonlLedger(file)
    expect(reopened.getAsset(original.sha256)).toEqual(original); reopened.close()
    expect(() => new JsonlLedger(file, { maxJournalBytes: 100 })).toThrow(/journal exceeds/)
    expect(() => new JsonlLedger(file, { maxRecordBytes: 100 })).toThrow(/record exceeds/)
    expect(() => new JsonlLedger(null, { maxJournalBytes: Infinity })).toThrow(/limits/)
  })
  it('leaves disk and memory unchanged when an append would exceed the budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-append-')); roots.push(root)
    const file = path.join(root, 'ledger.jsonl'), ledger = new JsonlLedger(file, { maxJournalBytes: 400 })
    ledger.upsertAsset(asset(1))
    const before = await readFile(file)
    expect(() => ledger.upsertAsset(asset(2))).toThrow(/journal exceeds/)
    expect(ledger.getAsset(asset(2).sha256)).toBeNull()
    expect(await readFile(file)).toEqual(before)
    ledger.close()
    const reopened = new JsonlLedger(file, { maxJournalBytes: 400 })
    expect(reopened.getAsset(asset(1).sha256)).toEqual(asset(1)); reopened.close()
  })
  it('does not expose unpersisted state after an actual filesystem append failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-write-')); roots.push(root)
    const file = path.join(root, 'ledger.jsonl'), ledger = new JsonlLedger(file)
    await mkdir(file)
    expect(() => ledger.upsertAsset(asset(1))).toThrow()
    expect(ledger.getAsset(asset(1).sha256)).toBeNull(); ledger.close()
  })
  it('fails closed on a truncated record without rewriting the journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-corrupt-')); roots.push(root)
    const file = path.join(root, 'ledger.jsonl'), bytes = '{"t":"asset","r":'
    await writeFile(file, bytes)
    expect(() => new JsonlLedger(file)).toThrow(/invalid JSON/)
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })
  it('prunes expired throttle state on reopen while preserving the append-only file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'creator-ledger-hits-')); roots.push(root)
    const file = path.join(root, 'ledger.jsonl'), ledger = new JsonlLedger(file), now = Date.now()
    ledger.recordHit('fixture', new Date(now - 36 * 60 * 60 * 1000).toISOString())
    ledger.recordHit('fixture', new Date(now - 30 * 60 * 1000).toISOString()); ledger.close()
    const before = await readFile(file), reopened = new JsonlLedger(file)
    expect(reopened.hitsSince('fixture', new Date(now - 48 * 60 * 60 * 1000).toISOString())).toBe(1)
    expect(await readFile(file)).toEqual(before); reopened.close()
  })
})
