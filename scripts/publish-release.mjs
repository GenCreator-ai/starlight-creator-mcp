import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReceipt, digest } from './release-contract.mjs'

export function assertPublishingContext(env, sourceSha) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'frankxai/starlight-creator-mcp' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_WORKFLOW_REF !== 'frankxai/starlight-creator-mcp/.github/workflows/npm-release.yml@refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(sourceSha) || env.GITHUB_SHA !== sourceSha || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    || env.NODE_AUTH_TOKEN || env.NPM_TOKEN) throw new Error('Publication requires the main-only GitHub OIDC environment without npm tokens')
}

// Reuse the SIS release boundary: a private package root prevents parent npmrc discovery.
export function createNpmRuntime(root, npmCli, env) {
  if (!npmCli || !isAbsolute(npmCli) || basename(npmCli) !== 'npm-cli.js' || !existsSync(npmCli)) throw new Error('Pinned npm CLI required')
  const cwd = mkdtempSync(join(root, 'artifacts', 'npm-oidc-'))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'creator-oidc-release-runtime', private: true }))
  for (const file of ['.npmrc', 'user.npmrc', 'global.npmrc']) writeFileSync(join(cwd, file), '', { mode: 0o600 })
  const allowed = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CI',
    'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER', 'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_SERVER_URL', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKFLOW',
    'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_EVENT_NAME', 'GITHUB_ACTOR', 'GITHUB_ACTOR_ID', 'GITHUB_REF', 'RUNNER_ENVIRONMENT',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']
  return { command: process.execPath, prefix: [npmCli, '--userconfig=' + join(cwd, 'user.npmrc'), '--globalconfig=' + join(cwd, 'global.npmrc')],
    options: { cwd, timeout: 120_000, env: Object.fromEntries(allowed.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])) } }
}

export async function registryIntegrity(row, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (response.status === 404 || !response.ok || !response.body) {
    // Release the connection held by unread error bodies before returning or failing.
    await response.body?.cancel().catch(() => {})
    if (response.status === 404) return null
    throw new Error('Registry preflight unavailable')
  }
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_000_000) throw new Error('Registry metadata budget exceeded')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const metadata = JSON.parse(Buffer.concat(chunks).toString())
  if (metadata.name !== row.name || metadata.version !== row.version || typeof metadata.dist?.integrity !== 'string') throw new Error('Registry identity mismatch')
  return metadata.dist.integrity
}

export async function publishRelease(root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), fetchImpl = fetch, publishImpl) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assertPublishingContext(process.env, sourceSha)
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Publication source must be clean')
  const directory = join(root, 'artifacts', 'npm-release')
  const receiptBytes = readFileSync(join(directory, 'manifest.json'))
  const receipt = JSON.parse(receiptBytes)
  // Validate filenames before resolving any artifact path from the downloaded receipt.
  if (!Array.isArray(receipt.packages) || receipt.packages.some(row => !/^[a-z0-9.-]+\.tgz$/.test(row.file))) throw new Error('Invalid receipt artifact path')
  const files = new Map(receipt.packages.map(row => [row.file, readFileSync(join(directory, row.file))]))
  validateReceipt(receipt, files, sourceSha)
  const consumer = JSON.parse(readFileSync(join(directory, 'consumer.json')))
  if (consumer.status !== 'passed' || consumer.sourceSha !== sourceSha || consumer.manifestSha256 !== digest(receiptBytes)
    || !['all-ten-artifact-install', 'optional-s3-omitted-install-and-doctor', 'strict-public-declarations', 'installed-init-launch-and-isolation', 'init-existing-config-preserved', 'installed-storage-link-boundary', 'official-stdio-tool-discovery', 'unapproved-publication-denied'].every(name => consumer.checks?.includes(name))) throw new Error('Installed-consumer evidence mismatch')
  const npmCli = process.env.NPM_CLI_PATH
  if (!npmCli || !isAbsolute(npmCli) || basename(npmCli) !== 'npm-cli.js' || !existsSync(npmCli)) throw new Error('Pinned npm CLI required')
  const pending = []
  // Preflight every existing version before the first irreversible action.
  for (const row of receipt.packages) {
    const existing = await registryIntegrity(row, fetchImpl)
    if (existing && existing !== row.integrity) throw new Error('Published version conflicts with reviewed bytes')
    if (!existing) pending.push(row)
  }
  const runtime = pending.length && !publishImpl ? createNpmRuntime(root, npmCli, process.env) : null
  const publish = publishImpl ?? (row => execFileSync(runtime.command, [...runtime.prefix, 'publish', join(directory, row.file),
    '--access=public', '--provenance', '--ignore-scripts', '--registry=https://registry.npmjs.org'],
    { ...runtime.options, stdio: ['ignore', 'pipe', 'pipe'] }))
  for (const row of pending) {
    if (digest(readFileSync(join(directory, row.file))) !== row.sha256) throw new Error('Artifact changed after preflight')
    try { await publish(row) } catch { throw new Error('Publication outcome is uncertain; reconcile registry before retrying') }
    if (await registryIntegrity(row, fetchImpl) !== row.integrity) throw new Error('Publication readback mismatch; stop and reconcile')
    console.log(JSON.stringify({ name: row.name, version: row.version, integrity: row.integrity, status: 'published-and-read-back' }))
  }
  console.log(JSON.stringify({ sourceSha, reconciled: receipt.packages.length, newlyPublished: pending.length }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await publishRelease() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
