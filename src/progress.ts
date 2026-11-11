// How far along a push, a pull, a fetch or a checkout is, read from what git prints while it works. Asked for
// progress, git writes lines such as `Writing objects:  42% (3/7)` to its error stream, each one over the last.
import type { GitProgress } from './types.ts'

/**
 * A line of progress: what git is doing, and how far through it is. A remote's own are prefixed with `remote: `.
 *
 * **Only the stages git itself names.** A remote's hook writes through the same stream under the same prefix, and
 * a line of its own shaped like these ("Coverage: 75% (300/400)") is the hook's reason, not progress: an unknown
 * stage is left in what is said of a failure and reported to nobody.
 */
const PROGRESS = /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Receiving objects|Resolving deltas|Unpacking objects|Indexing objects|Checking objects|Checking connectivity|Updating files|Checking out files|Filtering content):\s+(\d{1,3})% \((\d+)\/(\d+)\)/

/** The lines git writes around its progress that say nothing of a failure: a count that is done, and a summary */
const TRANSFER_NOTE = /^(?:remote: )?(?:Enumerating objects: \d+, done\.|Counting objects: \d+, done\.|Delta compression using up to \d+ threads|Total \d+ \(delta \d+\), reused \d+ \(delta \d+\).*)\s*$/

/**
 * Reads git's error stream as it arrives and reports each step forward: a stage, and the percent of it done.
 * Git repeats a line when a stage ends, and a chunk can end in the middle of one, so only whole lines are read
 * and only a change is reported.
 */
export function progressReader(report: (progress: GitProgress) => void): (chunk: string) => void {
  let partial = ''
  let last = ''
  return (chunk) => {
    const lines = (partial + chunk).split(/[\r\n]/)
    partial = lines.pop() ?? ''
    for (const line of lines) {
      const read = PROGRESS.exec(line)
      if (!read) continue
      const progress = { stage: read[1]!.trim(), percent: Math.min(100, Number(read[2])) }
      const key = `${progress.stage} ${progress.percent}`
      if (key === last) continue
      last = key
      report(progress)
    }
  }
}

/** What git printed to its error stream without the progress in it, which is what there is to say of a failure */
export function withoutProgress(printed: string): string {
  return printed.split(/[\r\n]/)
    .filter(line => line.trim() !== '' && !PROGRESS.test(line) && !TRANSFER_NOTE.test(line))
    .join('\n')
}
