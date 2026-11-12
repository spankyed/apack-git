// Runs git. Every git process the engine starts is started here: with the engine's environment over the host's,
// in the lane its command waits in, again when another git's lock refused it, and answered as a result that says
// why it failed.
import * as path from 'path'
import * as fs from 'fs/promises'
import { watch } from 'fs'
import { execFile, type ChildProcess } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CONTENT_MISSING, GitError, LOCKED, classifyGitError, type GitErrorCode } from './errors.ts'
import { GitUnusableError, checkGit, type GitUnusable } from './git-check.ts'
import { progressReader, withoutProgress } from './progress.ts'
import { runUnbounded, type RepositoryLog, type RepositoryTies, type RunProcess } from './ties.ts'
import { TrustGate } from './trust.ts'
import type { GitProgress } from './types.ts'

/**
 * What every git child runs with. No credential prompt, since nobody is at a terminal to answer one; no editor
 * for the same reason, so where git would open one for a message it takes the message it proposes; and no
 * optional locks, so a read made in the background (a status after a file changed) never holds `index.lock`
 * against a git the user or an agent runs in the same repository.
 */
export const gitEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...base,
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_OPTIONAL_LOCKS: '0',
  // Git translates its messages, and what a failure means is read from them here: in English, whatever the
  // user's locale is
  LANGUAGE: 'en',
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8',
})

/** What a caller is told when there is no git to run */
export const GIT_NOT_INSTALLED = 'Git is not installed. Please install Git to use version control features.'

/**
 * How long a command waits for another git to let go of a lock before it is given up on.
 *
 * It is a clock because the other git is a process this one cannot read: there is no work of its to watch,
 * only the lock, which is there until it is not. A git in a terminal or an agent's holds one for moments. One
 * held for longer than this is a commit in a very large repository, or what a git that stopped part-way left
 * behind, and either is said to whoever asked.
 */
const LOCK_PATIENCE_MS = 10_000

/**
 * Whether another git let go of this lock: `true` once the lock is gone, `false` when it is still there after
 * `patienceMs`, counted from when it was taken. A lock already older than that is not about to be let go of,
 * and is answered at once.
 *
 * **The lock file itself is watched, and looked for again once the event loop has been round.** A watch is not
 * in place when `watch` returns. A file's is put in place the next time the loop waits; a directory's, on macOS,
 * by a stream that starts on another thread some time later. A lock let go of before its watch is in place is
 * reported by nobody, and most are let go of within moments, so a command waited out its whole patience for a
 * lock that was gone. Looking again after the loop has waited once finds that one, and the watch reports any
 * later.
 */
function lockReleased(lock: string, patienceMs: number): Promise<boolean> {
  const takenAt = () => fs.stat(lock).then(stat => stat.mtimeMs, () => undefined)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let watcher: ReturnType<typeof watch> | undefined
    const settle = (released: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      resolve(released)
    }
    /** Gone, the lock was let go of. Still there after it was renamed or deleted, another git took it at once */
    const look = (retaken: 'follow' | 'leave') => {
      void takenAt().then((taken) => {
        if (taken === undefined) settle(true)
        else if (retaken === 'follow' && !settled) follow()
      })
    }
    const follow = () => {
      watcher?.close()
      try {
        // Written to, it is still held: only its being renamed or deleted says anything
        watcher = watch(lock, { persistent: false }, (change) => { if (change === 'rename') look('follow') })
        watcher.on('error', () => settle(false))
      } catch {
        // Nothing there to watch: it was let go of already
        return settle(true)
      }
      // Two turns, since the first of these runs before the loop next waits and the second after
      setImmediate(() => setImmediate(() => look('leave')))
    }
    follow()
    void takenAt().then((taken) => {
      if (taken === undefined) return settle(true)
      // No longer than the patience itself, whatever a clock that disagrees with this one stamped the lock with
      const left = Math.min(patienceMs, patienceMs - (Date.now() - taken))
      if (left <= 0) return settle(false)
      timer = setTimeout(() => settle(false), left)
    })
  })
}

/** What is said of a lock another git did not let go of, in place of git's own half page */
const heldLockMessage = (lock: string) =>
  // Git names the lock with `/` between its parts on every platform: said as the platform spells a path
  `Another git process is using this repository and has not let go of it: ${path.normalize(lock)} is still there. `
  + 'Try again once it has finished. If no git is running, one that stopped part-way left that file behind, and deleting it lets git carry on.'

