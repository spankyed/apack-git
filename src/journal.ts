// What the engine itself did that can be taken back: each write that moves a ref or removes something, as an entry
// of the operation, each ref it moved with where it was before and after, what it removed, and the checkpoint taken
// before it. `undo` reverses the last entry, and only while every ref it moved is still where it left it: a ref
// moved since by anyone else is refused, rather than moved back over what they did.
//
// The journal is a file in the repository's checkpoint store, a line an entry, so it is the repository's whichever
// window or process wrote it. An entry is kept for as long as a checkpoint is.
import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as fs from 'fs/promises'
import { CHECKPOINT_MAX_AGE_MS, type CheckpointStore } from './checkpoints.ts'
import { GitError } from './errors.ts'
import type { RepositoryModel } from './model.ts'
import { failure, type GitRunner } from './runner.ts'
import type { JournalEntry } from './types.ts'

/** The most entries kept: past it the oldest go, since only the last is ever taken back first */
const KEPT_ENTRIES = 100

export class Journal {
  private line: Promise<unknown> = Promise.resolve()

  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, private readonly checkpoints: CheckpointStore) {}

  private inLine<T>(work: () => Promise<T>): Promise<T> {
    const done = this.line.then(work, work)
    this.line = done.then(() => {}, () => {})
    return done
  }

  private async file(): Promise<string> {
    return path.join(await this.checkpoints.directory(), 'journal')
  }

  private async entries(): Promise<JournalEntry[]> {
    const text = await fs.readFile(await this.file(), 'utf8').catch(() => '')
    const entries: JournalEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line) as JournalEntry) } catch { /* a line cut short by a crash says nothing */ }
    }
    return entries.filter(entry => Date.now() - entry.at <= CHECKPOINT_MAX_AGE_MS).slice(-KEPT_ENTRIES)
  }

  private async write(entries: JournalEntry[]): Promise<void> {
    const file = await this.file()
    const temporary = `${file}.${randomUUID()}`
    await fs.writeFile(temporary, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    await fs.rename(temporary, file)
  }

  /** Writes down what a write did, once it has */
  record(entry: Omit<JournalEntry, 'id' | 'at'>): Promise<void> {
    return this.inLine(async () => this.write([...await this.entries(), { ...entry, id: randomUUID(), at: Date.now() }]))
  }

  /** The last thing done that can be taken back, or nothing */
  last(): Promise<JournalEntry | undefined> {
    return this.inLine(async () => (await this.entries()).at(-1))
  }

  /** Where a ref points now, or `null` when there is no such ref */
  private async now(ref: string): Promise<string | null> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--verify', '--quiet', ref])
    return result.success ? (result.output ?? '').trim() || null : null
  }

  /**
   * Takes back the last entry and answers it. Refused when a ref it moved has moved since, and, for a commit that a
   * remote branch already holds, unless `evenIfPublished`: taking it back here leaves it there.
   */
  undo({ evenIfPublished = false }: { evenIfPublished?: boolean } = {}): Promise<JournalEntry> {
    return this.inLine(async () => {
      const entries = await this.entries()
      const entry = entries.at(-1)
      if (!entry) throw new GitError('There is nothing to undo.')
      for (const { ref, after } of entry.refs) {
        if (await this.now(ref) !== after) {
          throw new GitError(`${ref.replace(/^refs\/heads\//, '')} has moved since ${entry.summary}, so it is not undone: undoing it would undo what moved it too.`)
        }
      }
      if (entry.operation === 'commit' && !evenIfPublished) {
        const after = entry.refs[0]?.after
        const holding = after ? await this.runner.executeGitCommand(['for-each-ref', '--format=%(refname:short)', '--contains', after, 'refs/remotes/']) : undefined
        const remotes = (holding?.output ?? '').split('\n').filter(Boolean)
        if (remotes.length > 0) {
          throw new GitError(`That commit is already on ${remotes.join(', ')}. Undoing it here leaves it there.`, 'published')
        }
      }
      await this.reverse(entry)
      await this.write(entries.slice(0, -1))
      this.model.markSnapshotStale()
      return entry
    })
  }

  private async reverse(entry: JournalEntry): Promise<void> {
    if (entry.operation === 'merge' || entry.operation === 'rebase' || entry.operation === 'cherry-pick') {
      // The branch back where it was, and the files that changed with it, keeping what the user changed since: git
      // refuses rather than overwrite a change of theirs
      const before = entry.refs[0]!.before!
      const reset = await this.runner.executeGitCommand(['reset', '--quiet', '--keep', before])
      if (!reset.success) throw failure(reset, `Failed to undo ${entry.summary}`)
      return
    }
    if (entry.operation === 'reset') {
      // The branch and the index back where they were; the files were never touched, and are left as they are
      const before = entry.refs[0]!.before!
      const reset = await this.runner.executeGitCommand(['reset', '--quiet', before])
      if (!reset.success) throw failure(reset, `Failed to undo ${entry.summary}`)
      return
    }
    for (const { ref, before, after } of entry.refs) {
      // Moved only from where the write left it, which git checks as it moves it
      const moved = before === null
        ? await this.runner.executeGitCommand(['update-ref', '-d', ref, after!])
        : await this.runner.executeGitCommand(['update-ref', '-m', `undo: ${entry.summary}`, ref, before, after ?? ''])
      if (!moved.success) throw failure(moved, `Failed to undo ${entry.summary}`)
    }
    for (const [key, value] of entry.config ?? []) {
      const set = await this.runner.executeGitCommand(['config', '--add', key, value])
      if (!set.success) throw failure(set, `Failed to undo ${entry.summary}`)
    }
    // Put back oldest first, so that they stand in the order they did
    for (const { commit, message } of [...entry.stashes ?? []].reverse()) {
      const stored = await this.runner.executeGitCommand(['stash', 'store', '--quiet', '-m', message, commit])
      if (!stored.success) throw failure(stored, `Failed to undo ${entry.summary}`)
    }
  }
}
