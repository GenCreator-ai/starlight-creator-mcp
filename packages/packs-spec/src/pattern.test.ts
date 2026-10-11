import { describe, expect, it } from 'vitest'
import { compilePackPattern, PackPatternError } from './pattern.js'
import { validatePackDir } from './validate.js'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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
})