/**
 * How long git's output may stay silent after git itself has exited before its pipes are given up on. A hook
 * that leaves a process running in the background leaves it holding those pipes, and they would otherwise stay
 * open, and the command unanswered, for as long as that process lives.
 */
const EXIT_GRACE_MS = 250

/**
 * How long a git that was asked to stop is given to end before it is killed. Asked with a signal it can catch, git
 * removes the locks it took; killed, it leaves them. A wait on a process told to go, with nothing left to do.
 */
const STOP_GRACE_MS = 2_000

/** What a command answers when whoever asked for it said to stop */
const STOPPED: GitCommandResult = { success: false, error: 'Stopped', code: 'aborted' }

/**
 * Ends a git that was asked to stop, and the helpers it started (`ssh`, the HTTPS helper), which outlive it
 * otherwise: git does not end them when it is signalled. They are found by their parents, starting from the git
 * started here, and each is asked first, so git can let go of its locks, then ended outright after a grace.
 * Windows has no such request: the process and every one under it are ended outright, by the id of the one
 * started here.
 */
function endTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    return
  }
  execFile('ps', ['-A', '-o', 'pid=,ppid='], (error, listed) => {
    const tree = [pid, ...(error ? [] : descendantsOf(pid, String(listed)))]
    const signal = (name: NodeJS.Signals) => { for (const each of tree) { try { process.kill(each, name) } catch { /* gone */ } } }
    signal('SIGTERM')
    const outright = setTimeout(() => { signal('SIGKILL') }, STOP_GRACE_MS)
    outright.unref()
  })
}

/** Every process under `root`, from a listing of each process's id and its parent's */
function descendantsOf(root: number, listed: string): number[] {
  const children = new Map<number, number[]>()
  for (const line of listed.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    if (!pid || parent === undefined) continue
    children.set(parent, [...(children.get(parent) ?? []), pid])
  }
  const found: number[] = []
  const visit = (pid: number) => { for (const each of children.get(pid) ?? []) { found.push(each); visit(each) } }
  visit(root)
  return found
}

/**
 * The first release on each line of git that can be told not to fetch what a partial clone lacks
 * (`GIT_NO_LAZY_FETCH`), by minor version. The switch came with the security releases of May 2024, onto every line
 * then maintained, and is in every release from 2.46.0; 2.45.0 and each line's earlier releases do not have it.
 * Read from `promisor-remote.c` at each release's tag.
 */
const NO_LAZY_FETCH_FROM: Readonly<Record<number, number>> = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 }

/**
 * Whether a git of this version can be told not to fetch. A read on one that cannot, in a partial clone, may reach
 * the network, so there it waits in line with the commands that do.
 */
export function refusesLazyFetch(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  if (major !== 2) return major > 2
  if (minor >= 46) return true
  const first = NO_LAZY_FETCH_FROM[minor]
  return first !== undefined && patch >= first
}

/** Set while reads may fetch what a partial clone lacks: inside `GitRepository.fetchingMissing` */
const fetching = new AsyncLocalStorage<true>()

/** Runs `read` with its reads allowed to fetch what a partial clone lacks, in line with the remote commands */
export const fetchingMissing = <T>(read: () => Promise<T>): Promise<T> => fetching.run(true, read)

/** Whether reads made from here may fetch what a partial clone lacks */
export const mayFetch = (): boolean => fetching.getStore() === true

/** What a read is told so it never fetches: what it lacks is answered as `content-missing` */
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' }

/** Subcommands that only read, which wait for nothing: no lock is taken, as `GIT_OPTIONAL_LOCKS` says */
const READS = new Set(['status', 'rev-parse', 'for-each-ref', 'ls-files', 'check-attr', 'diff', 'show', 'cat-file', 'rev-list', 'symbolic-ref', 'log', 'branch', 'reflog', 'show-ref'])
/** Subcommands that talk to a remote and touch no index, which wait only for each other */
const NETWORK = new Set(['fetch', 'push'])

/** Which commands a command waits behind: none for a read, the other remote commands, or the other writes */
function laneOf(args: string[]): 'read' | 'network' | 'write' {
  const [command, verb] = args
  if (READS.has(command!) || (command === 'config' && (verb === '--get' || verb === '--get-regexp'))) return 'read'
  if ((command === 'stash' || command === 'worktree') && verb === 'list') return 'read'
  // The address a remote is configured with, which is read from the config and asks the remote nothing
  if (command === 'ls-remote' && verb === '--get-url') return 'read'
  return NETWORK.has(command!) ? 'network' : 'write'
}

