// Every repository under a folder: the folder's own (or the one it is in), repositories of their own nested inside
// it, submodules and linked worktrees. Each is told apart by what its `.git` is: a directory for a repository of its
// own, or a file naming where its git state is, under its parent's `modules/` for a submodule and its main
// repository's `worktrees/` for a linked worktree. Found by walking the folder, without running git.
import * as path from 'path'
import * as fs from 'fs/promises'
import type { FoundRepository } from './types.ts'

/** Folders not walked into: what a package manager installs holds repositories nobody opened */
const NOT_WALKED = new Set(['node_modules', '.git'])

/** How deep under the folder a repository is looked for, and how many folders are looked in at most */
export const FIND_DEPTH = 6
export const FIND_FOLDERS = 20_000

/** What a `.git` here is: a repository's own, a submodule's, a linked worktree's, or none */
async function gitHere(directory: string): Promise<'own' | 'submodule' | 'worktree' | undefined> {
  const dotGit = path.join(directory, '.git')
  const stats = await fs.lstat(dotGit).catch(() => undefined)
  if (!stats) return undefined
  if (stats.isDirectory()) return 'own'
  const named = /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim() ?? ''
  const parts = named.replaceAll('\\', '/').split('/')
  if (parts.includes('modules')) return 'submodule'
  if (parts.includes('worktrees')) return 'worktree'
  return 'own'
}

/**
 * The repositories under `folder`, the folder's own first and the rest by path. `truncated` when the walk stopped
 * at its bound before it had looked everywhere.
 */
export async function repositoriesUnder(folder: string): Promise<{ repositories: FoundRepository[]; truncated: boolean }> {
  const root = path.resolve(folder)
  const found: FoundRepository[] = []
  // The folder's own, or the repository it is inside
  let enclosing: string | undefined
  for (let at = root; ; at = path.dirname(at)) {
    if (await gitHere(at)) { enclosing = at; break }
    if (path.dirname(at) === at) break
  }
  if (enclosing) found.push({ path: enclosing, relative: path.relative(root, enclosing), kind: 'top' })
  let looked = 0
  let truncated = false
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (truncated) return
    if (++looked > FIND_FOLDERS) { truncated = true; return }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_WALKED.has(entry.name)) continue
      const child = path.join(directory, entry.name)
      const kind = await gitHere(child)
      if (kind) found.push({ path: child, relative: path.relative(root, child).replaceAll('\\', '/'), kind: kind === 'own' ? 'nested' : kind })
      if (depth < FIND_DEPTH) await walk(child, depth + 1)
    }
  }
  await walk(root, 1)
  const [top, ...rest] = found
  return { repositories: top ? [top, ...rest.sort((a, b) => a.relative.localeCompare(b.relative))] : rest, truncated }
}
