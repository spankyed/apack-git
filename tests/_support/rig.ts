// What the watcher's rig cases share: a repository watched as a host watches it, operations made on its tree
// faster than any watcher follows, and the one question each case ends on.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  GitRepository, GitWatcherService, nodeSubscriber, perDirectorySubscriber,
  type RepositorySnapshot, type SubscribeToDirectory, type WatchDirectory, type WatchTree,
} from '../../src/index.ts'
import { run } from './process.ts'

/** Whether this platform has no watch over a tree, and holds one on each directory instead */
export const PER_DIRECTORY = process.platform !== 'darwin' && process.platform !== 'win32'

/** Random numbers that are the same for the same seed, so a case that fails is run again as it was */
export function seeded(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
  return { next, below: (count: number) => Math.floor(next() * count), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! }
}

/**
 * The platform's watch with a switch on it: while `losing`, what it reports reaches nobody, as when the
 * operating system drops events from a queue that is full. It also counts the watches open, by directory.
 */
export function platformWatch() {
  const state = { losing: false, lost: 0, delivered: 0 }
  const open = new Map<object, string>()
  const wrap = <Options>(directory: string, options: Options, listener: (eventType: string, filename: string | null) => void) => {
    const watcher = fs.watch(directory, options as fs.WatchOptions, (eventType, filename) => {
      if (state.losing) state.lost++
      else { state.delivered++; listener(eventType, filename as string | null) }
    })
    open.set(watcher, directory)
    return {
      on: (event: 'error', onError: (error: Error) => void) => watcher.on(event, onError),
      close: () => { open.delete(watcher); watcher.close() },
    }
  }
  const tree: WatchTree = (directory, options, listener) => wrap(directory, options, listener)
  const each: WatchDirectory = (directory, options, listener) => wrap(directory, options, listener)
  const subscribe: SubscribeToDirectory = PER_DIRECTORY ? perDirectorySubscriber(each) : nodeSubscriber(tree)
  return { state, subscribe, watched: () => [...open.values()].sort() }
}

const cleanups: Array<() => Promise<void> | void> = []
/** Ends what the cases of a file started, last first */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, '-c', 'user.name=rig', '-c', 'user.email=rig@example.com', ...args])

/**
 * A repository with a few committed directories, watched the way a host watches one: a report notes what
 * changed and has the repository checked, one check at a time. Every untracked file is a row of its own, so
 * that a file made in any directory is something a status shows.
 */
export async function watchedRepository({ subscribe }: { subscribe?: SubscribeToDirectory } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rig-')))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }))
  await git(root, 'init', '--quiet', '--initial-branch=main')
  await git(root, 'config', 'status.showUntrackedFiles', 'all')
  for (const file of ['src/a.ts', 'src/deep/b.ts', 'docs/readme.md', 'lib/util/c.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), `${file}\n`)
  }
  await git(root, 'add', '.')
  await git(root, 'commit', '--quiet', '-m', 'first')

  const repo = new GitRepository(root)
  const watcher = new GitWatcherService(root, subscribe ? { subscribe } : {})
  let checking: Promise<unknown> = Promise.resolve()
  cleanups.push(async () => {
    await watcher.stopWatching()
    // A check a report started is a git running in the repository's directory, and so is the git kept open for
    // reading files: Windows deletes the directory only once neither is there
    await checking.catch(() => {})
    await repo.close()
  })
  watcher.setGitRepository(repo)
  let reports = 0
  watcher.setChangeCallback((paths) => {
    reports++
    repo.noteChanged(paths)
    checking = checking.then(() => repo.refreshSnapshot('noted'), () => {})
  })
  await watcher.startWatching(new AbortController().signal)
  await repo.refreshSnapshot()
  return {
    root, repo, watcher,
    reports: () => reports,
    /** What a repository that has read nothing says the checkout holds */
    truth: (): Promise<RepositorySnapshot> => new GitRepository(root).readSnapshot(),
    /** What the watched repository holds once the checks its reports started have run */
    held: async (): Promise<RepositorySnapshot> => { await checking; return repo.readSnapshot() },
  }
}

/** Every directory under `root` but git's own, relative to it, with `''` for the root itself */
export function directoriesOf(root: string): string[] {
  const found = ['']
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || (relative === '' && entry.name === '.git')) continue
      const child = path.join(relative, entry.name)
      found.push(child)
      walk(child)
    }
  }
  walk('')
  return found.sort()
}

