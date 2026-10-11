import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import * as z from 'zod/v4'
import type { CreatorContext } from '@starlight-intelligence/creator-core'
import { inputRequired, type ServerContext } from '@modelcontextprotocol/server'
import { defineTool } from '../tool-def.js'
import { loadCompositeTools } from './composite.js'

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
it('propagates a failed built-in call without running later steps or reporting success', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'creator-composite-'))
  await writeFile(path.join(dir, 'tool.json'), JSON.stringify({ name: 'fixture_composite', description: 'Fixture', input: { type: 'object', properties: {} }, steps: [{ kind: 'call', tool: 'fixture_fail', args: {} }, { kind: 'call', tool: 'fixture_after', args: {} }] }))
  const after = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'after' }] }))
  const base = [defineTool({ name: 'fixture_fail', description: 'Fixture', inputSchema: z.object({}), outputSchema: z.object({}), annotations: {}, async handler() { return { content: [{ type: 'text', text: 'fixture failure' }], isError: true } } }),
    defineTool({ name: 'fixture_after', description: 'Fixture', inputSchema: z.object({}), outputSchema: z.object({}), annotations: {}, handler: after })]
  const ctx = { merged: { tools: [{ packId: 'fixture', dir, path: 'tool.json' }] } } as CreatorContext
  const [tool] = await loadCompositeTools(ctx, base)
  const result = await tool!.handler({}, ctx, {} as ServerContext)
  expect(result).toMatchObject({ isError: true })
  expect(after).not.toHaveBeenCalled()
})

it('refuses interactive pause results instead of discarding them and continuing', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'creator-composite-'))
  await writeFile(path.join(dir, 'tool.json'), JSON.stringify({ name: 'fixture_composite', description: 'Fixture', input: { type: 'object', properties: {} }, steps: [{ kind: 'call', tool: 'fixture_pause', args: {} }] }))
  const pause = defineTool({ name: 'fixture_pause', description: 'Fixture', inputSchema: z.object({}), outputSchema: z.object({}), annotations: {}, async handler() { return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ mode: 'form', message: 'Fixture', requestedSchema: { type: 'object', properties: { confirm: { type: 'string' } }, required: ['confirm'] } }) } }) } })
  const ctx = { merged: { tools: [{ packId: 'fixture', dir, path: 'tool.json' }] } } as CreatorContext
  const [tool] = await loadCompositeTools(ctx, [pause])
  expect(await tool!.handler({}, ctx, {} as ServerContext)).toMatchObject({ isError: true })
})

it.each(['creator_publication_approve', 'creator_publish'])('requires %s to be invoked separately from pack composites', async name => {
  dir = await mkdtemp(path.join(tmpdir(), 'creator-composite-'))
  await writeFile(path.join(dir, 'tool.json'), JSON.stringify({ name: 'fixture_composite', description: 'Fixture', input: { type: 'object', properties: {} }, steps: [{ kind: 'call', tool: name, args: {} }] }))
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'fixture' }] }))
  const base = defineTool({ name, description: 'Fixture', inputSchema: z.object({}), outputSchema: z.object({}), annotations: {}, handler })
  const ctx = { merged: { tools: [{ packId: 'fixture', dir, path: 'tool.json' }] } } as CreatorContext
  await expect(loadCompositeTools(ctx, [base])).rejects.toThrow(/unavailable|separately/)
  expect(handler).not.toHaveBeenCalled()
})
