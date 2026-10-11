import type { MergedPack, Rubric } from '@starlight-intelligence/creator-packs-spec'
import { PackPathError, readPackText, sha256Hex } from '@starlight-intelligence/creator-packs-spec'
import { ulid } from '../ids.js'
import type { Ledger } from '../ledger/interface.js'
import type { Provider } from '../provider/interface.js'
import type { Score, TextRequest } from '../types.js'
import { SandboxError } from '../fs/sandbox.js'

export interface JudgeTarget { kind: 'image' | 'text'; bytes?: Uint8Array; mime?: string; text?: string; sha256?: string }

export type RubricRecord = Rubric & { packId: string; dir: string }

export class TasteScorer {
  constructor(private readonly ledger: Ledger, private readonly judge: () => Promise<{ provider: Provider; model?: string } | null>) {}

  rubricFor(merged: MergedPack, kind: 'image' | 'video' | 'text' | 'audio', rubricId?: string): RubricRecord {
    const id = rubricId ?? merged.defaultRubric[kind]
    if (!id) throw new Error(`no ${kind} rubric loaded; add one to a pack or pass rubric`)
    const r = merged.rubrics.get(id)
    if (!r) throw new Error(`rubric ${id} not found; available: ${[...merged.rubrics.keys()].join(', ')}`)
    return r
  }

  async buildPrompt(rubric: RubricRecord): Promise<string> {
    let persona = 'You are an exacting reviewer.'
    if (rubric.promptFile) {
      try { persona = await readPackText(rubric.dir, rubric.promptFile) }
      catch (error) { if (error instanceof PackPathError) throw new SandboxError(error.message); throw error }
    }
    const dims = rubric.dimensions.map(d => `- ${d.id} (weight ${d.weight}${d.invert ? ', higher = worse' : ''})${d.guidance ? `: ${d.guidance}` : ''}`).join('\n')
    const autoFail = rubric.autoFail.length ? `\nAuto-fail conditions (set auto_failed to the matching strings when present): ${rubric.autoFail.join('; ')}` : ''
    return `${persona.trim()}\n\nScore each dimension 0-100:\n${dims}${autoFail}\n\nRespond with JSON only: {"dims":{"<id>":number},"strengths":[string],"weaknesses":[string],"auto_failed":[string]}`
  }

  aggregate(rubric: RubricRecord, raw: { dims: Record<string, number>; strengths?: string[]; weaknesses?: string[]; auto_failed?: string[] }, judge: string): Score {
    let total = 0
    const dims: Record<string, number> = {}
    for (const d of rubric.dimensions) {
      const v = Math.max(0, Math.min(100, Number(raw.dims[d.id] ?? 0)))
      const effective = d.invert ? 100 - v : v
      dims[d.id] = v
      total += (effective * d.weight) / 100
    }
    const autoFailed = (raw.auto_failed ?? []).filter(Boolean)
    const score = Math.round(autoFailed.length ? Math.min(total, 30) : total)
    const t = rubric.thresholds
    const shipDecision: Score['shipDecision'] = score >= t.ship ? 'ship' : score >= t.focused_pass ? 'focused-pass' : score >= t.draft ? 'draft' : 'restart'
    return { score, dims, strengths: raw.strengths ?? [], weaknesses: raw.weaknesses ?? [], shipDecision, rubricId: rubric.id, judge, ...(autoFailed.length ? { autoFailed } : {}) }
  }

  async score(target: JudgeTarget, rubric: RubricRecord, merged: MergedPack, judgeModel?: string): Promise<Score> {
    const judge = await this.judge()
    if (!judge || !judge.provider.text) throw new Error('no judge provider configured (OpenRouter or Gemini key); scoring unavailable')
    const prompt = await this.buildPrompt(rubric)
    const content: TextRequest['messages'][number]['content'] = []
    if (target.kind === 'image' && target.bytes) content.push({ type: 'image', bytes: target.bytes, mime: target.mime ?? 'image/png' })
    content.push({ type: 'text', text: target.kind === 'text' ? `Text to review:\n\n${target.text ?? ''}` : 'Review the attached image.' })
    const req: TextRequest = { system: prompt, messages: [{ role: 'user', content }], json: true, temperature: 0, maxTokens: 1200, ...(judgeModel ? { model: judgeModel } : judge.model ? { model: judge.model } : rubric.judge.model ? { model: rubric.judge.model } : {}) }
    const res = await judge.provider.text(req)
    const parsed = parseJudgeJson(res.text)
    const score = this.aggregate(rubric, parsed, res.model)
    const textSha = target.kind === 'text' ? sha256Hex(target.text ?? '') : undefined
    this.ledger.addScore({ id: ulid(), ...(target.sha256 ? { sha256: target.sha256 } : {}), ...(textSha ? { textSha } : {}), rubricId: rubric.id, packDigest: merged.digest, score: score.score, dims: score.dims, judge: res.model, createdAt: new Date().toISOString(), detail: score })
    return score
  }
}

export function parseJudgeJson(text: string): { dims: Record<string, number>; strengths?: string[]; weaknesses?: string[]; auto_failed?: string[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`judge returned no JSON: ${text.slice(0, 120)}`)
  const obj = JSON.parse(text.slice(start, end + 1)) as { dims?: Record<string, number>; strengths?: string[]; weaknesses?: string[]; auto_failed?: string[] }
  if (!obj.dims || typeof obj.dims !== 'object') throw new Error('judge JSON has no dims')
  return { dims: obj.dims, ...(obj.strengths ? { strengths: obj.strengths } : {}), ...(obj.weaknesses ? { weaknesses: obj.weaknesses } : {}), ...(obj.auto_failed ? { auto_failed: obj.auto_failed } : {}) }
}
