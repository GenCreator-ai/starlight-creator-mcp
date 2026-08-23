#!/usr/bin/env node
// Publish the substrate to npm in dependency order.
//   node scripts/release.mjs            → dry run, changes nothing
//   node scripts/release.mjs --publish  → actually publishes (needs `npm whoami`)
// pnpm rewrites `workspace:*` to the real version at pack time; plain `npm publish` does not.
// Always publish through pnpm.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publish = process.argv.includes('--publish')
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
const fail = msg => { console.error(`\n✗ ${msg}`); process.exit(1) }

const pkg = dir => JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'))

console.log(publish ? 'RELEASE (publishing for real)\n' : 'RELEASE DRY RUN — pass --publish to actually publish\n')

// 1. the tree must be clean and on main
const status = run('git', ['status', '--porcelain'], { capture: true }).trim()
if (status && publish) fail(`working tree is dirty:\n${status}`)
const branch = run('git', ['branch', '--show-current'], { capture: true }).trim()
if (branch !== 'main' && publish) fail(`on branch ${branch}; publish from main`)

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

// 4. who is publishing
let who = null
try { who = run(npm, ['whoami'], { capture: true }).trim() } catch { /* not logged in */ }
if (publish && !who) fail('not logged in to npm. Run `npm login` (or set NPM_TOKEN in the environment) first.')
console.log(`\nnpm user: ${who ?? '(not logged in — dry run only)'}\n`)

// 5. publish in order, skipping versions already on the registry
for (const dir of ORDER) {
  const { name, version } = pkg(dir)
  let onRegistry = false
  try {
    const published = run(npm, ['view', `${name}@${version}`, 'version'], { capture: true, stdio: 'pipe' }).trim()
    onRegistry = published === version
  } catch { /* 404 = not published, which is what we want */ }
  if (onRegistry) { console.log(`  = ${name}@${version} already on npm, skipping`); continue }
  const args = ['publish', '--no-git-checks', ...(publish ? [] : ['--dry-run'])]
  console.log(`  ${publish ? '↑' : '·'} ${name}@${version}`)
  run(pnpm, args, { cwd: path.join(root, dir) })
}

console.log(publish
  ? '\n✓ published. Next: `mcp-publisher publish` in packages/bundle to list it in the MCP Registry, and tag the release.'
  : '\n✓ dry run clean. Re-run with --publish when you are logged in to npm.')
