import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JobManager } from './manager.js'
import { JsonlLedger } from '../ledger/jsonl.js'
import { ProviderError, type Provider } from '../provider/interface.js'
import { ProviderRegistry } from '../provider/registry.js'
import { createLogger, Redactor } from '../log.js'
import { AssetStore } from '../assets/store.js'
import { LocalStorage } from '../storage/local.js'
import type { FetchPolicy } from '../net/fetch-guard.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.mocked(lookup).mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

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

async function outputFixture(allowHosts: string[] = [], operatorHosts: string[] = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'creator-job-recovery-')); roots.push(home)
  const file = path.join(home, 'ledger.jsonl')
  const local = new LocalStorage(path.join(home, 'assets'))
  const providers = new ProviderRegistry()
  const result = { outputs: [{ kind: 'video' as const, mime: 'video/mp4', url: 'https://media.example.test/output.mp4' }] }
  const submit = vi.fn<Provider['submit']>(async () => ({ providerJobId: 'durable-provider-job', status: 'queued' }))
  const poll = vi.fn<Provider['poll']>(async () => ({ providerJobId: 'durable-provider-job', status: 'completed', result, costUsd: 0.5 }))
  providers.register({ id: 'fixture', allowHosts, capabilities: () => ['t2v'], isConfigured: async () => true, listModels: async () => [], submit, poll })
  const policy: FetchPolicy = { allowHosts: operatorHosts }
  function reopen() {
    const ledger = new JsonlLedger(file)
    const assets = new AssetStore({ ledger, local, connectors: new Map(), substrateVersion: '0.1.0' })
    const manager = new JobManager({ ledger, providers, assets, fetchPolicy: policy, maxAssetBytes: 1024, log: createLogger({ redactor: new Redactor(), sink: () => {} }), substrateVersion: '0.1.0' })
    return { ledger, assets, manager }
  }
  const current = reopen()
  const job = await current.manager.submit({ request: { task: 't2v', model: { id: 'fixture/video', provider: 'fixture', modelId: 'video', name: 'Fixture', tasks: ['t2v'] }, params: {}, sources: [] }, provenance: {}, route: { model: 'fixture/video', provider: 'fixture', reason: 'fixture' }, requestSummary: { prompt: 'synthetic recovery fixture' } })
  const fetch = vi.fn().mockImplementation(async () => new Response('synthetic video bytes'))
  vi.stubGlobal('fetch', fetch)
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
  return { ...current, job, submit, poll, fetch, policy, reopen }
}

