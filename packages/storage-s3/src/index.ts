import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { assetRelPath, guardedFetch, SECRET_NAMES, type FetchPolicy, type StorageConnector, type StoredObject, type Vault } from '@starlight-intelligence/creator-core'

export interface S3StorageOptions {
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string
  publicDomain?: string
  forcePathStyle?: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  presignTtlSeconds?: number
  fetchPolicy?: FetchPolicy
}

/** Content-addressed S3/R2 storage. Keys mirror the local layout: <prefix>/<ab>/<sha>.<ext> */
export class S3Storage implements StorageConnector {
  readonly id = 's3'
  private readonly client: S3Client
  private readonly prefix: string
  private readonly maxBytes: number

  constructor(private readonly o: S3StorageOptions) {
    const prefix = o.prefix ?? ''
    let start = 0
    let end = prefix.length
    while (start < end && prefix[start] === '/') start++
    while (end > start && prefix[end - 1] === '/') end--
    this.prefix = prefix.slice(start, end)
    if (this.prefix.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('S3 prefix contains dot segments; use literal folder names')
    this.maxBytes = o.fetchPolicy?.maxBytes ?? 200 * 1024 * 1024
    const policy: FetchPolicy = { ...o.fetchPolicy, allowHosts: o.fetchPolicy?.allowHosts ?? [], maxBytes: this.maxBytes }
    this.client = new S3Client({
      ...(o.region ? { region: o.region } : o.endpoint ? { region: 'auto' } : {}),
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      forcePathStyle: o.forcePathStyle ?? true,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey,
        ...(o.sessionToken ? { sessionToken: o.sessionToken } : {}) },
      maxAttempts: 1,
      // Fetch rejects Expect: 100-continue; Expect is never part of the SigV4 signature.
      expectContinueHeader: false,
      requestHandler: {
        async handle(request: {
          protocol: string; hostname: string; port?: number; path: string; method: string
          headers: Record<string, string>; query?: Record<string, string | string[] | null>; body?: Uint8Array
        }, options: { abortSignal?: AbortSignal } = {}) {
          const url = new URL(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}`)
          for (const [name, value] of Object.entries(request.query ?? {})) {
            for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(name, v ?? '')
          }
          const response = await guardedFetch(url, {
            method: request.method, headers: fetchHeaders(request.headers, request.body),
            body: request.body as RequestInit['body'], signal: options.abortSignal, policy,
          })
          return { response: {
            statusCode: response.status, headers: Object.fromEntries(response.headers),
            body: response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>) : Readable.from([]),
          } }
        },
      },
    })
  }

  key(sha256: string, ext: string): string {
    const rel = assetRelPath(sha256, ext).replace(/\\/g, '/')
    return this.prefix ? `${this.prefix}/${rel}` : rel
  }

  async put(sha256: string, bytes: Uint8Array, meta: { mime: string; ext: string }): Promise<StoredObject> {
    const Key = this.key(sha256, meta.ext)
    if (bytes.byteLength > this.maxBytes) throw new Error('S3 upload exceeds asset byte limit')
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('S3 upload checksum mismatch')
    await this.client.send(new PutObjectCommand({
      Bucket: this.o.bucket, Key, Body: bytes, ContentType: meta.mime,
      // content-addressed: the body can never change for a given key
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { sha256 },
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    }))
    return { uri: `s3://${this.o.bucket}/${Key}`, connector: this.id }
  }

  async get(sha256: string, ext: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.key(sha256, ext) }), { abortSignal: signal })
      const body = res.Body as Readable | undefined
      if (!body) throw new Error('S3 returned no object body')
      try {
        if (res.ContentLength !== undefined && res.ContentLength > this.maxBytes) throw new Error('S3 download exceeds asset byte limit')
        const chunks: Uint8Array[] = []
        let total = 0
        for await (const chunk of body) {
          const bytes = Buffer.from(chunk)
          total += bytes.byteLength
          if (total > this.maxBytes) throw new Error('S3 download exceeds asset byte limit')
          chunks.push(bytes)
        }
        const bytes = Buffer.concat(chunks, total)
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('S3 download checksum mismatch')
        return bytes
      } finally { body.destroy() }
    } catch (err) {
      if (await this.isMissingObject(err, signal)) return null
      throw err
    }
  }

