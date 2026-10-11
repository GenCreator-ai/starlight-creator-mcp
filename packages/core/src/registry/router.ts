import { compilePackPattern, type RegistryOverrides } from '@starlight-intelligence/creator-packs-spec'
import type { ModelRecord, Quality, Task } from '../types.js'

export interface RouteInput {
  task: Task
  quality: Quality
  prompt?: string
  explicitModel?: string
  preferProviders?: string[]
}

export interface RouteResult { model: ModelRecord; reason: string }

export class RoutingError extends Error {}

function matchesPattern(model: ModelRecord, pattern: string): boolean {
  const p = pattern.toLowerCase()
  return model.id.toLowerCase() === p || model.modelId.toLowerCase() === p || model.modelId.toLowerCase().includes(p) || model.name.toLowerCase().includes(p)
}

export function routeModel(models: ModelRecord[], registry: RegistryOverrides, input: RouteInput): RouteResult {
  const denied = new Set(registry.deny.map(d => d.toLowerCase()))
  const candidates = models.filter(m => m.tasks.includes(input.task) && !denied.has(m.id.toLowerCase()) && !denied.has(m.modelId.toLowerCase()))
  if (!candidates.length) throw new RoutingError(`no configured provider offers task ${input.task}; run creator-mcp doctor`)

  if (input.explicitModel) {
    const hit = candidates.find(m => m.id === input.explicitModel || m.modelId === input.explicitModel)
    if (!hit) throw new RoutingError(`model ${input.explicitModel} is not available for task ${input.task}; call creator_models to list ids`)
    return { model: hit, reason: 'explicit' }
  }

  const pinned = (registry.pins as Partial<Record<Task, string>>)[input.task]
  if (pinned) {
    const hit = candidates.find(m => m.id === pinned || m.modelId === pinned)
    if (hit) return { model: hit, reason: `pack pin ${pinned}` }
  }

  const providerOrder = [...(input.preferProviders ?? []), ...registry.providers.prefer]
  const byProviderPreference = (list: ModelRecord[]) => [...list].sort((a, b) => {
    const ia = providerOrder.indexOf(a.provider); const ib = providerOrder.indexOf(b.provider)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  let key = `${input.task}:${input.quality}`
  if (input.prompt) {
    for (const intent of registry.intents) {
      if (intent.task !== input.task) continue
      if (!compilePackPattern(intent.pattern)(input.prompt)[Symbol.iterator]().next().done) { key = intent.preferenceKey; break }
    }
  }
  const prefs = registry.preferences[key] ?? registry.preferences[`${input.task}:${input.quality}`] ?? []
  for (const pattern of prefs) {
    const hits = byProviderPreference(candidates.filter(m => matchesPattern(m, pattern)))
    if (hits[0]) return { model: hits[0], reason: `preference ${key} -> ${pattern}` }
  }
  const fallback = byProviderPreference(candidates)[0]!
  return { model: fallback, reason: `first available for ${input.task}` }
}

export function applyStyle(prompt: string, style: { prefix?: string; suffix?: string } | undefined): string {
  if (!style) return prompt
  return [style.prefix, prompt, style.suffix].filter(s => s && s.trim()).join(', ')
}
