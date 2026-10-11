import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreatorContext } from './context.js'
import { configSchema } from './config.js'
import { createVault } from './vault/index.js'
import { JsonlLedger } from './ledger/jsonl.js'

describe('context initialization recovery', () => {
  let dir: string | undefined
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (dir) {
      expect(path.dirname(dir)).toBe(path.resolve(tmpdir()))
      await rm(dir, { recursive: true, force: true })
    }
    dir = undefined
  })
  it('releases an owned ledger when configured storage initialization fails', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-context-failure-'))
    vi.stubEnv('CREATOR_MCP_HOME', dir)
    await expect(CreatorContext.create({ config: configSchema.parse({}), vault: await createVault({ backend: 'memory' }),
      packs: [], providers: () => [], storageConnectors: async () => { throw new Error('fixture storage failure') } })).rejects.toThrow('fixture storage failure')
    // On Windows this fails with EBUSY when SQLite was not closed.
    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()))
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  })
  it('preserves caller-owned ledgers when initialization fails', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-context-injected-'))
    vi.stubEnv('CREATOR_MCP_HOME', dir)
    const ledger = new JsonlLedger(null)
    const close = vi.spyOn(ledger, 'close')
    await expect(CreatorContext.create({ config: configSchema.parse({}), vault: await createVault({ backend: 'memory' }), ledger,
      packs: [], providers: () => [], storageConnectors: async () => { throw new Error('fixture storage failure') } })).rejects.toThrow('fixture storage failure')
    expect(close).not.toHaveBeenCalled()
    ledger.close()
  })
})
