import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { targets, pnpmInvocation, readTar, validateEntries, validateGraph, digest, integrity } from './release-contract.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function verifyRelease() {
  const launcher = pnpmInvocation(process.env.npm_execpath)
  const out = join(root, 'artifacts', 'npm-release')
  mkdirSync(out, { recursive: true })
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  const packages = [], manifests = []
  for (const target of targets) {
    const cwd = join(root, target.directory)
    const source = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    if (source.name !== target.name) throw new Error('Source package identity mismatch')
    const file = source.name.replace('@', '').replace('/', '-') + '-' + source.version + '.tgz'
    execFileSync(launcher.command, [...launcher.prefix, 'pack', '--out', join(out, file)], { cwd, stdio: 'pipe', timeout: 60_000,
      env: { ...process.env, npm_config_ignore_scripts: 'true' } })
    const bytes = readFileSync(join(out, file))
    const entries = readTar(bytes)
    manifests.push(validateEntries(entries, source))
    try {
      execFileSync('gitleaks', ['stdin', '--redact', '--no-banner'], { cwd: root, input: Buffer.concat([...entries.values()].flatMap(bytes => [bytes, Buffer.from('\n')])), stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 })
    } catch { throw new Error('Release secret scan failed; inspect redacted findings privately') }
    packages.push({ name: source.name, version: source.version, file, sha256: digest(bytes), integrity: integrity(bytes), compressedBytes: bytes.length, memberCount: entries.size })
  }
  validateGraph(manifests)
  const receipt = { schemaVersion: 1, sourceSha, dirty, packages }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyRelease() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
