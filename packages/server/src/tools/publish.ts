import * as z from 'zod/v4'
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server'
import { claimSchema, postSchema, type MetricField, METRIC_FIELDS } from '@starlight-intelligence/creator-core'
import { textLine } from '../content.js'
import { errorResult, toolError } from '../errors.js'
import { defineTool, READ_ONLY, WRITES_LOCAL } from '../tool-def.js'

const manifestOut = z.object({ id: z.string(), status: z.string(), payload_hash: z.string(), expires_at: z.string(), posts: z.number(), claims: z.number(), approved_at: z.string().optional() })

export const publicationPrepare = defineTool({
  name: 'creator_publication_prepare',
  title: 'Prepare publication manifest',
  description: 'Assemble a publication manifest (posts per channel, assets by sha256, declared claims) and compute its payload hash. Numerical claims without an evidence asset are marked blocked; banned phrases and channel limits produce warnings. Nothing is sent. Same content → same manifest (idempotent).',
  inputSchema: z.object({ campaign_id: z.string().optional(), posts: z.array(postSchema).min(1), claims: z.array(claimSchema).default([]), expires_in_days: z.number().int().min(1).max(14).default(14), rubric: z.object({ id: z.string(), score: z.number(), ship_decision: z.string() }).optional() }),
  outputSchema: z.object({ manifest_id: z.string(), payload_hash: z.string(), confirm_code: z.string(), reused: z.boolean(), warnings: z.array(z.string()), manifest: manifestOut, summary: z.string() }),
  annotations: WRITES_LOCAL,
  async handler(a, ctx) {
    try {
      const r = await ctx.publish.prepare({ ...(a.campaign_id ? { campaignId: a.campaign_id } : {}), posts: a.posts, claims: a.claims, expiresInDays: a.expires_in_days, ...(a.rubric ? { rubric: { id: a.rubric.id, score: a.rubric.score, shipDecision: a.rubric.ship_decision } } : {}) }, ctx.merged)
      const m = r.manifest
      const result = { manifest_id: m.id, payload_hash: m.payload_hash, confirm_code: m.payload_hash.slice(0, 8), reused: r.reused, warnings: r.warnings, manifest: { id: m.id, status: m.status, payload_hash: m.payload_hash, expires_at: m.expires_at, posts: m.posts.length, claims: m.claims.length }, summary: ctx.publish.summary(m) }
      return { content: [{ type: 'text', text: `${result.summary}\n\nWarnings: ${r.warnings.length ? r.warnings.join(' | ') : 'none'}\nTo approve, the human confirms code ${result.confirm_code} via creator_publication_approve.` }, textLine(result)], structuredContent: result }
    } catch (err) { return errorResult(err) }
  },
})

const confirmSchema = z.object({ confirm: z.string().min(1), note: z.string().optional() })

export const publicationApprove = defineTool({
  name: 'creator_publication_approve',
  title: 'Approve publication (human)',
  description: 'Request host confirmation for a prepared manifest. The client shows the summary and collects an 8-character confirmation code; on match the manifest is HMAC-signed locally. The server trusts the client confirmation channel and does not independently verify human presence. If the client cannot show forms, returns needs_cli_approval with the command to run.',
  inputSchema: z.object({ manifest_id: z.string() }),
  outputSchema: z.object({ manifest_id: z.string(), status: z.enum(['approved', 'declined', 'needs_cli_approval', 'rejected']), reason: z.string().optional(), command: z.string().optional(), signature: z.string().optional(), approved_at: z.string().optional(), expires_at: z.string().optional() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(a, ctx, mcp) {
    const m = ctx.publish.get(a.manifest_id)
    if (!m) return toolError(`manifest ${a.manifest_id} not found`)
    if (m.status === 'approved' && m.approval) {
      const result = { manifest_id: m.id, status: 'approved' as const, signature: m.approval.signature, approved_at: m.approval.approved_at, expires_at: m.expires_at }
      return { content: [textLine(result)], structuredContent: result }
    }
    const message = `${ctx.publish.summary(m)}\n\nType the confirm code ${m.payload_hash.slice(0, 8)} to approve publishing this content.`
    const requestedSchema = { type: 'object' as const, properties: { confirm: { type: 'string' as const, title: 'Confirm code (first 8 characters of the payload hash)' }, note: { type: 'string' as const, title: 'Note (optional)' } }, required: ['confirm'] }
    const finish = async (confirm: string) => {
      const r = await ctx.publish.approve(m.id, confirm, 'elicitation')
      const result = r.ok && r.manifest?.approval
        ? { manifest_id: m.id, status: 'approved' as const, signature: r.manifest.approval.signature, approved_at: r.manifest.approval.approved_at, expires_at: r.manifest.expires_at }
        : { manifest_id: m.id, status: 'rejected' as const, ...(r.reason ? { reason: r.reason } : {}) }
      return { content: [textLine(result)], structuredContent: result }
    }
    const declined = () => { const result = { manifest_id: m.id, status: 'declined' as const, reason: 'operator declined' }; return { content: [textLine(result)], structuredContent: result } }
    const cliFallback = () => { const result = { manifest_id: m.id, status: 'needs_cli_approval' as const, command: `creator-mcp approve ${m.id}`, reason: 'this client cannot show an approval form' }; return { content: [textLine(result)], structuredContent: result } }
    if (mcp.mcpReq.envelope) {
      const responses = mcp.mcpReq.inputResponses
      const accepted = acceptedContent(responses, 'confirm', confirmSchema)
      if (accepted) return finish(accepted.confirm)
      if (responses && 'confirm' in responses) return declined()
      try {
        return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ mode: 'form', message, requestedSchema }) } })
      } catch { return cliFallback() }
    }
    try {
      const res = await mcp.mcpReq.elicitInput({ mode: 'form', message, requestedSchema })
      if (res.action !== 'accept') return declined()
      const parsed = confirmSchema.safeParse(res.content)
      return parsed.success ? finish(parsed.data.confirm) : cliFallback()
    } catch { return cliFallback() }
  },
})

