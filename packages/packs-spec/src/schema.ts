import * as z from 'zod/v4'
import { resolvePackPath } from './files.js'

export const PACK_SCHEMA_VERSION = 'creator-pack-manifest.v1'

export const taskSchema = z.enum(['t2i', 'i2i', 't2v', 'i2v', 'v2v', 'lipsync', 'tts', 'music', 'sfx', 'stt', 'chat', 'vision'])
export type Task = z.infer<typeof taskSchema>

export const qualitySchema = z.enum(['high', 'draft'])
export type Quality = z.infer<typeof qualitySchema>

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase kebab-case id')
const relPath = z.string().min(1).refine(p => { try { resolvePackPath('.', p); return true } catch { return false } }, 'relative path inside the pack')

export const licenseSchema = z.object({
  type: z.string().min(1),
  attribution_text: z.string().optional(),
  note: z.string().optional(),
  url: z.string().url().optional(),
})

export const rubricDimensionSchema = z.object({
  id: idSchema,
  label: z.string().optional(),
  weight: z.number().min(0).max(100),
  invert: z.boolean().optional(),
  guidance: z.string().optional(),
})

export const rubricSchema = z.object({
  id: idSchema,
  kind: z.enum(['image', 'video', 'text', 'audio']),
  default: z.boolean().optional(),
  judge: z.object({ task: z.enum(['vision', 'chat']).default('vision'), quality: qualitySchema.default('draft'), model: z.string().optional() }).default({ task: 'vision', quality: 'draft' }),
  dimensions: z.array(rubricDimensionSchema).min(1),
  thresholds: z.object({ ship: z.number().min(0).max(100), focused_pass: z.number().min(0).max(100), draft: z.number().min(0).max(100) }),
  autoFail: z.array(z.string()).default([]),
  promptFile: relPath.optional(),
}).superRefine((r, ctx) => {
  const sum = r.dimensions.reduce((a, d) => a + d.weight, 0)
  if (Math.abs(sum - 100) > 0.001) ctx.addIssue({ code: 'custom', message: `rubric ${r.id}: dimension weights sum to ${sum}, expected 100`, path: ['dimensions'] })
  if (!(r.thresholds.ship >= r.thresholds.focused_pass && r.thresholds.focused_pass >= r.thresholds.draft)) ctx.addIssue({ code: 'custom', message: `rubric ${r.id}: thresholds must satisfy ship >= focused_pass >= draft`, path: ['thresholds'] })
})

export const templateSchema = z.object({ id: idSchema, path: relPath, kind: z.enum(['markdown', 'json', 'text']).default('markdown'), tags: z.array(z.string()).default([]), description: z.string().optional() })
export const promptRefSchema = z.object({ id: idSchema, path: relPath, description: z.string().optional() })
export const styleSchema = z.object({ id: idSchema, task: taskSchema, label: z.string().optional(), prefix: z.string().optional(), suffix: z.string().optional(), negative: z.string().optional(), defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) })

export const registryOverridesSchema = z.object({
  preferences: z.record(z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/), z.array(z.string())).default({}),
  intents: z.array(z.object({ id: idSchema, task: taskSchema, pattern: z.string().min(1), preferenceKey: z.string() })).default([]),
  pins: z.partialRecord(taskSchema, z.string()).default({}),
  deny: z.array(z.string()).default([]),
  providers: z.object({ prefer: z.array(z.string()).default([]) }).default({ prefer: [] }),
})

export const canonSchema = z.object({
  paths: z.array(z.string()).default([]),
  locked: relPath.optional(),
  entities: relPath.optional(),
  forbiddenPatterns: z.array(z.object({ pattern: z.string().min(1), message: z.string().min(1) })).default([]),
  truthClasses: z.array(z.string()).default(['locked', 'soft', 'proposed']),
})

export const voiceSchema = z.object({
  principles: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  bannedPhrases: z.array(z.string()).default([]),
  register: z.string().optional(),
  files: z.array(relPath).default([]),
})

export const compositeToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  description: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  steps: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('template'), template: idSchema }),
    z.object({ kind: z.literal('prompt'), prompt: idSchema }),
    z.object({ kind: z.literal('call'), tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }),
  ])).min(1),
})

export const packSectionSchema = z.enum(['canon', 'rubrics', 'templates', 'prompts', 'styles', 'registry', 'voice', 'tools', 'init'])

export const packManifestSchema = z.object({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'semver'),
  description: z.string().optional(),
  license: licenseSchema,
  publicSafe: z.boolean().default(true),
  entitlement: z.object({ provider: z.literal('polar'), benefit_id: z.string(), organization_id: z.string() }).optional(),
  requires: z.object({ substrate: z.string().optional(), canon: z.record(idSchema, z.string()).default({}) }).default({ canon: {} }),
  extends: z.array(idSchema).default([]),
  canon: canonSchema.default({ paths: [], forbiddenPatterns: [], truthClasses: ['locked', 'soft', 'proposed'] }),
  rubrics: z.array(rubricSchema).default([]),
  templates: z.array(templateSchema).default([]),
  prompts: z.array(promptRefSchema).default([]),
  styles: z.array(styleSchema).default([]),
  registry: registryOverridesSchema.default({ preferences: {}, intents: [], pins: {}, deny: [], providers: { prefer: [] } }),
  voice: voiceSchema.default({ principles: [], avoid: [], bannedPhrases: [], files: [] }),
  publishing: z.object({ requireRubric: idSchema.optional(), minScore: z.number().min(0).max(100).optional(), channels: z.record(z.string(), z.object({ maxChars: z.number().int().positive().optional() })).default({}) }).default({ channels: {} }),
  tools: z.array(relPath).default([]),
  init: z.object({ dir: relPath }).optional(),
  offer: z.object({ free: z.array(packSectionSchema).default([]), paid: z.array(packSectionSchema).default([]) }).optional(),
  tags: z.array(z.string()).default([]),
  homepage: z.string().optional(),
  author: z.string().optional(),
})

export type PackManifest = z.infer<typeof packManifestSchema>
export type PackManifestInput = z.input<typeof packManifestSchema>
export type Rubric = z.infer<typeof rubricSchema>
export type Style = z.infer<typeof styleSchema>
export type CompositeTool = z.infer<typeof compositeToolSchema>
export type RegistryOverrides = z.infer<typeof registryOverridesSchema>

export function parsePackManifest(raw: unknown): PackManifest {
  return packManifestSchema.parse(raw)
}

export function packJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(packManifestSchema, { target: 'draft-7' }) as Record<string, unknown>
}