describe('provider output egress and durable retrieval', () => {
  it('rejects an unapproved output hostname before DNS, fetch or asset writes', async () => {
    const { manager, job, fetch, ledger } = await outputFixture()
    try {
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'failed', providerJobId: 'durable-provider-job', error: expect.stringMatching(/^result ingest failed:.*allow/i) })
      expect(lookup).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(ledger.listAssets({}).assets).toHaveLength(0)
    } finally { ledger.close() }
  })
  it.each(['provider', 'operator'])('retrieves an explicitly %s-allowed output', async source => {
    const host = ['media.example.test']
    const { manager, job, fetch, assets, ledger } = await outputFixture(source === 'provider' ? host : [], source === 'operator' ? host : [])
    try {
      const done = await manager.refresh(job.id)
      expect(done).toMatchObject({ status: 'completed', costUsd: 0.5 })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(Buffer.from((await assets.bytes(done!.resultSha256!))!.bytes).toString()).toBe('synthetic video bytes')
    } finally { ledger.close() }
  })
  it('denies a redirect from an approved output to an unapproved host', async () => {
    const { manager, job, fetch, ledger } = await outputFixture(['media.example.test'])
    fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://unapproved.example.test/output' } }))
    try {
      expect(await manager.refresh(job.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^result ingest failed:/) })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(ledger.listAssets({}).assets).toHaveLength(0)
    } finally { ledger.close() }
  })
  it('reopens a failed durable job and recovers verified bytes without another generation', async () => {
    const f = await outputFixture()
    const failed = await f.manager.refresh(f.job.id)
    expect(failed).toMatchObject({ status: 'failed', providerJobId: 'durable-provider-job', costUsd: 0.5 })
    f.ledger.close()
    const reopened = f.reopen()
    try {
      expect(await reopened.manager.refresh(f.job.id)).toEqual(failed)
      expect(f.poll).toHaveBeenCalledTimes(1)
      expect(await reopened.manager.retryIngest(f.job.id)).toMatchObject({ status: 'failed' })
      expect(f.fetch).not.toHaveBeenCalled()
      f.policy.allowHosts.push('media.example.test')
      const done = await reopened.manager.retryIngest(f.job.id)
      expect(done).toMatchObject({ id: f.job.id, status: 'completed', providerJobId: 'durable-provider-job', costUsd: 0.5 })
      expect(done?.error).toBeUndefined()
      expect(f.submit).toHaveBeenCalledTimes(1)
      expect(f.poll.mock.calls).toEqual(Array.from({ length: 3 }, () => ['durable-provider-job', 't2v']))
      expect(reopened.ledger.listJobs({})).toHaveLength(1)
      expect(reopened.ledger.listAssets({}).assets).toHaveLength(1)
      expect(Buffer.from((await reopened.assets.bytes(done!.resultSha256!))!.bytes).toString()).toBe('synthetic video bytes')
      expect(reopened.ledger.getAsset(done!.resultSha256!)?.provenance).toMatchObject({ job_id: f.job.id, prompt: 'synthetic recovery fixture', cost_usd: 0.5 })
      await reopened.manager.retryIngest(f.job.id)
      expect(f.poll).toHaveBeenCalledTimes(3)
      reopened.ledger.close()
      const final = f.reopen()
      try { expect(final.ledger.getJob(f.job.id)).toEqual(done) } finally { final.ledger.close() }
    } finally { reopened.ledger.close() }
  })
  it.each(['cancelled', 'failed'] as const)('does not resurrect a provider %s job through retrieval retry', async status => {
    const poll = vi.fn<Provider['poll']>(async () => ({ providerJobId: 'fixture-job', status, error: 'provider terminal failure' }))
    const { manager, job, ledger } = await fixture(poll)
    try {
      const terminal = await manager.refresh(job.id)
      expect(await manager.retryIngest(job.id)).toEqual(terminal)
      expect(poll).toHaveBeenCalledTimes(1)
      expect(await manager.retryIngest('unknown')).toBeNull()
    } finally { ledger.close() }
  })
  it('retains a recoverable retrieval error when the existing job poll is throttled', async () => {
    const f = await outputFixture()
    try {
      await f.manager.refresh(f.job.id)
      f.poll.mockRejectedValueOnce(new ProviderError('rate limited', 'fixture', true, 429))
      expect(await f.manager.retryIngest(f.job.id)).toMatchObject({ status: 'failed', error: 'result ingest failed: retrieval poll failed: rate limited' })
      f.policy.allowHosts.push('media.example.test')
      expect(await f.manager.retryIngest(f.job.id)).toMatchObject({ status: 'completed', error: undefined })
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally { f.ledger.close() }
  })
  it('does not report successful recovery when an inline provider has no retained output', async () => {
    const f = await outputFixture()
    try {
      await f.manager.refresh(f.job.id)
      f.poll.mockResolvedValueOnce({ providerJobId: 'durable-provider-job', status: 'completed', result: { outputs: [] } })
      expect(await f.manager.retryIngest(f.job.id)).toMatchObject({ status: 'failed', costUsd: 0.5, error: 'result ingest failed: provider returned no recoverable output' })
      expect(f.ledger.listAssets({}).assets).toHaveLength(0)
      expect(f.submit).toHaveBeenCalledTimes(1)
    } finally { f.ledger.close() }
  })
})
