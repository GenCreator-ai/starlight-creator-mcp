import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export class SandboxError extends Error {}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function resolveInside(root: string, rel: string): string {
  if (/^\\\\/.test(rel) || /^\/\//.test(rel)) throw new SandboxError('UNC paths are not allowed')
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new SandboxError(`absolute paths are not allowed: ${rel}`)
  if (rel.split(/[\\/]/).includes('..')) throw new SandboxError(`path traversal is not allowed: ${rel}`)
  const full = path.resolve(root, rel)
  if (!isInside(root, full)) throw new SandboxError(`path escapes sandbox: ${rel}`)
  return full
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
