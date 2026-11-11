// What a discard removes, kept. Discarding a changed file checks it out again, and discarding an untracked file
// or folder deletes it: before either, what is about to go is written into git's object store as a tree, built
// with an index of its own, and named by that tree's id. `restore` puts it back.
//
// The user's index, refs and stash are not touched, in either direction. Nothing refers to the tree, so git
// keeps it for as long as it keeps objects nothing refers to: two weeks, unless the user's settings or a prune
// say otherwise (`gc.pruneExpire`).
import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as fs from 'fs/promises'
import { rowSpec } from './arguments.ts'
import { GitError } from './errors.ts'
import type { RepositoryModel } from './model.ts'
import { failure, type GitRunner } from './runner.ts'
import { splitStatus } from './status.ts'
import type { DiscardKept, DiscardRestored } from './types.ts'

/** The largest file a discard keeps a copy of. A larger one is removed without one, and the answer says so */
export const KEPT_FILE_LIMIT = 10 * 1024 * 1024

export class DiscardStore {
  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel) {}

  /** The top of the checkout, which a row's path is from, and where git keeps this checkout's own state */
  private async where(): Promise<{ top: string; gitDir: string }> {
    const directories = this.model.gitDirectories ?? await this.model.resolveGitDirectories()
    if (!directories) throw new GitError('Not a git repository', 'not-a-repository')
    return {
      top: path.resolve(this.runner.workingDirectory, ...directories.prefix.split('/').filter(Boolean).map(() => '..')),
      gitDir: directories.gitDir,
    }
  }

  /**
   * The files discarding these rows would change or remove, from the top of the checkout, each with its size. A
   * row that names a folder git tracks nothing in stands for what git lists in it, which is what a discard of
   * it removes. A path with no file is a deletion being discarded, which removes nothing.
   */
  private async filesOf(rows: string[], top: string): Promise<{ file: string; size: number }[]> {
    const named = new Set<string>()
    for (const row of rows) {
      if (!row.endsWith('/')) {
        named.add(row)
        continue
      }
      const listed = await this.runner.executeGitCommand(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', rowSpec(row)])
      if (!listed.success) throw failure(listed, `Failed to list the folder: ${row}`)
      for (const file of (listed.output ?? '').split('\0')) if (file && !file.endsWith('/')) named.add(file)
    }
    const found = await Promise.all([...named].map(async (file) => {
      const stats = await fs.lstat(path.join(top, file)).catch(() => undefined)
      // A folder here is a repository of its own inside an untracked one, which git neither lists into nor removes
      return stats && !stats.isDirectory() ? [{ file, size: stats.size }] : []
    }))
    return found.flat()
  }

  /** Runs git over an index of its own, made for this and removed after: the user's is neither read nor written */
  private async withOwnIndex<T>(gitDir: string, work: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const index = path.join(gitDir, `apack-kept-${randomUUID()}.index`)
    try {
      return await work({ GIT_INDEX_FILE: index })
    } finally {
      await Promise.all([index, `${index}.lock`].map(file => fs.rm(file, { force: true })))
    }
  }

  /** The paths, among what discarding these rows would remove, that are too large to keep a copy of */
  async notKeptOf(rows: string[]): Promise<string[]> {
    const { top } = await this.where()
    return (await this.filesOf(rows, top)).filter(({ size }) => size > KEPT_FILE_LIMIT).map(({ file }) => file).sort()
  }

  /**
   * Keeps what discarding these rows is about to remove, before it does. Throws when the copy could not be
   * taken, so that whoever is discarding removes nothing they could not get back without having been told.
   */
  async keep(rows: string[]): Promise<DiscardKept> {
    const { top, gitDir } = await this.where()
    const files = await this.filesOf(rows, top)
    const kept = files.filter(({ size }) => size <= KEPT_FILE_LIMIT).map(({ file }) => file)
    const notKept = files.filter(({ size }) => size > KEPT_FILE_LIMIT).map(({ file }) => file).sort()
    if (kept.length === 0) return { notKept }
    const id = await this.withOwnIndex(gitDir, async (env) => {
      // Each path as it is spelled, from the top, and on the input: there may be more than a command line holds
      const added = await this.runner.executeGitCommand(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: kept.map(rowSpec).join('\0') })
      if (!added.success) throw failure(added, 'Could not keep a copy of what would be removed, so nothing was removed')
      const written = await this.runner.executeGitCommand(['write-tree'], { env })
      if (!written.success || !written.output?.trim()) throw failure(written, 'Could not keep a copy of what would be removed, so nothing was removed')
      return written.output.trim()
    })
    return { id, notKept }
  }

  /**
   * Puts back what a discard kept. A path that has changed in the working tree since, or been made again, is
   * left as it is and named: what is there now is not overwritten.
   */
  async restore(id: string): Promise<DiscardRestored> {
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error(`Invalid id of a kept discard: ${JSON.stringify(id)}`)
    const { top, gitDir } = await this.where()
    const kind = await this.runner.executeGitCommand(['cat-file', '-t', id])
    if (!kind.success || kind.output?.trim() !== 'tree') {
      throw new GitError('What that discard removed is no longer kept: git has pruned it, as it does objects nothing refers to.')
    }
    const listed = await this.runner.executeGitCommand(['ls-tree', '-r', '-z', '--name-only', '--full-tree', id])
    if (!listed.success) throw failure(listed, 'Failed to read what the discard kept')
    const files = (listed.output ?? '').split('\0').filter(Boolean)
    if (files.length === 0) return { restored: [], left: [] }

    // Changed in the working tree, or there and untracked: a file the discard left as git has it is neither
    const status = await this.runner.executeGitCommand(['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', ...files.map(rowSpec)])
    if (!status.success) throw failure(status, 'Failed to read how the kept files stand now')
    const changed = new Set(splitStatus(status.output ?? '').entries
      .filter(entry => !entry.columns || entry.columns[1] !== '.')
      .map(entry => entry.path))
    const left = files.filter(file => changed.has(file)).sort()
    const restored = files.filter(file => !changed.has(file)).sort()
    if (restored.length > 0) {
      await this.withOwnIndex(gitDir, async (env) => {
        const read = await this.runner.executeGitCommand(['read-tree', id], { env })
        if (!read.success) throw failure(read, 'Failed to read what the discard kept')
        // From the top, where the tree's paths are from
        const out = await this.runner.executeGitCommand(['-C', top, 'checkout-index', '--force', '-z', '--stdin'], { env, input: restored.join('\0') })
        if (!out.success) throw failure(out, 'Failed to put back what the discard kept')
      })
    }
    this.model.markSnapshotStale()
    return { restored, left }
  }
}
