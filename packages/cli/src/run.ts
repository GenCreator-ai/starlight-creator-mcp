import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import {
  CreatorContext, SECRET_NAMES, creatorHome, createVault, loadConfig, saveConfig, resolveInside, sqliteAvailable, type Provider, type Vault,
} from '@starlight-intelligence/creator-core'
import { validatePackDir } from '@starlight-intelligence/creator-packs-spec'
import { createCreatorServer, defaultProviders, packsFromEnv, serveCreatorHttp, STARTER_PACK, type AnyToolDef, type ToolCuration } from '@starlight-intelligence/creator-server'

export interface CliBrand {
  brand: string
  version: string
  packs?: string[]
  providers?: (vault: Vault) => Provider[] | Promise<Provider[]>
  tools?: ToolCuration
  brandTools?: AnyToolDef[]
  packsByBenefit?: Record<string, string[]>
  initTemplates?: string
  npmPackage?: string
}

const SECRETS: Array<{ name: string; label: string; hint: string }> = [
  { name: SECRET_NAMES.openrouter, label: 'OpenRouter API key', hint: 'openrouter.ai/keys — one key for text, images, video, audio' },
  { name: SECRET_NAMES.muapi, label: 'MuAPI key', hint: 'muapi.ai — 226 aggregated image/video models (optional)' },
  { name: SECRET_NAMES.fal, label: 'fal key', hint: 'fal.ai (optional)' },
  { name: SECRET_NAMES.elevenlabs, label: 'ElevenLabs key', hint: 'elevenlabs.io (optional, voice)' },
  { name: SECRET_NAMES.gemini, label: 'Gemini key', hint: 'aistudio.google.com (optional; OpenRouter can judge instead)' },
  { name: SECRET_NAMES.postiz, label: 'Postiz API key', hint: 'your own Postiz instance → Settings → API (optional)' },
  { name: SECRET_NAMES.license, label: 'Pack license key', hint: 'from your Polar purchase (optional)' },
]

function usage(b: CliBrand): string {
  return `${b.brand} ${b.version}

  ${b.brand} stdio                 run the MCP server over stdio (what clients launch)
  ${b.brand} http [--port N]       run a localhost streamable-HTTP server (dev/LAN only)
  ${b.brand} setup [--print]       store provider keys in the OS keychain; --print shows client config
  ${b.brand} doctor                check keys, providers, packs, ledger, storage
  ${b.brand} init <dir> [name]     scaffold a creator workspace from the pack's init templates
  ${b.brand} approve <manifest>    approve a prepared publication manifest from the terminal
  ${b.brand} packs                 list loaded packs and validation status
  ${b.brand} inspect               open MCP Inspector against this server
`
}

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
function has(args: string[], name: string): boolean { return args.includes(name) }

export async function runCli(b: CliBrand, argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv
  const packs = b.packs ?? packsFromEnv()
  const providers = b.providers ?? defaultProviders
  const serverOpts = { name: b.npmPackage ?? b.brand, version: b.version, packs, providers, ...(b.tools ? { tools: b.tools } : {}), ...(b.brandTools ? { brandTools: b.brandTools } : {}), ...(b.packsByBenefit ? { packsByBenefit: b.packsByBenefit } : {}) }
  switch (cmd) {
    case undefined:
    case 'stdio': {
      const { server } = await createCreatorServer(serverOpts)
      serveStdio(() => server)
      return 0
    }
    case 'http': {
      const port = Number(flag(rest, '--port') ?? process.env.PORT ?? 8787)
      const { url } = await serveCreatorHttp(serverOpts, { port })
      process.stderr.write(`${b.brand} listening at ${url} (localhost only)\n`)
      return 0
    }
    case 'setup': return setup(b, rest)
    case 'doctor': return doctor(b, serverOpts)
    case 'init': return init(b, rest)
    case 'approve': return approve(b, serverOpts, rest)
    case 'packs': {
      for (const dir of packs) { const v = await validatePackDir(dir); process.stdout.write(`${v.ok ? 'OK  ' : 'FAIL'} ${v.manifest?.id ?? '?'}@${v.manifest?.version ?? '?'}  ${dir}\n`); for (const i of v.issues) process.stdout.write(`      ${i.level}: ${i.path}: ${i.message}\n`) }
      return 0
    }
    case 'inspect': {
      const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@modelcontextprotocol/inspector', process.execPath, process.argv[1]!, 'stdio'], { stdio: 'inherit', shell: process.platform === 'win32' })
      return new Promise(resolve => child.on('exit', code => resolve(code ?? 0)))
    }
    case '--help': case '-h': case 'help':
      process.stdout.write(usage(b)); return 0
    default:
      process.stderr.write(usage(b)); return 2
  }
}

