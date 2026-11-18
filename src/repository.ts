// One working tree's repository: the door's class. It holds the engine's four parts and is what a host calls;
// each method here is one of theirs.
import * as path from 'path'
import { GitReads } from './reads.ts'
import { Trailers } from './trailers.ts'
import { RepositoryModel } from './model.ts'
import { GitRunner, failure, fetchingMissing } from './runner.ts'
import type { RepositoryTies } from './ties.ts'
import { GitWrites } from './writes.ts'
import { olderThan } from './git-check.ts'

/** The first git with a file monitor of its own, on macOS and Windows */
export const FILE_MONITOR_FROM = '2.37.0'
import { repositoriesUnder } from './repositories-under.ts'
import { addressArgument, cloneInto, initIn } from './clone.ts'
import { refArgument } from './arguments.ts'
import { History } from './history.ts'
import { Blame } from './blame.ts'
import { Refs } from './refs.ts'
import { MergePreviews } from './merge-preview.ts'
import { CheckpointStore } from './checkpoints.ts'
import { Journal } from './journal.ts'
import { DiscardStore } from './discards.ts'
import { DiffData } from './diff-data.ts'
import type { GitErrorCode } from './errors.ts'
import type { TrustReading } from './trust.ts'
import type {
  BranchCheckout, ChangedFile, FoundRepository, GitRemote, Checkpoint, CheckpointChange, CommitLogEntry, ConflictAnswer, ConflictSides, DiffHunk, DiscardKept, GitDirectories, GitProgress, GitStatusFile, LineCount, OperationMove, RepositoryChange, RepositorySnapshot, StashEntry, Trailer, WorktreeEntry, HistoryPage, BlameLine, RefsModel, MergePreview, RewriteStep, Undoable, Undone,
} from './types.ts'

export class GitRepository {
  /**
   * Every repository under a folder: its own, or the one it is in, first, then the repositories nested in it,
   * submodules and linked worktrees, by path. Each opens as a `GitRepository` of its own, with its own trust and its
   * own watcher. `truncated` when the walk stopped at its bound (`FIND_DEPTH`, `FIND_FOLDERS`).
   */
  static repositoriesUnder(folder: string): Promise<{ repositories: FoundRepository[]; truncated: boolean }> {
    return repositoriesUnder(folder)
  }

  /**
   * Clones `url` into `directory`, which must not exist yet or be empty, and answers the repository it made. Git's
   * progress goes to `onProgress`; stopped through `signal`, or failed, no directory it made is left behind
   */
  static async clone(url: string, directory: string, { ties = {}, onProgress, signal }: { ties?: RepositoryTies; onProgress?: (progress: GitProgress) => void; signal?: AbortSignal } = {}): Promise<GitRepository> {
    await cloneInto(url, directory, ties, { onProgress, signal })
    return new GitRepository(path.resolve(directory), ties)
  }

  /** Starts a repository in `directory`, made when it does not exist, and answers it */
  static async init(directory: string, { ties = {}, initialBranch }: { ties?: RepositoryTies; initialBranch?: string } = {}): Promise<GitRepository> {
    await initIn(directory, ties, { initialBranch })
    return new GitRepository(path.resolve(directory), ties)
  }

  private readonly runner: GitRunner
  private readonly model: RepositoryModel
  private readonly reads: GitReads
  private readonly writes: GitWrites
  private readonly histories: History
  private readonly blames: Blame
  private readonly refs: Refs
  private readonly previews: MergePreviews
  private readonly checkpoints: CheckpointStore
  private readonly journal: Journal
  private readonly diffs: DiffData
  private readonly trailers: Trailers

  constructor(private workingDirectory: string, ties: RepositoryTies = {}) {
    if (!path.isAbsolute(workingDirectory)) {
      throw new Error('Working directory must be an absolute path')
    }
    this.runner = new GitRunner(workingDirectory, ties)
    this.model = new RepositoryModel(this.runner, () => this.runner.writesInLine > 0 || this.writes.isWriteInProgress)
    this.reads = new GitReads(this.runner, this.model, ties)
    this.checkpoints = new CheckpointStore(this.runner, this.model, ties.checkpointDirectory)
    const discards = new DiscardStore(this.runner, this.model, this.checkpoints)
    this.journal = new Journal(this.runner, this.model, this.checkpoints, discards)
    this.blames = new Blame(this.runner, this.model)
    this.refs = new Refs(this.runner)
    this.writes = new GitWrites(this.runner, this.model, this.reads, this.checkpoints, this.journal, discards)
    this.diffs = new DiffData(this.runner)
    this.histories = new History(this.runner)
    this.previews = new MergePreviews(this.runner)
    this.trailers = new Trailers(this.runner)
  }

