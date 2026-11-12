// What the engine reads of a repository beyond its status: diffs, files as commits have them, branches, the log,
// stashes and worktrees.
import * as path from 'path'
import * as fs from 'fs/promises'
import { recordsOf, refArgument, rowSpec } from './arguments.ts'
import { hunksOf, type CutHunk } from './hunks.ts'
import type { RepositoryModel } from './model.ts'
import { GitObjectReader } from './objects.ts'
import { failure, type GitRunner } from './runner.ts'
import { GitUnusableError } from './git-check.ts'
import { ownershipRefusal } from './errors.ts'
import { statusOf } from './status.ts'
import type { RepositoryTies } from './ties.ts'
import type { CommitLogEntry, DiffHunk, GitStatusFile, StashEntry, WorktreeEntry } from './types.ts'

/** Where the branch a branch was made from is written down, in git's config: `branch.<name>.apack-base` */
export const BASE_KEY = 'apack-base'

/** The most files of an untracked folder that are listed when it is opened; past it the list is cut and says so */
export const UNTRACKED_LISTED_LIMIT = 1_000

interface CachedResult<T> {
  data: T
  timestamp: number
}

export class GitReads {
  private cache = new Map<string, CachedResult<any>>()

  private readonly CACHE_TTL = 5000

  /** Reads files as commits have them, through one git kept open while they are being read */
  private readonly objects: GitObjectReader

  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel, ties: RepositoryTies = {}) {
    this.objects = new GitObjectReader(runner.workingDirectory, runner.environment, ties.watchProcess, undefined, undefined, runner.git)
  }

  private get workingDirectory(): string {
    return this.runner.workingDirectory
  }

  /** Ends the git kept open for reading files, which the next read of one starts again; settles once it has gone */
  close(): Promise<void> {
    return this.objects.close()
  }

  /** Forgets what was kept of reads that do not change often, without saying the repository changed */
  forget(): void {
    this.cache.clear()
  }

  /**
   * The file a commit has under a name like `HEAD:src/a.ts`, or nothing when it has none. Through the git kept
   * open for it, and by a process of its own when that one cannot be asked: a name it cannot carry, or a git
   * that ended. Never for the index (`:src/a.ts`), which that git would go on answering from as it first read it.
   */
  async fileInCommit(name: string): Promise<Buffer | undefined> {
    // The git kept open is a git like any other: none is started in a repository that is not trusted
    await this.runner.trust.pass()
    try {
      return await this.objects.read(name)
    } catch {
      try {
        return await this.runner.executeGitCommandBinary(['show', name])
      } catch {
        return undefined
      }
    }
  }

  
  
  getCached<T>(key: string): T | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    
    const now = Date.now()
    if (now - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(key)
      return null
    }
    
    return cached.data
  }

  
  setCached<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    })
  }

  
  clearCache(): void {
    this.cache.clear()
    this.model.markSnapshotStale()
  }

  async isDirectory(filePath: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.workingDirectory, filePath)
      const stats = await fs.stat(fullPath)
      return stats.isDirectory()
    } catch {
      return false
    }
  }

  // Invalidate specific cache entries when files change
  invalidateCache(paths?: string[]): void {
    if (!paths || paths.length === 0) {
      // Clear everything if no specific paths
      this.clearCache()
      return
    }
    
    // Always invalidate status when any file changes
    this.model.markSnapshotStale()
    
    // If .git files changed, invalidate branch-related caches
    if (paths.some(p => p.includes('.git'))) {
      this.cache.delete('baseBranch')
      this.cache.delete('prBaseBranch')
      this.cache.delete('gitRepoValidated')
    }
    
    // Invalidate binary file cache for changed files
    paths.forEach(path => {
      this.cache.delete(`binary:${path}`)
    })
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (result.success && result.output) {
      return result.output.trim()
    }
    throw failure(result, 'Failed to get current branch')
  }


  /**
   * The files in an untracked folder that git would list, were it asked to list every one: those it does not
   * ignore. `directory` is a folder row's path, from the top of the checkout.
   */
  async listUntracked(directory: string): Promise<{ files: string[]; truncated: boolean }> {
    const result = await this.runner.executeGitCommand(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', `:(top,literal)${directory.replace(/\/$/, '')}`])
    if (!result.success && !result.truncated) throw failure(result, 'Failed to list the folder')
    const output = result.truncated ? (result.output ?? '').slice(0, (result.output ?? '').lastIndexOf('\0') + 1) : result.output ?? ''
    // Git does not look inside a repository of its own, and answers with the folder: it has no files to list here
    const files = output.split('\0').filter(file => file && !file.endsWith('/'))
    return { files: files.slice(0, UNTRACKED_LISTED_LIMIT), truncated: result.truncated === true || files.length > UNTRACKED_LISTED_LIMIT }
  }

  /**
   * The directories git ignores under the working directory, relative to it: what a watcher of the working
   * tree need not report from.
   */
  async listIgnoredDirectories(): Promise<string[]> {
    const result = await this.runner.executeGitCommand(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
    if (!result.success || !result.output) return []
    return result.output.split('\0').filter(entry => entry.endsWith('/')).map(entry => entry.slice(0, -1))
  }

  async isBinaryFile(filePath: string): Promise<boolean> {
    // Check cache first
    const cacheKey = `binary:${filePath}`
    const cached = this.getCached<boolean>(cacheKey)
    if (cached !== null) return cached
    
    // First, try git's built-in binary detection
    const gitResult = await this.runner.executeGitCommand(['check-attr', 'diff', '--', filePath])
    if (gitResult.success && gitResult.output) {
      // Git attributes format: "path: diff: value"
      const isBinary = gitResult.output.includes(': diff: binary') || 
                      gitResult.output.includes(': diff: -diff')
      if (isBinary) {
        this.setCached(cacheKey, true)
        return true
      }
    }
    
    // If git doesn't say it's binary, check if it's text according to git
    const diffStatResult = await this.runner.executeGitCommand(['diff', '--numstat', '/dev/null', filePath])
    if (diffStatResult.success && diffStatResult.output) {
      // Binary files show as "-\t-\tfilename" in numstat
      if (diffStatResult.output.startsWith('-\t-\t')) {
        this.setCached(cacheKey, true)
        return true
      }
    }
    
    // Fallback to quick heuristic for untracked files
    try {
      const stats = await fs.stat(filePath)
      // Large files are likely binary
      if (stats.size > 1024 * 1024) {
        this.setCached(cacheKey, true)
        return true // > 1MB
      }
      
      // Only read first 512 bytes for performance
      const buffer = Buffer.alloc(512)
      const fd = await fs.open(filePath, 'r')
      try {
        const { bytesRead } = await fd.read(buffer, 0, 512, 0)
        if (bytesRead === 0) {
          this.setCached(cacheKey, false)
          return false
        }
        
        // Check for BOM (Byte Order Mark) for UTF-16/UTF-32
        if (bytesRead >= 2) {
          const bom16LE = buffer[0] === 0xFF && buffer[1] === 0xFE
          const bom16BE = buffer[0] === 0xFE && buffer[1] === 0xFF
          if (bom16LE || bom16BE) {
            this.setCached(cacheKey, false)
            return false // UTF-16 text file
          }
        }
        
        if (bytesRead >= 4) {
          const bom32LE = buffer[0] === 0xFF && buffer[1] === 0xFE && buffer[2] === 0x00 && buffer[3] === 0x00
          const bom32BE = buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xFE && buffer[3] === 0xFF
          if (bom32LE || bom32BE) {
            this.setCached(cacheKey, false)
            return false // UTF-32 text file
          }
        }
        
        // Check for null bytes (but skip if it might be UTF-16/32)
        let nullCount = 0
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 0) nullCount++
        }
        
        // If many nulls but not in UTF-16/32 pattern, it's binary
        if (nullCount > bytesRead * 0.3) {
          this.setCached(cacheKey, true)
          return true
        }
        
        // Check for high ratio of non-printable characters
        let nonPrintable = 0
        for (let i = 0; i < bytesRead; i++) {
          const byte = buffer[i]!
          if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
            nonPrintable++
          }
        }
        
        const isBinary = nonPrintable / bytesRead > 0.3
        this.setCached(cacheKey, isBinary)
        return isBinary
      } finally {
        await fd.close()
      }
    } catch {
      this.setCached(cacheKey, false)
      return false
    }
  }

  async getDiff(filePath?: string, staged: boolean = false): Promise<string> {
    // For untracked files, we need to show the file content as an addition
    if (filePath) {
      const status = await this.model.getStatus()
      const fileStatus = status.find(f => f.path === filePath && f.staged === staged)

      if (fileStatus?.status === 'untracked') {
        return this.buildSyntheticDiff(filePath)
      }
    }

    const args = ['diff', '--binary', '-M']
    if (staged) {
      args.push('--cached')
    }
    if (filePath) {
      args.push('--', filePath)
    }

    const result = await this.runner.executeGitCommand(args)
    if (!result.success) {
      throw failure(result, 'Failed to get diff')
    }

    return result.output || ''
  }

  /**
   * Efficient multi-path diff: issues a single `git diff -- path1 path2 …`
   * for tracked files and builds synthetic diffs for untracked ones, avoiding
   * one git subprocess per file.
   */
  async getDiffMulti(paths: string[]): Promise<string> {
    const unique = [...new Set(paths)]
    const status = await this.model.getStatus()
    const untrackedSet = new Set(
      status.filter(f => f.status === 'untracked').map(f => f.path),
    )

    const tracked: string[] = []
    const untracked: string[] = []
    const external: string[] = []
    for (const p of unique) {
      if (path.isAbsolute(p) && !p.startsWith(this.workingDirectory + '/')) {
        external.push(p)
      } else if (untrackedSet.has(p)) {
        untracked.push(p)
      } else {
        tracked.push(p)
      }
    }

    const chunks: string[] = []

    // Single git command for all tracked files
    if (tracked.length > 0) {
      const args = ['diff', 'HEAD', '--binary', '-M', '--', ...tracked]
      const result = await this.runner.executeGitCommand(args)
      if (!result.success) {
        throw failure(result, 'Failed to get diff')
      }
      if (result.output) chunks.push(result.output)
    }

    // Synthetic diffs for untracked files (no git subprocess needed)
    for (const p of untracked) {
      chunks.push(await this.buildSyntheticDiff(p))
    }

    // Synthetic diffs for external (out-of-repo) files
    for (const p of external) {
      chunks.push(await this.buildSyntheticDiffAbsolute(p))
    }

    return chunks.filter(Boolean).join('\n')
  }

  /** Build a synthetic diff for an untracked file (new file / directory / binary). */
  async buildSyntheticDiff(filePath: string): Promise<string> {
    const fullPath = path.join(this.workingDirectory, filePath)

    // Directory
    if (await this.isDirectory(filePath)) {
      return (
        `diff --git a/${filePath} b/${filePath}\n` +
        `new directory\n` +
        `Unable to show diff for directory\n`
      )
    }

    // Binary
    if (await this.isBinaryFile(fullPath)) {
      const relativePath = path.relative(this.workingDirectory, fullPath)
      return (
        `diff --git a/${relativePath} b/${relativePath}\n` +
        `new file mode 100644\n` +
        `index 0000000..0000000\n` +
        `Binary files /dev/null and b/${relativePath} differ\n`
      )
    }

    // Text file
    try {
      const content = await fs.readFile(fullPath, 'utf8')
      const lines = content.split(/\r?\n/)
      const relativePath = path.relative(this.workingDirectory, fullPath)
      return (
        `diff --git a/${relativePath} b/${relativePath}\n` +
        `new file mode 100644\n` +
        `index 0000000..0000000\n` +
        `--- /dev/null\n` +
        `+++ b/${relativePath}\n` +
        `@@ -0,0 +1,${lines.length} @@\n` +
        lines.map(line => `+${line}`).join('\n')
      )
    } catch (error) {
      throw new Error(`Failed to read untracked file: ${error}`)
    }
  }

  /** Build a synthetic diff for a file outside the repository. */
  async buildSyntheticDiffAbsolute(absPath: string): Promise<string> {
    try {
      const stat = await fs.stat(absPath)
      if (stat.isDirectory()) {
        return (
          `diff --git a/${absPath} b/${absPath}\n` +
          `new directory\n` +
          `Unable to show diff for directory\n`
        )
      }
    } catch {
      return ''
    }

    if (await this.isBinaryFile(absPath)) {
      return (
        `diff --git a/${absPath} b/${absPath}\n` +
        `new file mode 100644\n` +
        `index 0000000..0000000\n` +
        `Binary files /dev/null and b/${absPath} differ\n`
      )
    }

    try {
      const content = await fs.readFile(absPath, 'utf8')
      const lines = content.split(/\r?\n/)
      return (
        `diff --git a/${absPath} b/${absPath}\n` +
        `new file mode 100644\n` +
        `index 0000000..0000000\n` +
        `--- /dev/null\n` +
        `+++ b/${absPath}\n` +
        `@@ -0,0 +1,${lines.length} @@\n` +
        lines.map(line => `+${line}`).join('\n')
      )
    } catch {
      return ''
    }
  }

  async getFileContent(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<string> {
    if (version === 'working') {
      // Working-tree reads don't touch the git index — no queue needed
      try {
        const relativePath = filePath.startsWith(this.workingDirectory)
          ? filePath.slice(this.workingDirectory.length + 1)
          : filePath

        if (await this.isDirectory(relativePath)) {
          return ''
        }

        const fullPath = path.join(this.workingDirectory, relativePath)
        return await fs.readFile(fullPath, 'utf8')
      } catch (error) {
        throw new Error(`Failed to read file: ${error}`)
      }
    } else {
      const relativePath = filePath.startsWith(this.workingDirectory)
        ? filePath.slice(this.workingDirectory.length + 1)
        : filePath
      if (version === 'HEAD') return (await this.fileInCommit(`HEAD:${relativePath}`))?.toString('utf8') ?? ''
      const result = await this.runner.executeGitCommand(['show', `:${relativePath}`])
      if (!result.success) {
        return ''
      }
      return result.output || ''
    }
  }

  /**
   * The pieces of a file's change that can be staged one at a time, or unstaged when `staged`: of the working
   * tree against the index, or of the index against the last commit. None for a file that is not plainly modified.
   */
  async getHunks(filePath: string, staged: boolean): Promise<DiffHunk[]> {
    return (await this.cutHunks(filePath, staged)).map(({ apply: _apply, ...hunk }) => hunk)
  }

  /**
   * The file's pieces as git cuts them now, each with the bytes that apply it. The patch is one `git apply` reads
   * with its defaults, whatever the user has told `git diff`: prefixes of `a/` and `b/`, three lines around each
   * change, paths from the top. Left to the user's settings, `diff.noprefix` names another file to `git apply`
   * and `diff.context=0` a piece it puts at the end of the file.
   */
  async cutHunks(filePath: string, staged: boolean): Promise<CutHunk[]> {
    const result = await this.runner.executeGitCommand(
      ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '-U3', ...(staged ? ['--cached'] : []), '--', rowSpec(filePath)],
      { encoding: 'latin1' },
    )
    return result.success ? hunksOf(result.output ?? '', staged) : []
  }

  async fileExistsInHead(filePath: string): Promise<boolean> {
    const result = await this.runner.executeGitCommand(['cat-file', '-e', `HEAD:${filePath}`])
    return result.success
  }

  /**
   * Whether the working directory is in a repository. Rejects when there is no git to ask, and with an
   * `UnsafeOwnershipError` when it is in one git will not read for who owns it.
   */
  async isGitRepository(): Promise<boolean> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--git-dir'])
    if (result.missing) throw new GitUnusableError({ code: 'git-not-found', git: this.runner.git })
    const refused = result.success ? undefined : ownershipRefusal(result.error ?? '')
    if (refused) throw refused
    return result.success
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.model.getStatus()
    return status.length > 0
  }

  async getStagedFiles(): Promise<GitStatusFile[]> {
    const status = await this.model.getStatus()
    return status.filter(file => file.staged)
  }

  async getUpstreamBranch(): Promise<string | null> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])

    if (!result.success) {
      return null
    }

    if (result.output) {
      const upstream = result.output.trim()
      const parts = upstream.split('/')
      if (parts.length >= 2) {
        return parts.slice(1).join('/')
      }
    }
    return null
  }

  async getBaseBranch(options?: { preferUpstream?: boolean }): Promise<string> {
    const preferUpstream = options?.preferUpstream !== false

    const cacheKey = preferUpstream ? 'baseBranch:preferUpstream' : 'baseBranch'
    const cached = this.getCached<string>(cacheKey)
    if (cached) return cached

    if (preferUpstream) {
      try {
        const upstream = await this.getUpstreamBranch()
        if (upstream) {
          this.setCached(cacheKey, upstream)
          return upstream
        }
      } catch (error) {
        this.runner.log.warn?.('Failed to get upstream branch', { error })
      }
    }

    const originHeadResult = await this.runner.executeGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (originHeadResult.success && originHeadResult.output) {
      const branch = originHeadResult.output.trim().replace(/^origin\//, '')
      if (branch) {
        this.setCached(cacheKey, branch)
        return branch
      }
    }

    for (const branch of ['main', 'master', 'develop', 'development']) {
      const result = await this.runner.executeGitCommand(['rev-parse', '--verify', branch])
      if (result.success) {
        this.setCached(cacheKey, branch)
        return branch
      }
    }

    throw new Error('Could not determine base branch')
  }

  /**
   * The branch this one was made from, where something wrote that down: this app when it made the branch, VS Code
   * when it did, or git itself, whose record of a branch's first move says what it was made from when it was
   * given a name. Nothing when none did, or when what they name is gone.
   */
  async rememberedBaseOf(branch: string): Promise<string | undefined> {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const config = await this.runner.executeGitCommand(['config', '--get-regexp', `^branch\\.${escaped}\\.(${BASE_KEY}|vscode-merge-base)$`])
    const told = new Map((config.success ? config.output ?? '' : '').split('\n').filter(Boolean).map((line): [string, string] => {
      const space = line.indexOf(' ')
      return [line.slice(line.lastIndexOf('.', space) + 1, space), line.slice(space + 1).trim()]
    }))
    const reflog = await this.runner.executeGitCommand(['reflog', 'show', '--format=%gs', `refs/heads/${refArgument(branch, 'branch')}`, '--'])
    const created = /^branch: Created from (.+)$/.exec((reflog.success ? reflog.output ?? '' : '').trim().split('\n').at(-1) ?? '')?.[1]

    for (const named of [told.get(BASE_KEY), told.get('vscode-merge-base'), created]) {
      const base = named?.replace(/^refs\/(heads|remotes\/origin)\//, '').replace(/^origin\//, '')
      // `HEAD` and a commit's name say where the branch began and not which branch that was
      if (!base || base === branch || base === 'HEAD' || /^[0-9a-f]{7,64}$/.test(base)) continue
      // A branch here by exactly that name, which is what the name is then given to git as. Not one only the
      // remote has, which git does not know by its bare name, and not a commit reached from a branch (`main~2`),
      // which names where the branch began and no branch
      if ((await this.runner.executeGitCommand(['show-ref', '--verify', '--quiet', `refs/heads/${base}`])).success) return base
    }
    return undefined
  }

  async getCommitDistance(branch: string): Promise<number> {
    const result = await this.runner.executeGitCommand(['rev-list', '--count', `${branch}..HEAD`])
    if (!result.success || !result.output) return Infinity
    return parseInt(result.output.trim(), 10)
  }

  async getNearbyMergedBranches(depth: number): Promise<string[]> {
    const result = await this.runner.executeGitCommand([
      'branch', '--merged', 'HEAD', '--contains', `HEAD~${depth}`, '--format=%(refname:short)',
    ])
    if (!result.success || !result.output) {
      // Falls back to all merged branches if HEAD~N is invalid (e.g., repo has < N commits)
      const fallback = await this.runner.executeGitCommand([
        'branch', '--merged', 'HEAD', '--format=%(refname:short)',
      ])
      if (!fallback.success || !fallback.output) return []
      return fallback.output.trim().split('\n').filter(Boolean)
    }
    return result.output.trim().split('\n').filter(Boolean)
  }

  async getBranchDiff(baseBranch: string, targetBranch?: string): Promise<GitStatusFile[]> {
    const target = targetBranch || 'HEAD'
    
    // Get the list of changed files between branches with NUL termination and rename detection
    const result = await this.runner.executeGitCommand(['diff', '--name-status', '-z', '-M', '-C', `${refArgument(baseBranch, 'base branch')}...${refArgument(target, 'branch')}`])
    if (!result.success) {
      throw failure(result, 'Failed to get branch diff')
    }
    
    const files: GitStatusFile[] = []
    const parts = (result.output || '').split('\0').filter(Boolean)
    
    for (let i = 0; i < parts.length; ) {
      const statusPart = parts[i++]
      if (!statusPart || i >= parts.length) break
      
      // Status is just a letter (M, A, D, R, C, T, U)
      const status = statusOf(statusPart.charAt(0))
      const path = parts[i++]
      
      if (!path) continue
      
      // For renames and copies, there's a second path
      if ((statusPart.startsWith('R') || statusPart.startsWith('C')) && i < parts.length && parts[i]) {
        const originalPath = path
        const newPath = parts[i++]!
        files.push({
          path: newPath,
          status,
          staged: false,
          originalPath
        })
      } else {
        files.push({
          path,
          status,
          staged: false
        })
      }
    }
    
    return files
  }

  /** Whether each of these names a commit in this repository */
  async commitsExist(...refs: string[]): Promise<boolean> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--quiet', ...refs.map(ref => `${refArgument(ref)}^{commit}`)])
    return result.success
  }

  async getFileContentFromBranch(filePath: string, branch: string): Promise<string> {
    // A file the branch does not have is not an error
    return (await this.getFileBytesFromBranch(filePath, branch))?.toString('utf8') ?? ''
  }

  /**
   * Every local branch, then every remote one, each most recently committed first. A branch of `origin` is
   * named as the local branch it would be checked out as; one of another remote keeps `remotes/<remote>/`.
   */
  async getAllBranches(): Promise<string[]> {
    // Read from the refs themselves, one per record: `git branch` decorates its lines for a person, marking the
    // current branch, one checked out in another worktree and a detached HEAD
    const result = await this.runner.executeGitCommand([
      'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes',
    ])
    if (!result.success) {
      throw failure(result, 'Failed to get branches')
    }

    const refs = (result.output || '').split('\n').filter(Boolean)
    const local = refs.filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice('refs/heads/'.length))
    const remote = refs
      .filter(ref => ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD'))
      .map(ref => ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : ref.slice('refs/'.length))

    // Case-insensitive dedup — prefer remote names (correct case from server) over local names: a remote
    // duplicate overwrites a wrong-case local entry, in the local entry's place
    const seen = new Map<string, string>()
    for (const branch of [...local, ...remote]) {
      seen.set(branch.toLowerCase(), branch)
    }
    return [...seen.values()]
  }

  async isCurrentBranchPublished(): Promise<boolean> {
    try {
      const upstream = await this.getUpstreamBranch()
      return upstream !== null
    } catch {
      // If there's an error checking upstream, assume unpublished
      return false
    }
  }

  async stashList(): Promise<StashEntry[]> {
    const result = await this.runner.executeGitCommand(['stash', 'list', '-z', '--format=%gd%x00%s%x00%ai'])
    if (!result.success) {
      // Empty stash list is not an error
      if (result.code === 'unknown-ref') return []
      throw failure(result, 'Failed to list stashes')
    }
    if (!result.output?.trim()) return []

    return recordsOf(result.output, 3).map((parts, i) => ({
      index: i,
      ref: parts[0] || `stash@{${i}}`,
      message: parts[1] || '',
      date: parts[2] || ''
    }))
  }

  // ── Worktree operations ──────────────────────────────────────────

  async worktreeList(): Promise<WorktreeEntry[]> {
    const result = await this.runner.executeGitCommand(['worktree', 'list', '--porcelain'])
    if (!result.success || !result.output?.trim()) return []

    const entries: WorktreeEntry[] = []
    const blocks = result.output.trim().split('\n\n')

    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i]!.trim().split('\n')
      let wtPath = ''
      let head = ''
      let branch = ''
      let isBare = false
      let isLocked = false
      let lockedReason: string | undefined

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length)
        } else if (line.startsWith('HEAD ')) {
          head = line.slice('HEAD '.length).substring(0, 7)
        } else if (line.startsWith('branch ')) {
          // branch refs/heads/main → main
          branch = line.slice('branch '.length).replace('refs/heads/', '')
        } else if (line === 'bare') {
          isBare = true
        } else if (line === 'detached') {
          branch = ''
        } else if (line.startsWith('locked')) {
          isLocked = true
          const reason = line.slice('locked'.length).trim()
          if (reason) lockedReason = reason
        }
      }

      if (wtPath) {
        entries.push({
          path: wtPath,
          head,
          branch,
          isBare,
          isCurrent: path.resolve(wtPath) === path.resolve(this.workingDirectory),
          isMain: i === 0,
          isLocked,
          lockedReason
        })
      }
    }

    return entries
  }

  async getCommitsBetweenBranches(baseBranch: string, targetBranch = 'HEAD'): Promise<{ subject: string; body: string }[]> {
    const result = await this.runner.executeGitCommand([
      'log', '-z', `${refArgument(baseBranch, 'base branch')}..${refArgument(targetBranch, 'branch')}`,
      '--format=%s%x00%b',
      '--reverse'
    ])
    if (!result.success || !result.output) return []

    return recordsOf(result.output, 2)
      .map(([subject, body]) => ({ subject: (subject || '').trim(), body: (body || '').trim() }))
      .filter(c => c.subject)
  }

  // --- Commit log operations ---

  async gitLog(count = 50): Promise<CommitLogEntry[]> {
    const result = await this.runner.executeGitCommand([
      'log', '-z', `-n${count}`,
      '--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%D',
    ])
    if (!result.success || !result.output) return []

    return recordsOf(result.output, 8)
      .map(parts => ({
        hash: (parts[0] || '').trim(),
        shortHash: (parts[1] || '').trim(),
        subject: (parts[2] || '').trim(),
        body: (parts[3] || '').trim(),
        authorName: (parts[4] || '').trim(),
        authorEmail: (parts[5] || '').trim(),
        date: (parts[6] || '').trim(),
        refs: (parts[7] || '').trim(),
      }))
      .filter(c => c.hash)
  }

  /**
   * A file's bytes: as the working tree has it, as the last commit has it, or as it is staged. Nothing when
   * there is no such file, or it could not be read.
   */
  async getFileBytes(filePath: string, version: 'HEAD' | 'working' | 'index' = 'working'): Promise<Buffer | undefined> {
    const relativePath = filePath.startsWith(this.workingDirectory)
      ? filePath.slice(this.workingDirectory.length + 1)
      : filePath
    try {
      if (version === 'working') return await fs.readFile(path.join(this.workingDirectory, relativePath))
      return version === 'HEAD' ? await this.fileInCommit(`HEAD:${relativePath}`) : await this.runner.executeGitCommandBinary(['show', `:${relativePath}`])
    } catch {
      return undefined
    }
  }

  /** A file's bytes as a branch has it, or nothing when the branch has no such file */
  async getFileBytesFromBranch(filePath: string, branch: string): Promise<Buffer | undefined> {
    // A path with a colon in it, or one that starts like an option, is named from the top of the tree
    const special = filePath.includes(':') || filePath.startsWith('-')
    return this.fileInCommit(`${refArgument(branch, 'branch')}:${special ? './' : ''}${filePath}`)
  }

  /**
   * The address of the remote this branch follows, as git would use it (its `insteadOf` rewrites applied).
   * Nothing where there is no remote.
   */
  async getRemoteUrl(): Promise<string | undefined> {
    const result = await this.runner.executeGitCommand(['ls-remote', '--get-url'])
    return (result.success && result.output?.trim()) || undefined
  }
}
