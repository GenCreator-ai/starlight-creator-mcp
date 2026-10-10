import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CreatorConfig, Provider, StorageConnector, Vault } from '@starlight-intelligence/creator-core'
import { createElevenLabsProvider } from '@starlight-intelligence/creator-provider-elevenlabs'
import { createGoogleProvider } from '@starlight-intelligence/creator-provider-google'
import { createMuapiProvider } from '@starlight-intelligence/creator-provider-muapi'
import { createOpenRouterProvider } from '@starlight-intelligence/creator-provider-openrouter'

const here = path.dirname(fileURLToPath(import.meta.url))
const STARTER_CANDIDATES = [path.resolve(here, '..', 'packs', 'starter'), path.resolve(here, '..', '..', '..', 'packs', 'starter')]
export const STARTER_PACK = STARTER_CANDIDATES.find(p => existsSync(path.join(p, 'pack.json'))) ?? STARTER_CANDIDATES[0]!

export function defaultProviders(vault: Vault): Provider[] {
  const fetchPolicy = { allowHosts: [], allowPrivateHosts: process.env.CREATOR_ALLOW_PRIVATE_HOSTS === '1' }
  return [
    createOpenRouterProvider({ vault, fetchPolicy }),
    createMuapiProvider({ vault, fetchPolicy }),
    createElevenLabsProvider({ vault, fetchPolicy }),
    createGoogleProvider({ vault, fetchPolicy }),
  ]
}

/**
 * S3 is optional: the AWS SDK is a large dependency, so it is loaded only when a bucket is
 * configured and the package is installed. Explicit S3 configuration must be diagnosable.
 */
export async function defaultStorageConnectors(vault: Vault, cfg: CreatorConfig): Promise<StorageConnector[]> {
  if (!cfg.storage.s3?.bucket) return []
  try {
    const mod = await import('@starlight-intelligence/creator-storage-s3')
    const s3 = await mod.createS3Storage(vault, cfg.storage.s3, {
      allowHosts: cfg.policy.allowHosts,
      allowPrivateHosts: process.env.CREATOR_ALLOW_PRIVATE_HOSTS === '1' && cfg.policy.allowPrivateHosts,
      maxBytes: cfg.policy.maxAssetBytes,
    })
    return s3 ? [s3] : []
  } catch (err) {
    if (isMissingS3Package(err)) {
      throw new Error('S3 is configured but optional creator-storage-s3 is not installed; install @starlight-intelligence/creator-storage-s3 or remove storage.s3 configuration', { cause: err })
    }
    throw err
  }
}

export function isMissingS3Package(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | null
  return e?.code === 'ERR_MODULE_NOT_FOUND' && /^Cannot find package '@starlight-intelligence\/creator-storage-s3' imported from /.test(e.message)
}

export function packsFromEnv(): string[] {
  const env = process.env.CREATOR_PACKS
  const list = env ? env.split(path.delimiter).map(s => s.trim()).filter(Boolean) : []
  return list.length ? list : [STARTER_PACK]
}
