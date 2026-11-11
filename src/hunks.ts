// A file's change, cut into the pieces git calls hunks, each one a patch that can be applied by itself. Staging
// one piece of a file is `git apply --cached` of that piece: git made the patch and git reads it back, so what a
// line ending or a filter does to the file is git's to get right on both sides.
//
// **The patch is bytes, and is handled as bytes.** A file need not be UTF-8, and a patch decoded as text and
// encoded again stages what the file never held. It is read here as one character per byte (`latin1`), cut on
// line breaks, which are one byte in every encoding git diffs as text, and handed back to git the same way. A
// window is sent the piece as text to show, and an id to name it by: the bytes never leave this side.
import { createHash } from 'node:crypto'
import type { DiffHunk } from './types.ts'

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** What a patch's header says that makes the file more than plainly modified, where only the whole file is staged */
const NOT_PLAINLY_MODIFIED = /^(new file mode|deleted file mode|rename from|rename to|copy from|copy to|similarity index|old mode|new mode|Binary files|GIT binary patch)/m

/** A piece as a window is sent it, with the bytes git is handed to apply it: one character per byte */
export interface CutHunk extends DiffHunk {
  apply: string
}

/** Where a side's lines are in its file: a side with no lines is numbered by the line before it */
const position = (start: number, lines: number) => (lines === 0 ? start + 1 : start)
const startAt = (at: number, lines: number) => (lines === 0 ? at - 1 : at)

/**
 * The hunks of one file's patch as `git diff` printed it, read one character per byte, each with the patch that
 * applies it alone: to the index when staging, or in reverse to the index when `staged`, to take it back out.
 * Nothing for a file that was added, deleted, renamed or is binary, and nothing for a patch of more than one file.
 *
 * **A piece applied alone is numbered for the file it is applied to.** In the whole diff each piece's two line
 * numbers differ by what the pieces above it added or removed, and git begins looking for a piece at the number
 * of the side it is producing. Alone, none of the pieces above are applied, so that number is wrong by their
 * sum, and git settles on the nearest lines that match: another block that reads the same. So the side git
 * starts from is numbered from the side it is applied to, which is the index either way.
 *
 * **Its id names it by the side that stays put.** Staging another piece of the file moves the index and leaves
 * the working tree, so an unstaged piece is named by where it is in the working tree and what it holds; a staged
 * one by where it is in the last commit. A piece still on a window's screen after another was staged is then
 * the piece git cuts now, and one whose file changed under it is not.
 */
export function hunksOf(patch: string, staged = false): CutHunk[] {
  const lines = patch.split('\n')
  const first = lines.findIndex(line => HUNK.test(line))
  if (first < 0) return []
  const header = lines.slice(0, first)
  // No line of a hunk begins a line with these words: each begins with a space, a sign or a backslash
  if (lines.filter(line => line.startsWith('diff --git ')).length !== 1 || NOT_PLAINLY_MODIFIED.test(header.join('\n'))) return []
  // A patch ends with a line break, which leaves one empty string after the last line
  const body = lines.slice(first, lines.at(-1) === '' ? -1 : undefined)

  const hunks: CutHunk[] = []
  for (let at = 0; at < body.length;) {
    let end = at + 1
    while (end < body.length && !HUNK.test(body[end]!)) end++
    const [, oldStartText, oldLinesText, newStartText, newLinesText, section] = HUNK.exec(body[at]!)!
    const oldStart = Number(oldStartText), oldLines = Number(oldLinesText ?? 1)
    const newStart = Number(newStartText), newLines = Number(newLinesText ?? 1)
    const rows = body.slice(at + 1, end)
    const alone = staged
      ? `@@ -${startAt(position(newStart, newLines), oldLines)},${oldLines} +${newStart},${newLines} @@${section}`
      : `@@ -${oldStart},${oldLines} +${startAt(position(oldStart, oldLines), newLines)},${newLines} @@${section}`
    const apply = `${[...header, alone, ...rows].join('\n')}\n`
    const stays = staged ? `-${oldStart},${oldLines}` : `+${newStart},${newLines}`
    hunks.push({
      id: createHash('sha1').update(`${stays}\n${rows.join('\n')}`, 'latin1').digest('hex'),
      oldStart, oldLines, newStart, newLines,
      patch: Buffer.from(`${[...header, body[at]!, ...rows].join('\n')}\n`, 'latin1').toString('utf8'),
      apply,
    })
    at = end
  }
  return hunks
}
