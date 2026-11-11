// What the engine changes in a repository. Every write marks the picture stale when it ends, and says it is
// running while it runs, so a watcher's report waits for it instead of racing it.
import * as path from 'path'
import * as fs from 'fs/promises'
import { commitArgument, refArgument, rowSpec, stashArgument } from './arguments.ts'
import { GitError, type GitErrorCode } from './errors.ts'
import type { RepositoryModel } from './model.ts'
import { BASE_KEY, type GitReads } from './reads.ts'
import { failure, type GitCommandResult, type GitRunner } from './runner.ts'
import type { GitProgress, OperationMove } from './types.ts'

/** Thrown when a stash apply/pop succeeds partially but leaves conflicts. */
export class StashConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StashConflictError'
  }
}

export class GitWrites {
  private _writeInProgress = 0

  private _writeCompleteCallbacks: (() => void)[] = []

  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, private readonly reads: GitReads) {}

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
    if (filePaths.length === 0) return
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['reset', 'HEAD', '--', ...filePaths.map(rowSpec)])
      if (!result.success) {
        throw failure(result, 'Failed to unstage files')
      }
      this.model.markSnapshotStale()
    })
  }

  async revertFile(filePath: string): Promise<void> {
    return this.withWriteFlag(async () => {
      const status = await this.model.getStatus()
      const fileStatus = status.find(f => f.path === filePath)

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

  async revertFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return
    return this.withWriteFlag(async () => {
      const status = await this.model.getStatus()
      const statusMap = new Map(status.map(f => [f.path, f.status]))

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
    })
  }

  async resolveConflict(filePath: string, strategy: 'ours' | 'theirs'): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['checkout', `--${strategy}`, '--', filePath])
      if (!result.success) {
        throw failure(result, `Failed to resolve conflict with ${strategy}`)
      }
      await this.runner.executeGitCommand(['add', '--', filePath])
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
      const result = await this.runner.executeGitCommand(['commit', '-m', message])
      if (!result.success) {
        throw failure(result, 'Failed to commit')
      }
    })
  }

  async fetchRemoteBranch(branch: string): Promise<void> {
    return this.withWriteFlag(async () => {
      await this.runner.executeGitCommand(['fetch', 'origin', refArgument(branch, 'branch')])
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
      const from = await this.reads.getCurrentBranch().catch(() => 'HEAD')
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

  async pushBranch(onProgress?: (progress: GitProgress) => void): Promise<void> {
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

      const result = await this.runner.executeGitCommand(args, { onProgress })

      if (!result.success) {
        throw new GitError(result.error || 'git gave no reason', result.code)
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

  async stashPush(message?: string, stagedOnly?: boolean): Promise<string> {
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
      const result = await this.runner.executeGitCommand(['stash', 'drop', stashArgument(index)])
      if (!result.success) {
        throw failure(result, 'Failed to drop stash')
      }
    })
  }

  async stashClear(): Promise<void> {
    return this.withWriteFlag(async () => {
      const result = await this.runner.executeGitCommand(['stash', 'clear'])
      if (!result.success) {
        throw failure(result, 'Failed to clear stashes')
      }
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
      const result = await this.runner.executeGitCommand(['reset', commitArgument(hash)])
      if (!result.success) {
        throw failure(result, `Failed to reset to commit ${hash}`)
      }
      this.reads.clearCache()
    })
  }

  /**
   * Fetches from the remote this branch follows, and says whether it did and, when it did not, why. It waits for
   * no write and marks the picture stale: what the fetch brought is found by the check that follows it.
   */
  async fetch(): Promise<{ success: boolean; code?: GitErrorCode; error?: string }> {
    const result = await this.runner.executeGitCommand(['fetch', '--quiet'])
    this.model.markSnapshotStale()
    return { success: result.success, ...(result.code && { code: result.code }), ...(result.error && { error: result.error }) }
  }
}
