// What a host hands the engine when it opens a repository: how a process is run, what environment git starts
// from, and where to say things. The engine names no host, so each of these is a function it is given, with a
// plain default that needs nothing.
import { execFile, type ChildProcess } from 'node:child_process'

/** What a git is run with */
export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  maxBuffer: number
  encoding: BufferEncoding
}

/**
 * Runs a process: `execFile`'s promise, with the child beside it. A host that ends a process which has stopped
 * working hands in the function that does; without one the process runs for as long as it runs.
 */
export type RunProcess = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }> & { child: ChildProcess }

/**
 * Watches a process that is kept open while it owes an answer, and calls `onStalled` once it has done no work and
 * written nothing for too long. `output()` says it wrote something, and `stop()` ends the watch.
 */
export type WatchProcess = (pid: number, onStalled: () => void, idleMs?: number) => { output(): void; stop(): void }

/**
 * A clock the engine takes its wall time, monotonic elapsed time, and timers from. Matches `@apackdev/clock`'s
 * `controller.clock` and `@apackdev/orderings`'s `schedule.clock` structurally with no runtime dependency on
 * either package.
 */
export interface RepositoryClock {
  /** Wall time in milliseconds since 1970 (for persisted timestamps and filesystem mtime comparisons) */
  now(): number
  /** Monotonic time in milliseconds for elapsed durations, on the same timeline as `after` */
  monotonic(): number
  /** Runs `run` once after `ms` milliseconds on the monotonic timeline. Returns what cancels it before it runs */
  after(ms: number, run: () => void): () => void
}

/** Built-in clock over `Date.now`, `performance.now` and `.unref()`'d `setTimeout`, used when no clock is handed in */
export const systemClock: RepositoryClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, Math.max(0, ms))
    timer.unref()
    return () => { clearTimeout(timer) }
  },
}

/** Schedules `run` on `clock`, returning `undefined` instead of throwing when a host clock has already closed */
export function scheduleAfter(clock: RepositoryClock, ms: number, run: () => void): (() => void) | undefined {
  try {
    return clock.after(Math.max(0, ms), run)
  } catch (error) {
    if (error instanceof Error && error.name === 'ClockClosedError') return undefined
    throw error
  }
}

export interface RepositoryLog {
  warn?(message: string, data?: Record<string, unknown>): void
  error?(message: string, data?: Record<string, unknown>): void
  /** Every git command run, with how long it took and whether it worked: a line each */
  command?(line: string): void
}

export interface RepositoryTies {
  /**
   * The git to run: a path, or a name the PATH is searched for. `git` when not given. Where a host looks for one
   * is the host's to decide; whether it can be used is the engine's, asked before the first command
   */
  git?: string
  /** The environment git's children start from, over which the engine lays its own. The process's own when not given */
  environment?: () => NodeJS.ProcessEnv
  run?: RunProcess
  /** Without one, a git kept open is not watched */
  watchProcess?: WatchProcess
  log?: RepositoryLog
  /** How long a command waits for another git to let go of a lock it needs */
  lockPatienceMs?: number
  /** How long a whole status may take before the snapshot says it is slow (1,000 ms when not given) */
  statusBudgetMs?: number
  /**
   * Whether the repository whose git state lives at this real path is one the host trusts to have git run what
   * its own configuration and hooks name. Without one, no repository is, and one that names anything is refused
   */
  isTrusted?: (repository: string) => boolean
  /**
   * Where the store that keeps copies of this repository's working tree is (`GitRepository.checkpoint`), for the
   * repository whose common git directory is at this real path. Under the system's temporary directory when not
   * given, which the system may empty
   */
  checkpointDirectory?: (commonDir: string) => string
  /**
   * Clock for timers, monotonic elapsed windows (lock patience, cache TTL, linger, slow-status budget), and wall
   * timestamps (checkpoint/journal expiry). Matches `@apackdev/clock`'s `controller.clock` structurally
   */
  clock?: RepositoryClock
}

/** `execFile` as a promise with its child beside it, unbounded: what runs git when a host hands nothing in */
export const runUnbounded: RunProcess = (file, args, options) => {
  let child!: ChildProcess
  const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
  return Object.assign(promise, { child })
}
