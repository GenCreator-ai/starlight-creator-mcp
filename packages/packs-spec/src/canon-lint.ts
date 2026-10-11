import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MergedPack } from './merge.js'
import { compilePackPattern } from './pattern.js'

export interface CanonFinding { packId: string; pattern: string; message: string; excerpt: string; index: number }
export interface CanonLintResult { ok: boolean; findings: CanonFinding[]; unknownEntities: string[] }

export interface EntityIndex { byType: Record<string, Array<{ name: string; aliases: string[] }>>; names: Set<string> }

export async function loadEntities(merged: MergedPack): Promise<EntityIndex> {
  const byType: EntityIndex['byType'] = {}
  const names = new Set<string>()
  for (const e of merged.entities) {
    const raw = JSON.parse(await readFile(path.join(e.dir, e.path), 'utf8')) as Record<string, Array<{ name: string; aliases?: string[] }>>
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
    for (const m of text.matchAll(/\b(?:Guardian|Godbeast|House|Realm|Gate)\s+([A-Z][\w'-]+)/g)) candidates.add(m[1]!)
    for (const c of candidates) if (!entities.names.has(c.toLowerCase())) unknownEntities.push(c)
  }
  return { ok: findings.length === 0 && unknownEntities.length === 0, findings, unknownEntities }
}
