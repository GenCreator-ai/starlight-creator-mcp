#!/usr/bin/env node
// Dry-run packing in dependency order. Publication is only through npm-release.yml OIDC.
//   node scripts/release.mjs            → dry run, changes nothing
// pnpm rewrites `workspace:*` to the real version at pack time; plain `npm publish` does not.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.includes('--publish')) throw new Error('Local publication is disabled. Use the reviewed main-only npm-release.yml OIDC workflow.')
const skipChecks = process.argv.includes('--skip-checks')

// dependency order: nothing may be published before what it depends on
const ORDER = [
  'packages/packs-spec',
  'packages/core',
  'packages/providers/openrouter',
  'packages/providers/muapi',
  'packages/providers/google',
  'packages/providers/elevenlabs',
  'packages/storage-s3',
  'packages/server',
  'packages/cli',
  'packages/bundle',
]

const isWin = process.platform === 'win32'
// On Windows, pnpm/npm/npx are .cmd shims; execFileSync needs a shell to launch them.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  cwd: root, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit',
  ...(isWin && /\.cmd$|^npx$/.test(cmd) ? { shell: true } : {}), ...opts,
})
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm'
const npm = isWin ? 'npm.cmd' : 'npm'

const pkg = dir => JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'))

console.log('RELEASE DRY RUN — publication requires the reviewed main-only npm-release.yml OIDC workflow\n')

// 2. versions must agree across the workspace
const versions = new Map(ORDER.map(d => [pkg(d).name, pkg(d).version]))
const distinct = new Set(versions.values())
if (distinct.size > 1) console.warn(`! packages are on ${distinct.size} different versions: ${[...versions].map(([n, v]) => `${n}@${v}`).join(', ')}`)

// 3. gates
if (!skipChecks) {
  console.log('› build');   run(pnpm, ['-r', '--filter', './packages/**', 'run', 'build'])
  console.log('› lint');    run('npx', ['eslint', '.'])
  console.log('› test');    run('npx', ['vitest', 'run'])
}

// 5. publish in order, skipping versions already on the registry
for (const dir of ORDER) {
  const { name, version } = pkg(dir)
  let onRegistry = false
  try {
    const published = run(npm, ['view', `${name}@${version}`, 'version'], { capture: true, stdio: 'pipe' }).trim()
    onRegistry = published === version
  } catch { /* 404 = not published, which is what we want */ }
  if (onRegistry) { console.log(`  = ${name}@${version} already on npm, skipping`); continue }
  const args = ['publish', '--no-git-checks', '--dry-run']
  console.log(`  · ${name}@${version}`)
  run(pnpm, args, { cwd: path.join(root, dir) })
}

console.log('\n✓ dry run clean. For publication use the reviewed main-only npm-release.yml OIDC workflow with fresh source-bound artifact and consumer evidence.')
