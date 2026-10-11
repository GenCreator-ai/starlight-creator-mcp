import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { clientLaunch, runCli } from './run.js'

const terminal = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }))
vi.mock('node:readline/promises', () => ({ createInterface: () => terminal }))

describe('stable CLI initialization and doctor', () => {
  let dir: string | undefined
  let server: Server | undefined
  const entry = process.argv[1]
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  afterEach(async () => {
    process.argv[1] = entry!
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    terminal.question.mockReset(); terminal.close.mockReset()
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty)
    else Reflect.deleteProperty(process.stdin, 'isTTY')
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    server = undefined
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })
  it.each([
    { answer: 'fixture-session', expected: 'fixture-session' },
    { answer: '', expected: 'fixture-existing' },
    { answer: '-', expected: null },
  ])('setup persists session-token answer "$answer" through the real vault', async ({ answer, expected }) => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-setup-sts-'))
    vi.stubEnv('CREATOR_MCP_HOME', dir)
    vi.stubEnv('CREATOR_VAULT_BACKEND', 'encrypted-file')
    vi.stubEnv('CREATOR_VAULT_KEY', '')
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
    const { createVault, SECRET_NAMES } = await import('@starlight-intelligence/creator-core')
    await (await createVault({ backend: 'encrypted-file', env: {} })).set(SECRET_NAMES.s3SessionToken, 'fixture-existing')
    terminal.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('S3/R2 bucket')) return 'fixture-bucket'
      if (prompt.startsWith('S3 access key id')) return 'fixture-access'
      if (prompt.startsWith('S3 secret access key')) return 'fixture-secret'
      if (prompt.startsWith('S3 session token')) return answer
      return ''
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0' }, ['setup', '--storage'])).toBe(0)
    const vault = await createVault({ backend: 'encrypted-file', env: {} })
    expect(await vault.get(SECRET_NAMES.s3SessionToken)).toBe(expected)
    expect(terminal.close).toHaveBeenCalledOnce()
  })
  it('approves an unchanged S3-backed asset after its local cache is removed', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-approve-s3-'))
    for (const [name, value] of Object.entries({ CREATOR_MCP_HOME: dir, CREATOR_VAULT_BACKEND: 'encrypted-file', CREATOR_VAULT_KEY: '', CREATOR_LICENSE_KEY: '', ARCANEA_LICENSE_KEY: '', CREATOR_MANIFEST_SIGNING_KEY: '', POSTIZ_API_URL: '', CREATOR_ALLOW_PRIVATE_HOSTS: '1', S3_ACCESS_KEY_ID: 'fixture-access', S3_SECRET_ACCESS_KEY: 'fixture-secret', S3_SESSION_TOKEN: '' })) vi.stubEnv(name, value)
    let stored: Buffer | undefined
    const methods: string[] = []
    server = createServer((req, res) => {
      methods.push(req.method!)
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => { stored = Buffer.concat(chunks); res.end() })
      } else if (stored) res.end(stored)
      else { res.statusCode = 404; res.end() }
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const { writeFile, unlink } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ storage: { s3: { bucket: 'assets', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, region: 'us-east-1' } }, policy: { allowHosts: ['127.0.0.1'], allowPrivateHosts: true } }))
    const { CreatorContext } = await import('@starlight-intelligence/creator-core')
    const { defaultStorageConnectors } = await import('@starlight-intelligence/creator-server')
    const ctx = await CreatorContext.create({ packs: [], providers: () => [], storageConnectors: defaultStorageConnectors })
    let id: string
    try {
      const row = await ctx.assets.ingest({ bytes: Buffer.from('approval fixture asset'), mime: 'text/plain', provenance: { task: 'import' } })
      await ctx.assets.sync(row.sha256, 's3')
      id = (await ctx.publish.prepare({ posts: [{ channel_id: 'local', text: 'Fixture publication', assets: [row.sha256] }], claims: [] }, ctx.merged)).manifest.id
      await unlink(row.localPath!)
    } finally { await ctx.close() }
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
    terminal.question.mockImplementation(async (prompt: string) => /confirm code \(([a-f0-9]{8})\)/.exec(prompt)?.[1] ?? '')
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0', packs: [], providers: () => [] }, ['approve', id!])).toBe(0)
    expect(methods).toEqual(['PUT', 'GET'])
    const restored = await CreatorContext.create({ packs: [], providers: () => [] })
    try { expect(restored.publish.get(id!)?.status).toBe('approved') } finally { await restored.close() }
  })
  it('pins npx init to the bundle version rather than its disposable cache path', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-'))
    process.argv[1] = path.join(dir, '_npx', 'cache', 'node_modules', 'creator-mcp', 'dist', 'main.js')
    const brand = { brand: 'starlight-creator-mcp', version: '0.1.1', npmPackage: '@starlight-intelligence/creator-mcp' }
    expect(await runCli(brand, ['init', dir])).toBe(0)
    const cfg = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'))
    expect(cfg.mcpServers.creator).toMatchObject({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', '@starlight-intelligence/creator-mcp@0.1.1', 'stdio'],
      env: { CREATOR_MCP_HOME: path.join(dir, '.creator-mcp') },
    })
    process.argv[1] = path.join(dir, 'installed', 'main.js')
    expect(clientLaunch(brand)).toEqual({ command: process.execPath, args: [process.argv[1]] })
  })
  it('rejects missing registry wrapper identity and preserves an explicit wrapper package', () => {
    process.argv[1] = path.join(tmpdir(), '_npx', 'fixture', 'node_modules', 'wrapper', 'main.js')
    expect(() => clientLaunch({ brand: 'custom-wrapper', version: '2.3.4' })).toThrow('must declare npmPackage')
    expect(clientLaunch({ brand: 'custom-wrapper', version: '2.3.4', npmPackage: '@fixture/custom-wrapper' }).args)
      .toEqual(['--yes', '@fixture/custom-wrapper@2.3.4', 'stdio'])
  })
  it('rejects a linked workspace state directory before writing anything', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-link-'))
    const workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside')
    await mkdir(workspace); await mkdir(outside)
    await symlink(outside, path.join(workspace, '.creator-mcp'), process.platform === 'win32' ? 'junction' : 'dir')
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0' }, ['init', workspace])).toBe(1)
    expect(errors.mock.calls.flat().join('')).toContain('must be a real directory')
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(workspace)).toEqual(['.creator-mcp'])
  })
  it('rejects a file in place of the workspace state directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-file-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, '.creator-mcp'), 'not a directory')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0' }, ['init', dir])).toBe(1)
    expect(await readdir(dir)).toEqual(['.creator-mcp'])
  })
  it('rejects a linked asset root before copying templates or writing configuration', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-assets-link-'))
    const workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside')
    await mkdir(workspace); await mkdir(outside)
    await symlink(outside, path.join(workspace, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0' }, ['init', workspace])).toBe(1)
    expect(errors.mock.calls.flat().join('')).toContain('must be a real directory')
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(workspace)).toEqual(['assets'])
  })
  it('rejects linked template input before copying any files', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-source-link-'))
    const templates = path.join(dir, 'templates'), workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside')
    await mkdir(templates); await mkdir(workspace); await mkdir(outside)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(templates, 'a.txt'), 'ordinary')
    await writeFile(path.join(outside, 'private.txt'), 'private fixture')
    await symlink(outside, path.join(templates, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0', initTemplates: templates }, ['init', workspace])).toBe(1)
    expect(await readdir(workspace)).toEqual([])
  })
  it.skipIf(process.platform === 'win32')('rejects a symlinked source file without copying its contents', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-source-file-'))
    const templates = path.join(dir, 'templates'), workspace = path.join(dir, 'workspace')
    await mkdir(templates); await mkdir(workspace)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'private.txt'), 'private fixture')
    await symlink(path.join(dir, 'private.txt'), path.join(templates, 'private.txt'))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0', initTemplates: templates }, ['init', workspace])).toBe(1)
    expect(await readdir(workspace)).toEqual([])
  })
  it('rejects outward nested destination links before creating child directories', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-init-target-link-'))
    const templates = path.join(dir, 'templates'), workspace = path.join(dir, 'workspace'), outside = path.join(dir, 'outside')
    await mkdir(path.join(templates, 'notes/deep'), { recursive: true }); await mkdir(workspace); await mkdir(outside)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(templates, 'notes/deep/new.txt'), 'ordinary')
    await symlink(outside, path.join(workspace, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0', initTemplates: templates }, ['init', workspace])).toBe(1)
    expect(await readdir(outside)).toEqual([])
  })
  it('doctor fails on explicitly configured S3 with missing credentials', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'creator-doctor-'))
    vi.stubEnv('CREATOR_MCP_HOME', dir)
    vi.stubEnv('CREATOR_VAULT_BACKEND', 'memory')
    vi.stubEnv('S3_ACCESS_KEY_ID', '')
    vi.stubEnv('S3_SECRET_ACCESS_KEY', '')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ storage: { s3: { bucket: 'fixture' } } }))
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    expect(await runCli({ brand: 'fixture', version: '0.1.0', providers: () => [] }, ['doctor'])).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('S3 credentials are missing')
  })
})
