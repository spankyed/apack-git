// Path containment and checkout-root helpers: keeps every direct filesystem read, write or delete strictly inside
// the checkout, refusing `..` escapes, NUL bytes, sibling-prefix collisions and symlinked directory escapes.
import * as fs from 'fs/promises'
import * as path from 'path'
import { GitError } from './errors.ts'
import type { GitDirectories } from './types.ts'

/** Internal directory record carrying git's own `--show-toplevel` beside the public `GitDirectories` fields */
export interface LocatedDirectories extends GitDirectories {
  /** The working tree's root as git reported it (`--show-toplevel`); absent in a bare repository */
  top?: string
}

/**
 * `candidate` as a path relative to `root`, or `undefined` when `candidate` is outside `root`.
 * Uses `path.relative` rather than string prefix matching, so `/repo-other/a` is never mistaken for `/repo/a`.
 */
export function relativeWithin(root: string, candidate: string): string | undefined {
  const base = path.resolve(root)
  const target = path.resolve(candidate)
  const relative = path.relative(base, target)
  if (relative === '') return ''
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative
}

/** Lexical fallback for the checkout root when git did not report `--show-toplevel` */
export function fallbackTop(workingDirectory: string, directories: GitDirectories | null | undefined): string {
  return path.resolve(workingDirectory, ...(directories?.prefix ?? '').split('/').filter(Boolean).map(() => '..'))
}

/**
 * Resolves `given` inside `top` and verifies that neither lexical traversal (`..`) nor a symlinked ancestor
 * escapes `top`. With `followTargetSymlink`, the target itself (when it exists) must also resolve inside `top`
 * — used before writing or reading through a path, whereas unlinking a symlink itself only checks its parent.
 */
export async function resolveInsideTop(
  top: string,
  given: string,
  { base = top, followTargetSymlink = false }: { base?: string; followTargetSymlink?: boolean } = {},
): Promise<string> {
  if (!given || given.includes('\0')) throw new GitError(`Invalid path: ${JSON.stringify(given)}`)
  const resolvedTop = path.resolve(top)
  const resolved = path.isAbsolute(given) ? path.resolve(given) : path.resolve(base, given)
  if (relativeWithin(resolvedTop, resolved) === undefined) {
    throw new GitError(`Path escapes repository: ${given}`)
  }
  const realTop = await fs.realpath(resolvedTop).catch(() => resolvedTop)
  // Walk up from the target (or its parent when unlinking a symlink itself) to the nearest existing path
  let cursor = followTargetSymlink ? resolved : path.dirname(resolved)
  for (;;) {
    const real = await fs.realpath(cursor).catch(() => undefined)
    if (real !== undefined) {
      if (relativeWithin(realTop, real) === undefined) {
        throw new GitError(`Path escapes repository through a symbolic link: ${given}`)
      }
      break
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return resolved
}

/**
 * Converts a path handed to `readFileContent` / `readFileBytes` (relative to `workingDirectory` or checkout top, or
 * absolute inside `top`) to a normalized path relative to `workingDirectory` for git/fs reads, refusing escapes.
 */
export function normalizeReadPath(filePath: string, workingDirectory: string, top: string): { relativeToCwd: string; relativeToTop: string } {
  if (!filePath || filePath.includes('\0')) throw new GitError(`Invalid path: ${JSON.stringify(filePath)}`)
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workingDirectory, filePath)
  const relTop = relativeWithin(top, resolved)
  if (relTop === undefined) throw new GitError(`Path escapes repository: ${filePath}`)
  const relCwd = path.relative(path.resolve(workingDirectory), resolved)
  return {
    relativeToCwd: relCwd.split(path.sep).join('/'),
    relativeToTop: relTop.split(path.sep).join('/'),
  }
}

/** Stage-0 index object specifier for `git show`: unambiguous even when `repoPath` starts with `2:` or `-` */
export const stageZeroSpec = (repoPath: string): string => `:0:${repoPath}`
