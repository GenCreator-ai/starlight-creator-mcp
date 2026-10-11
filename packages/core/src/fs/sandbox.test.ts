import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertRealInside, isInside, SandboxError } from './sandbox.js'
import { LocalStorage } from '../storage/local.js'

async function linkedFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'creator-sandbox-'))
  const root = path.join(home, 'assets')
  const outside = path.join(home, 'outside')
  await mkdir(root); await mkdir(outside)
  await symlink(outside, path.join(root, 'aa'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, outside }
}

describe('real filesystem sandbox', () => {
  it('rejects a missing leaf under an existing outward directory link', async () => {
    const { root } = await linkedFixture()
    await expect(assertRealInside(root, path.join(root, 'aa', 'new', 'asset.png'))).rejects.toBeInstanceOf(SandboxError)
  })
  it('local storage denies writes and sidecars through outward parent links', async () => {
    const { root, outside } = await linkedFixture()
    const storage = new LocalStorage(root)
    const sha = 'a'.repeat(64)
    await expect(storage.put(sha, Buffer.from('fixture'), { mime: 'image/png', ext: 'png' })).rejects.toBeInstanceOf(SandboxError)
    await expect(storage.writeSidecar(sha, { fixture: true })).rejects.toBeInstanceOf(SandboxError)
    await expect(readFile(path.join(outside, sha + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(outside, sha + '.provenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('local storage does not read externally linked asset bytes or provenance', async () => {
    const { root, outside } = await linkedFixture()
    const sha = 'a'.repeat(64)
    await writeFile(path.join(outside, sha + '.png'), 'external fixture')
    await writeFile(path.join(outside, sha + '.provenance.json'), '{"fixture":true}')
    const storage = new LocalStorage(root)
    expect(await storage.get(sha, 'png')).toBeNull()
    expect(await storage.exists(sha, 'png')).toBe(false)
    expect(await storage.readSidecar(sha)).toBeNull()
  })
  it('preserves valid new storage roots and inward links', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'creator-sandbox-'))
    const root = path.join(home, 'new-assets')
    const storage = new LocalStorage(root); const sha = 'b'.repeat(64)
    await storage.put(sha, Buffer.from('fixture'), { mime: 'image/png', ext: 'png' })
    await storage.writeSidecar(sha, { fixture: true })
    expect(Buffer.from((await storage.get(sha, 'png'))!).toString()).toBe('fixture')
    expect(await storage.readSidecar(sha)).toEqual({ fixture: true })
    await symlink(path.join(root, 'bb'), path.join(root, 'inside'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await assertRealInside(root, path.join(root, 'inside', 'new.png'))).toBe(path.join(await realpath(path.join(root, 'bb')), 'new.png'))
  })
  it('fails closed when an existing component is not a directory', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'creator-sandbox-'))
    const root = path.join(home, 'assets'); await mkdir(root)
    await writeFile(path.join(root, 'file'), 'fixture')
    await expect(assertRealInside(root, path.join(root, 'file', 'child'))).rejects.toBeInstanceOf(SandboxError)
  })
  it.skipIf(process.platform === 'win32')('denies dangling links instead of treating them as new directories', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'creator-sandbox-'))
    const root = path.join(home, 'assets'); await mkdir(root)
    await symlink(path.join(home, 'not-created'), path.join(root, 'dangling'), 'dir')
    await expect(assertRealInside(root, path.join(root, 'dangling', 'new.png'))).rejects.toBeInstanceOf(SandboxError)
  })
  it('uses platform path semantics for case and filesystem roots', () => {
    expect(isInside(path.parse(process.cwd()).root, process.cwd())).toBe(true)
    const root = path.join(os.tmpdir(), 'CaseRoot')
    expect(isInside(root, path.join(os.tmpdir(), 'caseroot', 'asset'))).toBe(process.platform === 'win32')
    expect(isInside(root, root + '-sibling')).toBe(false)
  })
})