  getWorkingDir(): string {
    return this.workingDirectory
  }

  /**
   * Lets go of what is held open for this repository, and waits for what it was asked: the git kept running
   * while files are read from commits is ended, and every command already running or waiting its turn runs to
   * its end. It is used again as before, and that git is started again by the next read of a file from a commit.
   *
   * Settles once no git of this repository is left running. On a platform that will not delete a directory a
   * process is in, the repository's can be deleted then and not before.
   */
  async close(): Promise<void> {
    await Promise.all([this.reads.close(), this.runner.idle()])
  }

  /**
   * What this repository would have git run, read without running any of it: the settings of its own that are
   * not known to run nothing, and its hooks. While it names anything and the host has not said the repository
   * is trusted (`RepositoryTies.isTrusted`), every other command here is refused with an `UntrustedError`.
   */
  readTrust(): Promise<TrustReading> {
    return this.runner.trust.read()
  }

  /**
   * What the host shows beside the status and is no part of git's, such as whether it is fetching: a change to
   * it reads as a change to the status at the next check, so the windows showing the checkout are told
   */
  setStatusNote(note: string): void {
    this.model.setStatusNote(note)
  }

  get isWriteInProgress(): boolean {
    return this.writes.isWriteInProgress
  }

  /** Register a one-shot callback that fires when all pending writes finish. */
  onWriteComplete(callback: () => void): void {
    return this.writes.onWriteComplete(callback)
  }

  clearCache(): void {
    return this.reads.clearCache()
  }

  /** The repository may have changed in any way: the next snapshot asked for is read from git, all of it */
  markSnapshotStale(): void {
    return this.model.markSnapshotStale()
  }

  /**
   * Notes what a watcher saw change, which is what the next snapshot asked for reads: these paths in the working
   * tree, relative to the working directory with `/` between their parts, or everything when it could not name them
   */
  noteChanged(paths: string[] | null): void {
    this.reads.forget()
    return this.model.noteChanged(paths)
  }

  /**
   * Says whether a watcher reports this checkout's changes, which is what lets a snapshot be reused. `failed`
   * says its watches could not be opened or have stopped, as opposed to not being open yet or not being wanted.
   */
  setWatched(watched: boolean, failed = false): void {
    return this.model.setWatched(watched, failed)
  }

  /** Whether this checkout's watches failed: a panel showing it then changes only when it is asked again */
  get hasWatchFailed(): boolean {
    return this.model.hasWatchFailed
  }

  invalidateCache(paths?: string[]): void {
    return this.reads.invalidateCache(paths)
  }

  readCurrentBranch(): Promise<string> {
    return this.reads.readCurrentBranch()
  }

  readStatus(): Promise<GitStatusFile[]> {
    return this.model.readStatus()
  }

  /**
   * The checkout's changed files, branch and distance from its upstream.
   *
   * A snapshot is reused until something says the repository may have changed: a watcher's event, a write made
   * here, a reconcile. It never reaches the remote: `fetch` does, when the host asks.
   */
  readSnapshot(): Promise<RepositorySnapshot> {
    return this.model.readSnapshot()
  }

  /**
   * Reads the repository from git and says which parts of it differ from the last check. A watcher's event is a
   * hint that something changed; this is what decides whether anything did, and what.
   *
   * A check a watcher's event started reads `noted`: what the watcher said changed (`noteChanged`), and nothing
   * when it said nothing since the last read. Any other check has no event to go by, and reads everything.
   *
   * **`refreshIndex` lets this one status write git's index**, which no other read here may
   * (`GIT_OPTIONAL_LOCKS`). Git keeps in the index what it last saw of each file, and a status that may not write
   * it re-reads every file whose time moved, on every run: after a checkout or a formatter over the tree, that is
   * every file, every time. Writing it holds git's lock for as long as the status takes, in which a git run from
   * a terminal would be refused, so it is the caller's to say when: at a moment nothing else is likely to be
   * running git, and only when something says the index may be stale.
   */
  refreshSnapshot(reading: 'everything' | 'noted' = 'everything', options: { refreshIndex?: boolean } = {}): Promise<RepositoryChange> {
    return this.model.refreshSnapshot(reading, options)
  }

