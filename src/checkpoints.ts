// Copies of the working tree, kept outside the repository. Each repository has a store of its own: a bare git
// directory in a place the host names, which borrows the repository's objects. A checkpoint is a commit there,
// named by a ref of the store's, and what it holds is the working tree's files as they were, as git would add them.
//
// **The repository's index, refs and objects are never written.** Every command runs against the repository's own
// git directory, so its ignore files, its attributes and the user's own excludes apply as they do to the user's
// git, with two things moved: the index is a file of the store's, made for the command and removed after, and the
// objects it writes go into the store's object directory. A file larger than `KEPT_FILE_LIMIT` is not kept, and
// the checkpoint says so; nothing it says is not kept is ever put back or removed.
//
// A checkpoint is dropped after `CHECKPOINT_MAX_AGE_MS`, and the oldest are dropped first while the store is larger
// than `CHECKPOINT_STORE_LIMIT`.
import { createHash, randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { rowSpec } from './arguments.ts'
import { GitError } from './errors.ts'
import type { RepositoryModel } from './model.ts'
import { failure, type GitRunner } from './runner.ts'
import type { Checkpoint, CheckpointChange } from './types.ts'

/** The largest file a checkpoint keeps a copy of. A larger one is left out, and the checkpoint names it */
export const KEPT_FILE_LIMIT = 10 * 1024 * 1024

/** How long a checkpoint is kept */
export const CHECKPOINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** How large a repository's store may grow before its oldest checkpoints are dropped */
export const CHECKPOINT_STORE_LIMIT = 1024 * 1024 * 1024

/** Where the refs naming checkpoints are, in the store */
const REFS = 'refs/checkpoints/'

/** Who a checkpoint's commit is by: it is the engine's, and no identity of the user's is needed to make one */
const IDENTITY = { GIT_AUTHOR_NAME: 'apack-git', GIT_AUTHOR_EMAIL: 'apack-git@localhost', GIT_COMMITTER_NAME: 'apack-git', GIT_COMMITTER_EMAIL: 'apack-git@localhost' }

/**
 * Where a repository's store is when the host names none: under the system's temporary directory, by the real path
 * of the repository's common git directory, so that every worktree of one repository shares one
 */
export const temporaryCheckpointDirectory = (commonDir: string): string =>
  path.join(os.tmpdir(), 'apack-git-checkpoints', createHash('sha256').update(commonDir).digest('hex').slice(0, 24))

/** What a checkpoint records beside its tree: what it left out, so that nothing it did not keep is touched */
interface Recorded { notKept: string[] }

export class CheckpointStore {
  /** Every change to the store, one at a time: a prune made while a checkpoint is being written would take its objects */
  private line: Promise<unknown> = Promise.resolve()
  private opened: Promise<{ top: string; gitDir: string; store: string; objects: string }> | undefined

  constructor(
    private readonly runner: GitRunner,
    private readonly model: RepositoryModel,
    /** The store's directory for the repository whose common git directory is at this real path */
    private readonly locate: (commonDir: string) => string = temporaryCheckpointDirectory,
  ) {}

  private inLine<T>(work: () => Promise<T>): Promise<T> {
    const done = this.line.then(work, work)
    this.line = done.then(() => {}, () => {})
    return done
  }

  /** The top of the checkout, its git directory, and the store, made the first time it is needed */
  private open() {
    this.opened ??= (async () => {
      const directories = this.model.gitDirectories ?? await this.model.resolveGitDirectories()
      if (!directories) throw new GitError('Not a git repository', 'not-a-repository')
      const commonDir = await fs.realpath(directories.commonDir)
      const store = this.locate(commonDir)
      const objects = path.join(commonDir, 'objects')
      if (!await fs.access(path.join(store, 'HEAD')).then(() => true, () => false)) {
        await fs.mkdir(path.dirname(store), { recursive: true })
        // No template: a store has no hooks, and nothing of the repository's is copied into it
        const made = await this.runner.executeGitCommand(['init', '--bare', '--quiet', '--template=', store])
        if (!made.success) throw failure(made, 'Could not make the store that keeps copies of the working tree')
      }
      // Its own objects first, then the repository's, which every checkpoint shares what it has not changed with
      // Spelled with `/`, which git reads on every platform
      await fs.writeFile(path.join(store, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`)
      return {
        top: path.resolve(this.runner.workingDirectory, ...directories.prefix.split('/').filter(Boolean).map(() => '..')),
        gitDir: directories.gitDir,
        store,
        objects,
      }
    })()
    void this.opened.catch(() => { this.opened = undefined })
    return this.opened
  }

  /** Runs git with an index of the store's, made for this and removed after, and the store's objects */
  private async withOwnIndex<T>(work: (env: NodeJS.ProcessEnv, where: Awaited<ReturnType<CheckpointStore['open']>>) => Promise<T>): Promise<T> {
    const where = await this.open()
    const index = path.join(where.store, `index-${randomUUID()}`)
    try {
      return await work({ GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: path.join(where.store, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: where.objects }, where)
    } finally {
      await Promise.all([index, `${index}.lock`].map(file => fs.rm(file, { force: true })))
    }
  }

  /** A git command in the store itself: its refs, and its housekeeping */
  private inStore(args: string[]) {
    return this.open().then(({ store }) => this.runner.executeGitCommand(['--git-dir', store, ...args]))
  }

  /**
   * The files these rows stand for, from the top of the checkout, each with its size. A row that names a folder
   * git tracks nothing in stands for what git lists in it. A path with no file is a file that was deleted.
   */
  private async filesOf(rows: string[], top: string): Promise<{ file: string; size: number | undefined }[]> {
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
      // A folder here is a repository of its own inside an untracked one, which git neither lists into nor adds
      return stats?.isDirectory() ? [] : [{ file, size: stats?.size }]
    }))
    return found.flat()
  }

  /** The files that differ from the index or that git does not track yet, whose content a checkpoint has to write */
  private async unstagedFiles(top: string): Promise<{ file: string; size: number | undefined }[]> {
    const listed = await this.runner.executeGitCommand(['-C', top, 'ls-files', '--modified', '--others', '--exclude-standard', '-z'])
    if (!listed.success) throw failure(listed, 'Failed to list the changed files')
    return this.filesOf([...new Set((listed.output ?? '').split('\0').filter(Boolean))], top)
  }

  /**
   * Writes a tree of the working tree's files into the store: of `paths` only when given, in an index that starts
   * as `seed` (a tree, or the repository's own index), and without the files named in `leaveOut`
   */
  private async treeOf(env: NodeJS.ProcessEnv, where: { top: string; gitDir: string }, paths: string[] | undefined, seed: string | 'index' | undefined, leaveOut: string[]): Promise<string> {
    if (seed === 'index') {
      // The repository's index knows which files have not changed since they were last read, so only the rest are
      await fs.copyFile(path.join(where.gitDir, 'index'), env.GIT_INDEX_FILE!).catch(() => {})
    } else if (seed) {
      const read = await this.runner.executeGitCommand(['-C', where.top, 'read-tree', seed], { env })
      if (!read.success) throw failure(read, 'Failed to read a checkpoint')
    }
    const specs = paths === undefined ? ['.'] : paths.map(rowSpec)
    if (specs.length > 0) {
      const added = await this.runner.executeGitCommand(['-C', where.top, 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: specs.join('\0') })
      if (!added.success) throw failure(added, 'Could not keep a copy of the working tree')
    }
    if (leaveOut.length > 0) {
      const removed = await this.runner.executeGitCommand(['-C', where.top, 'update-index', '--force-remove', '-z', '--stdin'], { env, input: leaveOut.join('\0') })
      if (!removed.success) throw failure(removed, 'Could not keep a copy of the working tree')
    }
    const written = await this.runner.executeGitCommand(['-C', where.top, 'write-tree'], { env })
    if (!written.success || !written.output?.trim()) throw failure(written, 'Could not keep a copy of the working tree')
    return written.output.trim()
  }

  /**
   * Keeps a copy of the working tree: of these paths (rows from the top of the checkout) when given, and of every
   * file git would add otherwise. Throws when the copy could not be taken, so that nothing is done to the files
   * on the understanding that it was.
   */
  checkpoint(paths?: string[]): Promise<Checkpoint> {
    return this.inLine(() => this.withOwnIndex(async (env, where) => {
      const files = paths === undefined ? await this.unstagedFiles(where.top) : await this.filesOf(paths, where.top)
      const notKept = files.filter(({ size }) => size !== undefined && size > KEPT_FILE_LIMIT).map(({ file }) => file).sort()
      const kept = paths === undefined ? undefined : files.filter(({ file, size }) => size !== undefined && !notKept.includes(file)).map(({ file }) => file)
      const tree = await this.treeOf(env, where, kept, paths === undefined ? 'index' : undefined, notKept)
      const recorded: Recorded = { notKept }
      const committed = await this.runner.executeGitCommand(['-C', where.top, 'commit-tree', tree, '-m', JSON.stringify(recorded)], { env: { ...env, ...IDENTITY } })
      const id = committed.output?.trim()
      if (!committed.success || !id) throw failure(committed, 'Could not keep a copy of the working tree')
      const named = await this.inStore(['update-ref', `${REFS}${id}`, id])
      if (!named.success) throw failure(named, 'Could not keep a copy of the working tree')
      await this.expire()
      return { id, notKept }
    }))
  }

  /** What a checkpoint recorded, or a `GitError` when it is not kept any more */
  private async recorded(id: string): Promise<Recorded> {
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error(`Invalid checkpoint: ${JSON.stringify(id)}`)
    const read = await this.inStore(['cat-file', 'commit', `${REFS}${id}`])
    if (!read.success) throw new GitError('That copy of the working tree is no longer kept: copies are kept for 14 days, and the oldest are dropped first when there are too many.')
    const message = (read.output ?? '').split('\n\n').slice(1).join('\n\n').trim()
    try {
      const parsed = JSON.parse(message) as Partial<Recorded>
      return { notKept: Array.isArray(parsed.notKept) ? parsed.notKept : [] }
    } catch {
      return { notKept: [] }
    }
  }

  /**
   * What differs now from a checkpoint: of these paths when given, and of everything it holds or git would add
   * otherwise. A file the checkpoint did not keep is not compared.
   */
  changedSince(id: string, paths?: string[]): Promise<CheckpointChange[]> {
    return this.inLine(() => this.changesOf(id, paths))
  }

  private async changesOf(id: string, paths?: string[]): Promise<CheckpointChange[]> {
    const { notKept } = await this.recorded(id)
    return this.withOwnIndex(async (env, where) => {
      const existing = paths === undefined ? undefined : (await this.filesOf(paths, where.top)).filter(({ size }) => size !== undefined).map(({ file }) => file)
      // A file in the checkpoint that is gone now is named too, so that it reads as deleted
      const held = paths === undefined ? undefined : await this.heldOf(id, paths, where.top, env)
      const now = await this.treeOf(env, where, existing && [...new Set([...existing, ...held!])], paths === undefined ? 'index' : id, notKept)
      const compared = await this.runner.executeGitCommand(['-C', where.top, 'diff-tree', '-r', '-z', '--no-renames', '--name-status', id, now, ...(paths === undefined ? [] : ['--', ...paths.map(rowSpec)])], { env })
      if (!compared.success) throw failure(compared, 'Failed to compare the working tree with its copy')
      const fields = (compared.output ?? '').split('\0').filter(Boolean)
      const changes: CheckpointChange[] = []
      for (let at = 0; at + 1 < fields.length; at += 2) {
        const change = fields[at] === 'A' ? 'added' : fields[at] === 'D' ? 'deleted' : 'modified'
        if (!notKept.includes(fields[at + 1]!)) changes.push({ path: fields[at + 1]!, change })
      }
      return changes.sort((a, b) => a.path.localeCompare(b.path))
    })
  }

  /** Every file a checkpoint holds, from the top of the checkout */
  filesIn(id: string): Promise<string[]> {
    return this.inLine(async () => {
      await this.recorded(id)
      return this.withOwnIndex((env, where) => this.heldOf(id, undefined, where.top, env))
    })
  }

  /** The files a checkpoint holds under these rows, or all of them */
  private async heldOf(id: string, rows: string[] | undefined, top: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    const listed = await this.runner.executeGitCommand(['-C', top, 'ls-tree', '-r', '-z', '--name-only', '--full-tree', id, ...(rows ? ['--', ...rows.map(rowSpec)] : [])], { env })
    if (!listed.success) throw failure(listed, 'Failed to read a checkpoint')
    return (listed.output ?? '').split('\0').filter(Boolean)
  }

  /**
   * Puts the working tree back as a checkpoint has it: of these paths when given, and everything it compares
   * otherwise. A file changed since is put back, one made since is removed, and one it did not keep is left
   * alone. The repository's index is not touched, so what was staged reads as changed against it.
   */
  restore(id: string, paths?: string[]): Promise<CheckpointChange[]> {
    return this.inLine(async () => {
      const changes = await this.changesOf(id, paths)
      if (changes.length === 0) return []
      await this.withOwnIndex(async (env, where) => {
        const read = await this.runner.executeGitCommand(['-C', where.top, 'read-tree', id], { env })
        if (!read.success) throw failure(read, 'Failed to read a checkpoint')
        const back = changes.filter(({ change }) => change !== 'added').map(({ path: file }) => file)
        if (back.length > 0) {
          const out = await this.runner.executeGitCommand(['-C', where.top, 'checkout-index', '--force', '-z', '--stdin'], { env, input: back.join('\0') })
          if (!out.success) throw failure(out, 'Failed to put back a copy of the working tree')
        }
        for (const { path: file } of changes.filter(({ change }) => change === 'added')) {
          await fs.rm(path.join(where.top, file), { force: true })
        }
      })
      this.model.markSnapshotStale()
      return changes
    })
  }

  /** Drops the checkpoints past their age, and the oldest while the store is over its size, then what only they held */
  private async expire(): Promise<void> {
    const listed = await this.inStore(['for-each-ref', '--sort=committerdate', '--format=%(refname)%00%(committerdate:unix)', REFS])
    if (!listed.success) return
    const refs = (listed.output ?? '').split('\n').filter(Boolean).map((line) => {
      const [ref, at] = line.split('\0')
      return { ref: ref!, at: Number(at) * 1000 }
    })
    const old = refs.filter(({ at }) => Date.now() - at > CHECKPOINT_MAX_AGE_MS)
    let kept = refs.filter(each => !old.includes(each))
    const dropAll = async (gone: typeof refs) => {
      for (const { ref } of gone) await this.inStore(['update-ref', '-d', ref])
      // Objects nothing refers to are removed once they are an hour old: a checkpoint being written at that moment
      // by another process holds only newer ones
      if (gone.length > 0) await this.inStore(['gc', '--quiet', '--prune=1.hour.ago'])
    }
    await dropAll(old)
    while (kept.length > 1 && await this.size() > CHECKPOINT_STORE_LIMIT) {
      const oldest = kept[0]!
      kept = kept.slice(1)
      await dropAll([oldest])
    }
  }

  /** How many bytes the store's objects take */
  private async size(): Promise<number> {
    const counted = await this.inStore(['count-objects', '-v'])
    const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(counted.output ?? '')?.[1] ?? 0)
    return (field('size') + field('size-pack') + field('size-garbage')) * 1024
  }
}
