// The picture of one working tree: the last status read, what a watcher has said changed since, and which parts
// of the repository differ from the last time it was checked.
import * as path from 'path'
import * as fs from 'fs/promises'
import { failure, type GitRunner } from './runner.ts'
import {
  NOTED_PATHS_LIMIT, STATUS_LIMIT, WHOLE_TREE_FILES, differingFiles, inStatusOrder, nameOfCommit, partsAll, pathFolding, snapshotOf, splitStatus,
  type LoadedSnapshot, type SnapshotIdentity, type StatusEntry,
} from './status.ts'
import type { GitDirectories, GitStatusFile, RepositoryChange, RepositoryOperation, RepositorySnapshot } from './types.ts'

/**
 * How many checks of everything in a row must find changes the watcher never reported before the snapshot says live
 * updates are not arriving. Counted in checks, never in time: one miss is a watcher that had not caught up yet
 */
export const MISSED_CHECKS_SILENT = 3

export class RepositoryModel {
  /**
   * What the host shows beside the status and is no part of git's: a change to it reads as a change to the
   * status, so the windows showing the checkout are told (`setStatusNote`)
   */
  private statusNote = ''

  /**
   * `writing` says whether a write made through this engine is running or waiting, which is when a status is not
   * let write git's index
   */
  constructor(private readonly runner: GitRunner, private readonly writing: () => boolean) {}

  private get workingDirectory(): string {
    return this.runner.workingDirectory
  }

  setStatusNote(note: string): void {
    this.statusNote = note
  }

  /** The last snapshot read, with what it and the refs looked like, to tell a change from none */
  snapshot?: LoadedSnapshot

  /**
   * What may have changed since `snapshot` was read: paths in the working tree that a watcher named, relative to
   * the working directory, or anything. Nothing in it is what lets the snapshot be reused.
   */
  unread: Set<string> | 'anything' = 'anything'

  /**
   * Whether the index may hold stale facts about the files: something changed many of them, or git's own state,
   * since a status was last let write it. Not known to be fresh until one has been
   */
  indexMayBeStale = true

  /** Counts the times a folder listed as one row was read again, so that each reads as a change to it */
  folderReads = 0

  /** Whether the next whole status is the one let write the index */
  refreshIndexOnRead = false

  /** Counts every notice that the repository may have changed, so a read begun before one is not taken for one after it */
  snapshotVersion = 0

  snapshotRead?: { version: number; promise: Promise<LoadedSnapshot> }

  /** What the last read looked like, `unreadable` when it failed */
  lastIdentity?: SnapshotIdentity

  /** What the last `refreshSnapshot` saw, which is what its next one is compared with */
  checkedIdentity?: SnapshotIdentity

  /** Where this checkout's git state lives, as git last said: it is asked again whenever the watches are checked */
  gitDirectories?: GitDirectories

  /** Whether a watcher reports this checkout's changes; without one a snapshot is read every time it is asked for */
  watched = false

  watchFailed = false

  /** The repository may have changed in any way: the next snapshot asked for is read from git, all of it */
  markSnapshotStale(): void {
    this.snapshotVersion++
    this.unread = 'anything'
  }

  /**
   * Notes what a watcher saw change, which is what the next snapshot asked for reads: these paths in the working
   * tree, relative to the working directory with `/` between their parts, or everything when it could not name them
   */
  /** What the watcher has reported since the last check of everything, which a check's findings are held to */
  private notedSinceCheck = 0
  /** Checks of everything in a row that found changes the watcher had said nothing of */
  private missedChecks = 0

  /** Whether checks keep finding what the watcher never reported (`RepositorySnapshot.watchSilent`) */
  get watchSilent(): boolean {
    return this.watched && !this.watchFailed && this.missedChecks >= MISSED_CHECKS_SILENT
  }

