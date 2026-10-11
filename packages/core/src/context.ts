import path from 'node:path'
import type { MergedPack } from '@starlight-intelligence/creator-packs-spec'
import { AssetStore } from './assets/store.js'
import { assetsDir, creatorHome, loadConfig, type CreatorConfig } from './config.js'
import { openLedger, type Ledger } from './ledger/index.js'
import { PolarLicense } from './license/polar.js'
import { createLogger, Redactor, type Logger } from './log.js'
import { generateBestOf, type BestOfResult } from './loop/best-of.js'
import { MetricsService } from './metrics/index.js'
import type { FetchPolicy } from './net/fetch-guard.js'
import { loadPacks, type LoadedPacks } from './packs/index.js'
import type { Provider } from './provider/interface.js'
import { ProviderRegistry } from './provider/registry.js'
import type { PublishAdapter } from './publish/adapter.js'
import { LocalStagingAdapter } from './publish/local-staging.js'
import { PostizAdapter } from './publish/postiz.js'
import { PublishService } from './publish/service.js'
import { ManifestSigner } from './publish/signer.js'
import { ModelCatalog } from './registry/catalog.js'
import { applyStyle, routeModel, type RouteResult } from './registry/router.js'
import type { StorageConnector } from './storage/interface.js'
import { LocalStorage } from './storage/local.js'
import { RcloneStorage } from './storage/rclone.js'
import { JobManager } from './jobs/manager.js'
import { TasteScorer } from './taste/scorer.js'
import type { GenerationRequest, JobRecord, Quality, Score, Task } from './types.js'
import { createVault, SECRET_NAMES, type Vault } from './vault/index.js'
import { SUBSTRATE_VERSION } from './index.js'

export interface CreatorContextOptions {
  packs: string[]
  providers: (vault: Vault) => Provider[] | Promise<Provider[]>
  storageConnectors?: (vault: Vault, cfg: CreatorConfig) => Promise<StorageConnector[]>
  packsByBenefit?: Record<string, string[]>
  config?: CreatorConfig
  vault?: Vault
  ledger?: Ledger
  log?: Logger
  dev?: boolean
}

export interface GenerateInput {
  task: Task
  prompt?: string
  negativePrompt?: string
  model?: string
  quality?: Quality
  style?: string
  params: Record<string, string | number | boolean>
  sourceAssets: Array<{ role: 'image' | 'video' | 'audio' | 'reference'; sha256: string }>
  seed?: number
  bestOf?: number
  minScore?: number
  waitMs: number
  rubric?: string
}

export interface GenerateOutput {
  job: JobRecord
  route: RouteResult
  score?: Score
  candidates?: Array<{ sha256: string; score?: number }>
  stoppedBy?: BestOfResult<unknown>['stoppedBy']
}

export class CreatorContext {
  private constructor(
    readonly config: CreatorConfig,
    readonly vault: Vault,
    readonly log: Logger,
    readonly providers: ProviderRegistry,
    readonly catalog: ModelCatalog,
    readonly ledger: Ledger,
    readonly assets: AssetStore,
    readonly connectors: Map<string, StorageConnector>,
    readonly jobs: JobManager,
    readonly scorer: TasteScorer,
    readonly signer: ManifestSigner,
    readonly publishAdapters: Map<string, PublishAdapter>,
    readonly publish: PublishService,
    readonly metrics: MetricsService,
    readonly license: PolarLicense,
    readonly packs: LoadedPacks,
    readonly fetchPolicy: FetchPolicy,
    readonly packsByBenefit: Record<string, string[]>,
  ) {}

  get merged(): MergedPack { return this.packs.merged }
  get home(): string { return creatorHome() }

  static async create(opts: CreatorContextOptions): Promise<CreatorContext> {
    const config = opts.config ?? (await loadConfig())
    const redactor = new Redactor()
    const log = opts.log ?? createLogger({ redactor })
    const vault = opts.vault ?? (await createVault({ redactor }))
    const providers = new ProviderRegistry()
    for (const p of await opts.providers(vault)) providers.register(p)
    const fetchPolicy: FetchPolicy = { allowHosts: [...config.policy.allowHosts, ...providers.allowedHosts()], allowPrivateHosts: config.policy.allowPrivateHosts, maxBytes: config.policy.maxAssetBytes }
    const home = creatorHome()
    const ledger = opts.ledger ?? openLedger({ home })
    try {
      const local = new LocalStorage(assetsDir(config))
      const connectors = new Map<string, StorageConnector>([['local', local]])
      if (config.storage.rclone) connectors.set('rclone', new RcloneStorage(config.storage.rclone.remote, config.storage.rclone.prefix))
      for (const c of await (opts.storageConnectors?.(vault, config) ?? Promise.resolve([]))) connectors.set(c.id, c)
      const assets = new AssetStore({ ledger, local, connectors, substrateVersion: SUBSTRATE_VERSION })
      const catalog = new ModelCatalog(providers, path.join(home, 'cache'), log.child('catalog'))
      const jobs = new JobManager({ ledger, providers, assets, fetchPolicy, maxAssetBytes: config.policy.maxAssetBytes, log: log.child('jobs'), substrateVersion: SUBSTRATE_VERSION })
      const judgeProvider = async () => {
        const preferred = config.providers.judge
        const order = preferred ? [preferred, ...providers.all().map(p => p.id)] : providers.all().map(p => p.id)
        for (const id of order) {
          if (!providers.has(id)) continue
          const p = providers.get(id)
          if (p.text && p.capabilities().includes('vision') && (await p.isConfigured())) return { provider: p }
        }
        return null
      }
      const scorer = new TasteScorer(ledger, judgeProvider)
      const signer = new ManifestSigner(vault)
      const publishAdapters = new Map<string, PublishAdapter>([['local', new LocalStagingAdapter(path.join(home, 'outbox'))]])
      const postizKey = await vault.resolve(SECRET_NAMES.postiz)
      if (config.postiz.apiUrl && postizKey) publishAdapters.set('postiz', new PostizAdapter({ apiUrl: config.postiz.apiUrl, apiKey: postizKey, fetchPolicy }))
      const publish = new PublishService({ ledger, assets, signer, adapters: publishAdapters })
      const metrics = new MetricsService(ledger, publishAdapters)
      const license = new PolarLicense({ home, signer, fetchPolicy })
      const packsByBenefit = opts.packsByBenefit ?? {}
      const licenseKey = await vault.resolve(SECRET_NAMES.license)
      let licensed = new Set<string>()
      if (licenseKey) {
        const status = await license.validate({ key: licenseKey, packsByBenefit }).catch(() => null)
        if (status?.valid) licensed = new Set(status.packs)
      }
      const packs = await loadPacks(opts.packs, SUBSTRATE_VERSION, { log: log.child('packs'), licensedPackIds: licensed, dev: opts.dev ?? process.env.CREATOR_DEV === '1' })
      return new CreatorContext(config, vault, log, providers, catalog, ledger, assets, connectors, jobs, scorer, signer, publishAdapters, publish, metrics, license, packs, fetchPolicy, packsByBenefit)
    } catch (err) {
      // A context was never returned, so the caller cannot release our resources.
      // Injected ledgers remain the caller's responsibility on failed creation.
      if (!opts.ledger) ledger.close()
      throw err
    }
  }

