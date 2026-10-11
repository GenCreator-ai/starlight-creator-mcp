import { readPackText } from '@starlight-intelligence/creator-packs-spec'
import * as z from 'zod/v4'
import { SECRET_NAMES } from '@starlight-intelligence/creator-core'
import { textLine } from '../content.js'
import { defineTool, READ_ONLY, READ_ONLY_NET } from '../tool-def.js'

export const packInfo = defineTool({
  name: 'creator_pack_info',
  title: 'Pack info and canon search',
  description: 'Inspect the loaded packs: manifest summary, canon search (query), rubrics, templates, styles, prompts, voice rules, or routing preferences. Use section=canon with a query before writing anything that must respect a brand\'s locked facts.',
  inputSchema: z.object({ pack: z.string().optional(), section: z.enum(['manifest', 'canon', 'rubrics', 'templates', 'styles', 'prompts', 'voice', 'registry']).default('manifest'), query: z.string().optional(), limit: z.number().int().min(1).max(30).default(8), template: z.string().optional().describe('template id to return in full') }),
  outputSchema: z.object({
    packs: z.array(z.object({ id: z.string(), version: z.string(), name: z.string(), license: z.string(), public_safe: z.boolean(), digest: z.string() })),
    canon_files: z.array(z.object({ pack: z.string(), file: z.string(), chunks: z.number(), locked: z.boolean() })).optional(),
    canon_hits: z.array(z.object({ id: z.string(), pack: z.string(), file: z.string(), heading: z.string(), excerpt: z.string(), locked: z.boolean() })).optional(),
    rubrics: z.array(z.object({ id: z.string(), kind: z.string(), default: z.boolean(), dimensions: z.array(z.object({ id: z.string(), weight: z.number() })), thresholds: z.object({ ship: z.number(), focused_pass: z.number(), draft: z.number() }) })).optional(),
    templates: z.array(z.object({ id: z.string(), pack: z.string(), kind: z.string(), tags: z.array(z.string()), description: z.string().optional() })).optional(),
    template_text: z.string().optional(),
    styles: z.array(z.object({ id: z.string(), task: z.string(), label: z.string().optional(), suffix: z.string().optional(), defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })).optional(),
    prompts: z.array(z.object({ id: z.string(), pack: z.string(), description: z.string().optional() })).optional(),
    voice: z.object({ principles: z.array(z.string()), avoid: z.array(z.string()), banned_phrases: z.array(z.string()), register: z.string().optional() }).optional(),
    registry: z.object({ preferences: z.record(z.string(), z.array(z.string())), pins: z.record(z.string(), z.string()), deny: z.array(z.string()), intents: z.array(z.object({ id: z.string(), task: z.string(), preference_key: z.string() })) }).optional(),
    forbidden_patterns: z.array(z.object({ pack: z.string(), message: z.string() })).optional(),
  }),
  annotations: READ_ONLY,
  async handler(a, ctx) {
    const m = ctx.merged
    const packs = m.packs.filter(p => !a.pack || p.id === a.pack).map(p => ({ id: p.id, version: p.version, name: p.name, license: p.license, public_safe: p.publicSafe, digest: p.digest.slice(0, 16) }))
    const result: Record<string, unknown> = { packs }
    switch (a.section) {
      case 'canon':
        result.canon_files = ctx.packs.canon.files().filter(f => !a.pack || f.packId === a.pack).map(f => ({ pack: f.packId, file: f.file, chunks: f.chunks, locked: f.locked }))
        if (a.query) result.canon_hits = ctx.packs.canon.search(a.query, a.limit, a.pack).map(h => ({ id: h.id, pack: h.packId, file: h.file, heading: h.heading, excerpt: h.excerpt, locked: h.locked }))
        result.forbidden_patterns = m.forbiddenPatterns.map(f => ({ pack: f.packId, message: f.message }))
        break
      case 'rubrics':
        result.rubrics = [...m.rubrics.values()].map(r => ({ id: r.id, kind: r.kind, default: m.defaultRubric[r.kind] === r.id, dimensions: r.dimensions.map(d => ({ id: d.id, weight: d.weight })), thresholds: r.thresholds }))
        break
      case 'templates':
        result.templates = [...m.templates.entries()].map(([id, t]) => ({ id, pack: t.packId, kind: t.kind, tags: t.tags, ...(t.description ? { description: t.description } : {}) }))
        if (a.template) { const t = m.templates.get(a.template); if (t && (!a.pack || t.packId === a.pack)) result.template_text = await readPackText(t.dir, t.path) }
        break
      case 'styles':
        result.styles = [...m.styles.values()].map(s => ({ id: s.id, task: s.task, ...(s.label ? { label: s.label } : {}), ...(s.suffix ? { suffix: s.suffix } : {}), defaults: s.defaults }))
        break
      case 'prompts':
        result.prompts = [...m.prompts.entries()].map(([id, p]) => ({ id, pack: p.packId, ...(p.description ? { description: p.description } : {}) }))
        break
      case 'voice':
        result.voice = { principles: m.voice.principles, avoid: m.voice.avoid, banned_phrases: m.voice.bannedPhrases, ...(m.voice.register ? { register: m.voice.register } : {}) }
        break
      case 'registry':
        result.registry = { preferences: m.registry.preferences, pins: m.registry.pins, deny: m.registry.deny, intents: m.registry.intents.map(i => ({ id: i.id, task: i.task, preference_key: i.preferenceKey })) }
        break
      default:
        break
    }
    return { content: [textLine(result)], structuredContent: result }
  },
})

export const licenseStatus = defineTool({
  name: 'creator_license_status',
  title: 'License status',
  description: 'Report whether a pack license key is configured and valid (validated against Polar from this machine; offline grace of 14 days after a successful online check). Shows which paid packs are unlocked.',
  inputSchema: z.object({ refresh: z.boolean().default(false) }),
  outputSchema: z.object({ valid: z.boolean(), source: z.enum(['online', 'cache', 'none']), status: z.string().optional(), packs_unlocked: z.array(z.string()), validated_at: z.string().optional(), grace_until: z.string().optional(), expires_at: z.string().optional(), reason: z.string().optional(), loaded_packs: z.array(z.object({ id: z.string(), public_safe: z.boolean() })) }),
  annotations: READ_ONLY_NET,
  async handler(a, ctx) {
    const key = await ctx.vault.resolve(SECRET_NAMES.license)
    const s = await ctx.license.validate({ key, packsByBenefit: ctx.packsByBenefit, refresh: a.refresh })
    const result = { valid: s.valid, source: s.source, ...(s.status ? { status: s.status } : {}), packs_unlocked: s.packs, ...(s.validatedAt ? { validated_at: s.validatedAt } : {}), ...(s.graceUntil ? { grace_until: s.graceUntil } : {}), ...(s.expiresAt ? { expires_at: s.expiresAt } : {}), ...(s.reason ? { reason: s.reason } : {}), loaded_packs: ctx.merged.packs.map(p => ({ id: p.id, public_safe: p.publicSafe })) }
    return { content: [textLine(result)], structuredContent: result }
  },
})
