// Removing what a case made, once nothing of the case's is left in it.
import * as fs from 'node:fs'

/**
 * Removes a directory and everything in it, trying again while the system refuses: Windows refuses for the
 * moments a virus scanner or an indexer has a file in it open. The promise form is used because its retries
 * wait what they are told to. The synchronous one's wait a thousandth of it (`Sleep(i * retryDelay / 1000)` in
 * Node's `RmSync`), so eighty of them at 100 ms are over in a third of a second.
 *
 * Each retry waits 50 ms longer than the last, ten seconds in all. A directory still refused then has a process
 * in it that a case left running, which is the case's to end.
 */
export const removeDirectory = (directory: string): Promise<void> =>
  fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })

const REFUSED_FOR_NOW = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

/**
 * The same, without giving the event loop a turn: for a case whose point is what else happens at the moment a
 * directory is deleted, which a removal that waited would move. It tries again while the system refuses, each
 * time 10 ms longer than the last and two seconds in all, and this thread sleeps between tries, so nothing
 * that needs the loop to let go of the directory can let go of it meanwhile.
 */
export function removeDirectoryNow(directory: string): void {
  const asleep = new Int32Array(new SharedArrayBuffer(4))
  for (let tries = 1; ; tries++) {
    try {
      return fs.rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      if (tries > 20 || !REFUSED_FOR_NOW.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      Atomics.wait(asleep, 0, 0, tries * 10)
    }
  }
}
