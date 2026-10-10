import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import { resolve, join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { targets, readTar, validateEntries, validateGraph, validateReceipt, digest, integrity, pnpmInvocation } from '../release-contract.mjs'
import { assertPublishingContext, registryIntegrity, createNpmRuntime } from '../publish-release.mjs'

function archive(entries, type = '0') {
  const blocks = []
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100); header.write('0000644\0', 100)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
function entries(pkg) {
  const result = new Map([
    ['package/package.json', Buffer.from(JSON.stringify(pkg))], ['package/dist/index.js', Buffer.from('export const fixture = true;')],
    ['package/dist/index.d.ts', Buffer.from('export declare const fixture: boolean;')], ['package/LICENSE', Buffer.from('MIT fixture')], ['package/README.md', Buffer.from('fixture usage')],
  ])
  if (pkg.name.endsWith('/creator-server')) result.set('package/packs/starter/pack.json', Buffer.from('{}'))
  if (pkg.name.endsWith('/creator-mcp')) result.set('package/server.json', Buffer.from(JSON.stringify({ version: pkg.version, packages: [{ identifier: pkg.name, version: pkg.version }] })))
  return result
}
const manifest = name => ({ name, version: '0.1.0', license: 'MIT', main: './dist/index.js', types: './dist/index.d.ts' })

test('archive parser rejects traversal, links, missing terminator, duplicate members and checksum corruption', () => {
  const item = [['package/../private', Buffer.from('fixture')]]
  assert.throws(() => readTar(archive(item)), /Unsafe/)
  assert.throws(() => readTar(archive([['package/link', Buffer.from('fixture')]], '2')), /denied/)
  assert.throws(() => readTar(archive([['package/a', Buffer.from('one')], ['package/a', Buffer.from('two')]])), /Duplicate/)
  assert.throws(() => readTar(gzipSync(Buffer.alloc(512, 65))), /Unsafe|checksum/)
  assert.throws(() => readTar(gzipSync(Buffer.alloc(0))), /Truncated/)
})

test('archive parser rejects partial terminators, concealed members, incomplete blocks and dirty padding', () => {
  const raw = gunzipSync(archive([['package/fixture', Buffer.from('fixture')]]))
  assert.throws(() => readTar(gzipSync(raw.subarray(0, -512))))
  assert.throws(() => readTar(gzipSync(Buffer.concat([raw, raw]))))
  assert.throws(() => readTar(gzipSync(raw.subarray(0, -1))))
  const padding = Buffer.from(raw); padding[519] = 1
  assert.throws(() => readTar(gzipSync(padding)))
})

test('archive parser rejects ambiguous paths, malformed octal and directory payloads', () => {
  for (const name of ['package//file', 'package/./file', 'package/a:b', 'package/a\u007fb']) {
    assert.throws(() => readTar(archive([[name, Buffer.from('fixture')]])))
  }
  const raw = gunzipSync(archive([['package/fixture', Buffer.from('fixture')]]))
  raw.write('0000000001x\0', 124); raw.fill(32, 148, 156)
  raw.write(raw.subarray(0, 512).reduce((n, byte) => n + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  assert.throws(() => readTar(gzipSync(raw)))
  assert.throws(() => readTar(archive([['package/folder/', Buffer.from('payload')]], '5')))
})

test('packed entrypoints, declaration files, local dependency protocols and install scripts fail closed', () => {
  const pkg = manifest(targets[0].name)
  const valid = entries(pkg)
  assert.equal(validateEntries(valid, pkg).name, pkg.name)
  valid.delete('package/dist/index.d.ts')
  assert.throws(() => validateEntries(valid, pkg), /entry missing/)
  for (const range of ['workspace:*', 'file:../private', 'link:../private']) {
    const local = { ...pkg, dependencies: { missing: range } }
    assert.throws(() => validateEntries(entries(local), local), /local dependency/)
  }
  const scripted = { ...pkg, scripts: { postinstall: 'fixture-command' } }
  assert.throws(() => validateEntries(entries(scripted), scripted), /install lifecycle/)
})

test('packaging rejects state, test fixtures, absent license and stale MCP registration', () => {
  const pkg = manifest(targets[9].name)
  for (const path of ['package/.env', 'package/dist/private/key.js', 'package/dist/sample.test.js']) {
    const files = entries(pkg); files.set(path, Buffer.from('fixture'))
    assert.throws(() => validateEntries(files, pkg), /Unapproved/)
  }
  const missingLicense = entries(pkg); missingLicense.delete('package/LICENSE')
  assert.throws(() => validateEntries(missingLicense, pkg), /license required/)
  const stale = entries(pkg); stale.set('package/server.json', Buffer.from('{"version":"9.0.0"}'))
  assert.throws(() => validateEntries(stale, pkg), /registration identity/)
})

test('all runtime and optional workspace dependencies must belong to the ordered version set', () => {
  const packages = targets.map(t => manifest(t.name))
  packages[9].dependencies = { [packages[8].name]: '0.1.0' }
  packages[7].optionalDependencies = { [packages[6].name]: '0.1.0' }
  validateGraph(packages)
  assert.throws(() => validateGraph(packages.slice(1)), /package set/)
  assert.throws(() => validateGraph([...packages].reverse()), /version or order/)
  packages[7].optionalDependencies[packages[6].name] = '0.9.0'
  assert.throws(() => validateGraph(packages), /version or order/)
})

test('receipt validation binds actual bytes, identity, source revision and clean publication state', () => {
  const files = new Map()
  const packages = targets.map((t, i) => {
    const pkg = manifest(t.name), bytes = archive(entries(pkg)), file = `fixture-${i}.tgz`
    files.set(file, bytes)
    return { ...pkg, file, sha256: digest(bytes), integrity: integrity(bytes) }
  })
  const receipt = { schemaVersion: 1, sourceSha: 'fixture-sha', dirty: false, packages }
  assert.equal(validateReceipt(receipt, files, 'fixture-sha').length, 10)
  assert.throws(() => validateReceipt(receipt, files, 'other-sha'), /source or cleanliness/)
  assert.throws(() => validateReceipt({ ...receipt, dirty: true }, files, 'fixture-sha'), /source or cleanliness/)
  assert.throws(() => validateReceipt({ ...receipt, packages: [...packages.slice(1), packages[1]] }, files, 'fixture-sha'), /identity invalid/)
  files.set(packages[0].file, Buffer.from('changed artifact'))
  assert.throws(() => validateReceipt(receipt, files, 'fixture-sha'), /digest mismatch/)
})

test('pnpm launchers support native and JavaScript paths without accepting shell shims', () => {
  assert.equal(pnpmInvocation(resolve('pnpm.cjs')).command, process.execPath)
  assert.equal(pnpmInvocation(resolve('pnpm.exe')).prefix.length, 0)
  for (const path of ['pnpm', resolve('pnpm.cmd'), resolve('arbitrary.js')]) assert.throws(() => pnpmInvocation(path), /absolute pnpm launcher/)
})

test('publication rejects local contexts, other repositories, branches and token fallback', () => {
  const sha = 'a'.repeat(40)
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'frankxai/starlight-creator-mcp', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'frankxai/starlight-creator-mcp/.github/workflows/npm-release.yml@refs/heads/main',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request' }
  assertPublishingContext(env, sha)
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'untrusted/repo' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'b'.repeat(40) }, { NODE_AUTH_TOKEN: 'fixture' }, { NPM_TOKEN: 'fixture' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }]) {
    assert.throws(() => assertPublishingContext({ ...env, ...patch }, sha), /main-only/)
  }
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: 'frankxai/starlight-creator-mcp/.github/workflows/ci.yml@refs/heads/main' }]) {
    assert.throws(() => assertPublishingContext({ ...env, ...patch }, sha), /main-only/)
  }
})

