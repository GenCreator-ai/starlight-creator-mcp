import { afterEach, describe, expect, it, vi } from 'vitest'
import { createS3Storage, S3Storage } from './index.js'
import { configSchema, createVault } from '@starlight-intelligence/creator-core'
import { createServer, type Server } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

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
  it.each(['.', '..', './media', '../media', 'media/./x', 'media/../x', '/media/../'])('rejects normalization-sensitive dot segments in prefix %s', prefix => {
    expect(() => storage({ prefix })).toThrow(/dot segments/)
  })
})

describe('public URLs', () => {
  it.each(['.hidden/..backup', 'folder.with.dots', '%2e/%2e%2e'])('preserves dot-containing names that are not relative segments: %s', async prefix => {
    const s = storage({ prefix, publicDomain: 'https://cdn.example.com/' })
    const url = new URL((await s.publicUrl(SHA, 'png'))!)
    expect(url.pathname.slice(1).split('/').map(decodeURIComponent).join('/')).toBe(s.key(SHA, 'png'))
  })
  it('encodes key segments while preserving the public-domain path and key separators', async () => {
    const s = storage({ prefix: 'media #?%/folder with space', publicDomain: 'https://cdn.example.com/base/' })
    const url = new URL((await s.publicUrl(SHA, 'png'))!)
    expect(url.hash).toBe('')
    expect(url.search).toBe('')
    expect(url.pathname).toBe(`/base/media%20%23%3F%25/folder%20with%20space/${SHA.slice(0, 2)}/${SHA}.png`)
    expect(url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')).toBe(s.key(SHA, 'png'))
  })
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
  it('includes temporary credential tokens in both presigned upload and download URLs', async () => {
    const temporary = storage({ sessionToken: 'fixture-session' })
    for (const url of [await temporary.publicUrl(SHA, 'png'), await temporary.presignUpload(SHA, 'png', 'image/png')]) {
      expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe('fixture-session')
    }
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
  it('resolves AWS session token aliases through the vault and redacts the token', async () => {
    const vault = await createVault({ backend: 'memory', env: {
      AWS_ACCESS_KEY_ID: 'fixture-access', AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_SESSION_TOKEN: 'fixture-session',
    } })
    const s3 = await createS3Storage(vault, { bucket: 'assets', region: 'us-east-1' })
    expect(new URL(await s3!.publicUrl(SHA, 'png')).searchParams.get('X-Amz-Security-Token')).toBe('fixture-session')
    expect(vault.redactor.redact('fixture-session')).not.toContain('fixture-session')
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
    async function fixture(handler: Parameters<typeof createServer>[0], maxBytes = 16, timeoutMs = 100, sessionToken?: string) {
      server = createServer(handler)
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      return storage({
        ...(sessionToken ? { sessionToken } : {}),
        endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        fetchPolicy: { allowHosts: [], allowPrivateHosts: true, maxBytes, timeoutMs },
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
        } else if (req.method === 'HEAD' && req.url!.split('?')[0] === '/assets/') { res.end() }
        else if (missing) { res.statusCode = 404; res.end() }
        else { res.write(bytes.subarray(0, 3)); res.end(bytes.subarray(3)) }
      })
      expect(await s.get(hash, 'bin')).toBeNull()
      await s.put(hash, bytes, { mime: 'application/octet-stream', ext: 'bin' })
      expect(await s.get(hash, 'bin')).toEqual(bytes)
      await expect(s.put(SHA, bytes, { mime: 'application/octet-stream', ext: 'bin' })).rejects.toThrow('checksum mismatch')
    })

    it('surfaces a named missing bucket instead of reporting a missing object', async () => {
      const s = await fixture((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/xml' })
        res.end('<Error><Code>NoSuchBucket</Code><Message>Bucket does not exist</Message></Error>')
      }, 1024, 5000)
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ name: 'NoSuchBucket' })
    })
    it('checks bucket existence before classifying a bodyless object 404', async () => {
      const requests: string[] = []
      const s = await fixture((req, res) => { requests.push(req.url!.split('?')[0]!); res.statusCode = 404; res.end() })
      await expect(s.exists(hash, 'bin')).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } })
      expect(requests).toEqual([`/assets/${s.key(hash, 'bin')}`, '/assets/'])
    })
    it('returns absence only after the bucket exists for an ambiguous HEAD 404', async () => {
      const s = await fixture((req, res) => { res.statusCode = req.url!.split('?')[0] === '/assets/' ? 200 : 404; res.end() })
      expect(await s.exists(hash, 'bin')).toBe(false)
    })
    it('preserves a named service error even when it carries HTTP 404', async () => {
      const s = await fixture((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/xml' })
        res.end('<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>')
      }, 1024, 5000)
      await expect(s.get(hash, 'bin')).rejects.toMatchObject({ name: 'AccessDenied' })
    })

    // Independent SigV4 verification of what actually arrived on the wire.
    function verifySigV4(req: IncomingMessage, body: Buffer): void {
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')
      expect(auth).not.toBeNull()
      const [, accessKey, date, region, signedHeaders, signature] = auth!
      expect(accessKey).toBe('fixture-access')
      const [rawPath, rawQuery = ''] = req.url!.split('?')
      const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      const query = rawQuery ? rawQuery.split('&').map(pair => pair.split('=').map(v => encode(decodeURIComponent(v.replace(/\+/g, ' ')))))
        .map(([k, v = '']) => `${k}=${v}`).sort().join('&') : ''
      const names = signedHeaders!.split(';')
      const headers = names.map(name => `${name}:${String(req.headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('')
      const payloadHash = String(req.headers['x-amz-content-sha256'])
      const canonical = [req.method, rawPath, query, headers, signedHeaders, payloadHash].join('\n')
      const scope = `${date}/${region}/s3/aws4_request`
      const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
      let key: Buffer = createHmac('sha256', 'AWS4fixture-secret').update(date!).digest()
      for (const part of [region!, 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest()
      expect(createHmac('sha256', key).update(toSign).digest('hex')).toBe(signature)
      expect(payloadHash).toBe(createHash('sha256').update(body).digest('hex'))
    }

    it('sends and signs temporary credentials through the actual guarded HTTP transport', async () => {
      let observed = false
      const s = await fixture((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          try {
            expect(req.headers['x-amz-security-token']).toBe('fixture-session')
            expect(req.headers.authorization).toContain('x-amz-security-token')
            verifySigV4(req, Buffer.concat(chunks)); observed = true
          } catch (error) { res.statusCode = 403; res.end(String(error)); return }
          res.end()
        })
      }, 16, 5000, 'fixture-session')
      await s.put(hash, bytes, { mime: 'application/octet-stream', ext: 'bin' })
      expect(observed).toBe(true)
    })

    it('uploads more than 2 MB through the real SDK with Fetch-valid, SigV4-verified headers', async () => {
      const large = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a)
      const largeHash = createHash('sha256').update(large).digest('hex')
      const received: Array<{ headers: IncomingMessage['headers']; length: number }> = []
      const s = await fixture((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          try {
            verifySigV4(req, body)
            received.push({ headers: req.headers, length: body.byteLength })
          } catch (error) { res.statusCode = 403; res.end(String(error)); return }
          res.end()
        })
      }, 8 * 1024 * 1024, 10_000)
      expect(await s.put(largeHash, large, { mime: 'application/octet-stream', ext: 'bin' })).toEqual({ uri: `s3://assets/${s.key(largeHash, 'bin')}`, connector: 's3' })
      expect(received).toHaveLength(1)
      const [{ headers, length }] = received as [typeof received[0]]
      expect(length).toBe(large.byteLength)
      expect(headers['content-length']).toBe(String(large.byteLength))
      expect(headers.expect).toBeUndefined()
      expect(headers.authorization).toContain('content-length;')
      expect(headers['x-amz-checksum-sha256']).toBe(Buffer.from(largeHash, 'hex').toString('base64'))
      expect(headers['x-amz-meta-sha256']).toBe(largeHash)
    })

    it('doctor fails a missing bucket instead of treating a 404 probe as reachable', async () => {
      const requests: string[] = []
      const s = await fixture((req, res) => { requests.push(`${req.method} ${req.url!.split('?')[0]}`); res.statusCode = 404; res.end() })
      expect(await s.stat()).toMatchObject({ ok: false, detail: expect.stringContaining('bucket not found') })
      expect(requests).toEqual(['HEAD /assets/'])
    })

    it('doctor accepts an existing bucket whose probe object is absent', async () => {
      const requests: string[] = []
      const s = await fixture((req, res) => {
        requests.push(`${req.method} ${req.url!.split('?')[0]}`)
        res.statusCode = req.url!.split('?')[0] === '/assets/' ? 200 : 404; res.end()
      })
      expect(await s.stat()).toMatchObject({ ok: true, detail: expect.stringContaining('reachable') })
      expect(requests).toEqual(['HEAD /assets/', `HEAD /assets/${s.key('0'.repeat(64), 'probe')}`])
    })

    it('doctor keeps a denied object probe indeterminate after the bucket exists', async () => {
      const s = await fixture((req, res) => { res.statusCode = req.url!.split('?')[0] === '/assets/' ? 200 : 403; res.end() })
      expect(await s.stat()).toMatchObject({ ok: false, detail: expect.stringContaining('access indeterminate') })
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
