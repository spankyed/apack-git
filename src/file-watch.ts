// A watch on one file, which goes on reporting when the file is replaced: git writes its index, HEAD and packed
// refs by writing a lock file beside them and renaming it over them, so the file at the path is another file
// after every write, and a watch is on the file it was opened on.
import * as fs from 'fs'

/** A file being followed, as whoever follows it holds it */
export interface FileFollower {
  close(): void
  /** Looks at the file now, and watches it if it has none: for a caller that knows it may have been made */
  look(): void
}

/** Follows the file at a path and calls `onChange` each time it differs: made, written, replaced or deleted */
export type FollowFile = (file: string, onChange: () => void) => FileFollower

/** The part of `fs.watch` a watch on one file uses */
export type WatchFile = (
  file: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }

/** Which file is at a path and how it looks, without reading it: `gone` when none is */
const lookOf = (file: string): Promise<string> =>
  fs.promises.stat(file).then(stats => `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}`, () => 'gone')

/**
 * Follows a file by its path. The watch is opened again after every event, since the event may be the file
 * being replaced, and the file is looked at again once the event loop has been round: a watch is not in place
 * when `watch` returns, and what changed before it was is reported by nothing.
 *
 * A file that is not there is not watched. Whoever watches its directory hears of it made, and says so here
 * (`look`), from which it is followed again.
 */
export const followFileWith = (watch: WatchFile = fs.watch): FollowFile => (file, onChange) => {
  let closed = false
  let watcher: ReturnType<WatchFile> | undefined
  let last: string | undefined
  /** One look at a time: a second asked for meanwhile is made once the first has answered */
  let looking = false
  let again: boolean | undefined

  const arm = () => {
    watcher?.close()
    watcher = undefined
    try {
      watcher = watch(file, { persistent: false }, () => { look(true) })
      // A watch that failed is opened again by the next look
      watcher.on('error', () => { look(true) })
    } catch {
      // Nothing there to watch
    }
    // Two turns, since the first of these runs before the loop next waits and the second after
    setImmediate(() => setImmediate(() => { look(false) }))
  }
  const look = (rearm: boolean) => {
    if (closed) return
    if (looking) {
      again = again || rearm
      return
    }
    looking = true
    void lookOf(file).then((now) => {
      looking = false
      if (closed) return
      const changed = last !== undefined && now !== last
      last = now
      if (changed) onChange()
      const next = again
      again = undefined
      // Changed, the file at the path may be another one, which the open watch is not on
      if (rearm || changed) arm()
      else if (next !== undefined) look(next)
    })
  }

  void lookOf(file).then((now) => {
    if (closed) return
    last = now
    arm()
  })
  return {
    close: () => {
      closed = true
      watcher?.close()
      watcher = undefined
    },
    // Watched again whether or not it differs: it may have been made, deleted and made again since the last look
    look: () => look(true),
  }
}

export const followFile: FollowFile = followFileWith()
