import path from 'node:path'
import { canonSchema, registryOverridesSchema, voiceSchema, readPackText, loadPack, mergePacks, resolveCanonFiles, type LoadedPack, type MergedPack } from '@starlight-intelligence/creator-packs-spec'
import type { Logger } from '../log.js'

export interface CanonChunk { id: string; packId: string; file: string; heading: string; text: string; locked: boolean }

export interface LoadedPacks { merged: MergedPack; loaded: LoadedPack[]; canon: CanonIndex }

export async function loadPacks(dirs: string[], substrateVersion: string, opts: { log: Logger; licensedPackIds?: Set<string>; dev?: boolean }): Promise<LoadedPacks> {
  const loaded: LoadedPack[] = []
  for (const dir of dirs) {
    const pack = await loadPack(dir)
    const id = pack.manifest.id
    if (!pack.manifest.publicSafe && !opts.dev && !(opts.licensedPackIds?.has(id))) {
      opts.log.warn('pack requires a license; loading free sections only', { pack: id })
      loaded.push(restrictToFree(pack))
      continue
    }
    loaded.push(pack)
  }
  const merged = mergePacks(loaded, substrateVersion)
  const canon = await CanonIndex.build(merged)
  return { merged, loaded, canon }
}

function restrictToFree(pack: LoadedPack): LoadedPack {
  const free = new Set(pack.manifest.offer?.free ?? [])
  const m = { ...pack.manifest }
  if (!free.has('canon')) m.canon = canonSchema.parse({})
  if (!free.has('registry')) m.registry = registryOverridesSchema.parse({})
  if (!free.has('voice')) m.voice = voiceSchema.parse({})
  if (!free.has('rubrics')) m.rubrics = []
  if (!free.has('templates')) m.templates = []
  if (!free.has('prompts')) m.prompts = []
  if (!free.has('styles')) m.styles = []
  if (!free.has('tools')) m.tools = []
  if (!free.has('init')) delete m.init
  return { ...pack, manifest: m }
}

export class CanonIndex {
  private constructor(readonly chunks: CanonChunk[], private readonly declaredFiles: Array<{ packId: string; file: string; chunks: number; locked: boolean }>) {}

  static async build(merged: MergedPack): Promise<CanonIndex> {
    const chunks: CanonChunk[] = []
    const files = new Map<string, { packId: string; file: string; chunks: number; locked: boolean }>()
    const lockedFiles = new Set(merged.locked.map(l => path.resolve(l.dir, l.path)))
    for (const entry of merged.canonPaths) {
      for (const file of await resolveCanonFiles(entry.dir, [entry.pattern])) {
        const rel = path.relative(entry.dir, file).split(path.sep).join('/')
        const key = `${entry.packId}:${rel}`
        if (files.has(key)) continue
        const locked = lockedFiles.has(path.resolve(file))
        const metadata = { packId: entry.packId, file: rel, chunks: 0, locked }
        files.set(key, metadata)
        if (!/\.(md|markdown|txt)$/i.test(file)) continue
        const text = await readPackText(entry.dir, rel)
        const fileChunks = chunkMarkdown(text, entry.packId, rel, locked)
        metadata.chunks = fileChunks.length
        chunks.push(...fileChunks)
      }
    }
    return new CanonIndex(chunks, [...files.values()])
  }

  search(query: string, limit = 8, packId?: string): Array<CanonChunk & { score: number; excerpt: string }> {
    const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2)
    if (!terms.length) return []
    const scored = this.chunks.filter(c => !packId || c.packId === packId).map(c => {
      const hay = `${c.heading}\n${c.text}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        const inHeading = c.heading.toLowerCase().includes(t)
        const count = hay.split(t).length - 1
        score += count * (inHeading ? 3 : 1)
      }
      if (c.locked) score *= 1.5
      return { ...c, score, excerpt: excerptAround(c.text, terms[0]!) }
    }).filter(c => c.score > 0)
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  files(): Array<{ packId: string; file: string; chunks: number; locked: boolean }> {
    return this.declaredFiles.map(file => ({ ...file }))
  }
}

export function chunkMarkdown(text: string, packId: string, file: string, locked: boolean): CanonChunk[] {
  const lines = text.split(/\r?\n/)
  const chunks: CanonChunk[] = []
  let heading = file
  let buf: string[] = []
  let n = 0
  const flush = () => {
    const body = buf.join('\n').trim()
    for (let offset = 0; offset < body.length;) {
      let end = Math.min(offset + 4000, body.length)
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]!) && /[\uDC00-\uDFFF]/.test(body[end]!)) end--
      chunks.push({ id: `${packId}:${file}#${n++}`, packId, file, heading, text: body.slice(offset, end), locked })
      offset = end
    }
    buf = []
  }
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { flush(); heading = h[2]!.trim() } else buf.push(line)
  }
  flush()
  return chunks
}

function excerptAround(text: string, term: string, width = 240): string {
  const i = text.toLowerCase().indexOf(term)
  const start = Math.max(0, (i === -1 ? 0 : i) - width / 3)
  return text.slice(start, start + width).replace(/\s+/g, ' ').trim()
}
