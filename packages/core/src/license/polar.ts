import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256Hex } from '@starlight-intelligence/creator-packs-spec'
import { discardBody, guardedFetch, type FetchPolicy } from '../net/fetch-guard.js'
import type { ManifestSigner } from '../publish/signer.js'

export const POLAR_HOST = 'api.polar.sh'
export const OFFLINE_GRACE_DAYS = 14

export interface LicenseStatus {
  valid: boolean
  source: 'online' | 'cache' | 'none'
  status?: 'granted' | 'revoked' | 'disabled'
  benefitId?: string
  packs: string[]
  validatedAt?: string
  graceUntil?: string
  expiresAt?: string
  reason?: string
}

interface CacheEntry { fingerprint: string; benefitId?: string; organizationId: string; status: string; validatedAt: string; expiresAt?: string; activationId?: string; packs: string[]; mac: string }

export interface PolarLicenseOptions {
  home: string
  signer: ManifestSigner
  fetchPolicy: FetchPolicy
  baseUrl?: string
  now?: () => Date
}

export class PolarLicense {
  private readonly base: string
  private readonly policy: FetchPolicy
  constructor(private readonly o: PolarLicenseOptions) {
    this.base = (o.baseUrl ?? `https://${POLAR_HOST}`).replace(/\/+$/, '')
    this.policy = { ...o.fetchPolicy, allowHosts: [...o.fetchPolicy.allowHosts, new URL(this.base).hostname], timeoutMs: 15_000 }
  }

  private cacheFile(): string { return path.join(this.o.home, 'license.json') }

  private async readCache(): Promise<CacheEntry | null> {
    try {
      const entry = JSON.parse(await readFile(this.cacheFile(), 'utf8')) as CacheEntry
      const expected = await this.o.signer.mac(this.cacheBody(entry))
      return expected === entry.mac ? entry : null
    } catch { return null }
  }

  private cacheBody(e: Omit<CacheEntry, 'mac'>): string {
    return [e.fingerprint, e.benefitId ?? '', e.organizationId, e.status, e.validatedAt, e.expiresAt ?? '', e.activationId ?? '', e.packs.join(',')].join('|')
  }

  private async writeCache(entry: Omit<CacheEntry, 'mac'>): Promise<void> {
    await mkdir(this.o.home, { recursive: true })
    await writeFile(this.cacheFile(), `${JSON.stringify({ ...entry, mac: await this.o.signer.mac(this.cacheBody(entry)) }, null, 2)}\n`, { mode: 0o600 })
  }

  async activate(key: string, organizationId: string, label = `${os.hostname()}-${os.platform()}`): Promise<{ activationId: string } | null> {
    const res = await guardedFetch(`${this.base}/v1/customer-portal/license-keys/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, organization_id: organizationId, label }), policy: this.policy })
    if (!res.ok) { await discardBody(res); return null }
    const data = (await res.json()) as { id?: string }
    return data.id ? { activationId: data.id } : null
  }

  async validate(input: { key: string | null; organizationId?: string; packsByBenefit: Record<string, string[]>; refresh?: boolean }): Promise<LicenseStatus> {
    const now = (this.o.now ?? (() => new Date()))()
    if (!input.key) return { valid: false, source: 'none', packs: [], reason: 'no license key configured; run creator-mcp setup --license' }
    const fingerprint = sha256Hex(input.key).slice(0, 16)
    const cached = await this.readCache()
    const cachedMatches = cached && cached.fingerprint === fingerprint
    if (!input.refresh && cachedMatches && cached.status === 'granted') {
      const grace = new Date(new Date(cached.validatedAt).getTime() + OFFLINE_GRACE_DAYS * 86_400_000)
      if (grace > now && (!cached.expiresAt || new Date(cached.expiresAt) > now) && now.getTime() - new Date(cached.validatedAt).getTime() < 86_400_000) {
        return { valid: true, source: 'cache', status: 'granted', packs: cached.packs, validatedAt: cached.validatedAt, graceUntil: grace.toISOString(), ...(cached.benefitId ? { benefitId: cached.benefitId } : {}), ...(cached.expiresAt ? { expiresAt: cached.expiresAt } : {}) }
      }
    }
    const organizationId = input.organizationId ?? cached?.organizationId
    if (!organizationId) return { valid: false, source: 'none', packs: [], reason: 'no Polar organization id known for this license' }
    try {
      const res = await guardedFetch(`${this.base}/v1/customer-portal/license-keys/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input.key, organization_id: organizationId, ...(cached?.activationId ? { activation_id: cached.activationId } : {}) }), policy: this.policy,
      })
      if (res.status === 404 || res.status === 403 || res.status === 401) {
        await discardBody(res)
        await this.writeCache({ fingerprint, organizationId, status: 'revoked', validatedAt: now.toISOString(), packs: [] })
        return { valid: false, source: 'online', status: 'revoked', packs: [], reason: `Polar rejected the key (${res.status})` }
      }
      if (!res.ok) {
        await discardBody(res)
        throw new Error(`Polar returned ${res.status}`)
      }
      const data = (await res.json()) as { status?: string; expires_at?: string | null; benefit_id?: string; activation?: { id?: string } | null }
      const status = (data.status ?? 'revoked') as LicenseStatus['status']
      const packs = data.benefit_id ? (input.packsByBenefit[data.benefit_id] ?? []) : []
      const valid = status === 'granted' && (!data.expires_at || new Date(data.expires_at) > now)
      await this.writeCache({ fingerprint, organizationId, status: status ?? 'revoked', validatedAt: now.toISOString(), packs, ...(data.benefit_id ? { benefitId: data.benefit_id } : {}), ...(data.expires_at ? { expiresAt: data.expires_at } : {}), ...(data.activation?.id ? { activationId: data.activation.id } : {}) })
      return { valid, source: 'online', status: status ?? 'revoked', packs, validatedAt: now.toISOString(), ...(data.benefit_id ? { benefitId: data.benefit_id } : {}), ...(data.expires_at ? { expiresAt: data.expires_at } : {}), ...(valid ? {} : { reason: `license status ${status}` }) }
    } catch (err) {
      if (cachedMatches && cached.status === 'granted') {
        const grace = new Date(new Date(cached.validatedAt).getTime() + OFFLINE_GRACE_DAYS * 86_400_000)
        if (grace > now) return { valid: true, source: 'cache', status: 'granted', packs: cached.packs, validatedAt: cached.validatedAt, graceUntil: grace.toISOString(), reason: `offline: ${(err as Error).message}` }
        return { valid: false, source: 'cache', status: 'granted', packs: [], reason: `offline grace of ${OFFLINE_GRACE_DAYS} days expired; validate online once` }
      }
      return { valid: false, source: 'none', packs: [], reason: `could not reach Polar and no prior online validation exists: ${(err as Error).message}` }
    }
  }
}
