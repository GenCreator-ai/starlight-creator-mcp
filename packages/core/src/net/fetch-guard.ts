import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Agent } from 'undici'

export interface FetchPolicy {
  allowHosts: string[]
  allowPrivateHosts?: boolean
  maxBytes?: number
  timeoutMs?: number
}

export class FetchGuardError extends Error {
  constructor(message: string, public readonly code: 'host_not_allowed' | 'private_host' | 'too_large' | 'timeout' | 'bad_scheme' | 'redirect_blocked' | 'http_error') {
    super(message)
  }
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function isPrivateIPv6(ip: string): boolean {
  let low = ip.toLowerCase()
  try { low = new URL(`http://[${low}]`).hostname.slice(1, -1) } catch { /* Scoped link-local addresses are handled by their prefix. */ }
  // Deny the entire compatible/mapped range, including normalized IPv4 tails.
  return low.startsWith('::') || low.startsWith('fc') || low.startsWith('fd') || /^fe[89ab]/.test(low) || low.startsWith('ff')
}

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v = isIP(h)
  if (v === 4) return isPrivateIPv4(h)
  if (v === 6) return isPrivateIPv6(h)
  return false
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase()
  return allow.some(a => {
    const pat = a.toLowerCase()
    if (pat.startsWith('*.')) return h === pat.slice(2) || h.endsWith(pat.slice(1))
    return h === pat
  })
}

async function assertResolvesPublic(host: string): Promise<void> {
  if (isIP(host)) {
    if (isPrivateHost(host)) throw new FetchGuardError(`refusing private address ${host}`, 'private_host')
    return
  }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new FetchGuardError('hostname resolution failed', 'host_not_allowed') })
  if (!addrs.length) throw new FetchGuardError('hostname has no resolved addresses', 'host_not_allowed')
  for (const a of addrs) if (isPrivateHost(a.address)) throw new FetchGuardError(`${host} resolves to private address ${a.address}`, 'private_host')
}

export async function assertUrlAllowed(url: URL, policy: FetchPolicy): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchGuardError(`scheme ${url.protocol} not allowed`, 'bad_scheme')
  const host = url.hostname
  if (!policy.allowPrivateHosts) {
    if (isPrivateHost(host)) throw new FetchGuardError(`refusing private host ${host}`, 'private_host')
    if (!hostAllowed(host, policy.allowHosts)) throw new FetchGuardError(`host ${host} is not in the allowlist (${policy.allowHosts.join(', ') || 'empty'})`, 'host_not_allowed')
    await assertResolvesPublic(host)
  } else if (!isPrivateHost(host) && !hostAllowed(host, policy.allowHosts)) {
    throw new FetchGuardError(`host ${host} is not in the allowlist`, 'host_not_allowed')
  }
}

