/**
 * Waits for what a case expects of something that happens after the event loop has turned, such as a watcher
 * looking at the disk: `check` is tried until it stops throwing. Nothing is decided by how long that took, and
 * the suite's timeout is what ends a case whose check never holds.
 */
export function settles<T>(check: () => T | Promise<T>, { interval = 20 }: { interval?: number } = {}): Promise<T> {
  return new Promise<T>((resolve) => {
    const attempt = async (): Promise<void> => {
      try { resolve(await check()) } catch { setTimeout(() => { void attempt() }, interval).unref() }
    }
    void attempt()
  })
}