/**
 * Tries `check` until it holds, and fails with what it last said when it has not held within `withinMs`. The
 * bound is on how long a watcher may take to catch up once the tree is quiet, which is what these cases are
 * about: one that never catches up fails with the difference rather than with a timeout.
 */
export async function catchesUp<T>(check: () => T | Promise<T>, withinMs = 30_000): Promise<T> {
  const until = Date.now() + withinMs
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() >= until) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    }
  }
}

/** The operations a churn makes on a tree, each one a thing a build, a checkout or a person does */
export function churn(root: string, random: ReturnType<typeof seeded>, operations: number): string[] {
  const made: string[] = []
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rig-outside-')))
  cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }))
  const name = (kind: string) => `${kind}-${made.length}`
  const directories = () => directoriesOf(root)
  const files = (directory: string) => fs.readdirSync(path.join(root, directory), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name))
  const kinds = ['write', 'write', 'edit', 'delete-file', 'make-deep', 'remove-directory', 'rename-directory', 'move-in', 'remake', 'copy-in'] as const
  for (let step = 0; step < operations; step++) {
    const kind = random.pick(kinds)
    const directory = random.pick(directories())
    const absolute = path.join(root, directory)
    try {
      if (kind === 'write') fs.writeFileSync(path.join(absolute, `${name('file')}.txt`), `${step}\n`)
      else if (kind === 'edit') {
        const existing = files(directory)
        if (existing.length > 0) fs.appendFileSync(path.join(root, random.pick(existing)), `${step}\n`)
      } else if (kind === 'delete-file') {
        const existing = files(directory)
        if (existing.length > 0) fs.rmSync(path.join(root, random.pick(existing)))
      } else if (kind === 'make-deep') {
        const deep = path.join(absolute, name('made'), 'b', 'c')
        fs.mkdirSync(deep, { recursive: true })
        fs.writeFileSync(path.join(deep, 'leaf.txt'), `${step}\n`)
      } else if (kind === 'remove-directory') {
        if (directory !== '') fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 })
      } else if (kind === 'rename-directory') {
        if (directory !== '') fs.renameSync(absolute, path.join(path.dirname(absolute), name('renamed')))
      } else if (kind === 'move-in') {
        const staged = path.join(outside, name('moved'))
        fs.mkdirSync(path.join(staged, 'inner'), { recursive: true })
        fs.writeFileSync(path.join(staged, 'inner', 'leaf.txt'), `${step}\n`)
        fs.renameSync(staged, path.join(absolute, path.basename(staged)))
      } else if (kind === 'remake') {
        if (directory !== '') {
          fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 })
          fs.mkdirSync(absolute)
          fs.writeFileSync(path.join(absolute, `${name('remade')}.txt`), `${step}\n`)
        }
      } else {
        const staged = path.join(outside, name('copied'))
        fs.mkdirSync(path.join(staged, 'inner'), { recursive: true })
        fs.writeFileSync(path.join(staged, 'inner', 'leaf.txt'), `${step}\n`)
        fs.cpSync(staged, path.join(absolute, path.basename(staged)), { recursive: true })
      }
      made.push(`${kind} ${directory || '.'}`)
    } catch (error) {
      // A directory picked may have gone under an earlier operation's rename: the next one picks afresh
      made.push(`${kind} ${directory || '.'} (${(error as NodeJS.ErrnoException).code ?? 'failed'})`)
    }
  }
  return made
}

/** Makes a file in every directory of the tree, which a watcher that follows the whole tree reports each of */
export function probeEveryDirectory(root: string, label: string): number {
  const directories = directoriesOf(root)
  for (const directory of directories) fs.writeFileSync(path.join(root, directory, `probe-${label}.txt`), `${label}\n`)
  return directories.length
}
