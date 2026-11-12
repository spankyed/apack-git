// What a discard removes, kept. Discarding a changed file checks it out again, and discarding an untracked file
// or folder deletes it: before either, what is about to go is kept as a checkpoint of those files, in the store
// outside the repository (`checkpoints.ts`), named by its id. `restore` puts it back.
//
// The user's index, refs, objects and stash are not touched, in either direction.
import * as path from 'path'
import * as fs from 'fs/promises'
import { rowSpec } from './arguments.ts'
import { KEPT_FILE_LIMIT, type CheckpointStore } from './checkpoints.ts'
import type { RepositoryModel } from './model.ts'
import { failure, type GitRunner } from './runner.ts'
import { splitStatus } from './status.ts'
import type { DiscardKept, DiscardRestored } from './types.ts'

export class DiscardStore {
  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, private readonly checkpoints: CheckpointStore) {}

  /**
   * The files discarding these rows would change or remove, from the top of the checkout, each with its size. A
   * row that names a folder git tracks nothing in stands for what git lists in it, which is what a discard of
   * it removes. A path with no file is a deletion being discarded, which removes nothing.
   */
  private async filesOf(rows: string[]): Promise<{ file: string; size: number }[]> {
    const directories = this.model.gitDirectories ?? await this.model.resolveGitDirectories()
    const top = path.resolve(this.runner.workingDirectory, ...(directories?.prefix ?? '').split('/').filter(Boolean).map(() => '..'))
    const named = new Set<string>()
    for (const row of rows) {
      if (!row.endsWith('/')) {
        named.add(row)
        continue
      }
      const listed = await this.runner.executeGitCommand(['-C', top, 'ls-files', '--others', '--exclude-standard', '-z', '--', rowSpec(row)])
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

  /** The paths, among what discarding these rows would remove, that are too large to keep a copy of */
  async notKeptOf(rows: string[]): Promise<string[]> {
    return (await this.filesOf(rows)).filter(({ size }) => size > KEPT_FILE_LIMIT).map(({ file }) => file).sort()
  }

  /**
   * Keeps what discarding these rows is about to remove, before it does. Throws when the copy could not be
   * taken, so that whoever is discarding removes nothing they could not get back without having been told.
   */
  async keep(rows: string[]): Promise<DiscardKept> {
    const files = await this.filesOf(rows)
    const kept = files.filter(({ size }) => size <= KEPT_FILE_LIMIT).map(({ file }) => file)
    const notKept = files.filter(({ size }) => size > KEPT_FILE_LIMIT).map(({ file }) => file).sort()
    if (kept.length === 0) return { notKept }
    const { id } = await this.checkpoints.checkpoint(kept)
    return { id, notKept }
  }

  /**
   * Puts back what a discard kept. A path that has changed in the working tree since, or been made again, is
   * left as it is and named: what is there now is not overwritten.
   */
  async restore(id: string): Promise<DiscardRestored> {
    const files = await this.checkpoints.filesIn(id)
    if (files.length === 0) return { restored: [], left: [] }
    // Changed in the working tree, or there and untracked: a file the discard left as git has it is neither
    const status = await this.runner.executeGitCommand(['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', ...files.map(rowSpec)])
    if (!status.success) throw failure(status, 'Failed to read how the kept files stand now')
    const changed = new Set(splitStatus(status.output ?? '').entries
      .filter(entry => !entry.columns || entry.columns[1] !== '.')
      .map(entry => entry.path))
    const left = files.filter(file => changed.has(file)).sort()
    const restored = files.filter(file => !changed.has(file)).sort()
    if (restored.length > 0) await this.checkpoints.restore(id, restored)
    return { restored, left }
  }
}
