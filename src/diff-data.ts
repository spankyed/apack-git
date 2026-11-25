// Diffs as data: how many lines each changed file adds and removes, in the working tree and in a commit or a stash,
// and which files a commit or a stash changed. Each is git's own count (`--numstat`), read in one command for every
// file at once.
import { commitArgument, stashArgument } from './arguments.js'
import { failure, type GitRunner } from './runner.js'
import type { ChangedFile, LineCount } from './types.js'

/** The letter git names a change by, as a status names it */
const STATUS_OF: Record<string, ChangedFile['status']> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'typechange' }

/**
 * `--numstat -z` records, as `{ path, added, removed }`: `added\tremoved\tpath\0`, or for a rename or a copy
 * `added\tremoved\t\0from\0to\0`, and `-` for both counts of a file that is not text
 */
export function parseNumstat(output: string): (LineCount & { originalPath?: string })[] {
  const fields = output.split('\0')
  const counts: (LineCount & { originalPath?: string })[] = []
  for (let at = 0; at < fields.length; at++) {
    const record = fields[at]
    if (!record) continue
    const [added, removed, ...rest] = record.split('\t')
    if (added === undefined || removed === undefined) continue
    const named = rest.join('\t')
    const binary = added === '-' && removed === '-'
    const addedNum = binary ? 0 : Number(added)
    const removedNum = binary ? 0 : Number(removed)
    if (!Number.isFinite(addedNum) || !Number.isFinite(removedNum)) continue
    const count = { added: addedNum, removed: removedNum, binary }
    if (named) {
      counts.push({ path: named, ...count })
    } else {
      // A rename or a copy: where it came from, then where it went, as the next two fields
      if (at + 2 >= fields.length) break
      const originalPath = fields[++at]!
      const targetPath = fields[++at]!
      if (!targetPath) continue
      counts.push({ path: targetPath, originalPath, ...count })
    }
  }
  return counts
}

/** `--name-status -z` records, as `{ path, status, originalPath? }` */
function parseNameStatus(output: string): Pick<ChangedFile, 'path' | 'status' | 'originalPath'>[] {
  const fields = output.split('\0')
  const files: Pick<ChangedFile, 'path' | 'status' | 'originalPath'>[] = []
  for (let at = 0; at < fields.length; at++) {
    const letter = fields[at]
    if (!letter) continue
    const status = STATUS_OF[letter[0]!] ?? 'modified'
    if (letter[0] === 'R' || letter[0] === 'C') {
      if (at + 2 >= fields.length) break
      const originalPath = fields[++at]!
      const targetPath = fields[++at]!
      if (!targetPath) continue
      files.push({ path: targetPath, status, originalPath })
    } else {
      if (at + 1 >= fields.length) break
      const targetPath = fields[++at]!
      if (!targetPath) continue
      files.push({ path: targetPath, status })
    }
  }
  return files
}

export class DiffData {
  constructor(private readonly runner: GitRunner) {}

  /**
   * How many lines each changed file adds and removes: of what is staged against the last commit, and of the
   * working tree against what is staged, as the status lists them. A file git does not track yet has no count.
   */
  async lineCounts(): Promise<(LineCount & { staged: boolean })[]> {
    const [unstaged, staged] = await Promise.all([
      this.runner.read(['diff', '--numstat', '-z', '-M']),
      this.runner.read(['diff', '--cached', '--numstat', '-z', '-M']),
    ])
    if (!unstaged.success) throw failure(unstaged, 'Failed to count the changed lines')
    if (!staged.success) throw failure(staged, 'Failed to count the staged lines')
    return [
      ...parseNumstat(staged.output ?? '').map(({ originalPath: _from, ...count }) => ({ ...count, staged: true })),
      ...parseNumstat(unstaged.output ?? '').map(({ originalPath: _from, ...count }) => ({ ...count, staged: false })),
    ]
  }

  /** The files `from` and `to` differ in, each with its count, renames found */
  private async between(from: string | undefined, to: string): Promise<ChangedFile[]> {
    const range = from === undefined ? ['--root', to] : [from, to]
    const [named, counted] = await Promise.all([
      this.runner.read(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', ...range]),
      this.runner.read(['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--numstat', ...range]),
    ])
    if (!named.success) throw failure(named, `Failed to read what ${to} changed`)
    if (!counted.success) throw failure(counted, `Failed to count what ${to} changed`)
    const counts = new Map(parseNumstat(counted.output ?? '').map(count => [count.path, count]))
    return parseNameStatus(named.output ?? '').map(file => ({
      ...file,
      added: counts.get(file.path)?.added ?? 0,
      removed: counts.get(file.path)?.removed ?? 0,
      binary: counts.get(file.path)?.binary ?? false,
    }))
  }

  /** The commits a revision has as parents, first first */
  private async parentsOf(revision: string): Promise<string[]> {
    const listed = await this.runner.read(['rev-list', '--parents', '-n', '1', revision, '--'])
    if (!listed.success) throw failure(listed, `${revision} is not a commit here`)
    return (listed.output ?? '').trim().split(' ').slice(1)
  }

  /** The files a commit changed against its first parent, or all it holds when it has none, each with its count */
  async changesIn(commit: string): Promise<ChangedFile[]> {
    const revision = commitArgument(commit)
    const [parent] = await this.parentsOf(revision)
    return this.between(parent, revision)
  }

  /**
   * The files a stash holds, against the commit it was made on, each with its count: what was changed, and what it
   * kept of the files git did not track, which are added. Read without applying it.
   */
  async readStashChanges(index: number): Promise<ChangedFile[]> {
    const stash = stashArgument(index)
    const parents = await this.parentsOf(stash)
    const changed = await this.between(parents[0], stash)
    // A stash made with its untracked files holds them as a third parent, a commit of only them
    const untracked = parents[2] ? (await this.between(undefined, parents[2])).map(file => ({ ...file, status: 'added' as const })) : []
    return [...changed, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
  }
}
