import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export class PackPathError extends Error {}
export const MAX_PACK_FILE_BYTES = 8 * 1024 * 1024

/** Portable lexical checks include Windows roots and alternate data streams. */
export function resolvePackPath(root: string, rel: string): string {
  if (!rel || /^[\\/]/.test(rel) || /[:\0]/.test(rel) || rel.split(/[\\/]/).includes('..')) throw new PackPathError('invalid relative pack path')
  const full = path.resolve(root, ...rel.split(/[\\/]/))
  if (!inside(root, full)) throw new PackPathError('path escapes pack directory')
  return full
}
function inside(root: string, full: string): boolean {
  const rel = path.relative(root, full)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`))
}
export async function checkedPackPath(root: string, rel: string, kind: 'file' | 'directory' = 'file'): Promise<string> {
  const lexical = resolvePackPath(root, rel)
  const realRoot = await realpath(root), real = await realpath(lexical)
  if (!inside(realRoot, real)) throw new PackPathError('path escapes pack directory via link')
  const info = await stat(real)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new PackPathError(`pack reference must be a regular ${kind}`)
  return real
}
/** Check at each read, not just at manifest validation. Parents must remain operator-owned. */
export async function readPackFile(root: string, rel: string): Promise<Buffer> {
  const file = await checkedPackPath(root, rel)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new PackPathError('pack reference must be a regular file')
    if (info.size > MAX_PACK_FILE_BYTES) throw new PackPathError('pack file exceeds 8 MiB limit')
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_PACK_FILE_BYTES + 1 - size))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_PACK_FILE_BYTES) throw new PackPathError('pack file exceeds 8 MiB limit')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, size)
  } finally { await handle.close() }
}
export async function readPackText(root: string, rel: string): Promise<string> { return (await readPackFile(root, rel)).toString('utf8') }