export interface GitCommandResult {
  success: boolean
  output?: string
  error?: string
  /** Git printed more than is read, so `output` is its beginning */
  truncated?: boolean
  /** There is no git to run */
  missing?: boolean
  /** Why it failed, where what git printed says */
  code?: GitErrorCode
}

/** A failed command as an error, carrying why it failed for whoever shows it */
export const failure = (result: GitCommandResult, otherwise: string): GitError => new GitError(result.error || otherwise, result.code)

interface GitCommandError extends Error {
  code?: number | string
  stdout?: string
  stderr?: string
}

export class GitRunner {
  /** The commands that wait for each other: writes to the index in one line, remote commands in another */
  private lanes = { write: Promise.resolve(), network: Promise.resolve() }

  /** How many commands are in the line of writes, running or waiting */
  writesInLine = 0

  /**
   * What is still to end: every command asked for, from when it was asked, and every git started, until it has
   * gone. Both, because a command is not a git yet while it waits its turn or for the repository to be read as
   * trusted, and a git read for that trust is no command.
   */
  private readonly unended = new Set<Promise<unknown>>()
  private untilEnded<T>(ending: Promise<T>): Promise<T> {
    const settled = ending.then(() => {}, () => {})
    this.unended.add(settled)
    void settled.then(() => this.unended.delete(settled))
    return ending
  }

  /** How long a command waits for another git to let go of a lock it needs */
  private readonly lockPatienceMs: number
  private readonly run: RunProcess
  /** The git every command runs */
  readonly git: string
  /** Whether that git can be used, and which it is, asked once, before the first command */
  private usable: Promise<GitUnusable | { version: string }> | undefined
  /** Whether this repository is a partial clone, which may lack content a read needs; asked once */
  private partial: Promise<boolean> | undefined
  private readonly base: () => NodeJS.ProcessEnv
  readonly log: RepositoryLog
  /** What keeps git from running what an untrusted repository names: every command passes it but its own reads */
  readonly trust: TrustGate

  constructor(readonly workingDirectory: string, ties: RepositoryTies = {}) {
    this.lockPatienceMs = ties.lockPatienceMs ?? LOCK_PATIENCE_MS
    this.run = ties.run ?? runUnbounded
    this.git = ties.git ?? 'git'
    this.base = ties.environment ?? (() => process.env)
    this.log = ties.log ?? {}
    // Its reads run beside every other, in no lane, and are not themselves gated
    this.trust = new TrustGate(workingDirectory, args => this.runGitOnce(args), ties.isTrusted)
  }

  /** What every git child of this repository runs with: the engine's own over what the host handed in */
  readonly environment = (): NodeJS.ProcessEnv => gitEnvironment(this.base())

  /**
   * Runs a command in its lane. A read runs at once: it takes no lock, so it has nothing to wait for, and a
   * status asked during a slow commit or a fetch is answered while that runs. Writes run one at a time, since
   * each takes the index lock, and remote commands one at a time beside them.
   */
  enqueueCommand<T>(lane: 'read' | 'network' | 'write', fn: () => Promise<T>): Promise<T> {
    if (lane === 'read') return this.untilEnded(fn())
    if (lane === 'write') this.writesInLine++
    const op = this.untilEnded(this.lanes[lane].then(fn, fn))
    this.lanes[lane] = op.then(() => {}, () => {})
    return lane === 'write' ? op.finally(() => { this.writesInLine-- }) : op
  }

  /** Refuses a command when the git it would run cannot be used, asking only the first time; answers its version */
  async passUsableGit(): Promise<string> {
    this.usable ??= checkGit(this.git, this.run, this.environment())
    const usable = await this.usable
    if ('code' in usable) throw new GitUnusableError(usable)
    return usable.version
  }

  /**
   * Whether this repository is a partial clone, one whose remote was asked for less than everything and promised
   * the rest: read once, from its config, which a read can do without fetching anything
   */
  isPartialClone(): Promise<boolean> {
    this.partial ??= this.runGitOnce(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']).then(
      result => result.success && /^(extensions\.partialclone \S|remote\..+\.promisor true$)/mi.test(result.output ?? ''),
    )
    return this.partial
  }

