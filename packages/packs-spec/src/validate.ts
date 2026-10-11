import { checkedPackPath, readPackText } from './files.js'
import * as z from 'zod/v4'
import { compositeToolSchema, packManifestSchema, type PackManifest } from './schema.js'
import { compilePackPattern } from './pattern.js'

export interface PackIssue { level: 'error' | 'warning'; path: string; message: string }
export interface PackValidation { ok: boolean; manifest?: PackManifest; issues: PackIssue[] }

const GLOB_CHARS = /[*?]/

export async function readPackManifest(dir: string): Promise<unknown> {
  const raw = await readPackText(dir, 'pack.json')
  return JSON.parse(raw)
}

export async function validatePackDir(dir: string): Promise<PackValidation> {
  const issues: PackIssue[] = []
  let raw: unknown
  try {
    raw = await readPackManifest(dir)
  } catch (err) {
    return { ok: false, issues: [{ level: 'error', path: 'pack.json', message: `cannot read pack.json: ${(err as Error).message}` }] }
  }
  const parsed = packManifestSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push({ level: 'error', path: issue.path.map(String).join('.') || 'pack.json', message: issue.message })
    return { ok: false, issues }
  }
  const m = parsed.data
  const refs: Array<[string, string | undefined]> = [
    ['canon.locked', m.canon.locked], ['canon.entities', m.canon.entities],
    ...m.rubrics.map((r): [string, string | undefined] => [`rubrics.${r.id}.promptFile`, r.promptFile]),
    ...m.templates.map((t): [string, string | undefined] => [`templates.${t.id}.path`, t.path]),
    ...m.prompts.map((p): [string, string | undefined] => [`prompts.${p.id}.path`, p.path]),
    ...m.voice.files.map((f, i): [string, string | undefined] => [`voice.files.${i}`, f]),
    ...m.tools.map((t, i): [string, string | undefined] => [`tools.${i}`, t]),
  ]
  if (m.init) refs.push(['init.dir', m.init.dir])
  for (const [label, rel] of refs) {
    if (!rel) continue
    try { await checkedPackPath(dir, rel, label === 'init.dir' ? 'directory' : 'file') }
    catch (err) { issues.push({ level: 'error', path: label, message: `referenced file missing or unsafe: ${rel}: ${(err as Error).message}` }) }
  }
  for (const [i, p] of m.canon.paths.entries()) {
    try { (await import('./load.js')).compilePackGlob(p) }
    catch (err) { issues.push({ level: 'error', path: `canon.paths.${i}`, message: (err as Error).message }); continue }
    if (GLOB_CHARS.test(p)) continue
    try { await checkedPackPath(dir, p) }
    catch (err) { issues.push({ level: 'error', path: `canon.paths.${i}`, message: `canon path missing or unsafe: ${p}: ${(err as Error).message}` }) }
  }
  for (const [i, toolPath] of m.tools.entries()) {
    try {
      compositeToolSchema.parse(JSON.parse(await readPackText(dir, toolPath)))
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map(x => x.message).join('; ') : (err as Error).message
      issues.push({ level: 'error', path: `tools.${i}`, message: `invalid composite tool: ${message}` })
    }
  }
  const defaultsByKind = new Map<string, number>()
  for (const r of m.rubrics) if (r.default) defaultsByKind.set(r.kind, (defaultsByKind.get(r.kind) ?? 0) + 1)
  for (const [kind, n] of defaultsByKind) if (n > 1) issues.push({ level: 'error', path: 'rubrics', message: `${n} default rubrics for kind ${kind}; at most one allowed` })
  for (const intent of m.registry.intents) {
    try { compilePackPattern(intent.pattern) } catch (error) { issues.push({ level: 'error', path: `registry.intents.${intent.id}`, message: (error as Error).message }) }
    if (!(intent.preferenceKey in m.registry.preferences)) issues.push({ level: 'warning', path: `registry.intents.${intent.id}`, message: `preferenceKey ${intent.preferenceKey} has no preference list in this pack (may come from another pack)` })
  }
  for (const fp of m.canon.forbiddenPatterns) {
    try { compilePackPattern(fp.pattern) } catch (error) { issues.push({ level: 'error', path: 'canon.forbiddenPatterns', message: (error as Error).message }) }
  }
  if (m.publishing.requireRubric && !m.rubrics.some(r => r.id === m.publishing.requireRubric)) issues.push({ level: 'warning', path: 'publishing.requireRubric', message: `rubric ${m.publishing.requireRubric} not defined in this pack` })
  if (!m.publicSafe && !m.entitlement) issues.push({ level: 'warning', path: 'entitlement', message: 'pack is not publicSafe but declares no entitlement; it will only load with CREATOR_DEV=1' })
  if (m.offer) {
    const paid = m.offer.paid
    const overlap = m.offer.free.filter(s => paid.includes(s))
    if (overlap.length) issues.push({ level: 'error', path: 'offer', message: `sections listed as both free and paid: ${overlap.join(', ')}` })
  }
  return { ok: !issues.some(i => i.level === 'error'), manifest: m, issues }
}
