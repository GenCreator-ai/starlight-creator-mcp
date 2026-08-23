import { describe, expect, it } from 'vitest'
import { createS3Storage, S3Storage } from './index.js'
import { createVault } from '@starlight-intelligence/creator-core'

const SHA = 'a'.repeat(64)

function storage(overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) {
  return new S3Storage({ bucket: 'assets', accessKeyId: 'ak', secretAccessKey: 'sk', ...overrides })
}

describe('S3 key layout', () => {
  it('mirrors the local content-addressed layout', () => {
    expect(storage().key(SHA, 'png')).toBe(`${SHA.slice(0, 2)}/${SHA}.png`)
  })

  it('applies a prefix and normalises stray slashes', () => {
    expect(storage({ prefix: '/media/' }).key(SHA, 'mp4')).toBe(`media/${SHA.slice(0, 2)}/${SHA}.mp4`)
  })

  it('always uses forward slashes so Windows keys are not corrupted', () => {
    expect(storage({ prefix: 'a' }).key(SHA, 'webp')).not.toContain('\\')
  })
})

describe('public URLs', () => {
  it('uses the public domain verbatim when configured', async () => {
    const url = await storage({ publicDomain: 'https://cdn.example.com/' }).publicUrl(SHA, 'png')
    expect(url).toBe(`https://cdn.example.com/${SHA.slice(0, 2)}/${SHA}.png`)
  })

  it('falls back to a presigned GET so a private bucket can still publish', async () => {
    const url = await storage({ region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com' }).publicUrl(SHA, 'png')
    expect(url).toContain(`${SHA}.png`)
    expect(url).toContain('X-Amz-Signature')
    expect(url).toContain('X-Amz-Expires')
  })

  it('presigns uploads for browser-direct flows', async () => {
    const url = await storage().presignUpload(SHA, 'png', 'image/png', 600)
    expect(url).toContain('X-Amz-Expires=600')
  })
})

describe('createS3Storage', () => {
  it('returns null without a bucket or credentials, so the server still starts', async () => {
    const vault = await createVault({ backend: 'memory' })
    expect(await createS3Storage(vault, undefined)).toBeNull()
    expect(await createS3Storage(vault, { bucket: 'assets' })).toBeNull()
    await vault.set('S3_ACCESS_KEY_ID', 'ak')
    await vault.set('S3_SECRET_ACCESS_KEY', 'sk')
    const s3 = await createS3Storage(vault, { bucket: 'assets' })
    expect(s3?.id).toBe('s3')
  })
})
