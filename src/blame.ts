// Who last changed each line of a file, as `git blame` answers it, handed on in pieces as git finds them: a long
// file's lines arrive while git is still walking back through history. The commits a repository lists to be left
// out of blame (`.git-blame-ignore-revs`, or the file `blame.ignoreRevsFile` names) are left out, as git leaves them
// out, and their lines go to the commit before.
import * as path from 'path'
import * as fs from 'fs/promises'
import { refArgument } from './arguments.js'
import type { RepositoryModel } from './model.js'
import { failure, type GitRunner } from './runner.js'
import type { BlameLine } from './types.js'

/** The file a repository lists commits in for blame to leave out, by the name GitHub and others read it at */
const IGNORE_FILE = '.git-blame-ignore-revs'

/** What `--incremental` says of a commit the first time it names it */
interface Described { author: string; authorEmail: string; date: string; summary: string }

/**
 * Reads `git blame --incremental` as it arrives: for each group of lines a header (`commit originalLine finalLine
 * count`), what is known of the commit the first time it is named, and `filename` last. Lines from 1.
 */
export class IncrementalBlame {
  private pending = ''
  private header: { commit: string; original: number; final: number; count: number } | undefined
  private fields: Partial<Described> = {}
  private readonly described = new Map<string, Described>()
  readonly lines: BlameLine[] = []

  constructor(private readonly onLines?: (lines: BlameLine[]) => void) {}

  take(chunk: string): void {
    this.pending += chunk
    let start = 0
    let end: number
    while ((end = this.pending.indexOf('\n', start)) >= 0) {
      this.line(this.pending.slice(start, end))
      start = end + 1
    }
    if (start > 0) this.pending = this.pending.slice(start)
  }

  private line(line: string): void {
    if (!this.header) {
      const [commit, original, final, count] = line.split(' ')
      const origNum = Number(original)
      const finalNum = Number(final)
      const countNum = Number(count)
      if (commit && count && Number.isInteger(origNum) && Number.isInteger(finalNum) && Number.isInteger(countNum) && countNum > 0) {
        this.header = { commit, original: origNum, final: finalNum, count: countNum }
      }
      return
    }
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'author') this.fields.author = value
    else if (key === 'author-mail') this.fields.authorEmail = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') {
      const ms = Number(value) * 1000
      const date = Number.isFinite(ms) ? new Date(ms) : undefined
      this.fields.date = date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
    }
    else if (key === 'summary') this.fields.summary = value
    else if (key === 'filename') this.close(value)
  }

  /** Ends a group at its `filename`, and hands its lines on */
  private close(originalPath: string): void {
    const { commit, original, final, count } = this.header!
    if (!this.described.has(commit)) this.described.set(commit, { author: '', authorEmail: '', date: '', summary: '', ...this.fields })
    const about = this.described.get(commit)!
    const group = Array.from({ length: count }, (_, at) => ({
      line: final + at, originalLine: original + at, originalPath, commit, ...about,
    }))
    this.lines.push(...group)
    this.onLines?.(group)
    this.header = undefined
    this.fields = {}
  }
}

export class Blame {
  constructor(private readonly runner: GitRunner, private readonly model: RepositoryModel) {}

  /**
   * Who last changed each line of a file, at `revision` (the working tree's file when none is named), in line order.
   * `onLines` is handed each group as git finds it, in the order git finds them. The path is from the top of the
   * checkout.
   */
  async blame(filePath: string, { revision, onLines, signal }: { revision?: string; onLines?: (lines: BlameLine[]) => void; signal?: AbortSignal } = {}): Promise<BlameLine[]> {
    const top = await this.model.checkoutTop()
    // Reuse held settings to avoid an extra `git config` spawn on every blame
    const settings = await this.runner.settings.read()
    const configured = settings.value('blame.ignorerevsfile')?.trim()
    const ignoring = !configured && await fs.access(path.join(top, IGNORE_FILE)).then(() => true, () => false)
    const reader = new IncrementalBlame(onLines)
    const result = await this.runner.read([
      '-c', 'core.quotepath=false', '-C', top, 'blame', '--incremental', ...(ignoring ? ['--ignore-revs-file', IGNORE_FILE] : []),
      ...(revision ? [refArgument(revision, 'revision')] : []), '--', filePath,
    ], { onOutput: chunk => reader.take(chunk), signal })
    if (!result.success) throw failure(result, `Failed to read who changed ${filePath}`)
    return [...reader.lines].sort((a, b) => a.line - b.line)
  }
}
