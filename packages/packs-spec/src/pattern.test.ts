import { describe, expect, it } from 'vitest'
import { compilePackPattern, PackPatternBudget, PackPatternError } from './pattern.js'
import { validatePackDir } from './validate.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { lintText } from './canon-lint.js'
import { mergePacks } from './merge.js'
import { canonSchema, registryOverridesSchema } from './schema.js'

const starter = path.resolve(fileURLToPath(import.meta.url), '../../../../packs/starter')
describe('bounded pack patterns', () => {
  it('rejects nested repetition, lookarounds, backreferences and empty alternatives', () => {
    for (const pattern of ['(a+)+b', '(a|aa)+b', 'a.*b', '(?=secret)', '(a)\\1', 'a|', '\\w*', 'a'.repeat(513)]) {
      expect(() => compilePackPattern(pattern), pattern).toThrow(PackPatternError)
    }
  })
  it('preserves shipped starter routing and case-insensitive word boundaries', async () => {
    const pack = JSON.parse(await readFile(path.join(starter, 'pack.json'), 'utf8'))
    const pattern: string = pack.registry.intents[0].pattern
    for (const prompt of ['a logo for a bakery', 'typography poster', 'LOGO', 'text reads hello', 'logotype', 'astypography', 'landscape', 'the words hello']) {
      expect([...compilePackPattern(pattern)(prompt)].length > 0, prompt).toBe(new RegExp(pattern, 'i').test(prompt))
    }
    expect((await validatePackDir(starter)).ok).toBe(true)
  })
  it('preserves whitespace gaps, all matches and original indices', () => {
    const pattern = '11th\\s+gate|gate\\s+11'
    const text = '11th\tGATE and gate  11.'
    expect([...compilePackPattern(pattern)(text)]).toEqual([{ index: 0, text: '11th\tGATE' }, { index: 14, text: 'gate  11' }])
    expect([...compilePackPattern('logo')('İ logo')][0]?.index).toBe(2)
  })
  it('bounds input and completes a long nonmatching adversarial prompt', () => {
    expect([...compilePackPattern('\\b(a|typograph\\w*)\\b')('a'.repeat(65_536))]).toEqual([])
    expect(() => [...compilePackPattern('logo')('a'.repeat(65_537))]).toThrow(PackPatternError)
  })
  it('bounds comparisons for a long nearly-matching literal', () => {
    expect(() => [...compilePackPattern('a'.repeat(480) + 'b')('a'.repeat(65_536))]).toThrow(/work budget/)
  })
  it('checks a maximum-size input against 256 impossible canon rules without repeated full scans', () => {
    const merged = mergePacks([], '0.1.0')
    merged.forbiddenPatterns = Array.from({ length: 256 }, () => ({ packId: 'test', pattern: 'x', message: 'not allowed' }))
    expect(lintText('a'.repeat(65_536), merged)).toEqual({ ok: true, findings: [], unknownEntities: [] })
  })
  it('still shares the cap for a costly collection of near-matches', () => {
    const merged = mergePacks([], '0.1.0')
    merged.forbiddenPatterns = Array.from({ length: 16 }, () => ({ packId: 'test', pattern: 'aaaaab', message: 'not allowed' }))
    expect(() => lintText('a'.repeat(65_536), merged)).toThrow(/work budget/)
  })
  it('preserves ordered alternatives and nonoverlapping matches with a shared input index', () => {
    const patterns = ['b|a', 'a|aa', 'aa|a', '\\b(logo|typograph\\w*)\\b', '11th\\s+gate|gate\\s+11', 'a b|b a', 'z|logo']
    const text = 'b aa a logo LOGOTYPE typography gate  11 and 11th\tGATE a b b a z logo'
    const budget = new PackPatternBudget()
    for (const pattern of patterns) {
      const expected = [...text.matchAll(new RegExp(pattern, 'gi'))].map(match => ({ index: match.index, text: match[0] }))
      expect([...compilePackPattern(pattern)(text, budget)], pattern).toEqual(expected)
    }
  })
  it('does not reuse a stale input index when a budget sees different text', () => {
    const budget = new PackPatternBudget(), matcher = compilePackPattern('logo')
    expect([...matcher('nothing', budget)]).toEqual([])
    expect([...matcher('a LOGO', budget)]).toEqual([{ index: 2, text: 'LOGO' }])
    expect([...matcher('nothing', budget)]).toEqual([])
  })
  it('rejects excessive intent and forbidden-pattern collections at manifest parsing', () => {
    expect(registryOverridesSchema.safeParse({ intents: Array.from({ length: 257 }, () => ({ id: 'test', task: 't2i', pattern: 'x', preferenceKey: 't2i:high' })) }).success).toBe(false)
    expect(canonSchema.safeParse({ forbiddenPatterns: Array.from({ length: 257 }, () => ({ pattern: 'x', message: 'no' })) }).success).toBe(false)
  })
})
