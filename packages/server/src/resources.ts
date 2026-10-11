import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { readPackText } from '@starlight-intelligence/creator-packs-spec'
import type { CreatorContext } from '@starlight-intelligence/creator-core'

function canonMimeType(file: string): string | null {
  if (/\.(md|markdown)$/i.test(file)) return 'text/markdown'
  if (/\.txt$/i.test(file)) return 'text/plain'
  if (/\.json$/i.test(file)) return 'application/json'
  return null
}

export function registerResources(server: McpServer, ctx: CreatorContext): void {
  const m = ctx.merged

  server.registerResource('pack-manifest', new ResourceTemplate('pack://{packId}/manifest', {
    list: async () => ({ resources: m.packs.map(p => ({ uri: `pack://${p.id}/manifest`, name: `${p.name} manifest`, mimeType: 'application/json' })) }),
  }), { title: 'Pack manifest', description: 'Merged view of a loaded pack: rubrics, styles, templates, prompts, voice, registry preferences.' }, async (uri, vars) => {
    const packId = String(vars.packId)
    const pack = m.packs.find(p => p.id === packId)
    if (!pack) throw new Error(`pack ${packId} not loaded`)
    const body = {
      ...pack, rubrics: [...m.rubrics.values()].filter(r => r.packId === packId).map(({ dir: _d, ...r }) => r), styles: [...m.styles.values()].filter(s => s.packId === packId),
      templates: [...m.templates.entries()].filter(([, t]) => t.packId === packId).map(([id, t]) => ({ id, path: t.path, kind: t.kind, tags: t.tags })),
      prompts: [...m.prompts.entries()].filter(([, p]) => p.packId === packId).map(([id, p]) => ({ id, path: p.path })),
      canon: ctx.packs.canon.files().filter(f => f.packId === packId), voice: m.voice, registry: m.registry,
    }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] }
  })

  server.registerResource('pack-canon', new ResourceTemplate('pack://{packId}/canon/{+file}', {
    list: async () => {
      const out: Array<{ uri: string; name: string; mimeType: string }> = []
      for (const file of ctx.packs.canon.files()) {
        const mimeType = canonMimeType(file.file)
        if (mimeType) out.push({ uri: `pack://${file.packId}/canon/${file.file}`, name: file.locked ? `${file.file} (locked)` : file.file, mimeType })
      }
      for (const l of m.locked) {
        const mimeType = canonMimeType(l.path)
        if (mimeType && !out.some(o => o.uri === `pack://${l.packId}/canon/${l.path}`)) out.unshift({ uri: `pack://${l.packId}/canon/${l.path}`, name: `${l.path} (locked)`, mimeType })
      }
      return { resources: out }
    },
  }), { title: 'Pack canon file', description: 'A canon document from a loaded pack. Locked files are the source of truth.' }, async (uri, vars) => {
    const packId = String(vars.packId)
    const pack = m.packs.find(p => p.id === packId)
    if (!pack) throw new Error(`pack ${packId} not loaded`)
    const rel = String(vars.file)
    const mimeType = canonMimeType(rel)
    if (!mimeType) throw new Error('file is not a supported text canon resource')
    if (!ctx.packs.canon.files().some(f => f.packId === packId && f.file === rel) && !m.locked.some(f => f.packId === packId && f.path === rel)) throw new Error('canon file not declared by this pack')
    const text = await readPackText(pack.dir, rel)
    return { contents: [{ uri: uri.href, mimeType, text }] }
  })

  server.registerResource('pack-template', new ResourceTemplate('pack://{packId}/templates/{templateId}', {
    list: async () => ({ resources: [...m.templates.entries()].map(([id, t]) => ({ uri: `pack://${t.packId}/templates/${id}`, name: id, mimeType: 'text/markdown' })) }),
  }), { title: 'Pack template' }, async (uri, vars) => {
    const t = m.templates.get(String(vars.templateId))
    if (!t || t.packId !== String(vars.packId)) throw new Error(`template ${String(vars.templateId)} not found`)
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readPackText(t.dir, t.path) }] }
  })

  server.registerResource('pack-rubric', new ResourceTemplate('pack://{packId}/rubrics/{rubricId}', {
    list: async () => ({ resources: [...m.rubrics.values()].map(r => ({ uri: `pack://${r.packId}/rubrics/${r.id}`, name: r.id, mimeType: 'application/json' })) }),
  }), { title: 'Pack rubric' }, async (uri, vars) => {
    const r = m.rubrics.get(String(vars.rubricId))
    if (!r || r.packId !== String(vars.packId)) throw new Error(`rubric ${String(vars.rubricId)} not found`)
    const { dir, ...rest } = r
    const prompt = r.promptFile ? await readPackText(dir, r.promptFile) : null
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...rest, prompt }, null, 2) }] }
  })

  server.registerResource('asset', new ResourceTemplate('creator://assets/{sha256}', { list: undefined }), { title: 'Ledger asset', description: 'Bytes of an asset by sha256 (images/video/audio as blob) or its provenance when suffixed with .provenance.json' }, async (uri, vars) => {
    const ref = String(vars.sha256)
    if (ref.endsWith('.provenance.json')) {
      const row = ctx.ledger.getAsset(ref.replace('.provenance.json', ''))
      if (!row) throw new Error('asset not found')
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(row.provenance, null, 2) }] }
    }
    const row = ctx.ledger.findAsset(ref)
    if (!row) throw new Error('asset not found')
    const data = await ctx.assets.bytes(row.sha256)
    if (!data) throw new Error('asset bytes unavailable')
    return { contents: [{ uri: uri.href, mimeType: data.mime, blob: Buffer.from(data.bytes).toString('base64') }] }
  })

  server.registerResource('job', new ResourceTemplate('creator://jobs/{jobId}', { list: undefined }), { title: 'Generation job' }, async (uri, vars) => {
    const job = ctx.ledger.getJob(String(vars.jobId))
    if (!job) throw new Error('job not found')
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(job, null, 2) }] }
  })
}