  /**
   * Which line a read waits in: none, unless it may reach the network. It may when whoever asked said it may
   * fetch, and on a git too old to be told not to, in a partial clone.
   */
  private async readLane(fetches: boolean): Promise<'read' | 'network'> {
    if (fetches) return 'network'
    if (refusesLazyFetch(await this.passUsableGit())) return 'read'
    return await this.isPartialClone() ? 'network' : 'read'
  }

  /**
   * Runs `run` in the line `args` waits in. A read's line is known only once git's version is, so it is chosen
   * when that is; every other line is joined at once, so a write is in line from when it was asked.
   */
  private inLane<T>(args: string[], refreshesIndex: boolean, fetches: boolean, run: () => Promise<T>): Promise<T> {
    // A read allowed to write the index waits its turn among the writes made here, which need the same lock
    const lane = refreshesIndex ? 'write' : laneOf(args)
    if (lane !== 'read') return this.enqueueCommand(lane, run)
    return this.untilEnded(this.readLane(fetches).then(chosen => this.enqueueCommand(chosen, run)))
  }

  /**
   * Settles once nothing asked of this repository is left to run and no git of its is left running: its
   * directory has no process of its in it. A command asked for meanwhile is waited for too.
   */
  async idle(): Promise<void> {
    while (this.unended.size > 0) await Promise.all(this.unended)
  }