  noteChanged(paths: string[] | null): void {
    this.notedSinceCheck++
    // A change too wide to name, or to git's own state: a checkout, a formatter over the tree, a commit elsewhere
    if (paths === null) this.indexMayBeStale = true
    if (paths === null || this.unread === 'anything' || this.unread.size + paths.length > NOTED_PATHS_LIMIT) return this.markSnapshotStale()
    this.snapshotVersion++
    for (const changed of paths) this.unread.add(changed)
  }

  /**
   * Says whether a watcher reports this checkout's changes, which is what lets a snapshot be reused. `failed`
   * says its watches could not be opened or have stopped, as opposed to not being open yet or not being wanted.
   */
  setWatched(watched: boolean, failed = false): void {
    this.watched = watched
    this.watchFailed = failed
    this.markSnapshotStale()
  }

  /** Whether this checkout's watches failed: a panel showing it then changes only when it is asked again */
  get hasWatchFailed(): boolean {
    return this.watchFailed
  }

  async readStatus(): Promise<GitStatusFile[]> {
    return (await this.readSnapshot()).files
  }

  /**
   * The checkout's changed files, branch and distance from its upstream.
   *
   * A snapshot is reused until something says the repository may have changed: a watcher's event, a write made
   * here, a reconcile. It never waits on the remote: `fetchIfDue` is what fetches.
   */
  async readSnapshot(): Promise<RepositorySnapshot> {
    const { value } = await this.currentSnapshot()
    return this.watchSilent ? { ...value, watchSilent: true } : value
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
  async refreshSnapshot(reading: 'everything' | 'noted' = 'everything', { refreshIndex = false } = {}): Promise<RepositoryChange> {
    // Whether its watches failed, and what the host shows beside the status, are part of what a window shows of
    // the checkout's status, so they are part of it here
    const seen = (identity: SnapshotIdentity): SnapshotIdentity =>
      ({ ...identity, status: `${this.watchFailed ? 'unwatched' : this.watchSilent ? 'silent' : 'watched'} ${this.statusNote}\n${identity.status}` })
    // Compared with what the last check saw, not with what was last read: one window's ask can read a change
    // before this runs, and this is what tells the others
    const before = this.checkedIdentity ?? (this.lastIdentity && seen(this.lastIdentity))
    if (reading === 'everything') {
      this.markSnapshotStale()
      if (refreshIndex && this.indexMayBeStale) this.refreshIndexOnRead = true
    }
    let read: SnapshotIdentity
    try {
      read = (await this.currentSnapshot()).identity
    } catch {
      read = this.lastIdentity = partsAll('unreadable')
    }
    // A check with nothing to go by that found the files changed, of which the watcher said nothing since the last:
    // evidence the watch is not delivering. One that heard from the watcher is evidence it is. Becoming silent, or
    // hearing again, then reads as news of the status, since the window says its view may be behind
    if (reading === 'everything' && this.watched && before) {
      const statusOf = (identity: SnapshotIdentity) => identity.status.slice(identity.status.indexOf('\n') + 1)
      if (this.notedSinceCheck > 0) this.missedChecks = 0
      else if (read.diffs !== before.diffs || statusOf(seen(read)) !== statusOf(before)) this.missedChecks++
      this.notedSinceCheck = 0
    }
    const now = seen(read)
    this.checkedIdentity = now
    // A first check has nothing to compare with, so everything it reads is new to whoever hears of it
    if (!before) return partsAll(true)

    const history = now.history !== before.history
    const diffs = now.diffs !== before.diffs
    return {
      status: now.status !== before.status,
      diffs,
      history,
      stashes: now.stashes !== before.stashes,
      // A worktree is listed with the commit it is on, which moves with its branch
      worktrees: history || now.worktrees !== before.worktrees,
      refs: now.refs !== before.refs,
      ...(diffs && differingFiles(before.files, now.files)),
    }
  }

  currentSnapshot(): Promise<LoadedSnapshot> {
    // Not while a read is under way: it took what was noted when it began and holds the new snapshot only when
    // it ends, so until then the one held is from before it, with nothing left noted against it
    if (!this.snapshotRead && this.snapshot && this.watched && this.unread !== 'anything' && this.unread.size === 0) return Promise.resolve(this.snapshot)
    if (this.snapshotRead?.version === this.snapshotVersion) return this.snapshotRead.promise

    // One read at a time, each starting from what the one before it left: a read of a few paths is put into the
    // snapshot it starts from, which a read still running has not written yet
    const version = this.snapshotVersion
    const earlier = this.snapshotRead?.promise.then(() => {}, () => {}) ?? Promise.resolve()
    const promise = earlier.then(() => this.readSnapshotOnce()).finally(() => {
      if (this.snapshotRead?.promise === promise) this.snapshotRead = undefined
    })
    this.snapshotRead = { version, promise }
    return promise
  }

  async readSnapshotOnce(): Promise<LoadedSnapshot> {
    const held = this.watched ? this.snapshot : undefined
    // Whatever is noted from here on may be a change this read does not see, so it stays unread
    const noted = this.unread
    this.unread = new Set()
    if (held && noted !== 'anything' && noted.size === 0) return held
    try {
      const loaded = (held && noted !== 'anything' ? await this.loadNoted(held, [...noted]) : undefined) ?? await this.loadSnapshot()
      this.snapshot = loaded
      this.lastIdentity = loaded.identity
      return loaded
    } catch (error) {
      this.unread = 'anything'
      throw error
    }
  }

  async loadSnapshot(): Promise<LoadedSnapshot> {
    // Two things git was told that decide what a status lists. An untracked folder is one row, as git lists it
    // when told nothing: a folder of thousands of files nobody ignored is then one line and not walked. The user
    // may have told git to list every file, or none, which is theirs to decide. And whether two spellings of a
    // name that differ by case are one file
    const config = await this.runner.executeGitCommand(['config', '--get-regexp', '^(status\\.showuntrackedfiles|core\\.ignorecase|user\\.name|user\\.email|core\\.fsmonitor|core\\.untrackedcache)$'])
    const told = new Map((config.success ? config.output ?? '' : '').split('\n').filter(Boolean).map((line): [string, string] => {
      const space = line.indexOf(' ')
      return [line.slice(0, space), line.slice(space + 1).trim()]
    }))
    const said = told.get('status.showuntrackedfiles')
    const untracked = said === 'no' || said === 'all' ? said : 'normal'
    const ignoreCase = /^(true|yes|on|1)$/i.test(told.get('core.ignorecase') ?? '')
    // Who a commit is by, from the settings or from what git's own environment says: a name and an email each
    const environment = this.runner.environment()
    const hasIdentity = !!(told.get('user.name') || (environment.GIT_AUTHOR_NAME && environment.GIT_COMMITTER_NAME))
      && !!(told.get('user.email') || (environment.GIT_AUTHOR_EMAIL && environment.GIT_COMMITTER_EMAIL) || environment.EMAIL)
    // Not while a write made here is running or waiting: the status would wait its turn behind it, and every
    // read asked meanwhile behind the status. A git of ours running is also not the moment this was chosen for.
    // The index stays marked as it was, and the next such check writes it
    const refreshesIndex = this.refreshIndexOnRead && !this.writing()
    this.refreshIndexOnRead = false
    // Another git holding the index is why git would skip the write, silently: the index is as suspect after
    const gitDir = refreshesIndex ? (this.gitDirectories ?? await this.resolveGitDirectories())?.gitDir : undefined
    const heldElsewhere = gitDir !== undefined && await fs.stat(path.join(gitDir, 'index.lock')).then(() => true, () => false)
    const statusStarted = performance.now()
    const status = await this.runner.executeGitCommand(['status', '--porcelain=v2', '--branch', '--show-stash', `--untracked-files=${untracked}`, '-z'], { refreshesIndex })
    const statusMs = Math.round(performance.now() - statusStarted)
    const on = (key: string) => /^(true|yes|on|1)$/i.test(told.get(key) ?? '')
    const fileMonitor = on('core.fsmonitor')
    const untrackedCache = on('core.untrackedcache')
    const slowStatus = statusMs > this.runner.statusBudgetMs && !(fileMonitor && untrackedCache)
      ? { ms: statusMs, budgetMs: this.runner.statusBudgetMs, fileMonitor, untrackedCache }
      : undefined
    if (!status.success && !status.truncated) {
      throw failure(status, 'Failed to get git status')
    }
    if (refreshesIndex && !heldElsewhere) this.indexMayBeStale = false
    // Git printed more than is read: what was read ends inside a record, which is dropped with the rest
    const output = status.truncated ? (status.output ?? '').slice(0, (status.output ?? '').lastIndexOf('\0') + 1) : status.output ?? ''
    const { headers, entries } = splitStatus(output)

    // Status's headers say more than status. The branch checked out, the commit it is on and what it follows
    // are history, and all but the commit are shown with the status too; the stash count is stashes
    const isBranch = (header: string) => header.startsWith('# branch.')
    const isStashCount = (header: string) => header.startsWith('# stash ')
    // Refs move without the status moving: a fetch, a branch made or deleted, a stash
    const refs = ((await this.runner.executeGitCommand(['for-each-ref', '--format=%(objectname) %(refname)'])).output ?? '').split('\n')
    const isStash = (ref: string) => ref.endsWith(' refs/stash')
    const isLocalBranch = (ref: string) => ref.includes(' refs/heads/')
    const directories = this.gitDirectories ?? await this.resolveGitDirectories()

    return this.snapshotOver({ headers, entries, untracked, ignoreCase, hasIdentity, slowStatus, operation: await this.readOperation(directories, refs) }, {
      // What is checked out, and the local branches: a remote's branch moving, as a fetch moves it, is not history
      history: [...headers.filter(isBranch), ...refs.filter(isLocalBranch)].join('\n'),
      // Every ref but the stash, and the settings that name the remotes, read from the file and not by running git
      refs: [...refs.filter(ref => !isStash(ref)), await this.readConfigIdentity(directories)].join('\n'),
      // The count as well as the ref: dropping a stash below the newest moves only the count
      stashes: [...headers.filter(isStashCount), ...refs.filter(isStash)].join('\n'),
      worktrees: await this.readWorktreesIdentity(directories),
    }, { directories, truncated: status.truncated === true })
  }

  /**
   * The held snapshot with these paths of the working tree read again, or nothing when a status of them alone
   * would not say all that changed, and the whole status is to be read.
   *
   * Git is asked about the paths and about nothing else. That is the whole truth of a change to the working tree
   * as long as no file's standing depends on another's, and the checks here are the ways it can.
   */
  async loadNoted(held: LoadedSnapshot, noted: string[]): Promise<LoadedSnapshot | undefined> {
    if (held.value.truncated) return undefined
    if (noted.some(changed => WHOLE_TREE_FILES.has(changed.slice(changed.lastIndexOf('/') + 1)))) return undefined
    // A rename, a copy and a file added without its content are each read from two paths at once: asked for alone,
    // one of the two comes back as an addition or a deletion
    if (held.entries.some(entry => entry.originalPath !== undefined || entry.columns?.[1] === 'A')) return undefined
    const directories = this.gitDirectories ?? await this.resolveGitDirectories()
    if (!directories) return undefined

    const fold = pathFolding(held.ignoreCase)
    // A path inside a folder held as one row is asked about as that folder: git answers for a file in it with
    // the file, where a whole status has the folder, and the folder is still one row or it is gone
    const folders = held.entries.filter(entry => entry.record.startsWith('? ') && entry.path.endsWith('/'))
    const folderOver = (changed: string) => folders.find(folder => fold(`${directories.prefix}${changed}/`).startsWith(fold(folder.path)))
    // A folder above the working directory cannot be asked about from under it
    if (noted.some(changed => (folderOver(changed)?.path.length ?? Infinity) <= directories.prefix.length)) return undefined
    // Asked about a folder and a path inside it at once, git answers for the path and says nothing of the folder
    // being one row: only the outermost of the paths are asked about, which covers what is under them
    const outermost = (specs: string[]) => {
      const folded = [...new Set(specs)].map(spec => [spec, fold(spec)] as const)
      return folded.filter(([, one]) => !folded.some(([, other]) => other === '' ? one !== '' : one.startsWith(`${other}/`))).map(([spec]) => spec)
    }
    let asked = outermost(await Promise.all(noted.map(async (changed) => {
      const folder = folderOver(changed)
      return folder ? folder.path.slice(directories.prefix.length, -1) : this.outermostRepositoryOver(changed)
    })))
    // Each path is taken as it is spelled: a `*` or a `[` in a name is that character, and where git ignores case
    // it does for these too
    const magic = `:(literal${held.ignoreCase ? ',icase' : ''})`
    const statusFor = async (specs: string[]): Promise<StatusEntry[] | undefined> => {
      // The working directory itself is asked about as `.`
      const status = await this.runner.executeGitCommand(['status', '--porcelain=v2', `--untracked-files=${held.untracked}`, '-z', '--', ...specs.map(spec => magic + (spec || '.'))])
      if (!status.success || status.truncated) return undefined
      const entries = splitStatus(status.output ?? '').entries
      return entries.some(entry => entry.originalPath !== undefined) ? undefined : entries
    }
    let found = await statusFor(asked)
    if (!found) return undefined

    // An untracked path that was not held and lies in a folder may be in one git tracks nothing in, which a whole
    // status lists as the folder and this answer as the path. Its folder is asked about: git answers with the
    // folder itself when it tracks nothing there, and then only the whole status says how far up that goes
    const heldPaths = new Set(held.entries.map(entry => fold(entry.path)))
    const folderOf = (entry: StatusEntry) => entry.path.replace(/\/$/, '').split('/').slice(0, -1).join('/')
    const mayBeInAFolder = (entry: StatusEntry) => entry.record.startsWith('? ') && !heldPaths.has(fold(entry.path)) && folderOf(entry) !== ''
    if (held.untracked === 'normal' && found.some(mayBeInAFolder)) {
      const parents = [...new Set(found.filter(mayBeInAFolder).map(folderOf))]
      // A folder above the working directory cannot be asked about from under it
      if (parents.some(parent => `${parent}/`.length < directories.prefix.length)) return undefined
      asked = outermost([...asked, ...parents.map(parent => parent.slice(directories.prefix.length))])
      found = await statusFor(asked)
      if (!found || found.some(entry => entry.path.endsWith('/') && parents.includes(entry.path.slice(0, -1)))) return undefined
    }

    // What git answered replaces what was held of the same paths and of everything under them
    const under = asked.map(spec => fold((directories.prefix + spec).replace(/\/$/, '')))
    const answered = new Set(found.map(entry => fold(entry.path)))
    const kept = held.entries.filter((entry) => {
      const folded = fold(entry.path)
      return !answered.has(folded) && !under.some(spec => folded === spec || folded.startsWith(`${spec}/`))
    })
    const entries = inStatusOrder([...kept, ...found])
    if (entries.length > STATUS_LIMIT) return undefined
    return this.snapshotOver({ ...held, entries }, held.identity, { directories, truncated: false, held: { files: held.identity.files, kept: new Set(kept) } })
  }

  /**
   * The path git answers for when asked about this one: the outermost directory over it that is a repository of
   * its own, or the path itself. Git does not look inside another repository — a nested one and a submodule are
   * each one entry, at the directory — so asked about a file inside one it answers nothing.
   */
  async outermostRepositoryOver(relativePath: string): Promise<string> {
    const parts = relativePath.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/')
      if (await fs.access(path.join(this.workingDirectory, directory, '.git')).then(() => true, () => false)) return directory
    }
    return relativePath
  }

