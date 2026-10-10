import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReceipt, targets, digest } from './release-contract.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'artifacts', 'npm-release')
// Clear prior success before even manifest parsing, artifact checks or installation can fail.
writeFileSync(join(releaseDir, 'consumer.json'), JSON.stringify({ schemaVersion: 1, status: 'failed', checks: [] }) + '\n')
const receiptBytes = readFileSync(join(releaseDir, 'manifest.json'))
const receipt = JSON.parse(receiptBytes)
if (!Array.isArray(receipt.packages) || receipt.packages.some(row => !/^[a-z0-9.-]+\.tgz$/.test(row.file))) throw new Error('Invalid receipt artifact path')
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const files = new Map(receipt.packages.map(row => [row.file, readFileSync(join(releaseDir, row.file))]))
validateReceipt(receipt, files, sourceSha, false)

const consumer = join(root, 'artifacts', 'consumer-' + randomUUID())
mkdirSync(consumer, { recursive: true })
const dependencies = Object.fromEntries(receipt.packages.map(row => [row.name, 'file:' + join(releaseDir, row.file).replace(/\\/g, '/')]))
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'creator-release-consumer', version: '0.0.0', private: true, type: 'module', dependencies,
  devDependencies: { '@modelcontextprotocol/client': '2.3.1', '@types/node': '22.20.1', typescript: '5.9.3' } }, null, 2))