async function setup(b: CliBrand, args: string[]): Promise<number> {
  const vault = await createVault()
  if (has(args, '--print')) {
    const pkg = b.npmPackage ?? b.brand
    const localBin = path.resolve(process.argv[1] ?? 'packages/bundle/dist/main.js')
    const name = b.brand.replace(/-mcp$/, '')
    const config = JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [localBin] } } }, null, 2)
    process.stdout.write(
      `Claude Code (local, until npm publish exists):\n  claude mcp add ${name} -s user -- ${process.execPath} ${localBin}\n\n` +
      `Cursor / Antigravity / Codex (.mcp.json or settings):\n${config}\n\n` +
      `Do not run \`npx -y ${pkg}\` until that package is on the npm registry.\n` +
      `Keys are read from the OS keychain (${vault.backend}) or from env: ${SECRETS.map(s => s.name).join(', ')}\n`,
    )
    return 0
  }
  if (!process.stdin.isTTY) { process.stderr.write('setup needs an interactive terminal; or set keys as environment variables\n'); return 2 }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write(`${b.brand} setup — keys are stored in ${vault.backend === 'keyring' ? 'your OS keychain' : `an encrypted file under ${creatorHome()}`}; never sent anywhere but the provider.\nPress Enter to skip a key, "-" to delete it.\n\n`)
  for (const s of SECRETS) {
    const existing = await vault.get(s.name)
    const answer = (await rl.question(`${s.label}${existing ? ' [stored]' : ''} (${s.hint}): `)).trim()
    if (answer === '-') { await vault.delete(s.name); process.stdout.write(`  removed ${s.name}\n`) }
    else if (answer) { await vault.set(s.name, answer); process.stdout.write(`  stored ${s.name}\n`) }
  }
  const cfg = await loadConfig()
  const postiz = (await rl.question(`Postiz API URL${cfg.postiz.apiUrl ? ` [${cfg.postiz.apiUrl}]` : ''} (your own instance, e.g. https://postiz.example.com): `)).trim()
  if (postiz) cfg.postiz.apiUrl = postiz
  if (has(args, '--storage')) {
    const bucket = (await rl.question('S3/R2 bucket name (blank to skip): ')).trim()
    if (bucket) {
      const endpoint = (await rl.question('S3 endpoint (R2: https://<account>.r2.cloudflarestorage.com): ')).trim()
      const publicDomain = (await rl.question('Public domain for objects (optional): ')).trim()
      cfg.storage.s3 = { bucket, region: 'auto', prefix: '', forcePathStyle: true, ...(endpoint ? { endpoint } : {}), ...(publicDomain ? { publicDomain } : {}) }
      cfg.storage.connector = 'local'
      const ak = (await rl.question('S3 access key id: ')).trim(); if (ak) await vault.set(SECRET_NAMES.s3AccessKeyId, ak)
      const sk = (await rl.question('S3 secret access key: ')).trim(); if (sk) await vault.set(SECRET_NAMES.s3SecretAccessKey, sk)
    }
  }
  await saveConfig(cfg)
  rl.close()
  process.stdout.write(`\nSaved. Run \`${b.brand} doctor\` to verify, and \`${b.brand} setup --print\` for client config.\n`)
  return 0
}

async function doctor(b: CliBrand, serverOpts: Parameters<typeof createCreatorServer>[0]): Promise<number> {
  const lines: string[] = []
  let ok = true
  const vault = await createVault()
  lines.push(`vault: ${vault.backend}`)
  for (const s of SECRETS) lines.push(`  ${(await vault.resolve(s.name)) ? 'set    ' : 'missing'} ${s.name}`)
  lines.push(`ledger: ${sqliteAvailable() ? 'node:sqlite' : 'jsonl fallback (node:sqlite unavailable)'} at ${creatorHome()}`)
  for (const dir of serverOpts.packs) { const v = await validatePackDir(dir); lines.push(`pack: ${v.ok ? 'ok  ' : 'FAIL'} ${v.manifest?.id ?? '?'} ${dir}`); if (!v.ok) ok = false; for (const i of v.issues.filter(i => i.level === 'error')) lines.push(`  ${i.path}: ${i.message}`) }
  try {
    const ctx = await CreatorContext.create({ packs: serverOpts.packs, providers: serverOpts.providers, ...(serverOpts.packsByBenefit ? { packsByBenefit: serverOpts.packsByBenefit } : {}) })
    for (const p of ctx.providers.all()) {
      const configured = await p.isConfigured()
      let detail = configured ? 'configured' : 'no key'
      if (configured) { try { detail = `${(await p.listModels()).length} models` } catch (err) { detail = `ERROR ${(err as Error).message}`; ok = false } }
      lines.push(`provider: ${p.id.padEnd(11)} ${detail}`)
    }
    for (const [id, c] of ctx.connectors) { const s = await c.stat(); lines.push(`storage: ${id.padEnd(8)} ${s.ok ? 'ok' : 'FAIL'} ${s.detail}`) }
    for (const [id, a] of ctx.publishAdapters) { const s = await a.stat(); lines.push(`publish: ${id.padEnd(8)} ${s.ok ? 'ok' : 'FAIL'} ${s.detail}`) }
    const rubrics = [...ctx.merged.rubrics.keys()]
    lines.push(`packs loaded: ${ctx.merged.packs.map(p => `${p.id}@${p.version}`).join(', ')} | rubrics: ${rubrics.join(', ') || 'none'} | styles: ${ctx.merged.styles.size} | prompts: ${ctx.merged.prompts.size}`)
    lines.push(`signer fingerprint: ${await ctx.signer.fingerprint()}`)
    await ctx.close()
  } catch (err) { lines.push(`context: FAIL ${(err as Error).message}`); ok = false }
  process.stdout.write(`${lines.join('\n')}\n${ok ? 'OK' : 'PROBLEMS FOUND'}\n`)
  return ok ? 0 : 1
}

