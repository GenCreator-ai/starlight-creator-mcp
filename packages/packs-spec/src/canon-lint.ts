import { readPackText } from './files.js'
import type { MergedPack } from './merge.js'
import { compilePackPattern } from './pattern.js'

export interface CanonFinding { packId: string; pattern: string; message: string; excerpt: string; index: number }
export interface CanonLintResult { ok: boolean; findings: CanonFinding[]; unknownEntities: string[] }

export interface EntityIndex { byType: Record<string, Array<{ name: string; aliases: string[] }>>; names: Set<string> }

export async function loadEntities(merged: MergedPack): Promise<EntityIndex> {
  const byType: EntityIndex['byType'] = {}
  const names = new Set<string>()
  for (const e of merged.entities) {
    const raw = JSON.parse(await readPackText(e.dir, e.path)) as Record<string, Array<{ name: string; aliases?: string[] }>>
    for (const [type, list] of Object.entries(raw)) {
      byType[type] ??= []
      for (const item of list) {
        const aliases = item.aliases ?? []
        byType[type].push({ name: item.name, aliases })
        names.add(item.name.toLowerCase())
        for (const a of aliases) names.add(a.toLowerCase())
      }
    }
  }
  return { byType, names }
}

export function lintText(text: string, merged: MergedPack, entities?: EntityIndex): CanonLintResult {
  const findings: CanonFinding[] = []
  for (const fp of merged.forbiddenPatterns) {
    for (const match of compilePackPattern(fp.pattern)(text)) {
      const start = Math.max(0, match.index - 40)
      findings.push({ packId: fp.packId, pattern: fp.pattern, message: fp.message, excerpt: text.slice(start, match.index + match.text.length + 40).replace(/\s+/g, ' '), index: match.index })
    }
  }
  const unknownEntities: string[] = []
  if (entities && entities.names.size) {
    const candidates = new Set<string>()
    // Entity type labels are data from this pack, never executable regex or global brand vocabulary.
    const labels = new Set<string>()
    for (const type of Object.keys(entities.byType)) {
      const label = type.replace(/[_-]/g, ' ').toLowerCase()
      labels.add(label)
      if (label.endsWith('ies')) labels.add(label.slice(0, -3) + 'y')
      else if (label.endsWith('s') && !label.endsWith('ss')) labels.add(label.slice(0, -1))
    }
    const words = [...text.matchAll(/[A-Za-z][\w'-]*/g)]
    for (let i = 1; i < words.length; i++) {
      const name = words[i]![0]
      if (!/^[A-Z]/.test(name)) continue
      // Only adjacent type + capitalized one-word names are candidates. Arbitrary proper nouns are not classified.
      for (const label of labels) {
        const count = label.split(' ').length
        if (i < count) continue
        const previous = words.slice(i - count, i)
        const start = previous[0]!.index!, end = words[i]!.index!
        if (text.slice(start, end).trim().toLowerCase().replace(/\s+/g, ' ') === label) candidates.add(name)
      }
    }
    for (const c of candidates) if (!entities.names.has(c.toLowerCase())) unknownEntities.push(c)
  }
  return { ok: findings.length === 0 && unknownEntities.length === 0, findings, unknownEntities }
}