const npmCli = process.env.NPM_CLI_PATH ?? resolve(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')
if (!existsSync(npmCli)) throw new Error('Set NPM_CLI_PATH to the installed npm CLI')
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
env.CREATOR_MCP_HOME = join(consumer, 'home')
env.CREATOR_VAULT_BACKEND = 'encrypted-file'
const run = (args, timeout = 120_000) => execFileSync(process.execPath, args, { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout })
let check = 'install'
try {
  run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=20000', '--registry=https://registry.npmjs.org'], 300_000)
  check = 'optional-s3'
  const localOnly = join(consumer, 'local-only')
  mkdirSync(localOnly)
  const localDependencies = Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== '@starlight-intelligence/creator-storage-s3'))
  writeFileSync(join(localOnly, 'package.json'), JSON.stringify({ name: 'creator-local-only-consumer', version: '0.0.0', private: true, type: 'module', dependencies: localDependencies }))
  execFileSync(process.execPath, [npmCli, 'install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=20000', '--registry=https://registry.npmjs.org'], { cwd: localOnly, env, stdio: 'pipe', timeout: 300_000 })
  if (existsSync(join(localOnly, 'node_modules', '@starlight-intelligence', 'creator-storage-s3')) || existsSync(join(localOnly, 'node_modules', '@aws-sdk', 'client-s3'))) throw new Error('Local-only installation still requires S3')
  const localCli = join(localOnly, 'node_modules', '@starlight-intelligence', 'creator-mcp', 'dist', 'main.js')
  if (!run([localCli, 'doctor']).includes('OK')) throw new Error('Local-only doctor failed without S3')
  writeFileSync(join(env.CREATOR_MCP_HOME, 'config.json'), JSON.stringify({ storage: { s3: { bucket: 'missing-optional-fixture' } } }))
  let diagnosedMissing = false
  try { run([localCli, 'doctor']) } catch (err) {
    diagnosedMissing = String(err.stdout).includes('optional creator-storage-s3 is not installed')
  } finally { writeFileSync(join(env.CREATOR_MCP_HOME, 'config.json'), '{}') }
  if (!diagnosedMissing) throw new Error('Missing optional S3 was not precisely diagnosed')
  check = 'declarations'
  const imports = targets.map((t, i) => `import * as p${i} from '${t.name}';\nexport const surface${i} = p${i};`).join('\n')
  writeFileSync(join(consumer, 'types.ts'), imports)
  run([join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', 'types.ts'])
  const bundleCli = join(consumer, 'node_modules', '@starlight-intelligence', 'creator-mcp', 'dist', 'main.js')
  check = 'setup'
  const setup = run([bundleCli, 'setup', '--print'])
  if (!setup.includes('@starlight-intelligence/creator-mcp')) throw new Error('Installed setup advertises the wrong package')
  check = 'doctor'
  const doctor = run([bundleCli, 'doctor'])
  if (!doctor.includes('OK') || !doctor.includes('starter@')) throw new Error('Installed doctor or starter pack failed')
  check = 'packs'
  const packs = run([bundleCli, 'packs'])
  if (!packs.includes('starter')) throw new Error('Installed pack discovery failed')
  check = 'init'
  const workspace = join(consumer, 'workspace')
  run([bundleCli, 'init', workspace, 'Release consumer'])
  const initialized = JSON.parse(readFileSync(join(workspace, '.mcp.json')))
  const launch = initialized.mcpServers.creator
  if (launch.command !== process.execPath || launch.args[0] !== bundleCli || launch.env?.CREATOR_MCP_HOME !== join(workspace, '.creator-mcp')) throw new Error('Initialized workspace cannot launch the installed package in isolation')
  const config = JSON.parse(readFileSync(join(workspace, '.creator-mcp', 'config.json')))
  if (config.storage.assetsDir !== join(workspace, 'assets')) throw new Error('Initialized assets escape the workspace')
  const existing = JSON.stringify({ mcpServers: { 'user-owned': { command: 'existing-fixture' } } })
  writeFileSync(join(workspace, '.mcp.json'), existing)
  run([bundleCli, 'init', workspace, 'Second init'])
  if (readFileSync(join(workspace, '.mcp.json'), 'utf8') !== existing) throw new Error('Init overwrote an existing client configuration')
  check = 'storage-boundary'
  writeFileSync(join(consumer, 'storage.mjs'), `
import assert from 'node:assert/strict';
import { mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalStorage, assertRealInside, SandboxError } from '@starlight-intelligence/creator-core';
const root=path.resolve('storage-fixture'); const outside=path.resolve('outside-fixture');
await mkdir(root); await mkdir(outside);
await symlink(outside,path.join(root,'aa'),process.platform==='win32'?'junction':'dir');
const sha='a'.repeat(64);const storage=new LocalStorage(root);
await assert.rejects(storage.put(sha,Buffer.from('fixture'),{mime:'image/png',ext:'png'}),SandboxError);
await assert.rejects(storage.writeSidecar(sha,{fixture:true}),SandboxError);
await assert.rejects(readFile(path.join(outside,sha+'.png')),error=>error.code==='ENOENT');
await assert.rejects(readFile(path.join(outside,sha+'.provenance.json')),error=>error.code==='ENOENT');
await writeFile(path.join(outside,sha+'.png'),'external fixture');
assert.equal(await storage.get(sha,'png'),null);assert.equal(await storage.exists(sha,'png'),false);
await assert.rejects(assertRealInside(root,path.join(root,'aa','missing','asset.png')),SandboxError);
const valid='b'.repeat(64);await storage.put(valid,Buffer.from('valid'),{mime:'image/png',ext:'png'});
assert.equal(Buffer.from(await storage.get(valid,'png')).toString(),'valid');
`)
  run(['storage.mjs'])
  check = 'protocol'
  writeFileSync(join(consumer, 'protocol.mjs'), `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const transport = new StdioClientTransport({ command: ${JSON.stringify(launch.command)}, args: ${JSON.stringify(launch.args)}, env: ${JSON.stringify({ ...env, ...launch.env })}, stderr: 'pipe' });
const client = new Client({name:'installed-release-consumer',version:'0.0.0'});
try {
 await client.connect(transport);
 const tools = await client.listTools();
 assert.equal(tools.tools.length,16);
 assert.ok(tools.tools.some(t=>t.name==='creator_publication_prepare'));
 const info = await client.callTool({name:'creator_pack_info',arguments:{}});
 assert.notEqual(info.isError,true);
 const prepared = await client.callTool({name:'creator_publication_prepare',arguments:{posts:[{channel_id:'outbox',text:'Local release acceptance fixture.'}]}});
 assert.notEqual(prepared.isError,true);
 assert.equal(prepared.structuredContent.manifest.status,'prepared');
 const denied = await client.callTool({name:'creator_publish',arguments:{manifest_id:prepared.structuredContent.manifest_id,adapter:'local'}});
 assert.equal(denied.isError,true);
} finally { await client.close(); await transport.close(); }
`)
  run(['protocol.mjs'])
  const evidence = { schemaVersion: 1, sourceSha, manifestSha256: digest(receiptBytes), status: 'passed',
    checks: ['all-ten-artifact-install', 'optional-s3-omitted-install-and-doctor', 'strict-public-declarations', 'installed-setup-identity', 'doctor-without-provider-keys', 'bundled-starter-discovery', 'installed-init-launch-and-isolation', 'init-existing-config-preserved', 'installed-storage-link-boundary', 'official-stdio-tool-discovery', 'unapproved-publication-denied'] }
  writeFileSync(join(releaseDir, 'consumer.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} catch {
  console.error(`Installed consumer failed at ${check}; inspect its isolated files privately`)
  process.exitCode = 1
}
