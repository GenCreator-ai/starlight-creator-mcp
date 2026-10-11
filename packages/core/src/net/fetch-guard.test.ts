import { afterEach, describe, expect, it, vi } from 'vitest'
import { discardBody, guardedFetch, isPrivateHost } from './fetch-guard.js'
import { lookup } from 'node:dns/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const policy = { allowHosts: [], allowPrivateHosts: true, timeoutMs: 1000 }
const origin = 'http://127.0.0.1:3021'
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(lookup).mockReset() })

describe('guarded redirect requests', () => {
  it('rejects equivalent IPv6 private addresses and non-unicast destinations', () => {
    for (const address of ['::127.0.0.1', '::169.254.169.254', '::7f00:1', '::a9fe:a9fe', '0:0:0:0:0:0:7f00:1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', 'fe90::1', 'fea0::1', 'feb0::1', 'ff02::1', '224.0.0.1', '255.255.255.255']) {
      expect(isPrivateHost(address), address).toBe(true)
    }
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false)
  })
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
    const response = await guardedFetch(origin, { signal: active.signal, policy })
    await response.text()
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

  it('times out stalled response bodies after headers have arrived', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel }))))
    const response = await guardedFetch(origin, { policy: { ...policy, timeoutMs: 40 } })
    await expect(response.text()).rejects.toMatchObject({ code: 'timeout' })
    expect(cancel).toHaveBeenCalled()
  })

  it('honors caller cancellation during body consumption', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel }))))
    const controller = new AbortController()
    const response = await guardedFetch(origin, { signal: controller.signal, policy })
    const read = response.arrayBuffer(); controller.abort()
    await expect(read).rejects.toMatchObject({ code: 'timeout' })
    expect(cancel).toHaveBeenCalled()
  })

  it('enforces actual body size without a content-length header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"value":"large fixture"}')))
    const response = await guardedFetch(origin, { policy: { ...policy, maxBytes: 5 } })
    await expect(response.json()).rejects.toMatchObject({ code: 'too_large' })
  })

  it('times out DNS checks and never fetches after their late completion', async () => {
    let complete: (value: { address: string; family: number }[]) => void = () => {}
    vi.mocked(lookup).mockImplementation(() => new Promise(resolve => { complete = resolve }) as ReturnType<typeof lookup>)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(guardedFetch('https://fixture.invalid', { policy: { allowHosts: ['fixture.invalid'], timeoutMs: 40 } })).rejects.toMatchObject({ code: 'timeout' })
    complete([{ address: '8.8.8.8', family: 4 }])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('denies failed or empty DNS checks before fetch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.mocked(lookup).mockRejectedValueOnce(new Error('synthetic resolver failure'))
    await expect(guardedFetch('https://fixture.invalid', { policy: { allowHosts: ['fixture.invalid'] } })).rejects.toMatchObject({ code: 'host_not_allowed' })
    vi.mocked(lookup).mockResolvedValueOnce([] as never)
    await expect(guardedFetch('https://fixture.invalid', { policy: { allowHosts: ['fixture.invalid'] } })).rejects.toMatchObject({ code: 'host_not_allowed' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves normal JSON response metadata and releases its deadline', async () => {
    const source = new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' } })
    Object.defineProperty(source, 'url', { value: origin + '/result' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(source))
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener')
    const response = await guardedFetch(origin, { signal: controller.signal, policy })
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.url).toBe(origin + '/result')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ok: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('bounds an actual native-fetch body that stalls after HTTP headers', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"unfinished":')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`
      const response = await guardedFetch(url, { policy: { ...policy, timeoutMs: 150 } })
      expect(response.status).toBe(200)
      await expect(response.json()).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('releases the socket and deadline of an unread error body when discarded', async () => {
    let open = 0
    const server = createServer((request, response) => {
      open++
      request.socket.once('close', () => { open-- })
      response.writeHead(503, { 'content-type': 'application/json' })
      response.write('{"error":')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const timers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length
    try {
      const before = timers()
      const response = await guardedFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`, { policy: { ...policy, timeoutMs: 60_000 } })
      expect(response.status).toBe(503)
      expect(open).toBe(1)
      expect(timers()).toBeGreaterThan(before)
      await discardBody(response)
      await vi.waitFor(() => { expect(open).toBe(0) }, { timeout: 1000 })
      expect(timers()).toBe(before)
      await discardBody(response)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('blocks a public preflight answer that rebinds to loopback at socket lookup', async () => {
    let requests = 0
    const server = createServer((_request, response) => { requests++; response.end('must not be reached') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
    try {
      const url = `http://fixture.invalid:${(server.address() as AddressInfo).port}/fixture`
      await expect(guardedFetch(url, { policy: { allowHosts: ['fixture.invalid'], timeoutMs: 1000 } })).rejects.toMatchObject({ code: 'private_host' })
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(requests).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('connects through checked DNS addresses with the explicit private-host fixture policy', async () => {
    const server = createServer((_request, response) => response.end('{"checked":true}'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    try {
      const url = `http://fixture.invalid:${(server.address() as AddressInfo).port}/fixture`
      const response = await guardedFetch(url, { policy: { allowHosts: ['fixture.invalid'], allowPrivateHosts: true, timeoutMs: 1000 } })
      expect(await response.json()).toEqual({ checked: true })
      expect(lookup).toHaveBeenCalledTimes(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