  async exists(sha256: string, ext: string): Promise<boolean> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: this.key(sha256, ext) })); return true } catch (err) {
      if (await this.isMissingObject(err)) return false
      throw err
    }
  }

  private async isMissingObject(err: unknown, signal?: AbortSignal): Promise<boolean> {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (e.name === 'NoSuchKey') return true
    if (e.name && e.name !== 'NotFound' && e.name !== 'Error' && e.name !== '404') return false
    if (e.$metadata?.httpStatusCode !== 404) return false
    // Bodyless HEAD 404s do not identify whether the object or its bucket is absent.
    // Preserve configuration/permission errors from this read-only bucket check.
    await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket }), { abortSignal: signal })
    return true
  }

  /** A public domain gives a stable URL; otherwise a presigned GET so publishing still works on a private bucket. */
  async publicUrl(sha256: string, ext: string): Promise<string | null> {
    const Key = this.key(sha256, ext)
    if (this.o.publicDomain) return `${this.o.publicDomain.replace(/\/+$/, '')}/${Key.split('/').map(encodeURIComponent).join('/')}`
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.o.bucket, Key }), { expiresIn: this.o.presignTtlSeconds ?? 7 * 24 * 3600 })
    } catch { return null }
  }

  async presignUpload(sha256: string, ext: string, mime: string, ttlSeconds = 900): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.o.bucket, Key: this.key(sha256, ext), ContentType: mime,
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
    }), { expiresIn: ttlSeconds, unhoistableHeaders: new Set(['x-amz-checksum-sha256']), signableHeaders: new Set(['content-type']) })
  }

  async stat(): Promise<{ ok: boolean; detail: string }> {
    try {
      // HEAD responses carry no error body, so a missing bucket and a missing probe key both look like 404.
      // HeadBucket is read-only (s3:ListBucket) and proves the bucket exists before the object probe.
      await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket }))
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      const status = e.$metadata?.httpStatusCode
      if (status === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') return { ok: false, detail: `${this.o.bucket}: bucket not found${this.o.endpoint ? ` at ${this.o.endpoint}` : ''}` }
      if (status === 403) return { ok: false, detail: `${this.o.bucket}: access indeterminate (403); HeadBucket requires s3:ListBucket. Verify bucket permissions and credentials; no write probe was performed.` }
      return { ok: false, detail: `${this.o.bucket}: ${e.name ?? (err as Error).message}` }
    }
    try {
      // A missing-key HEAD cannot distinguish denied access from missing ListBucket permission.
      await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: this.key('0'.repeat(64), 'probe') }))
      return { ok: true, detail: `${this.o.bucket} reachable` }
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      const status = e.$metadata?.httpStatusCode
      if (status === 404 || e.name === 'NotFound') return { ok: true, detail: `${this.o.bucket} reachable${this.o.endpoint ? ` at ${this.o.endpoint}` : ''}` }
      if (status === 403) return { ok: false, detail: `${this.o.bucket}: access indeterminate (403); missing-key HEAD may require ListBucket. Verify GetObject/PutObject permissions and credentials; no write probe was performed.` }
      return { ok: false, detail: `${this.o.bucket}: ${e.name ?? (err as Error).message}` }
    }
  }
}

/**
 * Fetch derives Content-Length from the buffered body and rejects caller-supplied
 * Content-Length/Expect. The signed Content-Length must equal the bytes fetch sends,
 * so only buffered bodies are accepted and any mismatch fails closed.
 */
function fetchHeaders(headers: Record<string, string>, body: unknown): Headers {
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('S3 request body must be buffered')
  const length = body == null ? 0 : typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  const out = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'expect' || lower === 'transfer-encoding') continue
    if (lower === 'content-length') {
      if (!/^\d+$/.test(value) || Number(value) !== length) throw new Error('S3 signed content-length does not match request body')
      continue
    }
    out.set(name, value)
  }
  return out
}

export interface S3Config {
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string
  publicDomain?: string
  forcePathStyle?: boolean
}

/** Returns null for unconfigured S3; explicit configuration requires credentials. */
export async function createS3Storage(vault: Vault, cfg: S3Config | undefined, fetchPolicy?: FetchPolicy): Promise<S3Storage | null> {
  if (!cfg?.bucket) return null
  const accessKeyId = await vault.resolve(SECRET_NAMES.s3AccessKeyId)
  const secretAccessKey = await vault.resolve(SECRET_NAMES.s3SecretAccessKey)
  const sessionToken = await vault.resolve(SECRET_NAMES.s3SessionToken)
  if (!accessKeyId || !secretAccessKey) throw new Error('S3 bucket configured but S3 credentials are missing; run creator-mcp setup --storage')
  return new S3Storage({ ...cfg, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}), fetchPolicy })
}
