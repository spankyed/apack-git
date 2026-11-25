// What the engine itself did that can be taken back: each write that moves a ref or removes something, as an entry
// of the operation, each ref it moved with where it was before and after, what it removed, and the checkpoint taken
// before it. `undo` reverses the entry it is handed by id, and only while every ref it moved is still where it left
// it: a ref moved since by anyone else is refused, rather than moved back over what they did. Any entry can be taken
// back that way, not only the last, and what the list says of an entry is what `undo` of it then does.
//
// The journal is a file in the repository's checkpoint store, a line an entry, so it is the repository's whichever
// window or process wrote it. An entry is kept for as long as a checkpoint is.
import { randomUUID } from 'node:crypto'
import * as path from 'path'
import * as fs from 'fs/promises'
import { CHECKPOINT_MAX_AGE_MS, NO_LONGER_KEPT, type CheckpointStore } from './checkpoints.js'
import type { DiscardStore } from './discards.js'
import { GitError } from './errors.js'
import type { RepositoryModel } from './model.js'
import { failure, type GitRunner } from './runner.js'
import type { JournalEntry, Undoable, Undone } from './types.js'

/** The most entries kept: past it the oldest go, which are the likeliest to have moved since */
const KEPT_ENTRIES = 100

export class Journal {
  private line: Promise<unknown> = Promise.resolve()

  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, private readonly checkpoints: CheckpointStore, private readonly discards: DiscardStore) {}

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

  /** Writes down what a write did, once it has, and answers the entry it wrote */
  record(entry: Omit<JournalEntry, 'id' | 'at'>): Promise<JournalEntry> {
    return this.inLine(async () => {
      const written = { ...entry, id: randomUUID(), at: Date.now() }
      await this.write([...await this.entries(), written])
      return written
    })
  }

  /** Where a ref points now, or `null` when there is no such ref */
  private async now(ref: string): Promise<string | null> {
    const result = await this.runner.read(['rev-parse', '--verify', '--quiet', ref])
    return result.success ? (result.output ?? '').trim() || null : null
  }

  /** The branch `HEAD` is on, as a full ref, or `HEAD` itself when it is on none */
  private async headRef(): Promise<string> {
    const result = await this.runner.read(['symbolic-ref', '--quiet', 'HEAD'])
    return result.success ? (result.output ?? '').trim() || 'HEAD' : 'HEAD'
  }

  /**
   * Whether `undo` would take an entry back now, and why not: the one place that decides it, so the list and `undo`
   * cannot disagree. `at` is where each ref is now and `head` the branch checked out, read once for a whole list.
   */
  private async standingOf(entry: JournalEntry, at: (ref: string) => Promise<string | null>, head: string): Promise<Undoable> {
    // What a discard kept, which the store drops after its age or as the oldest of too many
    if (entry.operation === 'discard' && !await this.checkpoints.has(entry.checkpoint ?? '')) return { entry, standing: 'no-longer-kept' }
    const moved: string[] = []
    for (const { ref, after } of entry.refs) {
      // Written with no branch checked out, its ref is `HEAD` itself: with a branch checked out since, moving `HEAD`
      // back would move that branch, which the write never touched
      if (await at(ref) !== after || (ref === 'HEAD' && head !== 'HEAD')) moved.push(ref)
    }
    if (moved.length > 0) return { entry, standing: 'moved-since', moved }
    const after = entry.refs[0]?.after
    const createsCommits = entry.operation === 'commit' || entry.operation === 'amend' || entry.operation === 'merge' || entry.operation === 'rebase' || entry.operation === 'cherry-pick' || entry.operation === 'rewrite'
    if (createsCommits && after) {
      const holding = await this.runner.read(['for-each-ref', '--format=%(refname:short)', '--contains', after, 'refs/remotes/'])
      const publishedOn = (holding.output ?? '').split('\n').filter(Boolean)
      if (publishedOn.length > 0) return { entry, standing: 'published', publishedOn }
    }
    return { entry, standing: 'ready' }
  }

  /** Where each ref is now, each read once however many entries name it */
  private refsNow(): (ref: string) => Promise<string | null> {
    const read = new Map<string, Promise<string | null>>()
    return (ref) => {
      if (!read.has(ref)) read.set(ref, this.now(ref))
      return read.get(ref)!
    }
  }

  /** Every entry kept, newest first, each with whether `undo` would take it back now */
  all(): Promise<Undoable[]> {
    return this.inLine(async () => {
      const at = this.refsNow()
      const head = await this.headRef()
      const entries = (await this.entries()).reverse()
      return Promise.all(entries.map(entry => this.standingOf(entry, at, head)))
    })
  }

  /**
   * Takes back the entry with this id and answers it. Refused, with the standing as the code, when a ref it moved
   * has moved since, and, for a commit a remote branch already holds, unless `evenIfPublished`: taking it back here
   * leaves it there. An id the journal does not hold is `nothing-to-undo`.
   */
  undo(id: string, { evenIfPublished = false }: { evenIfPublished?: boolean } = {}): Promise<Undone> {
    return this.inLine(async () => {
      const entries = await this.entries()
      const entry = entries.find(each => each.id === id)
      if (!entry) throw new GitError('There is nothing to undo.', 'nothing-to-undo')
      const { standing, moved, publishedOn } = await this.standingOf(entry, this.refsNow(), await this.headRef())
      if (standing === 'no-longer-kept') {
        throw new GitError(NO_LONGER_KEPT, 'no-longer-kept')
      }
      if (standing === 'moved-since') {
        const ref = moved![0]!
        throw new GitError(`${ref.replace(/^refs\/heads\//, '')} has moved since ${entry.summary}, so it is not undone: undoing it would undo what moved it too.`, 'moved-since')
      }
      if (standing === 'published' && !evenIfPublished) {
        throw new GitError(`That commit is already on ${publishedOn!.join(', ')}. Undoing it here leaves it there.`, 'published')
      }
      if (entry.operation === 'discard') {
        const discard = await this.discards.restore(entry.checkpoint!)
        // What it kept of a file left as it was is still there, and stays in reach until a restore leaves nothing
        if (discard.left.length === 0) await this.write(entries.filter(each => each.id !== id))
        this.model.markSnapshotStale()
        return { entry, discard }
      }
      await this.reverse(entry)
      await this.write(entries.filter(each => each.id !== id))
      this.model.markSnapshotStale()
      return { entry }
    })
  }

  private async reverse(entry: JournalEntry): Promise<void> {
    // A reset moves whatever is checked out. A write to a branch that is not checked out now is taken back by
    // moving that branch alone, below: the working tree is on another and is left as it is
    const checkedOut = entry.refs[0]?.ref === await this.headRef()
    if (checkedOut && (entry.operation === 'merge' || entry.operation === 'rebase' || entry.operation === 'cherry-pick' || entry.operation === 'rewrite')) {
      // The branch back where it was, and the files that changed with it, keeping what the user changed since: git
      // refuses rather than overwrite a change of theirs
      const before = entry.refs[0]!.before!
      const reset = await this.runner.write(['reset', '--quiet', '--keep', before])
      if (!reset.success) throw failure(reset, `Failed to undo ${entry.summary}`)
      return
    }
    if (checkedOut && entry.operation === 'reset') {
      // The branch and the index back where they were; the files were never touched, and are left as they are
      const before = entry.refs[0]!.before!
      const reset = await this.runner.write(['reset', '--quiet', before])
      if (!reset.success) throw failure(reset, `Failed to undo ${entry.summary}`)
      return
    }
    for (const { ref, before, after } of entry.refs) {
      // Moved only from where the write left it, which git checks as it moves it
      const moved = before === null
        ? await this.runner.write(['update-ref', '-d', ref, after!])
        : await this.runner.write(['update-ref', '-m', `undo: ${entry.summary}`, ref, before, after ?? ''])
      if (!moved.success) throw failure(moved, `Failed to undo ${entry.summary}`)
    }
    for (const [key, value] of entry.config ?? []) {
      const set = await this.runner.write(['config', '--add', key, value])
      if (!set.success) throw failure(set, `Failed to undo ${entry.summary}`)
    }
    // Put back oldest first, so that they stand in the order they did
    for (const { commit, message } of [...entry.stashes ?? []].reverse()) {
      const stored = await this.runner.write(['stash', 'store', '--quiet', '-m', message, commit])
      if (!stored.success) throw failure(stored, `Failed to undo ${entry.summary}`)
    }
  }
}