  /**
   * The files in an untracked folder that git would list, were it asked to list every one: those it does not
   * ignore. `directory` is a folder row's path, from the top of the checkout.
   */
  listUntracked(directory: string): Promise<{ files: string[]; truncated: boolean }> {
    return this.reads.listUntracked(directory)
  }

  /**
   * The directories git ignores under the working directory, relative to it: what a watcher of the working
   * tree need not report from.
   */
  listIgnoredDirectories(): Promise<string[]> {
    return this.reads.listIgnoredDirectories()
  }

  /**
   * The diff of a file, or of every file when none is named: of the working tree against what is staged, or with
   * `staged` of what is staged against the last commit. `signal` stops it, rejecting with a `GitError` coded `aborted`
   */
  readDiff(filePath?: string, staged: boolean = false, options?: { signal?: AbortSignal }): Promise<string> {
    return this.reads.readDiff(filePath, staged, options)
  }

  /**
   * Efficient multi-path diff: issues a single `git diff -- path1 path2 …`
   * for tracked files and builds synthetic diffs for untracked ones, avoiding
   * one git subprocess per file.
   */
  readDiffs(paths: string[]): Promise<string> {
    return this.reads.readDiffs(paths)
  }

  readFileContent(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<string> {
    return this.reads.readFileContent(filePath, version)
  }

  /**
   * The pieces of a file's change that can be staged one at a time, or unstaged when `staged`: of the working
   * tree against the index, or of the index against the last commit. None for a file that is not plainly modified.
   */
  readHunks(filePath: string, staged: boolean): Promise<DiffHunk[]> {
    return this.reads.readHunks(filePath, staged)
  }

  /**
   * Applies a patch of any number of files — what `git diff` prints, binary files included — to the working tree, or
   * with `staged` to what is staged and nothing else: a change an agent proposes, say. Its paths are from the top of
   * the checkout, wherever this repository was opened. It is applied whole or not at all: a patch any part of which
   * does not apply, or that names a path outside the checkout, is refused with a `GitError` and changes nothing.
   */
  applyPatch(patch: string | Buffer, options?: { staged?: boolean }): Promise<void> {
    return this.writes.applyPatch(patch, options)
  }

  /**
   * Stages one piece of a file's change, or with `staged` takes one piece out of what is staged. The piece is
   * named by its id, and is one this repository cuts from the file as it is now: one whose file changed under
   * it is refused, rather than applied to lines it was not made from.
   */
  applyHunk(filePath: string, staged: boolean, id: string): Promise<void> {
    return this.writes.applyHunk(filePath, staged, id)
  }

  stageFiles(filePaths: string[]): Promise<void> {
    return this.writes.stageFiles(filePaths)
  }

  unstageFiles(filePaths: string[]): Promise<void> {
    return this.writes.unstageFiles(filePaths)
  }

  /**
   * Discards a file's changes, or an untracked file or folder, and answers with what it kept of what that
   * removed: its id names the discard in the journal (`undoables`), and `undo` of it puts it back. Nothing is
   * removed when the copy could not be taken.
   */
  revertFile(filePath: string): Promise<DiscardKept> {
    return this.writes.revertFile(filePath)
  }

  /** The same for several at once, kept as one discard in the journal */
  revertFiles(filePaths: string[]): Promise<DiscardKept> {
    return this.writes.revertFiles(filePaths)
  }

  /** The three sides of a conflicted file, the working file and where its conflicts are marked (`ConflictSides`) */
  conflictSides(filePath: string): Promise<ConflictSides> {
    return this.reads.conflictSides(filePath)
  }

  /**
   * Resolves a conflicted file with one side, or with content written in its place, and marks it resolved. A side
   * that deleted the file resolves it by deleting it
   */
  resolveConflict(filePath: string, answer: ConflictAnswer): Promise<void> {
    return this.writes.resolveConflict(filePath, answer)
  }

  /**
   * Carries on with what git is in the middle of, leaves out the commit a rebase stopped at, or gives it up.
   * Carrying on takes the message git proposes, there being no editor for it to open (`gitEnvironment`).
   */
  moveOperation(move: OperationMove): Promise<void> {
    return this.writes.moveOperation(move)
  }

  commit(message: string): Promise<void> {
    return this.writes.commit(message)
  }

  /**
   * Where this checkout's git state lives: its own git directory (index, HEAD) and the common one holding refs.
   * The two differ in a linked worktree. Null when the working directory is in no repository.
   */
  resolveGitDirectories(): Promise<GitDirectories | null> {
    return this.model.resolveGitDirectories()
  }

  /**
   * Whether the working directory is in a repository. Rejects when there is no git to ask, and with an
   * `UnsafeOwnershipError` naming the repository when git will not read it for who owns it.
   */
  isGitRepository(): Promise<boolean> {
    return this.reads.isGitRepository()
  }

  /**
   * Adds a repository git refused for who owns it to the user's `safe.directory` entries, which is what git's
   * refusal says to do. It writes the user's global git configuration, so it is run only when the user asks.
   * `directory` is an `UnsafeOwnershipError`'s, the path as git printed it.
   */
  async trustOwnership(directory: string): Promise<void> {
    const result = await this.runner.executeGitCommand(['config', '--global', '--add', 'safe.directory', directory])
    if (!result.success) throw failure(result, `Could not add ${directory} to safe.directory`)
  }

  readStagedFiles(): Promise<GitStatusFile[]> {
    return this.reads.readStagedFiles()
  }

  findBaseBranch(options?: { preferUpstream?: boolean }): Promise<string> {
    return this.reads.findBaseBranch(options)
  }

  readBranchDiff(baseBranch: string, targetBranch?: string): Promise<GitStatusFile[]> {
    return this.reads.readBranchDiff(baseBranch, targetBranch)
  }

  /**
   * What merging `target` into what is checked out would do, before it is done: nothing, a fast-forward, a clean
   * merge, or one that stops on conflicts in the files it names. For a pull, `target` is the upstream after a fetch.
   * Nothing moves: no ref, no index and no file. `unknown` on a git older than 2.38.
   */
  previewMerge(target: string): Promise<MergePreview> {
    return this.previews.preview(target)
  }

  /** A commit's whole message, its subject and its body, as it was written */
  commitMessage(commit: string): Promise<string> {
    return this.reads.commitMessage(commit)
  }

  /**
   * Brings submodules to the commits this repository records: those at `paths` (from the top of the checkout) when
   * any are named, every one otherwise, each set up first where it is not yet, and the submodules in them in turn.
   * What a submodule lacks is fetched, with git's progress handed to `onProgress`, and `signal` stops it, rejecting
   * with a `GitError` coded `aborted`. One whose own changes the checkout would overwrite is refused, and left as it is
   */
  updateSubmodules(paths?: string[], options?: { onProgress?: (progress: GitProgress) => void; signal?: AbortSignal }): Promise<void> {
    return this.writes.updateSubmodules(paths, options)
  }

  /**
   * The trailers git reads at the end of a message, in order: `Co-authored-by: …`, `Signed-off-by: …`. None when its
   * last paragraph is not trailers, and a message of one paragraph has none, that being its subject
   */
  trailersIn(message: string): Promise<Trailer[]> {
    return this.trailers.trailersIn(message)
  }

  /**
   * A message without the trailers `remove` picks, each with the lines that continue it, and every other line as it
   * was written: what to commit when some of what a message ends with is not to be kept
   */
  withoutTrailers(message: string, remove: (trailer: Trailer) => boolean): Promise<string> {
    return this.trailers.withoutTrailers(message, remove)
  }

  /** Whether each of these names a commit in this repository */
  commitsExist(...refs: string[]): Promise<boolean> {
    return this.reads.commitsExist(...refs)
  }

  readFileContentFromBranch(filePath: string, branch: string): Promise<string> {
    return this.reads.readFileContentFromBranch(filePath, branch)
  }

  /**
   * How many lines each changed file adds and removes, as git counts them: what is staged against the last commit,
   * and the working tree against what is staged. A file git does not track yet has no count.
   */
  lineCounts(): Promise<(LineCount & { staged: boolean })[]> {
    return this.diffs.lineCounts()
  }

  /** The files a commit changed against its first parent, each with its count */
  changesIn(commit: string): Promise<ChangedFile[]> {
    return this.diffs.changesIn(commit)
  }

  /**
   * The files a stash holds against the commit it was made on, each with its count, its untracked files among
   * them as added: what applying it would bring, read without applying it. A file's two sides are
   * `readFileContentFromBranch(path, 'stash@{n}^1')` and `(path, 'stash@{n}')`, or `'stash@{n}^3'` for an untracked one
   */
  readStashChanges(index: number): Promise<ChangedFile[]> {
    return this.diffs.readStashChanges(index)
  }

  /**
   * A page of history to draw: from `refs` (`HEAD` when none), each commit with its parents and the refs at it,
   * never one before a commit that descends from it; or from the `cursor` the page before gave, which continues
   * from where the first page stood, so the pages neither repeat nor drop a commit whatever moves meanwhile. With
   * `path`, that file's history from the first ref, followed across its renames. `signal` stops the read, which then
   * rejects with a `GitError` coded `aborted`: for a page whoever asked no longer wants.
   */
  history(options?: { refs?: string[]; cursor?: string; path?: string; limit?: number; signal?: AbortSignal }): Promise<HistoryPage> {
    return this.histories.page(options)
  }

  /**
   * Who last changed each line of a file, at `revision` or as the working tree has it, in line order, leaving out
   * the commits the repository lists to be ignored. `onLines` is handed each group of lines as git finds it. Blame
   * runs the conversion programs a repository names, as a diff does, so it is refused like any other command in a
   * repository not trusted to. `signal` stops it, rejecting with a `GitError` coded `aborted`.
   */
  blame(filePath: string, options?: { revision?: string; onLines?: (lines: BlameLine[]) => void; signal?: AbortSignal }): Promise<BlameLine[]> {
    return this.blames.blame(filePath, options)
  }

  /**
   * Runs `read`, whose reads of this repository may fetch what a partial clone has not: what a read answers with
   * `content-missing` otherwise. They wait in line with the fetches and pushes while they do, since they reach the
   * remote. Only what `read` calls is let fetch; every other read goes on fetching nothing.
   */
  fetchingMissing<T>(read: () => Promise<T>): Promise<T> {
    return fetchingMissing(read)
  }

  /**
   * Keeps a copy of the working tree outside the repository, in the store `RepositoryTies.checkpointDirectory`
   * names: of these paths (from the top of the checkout) when given, and of every file git would add otherwise.
   * Nothing of the repository's own is written. A file larger than `KEPT_FILE_LIMIT` is left out and named.
   */
  checkpoint(paths?: string[]): Promise<Checkpoint> {
    return this.checkpoints.checkpoint(paths)
  }

  /** What differs now from a checkpoint, of these paths when given; a file it left out is not compared */
  changedSince(id: string, paths?: string[]): Promise<CheckpointChange[]> {
    return this.checkpoints.changedSince(id, paths)
  }

  /**
   * Puts the working tree back as a checkpoint has it, of these paths when given: a file changed since is put
   * back, one made since is removed, and one it left out is left alone. Answers what it changed. The index is not
   * touched, so what was staged reads as changed against it.
   */
  restoreCheckpoint(id: string, paths?: string[]): Promise<CheckpointChange[]> {
    return this.checkpoints.restore(id, paths)
  }

  /**
   * Merges a branch or a commit into what is checked out, after a checkpoint of the working tree. One that stops on
   * conflicts is the operation in progress the snapshot describes, and is refused with `conflict`; one that goes
   * through can be undone, which puts the branch and its files back and keeps what the user changed since
   */
  merge(target: string): Promise<void> {
    return this.writes.merge(target)
  }

  /** Makes a tag at `commit` (what is checked out when none), annotated with `message` when one is given */
  createTag(name: string, options?: { commit?: string; message?: string }): Promise<void> {
    return this.writes.createTag(name, options)
  }

  deleteTag(name: string): Promise<void> {
    return this.writes.deleteTag(name)
  }

  /** Pushes a tag to a remote, `origin` unless another is named, with progress, stopped through `signal` */
  pushTag(name: string, options?: { remote?: string; onProgress?: (progress: GitProgress) => void; signal?: AbortSignal }): Promise<void> {
    return this.writes.pushTag(name, options)
  }

  /** Renames a local branch, and what it follows with it; refused with `branch-exists` when the name is taken */
  renameBranch(name: string, to: string): Promise<void> {
    return this.writes.renameBranch(name, to)
  }

  /**
   * Amends the last commit with what is staged, and with `message` when given. Refused with `published` for a commit
   * a remote branch already holds unless `evenIfPublished`; `undo` takes it back, leaving what it took in staged
   */
  amend(options?: { message?: string; evenIfPublished?: boolean }): Promise<void> {
    return this.writes.amend(options)
  }

  /**
   * Rewrites the commits after `base` by the steps given, in the order they are to stand: each kept, reworded,
   * folded into the one before, or dropped. Refused with `published` for a range a remote branch already holds part
   * of unless `evenIfPublished`; checkpointed first, and undone with `undo`
   */
  rewrite(base: string, steps: RewriteStep[], options?: { evenIfPublished?: boolean }): Promise<void> {
    return this.writes.rewrite(base, steps, options)
  }

  /** Replays what is checked out onto a branch or a commit, as `merge` does its work: checkpointed, and undone the same */
  rebaseOnto(target: string): Promise<void> {
    return this.writes.rebaseOnto(target)
  }

  /** Applies commits onto what is checked out, oldest first, as `merge` does its work */
  cherryPick(commits: string[]): Promise<void> {
    return this.writes.cherryPick(commits)
  }

  /** Adds a remote by its name and address */
  async addRemote(name: string, url: string): Promise<void> {
    await this.remoteCommand(['add', refArgument(name, 'remote'), addressArgument(url)], `add the remote ${name}`)
  }

  /** Renames a remote, and the branches of it git keeps with it */
  async renameRemote(name: string, to: string): Promise<void> {
    await this.remoteCommand(['rename', refArgument(name, 'remote'), refArgument(to, 'remote')], `rename the remote ${name}`)
  }

  /** Removes a remote, and the branches of it git keeps */
  async removeRemote(name: string): Promise<void> {
    await this.remoteCommand(['remove', refArgument(name, 'remote')], `remove the remote ${name}`)
  }

  /** Changes where a remote is fetched from, or with `push` where it is pushed to */
  async setRemoteUrl(name: string, url: string, { push = false }: { push?: boolean } = {}): Promise<void> {
    await this.remoteCommand(['set-url', ...(push ? ['--push'] : []), refArgument(name, 'remote'), addressArgument(url)], `change the address of ${name}`)
  }

  /**
   * A `git remote` subcommand. Its names and addresses are refused when they start like an option, so none is
   * marked off with `--`, which `git remote rename` before 2.36 does not take
   */
  private async remoteCommand(args: string[], what: string): Promise<void> {
    const result = await this.runner.executeGitCommand(['remote', ...args])
    if (!result.success) throw failure(result, `Failed to ${what}`)
    this.model.markSnapshotStale()
  }

  /**
   * Turns on what makes a whole status faster in this repository's own settings: git's untracked cache, and its own
   * file monitor where git has one (macOS and Windows, from 2.37). It writes the user's git settings, so a host does
   * it only when the user asks. Answers what is on now
   */
  async speedUpStatus(): Promise<{ fileMonitor: boolean; untrackedCache: boolean }> {
    const version = await this.runner.passUsableGit()
    const monitor = (process.platform === 'darwin' || process.platform === 'win32') && !olderThan(version, FILE_MONITOR_FROM)
    for (const [key, value] of [['core.untrackedCache', 'true'], ...(monitor ? [['core.fsmonitor', 'true']] : [])] as const) {
      const set = await this.runner.executeGitCommand(['config', '--local', key, value])
      if (!set.success) throw failure(set, `Failed to set ${key}`)
    }
    this.model.markSnapshotStale()
    return { fileMonitor: monitor, untrackedCache: true }
  }

  /** Deletes a local branch, merged or not; `undo` makes it again where it was, with what it followed */
  deleteBranch(name: string): Promise<void> {
    return this.writes.deleteBranch(name)
  }

  /**
   * Every write made here that `undo` can take back, newest first, in the last 14 days: a commit, an amend, a reset
   * to a commit, a merge, a rebase, a cherry-pick, a rewrite, a deleted branch, a dropped or cleared stash, and a
   * discard. Each with
   * whether `undo` would take it back now, and why not: what it says of an entry is what `undo` of it then does
   */
  undoables(): Promise<Undoable[]> {
    return this.journal.all()
  }

  /**
   * Takes back the write `undoables` lists under this id, and answers it: the one a host showed, whatever was
   * written since. A commit is taken off its branch with what it held left staged; a reset puts the branch and the
   * index back; a branch is made again; a stash is put back on top; a discard's files are put back, those changed
   * or made again since left as they are and named in the answer's `discard`, and the discard stays in the list until
   * a restore leaves nothing. Refused with `moved-since` when a ref it moved has moved since, with `published` for a
   * commit a remote branch already holds unless `evenIfPublished`, with `no-longer-kept` for a discard the store has
   * dropped, and with `nothing-to-undo` for an id the journal does not hold. A write like any other while it runs
   */
  undo(id: string, options?: { evenIfPublished?: boolean }): Promise<Undone> {
    return this.writes.withWriteFlag(() => this.journal.undo(id, options))
  }

  /**
   * Fetches what a pull request proposes from where GitHub keeps it, `refs/pull/<number>/head`, into
   * `refs/remotes/<remote>/pull/<number>`, and answers that ref. GitHub keeps it after the pull request's branch is
   * deleted, and for a pull request from a fork, whose branch is on no remote of this repository. Throws a `GitError`
   * when the remote has no such pull request
   */
  fetchPullRequest(number: number, remote?: string): Promise<string> {
    return this.writes.fetchPullRequest(number, remote)
  }

  /**
   * Fetches `branch` from `remote` (`origin` unless named) into its remote-tracking ref, and answers that ref.
   * Throws a `GitError` when the fetch fails, the remote having no such branch included
   */
  fetchRemoteBranch(branch: string, remote?: string): Promise<string> {
    return this.writes.fetchRemoteBranch(branch, remote)
  }

  /** Deletes `branch` on `remote` (`origin` unless named) */
  deleteRemoteBranch(branch: string, remote?: string): Promise<void> {
    return this.writes.deleteRemoteBranch(branch, remote)
  }

  /**
   * Deletes this repository's record of `branch` on `remote` (`origin` unless named), its remote-tracking ref, as
   * a fetch that prunes would: for a branch deleted on the remote by other means. The remote is not asked
   */
  deleteRemoteTrackingBranch(branch: string, remote?: string): Promise<void> {
    return this.writes.deleteRemoteTrackingBranch(branch, remote)
  }

  /**
   * Every local branch, then every remote one, each most recently committed first. A branch of `origin` is
   * named as the local branch it would be checked out as; one of another remote keeps `remotes/<remote>/`.
   */
  /**
   * Every branch, local and each remote's, with what it follows and how far ahead and behind it is, read in one
   * command; the remotes with their addresses; and the tags. The snapshot's `refs` part says when any of it moved.
   */
  refsModel(): Promise<RefsModel> {
    return this.refs.model()
  }

  readBranches(): Promise<string[]> {
    return this.reads.readBranches()
  }

  /**
   * Checks out a branch there is: a local one, or one a single remote has, which git makes a local branch
   * following it. A name no branch has is refused as `unknown-ref`, naming it, and `createBranch` makes one.
   * Nothing is fetched or pulled.
   */
  checkoutBranch(branchName: string, onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.writes.checkoutBranch(branchName, onProgress)
  }

  /**
   * Checks out `name` at the commit `at` names: made there where there is no such branch, checked out there where
   * the branch is at it or only behind it, and checked out where it is where it has commits of its own, which the
   * answer says (`BranchCheckout`). `track` makes a new branch follow `at`, a remote's branch; otherwise it follows
   * nothing. Nothing is fetched or pulled
   */
  checkoutBranchAt(name: string, at: string, options?: { track?: boolean; onProgress?: (progress: GitProgress) => void }): Promise<BranchCheckout> {
    return this.writes.checkoutBranchAt(name, at, options)
  }

  /**
   * Makes a branch at what is checked out and checks it out, writing down the branch it was made from
   * (`rememberedBaseOf`). A name a branch already has is refused as `branch-exists`.
   */
  createBranch(branchName: string): Promise<void> {
    return this.writes.createBranch(branchName)
  }

  /**
   * Pushes the branch, publishing it when it is not: to the remote the branch is set to push to, else `origin`,
   * else the only remote (`no-remote` when that leaves none). With no branch checked out it is refused as
   * `detached-head`. `signal` stops it, and the push then rejects with a `GitError` coded `aborted`
   */
  pushBranch(onProgress?: (progress: GitProgress) => void, signal?: AbortSignal): Promise<void> {
    return this.writes.pushBranch(onProgress, signal)
  }

  pullBranch(onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.writes.pullBranch(onProgress)
  }

  /**
   * Stashes the changes, untracked files included: only what is staged with `stagedOnly`, and only these paths
   * (from the top of the checkout) when `paths` names any
   */
  stashPush(message?: string, stagedOnly?: boolean, paths?: string[]): Promise<string> {
    return this.writes.stashPush(message, stagedOnly, paths)
  }

  stashList(): Promise<StashEntry[]> {
    return this.reads.stashList()
  }

  stashApply(index: number): Promise<void> {
    return this.writes.stashApply(index)
  }

  stashPop(index: number): Promise<void> {
    return this.writes.stashPop(index)
  }

  stashDrop(index: number): Promise<void> {
    return this.writes.stashDrop(index)
  }

  stashClear(): Promise<void> {
    return this.writes.stashClear()
  }

  worktreeList(): Promise<WorktreeEntry[]> {
    return this.reads.worktreeList()
  }

  worktreeAdd(wtPath: string, branch?: string, createBranch?: boolean): Promise<string> {
    return this.writes.worktreeAdd(wtPath, branch, createBranch)
  }

  worktreeRemove(wtPath: string, force?: boolean): Promise<void> {
    return this.writes.worktreeRemove(wtPath, force)
  }

  readCommitsBetween(baseBranch: string, targetBranch = 'HEAD'): Promise<{ subject: string; body: string }[]> {
    return this.reads.readCommitsBetween(baseBranch, targetBranch)
  }

  gitLog(count = 50): Promise<CommitLogEntry[]> {
    return this.reads.gitLog(count)
  }

  revertCommit(hash: string): Promise<void> {
    return this.writes.revertCommit(hash)
  }

  resetToCommit(hash: string): Promise<void> {
    return this.writes.resetToCommit(hash)
  }

  /**
   * The paths, among what discarding these would remove, that are too large for a discard to keep a copy of:
   * what a host says cannot be brought back, before it is discarded
   */
  discardNotKept(filePaths: string[]): Promise<string[]> {
    return this.writes.discardNotKept(filePaths)
  }

  /**
   * A file's bytes: as the working tree has it, as the last commit has it, or as it is staged. Nothing when
   * there is no such file, or it could not be read.
   */
  readFileBytes(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<Buffer | undefined> {
    return this.reads.readFileBytes(filePath, version)
  }

  /** A file's bytes as a branch has it, or nothing when the branch has no such file */
  readFileBytesFromBranch(filePath: string, branch: string): Promise<Buffer | undefined> {
    return this.reads.readFileBytesFromBranch(filePath, branch)
  }

  /**
   * The address of the remote this branch follows, as git would use it (its `insteadOf` rewrites applied).
   * Nothing where there is no remote.
   */
  readRemoteUrl(): Promise<string | undefined> {
    return this.reads.readRemoteUrl()
  }

  /**
   * The remote a pull request or a push goes to: the one the current branch follows, else `origin`, else the only
   * remote there is; with its address as git would use it. Nothing where there is no remote, or several and none of
   * them is followed or named `origin`
   */
  readRemote(): Promise<{ name: string; url: string } | undefined> {
    return this.reads.readRemote()
  }

  /** Every remote, with its address as git would use it (its `insteadOf` rewrites applied), in the order git lists them */
  readRemotes(): Promise<GitRemote[]> {
    return this.reads.readRemotes()
  }

  /** The commit two commits' histories last share, or nothing when they share none or one is not a commit here */
  mergeBase(first: string, second: string): Promise<string | undefined> {
    return this.reads.mergeBase(first, second)
  }

  /**
   * The branch this one was made from, where something wrote that down: this engine when it made the branch,
   * VS Code when it did, or git itself, whose record of a branch's first move says what it was made from when
   * it was given a name. Nothing when none did, or when what they name is gone.
   */
  rememberedBaseOf(branch: string): Promise<string | undefined> {
    return this.reads.rememberedBaseOf(branch)
  }

  /** How many commits the checked-out commit has that this branch does not: `Infinity` when git cannot say */
  readCommitDistance(branch: string): Promise<number> {
    return this.reads.readCommitDistance(branch)
  }

  /** The branches merged into the checked-out commit whose tip is within `depth` commits of it */
  findNearbyMergedBranches(depth: number): Promise<string[]> {
    return this.reads.findNearbyMergedBranches(depth)
  }

  /**
   * Fetches from the remote this branch follows, and says whether it did and, when it did not, why. When to
   * fetch is the host's to decide: nothing here fetches unasked.
   */
  fetch(signal?: AbortSignal): Promise<{ success: boolean; code?: GitErrorCode; error?: string }> {
    return this.writes.fetch(signal)
  }
}
