// The trailers at the end of a commit message — `Co-authored-by: …`, `Signed-off-by: …` — as git reads them, and a
// message without the ones a host names.
//
// **Git decides what a trailer is.** Its rule is not a pattern a line can be held to: the trailers are the last
// paragraph, never the subject, and a paragraph mixing trailers with prose counts only when one of them is git's
// own (`Signed-off-by`) or a key the repository configures, comments in it are skipped and an indented line
// continues the one before. So `git interpret-trailers --parse` names them, and the message's lines are matched
// to what it named rather than parsed a second way here.
import { failure, type GitRunner } from './runner.ts'
import type { Trailer } from './types.ts'

/** What `git interpret-trailers --parse` printed, one trailer a line, each `key: value` with its lines unfolded */
function parsed(printed: string): Trailer[] {
  return printed.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(':')
    return { key: line.slice(0, at), value: line.slice(at + 1).trim() }
  })
}

/** A trailer as git prints it, which is what the lines of one are unfolded and spaced to before they are compared */
const printedAs = ({ key, value }: Trailer) => `${key}: ${value}`

/**
 * The message's last paragraph as the entries git reads it in: each line, with the indented lines after it that
 * continue it. `start` is the index of the paragraph's first line; nothing when the message has none.
 */
function lastParagraph(lines: string[]): { start: number; end: number; entries: { first: number; count: number; trailer: Trailer | undefined }[] } | undefined {
  let end = lines.length - 1
  while (end >= 0 && !lines[end]!.trim()) end--
  if (end < 0) return undefined
  let start = end
  while (start > 0 && lines[start - 1]!.trim()) start--
  const entries: { first: number; count: number; trailer: Trailer | undefined }[] = []
  for (let at = start; at <= end; at++) {
    const continues = /^\s/.test(lines[at]!) && entries.length > 0
    if (continues) entries.at(-1)!.count++
    else entries.push({ first: at, count: 1, trailer: undefined })
  }
  for (const entry of entries) {
    const unfolded = lines.slice(entry.first, entry.first + entry.count).map(line => line.trim()).join(' ')
    const at = unfolded.indexOf(':')
    // A comment is never a trailer, and git skips it
    if (at > 0 && !unfolded.startsWith('#')) entry.trailer = { key: unfolded.slice(0, at).trim(), value: unfolded.slice(at + 1).trim() }
  }
  return { start, end, entries }
}

export class Trailers {
  constructor(private readonly runner: GitRunner) {}

  /**
   * The trailers git reads at the end of `message`, in order, each with its continued lines unfolded into its
   * value. None when its last paragraph is not trailers: a message of one paragraph has none, that being its subject.
   */
  async trailersIn(message: string): Promise<Trailer[]> {
    // `--no-divider`: a commit message is not a patch, so a line of `---` in it does not end it
    const result = await this.runner.read(['interpret-trailers', '--parse', '--no-divider'], { input: message })
    if (!result.success) throw failure(result, 'Failed to read the trailers of a message')
    return parsed(result.output ?? '')
  }

  /**
   * `message` without the trailers `remove` picks, each with the lines that continue it. Every other line is left
   * as it was written, and the blank lines that set the trailers apart go with them when none is left. A trailer git
   * reads under a separator other than `:` (`trailer.separators`) is not found in the message, and stays.
   */
  async withoutTrailers(message: string, remove: (trailer: Trailer) => boolean): Promise<string> {
    const trailers = await this.trailersIn(message)
    if (trailers.length === 0) return message
    const eol = message.includes('\r\n') ? '\r\n' : '\n'
    const lines = message.split(/\r?\n/)
    const paragraph = lastParagraph(lines)
    if (!paragraph) return message
    // Each of git's is matched once, so a line that only reads like a trailer in a paragraph git took as prose stays
    const unmatched = trailers.map(printedAs)
    const dropped = new Set<number>()
    for (const { first, count, trailer } of paragraph.entries) {
      if (!trailer) continue
      const at = unmatched.indexOf(printedAs(trailer))
      if (at === -1) continue
      unmatched.splice(at, 1)
      if (remove(trailer)) for (let line = first; line < first + count; line++) dropped.add(line)
    }
    if (dropped.size === 0) return message
    const kept = lines.slice(paragraph.start, paragraph.end + 1).filter((_, offset) => !dropped.has(paragraph.start + offset))
    const rest = [...lines.slice(0, paragraph.start), ...kept, ...lines.slice(paragraph.end + 1)].join(eol)
    // With no trailer left, the blank lines that set them apart end the message, and go
    return kept.length === 0 ? rest.trimEnd() : rest
  }
}