  async route(task: Task, quality: Quality, prompt?: string, explicitModel?: string): Promise<RouteResult> {
    await this.catalog.refresh()
    return routeModel(this.catalog.list(), this.merged.registry, { task, quality, ...(prompt ? { prompt } : {}), ...(explicitModel ? { explicitModel } : {}) })
  }

  async generate(input: GenerateInput): Promise<GenerateOutput> {
    const style = input.style ? this.merged.styles.get(input.style) : undefined
    if (input.style && !style) throw new Error(`style ${input.style} not found; available: ${[...this.merged.styles.keys()].join(', ') || 'none'}`)
    const prompt = input.prompt ? applyStyle(input.prompt, style) : undefined
    const quality = input.quality ?? 'high'
    const route = await this.route(input.task, quality, prompt, input.model)
    const sources: GenerationRequest['sources'] = []
    for (const s of input.sourceAssets) {
      const data = await this.assets.bytes(s.sha256)
      if (!data) throw new Error(`source asset ${s.sha256.slice(0, 12)} not found in the ledger`)
      sources.push({ role: s.role, bytes: data.bytes, mime: data.mime, sha256: s.sha256 })
    }
    const params = { ...(style?.defaults ?? {}), ...input.params }
    const negativePrompt = input.negativePrompt ?? style?.negative
    const packProv = { pack: { ids: this.merged.packs.map(p => p.id), digest: this.merged.digest }, ...(input.style ? { style: input.style } : {}), license: { pack_license: this.merged.packs.map(p => p.license).join(',') } }
    const summary = { task: input.task, ...(prompt ? { prompt } : {}), ...(negativePrompt ? { negative_prompt: negativePrompt } : {}), params, ...(input.seed !== undefined ? { seed: input.seed } : {}), source_assets: input.sourceAssets.map(s => s.sha256), quality, model: route.model.id }
    const submitOne = async (attempt: number): Promise<JobRecord> => {
      const seed = input.seed !== undefined ? input.seed + attempt - 1 : undefined
      const req: GenerationRequest = { task: input.task, model: route.model, ...(prompt ? { prompt } : {}), ...(negativePrompt ? { negativePrompt } : {}), params, sources, ...(seed !== undefined ? { seed } : {}) }
      const job = await this.jobs.submit({ request: req, provenance: packProv, route: { model: route.model.id, provider: route.model.provider, reason: route.reason }, requestSummary: { ...summary, attempt, ...(seed !== undefined ? { seed } : {}) } })
      return (await this.jobs.waitFor(job.id, input.waitMs)) ?? job
    }
    const wantsLoop = (input.bestOf ?? 1) > 1 || input.minScore !== undefined
    const kind = input.task === 't2i' || input.task === 'i2i' ? 'image' : null
    if (!wantsLoop || !kind) {
      const job = await submitOne(1)
      return { job, route }
    }
    const rubric = this.scorer.rubricFor(this.merged, 'image', input.rubric)
    const scoreJob = async (job: JobRecord): Promise<number | null> => {
      if (job.status !== 'completed' || !job.resultSha256) return null
      const data = await this.assets.bytes(job.resultSha256)
      if (!data) return null
      const s = await this.scorer.score({ kind: 'image', bytes: data.bytes, mime: data.mime, sha256: job.resultSha256 }, rubric, this.merged)
      await this.assets.setScore(job.resultSha256, rubric.id, s.score)
      this.ledger.updateJob(job.id, { score: s })
      return s.score
    }
    const result = await generateBestOf(submitOne, scoreJob, { bestOf: input.bestOf ?? 1, ...(input.minScore !== undefined ? { minScore: input.minScore } : {}) })
    const best = result.best.value
    const candidates = result.candidates.map(c => ({ sha256: c.value.resultSha256 ?? '', ...(c.score !== null ? { score: c.score } : {}) })).filter(c => c.sha256)
    const bestJob = this.ledger.updateJob(best.id, { candidates }) ?? best
    return { job: bestJob, route, ...(bestJob.score ? { score: bestJob.score } : {}), candidates, stoppedBy: result.stoppedBy }
  }

  async close(): Promise<void> { this.ledger.close() }
}
