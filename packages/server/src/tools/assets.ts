import { readFile, stat } from 'node:fs/promises'
import * as z from 'zod/v4'
import { discardBody, guardedFetch, readBodyLimited, resolveInside, sniffMime, type AssetFilter, type Task } from '@starlight-intelligence/creator-core'
import { embedAsset, scoreOutOf, summarizeAsset, textLine } from '../content.js'
import { errorResult, toolError } from '../errors.js'
import { assetRef, assetSummary, scoreOut, task } from '../schemas.js'
import { defineTool, READ_ONLY, READ_ONLY_NET } from '../tool-def.js'

export const models = defineTool({
  name: 'creator_models',
  title: 'List models',
  description: 'List models available through the user\'s configured providers, optionally filtered by task. Returns registry ids (`<provider>/<model>`) to pass as `model` to generation tools, plus which id the pack would route to by default.',
  inputSchema: z.object({ task: task.optional(), provider: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).default(40), cursor: z.string().optional(), refresh: z.boolean().default(false) }),
  outputSchema: z.object({ models: z.array(z.object({ id: z.string(), provider: z.string(), name: z.string(), tasks: z.array(z.string()), aspect_ratios: z.array(z.string()).optional(), resolutions: z.array(z.string()).optional(), durations: z.array(z.number()).optional(), pricing: z.object({ unit: z.string(), usd: z.number() }).optional() })), counts: z.record(z.string(), z.number()), default_for_task: z.string().optional(), next_cursor: z.string().optional(), providers: z.array(z.object({ id: z.string(), configured: z.boolean() })) }),
  annotations: READ_ONLY_NET,
  async handler(a, ctx) {
    await ctx.catalog.refresh(a.refresh)
    const all = ctx.catalog.list({ ...(a.task ? { task: a.task } : {}), ...(a.provider ? { provider: a.provider } : {}), ...(a.query ? { query: a.query } : {}) })
    const start = a.cursor ? Number(a.cursor) || 0 : 0
    const page = all.slice(start, start + a.limit)
    let defaultForTask: string | undefined
    if (a.task) { try { defaultForTask = (await ctx.route(a.task as Task, 'high')).model.id } catch { /* none */ } }
    const providers = await Promise.all(ctx.providers.all().map(async p => ({ id: p.id, configured: await p.isConfigured() })))
    const result = { models: page.map(m => ({ id: m.id, provider: m.provider, name: m.name, tasks: m.tasks, ...(m.aspect_ratios ? { aspect_ratios: m.aspect_ratios } : {}), ...(m.resolutions ? { resolutions: m.resolutions } : {}), ...(m.durations ? { durations: m.durations } : {}), ...(m.pricing ? { pricing: m.pricing } : {}) })), counts: ctx.catalog.counts(), ...(defaultForTask ? { default_for_task: defaultForTask } : {}), ...(start + a.limit < all.length ? { next_cursor: String(start + a.limit) } : {}), providers }
    const summary = `${all.length} models (${Object.entries(result.counts).map(([k, v]) => `${k}:${v}`).join(' ')}); providers: ${providers.map(p => `${p.id}${p.configured ? '' : ' (no key)'}`).join(', ')}${defaultForTask ? `; default for ${a.task}: ${defaultForTask}` : ''}`
    return { content: [{ type: 'text', text: summary }, textLine({ models: result.models.map(m => m.id) })], structuredContent: result }
  },
})

export const score = defineTool({
  name: 'creator_score',
  title: 'Score with rubric',
  description: 'Score an image asset or a piece of text against a pack rubric using a vision/text judge model. Returns per-dimension scores, strengths, weaknesses and a ship decision; the score is recorded in the ledger and the asset provenance.',
  inputSchema: z.object({ asset: assetRef.optional(), text: z.string().optional(), rubric: z.string().optional().describe('rubric id; defaults to the pack default for the kind'), judge_model: z.string().optional() }),
  outputSchema: scoreOut,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(a, ctx) {
    try {
      if (!a.asset && !a.text) return toolError('pass asset or text')
      if (a.asset) {
        const row = ctx.ledger.findAsset(a.asset)
        if (!row) return toolError(`asset ${a.asset} not found`)
        if (row.kind !== 'image') return toolError(`scoring supports images and text; asset is ${row.kind}`)
        const data = await ctx.assets.bytes(row.sha256)
        if (!data) return toolError('asset bytes are not available locally')
        const rubric = ctx.scorer.rubricFor(ctx.merged, 'image', a.rubric)
        const s = await ctx.scorer.score({ kind: 'image', bytes: data.bytes, mime: data.mime, sha256: row.sha256 }, rubric, ctx.merged, a.judge_model)
        await ctx.assets.setScore(row.sha256, rubric.id, s.score)
        const out = scoreOutOf(s)
        return { content: [{ type: 'text', text: `${out.score}/100 (${out.ship_decision}) via ${out.rubric_id}` }, textLine(out)], structuredContent: out }
      }
      const rubric = ctx.scorer.rubricFor(ctx.merged, 'text', a.rubric)
      const s = await ctx.scorer.score({ kind: 'text', text: a.text! }, rubric, ctx.merged, a.judge_model)
      const out = scoreOutOf(s)
      return { content: [{ type: 'text', text: `${out.score}/100 (${out.ship_decision}) via ${out.rubric_id}` }, textLine(out)], structuredContent: out }
    } catch (err) { return errorResult(err, 'scoring needs a judge provider (OpenRouter key) and a rubric in the loaded pack') }
  },
})

