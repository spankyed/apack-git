// Reads files as commits have them through one git process that stays open (`git cat-file --batch`), where each
// read would otherwise start a process of its own. A view of a pull request reads two versions of every file it
// lists, at once: a hundred processes for fifty files, against a hundred lines written to one.
//
// **For commits only, never the index.** A name like `main:src/a.ts` is resolved when it is asked for, so a branch
// that moved is read where it is now. `:src/a.ts`, the staged version, is read from the index, which this process
// loads once and keeps: it would go on answering with what was staged when it started.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { WatchProcess } from './ties.ts'

/** The largest file handed back; a larger one is read past and answered as not there, as a read by `git show` is */
const LARGEST_READ = 10 * 1024 * 1024

/**
 * How long the process is kept once nothing is being read. It is a wait on this process's own state, with nothing
 * to watch but the absence of a request: long enough to span the reads one view makes, and short enough that a
 * repository nobody is looking at holds no process open.
 */
const LINGER_MS = 5_000

/**
 * How long a git whose input was closed is given to end by itself before its process tree is ended. A wait on a
 * process that was told to go and has nothing left to do: there is no work of its to watch.
 */
const STILL_RUNNING_MS = 1_000

interface Pending {
  resolve(content: Buffer | undefined): void
  reject(error: Error): void
}

export class GitObjectReader {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending: Pending[] = []
  private received: Buffer = Buffer.alloc(0)
  /** The object being read: how many of its bytes are still to come, and whether they are kept */
  private body: { left: number; chunks: Buffer[] | undefined } | undefined
  private linger: NodeJS.Timeout | undefined
  /**
   * The watch on the git process while it owes an answer. Reads are answered in the order they were asked, so
   * one git cannot finish holds every read behind it: a git that does no work and writes nothing for `idleMs`
   * is ended, as a git run for one read is, and what it owed is failed for the caller to read another way.
   * A git that is working (fetching a version a partial clone never had) is left to.
   */
  private stall: ReturnType<WatchProcess> | undefined

  constructor(
    private readonly workingDirectory: string,
    private readonly environment: () => NodeJS.ProcessEnv,
    /** What watches the process while it owes an answer; without one it is not watched */
    private readonly watchProcess?: WatchProcess,
    private readonly lingerMs = LINGER_MS,
    /** How long the process may owe an answer without working, the progress watch's own when not given */
    private readonly idleMs?: number,
  ) {}

  /** Whether the git process is open */
  get isOpen(): boolean {
    return this.child !== undefined
  }

  /**
   * The file a name like `HEAD:src/a.ts` stands for, or nothing when git knows no such file. Rejects when git
   * could not be asked, or for a name with a line break in it, which one line cannot carry: the caller reads
   * that one another way.
   */
  read(name: string): Promise<Buffer | undefined> {
    if (name.includes('\n')) return Promise.reject(new Error('A name with a line break cannot be asked for on one line'))
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.child ?? this.open()
      } catch (error) {
        return reject(error instanceof Error ? error : new Error(String(error)))
      }
      clearTimeout(this.linger)
      this.pending.push({ resolve, reject })
      if (!this.stall && child.pid !== undefined) {
        this.stall = this.watchProcess?.(child.pid, () => this.end(child, new Error('git cat-file stopped answering while a file was being read')), this.idleMs)
      }
      child.stdin.write(`${name}\n`)
    })
  }

  /** Ends the git process, failing whatever was still being read */
  close(): void {
    if (this.child) this.end(this.child, new Error('The git object reader was closed'))
  }

  /** Ends this git process, which is the one started here, failing whatever it still owed */
  private end(child: ChildProcessWithoutNullStreams, why: Error): void {
    if (this.child !== child) return
    clearTimeout(this.linger)
    this.child = undefined
    this.fail(why)
    // Its input closing is what ends it: it has nothing more to read
    child.stdin.end()
    if (process.platform !== 'win32') {
      child.kill()
      return
    }
    // On Windows `git` is a launcher that starts the git doing the work, and ending the launcher leaves that one
    // running in the repository's directory, which then cannot be deleted. It is left to end by itself, and the
    // whole tree under it is ended if it has not
    const stuck = setTimeout(() => {
      if (child.exitCode === null && child.pid !== undefined) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    }, STILL_RUNNING_MS)
    stuck.unref()
    child.once('exit', () => clearTimeout(stuck))
  }

  private open(): ChildProcessWithoutNullStreams {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: this.workingDirectory, env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.received = Buffer.alloc(0)
    this.body = undefined
    const gone = (error: Error) => {
      if (this.child !== child) return
      this.child = undefined
      clearTimeout(this.linger)
      this.fail(error)
    }
    child.on('error', gone)
    child.on('exit', () => gone(new Error('git cat-file ended while a file was being read')))
    // Writing to a process that has gone is reported here, and the exit says the rest
    child.stdin.on('error', () => {})
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      this.stall?.output()
      this.take(chunk)
    })
    return child
  }

  private fail(error: Error): void {
    this.stall?.stop()
    this.stall = undefined
    for (const each of this.pending.splice(0)) each.reject(error)
  }

  /** Answers the oldest read, and lets the process go once nothing more is asked of it for a while */
  private answer(content: Buffer | undefined): void {
    this.pending.shift()?.resolve(content)
    if (this.pending.length > 0) return
    this.stall?.stop()
    this.stall = undefined
    this.linger = setTimeout(() => this.close(), this.lingerMs)
    this.linger.unref()
  }

  /**
   * Reads what git wrote: for each name a line saying what it is and how long, then that many bytes and a line
   * break, or one line saying it is missing
   */
  private take(chunk: Buffer): void {
    this.received = this.received.length === 0 ? chunk : Buffer.concat([this.received, chunk])
    for (;;) {
      if (this.body) {
        const taken = this.received.subarray(0, this.body.left)
        this.body.chunks?.push(taken)
        this.body.left -= taken.length
        this.received = this.received.subarray(taken.length)
        if (this.body.left > 0) return
        const { chunks } = this.body
        this.body = undefined
        // The line break git ends the object with was counted into `left`
        this.answer(chunks ? Buffer.concat(chunks).subarray(0, -1) : undefined)
        continue
      }
      const end = this.received.indexOf(0x0a)
      if (end < 0) return
      const header = this.received.subarray(0, end).toString('utf8')
      this.received = this.received.subarray(end + 1)
      const object = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header)
      if (!object) {
        this.answer(undefined)
        continue
      }
      const size = Number(object[2])
      // Only a file is a file: a directory's name answers with a tree, which is read past
      this.body = { left: size + 1, chunks: object[1] === 'blob' && size <= LARGEST_READ ? [] : undefined }
    }
  }
}