  /**
   * Runs git, answering once it has exited and its output has gone quiet, without waiting for its pipes to
   * close: a process a hook left behind holds them open for as long as it lives.
   */
  runGit(args: string[], encoding: BufferEncoding, refreshesIndex = false, input?: string | Buffer, onProgress?: (progress: GitProgress) => void, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    const running = this.run(this.git, ['-c', 'color.ui=never', ...args], {
      cwd: this.workingDirectory,
      // The one read that may write: it lets git take its optional lock and keep what it learns of the files
      env: { ...this.environment(), ...(refreshesIndex && { GIT_OPTIONAL_LOCKS: '1' }), ...env },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer limit
      encoding,
    })
    const { child } = running
    if (signal) {
      const stop = () => { endTree(child) }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
      void running.then(() => signal.removeEventListener('abort', stop), () => signal.removeEventListener('abort', stop))
    }
    // Gone once its output has closed and not when it exits: on Windows `git` starts the git doing the work,
    // which holds the output until it has ended too, and one ended by the host outlives the first by a moment.
    // A process a hook left holding the output is given up on below, which closes it
    void this.untilEnded(new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    }))
    if (input !== undefined) {
      // A git that ends before it has read all it was handed is reported by its exit, not by the pipe
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
    if (onProgress) child.stderr?.on('data', progressReader(onProgress))
    let grace: NodeJS.Timeout | undefined
    const giveUpOnPipes = () => { child.stdout?.destroy(); child.stderr?.destroy() }
    const quiet = () => { clearTimeout(grace); grace = setTimeout(giveUpOnPipes, EXIT_GRACE_MS) }
    child.once('exit', () => {
      child.stdout?.on('data', quiet)
      child.stderr?.on('data', quiet)
      quiet()
    })
    return running.finally(() => clearTimeout(grace))
  }

  /**
   * Runs a git command in its lane. One that another git's lock refuses is run again once that lock is let go
   * of: a git in a terminal, or an agent's, holds the index for moments, and the user who staged a file in
   * those moments meant it. The lane waits with it, since what is queued behind needs the same lock.
   */
  executeGitCommand(args: string[], { refreshesIndex = false, input, onProgress, encoding = 'utf8', env: given, signal }: { signal?: AbortSignal; refreshesIndex?: boolean; input?: string | Buffer; onProgress?: (progress: GitProgress) => void; encoding?: BufferEncoding; /** Laid over the environment every git runs with, for this one */ env?: NodeJS.ProcessEnv } = {}): Promise<GitCommandResult> {
    const fetches = mayFetch()
    // A read fetches nothing unless it was said it may: a write (a checkout, a merge) fetches what it needs
    const env = laneOf(args) === 'read' && !fetches ? { ...NO_LAZY_FETCH, ...given } : given
    return this.inLane(args, refreshesIndex, fetches, async () => {
      await this.passUsableGit()
      await this.trust.pass()
      // Stopped while it waited its turn: it is not started
      if (signal?.aborted) return STOPPED
      let refusedAt: number | undefined
      for (;;) {
        const result = await this.runGitOnce(args, refreshesIndex, input, onProgress, encoding, env, signal)
        const lock = result.code === 'locked' ? LOCKED.exec(result.error ?? '')?.[1] : undefined
        if (!lock) return result
        // A stash is several steps to git, and one refused part-way has done the steps before it: run again, it
        // would stash, or apply, a second time. It is said to be refused, and whoever asked decides
        if (args[0] === 'stash') return { ...result, error: heldLockMessage(lock) }
        refusedAt ??= Date.now()
        // Counted here as well as against the lock: a lock git names and nothing can see is "let go of" every
        // time it is looked for, and the command would be run again for ever
        const left = this.lockPatienceMs - (Date.now() - refusedAt)
        if (left <= 0 || !await lockReleased(lock, left)) return { ...result, error: heldLockMessage(lock) }
      }
    })
  }

  async runGitOnce(args: string[], refreshesIndex = false, input?: string | Buffer, onProgress?: (progress: GitProgress) => void, encoding: BufferEncoding = 'utf8', env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitCommandResult> {
    const started = performance.now()
    const result = await this.runGitAnswered(args, refreshesIndex, input, onProgress, encoding, env, signal)
    // A reading for whoever is looking into what the panel is doing: nothing is decided with it
    this.log.command?.(`git ${args.join(' ').slice(0, 300)}: ${result.success ? 'ok' : `failed${result.code ? ` (${result.code})` : ''}`} in ${Math.round(performance.now() - started)} ms`)
    return result
  }

  async runGitAnswered(args: string[], refreshesIndex: boolean, input: string | Buffer | undefined, onProgress: ((progress: GitProgress) => void) | undefined, encoding: BufferEncoding, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<GitCommandResult> {
    try {
      // Ended when it stops working, not when a clock runs out: a fetch stalled on the network would
      // otherwise hold its lane, and every later remote command with it, until the app restarts
      const { stdout, stderr } = await this.runGit(args, encoding, refreshesIndex, input, onProgress, env, signal)
      // A read that went without content it lacked may still exit cleanly, having answered with less
      if (CONTENT_MISSING.test(stderr)) return { success: false, error: stderr.trim(), output: stdout, code: 'content-missing' }
      return { success: true, output: stdout }
    } catch (error) {
      const gitError = error as GitCommandError

      // Ended because whoever asked for it said to stop: that is no failure of git's to report
      if (signal?.aborted) return STOPPED
      // Ahead of the exits read as answers below: `show` says only "bad object" of content it does not have
      if (CONTENT_MISSING.test(gitError.stderr ?? '')) return { success: false, error: gitError.stderr!.trim(), output: gitError.stdout, code: 'content-missing' }
      if (gitError.code === 'ENOENT') {
        return { success: false, error: GIT_NOT_INSTALLED, missing: true }
      }
      if (gitError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { success: false, error: gitError.message, output: gitError.stdout, truncated: true }
      }

      // Special cases where non-zero exit codes are expected
      if (gitError.code === 1 && args[0] === 'diff') {
        return { success: true, output: gitError.stdout || '' }
      }
      if (gitError.code === 128 && args[0] === 'show') {
        return { success: true, output: '' }
      }

      // Asked for progress, git wrote it to the same stream as why it failed
      const said = onProgress && gitError.stderr ? withoutProgress(gitError.stderr) : gitError.stderr
      return {
        success: false,
        error: said || gitError.message,
        output: gitError.stdout,
        // Read from both streams: a merge that stops on a conflict says so on its output and nothing on its error
        code: classifyGitError(`${gitError.stderr ?? ''}\n${gitError.stdout ?? ''}`),
      }
    }
  }

  /** Execute a git command and return raw binary buffer output. */
  executeGitCommandBinary(args: string[]): Promise<Buffer> {
    const fetches = mayFetch()
    return this.inLane(args, false, fetches, async () => {
      await this.passUsableGit()
      await this.trust.pass()
      // Read as latin1, which maps each byte to one character and back, so the bytes survive a text channel
      const { stdout, stderr } = await this.runGit(args, 'latin1', false, undefined, undefined, fetches ? undefined : NO_LAZY_FETCH).catch((error: GitCommandError) => {
        throw CONTENT_MISSING.test(error.stderr ?? '') ? new GitError(String(error.stderr).trim(), 'content-missing') : error
      })
      if (CONTENT_MISSING.test(stderr)) throw new GitError(stderr.trim(), 'content-missing')
      return Buffer.from(stdout, 'latin1')
    })
  }
}