export const publish = defineTool({
  name: 'creator_publish',
  title: 'Publish approved manifest',
  description: 'Send an approved, signed manifest through a publish adapter (the user\'s own Postiz instance, or the local outbox). Refuses unsigned, expired or modified manifests. Re-running after a partial failure only sends the channels that have not been sent (idempotent). dry_run validates everything without sending. This posts publicly when not a dry run.',
  inputSchema: z.object({ manifest_id: z.string(), adapter: z.string().optional().describe('postiz | local; defaults to postiz when configured'), dry_run: z.boolean().default(false) }),
  outputSchema: z.object({ manifest_id: z.string(), status: z.string(), publications: z.array(z.object({ channel_id: z.string(), status: z.string(), native_id: z.string().optional(), native_url: z.string().optional(), error: z.string().optional() })), rate_limit: z.object({ adapter: z.string(), remaining_hour: z.number() }) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(a, ctx) {
    try {
      const r = await ctx.publish.publish(a.manifest_id, { dryRun: a.dry_run, ...(a.adapter ? { adapterId: a.adapter } : {}) })
      const result = { manifest_id: a.manifest_id, status: r.manifest.status, publications: r.outcomes.map(o => ({ channel_id: o.channelId, status: o.status, ...(o.nativeId ? { native_id: o.nativeId } : {}), ...(o.nativeUrl ? { native_url: o.nativeUrl } : {}), ...(o.error ? { error: o.error } : {}) })), rate_limit: { adapter: r.rateLimit.adapter, remaining_hour: Number.isFinite(r.rateLimit.remainingHour) ? r.rateLimit.remainingHour : 9999 } }
      return { content: [textLine(result)], structuredContent: result }
    } catch (err) { return errorResult(err, 'prepare → approve (human confirm code) → publish') }
  },
})

const metricFields = Object.fromEntries(METRIC_FIELDS.map(f => [f, z.number().optional()])) as Record<MetricField, z.ZodOptional<z.ZodNumber>>

export const metricsIngest = defineTool({
  name: 'creator_metrics_ingest',
  title: 'Ingest metrics',
  description: 'Record performance observations for published posts into the local ledger: from the publish adapter (postiz), manual numbers, or a CSV export (columns publication_id, observed_at, impressions, reach, views, likes, comments, shares, saves, link_actions, follower_delta).',
  inputSchema: z.object({ source: z.enum(['postiz', 'manual', 'csv']), publication_ids: z.array(z.string()).optional(), observations: z.array(z.object({ publication_id: z.string(), observed_at: z.string().optional(), window_hours: z.number().optional(), ...metricFields })).optional(), csv_path: z.string().optional() }),
  outputSchema: z.object({ ingested: z.number(), skipped: z.number() }),
  annotations: WRITES_LOCAL,
  async handler(a, ctx) {
    try {
      let r: { ingested: number; skipped: number }
      if (a.source === 'csv') { if (!a.csv_path) return toolError('csv_path required'); r = await ctx.metrics.ingestCsv(a.csv_path, [process.cwd(), ctx.home]) }
      else if (a.source === 'manual') {
        r = ctx.metrics.ingestManual((a.observations ?? []).map(o => { const { publication_id, observed_at, window_hours, ...metrics } = o; return { publicationId: publication_id, ...(observed_at ? { observedAt: observed_at } : {}), ...(window_hours ? { windowHours: window_hours } : {}), metrics: Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined)) as Partial<Record<MetricField, number>> } }))
      } else r = await ctx.metrics.ingestFromAdapter('postiz', a.publication_ids)
      return { content: [textLine(r)], structuredContent: r }
    } catch (err) { return errorResult(err) }
  },
})

export const metricsQuery = defineTool({
  name: 'creator_metrics_query',
  title: 'Query metrics',
  description: 'Aggregate recorded metrics by publication, channel, day or source, with totals. Use it to close the loop on what actually performed before planning the next campaign.',
  inputSchema: z.object({ publication_id: z.string().optional(), since: z.string().optional(), until: z.string().optional(), group_by: z.enum(['publication', 'channel', 'day', 'source']).default('publication') }),
  outputSchema: z.object({ rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))), totals: z.record(z.string(), z.number()) }),
  annotations: READ_ONLY,
  async handler(a, ctx) {
    const r = ctx.metrics.query({ ...(a.publication_id ? { publicationId: a.publication_id } : {}), ...(a.since ? { since: a.since } : {}), ...(a.until ? { until: a.until } : {}), groupBy: a.group_by })
    const result = { rows: r.rows as Array<Record<string, string | number>>, totals: r.totals }
    return { content: [textLine(result)], structuredContent: result }
  },
})
