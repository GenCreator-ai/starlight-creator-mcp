import { readPackText } from '@starlight-intelligence/creator-packs-spec'
import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import type { CreatorContext } from '@starlight-intelligence/creator-core'

interface PromptFrontmatter { name?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }

export function parsePromptFile(text: string): { meta: PromptFrontmatter; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const fm = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  const meta: PromptFrontmatter = {}
  const args: PromptFrontmatter['arguments'] = []
  let current: { name: string; description?: string; required?: boolean } | null = null
  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const top = /^(name|description):\s*(.*)$/.exec(line)
    if (top) { (meta as Record<string, string>)[top[1]!] = top[2]!.trim(); continue }
    const item = /^\s*-\s*name:\s*(.+)$/.exec(line)
    if (item) { current = { name: item[1]!.trim() }; args.push(current); continue }
    const sub = /^\s+(description|required):\s*(.+)$/.exec(line)
    if (sub && current) { if (sub[1] === 'required') current.required = sub[2]!.trim() === 'true'; else current.description = sub[2]!.trim() }
  }
  if (args.length) meta.arguments = args
  return { meta, body }
}

export async function registerPrompts(server: McpServer, ctx: CreatorContext): Promise<number> {
  let n = 0
  for (const [id, p] of ctx.merged.prompts) {
    const { meta, body } = parsePromptFile(await readPackText(p.dir, p.path))
    const shape: Record<string, z.ZodType> = {}
    for (const a of meta.arguments ?? []) { let t: z.ZodType = z.string(); if (a.description) t = t.describe(a.description); shape[a.name] = a.required ? t : t.optional() }
    server.registerPrompt(meta.name ?? id, { title: meta.name ?? id, description: meta.description ?? p.description ?? `Prompt ${id} from pack ${p.packId}`, argsSchema: shape }, (args: Record<string, unknown>) => {
      const text = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => (typeof args[k] === 'string' ? (args[k] as string) : ''))
      return { messages: [{ role: 'user', content: { type: 'text', text } }] }
    })
    n++
  }
  return n
}
