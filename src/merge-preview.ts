// What a merge or a pull would do, before it is done: nothing, a fast-forward, a clean merge, or a merge that stops
// on conflicts in these files. Asked of `git merge-tree --write-tree`, which merges in the object store alone and
// moves no ref, no index and no file. A git without it (before 2.38) answers that it is not known.
import { refArgument } from './arguments.ts'
import { olderThan } from './git-check.ts'
import { failure, type GitRunner } from './runner.ts'
import type { MergePreview } from './types.ts'

/** The first git with `merge-tree --write-tree` */
export const MERGE_TREE_FROM = '2.38.0'

export class MergePreviews {
  constructor(private readonly runner: GitRunner) {}

  private async isAncestor(ancestor: string, of: string): Promise<boolean> {
    return (await this.runner.executeGitCommand(['merge-base', '--is-ancestor', ancestor, of])).success
  }

  /** What merging `target` into what is checked out would do; for a pull, `target` is the upstream after a fetch */
  async preview(target: string): Promise<MergePreview> {
    const into = 'HEAD'
    const named = refArgument(target, 'branch')
    const exists = await this.runner.executeGitCommand(['rev-parse', '--verify', '--quiet', `${named}^{commit}`])
    if (!exists.success) throw failure(exists, `${target} is not a commit here`)
    if (await this.isAncestor(named, into)) return { kind: 'up-to-date' }
    if (await this.isAncestor(into, named)) return { kind: 'fast-forward' }
    if (olderThan(await this.runner.passUsableGit(), MERGE_TREE_FROM)) return { kind: 'unknown' }
    const merged = await this.runner.executeGitCommand(['merge-tree', '--write-tree', '--name-only', '--no-messages', into, named])
    // Exit 1 is a merge that would stop on conflicts, and says so on its output: the tree, then each file
    const lines = (merged.output ?? '').split('\n').filter(Boolean)
    if (merged.success) return { kind: 'clean' }
    if (lines.length > 1 && /^[0-9a-f]{40,64}$/.test(lines[0]!)) return { kind: 'conflicts', files: [...new Set(lines.slice(1))] }
    throw failure(merged, `Failed to work out what merging ${target} would do`)
  }
}
