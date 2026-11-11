import * as fs from 'fs'
import * as path from 'path'

/** Where under a watched directory something changed, relative to it; `null` when the platform could not say */
export type WatchedChange = string | null

/** A watch over a tree, as whoever opened it holds it */
export interface DirectorySubscription {
  unsubscribe(): Promise<void>
  /**
   * Brings the watch in line with the tree as it is now and with the directories to ignore as they are now,
   * without closing it: for a caller that knows the tree may have moved under it, or that events may have been
   * lost. A subscription without one is closed and opened again instead.
   */
  check?(options: { ignore: string[] }): Promise<void>
}

/**
 * Watches a directory and everything under it, apart from the directories `ignore` names relative to it.
 * An error means the watch has stopped reporting, or may have.
 */
export type SubscribeToDirectory = (
  directory: string,
  onChanges: (error: Error | null, changes: WatchedChange[]) => void,
  options: { ignore: string[] },
) => Promise<DirectorySubscription>

/** The part of `fs.watch` a watch over a tree uses */
export type WatchTree = (
  directory: string,
  options: { recursive: true; persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }

/** The part of `fs.watch` a watch on one directory uses */
export type WatchDirectory = (
  directory: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }

/** Whether a path is one of these directories or under one, each named relative to the same root as the path */
function under(directories: string[]): (relativePath: string) => boolean {
  const named = new Set(directories.map(directory => path.normalize(directory)))
  return (relativePath) => {
    for (let end = relativePath.indexOf(path.sep); end !== -1; end = relativePath.indexOf(path.sep, end + 1)) {
      if (named.has(relativePath.slice(0, end))) return true
    }
    return named.has(relativePath)
  }
}

/**
 * Node's own recursive watch. The platform reports every change under the directory, so the ignored ones are
 * dropped here; a change to the watched directory itself arrives under that directory's own name. Deleting
 * the directory does not end the watch on macOS, where one made again at the path is reported on, and is an
 * error on Windows.
 */
export const nodeSubscriber = (watch: WatchTree = fs.watch): SubscribeToDirectory => async (directory, onChanges, { ignore }) => {
  let ignored = under(ignore)
  // Never the reason a process stays alive: whoever opened the watch closes it
  const watcher = watch(directory, { recursive: true, persistent: false }, (_eventType, filename) => {
    if (filename === null) onChanges(null, [null])
    else if (!ignored(filename)) onChanges(null, [filename])
  })
  watcher.on('error', error => onChanges(error, []))
  return {
    unsubscribe: async () => watcher.close(),
    // The platform's one watch covers whatever the tree holds, and what is ignored is dropped here: nothing to
    // reopen. Closing and opening it again would lose what the platform had not yet delivered
    check: async (options) => { ignored = under(options.ignore) },
  }
}

/**
 * A watch on every directory of a tree, one each, for a platform that has no watch over a tree.
 *
 * A directory is watched and then read, in that order, so what is made in it meanwhile is either reported by
 * its watch or found by the reading. One that appears later is watched the same way, and reported once more
 * when its watches are in place: what was made in it before then was reported by nothing, and whoever hears a
 * directory changed asks about everything under it. One that goes has its watches closed with it, and the
 * watched directory itself going is an error, since nothing reports on one made again at its path.
 *
 * **A watch is on the directory that was at a path when it was opened, not on the path.** A directory deleted
 * and made again at once (`rm -rf dist && mkdir dist`) is another directory under the same name, and the watch
 * on the first reports nothing of it. So each watch is held with which directory it is on, and a path that is
 * found to hold another is watched again.
 *
 * The platform's limit on watches is reached one directory at a time. Running out while the tree is first
 * read fails the subscription, and running out later is reported as an error: either way the tree is not all
 * watched, and whoever opened the watch is told so rather than left with part of one.
 */
export const perDirectorySubscriber = (watch: WatchDirectory = fs.watch): SubscribeToDirectory => async (directory, onChanges, { ignore }) => {
  let ignored = under(ignore)
  /**
   * The open watches, by the directory each is on, relative to the watched one: `''` is the watched one itself.
   * `identity` says which directory that was when the watch was opened
   */
  const watches = new Map<string, { close(): void; identity: string | undefined }>()
  /** The directories whose watch is being opened, so that two reports of one directory open one watch */
  const opening = new Set<string>()
  let closed = false
  /**
   * Which directory is at a path: another one made under the same name is a different one. By when it was made
   * as well as by its number, since a file system hands the number of a directory just deleted to the next one
   * made, which is the one made again at its path
   */
  const identityOf = (stats: fs.BigIntStats): string => `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`
  const identityAt = (absolute: string) => fs.promises.stat(absolute, { bigint: true }).then(identityOf, () => undefined)

  const close = () => {
    closed = true
    for (const watcher of watches.values()) watcher.close()
    watches.clear()
  }
  /** Lets go of a directory's watch and of every watch under it */
  const drop = (relative: string) => {
    for (const [watched, watcher] of watches) {
      if (watched !== relative && !watched.startsWith(relative + path.sep)) continue
      watcher.close()
      watches.delete(watched)
    }
  }

  const add = async (relative: string): Promise<void> => {
    if (closed || watches.has(relative) || opening.has(relative) || (relative !== '' && ignored(relative))) return
    const absolute = path.join(directory, relative)
    opening.add(relative)
    try {
      // The watch is opened between two looks at which directory is there. When they differ it was replaced
      // while the watch was being opened, and which of the two the watch is on is not known: it is opened again
      for (let attempt = 0; ; attempt++) {
        const before = await identityAt(absolute)
        if (closed) return
        let watcher: ReturnType<WatchDirectory>
        try {
          watcher = watch(absolute, { persistent: false }, (eventType, filename) => { void changed(relative, eventType, filename) })
        } catch (error) {
          // Gone between being listed and being watched: nothing is there to report on
          const code = (error as NodeJS.ErrnoException).code
          if (relative !== '' && (code === 'ENOENT' || code === 'ENOTDIR')) return
          throw error
        }
        watcher.on('error', (error) => {
          if (relative === '') onChanges(error, [])
          else drop(relative)
        })
        const after = await identityAt(absolute)
        if (closed) return watcher.close()
        // Replaced three times over while being watched, it is being rewritten faster than it can be followed:
        // the last watch is kept, and what is made there is reported by its parent's
        if (before === after || attempt === 2) {
          watches.set(relative, { close: () => watcher.close(), identity: after })
          break
        }
        watcher.close()
      }
    } finally {
      opening.delete(relative)
    }
    const entries = await fs.promises.readdir(absolute, { withFileTypes: true }).catch((): fs.Dirent[] => [])
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => add(path.join(relative, entry.name))))
  }

  const changed = async (relative: string, eventType: string, filename: string | null): Promise<void> => {
    if (closed) return
    if (filename === null) return onChanges(null, [null])
    const where = path.join(relative, filename)
    if (ignored(where)) return
    onChanges(null, [where])
    // Only a path made, deleted or moved can be a directory that came or went
    if (eventType !== 'rename') return
    const found = await fs.promises.lstat(path.join(directory, where), { bigint: true }).catch(() => undefined)
    if (closed) return
    if (!found) {
      drop(where)
      // The platform reports the watched directory's own deletion to it under its own name
      if (relative === '' && !await fs.promises.lstat(directory).then(() => true, () => false) && !closed) onChanges(new Error(`${directory} was deleted`), [])
      return
    }
    // A file where a watched directory was: that directory is gone
    if (!found.isDirectory()) return drop(where)
    const held = watches.get(where)
    if (held) {
      // Still the directory its watch is on. Another one under the same name is watched in its place
      if (held.identity === identityOf(found)) return
      drop(where)
    }
    // Another report of the same directory is opening its watch, and reports it once that is in place
    if (opening.has(where)) return
    try {
      await add(where)
    } catch (error) {
      if (!closed) onChanges(error instanceof Error ? error : new Error(String(error)), [])
      return
    }
    if (!closed) onChanges(null, [where])
  }

  /**
   * Walks the tree as it is now and holds a watch on every directory of it that is not ignored, and on no
   * other. The kernel drops events when its queue is full and says so to nobody here, so a directory made
   * then has no watch: this is what finds it. A directory watched here, or found to be another one than its
   * watch is on, is reported, since what was made in it meanwhile was reported by nothing.
   */
  const reconcile = async (): Promise<void> => {
    const found = new Set<string>([''])
    const walk = async (relative: string): Promise<void> => {
      const entries = await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true }).catch((): fs.Dirent[] => [])
      await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
        const child = path.join(relative, entry.name)
        if (closed || ignored(child)) return
        found.add(child)
        const held = watches.get(child)
        if (held && held.identity === await identityAt(path.join(directory, child))) return walk(child)
        if (held) drop(child)
        await add(child)
        // Everything under it was watched by `add`, and may hold what nothing reported
        for (const watched of watches.keys()) if (watched === child || watched.startsWith(child + path.sep)) found.add(watched)
        if (!closed) onChanges(null, [child])
      }))
    }
    await walk('')
    for (const watched of [...watches.keys()]) if (!found.has(watched)) drop(watched)
  }

  try {
    await add('')
  } catch (error) {
    close()
    throw error
  }
  return {
    unsubscribe: async () => close(),
    check: async (options) => {
      if (closed) return
      ignored = under(options.ignore)
      try {
        await reconcile()
      } catch (error) {
        if (!closed) onChanges(error instanceof Error ? error : new Error(String(error)), [])
      }
    },
  }
}

/**
 * The platform's watcher for a whole tree.
 *
 * macOS and Windows watch a tree natively, and Node's `fs.watch` is that watch. Linux has no watch over a
 * tree, and Node's recursive watch there holds one per file and reads the whole tree before it returns: a
 * watch is held on each directory that is not ignored instead (`perDirectorySubscriber`).
 *
 * **No native watcher library is loaded, on any platform.** `@parcel/watcher` was measured on all three: its
 * macOS backend releases its event stream from two threads when a watched directory is deleted as its watch
 * closes, its Windows one frees a subscription the kernel still writes to (parcel-bundler/watcher#271, #262),
 * either of which corrupts the heap of the process that holds the user's database, and its Linux one refuses to
 * close a watch whose directory was deleted moments before and leaves inotify watches with the process. Before
 * moving a platform onto a library, close a watch as its directory is deleted, a few hundred times over, and
 * see that the process survives and holds no watch afterwards.
 */
export const subscribeToDirectory: SubscribeToDirectory =
  process.platform === 'darwin' || process.platform === 'win32' ? nodeSubscriber() : perDirectorySubscriber()
