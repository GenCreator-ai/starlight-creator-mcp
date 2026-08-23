import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { assetRelPath, SECRET_NAMES, type StorageConnector, type StoredObject, type Vault } from '@starlight-intelligence/creator-core'

export interface S3StorageOptions {
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string
  publicDomain?: string
  forcePathStyle?: boolean
  accessKeyId: string
  secretAccessKey: string
  presignTtlSeconds?: number
}

/** Content-addressed S3/R2 storage. Keys mirror the local layout: <prefix>/<ab>/<sha>.<ext> */
export class S3Storage implements StorageConnector {
  readonly id = 's3'
  private readonly client: S3Client
  private readonly prefix: string

  constructor(private readonly o: S3StorageOptions) {
    this.prefix = (o.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.client = new S3Client({
      region: o.region ?? 'auto',
      ...(o.endpoint ? { endpoint: o.endpoint } : {}),
      forcePathStyle: o.forcePathStyle ?? true,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    })
  }

  key(sha256: string, ext: string): string {
    const rel = assetRelPath(sha256, ext).replace(/\\/g, '/')
    return this.prefix ? `${this.prefix}/${rel}` : rel
  }

  async put(sha256: string, bytes: Uint8Array, meta: { mime: string; ext: string }): Promise<StoredObject> {
    const Key = this.key(sha256, meta.ext)
    await this.client.send(new PutObjectCommand({
      Bucket: this.o.bucket, Key, Body: bytes, ContentType: meta.mime,
      // content-addressed: the body can never change for a given key
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { sha256 },
    }))
    return { uri: `s3://${this.o.bucket}/${Key}`, connector: this.id }
  }

  async get(sha256: string, ext: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.key(sha256, ext) }))
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
      return body?.transformToByteArray ? await body.transformToByteArray() : null
    } catch { return null }
  }

  async exists(sha256: string, ext: string): Promise<boolean> {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: this.key(sha256, ext) })); return true } catch { return false }
  }

  /** A public domain gives a stable URL; otherwise a presigned GET so publishing still works on a private bucket. */
  async publicUrl(sha256: string, ext: string): Promise<string | null> {
    const Key = this.key(sha256, ext)
    if (this.o.publicDomain) return `${this.o.publicDomain.replace(/\/+$/, '')}/${Key}`
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.o.bucket, Key }), { expiresIn: this.o.presignTtlSeconds ?? 7 * 24 * 3600 })
    } catch { return null }
  }

  async presignUpload(sha256: string, ext: string, mime: string, ttlSeconds = 900): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.o.bucket, Key: this.key(sha256, ext), ContentType: mime }), { expiresIn: ttlSeconds })
  }

  async stat(): Promise<{ ok: boolean; detail: string }> {
    try {
      // HEAD on a key that will not exist still proves credentials and bucket reachability
      await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: this.key('0'.repeat(64), 'probe') }))
      return { ok: true, detail: `${this.o.bucket} reachable` }
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      const status = e.$metadata?.httpStatusCode
      if (status === 404 || e.name === 'NotFound') return { ok: true, detail: `${this.o.bucket} reachable${this.o.endpoint ? ` at ${this.o.endpoint}` : ''}` }
      if (status === 403) return { ok: false, detail: `${this.o.bucket}: credentials rejected (403)` }
      return { ok: false, detail: `${this.o.bucket}: ${e.name ?? (err as Error).message}` }
    }
  }
}

export interface S3Config {
  bucket: string
  endpoint?: string
  region?: string
  prefix?: string
  publicDomain?: string
  forcePathStyle?: boolean
}

/** Returns null when the bucket or credentials are not configured, so the server starts without S3. */
export async function createS3Storage(vault: Vault, cfg: S3Config | undefined): Promise<S3Storage | null> {
  if (!cfg?.bucket) return null
  const accessKeyId = await vault.resolve(SECRET_NAMES.s3AccessKeyId)
  const secretAccessKey = await vault.resolve(SECRET_NAMES.s3SecretAccessKey)
  if (!accessKeyId || !secretAccessKey) return null
  return new S3Storage({ ...cfg, accessKeyId, secretAccessKey })
}
