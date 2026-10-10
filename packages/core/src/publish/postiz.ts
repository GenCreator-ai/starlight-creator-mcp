import { discardBody, guardedFetch, type FetchPolicy } from '../net/fetch-guard.js'
import type { Channel, PublishAdapter, PublishOutcome } from './adapter.js'
import type { ManifestPost, PublicationManifest } from './manifest.js'

export interface PostizOptions {
  apiUrl: string
  apiKey: string
  fetchPolicy: FetchPolicy
  hourlyLimit?: number
}

interface PostizIntegration { id: string | number; name?: string; platformName?: string; type?: string; provider?: string; identifier?: string; profileName?: string; username?: string; disabled?: boolean }

export class PostizAdapter implements PublishAdapter {
  readonly id = 'postiz'
  readonly hourlyLimit: number
  private readonly base: string
  private readonly policy: FetchPolicy

  constructor(private readonly o: PostizOptions) {
    const trimmed = o.apiUrl.replace(/\/+$/, '')
    this.base = /\/public\/v1$/.test(trimmed) ? trimmed : `${trimmed}/public/v1`
    this.policy = { ...o.fetchPolicy, allowHosts: [...o.fetchPolicy.allowHosts, new URL(this.base).hostname], timeoutMs: 30_000 }
    this.hourlyLimit = o.hourlyLimit ?? 30
  }

  private headers(json = true): Record<string, string> {
    return { Authorization: this.o.apiKey, ...(json ? { 'Content-Type': 'application/json' } : {}) }
  }

  async listChannels(): Promise<Channel[]> {
    let res = await guardedFetch(`${this.base}/integrations`, { headers: this.headers(false), policy: this.policy })
    if (!res.ok) {
      await discardBody(res)
      res = await guardedFetch(`${this.base}/channels`, { headers: this.headers(false), policy: this.policy })
    }
    if (!res.ok) {
      await discardBody(res)
      throw new Error(`Postiz integrations request failed: ${res.status}`)
    }
    const data = (await res.json()) as PostizIntegration[] | { integrations?: PostizIntegration[]; data?: PostizIntegration[] }
    const list = Array.isArray(data) ? data : data.integrations ?? data.data ?? []
    return list.filter(i => !i.disabled).map(i => ({ id: String(i.id), name: i.name ?? i.profileName ?? i.username ?? 'channel', platform: i.identifier ?? i.type ?? i.provider ?? 'unknown', raw: i as unknown as Record<string, unknown> }))
  }

  async uploadFromUrl(url: string): Promise<{ id: string; path: string } | null> {
    const res = await guardedFetch(`${this.base}/upload-from-url`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ url }), policy: this.policy })
    if (!res.ok) { await discardBody(res); return null }
    const data = (await res.json()) as { id?: string; path?: string }
    return data.id && data.path ? { id: data.id, path: data.path } : null
  }

  async publish(manifest: PublicationManifest, post: ManifestPost, media: Array<{ sha256: string; url: string; mime: string }>, opts: { dryRun: boolean }): Promise<PublishOutcome> {
    const images = media.map(m => ({ id: m.sha256.slice(0, 12), path: m.url }))
    const body = {
      type: post.scheduled_at ? 'schedule' : 'now',
      date: post.scheduled_at ?? new Date().toISOString(),
      shortLink: false,
      tags: manifest.campaign_id ? [{ value: manifest.campaign_id, label: manifest.campaign_id }] : [],
      posts: [{ integration: { id: post.channel_id }, value: [{ content: post.text + (post.link ? `\n${post.link}` : ''), image: images }], settings: {} }],
    }
    if (opts.dryRun) return { channelId: post.channel_id, status: 'dry_run' }
    const res = await guardedFetch(`${this.base}/posts`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), policy: this.policy })
    if (!res.ok) return { channelId: post.channel_id, status: 'failed', error: `Postiz returned ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = (await res.json()) as Array<{ postId?: string; id?: string; releaseURL?: string }> | { id?: string; postId?: string; releaseURL?: string }
    const first = Array.isArray(data) ? data[0] : data
    const nativeId = String(first?.postId ?? first?.id ?? 'submitted')
    return { channelId: post.channel_id, status: 'sent', nativeId, ...(first?.releaseURL ? { nativeUrl: first.releaseURL } : {}) }
  }

  async fetchMetrics(nativeId: string): Promise<Record<string, number> | null> {
    const res = await guardedFetch(`${this.base}/posts/${encodeURIComponent(nativeId)}`, { headers: this.headers(false), policy: this.policy })
    if (!res.ok) { await discardBody(res); return null }
    const data = (await res.json()) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(data)) if (typeof v === 'number') out[k] = v
    return Object.keys(out).length ? out : null
  }

  async stat(): Promise<{ ok: boolean; detail: string }> {
    try { const ch = await this.listChannels(); return { ok: true, detail: `${ch.length} channels at ${this.base}` } } catch (err) { return { ok: false, detail: (err as Error).message } }
  }
}
