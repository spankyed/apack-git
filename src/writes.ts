// What the engine changes in a repository. Every write marks the picture stale when it ends, and says it is
// running while it runs, so a watcher's report waits for it instead of racing it.
import * as path from 'path'
import * as fs from 'fs/promises'
import { commitArgument, refArgument, rowSpec, stashArgument } from './arguments.ts'
import { DiscardStore } from './discards.ts'
import { rebaseWithTodo, refusePublished } from './rewrite.ts'
import type { CheckpointStore } from './checkpoints.ts'
import type { Journal } from './journal.ts'
import { GitError, type GitErrorCode } from './errors.ts'
import { NOT_TEXT } from './status.ts'
import type { RepositoryModel } from './model.ts'
import { BASE_KEY, type GitReads } from './reads.ts'
import { failure, type GitCommandResult, type GitRunner } from './runner.ts'
import type { ConflictAnswer, DiscardKept, DiscardRestored, GitProgress, OperationMove, RewriteStep } from './types.ts'

/** A stash applied or popped with conflicts: its changes are in the working tree with conflict markers */
export class StashConflictError extends GitError {
  constructor(message: string) {
    super(message, 'conflict')
    this.name = 'StashConflictError'
  }
}

/** Refuses paths whose names are not text, naming them: git would be handed a name that is not theirs */
function refuseNamesNotText(paths: string[]): void {
  const unnamed = paths.filter(file => file.includes(NOT_TEXT))
  if (unnamed.length > 0) throw new GitError(`${unnamed.join(', ')}: ${unnamed.length === 1 ? 'its name is' : 'their names are'} not text, so ${unnamed.length === 1 ? 'it' : 'they'} cannot be named to git from here. Rename ${unnamed.length === 1 ? 'it' : 'them'} in a terminal.`, 'name-not-text')
}

export class GitWrites {
  private _writeInProgress = 0

  private _writeCompleteCallbacks: (() => void)[] = []

