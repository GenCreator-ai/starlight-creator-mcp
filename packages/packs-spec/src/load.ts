import { readdir } from 'node:fs/promises'
import { readPackFile, resolvePackPath } from './files.js'
import path from 'node:path'
import { sha256CanonicalJson, sha256Hex } from './hash.js'
import type { LoadedPack } from './merge.js'
import { validatePackDir } from './validate.js'
import type { PackManifest } from './schema.js'

export class PackLoadError extends Error {
  constructor(message: string, public readonly issues: Array<{ level: string; path: string; message: string }> = []) { super(message) }
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) out.push(full)
    }
  }
  await walk(root)
  return out.sort()
}

/** Bounded glob matching: literals, ?, *, and ** as a whole directory segment. */
export function compilePackGlob(pattern: string): (relative: string) => boolean {
  if (pattern.length > 512) throw new PackLoadError('canon glob exceeds 512 characters')
  resolvePackPath('.', pattern)
  const parts = pattern.replace(/\\/g, '/').split('/')
  if (parts.some(p => !p || (p.includes('**') && p !== '**'))) throw new PackLoadError('** must be a whole canon glob directory segment')
  const segmentMatches = (glob: string, value: string) => {
    let p = 0, v = 0, star = -1, retry = 0
    while (v < value.length) {
      if (glob[p] === '?' || glob[p] === value[v]) { p++; v++ }
      else if (glob[p] === '*') { star = p++; retry = v }
      else if (star !== -1) { p = star + 1; v = ++retry }
      else return false
    }
    while (glob[p] === '*') p++
    return p === glob.length
  }
  return relative => {
    if (relative.length > 4096) throw new PackLoadError('canon file path exceeds 4096 characters')
    const segments = relative.replace(/\\/g, '/').split('/')
    let previous = new Array<boolean>(segments.length + 1).fill(false); previous[0] = true
    for (const part of parts) {
      const next = new Array<boolean>(segments.length + 1).fill(false)
      if (part === '**') {
        next[0] = previous[0]!
        for (let j = 1; j <= segments.length; j++) next[j] = previous[j]! || next[j - 1]!
      } else for (let j = 1; j <= segments.length; j++) next[j] = previous[j - 1]! && segmentMatches(part, segments[j - 1]!)
      previous = next
    }
    return previous[segments.length]!
  }
}

export async function resolveCanonFiles(dir: string, patterns: string[]): Promise<string[]> {
  const all = await listFilesRecursive(dir)
  const rel = all.map(f => path.relative(dir, f).split(path.sep).join('/'))
  const matched = new Set<string>()
  for (const p of patterns) {
    const matches = compilePackGlob(p)
    for (const r of rel) if (matches(r)) matched.add(r)
  }
  return [...matched].sort().map(r => path.join(dir, r))
}

export function referencedFiles(m: PackManifest): string[] {
  const files = new Set<string>()
  if (m.canon.locked) files.add(m.canon.locked)
  if (m.canon.entities) files.add(m.canon.entities)
  for (const r of m.rubrics) if (r.promptFile) files.add(r.promptFile)
  for (const t of m.templates) files.add(t.path)
  for (const p of m.prompts) files.add(p.path)
  for (const f of m.voice.files) files.add(f)
  for (const t of m.tools) files.add(t)
  return [...files].sort()
}

export async function computePackDigest(dir: string, m: PackManifest): Promise<string> {
  const fileHashes: Record<string, string> = {}
  const canonFiles = await resolveCanonFiles(dir, m.canon.paths)
  const refs = referencedFiles(m).map(r => resolvePackPath(dir, r))
  for (const full of [...new Set([...refs, ...canonFiles])].sort()) {
    const rel = path.relative(dir, full).split(path.sep).join('/')
    fileHashes[rel] = sha256Hex(await readPackFile(dir, rel))
  }
  return sha256CanonicalJson({ manifest: m, files: fileHashes })
}

export async function loadPack(dir: string): Promise<LoadedPack> {
  const v = await validatePackDir(dir)
  if (!v.ok || !v.manifest) throw new PackLoadError(`pack at ${dir} is invalid: ${v.issues.filter(i => i.level === 'error').map(i => `${i.path}: ${i.message}`).join('; ')}`, v.issues)
  return { dir: path.resolve(dir), manifest: v.manifest, digest: await computePackDigest(dir, v.manifest) }
}