export async function guardedFetch(input: string | URL, init: RequestInit & { policy: FetchPolicy }): Promise<Response> {
  const { policy, ...rest } = init
  let url = new URL(String(input))
  let request = { ...rest, headers: new Headers(rest.headers) }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), policy.timeoutMs ?? 60_000)
  const outerSignal = rest.signal
  const abort = () => controller.abort()
  let bodyOwnsDeadline = false
  let abortBody: () => void = () => {}
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timeout)
    outerSignal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', abortBody)
    void dispatcher.destroy().catch(() => {})
  }
  const dispatcher = new Agent({
    connect: {
      lookup(host, options, callback) {
        void withinDeadline(() => lookup(host, { all: true })).then(addresses => {
          if (!addresses.length || addresses.some(address => !isIP(address.address))) throw new FetchGuardError('invalid connection DNS answer', 'host_not_allowed')
          if (!policy.allowPrivateHosts && addresses.some(address => isPrivateHost(address.address))) throw new FetchGuardError('connection resolves to private address', 'private_host')
          const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
          const selected = family ? addresses.filter(address => address.family === family) : addresses
          if (!selected.length) throw new FetchGuardError('connection DNS family unavailable', 'host_not_allowed')
          // Pass checked addresses directly to net.connect; no subsequent DNS lookup.
          if (options.all) callback(null, selected)
          else callback(null, selected[0]!.address, selected[0]!.family)
        }).catch(error => callback(error as Error, '', 0))
      },
    },
  })
  const withinDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted()
    let rejectAbort: () => void = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new FetchGuardError('request cancelled or timed out', 'timeout'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try { return await Promise.race([Promise.resolve().then(operation), cancelled]) }
    finally { controller.signal.removeEventListener('abort', rejectAbort) }
  }
  outerSignal?.addEventListener('abort', abort, { once: true })
  if (outerSignal?.aborted) abort()
  try {
    for (let redirects = 0; ; redirects++) {
      controller.signal.throwIfAborted()
      await withinDeadline(() => assertUrlAllowed(url, policy))
      controller.signal.throwIfAborted()
      // Node's declarations pin older undici-types; the native dispatcher API is compatible.
      const dispatchRequest = { ...request, dispatcher: dispatcher as unknown as RequestInit['dispatcher'], signal: controller.signal, redirect: 'manual' as const }
      const res = await fetch(url, dispatchRequest)
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.has('location')) {
        await withinDeadline(async () => { await res.body?.cancel() })
        if (redirects >= 20) throw new FetchGuardError('redirect limit exceeded', 'redirect_blocked')
        const next = new URL(res.headers.get('location')!, url)
        if (next.username || next.password || (url.protocol === 'https:' && next.protocol !== 'https:')) {
          throw new FetchGuardError('credential-bearing or downgraded redirect blocked', 'redirect_blocked')
        }
        await withinDeadline(() => assertUrlAllowed(next, policy)).catch(err => {
          if (controller.signal.aborted) throw err
          throw new FetchGuardError('redirect destination blocked', 'redirect_blocked')
        })
        const method = (request.method ?? 'GET').toUpperCase()
        if ((res.status === 303 && method !== 'GET' && method !== 'HEAD') || ([301, 302].includes(res.status) && method === 'POST')) {
          request = { ...request, method: 'GET', body: undefined }
          for (const header of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) request.headers.delete(header)
        }
        if (next.origin !== url.origin) {
          // Provider keys can use arbitrary header names. Never forward any caller headers.
          if (request.body != null || !['GET', 'HEAD'].includes((request.method ?? 'GET').toUpperCase())) {
            throw new FetchGuardError('cross-origin request payload blocked', 'redirect_blocked')
          }
          request = { ...request, headers: new Headers(), credentials: 'omit', referrer: '' }
        }
        url = next
        continue
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (policy.maxBytes && len > policy.maxBytes) {
        void res.body?.cancel().catch(() => {})
        throw new FetchGuardError(`response ${len} bytes exceeds limit ${policy.maxBytes}`, 'too_large')
      }
      if (!res.body) return res
      let bytes = 0
      const bounded = new TransformStream<Uint8Array, Uint8Array>({
        start(destination) {
          abortBody = () => {
            destination.error(new FetchGuardError('response body cancelled or timed out', 'timeout'))
            cleanup()
          }
          controller.signal.addEventListener('abort', abortBody, { once: true })
          if (controller.signal.aborted) abortBody()
        },
        transform(chunk, destination) {
          bytes += chunk.byteLength
          if (policy.maxBytes !== undefined && bytes > policy.maxBytes) throw new FetchGuardError('response body exceeds limit', 'too_large')
          destination.enqueue(chunk)
        },
        flush() { cleanup() },
      })
      // Keep the deadline alive through json/text/arrayBuffer and streamed reads.
      void res.body.pipeTo(bounded.writable, { signal: controller.signal }).then(cleanup, cleanup)
      bodyOwnsDeadline = true
      const response = new Response(bounded.readable, { status: res.status, statusText: res.statusText, headers: res.headers })
      Object.defineProperties(response, { url: { value: res.url }, redirected: { value: res.redirected }, type: { value: res.type } })
      return response
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new FetchGuardError(`fetch ${url.host} timed out`, 'timeout')
    if ((err as Error).cause instanceof FetchGuardError) throw (err as Error).cause
    throw err
  } finally {
    if (!bodyOwnsDeadline) cleanup()
  }
}

/** A guarded body owns its deadline timer and connection pool until read or cancelled; release it on every early return. */
export async function discardBody(res: Response): Promise<void> {
  try { await res.body?.cancel() } catch { /* Already consumed, locked, or errored bodies have released their resources. */ }
}

export async function readBodyLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) { await reader.cancel(); throw new FetchGuardError(`body exceeds ${maxBytes} bytes`, 'too_large') }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}