  private readonly discards: DiscardStore

  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, private readonly reads: GitReads, private readonly checkpoints: CheckpointStore, private readonly journal: Journal) {
    this.discards = new DiscardStore(runner, model, checkpoints)
  }

  /** Where a ref points, or `null` when there is none: `HEAD` before the first commit has none */
  private async revisionOf(ref: string): Promise<string | null> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--verify', '--quiet', ref])
    return result.success ? (result.output ?? '').trim() || null : null
  }

  /** The branch `HEAD` is on, as a full ref, or `HEAD` itself when it is on none */
  private async headRef(): Promise<string> {
    const result = await this.runner.executeGitCommand(['symbolic-ref', '--quiet', 'HEAD'])
    return result.success ? (result.output ?? '').trim() || 'HEAD' : 'HEAD'
  }

  /** The stashes there are, newest first, each with the commit it is and its message */
  private async stashes(): Promise<{ commit: string; message: string }[]> {
    const result = await this.runner.executeGitCommand(['stash', 'list', '-z', '--format=%H%x00%gs'])
    if (!result.success) return []
    const fields = (result.output ?? '').split('\0')
    const stashes: { commit: string; message: string }[] = []
    for (let at = 0; at + 1 < fields.length; at += 2) if (fields[at]) stashes.push({ commit: fields[at]!.trim(), message: fields[at + 1]! })
    return stashes
  }

  private get workingDirectory(): string {
    return this.runner.workingDirectory
  }

  get isWriteInProgress(): boolean {
    return this._writeInProgress > 0
  }

  /** Register a one-shot callback that fires when all pending writes finish. */
  onWriteComplete(callback: () => void): void {
    if (!this.isWriteInProgress) {
      callback()
    } else {
      this._writeCompleteCallbacks.push(callback)
    }
  }

  /** Wrap a write operation to track write-in-progress for watcher suppression. */
  async withWriteFlag<T>(fn: () => Promise<T>): Promise<T> {
    this._writeInProgress++
    try {
      return await fn()
    } finally {
      this.model.markSnapshotStale()
      this._writeInProgress--
      if (this._writeInProgress === 0 && this._writeCompleteCallbacks.length > 0) {
        const callbacks = this._writeCompleteCallbacks.splice(0)
        for (const cb of callbacks) {
          try { cb() } catch { /* ignore */ }
        }
      }
    }
  }

  /**
   * Stages one piece of a file's change, or with `staged` takes one piece out of what is staged. The piece is
   * named by its id, and is one this repository cuts from the file as it is now: one whose file changed under
   * it is refused, rather than applied to lines it was not made from.
   */
  async applyHunk(filePath: string, staged: boolean, id: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const hunk = (await this.reads.cutHunks(filePath, staged)).find(cut => cut.id === id)
      if (!hunk) throw new GitError('The file has changed since this change was read. It is shown as it is now: try again.')
      const result = await this.runner.executeGitCommand(['apply', '--cached', ...(staged ? ['--reverse'] : []), '--whitespace=nowarn', '-'], { input: Buffer.from(hunk.apply, 'latin1') })
      if (!result.success) throw failure(result, staged ? 'Failed to unstage the change' : 'Failed to stage the change')
    })
  }

  async stageFiles(filePaths: string[]): Promise<void> {
    refuseNamesNotText(filePaths)
    if (filePaths.length === 0) return
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['add', '--', ...filePaths.map(rowSpec)])
      if (!result.success) {
        throw failure(result, 'Failed to stage files')
      }
      this.model.markSnapshotStale()
    })
  }

  async unstageFiles(filePaths: string[]): Promise<void> {
    refuseNamesNotText(filePaths)
    if (filePaths.length === 0) return
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['reset', 'HEAD', '--', ...filePaths.map(rowSpec)])
      if (!result.success) {
        throw failure(result, 'Failed to unstage files')
      }
      this.model.markSnapshotStale()
    })
  }

  /**
   * Discards a file's changes, or an untracked file or folder, and answers with what it kept of what that
   * removed (`restoreDiscarded`). Nothing is removed when the copy could not be taken.
   */
  async revertFile(filePath: string): Promise<DiscardKept> {
    refuseNamesNotText([filePath])
    return this.withWriteFlag(async () => {
      const status = await this.model.readStatus()
      const fileStatus = status.find(f => f.path === filePath)
      const kept = await this.discards.keep([filePath])

      // A file inside a folder listed as one row is untracked too, though it has no row of its own
      const inAFolderRow = !fileStatus && status.some(f => f.isDirectory && filePath.startsWith(f.path))
      if (fileStatus?.status === 'untracked' || inAFolderRow) {
        await this.discardUntracked(filePath, fileStatus?.isDirectory === true)
      } else if (fileStatus?.status === 'unmerged') {
        // `git checkout --` refuses unmerged paths; explicit HEAD ref works
        // and clears the conflict state in both the index and worktree.
        const existsInHead = await this.reads.fileExistsInHead(filePath)
        if (existsInHead) {
          const result = await this.runner.executeGitCommand(['checkout', 'HEAD', '--', rowSpec(filePath)])
          if (!result.success) {
            throw failure(result, `Failed to revert file: ${filePath}`)
          }
        } else {
          // File was added by stash/merge — delete it and clean the index entry
          const fullPath = path.join(this.workingDirectory, filePath)
          await fs.unlink(fullPath)
          await this.runner.executeGitCommand(['rm', '--cached', '--force', '--', rowSpec(filePath)])
        }
      } else {
        const result = await this.runner.executeGitCommand(['checkout', '--', rowSpec(filePath)])
        if (!result.success) {
          throw failure(result, `Failed to revert file: ${filePath}`)
        }
      }
      this.model.markSnapshotStale()
      return kept
    })
  }

  /**
   * Discards an untracked path. A file is deleted. A folder has deleted what git lists in it, and what git
   * ignores there is left where it is, as it is when every file of the folder is discarded one by one.
   */
  async discardUntracked(filePath: string, isDirectory: boolean): Promise<void> {
    // A row's path is from the top of the checkout, which the working directory may be under
    const directories = this.model.gitDirectories ?? await this.model.resolveGitDirectories()
    const onDisk = path.resolve(this.workingDirectory, ...(directories?.prefix ?? '').split('/').filter(Boolean).map(() => '..'), filePath)
    if (!isDirectory) return fs.unlink(onDisk)
    // Git leaves a repository of its own where it is, and says nothing: said here, where it would read as done
    if (await fs.access(path.join(onDisk, '.git')).then(() => true, () => false)) {
      throw new GitError(`${filePath} is a repository of its own, which git does not remove. Delete the folder yourself if it is not wanted.`)
    }
    const result = await this.runner.executeGitCommand(['clean', '--force', '-d', '--quiet', '--', rowSpec(filePath)])
    if (!result.success) throw failure(result, `Failed to discard folder: ${filePath}`)
  }

  /** The same for several at once, kept as one */
  async revertFiles(filePaths: string[]): Promise<DiscardKept> {
    refuseNamesNotText(filePaths)
    if (filePaths.length === 0) return { notKept: [] }
    return this.withWriteFlag(async () => {
      const status = await this.model.readStatus()
      const statusMap = new Map(status.map(f => [f.path, f.status]))
      const kept = await this.discards.keep(filePaths)

      const untrackedPaths = filePaths.filter(p => statusMap.get(p) === 'untracked')
      const unmergedPaths = filePaths.filter(p => statusMap.get(p) === 'unmerged')
      const trackedPaths = filePaths.filter(p => {
        const s = statusMap.get(p)
        return s !== 'untracked' && s !== 'unmerged'
      })

      // Delete untracked files, and what git lists of untracked folders
      const folders = new Set(status.filter(f => f.isDirectory).map(f => f.path))
      for (const filePath of untrackedPaths) await this.discardUntracked(filePath, folders.has(filePath))

      // Revert unmerged files — split by whether they exist in HEAD
      if (unmergedPaths.length > 0) {
        const existsInHead: string[] = []
        const newFiles: string[] = []
        for (const p of unmergedPaths) {
          if (await this.reads.fileExistsInHead(p)) {
            existsInHead.push(p)
          } else {
            newFiles.push(p)
          }
        }
        if (existsInHead.length > 0) {
          const result = await this.runner.executeGitCommand(['checkout', 'HEAD', '--', ...existsInHead.map(rowSpec)])
          if (!result.success) {
            throw failure(result, 'Failed to revert unmerged files')
          }
        }
        for (const p of newFiles) {
          const fullPath = path.join(this.workingDirectory, p)
          await fs.unlink(fullPath)
          await this.runner.executeGitCommand(['rm', '--cached', '--force', '--', rowSpec(p)])
        }
      }

      // Revert tracked files
      if (trackedPaths.length > 0) {
        const result = await this.runner.executeGitCommand(['checkout', '--', ...trackedPaths.map(rowSpec)])
        if (!result.success) {
          throw failure(result, 'Failed to revert files')
        }
      }

      this.model.markSnapshotStale()
      return kept
    })
  }

  /** The paths, among what discarding these would remove, that are too large to keep a copy of */
  discardNotKept(filePaths: string[]): Promise<string[]> {
    return this.discards.notKeptOf(filePaths)
  }

  /** Puts back what a discard kept, leaving alone what has changed or been made again since */
  async restoreDiscarded(id: string): Promise<DiscardRestored> {
    return this.withWriteFlag(() => this.discards.restore(id))
  }

  /**
   * Resolves a conflicted file: with one side as it is, or with `content` written in its place, then marks it
   * resolved. A side that deleted the file resolves it by deleting it. The path is from the top of the checkout.
   */
  async resolveConflict(filePath: string, answer: ConflictAnswer): Promise<void> {
    return this.withWriteFlag(async () => {
      const directories = this.model.gitDirectories ?? await this.model.resolveGitDirectories()
      const top = path.resolve(this.workingDirectory, ...(directories?.prefix ?? '').split('/').filter(Boolean).map(() => '..'))
      const spec = rowSpec(filePath)
      if (typeof answer === 'object') {
        await fs.writeFile(path.join(top, filePath), answer.content)
      } else {
        const sides = await this.reads.conflictSides(filePath)
        if ((answer === 'ours' ? sides.ours : sides.theirs) === null) {
          const removed = await this.runner.executeGitCommand(['-C', top, 'rm', '--quiet', '--force', '--', spec])
          if (!removed.success) throw failure(removed, `Failed to resolve conflict with ${answer}`)
          this.model.markSnapshotStale()
          return
        }
        const result = await this.runner.executeGitCommand(['-C', top, 'checkout', `--${answer}`, '--', spec])
        if (!result.success) throw failure(result, `Failed to resolve conflict with ${answer}`)
      }
      const added = await this.runner.executeGitCommand(['-C', top, 'add', '--', spec])
      if (!added.success) throw failure(added, `Failed to mark ${filePath} resolved`)
      this.model.markSnapshotStale()
    })
  }

  /**
   * Carries on with what git is in the middle of, leaves out the commit a rebase stopped at, or gives it up.
   * Carrying on takes the message git proposes, there being no editor for it to open (`gitEnvironment`).
   */
  async moveOperation(move: OperationMove): Promise<void> {
    const operation = (await this.model.currentSnapshot()).operation
    if (!operation) throw new Error('Git is not in the middle of anything in this repository')
    if (move === 'skip' && operation.kind !== 'rebase') throw new Error(`Only a rebase has a commit to skip, and this is a ${operation.kind}`)
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand([operation.kind, `--${move}`])
      this.model.markSnapshotStale()
      if (result.success) return
      // A rebase that went on to its next commit and stopped there, at a conflict, did what was asked
      const now = (await this.model.currentSnapshot()).operation
      if (now?.kind === 'rebase' && (now.step ?? 0) > (operation.step ?? 0)) return
      throw failure(result, `Could not ${move} the ${operation.kind}`)
    })
  }

  async commit(message: string): Promise<void> {
    if (!message.trim()) {
      throw new Error('Commit message cannot be empty')
    }
    return this.withWriteFlag(async () => {
      const ref = await this.headRef()
      const before = await this.revisionOf('HEAD')
      const result = await this.runner.executeGitCommand(['commit', '-m', message])
      if (!result.success) {
        throw failure(result, 'Failed to commit')
      }
      const subject = message.trim().split('\n')[0]!
      await this.journal.record({ operation: 'commit', summary: `commit "${subject}"`, refs: [{ ref, before, after: await this.revisionOf('HEAD') }] })
    })
  }

  /**
   * Runs a merge, a rebase or a cherry-pick after a checkpoint of the working tree, and writes it down once it has
   * gone through, so that `undo` can take it back. One that stops on conflicts is the operation in progress the
   * snapshot describes, carried on with or given up through `moveOperation`, and is refused here with `conflict`.
   */
  private async startOperation(operation: 'merge' | 'rebase' | 'cherry-pick', args: string[], summary: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const ref = await this.headRef()
      const before = await this.revisionOf('HEAD')
      const { id: checkpoint } = await this.checkpoints.checkpoint()
      const result = await this.runner.executeGitCommand(args)
      this.reads.clearCache()
      if (!result.success) throw failure(result, `Failed to ${summary}`)
      await this.journal.record({ operation, summary, refs: [{ ref, before, after: await this.revisionOf('HEAD') }], checkpoint })
    })
  }

  /** Makes a tag at `commit` (what is checked out when none), annotated with `message` when one is given */
  async createTag(name: string, { commit, message }: { commit?: string; message?: string } = {}): Promise<void> {
    return this.withWriteFlag(async () => {
      const args = ['tag', ...(message !== undefined ? ['-a', '-m', message] : []), refArgument(name, 'tag'), ...(commit ? [refArgument(commit, 'commit')] : [])]
      const result = await this.runner.executeGitCommand(args)
      if (!result.success) throw failure(result, `Failed to make the tag ${name}`)
    })
  }

  async deleteTag(name: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['tag', '--delete', refArgument(name, 'tag')])
      if (!result.success) throw failure(result, `Failed to delete the tag ${name}`)
    })
  }

  /** Pushes a tag to a remote, `origin` unless another is named, with progress, stopped through `signal` */
  async pushTag(name: string, { remote = 'origin', onProgress, signal }: { remote?: string; onProgress?: (progress: GitProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
    const result = await this.runner.executeGitCommand(['push', '--progress', refArgument(remote, 'remote'), `refs/tags/${refArgument(name, 'tag')}`], { onProgress, signal })
    if (!result.success) throw result.code === 'aborted' ? new GitError('The push was stopped', 'aborted') : failure(result, `Failed to push the tag ${name}`)
  }

  /** Renames a local branch, and what it follows with it; refused when a branch already has the new name */
  async renameBranch(name: string, to: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['branch', '--move', refArgument(name, 'branch'), refArgument(to, 'branch')])
      if (!result.success) throw failure(result, `Failed to rename ${name}`)
      this.reads.clearCache()
    })
  }

  /**
   * Amends the last commit with what is staged, and with `message` in place of its own when given. Refused for a
   * commit a remote branch already holds, unless `evenIfPublished`. Written in the journal, so `undo` takes it back
   * and leaves what it took in staged
   */
  async amend({ message, evenIfPublished = false }: { message?: string; evenIfPublished?: boolean } = {}): Promise<void> {
    if (message !== undefined && !message.trim()) throw new Error('Commit message cannot be empty')
    return this.withWriteFlag(async () => {
      const ref = await this.headRef()
      const before = await this.revisionOf('HEAD')
      if (!before) throw new GitError('There is no commit to amend yet.')
      await refusePublished(this.runner, `${before}~1`, evenIfPublished)
      const result = await this.runner.executeGitCommand(['commit', '--amend', '--allow-empty', ...(message === undefined ? ['--no-edit'] : ['-m', message])])
      if (!result.success) throw failure(result, 'Failed to amend the last commit')
      this.reads.clearCache()
      await this.journal.record({ operation: 'amend', summary: 'amending the last commit', refs: [{ ref, before, after: await this.revisionOf('HEAD') }] })
    })
  }

  /**
   * Rewrites the commits after `base`: `steps` name each of them in the order they are to stand, kept, reworded,
   * folded into the one before or dropped. Runs after a checkpoint of the working tree, refused for a range a remote
   * branch already holds part of unless `evenIfPublished`, and written in the journal so `undo` takes it back
   */
  async rewrite(base: string, steps: RewriteStep[], { evenIfPublished = false }: { evenIfPublished?: boolean } = {}): Promise<void> {
    return this.withWriteFlag(async () => {
      const ref = await this.headRef()
      const before = await this.revisionOf('HEAD')
      await refusePublished(this.runner, base, evenIfPublished)
      const { id: checkpoint } = await this.checkpoints.checkpoint()
      try {
        await rebaseWithTodo(this.runner, base, steps)
      } finally {
        this.reads.clearCache()
      }
      await this.journal.record({ operation: 'rewrite', summary: `rewriting ${steps.length === 1 ? 'a commit' : `${steps.length} commits`}`, refs: [{ ref, before, after: await this.revisionOf('HEAD') }], checkpoint })
    })
  }

  /** Merges a branch or a commit into what is checked out, with the message git proposes */
  merge(target: string): Promise<void> {
    return this.startOperation('merge', ['merge', '--no-edit', refArgument(target, 'branch')], `merge ${target}`)
  }

  /** Replays what is checked out onto a branch or a commit */
  rebaseOnto(target: string): Promise<void> {
    return this.startOperation('rebase', ['rebase', refArgument(target, 'branch')], `rebase onto ${target}`)
  }

  /** Applies commits onto what is checked out, oldest first */
  cherryPick(commits: string[]): Promise<void> {
    if (commits.length === 0) return Promise.resolve()
    return this.startOperation('cherry-pick', ['cherry-pick', ...commits.map(commitArgument)], `cherry-pick ${commits.map(commit => commit.slice(0, 7)).join(', ')}`)
  }

  /**
   * Deletes a local branch, whether or not it was merged, and writes down where it pointed and what it followed,
   * so that `undo` can make it again
   */
  async deleteBranch(name: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const ref = `refs/heads/${refArgument(name, 'branch')}`
      const before = await this.revisionOf(ref)
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const settings = await this.runner.executeGitCommand(['config', '--get-regexp', `^branch\\.${escaped}\\.`])
      const config = (settings.output ?? '').split('\n').filter(Boolean).map((line) => {
        const space = line.indexOf(' ')
        return [line.slice(0, space), line.slice(space + 1)] as [string, string]
      })
      const result = await this.runner.executeGitCommand(['branch', '--delete', '--force', '--', refArgument(name, 'branch')])
      if (!result.success) throw failure(result, `Failed to delete branch ${name}`)
      await this.journal.record({ operation: 'delete-branch', summary: `deleting branch ${name}`, refs: [{ ref, before, after: null }], config })
    })
  }

  async fetchRemoteBranch(branch: string): Promise<void> {
    return this.withWriteFlag(async () => {
      await this.runner.executeGitCommand(['fetch', 'origin', refArgument(branch, 'branch')])
    })
  }

  async fetchPullRequest(number: number, remote = 'origin'): Promise<string> {
    if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid pull request number: ${JSON.stringify(number)}`)
    const ref = `refs/remotes/${refArgument(remote, 'remote')}/pull/${number}`
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['fetch', '--no-tags', remote, `+refs/pull/${number}/head:${ref}`])
      if (!result.success) throw failure(result, `Failed to fetch pull request #${number}`)
      return ref
    })
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['push', 'origin', '--delete', refArgument(branch, 'branch')])
      if (!result.success) {
        throw failure(result, 'Failed to delete remote branch')
      }
    })
  }

  async checkoutBranch(branchName: string, onProgress?: (progress: GitProgress) => void): Promise<void> {
    if (!branchName.trim()) {
      throw new Error('Branch name cannot be empty')
    }
    
    // Validate branch name to prevent command injection
    if (branchName.startsWith('-') || !/^[a-zA-Z0-9._/-]+$/.test(branchName)) {
      throw new Error('Invalid branch name. Branch names can only contain letters, numbers, dots, underscores, hyphens, and forward slashes.')
    }
    
    return this.withWriteFlag(async () => {
      // The branch this one is made from, if it has to be made here: where it was is not written down otherwise
      const from = await this.reads.readCurrentBranch().catch(() => 'HEAD')
      // Try to checkout the branch
      // The `--` ends the names of branches: without it, a name that is no branch and is a tracked file or folder
      // is checked out as that path, over whatever was changed in it
      const result = await this.runner.executeGitCommand(['checkout', '--progress', branchName, '--'], { onProgress })

      if (!result.success) {
        // Check if it's because the branch doesn't exist locally or can't be resolved
        if (result.code === 'unknown-ref') {
          // Try to create a new branch tracking the remote
          const remoteResult = await this.runner.executeGitCommand(['checkout', '-b', branchName, `origin/${branchName}`])
          if (!remoteResult.success) {
            // If that fails too, just create a new local branch
            const newBranchResult = await this.runner.executeGitCommand(['checkout', '-b', branchName])
            if (!newBranchResult.success) {
              throw failure(newBranchResult, `Failed to create branch: ${branchName}`)
            }
            if (from !== 'HEAD') await this.runner.executeGitCommand(['config', `branch.${branchName}.${BASE_KEY}`, from])
          }
        } else if (result.code === 'local-changes') {
          // Git is preventing checkout due to conflicts
          throw new GitError('Cannot switch branches: Your uncommitted changes conflict with files in the target branch. Please commit, stash, or discard your changes first.', result.code)
        } else {
          throw failure(result, `Failed to checkout branch: ${branchName}`)
        }
      }

      // After successful checkout, pull latest (best-effort)
      try {
        const hasUpstream = await this.reads.isCurrentBranchPublished()
        if (hasUpstream) {
          await this.runner.executeGitCommand(['pull'])
        }
      } catch {
        // Pull failed (network issue, etc.) — checkout still succeeded, so ignore
      }

      // Clear cache after branch switch
      this.reads.clearCache()
    })
  }

  /**
   * Pushes the branch, publishing it when it is not. `signal` stops it: git is ended with what it started, and
   * the push rejects with a `GitError` coded `aborted`. A push stopped part-way leaves the working tree and the
   * index as they were; the remote has the push or it does not.
   */
  async pushBranch(onProgress?: (progress: GitProgress) => void, signal?: AbortSignal): Promise<void> {
    return this.withWriteFlag(async () => {
      // Check if branch is published
      const isPublished = await this.reads.isCurrentBranchPublished()

      // Use appropriate push command
      // Use HEAD instead of branch name for unpublished branches to avoid
      // case-sensitivity issues on macOS (git push -u origin <name> fails
      // when the ref case doesn't match the filesystem case)
      const args = isPublished
        ? ['push', '--progress']
        : ['push', '--progress', '-u', 'origin', 'HEAD']

      const result = await this.runner.executeGitCommand(args, { onProgress, signal })

      if (!result.success) {
        // What a stopped git did before it ended is read afresh
        if (result.code === 'aborted') this.model.markSnapshotStale()
        throw new GitError(result.code === 'aborted' ? 'The push was stopped' : result.error || 'git gave no reason', result.code)
      }

      this.reads.clearCache()
    })
  }

  async pullBranch(onProgress?: (progress: GitProgress) => void): Promise<void> {
    return this.withWriteFlag(async () => {
      // Check if we have an upstream branch
      const hasUpstream = await this.reads.isCurrentBranchPublished()
      if (!hasUpstream) {
        throw new Error('No upstream branch to pull from. Push your branch first.')
      }

      // Execute git pull
      const result = await this.runner.executeGitCommand(['pull', '--progress'], { onProgress })

      if (!result.success) {
        throw new GitError(result.error || 'git gave no reason', result.code)
      }

      this.reads.clearCache()
    })
  }

  // --- Stash operations ---

  /**
   * Stashes the changes, untracked files included: only what is staged with `stagedOnly`, and only these paths
   * (from the top of the checkout) when `paths` names any
   */
  async stashPush(message?: string, stagedOnly?: boolean, paths?: string[]): Promise<string> {
    return this.withWriteFlag(async () => {
      const args = ['stash', 'push']
      if (message) {
        args.push('-m', message)
      }
      if (stagedOnly) {
        args.push('--staged')
      } else {
        args.push('--include-untracked')
      }
      if (paths?.length) args.push('--', ...paths.map(rowSpec))
      const result = await this.runner.executeGitCommand(args)
      if (!result.success) {
        throw failure(result, 'Failed to stash changes')
      }
      this.reads.clearCache()
      return result.output || 'Changes stashed'
    })
  }

  async stashApply(index: number): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['stash', 'apply', stashArgument(index)])
      if (!result.success) {
        if (this.isStashConflict(result)) {
          // Stash was applied — unmerged files now exist. Refresh cache so
          // the UI picks them up, then signal the conflict upward.
          this.reads.clearCache()
          throw new StashConflictError(result.error || 'Stash applied with conflicts')
        }
        throw failure(result, 'Failed to apply stash')
      }
      this.reads.clearCache()
    })
  }

  async stashPop(index: number): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['stash', 'pop', stashArgument(index)])
      if (!result.success) {
        if (this.isStashConflict(result)) {
          // `git stash pop` with conflicts leaves the stash in place and
          // still applies unmerged files — refresh cache and signal conflict.
          this.reads.clearCache()
          throw new StashConflictError(result.error || 'Stash popped with conflicts — stash retained')
        }
        throw failure(result, 'Failed to pop stash')
      }
      this.reads.clearCache()
    })
  }

  isStashConflict(result: GitCommandResult): boolean {
    return result.code === 'conflict'
  }

  async stashDrop(index: number): Promise<void> {
    return this.withWriteFlag(async () => {
      const dropped = (await this.stashes())[index]
      const result = await this.runner.executeGitCommand(['stash', 'drop', stashArgument(index)])
      if (!result.success) {
        throw failure(result, 'Failed to drop stash')
      }
      if (dropped) await this.journal.record({ operation: 'drop-stash', summary: `dropping stash "${dropped.message}"`, refs: [], stashes: [dropped] })
    })
  }

  async stashClear(): Promise<void> {
    return this.withWriteFlag(async () => {
      const cleared = await this.stashes()
      const result = await this.runner.executeGitCommand(['stash', 'clear'])
      if (!result.success) {
        throw failure(result, 'Failed to clear stashes')
      }
      if (cleared.length > 0) await this.journal.record({ operation: 'clear-stashes', summary: `clearing ${cleared.length === 1 ? 'a stash' : `${cleared.length} stashes`}`, refs: [], stashes: cleared })
    })
  }

  async worktreeAdd(wtPath: string, branch?: string, createBranch?: boolean): Promise<string> {
    return this.withWriteFlag(async () => {
      const args = ['worktree', 'add']
      if (createBranch && branch) {
        args.push('-b', refArgument(branch, 'branch'), '--', wtPath)
      } else if (branch) {
        args.push('--', wtPath, refArgument(branch, 'branch'))
      } else {
        args.push('--', wtPath)
      }

      const result = await this.runner.executeGitCommand(args)
      if (!result.success) {
        throw failure(result, 'Failed to add worktree')
      }
      return wtPath
    })
  }

  async worktreeRemove(wtPath: string, force?: boolean): Promise<void> {
    return this.withWriteFlag(async () => {
      const args = ['worktree', 'remove']
      if (force) args.push('--force')
      args.push('--', wtPath)

      const result = await this.runner.executeGitCommand(args)
      if (!result.success) {
        throw failure(result, 'Failed to remove worktree')
      }
    })
  }

  async revertCommit(hash: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['revert', '--no-edit', commitArgument(hash)])
      if (!result.success) {
        throw failure(result, `Failed to revert commit ${hash}`)
      }
      this.reads.clearCache()
    })
  }

  async resetToCommit(hash: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const ref = await this.headRef()
      const before = await this.revisionOf('HEAD')
      // A copy of the working tree first: the reset leaves the files as they are, and anything after it may not
      const { id: checkpoint } = await this.checkpoints.checkpoint()
      const result = await this.runner.executeGitCommand(['reset', commitArgument(hash)])
      if (!result.success) {
        throw failure(result, `Failed to reset to commit ${hash}`)
      }
      this.reads.clearCache()
      await this.journal.record({ operation: 'reset', summary: `resetting to ${hash.slice(0, 7)}`, refs: [{ ref, before, after: await this.revisionOf('HEAD') }], checkpoint })
    })
  }

  /**
   * Fetches from the remote this branch follows, and says whether it did and, when it did not, why. It waits for
   * no write and marks the picture stale: what the fetch brought is found by the check that follows it.
   */
  async fetch(signal?: AbortSignal): Promise<{ success: boolean; code?: GitErrorCode; error?: string }> {
    const result = await this.runner.executeGitCommand(['fetch', '--quiet'], { signal })
    this.model.markSnapshotStale()
    return { success: result.success, ...(result.code && { code: result.code }), ...(result.error && { error: result.error }) }
  }
}