test('publisher isolates project/user/global npm configs and sensitive environment while preserving provenance metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'creator-npm-config-'))
  try {
    mkdirSync(join(root, 'artifacts'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture-parent","private":true}')
    writeFileSync(join(root, '.npmrc'), 'registry=https://fixture.invalid/\n')
    const empty = join(root, 'empty.npmrc')
    const emptyGlobal = join(root, 'empty-global.npmrc')
    writeFileSync(empty, '')
    writeFileSync(emptyGlobal, '')
    const npmCli = process.env.NPM_CLI_PATH ?? join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules' : '../lib/node_modules', 'npm/bin/npm-cli.js')
    const platform = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    // Empty user/global configs alone leave the parent project config active.
    const inherited = execFileSync(process.execPath, [npmCli, '--userconfig=' + empty, '--globalconfig=' + emptyGlobal, 'config', 'get', 'registry'],
      { cwd: root, env: platform, encoding: 'utf8', timeout: 15_000 }).trim()
    assert.equal(inherited, 'https://fixture.invalid/')
    const provenance = { GITHUB_REPOSITORY_OWNER_ID: 'fixture-owner', GITHUB_REF: 'refs/heads/main', RUNNER_ENVIRONMENT: 'github-hosted',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.invalid/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request' }
    const runtime = createNpmRuntime(root, npmCli, { ...platform, ...provenance, NODE_OPTIONS: '--require=fixture-must-not-load', NODE_PATH: root,
      npm_config_registry: 'https://environment.invalid/', NPM_CONFIG_USERCONFIG: empty, NPM_TOKEN: 'fixture-token', NODE_AUTH_TOKEN: 'fixture-token',
      GITHUB_TOKEN: 'fixture-token', OPENROUTER_API_KEY: 'fixture-provider' })
    for (const [key, value] of Object.entries(provenance)) assert.equal(runtime.options.env[key], value)
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_USERCONFIG', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']) {
      assert.equal(runtime.options.env[key], undefined)
    }
    assert.equal(execFileSync(runtime.command, [...runtime.prefix, 'config', 'get', 'registry'],
      { ...runtime.options, encoding: 'utf8' }).trim(), 'https://registry.npmjs.org/')
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('registry recovery distinguishes missing versions from errors and rejects identity substitution', async () => {
  const row = { name: targets[0].name, version: '0.1.0' }
  assert.equal(await registryIntegrity(row, async () => new Response('', { status: 404 })), null)
  await assert.rejects(registryIntegrity(row, async () => new Response('', { status: 503 })), /unavailable/)
  await assert.rejects(registryIntegrity(row, async () => new Response(JSON.stringify({ ...row, name: 'substituted', dist: { integrity: 'fixture' } }))), /identity mismatch/)
  let request
  assert.equal(await registryIntegrity(row, async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ ...row, dist: { integrity: 'fixture-integrity' } }))
  }), 'fixture-integrity')
  assert.equal(new URL(request.url).origin, 'https://registry.npmjs.org')
  assert.equal(request.options.redirect, 'error')
})

