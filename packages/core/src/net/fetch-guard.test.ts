import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardedFetch } from './fetch-guard.js'

const policy = { allowHosts: [], allowPrivateHosts: true, timeoutMs: 1000 }
const origin = 'http://127.0.0.1:3021'
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

afterEach(() => vi.unstubAllGlobals())

describe('guarded redirect requests', () => {
  it('drops every caller header on an origin change, including custom provider keys', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect('http://127.0.0.1:3022/asset')).mockResolvedValueOnce(new Response('asset'))
    vi.stubGlobal('fetch', fetch)
    await guardedFetch(origin, { headers: { 'x-api-key': 'synthetic', Authorization: 'synthetic', Cookie: 'synthetic' }, credentials: 'include', policy })
    const request = fetch.mock.calls[1]![1] as RequestInit
    expect([...new Headers(request.headers)]).toEqual([])
    expect(request.credentials).toBe('omit')
    expect(request.referrer).toBe('')
  })

  it('preserves same-origin 307 payloads and headers without mutating the caller', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect('/next', 307)).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const headers = new Headers({ 'x-api-key': 'synthetic' })
    await guardedFetch(origin, { method: 'POST', body: 'payload', headers, policy })
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: 'payload' })
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('x-api-key')).toBe('synthetic')
    expect(headers.get('x-api-key')).toBe('synthetic')
  })

  it('turns redirected POST into GET and removes its body headers', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect('/next')).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    await guardedFetch(origin, { method: 'POST', body: 'payload', headers: { 'content-type': 'application/json' }, policy })
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'GET', body: undefined })
    expect(new Headers(fetch.mock.calls[1]![1].headers).has('content-type')).toBe(false)
  })

  it('denies cross-origin body replay before contacting the destination', async () => {
    const fetch = vi.fn().mockResolvedValue(redirect('http://127.0.0.1:3022/next', 307))
    vi.stubGlobal('fetch', fetch)
    await expect(guardedFetch(origin, { method: 'POST', body: 'private prompt', policy })).rejects.toMatchObject({ code: 'redirect_blocked' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds redirect loops and cancels each redirect body', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn().mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: '/loop' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(guardedFetch(origin, { policy })).rejects.toMatchObject({ code: 'redirect_blocked' })
    expect(fetch).toHaveBeenCalledTimes(21)
    expect(cancel).toHaveBeenCalledTimes(21)
  })

  it('denies pre-cancelled work and removes listeners after success', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const cancelled = new AbortController(); cancelled.abort()
    await expect(guardedFetch(origin, { signal: cancelled.signal, policy })).rejects.toMatchObject({ code: 'timeout' })
    expect(fetch).not.toHaveBeenCalled()
    const active = new AbortController()
    const remove = vi.spyOn(active.signal, 'removeEventListener')
    await guardedFetch(origin, { signal: active.signal, policy })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('shares one cancellation signal and timeout across redirect hops', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(redirect('/next')).mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    await expect(guardedFetch(origin, { policy: { ...policy, timeoutMs: 15 } })).rejects.toMatchObject({ code: 'timeout' })
    expect(fetch.mock.calls[0]![1].signal).toBe(fetch.mock.calls[1]![1].signal)
  })

  it('blocks HTTPS downgrade and credentials embedded in a redirect URL', async () => {
    for (const location of ['http://127.0.0.1:3021/next', 'https://user:synthetic@127.0.0.1:3021/next']) {
      const fetch = vi.fn().mockResolvedValue(redirect(location))
      vi.stubGlobal('fetch', fetch)
      await expect(guardedFetch('https://127.0.0.1:3021', { policy })).rejects.toMatchObject({ code: 'redirect_blocked' })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })
})
