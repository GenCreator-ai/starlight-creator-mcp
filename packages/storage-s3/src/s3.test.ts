import { afterEach, describe, expect, it, vi } from 'vitest'
import { createS3Storage, S3Storage } from './index.js'
import { configSchema, createVault } from '@starlight-intelligence/creator-core'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'

const SHA = 'a'.repeat(64)

function storage(overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) {
  return new S3Storage({ bucket: 'assets', region: 'us-east-1', accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret', ...overrides })
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
    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders')?.split(';')
    expect(signed).toContain('x-amz-checksum-sha256')
    expect(signed).toContain('content-type')
    expect(new URL(url).searchParams.has('x-amz-checksum-sha256')).toBe(false)
    expect(await storage().presignUpload('b'.repeat(64), 'png', 'image/png', 600)).not.toBe(url)
  })
})

describe('createS3Storage', () => {
  it('returns null only without a bucket; missing credentials are diagnosable', async () => {
    const vault = await createVault({ backend: 'memory' })
    expect(await createS3Storage(vault, undefined)).toBeNull()
    await expect(createS3Storage(vault, { bucket: 'assets' })).rejects.toThrow('credentials are missing')
    await vault.set('S3_ACCESS_KEY_ID', 'ak')
    await vault.set('S3_SECRET_ACCESS_KEY', 'sk')
    const s3 = await createS3Storage(vault, { bucket: 'assets' })
    expect(s3?.id).toBe('s3')
  })

  describe('native AWS region resolution', () => {
    afterEach(() => vi.unstubAllEnvs())
    it('does not insert auto into AWS config and uses the SDK region chain', async () => {
      vi.stubEnv('AWS_REGION', 'eu-west-1')
      const cfg = configSchema.parse({ storage: { s3: { bucket: 'assets' } } })
      expect(cfg.storage.s3?.region).toBeUndefined()
      const url = await storage({ region: undefined }).presignUpload(SHA, 'png', 'image/png')
      expect(new URL(url).searchParams.get('X-Amz-Credential')).toContain('/eu-west-1/s3/aws4_request')
    })
  })

  describe('real SDK HTTP failure and recovery fixtures', () => {
    let server: Server | undefined
    afterEach(async () => {
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
      server = undefined
    })
    async function fixture(handler: Parameters<typeof createServer>[0], maxBytes = 16) {
      server = createServer(handler)
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      return storage({
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        fetchPolicy: { allowHosts: [], allowPrivateHosts: true, maxBytes, timeoutMs: 100 },
      })
    }
    const bytes = Buffer.from('asset fixture')
    const hash = createHash('sha256').update(bytes).digest('hex')

    it('streams authentic bytes, validates upload checksum, and recovers after a missing object', async () => {
      let missing = true
      const s = await fixture((req, res) => {
        if (req.method === 'PUT') {
          expect(req.headers['x-amz-checksum-sha256']).toBe(Buffer.from(hash, 'hex').toString('base64'))
          expect(req.headers.authorization).toContain('SignedHeaders=')
          req.resume(); req.on('end', () => { missing = false; res.end() })
        } else if (missing) { res.statusCode = 404; res.end() }
        else { res.write(bytes.subarray(0, 3)); res.end(bytes.subarray(3)) }
      })
      expect(await s.get(hash, 'bin')).toBeNull()
      await s.put(hash, bytes, { mime: 'application/octet-stream', ext: 'bin' })
      expect(await s.get(hash, 'bin')).toEqual(bytes)
      await expect(s.put(SHA, bytes, { mime: 'application/octet-stream', ext: 'bin' })).rejects.toThrow('checksum mismatch')
    })

    it('does not equate least-privilege 403 with rejected credentials or send write probes', async () => {
      const methods: string[] = []
      const s = await fixture((req, res) => { methods.push(req.method!); res.statusCode = 403; res.end() })
      expect(await s.stat()).toMatchObject({ ok: false, detail: expect.stringContaining('access indeterminate') })
      expect(methods).toEqual(['HEAD'])
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })
      await expect(s.exists(hash, 'bin')).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })
    })

    it('rejects announced and chunked over-budget objects', async () => {
      let announced = true
      const s = await fixture((_req, res) => {
        if (announced) res.setHeader('content-length', '30')
        res.write(Buffer.alloc(10)); res.end(Buffer.alloc(20))
      })
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ code: 'too_large' })
      announced = false
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ code: 'too_large' })
    })

    it('rejects corrupt bytes and server errors instead of pretending the object is absent', async () => {
      let status = 200
      const s = await fixture((_req, res) => { res.statusCode = status; res.end('wrong') })
      await expect(s.get(hash, 'bin')).rejects.toThrow('checksum mismatch')
      status = 500
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ $metadata: { httpStatusCode: 500 } })
    })

    it('bounds stalled response bodies', async () => {
      const s = await fixture((_req, res) => { res.write('a') })
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ code: 'timeout' })
    })

    it('cancels active and pre-cancelled downloads', async () => {
      let calls = 0
      const s = await fixture((_req, res) => { calls++; res.write('a') })
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(s.get(hash, 'bin', cancelled.signal)).rejects.toMatchObject({ code: 'timeout' })
      expect(calls).toBe(0)
      const active = new AbortController()
      const result = s.get(hash, 'bin', active.signal)
      setTimeout(() => active.abort(), 30)
      await expect(result).rejects.toMatchObject({ code: 'timeout' })
    })

    it('rechecks redirect hosts without forwarding signed requests to unlisted destinations', async () => {
      const s = await fixture((_req, res) => { res.statusCode = 307; res.setHeader('location', 'https://unlisted.invalid/object'); res.end() })
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ code: 'redirect_blocked' })
    })

    it('blocks configurable private endpoints without enabling the test override', async () => {
      const s = storage({ endpoint: 'http://127.0.0.1:1', fetchPolicy: { allowHosts: ['127.0.0.1'] } })
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ code: 'private_host' })
      const denied = storage({ endpoint: 'https://unlisted.invalid' })
      await expect(denied.get(hash, 'bin')).rejects.toMatchObject({ code: 'host_not_allowed' })
    })
  })
})