async function init(b: CliBrand, args: string[]): Promise<number> {
  const dir = args[0]
  if (!dir) { process.stderr.write('usage: init <dir> [name]\n'); return 2 }
  const name = args[1] ?? path.basename(path.resolve(dir))
  const templates = b.initTemplates ?? path.join(STARTER_PACK, 'init')
  const target = path.resolve(dir)
  await mkdir(target, { recursive: true })
  let n = 0
  const walk = async (rel: string) => {
    for (const e of await readdir(path.join(templates, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) { await mkdir(resolveInside(target, r), { recursive: true }); await walk(r); continue }
      const out = resolveInside(target, r)
      try { await stat(out); process.stdout.write(`  skip ${r} (exists)\n`); continue } catch { /* new */ }
      let body = (await readFile(path.join(templates, r), 'utf8')).replace(/\{\{\s*projectName\s*\}\}/g, name).replace(/\{\{\s*brand\s*\}\}/g, b.brand)
      if (r === '.mcp.json') {
        const settings = JSON.parse(body) as { mcpServers?: Record<string, unknown> }
        if (settings.mcpServers?.creator) settings.mcpServers.creator = {
          command: process.execPath,
          args: [path.resolve(process.argv[1] ?? 'packages/bundle/dist/main.js')],
          env: { CREATOR_MCP_HOME: resolveInside(target, '.creator-mcp') },
        }
        body = JSON.stringify(settings, null, 2) + '\n'
      }
      await mkdir(path.dirname(out), { recursive: true })
      try { await writeFile(out, body, { flag: 'wx' }) }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; throw err }
      n++
    }
  }
  await walk('')
  const workspaceAssets = resolveInside(target, 'assets')
  await mkdir(workspaceAssets, { recursive: true })
  const workspaceHome = resolveInside(target, '.creator-mcp')
  await mkdir(workspaceHome, { recursive: true, mode: 0o700 })
  const workspaceConfig = resolveInside(target, '.creator-mcp/config.json')
  try { await writeFile(workspaceConfig, JSON.stringify({ storage: { assetsDir: workspaceAssets } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
  process.stdout.write(`initialised ${name} at ${target} (${n} files)\n`)
  return 0
}

async function approve(b: CliBrand, serverOpts: Parameters<typeof createCreatorServer>[0], args: string[]): Promise<number> {
  const id = args[0]
  if (!id) { process.stderr.write('usage: approve <manifest_id>\n'); return 2 }
  const ctx = await CreatorContext.create({ packs: serverOpts.packs, providers: serverOpts.providers })
  try {
    const m = ctx.publish.get(id)
    if (!m) { process.stderr.write(`manifest ${id} not found\n`); return 1 }
    process.stdout.write(`${ctx.publish.summary(m)}\n\n`)
    if (!process.stdin.isTTY) { process.stderr.write('approve needs an interactive terminal\n'); return 2 }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const code = (await rl.question(`Type the confirm code (${m.payload_hash.slice(0, 8)}) to approve, anything else to abort: `)).trim()
    rl.close()
    const r = await ctx.publish.approve(id, code, 'cli')
    process.stdout.write(r.ok ? `approved; signature ${r.manifest?.approval?.signature.slice(0, 16)}…\n` : `not approved: ${r.reason}\n`)
    return r.ok ? 0 : 1
  } finally { await ctx.close() }
}
