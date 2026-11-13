import * as path from 'path'
import * as fs from 'fs/promises'
import type { GitRepository } from './repository.ts'
import { subscribeToDirectory, type DirectorySubscription, type SubscribeToDirectory, type WatchedChange } from './directory-watch.ts'
import { followFile, type FileFollower, type FollowFile } from './file-watch.ts'
import type { RepositoryLog } from './ties.ts'

/** How long the repository must go quiet before its change is reported */
const QUIET_MS = 200
/** The same once one of this app's own git writes has finished: its lock is already released */
const QUIET_AFTER_WRITE_MS = 50
/** The longest a change waits for quiet, so a steady stream of writes cannot postpone it without end */
const MAX_WAIT_MS = 1000

/** Files in a checkout's own git directory whose change means its status may have */
const GIT_DIR_FILES = new Set(['index', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
/** What a git directory holds that says nothing about status, and is written in bulk */
const GIT_DIR_IGNORED = ['objects', 'logs', 'hooks', 'lfs', 'modules', 'worktrees']
/** The most ignored directories handed to the watcher; the rest only cost a status that finds nothing changed */
const MAX_IGNORED_DIRECTORIES = 2000
/** The most paths one report names: past these it says only that the checkout may have changed */
const MAX_NAMED_PATHS = 32
/**
 * How many events the platform delivers in one burst before what it reported is no longer taken to be all
 * there was. A platform drops events once its queue is full and says so to nobody, and Linux's holds 16,384:
 * a burst a sixteenth of that is one a full queue is not far from, and far more than a save or a small
 * checkout makes.
 */
const FLOOD_EVENTS = 1000
/**
 * How long the platform must deliver nothing for a burst to be over. A wait on this process's own state, with
 * nothing to watch but the absence of an event
 */
const FLOOD_QUIET_MS = 500

/**
 * What a report says changed: paths in the working tree, relative to the working directory with `/` between
 * their parts, when nothing else changed and they are few enough to name; `null` when anything may have.
 */
export type ChangedPaths = string[] | null

type WatchKey = 'tree' | 'git' | 'common'

interface WantedWatch {
  directory: string
  ignore: string[]
  /** Whether a change at this path, relative to the directory, can move the repository's status */
  relevant(relativePath: string): boolean
}

const isRef = (relativePath: string) => relativePath === 'packed-refs' || relativePath.startsWith(`refs${path.sep}`)
const isLock = (relativePath: string) => relativePath.endsWith('.lock')

/**
 * Reports that a checkout may have changed: its working tree, its index and HEAD, or its refs.
 *
 * **An event is a hint, and git is what says whether anything changed.** So nothing here needs to be exact: an
 * event for a file git ignores costs one status that finds no difference, and an event the platform never
 * delivered is made up for by `check`, which whoever knows the repository may have moved calls — a window
 * gaining focus, a terminal command finishing, an agent's turn ending.
 */
export class GitWatcherService {
  private subscriptions = new Map<WatchKey, { watch: WantedWatch; signature: string; subscription: DirectorySubscription }>()
  /**
   * Git's own files that say its state moved, each followed on its own. A watch on one file is another
   * mechanism than the watch on a tree, and goes on reporting while a flood of file events holds that one up:
   * the index, HEAD and the packed refs are what a checkout, a commit and a fetch end by writing
   */
  private followed = new Map<string, FileFollower>()
  private readonly subscribe: SubscribeToDirectory
  private readonly follow: FollowFile
  private readonly log: RepositoryLog
  /** Every start, stop and check in order, so two never set subscriptions up at once */
  private establishing: Promise<void> = Promise.resolve()
  /** Moves on every start and stop, which is what tells work begun before one that it is no longer wanted */
  private generation = 0
  private onChangeCallback?: (paths: ChangedPaths) => void
  /** The working-tree paths that changed since the last report, or `null` once something else may have too */
  private changedPaths: Set<string> | null = new Set()
  private quietTimeout?: NodeJS.Timeout
  /** When the first change not yet reported arrived */
  private pendingSince?: number
  /** Whether a callback is already waiting on the repository's write in progress */
  private awaitingWrite = false
  /**
   * The burst of platform events under way: how many there have been, when the last arrived, and when the
   * checkout was last reported as one in which anything may have changed
   */
  private burst = { events: 0, lastAt: 0, saidAnythingAt: 0 }
  private burstTimeout?: NodeJS.Timeout
  private isWatching = false
  private gitRepository?: GitRepository

  /**
   * `subscribe` and `followFile` are the platform's watches, which a host or a spec can replace; `log` is where
   * a watch that could not be opened or closed is said
   */
  constructor(private workingDirectory: string, { subscribe = subscribeToDirectory, followFile: follow = followFile, log = {} }: { subscribe?: SubscribeToDirectory; followFile?: FollowFile; log?: RepositoryLog } = {}) {
    this.subscribe = subscribe
    this.follow = follow
    this.log = log
  }

  setGitRepository(repo: GitRepository): void {
    this.gitRepository = repo
  }

  setChangeCallback(callback: (paths: ChangedPaths) => void) {
    this.onChangeCallback = callback
  }

  async startWatching(signal: AbortSignal): Promise<void> {
    if (this.isWatching || signal.aborted) return
    const generation = ++this.generation
    const cancelled = () => signal.aborted || generation !== this.generation
    this.establishing = this.establishing.catch(() => {}).then(async () => {
      await this.establish(cancelled)
      if (cancelled()) return
      this.isWatching = true
      // A watch is not in place when the call that opens it returns: a change made in the next turns is one no
      // event reports, so starting resolves once it is
      await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)))
    })
    await this.establishing
  }

  /**
   * Brings the watches in line with the checkout as it is now, for a caller that knows it may have moved.
   * A directory that became a repository starts being watched, a watch that failed or ended with its
   * directory is opened again, and the ignored directories are taken afresh.
   */
  async check(): Promise<void> {
    if (!this.isWatching) return
    const generation = this.generation
    this.establishing = this.establishing
      .catch(() => {})
      .then(() => this.establish(() => generation !== this.generation))
      .catch((error) => { this.log.error?.('Could not re-establish the git watches', { error }) })
    await this.establishing
  }

  private async establish(cancelled: () => boolean): Promise<void> {
    // Git says where its state lives: the working directory may be a subfolder of the checkout or a linked
    // worktree, and neither keeps a `.git` directory of its own holding the refs.
    // A repository that is not trusted is asked nothing, and is watched once it is: until then there is none
    // here to watch, as when the directory holds no repository
    const directories = await this.gitRepository?.resolveGitDirectories().catch(() => null) ?? null
    const ignored = directories ? await this.gitRepository!.listIgnoredDirectories().catch(() => []) : []
    if (cancelled()) return

    const wanted = new Map<WatchKey, WantedWatch>()
    if (directories) {
      // One directory can be named two ways, and git names its own both ways: by its real path they compare
      const real = (directory: string) => fs.realpath(directory).catch(() => directory)
      const [tree, gitDir, commonDir] = await Promise.all([real(this.workingDirectory), real(directories.gitDir), real(directories.commonDir)])
      const shared = gitDir === commonDir
      wanted.set('tree', { directory: tree, ignore: ['.git', ...ignored.slice(0, MAX_IGNORED_DIRECTORIES)], relevant: () => true })
      wanted.set('git', {
        directory: gitDir,
        ignore: GIT_DIR_IGNORED,
        relevant: relativePath => !isLock(relativePath) && (GIT_DIR_FILES.has(relativePath) || (shared && isRef(relativePath))),
      })
      // A linked worktree's refs are in the git directory of its main checkout
      if (!shared) wanted.set('common', { directory: commonDir, ignore: GIT_DIR_IGNORED, relevant: relativePath => !isLock(relativePath) && isRef(relativePath) })
    }
    if (cancelled()) return

    // The files of git's own that are followed one by one, beside the watch on its directory
    const files = directories
      ? [path.join(directories.gitDir, 'index'), path.join(directories.gitDir, 'HEAD'), path.join(directories.commonDir, 'packed-refs')]
      : []
    for (const [file, follower] of this.followed) {
      if (files.includes(file)) continue
      follower.close()
      this.followed.delete(file)
    }
    for (const file of files) {
      // One that was not there when it was first followed, as the packed refs are until git packs them, is
      // followed from here
      const held = this.followed.get(file)
      if (held) held.look()
      else this.followed.set(file, this.follow(file, () => { if (!cancelled()) this.scheduleChange(null) }))
    }

    const signatureOf = (watch: WantedWatch) => JSON.stringify([watch.directory, watch.ignore])
    for (const [key, held] of this.subscriptions) {
      const watch = wanted.get(key)
      if (watch && held.signature === signatureOf(watch)) {
        // Still the watch wanted. Its tree may have moved under it all the same, with events lost on the way
        await held.subscription.check?.({ ignore: watch.ignore }).catch((error) => { this.log.error?.(`Could not check the ${key} watch`, { error }) })
        continue
      }
      // The same directory with other directories to ignore: taken afresh by the watch that is open, where it can
      if (watch && watch.directory === held.watch.directory && held.subscription.check) {
        await held.subscription.check({ ignore: watch.ignore }).catch((error) => { this.log.error?.(`Could not check the ${key} watch`, { error }) })
        held.signature = signatureOf(watch)
        continue
      }
      this.subscriptions.delete(key)
      await held.subscription.unsubscribe().catch((error) => { this.log.error?.(`Could not close the ${key} watch`, { error }) })
    }
    for (const [key, watch] of wanted) {
      if (this.subscriptions.has(key)) continue
      try {
        const subscription = await this.subscribe(watch.directory, (error, changes) => this.handleChanges(key, watch, error, changes), {
          ignore: watch.ignore,
          onEvent: () => this.countEvent(),
        })
        if (cancelled()) {
          await subscription.unsubscribe()
          return
        }
        this.subscriptions.set(key, { watch, signature: signatureOf(watch), subscription })
      } catch (error) {
        // Left unwatched: `check` tries again, and until then the repository is read every time it is asked for
        this.log.error?.(`Could not watch ${watch.directory}`, { error })
      }
    }

    // A snapshot is only reused while every watch that could say it went stale is open
    const watched = wanted.size > 0 && [...wanted.keys()].every(key => this.subscriptions.has(key))
    const failed = wanted.size > 0 && !watched
    const failedBefore = this.gitRepository?.hasWatchFailed ?? false
    this.gitRepository?.setWatched(watched, failed)
    // That its watches failed, or came back, is something a window shows, so it is a change to report
    if (failed !== failedBefore) this.scheduleChange(null)
  }

  private handleChanges(key: WatchKey, watch: WantedWatch, error: Error | null, changes: WatchedChange[]) {
    const held = this.subscriptions.get(key)
    // A watch that has since been replaced may still deliver: what it says is about a watch that is gone
    if (held && held.watch !== watch) return
    if (error) {
      // A watch that reported an error has stopped reporting, or may have: close it, so `check` opens a new one
      this.log.error?.(`The ${key} watch failed`, { error })
      if (held) {
        this.subscriptions.delete(key)
        this.gitRepository?.setWatched(false, true)
        void held.subscription.unsubscribe().catch(() => {})
      }
      this.scheduleChange(null)
      return
    }
    const relevant = changes.filter(change => change === null || watch.relevant(change))
    if (relevant.length === 0) return
    // A file in the working tree changes its own standing. The index, HEAD and a ref each change every file's,
    // and a change the platform could not place may be any of them
    const named = key === 'tree' && relevant.every(change => change !== null)
    this.scheduleChange(named ? relevant.map(change => change!.split(path.sep).join('/')) : null)
  }

  /**
   * Counts an event of the platform's towards the burst under way, and once the burst is over reports the
   * checkout as one in which anything may have changed, if it was a flood and its last report named files.
   *
   * **A report that names files is believed only while the platform can be taken to have delivered every
   * event.** A read of the files a report names is all a window reads, so an event the platform dropped is a
   * change nothing shows until something else has the whole checkout read. Neither of Node's watches says when
   * it dropped one. What is known is how many events arrived: a flood is when a queue fills, most of all one in
   * a directory git ignores, whose events are dropped here and never counted towards a report. So a flood ends
   * with the whole checkout read once, after the last event, unless a report since that event already asked
   * for that.
   */
  private countEvent() {
    this.burst.events++
    this.burst.lastAt = Date.now()
    if (this.burstTimeout) return
    const generation = this.generation
    const settle = () => {
      this.burstTimeout = undefined
      if (generation !== this.generation) return
      const quietFor = Date.now() - this.burst.lastAt
      if (quietFor < FLOOD_QUIET_MS) {
        this.burstTimeout = setTimeout(settle, FLOOD_QUIET_MS - quietFor)
        this.burstTimeout.unref()
        return
      }
      const { events, lastAt, saidAnythingAt } = this.burst
      this.burst.events = 0
      if (events >= FLOOD_EVENTS && saidAnythingAt < lastAt) this.scheduleChange(null)
    }
    this.burstTimeout = setTimeout(settle, FLOOD_QUIET_MS)
    this.burstTimeout.unref()
  }

  /** One report for every change that arrives close together */
  private scheduleChange(paths: ChangedPaths) {
    if (!this.onChangeCallback) return
    if (paths === null || this.changedPaths === null) this.changedPaths = null
    else {
      for (const changed of paths) this.changedPaths.add(changed)
      if (this.changedPaths.size > MAX_NAMED_PATHS) this.changedPaths = null
    }
    this.pendingSince ??= Date.now()

    // While one of this app's git writes runs, wait for it to finish instead of racing it on a timer
    if (this.gitRepository?.isWriteInProgress) {
      clearTimeout(this.quietTimeout)
      this.quietTimeout = undefined
      if (this.awaitingWrite) return
      this.awaitingWrite = true
      const generation = this.generation
      this.gitRepository.onWriteComplete(() => {
        if (generation !== this.generation) return
        this.awaitingWrite = false
        if (this.pendingSince !== undefined) this.armChange(QUIET_AFTER_WRITE_MS)
      })
      return
    }
    this.armChange(QUIET_MS)
  }

  private armChange(quietMs: number) {
    clearTimeout(this.quietTimeout)
    const waited = Date.now() - (this.pendingSince ?? Date.now())
    this.quietTimeout = setTimeout(() => {
      this.quietTimeout = undefined
      this.pendingSince = undefined
      const paths = this.changedPaths
      this.changedPaths = new Set()
      if (paths === null) this.burst.saidAnythingAt = Date.now()
      this.onChangeCallback?.(paths && [...paths])
    }, Math.max(0, Math.min(quietMs, MAX_WAIT_MS - waited)))
  }

  async stopWatching(): Promise<void> {
    this.generation++
    this.isWatching = false
    this.onChangeCallback = undefined
    clearTimeout(this.quietTimeout)
    this.quietTimeout = undefined
    clearTimeout(this.burstTimeout)
    this.burstTimeout = undefined
    this.burst = { events: 0, lastAt: 0, saidAnythingAt: 0 }
    this.pendingSince = undefined
    this.awaitingWrite = false
    this.changedPaths = new Set()

    for (const follower of this.followed.values()) follower.close()
    this.followed.clear()
    this.establishing = this.establishing.catch(() => {}).then(async () => {
      const held = [...this.subscriptions.values()]
      this.subscriptions.clear()
      this.gitRepository?.setWatched(false)
      await Promise.all(held.map(({ subscription }) => subscription.unsubscribe().catch((error) => {
        this.log.error?.('Could not close a git watch', { error })
      })))
    })
    await this.establishing
  }

  isActive(): boolean {
    return this.isWatching
  }
}
