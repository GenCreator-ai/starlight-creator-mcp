import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { gunzipSync } from 'node:zlib'

// Release order includes optional workspace dependencies: the bundle must never outrun them.
export const targets = [
  ['packs-spec', 'creator-packs-spec'], ['core', 'creator-core'],
  ['providers/openrouter', 'creator-provider-openrouter'], ['providers/muapi', 'creator-provider-muapi'],
  ['providers/google', 'creator-provider-google'], ['providers/elevenlabs', 'creator-provider-elevenlabs'],
  ['storage-s3', 'creator-storage-s3'], ['server', 'creator-server'], ['cli', 'creator-cli'], ['bundle', 'creator-mcp'],
].map(([directory, name]) => ({ directory: `packages/${directory}`, name: `@starlight-intelligence/${name}` }))
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')

export function pnpmInvocation(cli) {
  if (typeof cli !== 'string' || !isAbsolute(cli) || !/^pnpm(?:\.[cm]?js|\.exe)?$/.test(basename(cli))) throw new Error('Use an absolute pnpm launcher through pnpm run')
  return /\.[cm]?js$/.test(cli) ? { command: process.execPath, prefix: [cli] } : { command: cli, prefix: [] }
}

// Derived from SIS verify-npm-ecosystem.mjs (MIT), with hardening from 44346d9f; budgets fit the creator runtime.
export function readTar(bytes) {
  if (bytes.length > 2_000_000) throw new Error('Compressed archive budget exceeded')
  const tar = gunzipSync(bytes, { maxOutputLength: 8_000_000 })
  if (tar.length % 512 !== 0) throw new Error('Incomplete archive block')
  const entries = new Map()
  const seen = new Set()
  let ended = false
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid archive terminator or trailing members')
      ended = true; break
    }
    const field = (a, b) => header.subarray(a, b).toString().replace(/\0.*$/s, '')
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/')
    const type = field(156, 157)
    const path = type === '5' ? name.replace(/\/$/, '') : name
    if (!name.startsWith('package/') || path.split('/').some(p => !p || p === '..' || p === '.') || /[\\:\x00-\x1f\x7f]/.test(name)) throw new Error('Unsafe archive path')
    const octal = (a, b) => {
      const value = field(a, b).trim()
      if (!/^[0-7]+$/.test(value)) throw new Error('Invalid archive numeric field')
      const number = Number.parseInt(value, 8)
      if (!Number.isSafeInteger(number)) throw new Error('Invalid archive numeric field')
      return number
    }
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
    if (octal(148, 156) !== checksum) throw new Error('Invalid archive checksum')
    const size = octal(124, 136)
    const next = offset + 512 + Math.ceil(size / 512) * 512
    if (!Number.isSafeInteger(size) || size < 0 || next > tar.length) throw new Error('Invalid archive size')
    if (!['0', '', '5'].includes(type)) throw new Error('Archive links and extensions are denied')
    if (type === '5' && size !== 0) throw new Error('Invalid archive directory payload')
    if (seen.has(path) || seen.size >= 500) throw new Error('Duplicate or excessive archive members')
    seen.add(path)
    if (!tar.subarray(offset + 512 + size, next).every(byte => byte === 0)) throw new Error('Invalid archive padding')
    if (type !== '5') {
      entries.set(name, tar.subarray(offset + 512, offset + 512 + size))
    }
    offset = next
  }
  if (!ended) throw new Error('Truncated archive')
  return entries
}

export function validateEntries(entries, expected) {
  for (const name of entries.keys()) {
    const approved = /^package\/(?:package\.json|README\.md|LICENSE|server\.json|dist\/[\w./-]+\.(?:js|d\.ts|js\.map|d\.ts\.map))$/.test(name)
      || (expected.name.endsWith('/creator-server') && /^package\/packs\/starter\/[\w./-]+\.(?:json|md)$/.test(name))
      || (expected.name.endsWith('/creator-provider-muapi') && name === 'package/data/models.json')
      || (expected.name.endsWith('/creator-server') && name === 'package/packs/starter/init/.gitignore')
    if (!approved || /(?:^|\/)(?:\.env|\.npmrc|private|_audit|credentials)(?:[./]|$)/i.test(name) || /\.(?:test|spec)\./.test(name)) throw new Error('Unapproved archive member')
  }
  const pkg = JSON.parse(entries.get('package/package.json')?.toString() ?? 'null')
  if (!pkg || pkg.name !== expected.name || pkg.version !== expected.version || pkg.private || pkg.license !== 'MIT') throw new Error('Package identity or license mismatch')
  if (pkg.publishConfig?.registry && pkg.publishConfig.registry !== 'https://registry.npmjs.org') throw new Error('Unexpected publication registry')
  if (!entries.has('package/README.md') || !entries.has('package/LICENSE')) throw new Error('Usage documentation and license required')
  const paths = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(paths) : []
  for (const target of [...paths(pkg.exports), ...paths(pkg.bin), pkg.main, pkg.types].filter(Boolean)) {
    if (!entries.has('package/' + target.replace(/^\.\//, ''))) throw new Error('Advertised entry missing')
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const range of Object.values(pkg[field] ?? {})) {
      if (typeof range !== 'string' || /^(?:workspace:|file:|link:)/.test(range)) throw new Error('Unresolved local dependency')
    }
  }
  if (['preinstall', 'install', 'postinstall'].some(name => pkg.scripts?.[name])) throw new Error('Unexpected package install lifecycle')
  if (pkg.name.endsWith('/creator-server') && !entries.has('package/packs/starter/pack.json')) throw new Error('Bundled starter pack missing')
  if (pkg.name.endsWith('/creator-mcp')) {
    const registration = JSON.parse(entries.get('package/server.json')?.toString() ?? 'null')
    if (registration?.version !== pkg.version || registration.packages?.length !== 1 || registration.packages[0].identifier !== pkg.name || registration.packages[0].version !== pkg.version) throw new Error('MCP registration identity mismatch')
  }
  return pkg
}

export function validateGraph(packages) {
  const ordered = new Map(packages.map((pkg, i) => [pkg.name, { pkg, i }]))
  if (ordered.size !== targets.length || targets.some(t => !ordered.has(t.name))) throw new Error('Release package set mismatch')
  for (const [name, { pkg, i }] of ordered) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(pkg[field] ?? {})) {
        if (!dependency.startsWith('@starlight-intelligence/creator-')) continue
        const other = ordered.get(dependency)
        if (!other || other.i >= i || range !== other.pkg.version) throw new Error('Release dependency version or order mismatch')
      }
    }
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !name.startsWith('@starlight-intelligence/')) throw new Error('Release identity invalid')
  }
}

export function validateReceipt(receipt, files, sourceSha, requireClean = true) {
  if (receipt.schemaVersion !== 1 || receipt.sourceSha !== sourceSha || (requireClean && receipt.dirty !== false) || !Array.isArray(receipt.packages) || receipt.packages.length !== targets.length) throw new Error('Release receipt source or cleanliness mismatch')
  const manifests = []
  const seen = new Set()
  for (const row of receipt.packages) {
    if (seen.has(row.name) || !targets.some(t => t.name === row.name) || !/^[a-z0-9.-]+\.tgz$/.test(row.file)) throw new Error('Release receipt package identity invalid')
    seen.add(row.name)
    const bytes = files.get(row.file)
    if (!bytes || digest(bytes) !== row.sha256 || integrity(bytes) !== row.integrity) throw new Error('Release artifact digest mismatch')
    manifests.push(validateEntries(readTar(bytes), row))
  }
  validateGraph(manifests)
  return manifests
}
