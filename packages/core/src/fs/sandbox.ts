import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

export class SandboxError extends Error {}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function resolveInside(root: string, rel: string): string {
  if (/^\\\\/.test(rel) || /^\/\//.test(rel)) throw new SandboxError('UNC paths are not allowed')
  if (/^[\\/]/.test(rel) || /[:\0]/.test(rel) || path.isAbsolute(rel)) throw new SandboxError(`absolute paths and alternate streams are not allowed: ${rel}`)
  if (rel.split(/[\\/]/).includes('..')) throw new SandboxError(`path traversal is not allowed: ${rel}`)
  const full = path.resolve(root, rel)
  if (!isInside(root, full)) throw new SandboxError(`path escapes sandbox: ${rel}`)
  return full
}

/** Bounded regular-file read from operator-owned roots, with point-of-use containment. */
export async function readSandboxFile(roots: readonly string[], rel: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SandboxError('invalid local file byte limit')
  for (const root of roots) {
    const full = await assertRealInside(root, resolveInside(root, rel))
    let handle
    try {
      if (!(await lstat(full)).isFile()) throw new SandboxError('local input must be a regular file')
      handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0)))
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new SandboxError('local input must be a regular file')
      if (info.size > maxBytes) throw new SandboxError('local input exceeds byte limit')
      const chunks: Buffer[] = []; let size = 0
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (!bytesRead) break
        size += bytesRead
        if (size > maxBytes) throw new SandboxError('local input exceeds byte limit')
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks, size)
    } finally { await handle.close() }
  }
  throw new SandboxError('local file not found in allowed roots')
}

/** Resolve existing ancestors too: a new leaf can still sit under an outward link. */
async function realWithMissingLeaf(full: string): Promise<string> {
  let candidate = path.resolve(full)
  const missing: string[] = []
  for (;;) {
    try {
      const real = await realpath(candidate)
      if (missing.length && !(await lstat(real)).isDirectory()) throw new SandboxError('Sandbox parent is not a directory')
      return path.join(real, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SandboxError('Cannot resolve sandbox path')
      // A dangling link is not an ordinary uncreated directory.
      try {
        if ((await lstat(candidate)).isSymbolicLink()) throw new SandboxError('Cannot resolve sandbox link')
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      const parent = path.dirname(candidate)
      if (parent === candidate) throw new SandboxError('Cannot resolve sandbox root')
      missing.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}

export async function assertRealInside(root: string, full: string): Promise<string> {
  const realRoot = await realWithMissingLeaf(root)
  const real = await realWithMissingLeaf(full)
  if (!isInside(realRoot, real)) throw new SandboxError(`path escapes sandbox via link: ${full}`)
  return real
}
