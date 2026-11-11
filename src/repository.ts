// One working tree's repository: the door's class. It holds the engine's four parts and is what a host calls;
// each method here is one of theirs.
import * as path from 'path'
import { GitReads } from './reads.ts'
import { RepositoryModel } from './model.ts'
import { GitRunner } from './runner.ts'
import type { RepositoryTies } from './ties.ts'
import { GitWrites } from './writes.ts'
import type { GitErrorCode } from './errors.ts'
import type { TrustReading } from './trust.ts'
import type {
  CommitLogEntry, DiffHunk, DiscardKept, DiscardRestored, GitDirectories, GitProgress, GitStatusFile, OperationMove, RepositoryChange, RepositorySnapshot, StashEntry, WorktreeEntry,
} from './types.ts'

export class GitRepository {
  private readonly runner: GitRunner
  private readonly model: RepositoryModel
  private readonly reads: GitReads
  private readonly writes: GitWrites

  constructor(private workingDirectory: string, ties: RepositoryTies = {}) {
    if (!path.isAbsolute(workingDirectory)) {
      throw new Error('Working directory must be an absolute path')
    }
    this.runner = new GitRunner(workingDirectory, ties)
    this.model = new RepositoryModel(this.runner, () => this.runner.writesInLine > 0 || this.writes.isWriteInProgress)
    this.reads = new GitReads(this.runner, this.model, ties)
    this.writes = new GitWrites(this.runner, this.model, this.reads)
  }

  getWorkingDir(): string {
    return this.workingDirectory
  }

