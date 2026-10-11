import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { mergePacks, packManifestSchema, PACK_SCHEMA_VERSION } from '@starlight-intelligence/creator-packs-spec'
import type { CreatorContext } from '@starlight-intelligence/creator-core'
import { CanonIndex } from '../../core/src/packs/index.js'
import { registerResources } from '../src/resources.js'

const owned: Array<{ dir: string; client: Client; server: McpServer }> = []
afterEach(async () => {
  for (const { dir, client, server } of owned.splice(0)) {
    try { await client.close() } finally { try { await server.close() } finally { await rm(dir, { recursive: true, force: true }) } }
  }
})

async function fixture(canon: { paths?: string[]; locked?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'creator-canon-resources-'))
  const client = new Client({ name: 'canon-fixture', version: '0.0.0' })
  const server = new McpServer({ name: 'canon-fixture', version: '0.0.0' })
  owned.push({ dir, client, server })
  await mkdir(path.join(dir, 'canon'))
  await writeFile(path.join(dir, 'canon/empty.md'), '')
  await writeFile(path.join(dir, 'canon/world.txt'), 'A text world')
  await writeFile(path.join(dir, 'canon/entities.json'), '{"name":"A JSON world"}')
  await writeFile(path.join(dir, 'canon/locked.md'), 'A locked world')
  await writeFile(path.join(dir, 'canon/image.png'), Buffer.from([137, 80, 78, 71, 0, 255]))
  const manifest = packManifestSchema.parse({ schemaVersion: PACK_SCHEMA_VERSION, id: 'fixture', name: 'Fixture', version: '1.0.0', license: { type: 'MIT' }, canon })
  const merged = mergePacks([{ dir, manifest, digest: 'a'.repeat(64) }], '0.1.0')
  const index = await CanonIndex.build(merged)
  registerResources(server, { merged, packs: { canon: index } } as unknown as CreatorContext)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  return client
}

it('lists only text canon over MCP, preserves JSON and empty markdown, and refuses binary glob or locked files', async () => {
  const client = await fixture({ paths: ['canon/**/*', 'canon/*.md'], locked: 'canon/image.png' })
  const { resources } = await client.listResources()
  const canon = resources.filter(resource => resource.uri.includes('/canon/'))
  expect(canon.map(resource => resource.uri)).not.toContain('pack://fixture/canon/canon/image.png')
  expect(new Set(canon.map(resource => resource.uri)).size).toBe(canon.length)
  const json = await client.readResource({ uri: 'pack://fixture/canon/canon/entities.json' })
  expect(json.contents[0]).toMatchObject({ mimeType: 'application/json', text: '{"name":"A JSON world"}' })
  expect((await client.readResource({ uri: 'pack://fixture/canon/canon/world.txt' })).contents[0]).toMatchObject({ mimeType: 'text/plain', text: 'A text world' })
  expect((await client.readResource({ uri: 'pack://fixture/canon/canon/empty.md' })).contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '' })
  await expect(client.readResource({ uri: 'pack://fixture/canon/canon/image.png' })).rejects.toThrow(/text canon/)
})

it('retains an explicitly locked text resource even without a canon glob', async () => {
  const client = await fixture({ locked: 'canon/locked.md' })
  expect((await client.listResources()).resources).toContainEqual(expect.objectContaining({ uri: 'pack://fixture/canon/canon/locked.md', mimeType: 'text/markdown' }))
  expect((await client.readResource({ uri: 'pack://fixture/canon/canon/locked.md' })).contents[0]).toMatchObject({ mimeType: 'text/markdown', text: 'A locked world' })
})
