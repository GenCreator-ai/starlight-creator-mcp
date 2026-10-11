import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TasteScorer, type RubricRecord } from './scorer.js'
import { SandboxError } from '../fs/sandbox.js'
import type { Ledger } from '../ledger/interface.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'creator-rubric-')); roots.push(home)
  const dir = path.join(home, 'pack'); await mkdir(dir)
  await writeFile(path.join(home, 'outside.md'), 'outside synthetic fixture')
  await writeFile(path.join(dir, 'review.md'), 'in-pack reviewer')
  const rubric: RubricRecord = { id: 'review', kind: 'text', packId: 'fixture', dir, judge: { task: 'chat', quality: 'draft' }, dimensions: [{ id: 'quality', weight: 100 }], thresholds: { ship: 80, focused_pass: 60, draft: 40 }, autoFail: [] }
  const scorer = new TasteScorer({} as Ledger, async () => null)
  return { home, dir, rubric, scorer }
}
describe('rubric prompt containment', () => {
  it('rejects oversized rubric prompts before a judge call', async () => {
    const { dir, rubric, scorer } = await fixture()
    await writeFile(path.join(dir, 'large.md'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(scorer.buildPrompt({ ...rubric, promptFile: 'large.md' })).rejects.toThrow('8 MiB')
  })
  it('denies traversal and absolute paths even on direct scorer calls', async () => {
    const { home, rubric, scorer } = await fixture()
    for (const promptFile of ['../outside.md', path.join(home, 'outside.md'), 'C:\\outside.md', '\\\\server\\share']) {
      await expect(scorer.buildPrompt({ ...rubric, promptFile })).rejects.toBeInstanceOf(SandboxError)
    }
  })
  it('denies reads through an outward directory link', async () => {
    const { home, dir, rubric, scorer } = await fixture()
    await symlink(home, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(scorer.buildPrompt({ ...rubric, promptFile: 'link/outside.md' })).rejects.toBeInstanceOf(SandboxError)
  })
  it('preserves an in-pack prompt and the default persona', async () => {
    const { rubric, scorer } = await fixture()
    expect(await scorer.buildPrompt({ ...rubric, promptFile: 'review.md' })).toContain('in-pack reviewer')
    expect(await scorer.buildPrompt(rubric)).toContain('You are an exacting reviewer.')
  })
})
