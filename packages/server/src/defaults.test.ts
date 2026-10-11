import { afterEach, describe, expect, it, vi } from 'vitest'
import { configSchema, createVault } from '@starlight-intelligence/creator-core'
import { defaultStorageConnectors, isMissingS3Package } from './defaults.js'

const optionalPackage = '@starlight-intelligence/creator-storage-s3'
describe('optional S3 loading', () => {
  afterEach(() => { vi.doUnmock(optionalPackage); vi.resetModules() })
  const configured = () => configSchema.parse({ storage: { s3: { bucket: 'fixture' } } })
  it('does not import S3 when no bucket is configured', async () => {
    vi.doMock(optionalPackage, () => { throw new Error('must not load') })
    expect(await defaultStorageConnectors(await createVault({ backend: 'memory' }), configSchema.parse({}))).toEqual([])
  })
  it('diagnoses missing optional package specifically', async () => {
    const absent = Object.assign(new Error(`Cannot find package '${optionalPackage}' imported from /fixture/defaults.js`), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(isMissingS3Package(absent)).toBe(true)
    expect(isMissingS3Package(Object.assign(new Error("Cannot find package '@aws-sdk/client-s3' imported from /fixture/s3.js"), { code: 'ERR_MODULE_NOT_FOUND' }))).toBe(false)
    expect(isMissingS3Package(new Error('broken configuration'))).toBe(false)
    vi.doMock(optionalPackage, () => ({ createS3Storage: async () => { throw absent } }))
    await expect(defaultStorageConnectors(await createVault({ backend: 'memory' }), configured())).rejects.toThrow('optional creator-storage-s3 is not installed')
  })
  it('does not suppress a broken transitive module or initialization failure', async () => {
    vi.doMock(optionalPackage, () => ({ createS3Storage: async () => { throw Object.assign(new Error("Cannot find package '@aws-sdk/client-s3' imported from /fixture/s3.js"), { code: 'ERR_MODULE_NOT_FOUND' }) } }))
    await expect(defaultStorageConnectors(await createVault({ backend: 'memory' }), configured())).rejects.toThrow('@aws-sdk/client-s3')
  })
  it('threads configured network limits and registers the connector', async () => {
    const connector = { id: 's3' }
    const create = vi.fn(async () => connector)
    vi.doMock(optionalPackage, () => ({ createS3Storage: create }))
    const cfg = configured()
    cfg.policy.allowHosts = ['s3.eu-west-1.amazonaws.com']
    cfg.policy.maxAssetBytes = 123
    expect(await defaultStorageConnectors(await createVault({ backend: 'memory' }), cfg)).toEqual([connector])
    expect(create.mock.calls[0]).toHaveLength(3)
    expect(create.mock.calls[0]?.[2]).toMatchObject({ allowHosts: cfg.policy.allowHosts, maxBytes: 123, allowPrivateHosts: false })
  })
})