export const assets = defineTool({
  name: 'creator_assets',
  title: 'List assets',
  description: 'Search the local asset ledger (every generated or imported file with provenance). Filter by text, task, model, minimum score or date. include_preview embeds small image thumbnails.',
  inputSchema: z.object({ query: z.string().optional(), task: task.optional(), model: z.string().optional(), kind: z.enum(['image', 'video', 'audio', 'text']).optional(), min_score: z.number().optional(), pack: z.string().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(50).default(12), cursor: z.string().optional(), include_preview: z.boolean().default(false) }),
  outputSchema: z.object({ assets: z.array(assetSummary), next_cursor: z.string().optional() }),
  annotations: READ_ONLY,
  async handler(a, ctx) {
    const filter: AssetFilter = { limit: a.limit, ...(a.query ? { query: a.query } : {}), ...(a.task ? { task: a.task as Task } : {}), ...(a.model ? { model: a.model } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.min_score !== undefined ? { minScore: a.min_score } : {}), ...(a.pack ? { packId: a.pack } : {}), ...(a.since ? { since: a.since } : {}), ...(a.cursor ? { cursor: a.cursor } : {}) }
    const page = ctx.ledger.listAssets(filter)
    const result = { assets: page.assets.map(r => summarizeAsset(ctx, r)), ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [textLine(result)]
    if (a.include_preview) for (const r of page.assets.slice(0, 6)) { const img = await embedAsset(ctx, r.sha256); if (img) content.push(img) }
    return { content, structuredContent: result }
  },
})

export const assetSync = defineTool({
  name: 'creator_asset_sync',
  title: 'Sync or import asset',
  description: 'Either copy a ledger asset to a storage connector (`to`: s3, rclone) so it gets a public URL for publishing, or import a file into the ledger from an allowlisted URL (`import_url`) or a path inside the assets directory / project (`import_path`).',
  inputSchema: z.object({ asset: assetRef.optional(), to: z.string().optional(), import_url: z.string().url().optional(), import_path: z.string().optional(), mime: z.string().optional() }),
  outputSchema: z.object({ asset: assetSummary, uri: z.string().optional(), connector: z.string().optional(), public_url: z.string().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(a, ctx) {
    try {
      if (a.import_url) {
        const res = await guardedFetch(a.import_url, { policy: { ...ctx.fetchPolicy, maxBytes: ctx.config.policy.maxAssetBytes } })
        if (!res.ok) { await discardBody(res); return toolError(`fetch returned ${res.status}`) }
        const bytes = await readBodyLimited(res, ctx.config.policy.maxAssetBytes)
        const row = await ctx.assets.ingest({ bytes, mime: a.mime ?? res.headers.get('content-type') ?? sniffMime(bytes), provenance: { task: 'import', origin: { kind: 'imported_url', ref: a.import_url }, pack: { ids: ctx.merged.packs.map(p => p.id), digest: ctx.merged.digest } } })
        const out = { asset: summarizeAsset(ctx, row) }
        return { content: [textLine(out)], structuredContent: out }
      }
      if (a.import_path) {
        const roots = [ctx.assets.local.root, process.cwd(), ctx.home]
        let full: string | null = null
        for (const root of roots) { try { full = resolveInside(root, a.import_path); await stat(full); break } catch { full = null } }
        if (!full) return toolError(`import_path must be a relative path inside the assets dir, the project dir or ~/.creator-mcp`, 'copy the file there first, or pass import_url')
        const bytes = new Uint8Array(await readFile(full))
        const row = await ctx.assets.ingest({ bytes, mime: a.mime ?? sniffMime(bytes), provenance: { task: 'import', origin: { kind: 'imported_file', ref: a.import_path }, pack: { ids: ctx.merged.packs.map(p => p.id), digest: ctx.merged.digest } } })
        const out = { asset: summarizeAsset(ctx, row) }
        return { content: [textLine(out)], structuredContent: out }
      }
      if (!a.asset) return toolError('pass asset (with to), import_url, or import_path')
      const row = ctx.ledger.findAsset(a.asset)
      if (!row) return toolError(`asset ${a.asset} not found`)
      const target = a.to ?? [...ctx.connectors.keys()].find(k => k !== 'local')
      if (!target) return toolError('no remote storage connector configured', 'configure s3 or rclone in ~/.creator-mcp/config.json (creator-mcp setup --storage)')
      const stored = await ctx.assets.sync(row.sha256, target)
      const publicUrl = await ctx.assets.publicUrl(row.sha256)
      const out = { asset: summarizeAsset(ctx, ctx.ledger.getAsset(row.sha256)!), uri: stored.uri, connector: stored.connector, ...(publicUrl ? { public_url: publicUrl } : {}) }
      return { content: [textLine(out)], structuredContent: out }
    } catch (err) { return errorResult(err) }
  },
})