  /**
   * A snapshot of a status as it was read, beside the parts of the repository a status does not hold. `held` is
   * the snapshot this one was made from by reading some paths again: how its other files looked is kept, not read.
   */
  async snapshotOver(
    read: Pick<LoadedSnapshot, 'headers' | 'entries' | 'untracked' | 'ignoreCase' | 'hasIdentity' | 'slowStatus' | 'operation'>,
    rest: Pick<SnapshotIdentity, 'history' | 'stashes' | 'worktrees' | 'refs'>,
    { directories, truncated, held }: { directories: GitDirectories | null; truncated: boolean; held?: { files?: Map<string, string>; kept: Set<StatusEntry> } },
  ): Promise<LoadedSnapshot> {
    const { headers, entries } = read
    const value = snapshotOf({ headers, entries })
    value.hasIdentity = read.hasIdentity
    if (read.slowStatus) value.slowStatus = read.slowStatus
    if (read.operation) value.operation = read.operation
    if (truncated || value.files.length > STATUS_LIMIT) {
      value.files = value.files.slice(0, STATUS_LIMIT)
      value.truncated = true
    }
    // Status names its paths from the top of the checkout, which the working directory may be under
    const top = path.resolve(this.workingDirectory, ...(directories?.prefix ?? '').split('/').filter(Boolean).map(() => '..'))
    // A file's record names what it holds in HEAD and in the index, and nothing of what it holds in the working
    // tree: a second edit to a file already changed leaves the record as it was. How the file looks says that,
    // for the files a window can have a diff of open, which are the ones the snapshot lists
    const files = new Map(await Promise.all(entries.slice(0, STATUS_LIMIT).map(async (entry): Promise<[string, string]> => {
      const known = held?.kept.has(entry) ? held.files?.get(entry.path) : undefined
      if (known !== undefined) return [entry.path, known]
      const inWorkingTree = !entry.columns || entry.columns[1] !== '.'
      // A folder listed as one row was read again because something under it may have changed, which its own
      // time does not say when the change is deeper than its own files: it reads as changed each time it is
      // read, by a read of everything as by a read of it alone
      if (entry.path.endsWith('/')) return [entry.path, `${entry.record}\0${++this.folderReads}`]
      return [entry.path, `${entry.record}\0${inWorkingTree ? await this.fileSignature(path.join(top, entry.path)) : ''}`]
    })))
    const isCommit = (header: string) => header.startsWith('# branch.oid ')
    const isStashCount = (header: string) => header.startsWith('# stash ')

    return {
      ...read,
      value,
      identity: {
        // What git is in the middle of is shown with the status, so it is part of it
        // Whether a status is slow, and what would help, is news; how long this one took is not
        status: [JSON.stringify(read.operation ?? null), `identity ${read.hasIdentity}`, `slow ${JSON.stringify(read.slowStatus ? { ...read.slowStatus, ms: 0 } : null)}`, ...headers.filter(header => !isCommit(header) && !isStashCount(header)), ...entries.map(entry => entry.record)].join('\0'),
        diffs: [...files.values()].join('\0'),
        history: rest.history,
        stashes: rest.stashes,
        worktrees: rest.worktrees,
        refs: rest.refs,
        files,
      },
    }
  }

