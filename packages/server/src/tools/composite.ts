import { readPackText } from '@starlight-intelligence/creator-packs-spec'
import * as z from 'zod/v4'
import { compositeToolSchema, fromJsonSchemaToZod, type CompositeTool } from '../json-schema.js'
import type { CreatorContext } from '@starlight-intelligence/creator-core'
import { textLine } from '../content.js'
import { toolError } from '../errors.js'
import type { AnyToolDef } from '../tool-def.js'

function fill(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => { const v = vars[key]; return v === undefined || v === null ? '' : String(v) })
}

export async function loadCompositeTools(ctx: CreatorContext, base: AnyToolDef[]): Promise<AnyToolDef[]> {
  const out: AnyToolDef[] = []
  const byName = new Map(base.map(t => [t.name, t]))
  for (const ref of ctx.merged.tools) {
    const def = compositeToolSchema.parse(JSON.parse(await readPackText(ref.dir, ref.path))) as CompositeTool
    for (const step of def.steps) if (step.kind === 'call' && !byName.has(step.tool)) throw new Error(`composite ${def.name} references unavailable built-in tool ${step.tool}`)
    const inputSchema = fromJsonSchemaToZod(def.input)
    out.push({
      name: def.name, title: def.name.replace(/_/g, ' '), description: `${def.description} (pack ${ref.packId})`,
      inputSchema, outputSchema: z.object({ steps: z.array(z.object({ kind: z.string(), ref: z.string(), output: z.unknown() })), text: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler(args, context, mcp) {
        const vars: Record<string, unknown> = { ...(args as Record<string, unknown>) }
        const steps: Array<{ kind: string; ref: string; output: unknown }> = []
        const texts: string[] = []
        for (const step of def.steps) {
          if (step.kind === 'template') {
            const t = context.merged.templates.get(step.template)
            if (!t) return toolError(`template ${step.template} not found in loaded packs`)
            const text = fill(await readPackText(t.dir, t.path), vars)
            vars.template = text; texts.push(text); steps.push({ kind: 'template', ref: step.template, output: text })
          } else if (step.kind === 'prompt') {
            const p = context.merged.prompts.get(step.prompt)
            if (!p) return toolError(`prompt ${step.prompt} not found in loaded packs`)
            const text = fill(stripFrontmatter(await readPackText(p.dir, p.path)), vars)
            vars.prompt = text; texts.push(text); steps.push({ kind: 'prompt', ref: step.prompt, output: text })
          } else {
            const target = byName.get(step.tool)
            if (!target) return toolError(`composite step references unknown tool ${step.tool}`)
            const callArgs = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, typeof v === 'string' ? fill(v, vars) : v]))
            const parsed = target.inputSchema.safeParse(callArgs)
            if (!parsed.success) return toolError(`composite step ${step.tool} has invalid args: ${parsed.error.issues.map(i => i.message).join('; ')}`)
            const res = await target.handler(parsed.data, context, mcp)
            if ('isError' in res && res.isError) return res
            const structured = 'structuredContent' in res ? res.structuredContent : undefined
            if (structured && typeof structured === 'object') for (const [k, v] of Object.entries(structured)) vars[`${step.tool}.${k}`] = v
            steps.push({ kind: 'call', ref: step.tool, output: structured ?? null })
          }
        }
        const result = { steps, text: texts.join('\n\n---\n\n') }
        return { content: [{ type: 'text', text: result.text || 'done' }, textLine({ steps: steps.map(s => ({ kind: s.kind, ref: s.ref })) })], structuredContent: result }
      },
    })
  }
  return out
}

function stripFrontmatter(text: string): string {
  return text.startsWith('---') ? text.replace(/^---[\s\S]*?\n---\s*\n?/, '') : text
}
