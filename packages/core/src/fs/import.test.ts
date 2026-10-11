import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readSandboxFile } from './sandbox.js'

let home: string
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }) })
describe('bounded local file reads', () => {
  it('reads contained regular files and refuses links, traversal, streams and oversized inputs', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'creator-local-read-'))
    const root = path.join(home, 'root'), outside = path.join(home, 'outside')
    await mkdir(root); await mkdir(outside)
    await writeFile(path.join(root, 'safe.txt'), 'safe')
    await writeFile(path.join(root, 'large.txt'), 'too large')
    await writeFile(path.join(outside, 'private.txt'), 'private fixture')
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await readSandboxFile([root], 'safe.txt', 4)).toString()).toBe('safe')
    for (const rel of ['linked/private.txt', '../outside/private.txt', 'safe.txt:stream', '\\outside\\private.txt', 'large.txt', '.']) await expect(readSandboxFile([root], rel, 4)).rejects.toThrow()
    await expect(readSandboxFile([root], 'safe.txt', 0)).rejects.toThrow('byte limit')
  })
  it('tries another declared root only for a missing file', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'creator-local-read-'))
    const first = path.join(home, 'first'), second = path.join(home, 'second')
    await mkdir(first); await mkdir(second); await writeFile(path.join(second, 'fixture.txt'), 'fixture')
    expect((await readSandboxFile([first, second], 'fixture.txt', 10)).toString()).toBe('fixture')
    await writeFile(path.join(first, 'fixture.txt'), 'oversized fixture')
    await expect(readSandboxFile([first, second], 'fixture.txt', 10)).rejects.toThrow('byte limit')
  })
})