  /**
   * Lets go of what is held open for this repository: the git kept running while files are read from commits.
   * It is used again as before, and that git is started again by the next such read. On a platform that will
   * not delete a directory a process is in, this is what lets the repository's be deleted at once.
   */
  close(): void {
    this.reads.close()
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

  get isWatched(): boolean {
    return this.model.isWatched
  }

  /** Whether this checkout's watches failed: a panel showing it then changes only when it is asked again */
  get hasWatchFailed(): boolean {
    return this.model.hasWatchFailed
  }

  invalidateCache(paths?: string[]): void {
    return this.reads.invalidateCache(paths)
  }

  getCurrentBranch(): Promise<string> {
    return this.reads.getCurrentBranch()
  }

  getStatus(): Promise<GitStatusFile[]> {
    return this.model.getStatus()
  }

  /**
   * The checkout's changed files, branch and distance from its upstream.
   *
   * A snapshot is reused until something says the repository may have changed: a watcher's event, a write made
   * here, a reconcile. It never waits on the remote: `fetchIfDue` is what fetches.
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

  getDiff(filePath?: string, staged: boolean = false): Promise<string> {
    return this.reads.getDiff(filePath, staged)
  }

  /**
   * Efficient multi-path diff: issues a single `git diff -- path1 path2 …`
   * for tracked files and builds synthetic diffs for untracked ones, avoiding
   * one git subprocess per file.
   */
  getDiffMulti(paths: string[]): Promise<string> {
    return this.reads.getDiffMulti(paths)
  }

  getFileContent(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<string> {
    return this.reads.getFileContent(filePath, version)
  }

  /**
   * The pieces of a file's change that can be staged one at a time, or unstaged when `staged`: of the working
   * tree against the index, or of the index against the last commit. None for a file that is not plainly modified.
   */
  getHunks(filePath: string, staged: boolean): Promise<DiffHunk[]> {
    return this.reads.getHunks(filePath, staged)
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
   * removed: `restoreDiscarded` puts it back. Nothing is removed when the copy could not be taken.
   */
  revertFile(filePath: string): Promise<DiscardKept> {
    return this.writes.revertFile(filePath)
  }

  /** The same for several at once, kept as one */
  revertFiles(filePaths: string[]): Promise<DiscardKept> {
    return this.writes.revertFiles(filePaths)
  }

  fileExistsInHead(filePath: string): Promise<boolean> {
    return this.reads.fileExistsInHead(filePath)
  }

  resolveConflict(filePath: string, strategy: 'ours' | 'theirs'): Promise<void> {
    return this.writes.resolveConflict(filePath, strategy)
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

  /** Whether the working directory is in a repository. Rejects when there is no git to ask. */
  isGitRepository(): Promise<boolean> {
    return this.reads.isGitRepository()
  }

  hasUncommittedChanges(): Promise<boolean> {
    return this.reads.hasUncommittedChanges()
  }

  getStagedFiles(): Promise<GitStatusFile[]> {
    return this.reads.getStagedFiles()
  }

  getUpstreamBranch(): Promise<string | null> {
    return this.reads.getUpstreamBranch()
  }

  getBaseBranch(options?: { preferUpstream?: boolean }): Promise<string> {
    return this.reads.getBaseBranch(options)
  }

  getBranchDiff(baseBranch: string, targetBranch?: string): Promise<GitStatusFile[]> {
    return this.reads.getBranchDiff(baseBranch, targetBranch)
  }

  /** Whether each of these names a commit in this repository */
  commitsExist(...refs: string[]): Promise<boolean> {
    return this.reads.commitsExist(...refs)
  }

  getFileContentFromBranch(filePath: string, branch: string): Promise<string> {
    return this.reads.getFileContentFromBranch(filePath, branch)
  }

  fetchRemoteBranch(branch: string): Promise<void> {
    return this.writes.fetchRemoteBranch(branch)
  }

  deleteRemoteBranch(branch: string): Promise<void> {
    return this.writes.deleteRemoteBranch(branch)
  }

  /**
   * Every local branch, then every remote one, each most recently committed first. A branch of `origin` is
   * named as the local branch it would be checked out as; one of another remote keeps `remotes/<remote>/`.
   */
  getAllBranches(): Promise<string[]> {
    return this.reads.getAllBranches()
  }

  checkoutBranch(branchName: string, onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.writes.checkoutBranch(branchName, onProgress)
  }

  isCurrentBranchPublished(): Promise<boolean> {
    return this.reads.isCurrentBranchPublished()
  }

  pushBranch(onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.writes.pushBranch(onProgress)
  }

  pullBranch(onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.writes.pullBranch(onProgress)
  }

  stashPush(message?: string, stagedOnly?: boolean): Promise<string> {
    return this.writes.stashPush(message, stagedOnly)
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

  getCommitsBetweenBranches(baseBranch: string, targetBranch = 'HEAD'): Promise<{ subject: string; body: string }[]> {
    return this.reads.getCommitsBetweenBranches(baseBranch, targetBranch)
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
   * Puts back what a discard kept, by the id it answered with. A path changed or made again since is left as it
   * is and named. Rejects when git no longer keeps it, which it does for as long as it keeps objects nothing
   * refers to: two weeks, unless the user's settings or a prune say otherwise.
   */
  restoreDiscarded(id: string): Promise<DiscardRestored> {
    return this.writes.restoreDiscarded(id)
  }

  /**
   * A file's bytes: as the working tree has it, as the last commit has it, or as it is staged. Nothing when
   * there is no such file, or it could not be read.
   */
  getFileBytes(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<Buffer | undefined> {
    return this.reads.getFileBytes(filePath, version)
  }

  /** A file's bytes as a branch has it, or nothing when the branch has no such file */
  getFileBytesFromBranch(filePath: string, branch: string): Promise<Buffer | undefined> {
    return this.reads.getFileBytesFromBranch(filePath, branch)
  }

  /**
   * The address of the remote this branch follows, as git would use it (its `insteadOf` rewrites applied).
   * Nothing where there is no remote.
   */
  getRemoteUrl(): Promise<string | undefined> {
    return this.reads.getRemoteUrl()
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
  getCommitDistance(branch: string): Promise<number> {
    return this.reads.getCommitDistance(branch)
  }

  /** The branches merged into the checked-out commit whose tip is within `depth` commits of it */
  getNearbyMergedBranches(depth: number): Promise<string[]> {
    return this.reads.getNearbyMergedBranches(depth)
  }

  /**
   * Fetches from the remote this branch follows, and says whether it did and, when it did not, why. When to
   * fetch is the host's to decide: nothing here fetches unasked.
   */
  fetch(): Promise<{ success: boolean; code?: GitErrorCode; error?: string }> {
    return this.writes.fetch()
  }
}
