import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as z from 'zod/v4'

export const configSchema = z.object({
  packs: z.array(z.string()).default([]),
  storage: z.object({
    connector: z.enum(['local', 's3', 'rclone']).default('local'),
    assetsDir: z.string().optional(),
    s3: z.object({ bucket: z.string(), endpoint: z.string().optional(), region: z.string().optional(), prefix: z.string().default(''), publicDomain: z.string().optional(), forcePathStyle: z.boolean().default(true) }).optional(),
    rclone: z.object({ remote: z.string(), prefix: z.string().default('') }).optional(),
    autoSync: z.array(z.string()).default([]),
  }).default({ connector: 'local', autoSync: [] }),
  policy: z.object({
    autoScore: z.boolean().default(false),
    allowHosts: z.array(z.string()).default([]),
    allowPrivateHosts: z.boolean().default(false),
    maxWaitMs: z.number().int().min(0).max(20_000).default(20_000),
    maxAssetBytes: z.number().int().positive().default(200 * 1024 * 1024),
  }).default({ autoScore: false, allowHosts: [], allowPrivateHosts: false, maxWaitMs: 20_000, maxAssetBytes: 200 * 1024 * 1024 }),
  providers: z.object({ enabled: z.array(z.string()).default([]), judge: z.string().optional() }).default({ enabled: [] }),
  postiz: z.object({ apiUrl: z.string().optional() }).default({}),
})

export type CreatorConfig = z.infer<typeof configSchema>

export function creatorHome(): string {
  return process.env.CREATOR_MCP_HOME ?? path.join(os.homedir(), '.creator-mcp')
}

export function configPath(): string { return path.join(creatorHome(), 'config.json') }

export async function loadConfig(): Promise<CreatorConfig> {
  let raw: unknown = {}
  try { raw = JSON.parse(await readFile(configPath(), 'utf8')) } catch { /* first run */ }
  const cfg = configSchema.parse(raw)
  if (process.env.CREATOR_ALLOW_PRIVATE_HOSTS === '1') cfg.policy.allowPrivateHosts = true
  if (process.env.CREATOR_ALLOW_HOSTS) cfg.policy.allowHosts.push(...process.env.CREATOR_ALLOW_HOSTS.split(',').map(s => s.trim()).filter(Boolean))
  if (process.env.POSTIZ_API_URL) cfg.postiz.apiUrl = process.env.POSTIZ_API_URL
  return cfg
}

export async function saveConfig(cfg: CreatorConfig): Promise<void> {
  await mkdir(creatorHome(), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(cfg, null, 2)}\n`)
}

export function assetsDir(cfg: CreatorConfig): string {
  return cfg.storage.assetsDir ?? path.join(creatorHome(), 'assets')
}