  /**
   * What git is in the middle of here, read from what it keeps in its directory while it is: no git is run. A
   * rebase is looked for first, since the commit it stops at can leave what a cherry-pick leaves too.
   */
  async readOperation(directories: GitDirectories | null, refs: string[]): Promise<RepositoryOperation | undefined> {
    if (!directories) return undefined
    const read = (file: string) => fs.readFile(path.join(directories.gitDir, file), 'utf8').then(text => text.trim(), () => undefined)
    for (const [directory, at, of] of [['rebase-merge', 'msgnum', 'end'], ['rebase-apply', 'next', 'last']] as const) {
      const onto = await read(`${directory}/onto`)
      if (!onto) continue
      const [branch, step, steps] = await Promise.all([read(`${directory}/head-name`), read(`${directory}/${at}`), read(`${directory}/${of}`)])
      return {
        kind: 'rebase',
        subject: nameOfCommit(refs, onto),
        ...(branch?.startsWith('refs/heads/') && { branch: branch.slice('refs/heads/'.length) }),
        ...(Number(step) > 0 && Number(steps) > 0 && { step: Number(step), steps: Number(steps) }),
      }
    }
    const merged = await read('MERGE_HEAD')
    if (merged) {
      // Git wrote what it is merging into the message it proposes, where it was given a name for it
      const named = /^Merge (?:remote-tracking )?(?:branch|tag) '([^']+)'/.exec(await read('MERGE_MSG') ?? '')
      return { kind: 'merge', subject: named?.[1] ?? nameOfCommit(refs, merged.split('\n')[0]!) }
    }
    const picked = await read('CHERRY_PICK_HEAD')
    if (picked) return { kind: 'cherry-pick', subject: picked.slice(0, 7) }
    const reverted = await read('REVERT_HEAD')
    if (reverted) return { kind: 'revert', subject: reverted.slice(0, 7) }
    return undefined
  }

  /** How a file in the working tree looks without reading it, which tells a later edit from none */
  fileSignature(file: string): Promise<string> {
    return fs.stat(file).then(stat => `${stat.mtimeMs}:${stat.size}`, () => 'gone')
  }

  /** What says the remotes changed, read from the repository's settings file and without running git: all of it */
  async readConfigIdentity(directories: GitDirectories | null): Promise<string> {
    if (!directories) return ''
    return fs.readFile(path.join(directories.commonDir, 'config'), 'utf8').catch(() => '')
  }

  /**
   * What says the worktrees changed, read from the files git keeps for them and without running it: which there
   * are, where each is, what each has checked out, and which are locked.
   */
  async readWorktreesIdentity(directories: GitDirectories | null): Promise<string> {
    if (!directories) return ''
    const { commonDir } = directories
    const read = (file: string) => fs.readFile(file, 'utf8').then(text => text.trim(), () => '')
    const names = await fs.readdir(path.join(commonDir, 'worktrees')).then(found => found.sort(), () => [] as string[])
    const linked = await Promise.all(names.map(async (name) => {
      const directory = path.join(commonDir, 'worktrees', name)
      const locked = await fs.access(path.join(directory, 'locked')).then(() => ' locked', () => '')
      return `${name} ${await read(path.join(directory, 'gitdir'))} ${await read(path.join(directory, 'HEAD'))}${locked}`
    }))
    return [`main ${await read(path.join(commonDir, 'HEAD'))}`, ...linked].join('\n')
  }

  /**
   * Where this checkout's git state lives: its own git directory (index, HEAD) and the common one holding refs.
   * The two differ in a linked worktree. Null when the working directory is in no repository.
   */
  async resolveGitDirectories(): Promise<GitDirectories | null> {
    const result = await this.runner.executeGitCommand(['rev-parse', '--git-dir', '--git-common-dir', '--show-prefix'])
    const [gitDir, commonDir, prefix] = (result.success ? result.output ?? '' : '').split('\n').map(line => line.trim())
    this.gitDirectories = gitDir && commonDir
      ? { gitDir: path.resolve(this.workingDirectory, gitDir), commonDir: path.resolve(this.workingDirectory, commonDir), prefix: prefix ?? '' }
      : undefined
    return this.gitDirectories ?? null
  }
}
