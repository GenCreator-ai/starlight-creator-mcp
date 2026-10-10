import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clientLaunch, runCli } from './run.js'

describe('stable CLI initialization and doctor', () => {
  let dir: string | undefined
  const entry = process.argv[1]
  afterEach(async () => {
    process.argv[1] = entry!
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
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
