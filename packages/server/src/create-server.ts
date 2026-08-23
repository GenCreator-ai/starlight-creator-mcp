import { McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { CreatorContext, type CreatorContextOptions, type Provider, type Vault } from '@starlight-intelligence/creator-core'
import { errorResult } from './errors.js'
import { registerPrompts } from './prompts.js'
import { registerResources } from './resources.js'
import type { AnyToolDef } from './tool-def.js'
import { defaultStorageConnectors } from './defaults.js'
import { assets, assetSync, models, score } from './tools/assets.js'
import { loadCompositeTools } from './tools/composite.js'
import { generateAudio, generateImage, generateVideo, jobStatus, transcribe } from './tools/generate.js'
import { licenseStatus, packInfo } from './tools/pack.js'
import { metricsIngest, metricsQuery, publicationApprove, publicationPrepare, publish } from './tools/publish.js'

export const SUBSTRATE_TOOLS: AnyToolDef[] = [models, generateImage, generateVideo, generateAudio, transcribe, jobStatus, score, assets, assetSync, packInfo, publicationPrepare, publicationApprove, publish, metricsIngest, metricsQuery, licenseStatus]

export interface ToolCuration {
  alias?: Record<string, string>
  hide?: string[]
  defaults?: Record<string, Record<string, unknown>>
}

export interface CreatorServerOptions {
  name: string
  version: string
  packs: string[]
  providers: (vault: Vault) => Provider[] | Promise<Provider[]>
  storageConnectors?: CreatorContextOptions['storageConnectors']
  packsByBenefit?: Record<string, string[]>
  tools?: ToolCuration
  brandTools?: AnyToolDef[]
  context?: CreatorContext
  dev?: boolean
  instructions?: string
}

export interface CreatorServer { server: McpServer; ctx: CreatorContext; toolNames: string[] }

export async function createCreatorServer(opts: CreatorServerOptions): Promise<CreatorServer> {
  const ctx = opts.context ?? (await CreatorContext.create({ packs: opts.packs, providers: opts.providers, storageConnectors: opts.storageConnectors ?? defaultStorageConnectors, ...(opts.packsByBenefit ? { packsByBenefit: opts.packsByBenefit } : {}), ...(opts.dev !== undefined ? { dev: opts.dev } : {}) }))
  const server = new McpServer({ name: opts.name, version: opts.version }, { instructions: opts.instructions ?? defaultInstructions(ctx) })
  const curation = opts.tools ?? {}
  const hidden = new Set(curation.hide ?? [])
  const base = SUBSTRATE_TOOLS.filter(t => !hidden.has(t.name))
  const composite = await loadCompositeTools(ctx, SUBSTRATE_TOOLS)
  const all = [...base, ...(opts.brandTools ?? []), ...composite]
  const names: string[] = []
  for (const def of all) {
    const name = curation.alias?.[def.name] ?? def.name
    const defaults = curation.defaults?.[def.name]
    names.push(name)
    server.registerTool(name, { title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations }, async (args: Record<string, unknown>, mcp: ServerContext) => {
      try {
        const merged = defaults ? { ...defaults, ...args } : args
        const parsed = def.inputSchema.parse(merged)
        return await def.handler(parsed, ctx, mcp)
      } catch (err) {
        return errorResult(err)
      }
    })
  }
  registerResources(server, ctx)
  await registerPrompts(server, ctx)
  return { server, ctx, toolNames: names }
}

function defaultInstructions(ctx: CreatorContext): string {
  const packs = ctx.merged.packs.map(p => `${p.id}@${p.version}`).join(', ') || 'none'
  return [
    `Creator substrate server. Loaded packs: ${packs}. All generation runs on the user's own provider keys; assets are stored locally with provenance sidecars.`,
    'Workflow: creator_models (ids) → creator_generate_* (job) → creator_job_status (poll) → creator_score (taste) → creator_publication_prepare → creator_publication_approve (human confirm code) → creator_publish.',
    'Before writing brand content, search canon with creator_pack_info section=canon. Never invent numbers: declare them as numerical claims with evidence assets or they are blocked at prepare time.',
  ].join('\n')
}
