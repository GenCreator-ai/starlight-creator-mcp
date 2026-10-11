import { describe, expect, it, vi } from 'vitest'
import { JobManager } from './manager.js'
import { JsonlLedger } from '../ledger/jsonl.js'
import { ProviderError, type Provider } from '../provider/interface.js'
import { ProviderRegistry } from '../provider/registry.js'
import { createLogger, Redactor } from '../log.js'
import type { AssetStore } from '../assets/store.js'

async function fixture(poll: Provider['poll']) {
  const ledger = new JsonlLedger(null), providers = new ProviderRegistry()
  const provider: Provider = { id: 'fixture', allowHosts: [], capabilities: () => ['t2v'], isConfigured: async () => true, listModels: async () => [], submit: async () => ({ providerJobId: 'fixture-job', status: 'queued' }), poll }
  providers.register(provider)
  const manager = new JobManager({ ledger, providers, assets: {} as AssetStore, fetchPolicy: { allowHosts: [] }, maxAssetBytes: 1024, log: createLogger({ redactor: new Redactor(), sink: () => {} }), substrateVersion: '0.1.0' })
  const job = await manager.submit({ request: { task: 't2v', model: { id: 'fixture/video', provider: 'fixture', modelId: 'video', name: 'Fixture', tasks: ['t2v'] }, params: {}, sources: [] }, provenance: {}, route: { model: 'fixture/video', provider: 'fixture', reason: 'fixture' }, requestSummary: {} })
  return { manager, job, ledger }
}
describe('durable job terminal states', () => {
  it('persists cancellation and never polls a cancelled job again', async () => {
    const poll = vi.fn<Provider['poll']>(async () => ({ providerJobId: 'fixture-job', status: 'cancelled' }))
    const { manager, job, ledger } = await fixture(poll)
    try {
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'cancelled' })
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'cancelled' })
      expect(poll).toHaveBeenCalledTimes(1)
    } finally { ledger.close() }
  })
  it('fails a permanently rejected poll while keeping transient throttling recoverable', async () => {
    const poll = vi.fn<Provider['poll']>().mockRejectedValueOnce(new ProviderError('rate limited', 'fixture', true, 429)).mockRejectedValueOnce(new ProviderError('content origin denied', 'fixture', false))
    const { manager, job, ledger } = await fixture(poll)
    try {
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'queued' })
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'failed', error: 'content origin denied' })
      await manager.refresh(job.id)
      expect(poll).toHaveBeenCalledTimes(2)
    } finally { ledger.close() }
  })
})
