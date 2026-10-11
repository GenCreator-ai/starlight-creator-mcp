import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { MetricsService } from './index.js'
import type { Ledger } from '../ledger/interface.js'

let home: string
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }) })
it('bounds CSV reads to explicit roots and never records non-finite observations', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'creator-metrics-import-'))
  const root = path.join(home, 'root'), outside = path.join(home, 'outside')
  await mkdir(root); await mkdir(outside)
  await writeFile(path.join(root, 'metrics.csv'), 'publication_id,views,likes,follower_delta\nfixture,42,Infinity,-2')
  await writeFile(path.join(root, 'large.csv'), Buffer.alloc(8 * 1024 * 1024 + 1))
  await writeFile(path.join(outside, 'private.csv'), 'publication_id,views\nfixture,999')
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const addObservation = vi.fn(), ledger = { getPublication: () => ({ id: 'fixture' }), addObservation } as unknown as Ledger
  const metrics = new MetricsService(ledger, new Map())
  expect(await metrics.ingestCsv('metrics.csv', [root])).toEqual({ ingested: 1, skipped: 0 })
  expect(addObservation.mock.calls[0]?.[0]).toMatchObject({ views: 42, followerDelta: -2 })
  expect(addObservation.mock.calls[0]?.[0]).not.toHaveProperty('likes')
  for (const file of ['linked/private.csv', '../outside/private.csv', 'large.csv', path.join(outside, 'private.csv')]) await expect(metrics.ingestCsv(file, [root])).rejects.toThrow()
  expect(addObservation).toHaveBeenCalledTimes(1)
})