test('registry 404 and failure responses release their unread bodies', async () => {
  const row = { name: targets[0].name, version: '0.1.0' }
  for (const status of [404, 403, 503]) {
    let cancelled = 0
    const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled++ } })
    const outcome = registryIntegrity(row, async () => new Response(body, { status }))
    if (status === 404) assert.equal(await outcome, null)
    else await assert.rejects(outcome, /unavailable/)
    assert.equal(cancelled, 1, `status ${status}`)
  }
})

test('a failed consumer rerun invalidates previous success before malformed manifest parsing', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'creator-consumer-denial-'))
  try {
    writeFileSync(join(fixture, 'consumer.json'), JSON.stringify({ status: 'passed', checks: ['previous-success'] }))
    writeFileSync(join(fixture, 'manifest.json'), 'malformed-json')
    // Run the actual consumer entry with only its artifact directory and import location relocated.
    const source = readFileSync(new URL('../test-consumer.mjs', import.meta.url), 'utf8')
    const declaration = "const releaseDir = join(root, 'artifacts', 'npm-release')"
    assert.ok(source.includes(declaration))
    const relocated = source.replace(declaration, 'const releaseDir = ' + JSON.stringify(fixture))
      .replace("'./release-contract.mjs'", JSON.stringify(new URL('../release-contract.mjs', import.meta.url).href))
    const entry = join(fixture, 'consumer-fixture.mjs')
    writeFileSync(entry, relocated)
    assert.throws(() => execFileSync(process.execPath, [entry], { timeout: 10_000, stdio: 'pipe' }))
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, 'consumer.json'))), { schemaVersion: 1, status: 'failed', checks: [] })
  } finally {
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()))
    rmSync(fixture, { recursive: true, force: true })
  }
})
