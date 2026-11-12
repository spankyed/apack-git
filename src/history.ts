// History that can be drawn: commits with their parents, in pages, from a chosen set of refs, and one file's
// history across its renames.
//
// **A page continues from where the first one stood.** The first page reads where each ref points, and every later
// page walks from those same commits, so a ref that moves between pages neither repeats a commit nor drops one: the
// history a set of pages draws is the one that was there when the first was asked for. The cursor carries those
// commits and how many were read, and is the caller's to hand back as it was given.
import { recordsOf, refArgument } from './arguments.ts'
import { failure, type GitRunner } from './runner.ts'
import type { HistoryCommit, HistoryPage } from './types.ts'

/** How many commits a page holds when no number is asked for */
export const HISTORY_PAGE = 200

/** What a cursor carries: the commits the first page started from, and how many have been read from them */
interface Cursor { tips: string[]; read: number; path?: string }

const FIELDS = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D']

export class History {
  constructor(private readonly runner: GitRunner) {}

  /**
   * A page of one file's history from `tip`, where it is named `path`, followed across its renames. The next page
   * starts from the last commit's first parent, under the name the file had there: git follows a rename afresh on
   * each read, so a skip past one would lose it.
   */
  private async filePage(tip: string, path: string, limit: number): Promise<HistoryPage> {
    const result = await this.runner.executeGitCommand([
      'log', '-z', '--follow', '--name-status', `--format=%x1e${FIELDS.join('%x00')}%x00`, `-n${limit + 1}`, tip, '--', path,
    ])
    if (!result.success) throw failure(result, `Failed to read the history of ${path}`)
    // Each commit is its fields, then what it did to the file: `M`, `A` or `D` and the name, or `R…`/`C…` and both
    const read = (result.output ?? '').split('\x1e').filter(Boolean).map((record) => {
      const fields = record.split('\0')
      const commit = commitOf(fields.slice(0, FIELDS.length))
      // The first name is the one in the parent: where a rename or a copy came from, and otherwise the only one
      const [change = '', nameBefore = ''] = fields.slice(FIELDS.length + 1).map(field => field.trim())
      return { commit, added: change.startsWith('A'), nameBefore }
    }).filter(({ commit }) => commit.hash)
    const page = read.slice(0, limit)
    const last = page.at(-1)
    const parent = last?.commit.parents[0]
    if (read.length <= limit || !last || last.added || !parent) return { commits: page.map(({ commit }) => commit) }
    return { commits: page.map(({ commit }) => commit), cursor: encode({ tips: [parent], read: 0, path: last.nameBefore }) }
  }

  /** The commits these refs point at, each once, refusing a ref that names none */
  private async tipsOf(refs: string[]): Promise<string[]> {
    const resolved = await this.runner.executeGitCommand(['rev-parse', '--verify', '--end-of-options', ...refs.map(ref => `${refArgument(ref)}^{commit}`)])
    if (!resolved.success) throw failure(resolved, `Not every one of ${refs.join(', ')} names a commit here`)
    return [...new Set((resolved.output ?? '').split('\n').map(line => line.trim()).filter(Boolean))]
  }

  /**
   * A page of history: from `refs` (`HEAD` when none are named), newest first and never a commit before one that
   * descends from it, or from where `cursor` left off. With `path`, that file's history, followed across renames:
   * then only one ref is walked, since git follows a file down one line of history.
   */
  async page({ refs, cursor, path, limit = HISTORY_PAGE }: { refs?: string[]; cursor?: string; path?: string; limit?: number } = {}): Promise<HistoryPage> {
    // `HEAD` before the first commit names none, and that history is empty; a ref asked for by name must name one
    if (!cursor && !refs?.length && !(await this.runner.executeGitCommand(['rev-parse', '--verify', '--quiet', 'HEAD'])).success) return { commits: [] }
    const from: Cursor = cursor ? decode(cursor) : { tips: await this.tipsOf(refs?.length ? refs : ['HEAD']), read: 0, path }
    if (from.path !== undefined) return this.filePage(from.tips[0]!, from.path, limit)
    const args = ['log', '-z', '--topo-order', `--format=${FIELDS.join('%x00')}`, `--skip=${from.read}`, `-n${limit + 1}`, ...from.tips, '--']
    const result = await this.runner.executeGitCommand(args)
    if (!result.success) throw failure(result, 'Failed to read the history')
    const commits = historyRecords(result.output ?? '')
    // One more than a page was asked for, so that a page that ends the history says so without another read
    const more = commits.length > limit
    const page = commits.slice(0, limit)
    return more ? { commits: page, cursor: encode({ ...from, read: from.read + page.length }) } : { commits: page }
  }
}

/** `git log -z` with `FIELDS`: the commits it printed */
export function historyRecords(output: string): HistoryCommit[] {
  return recordsOf(output, FIELDS.length).map(commitOf).filter(commit => commit.hash)
}

/** A commit as git prints it with `FIELDS`: a history commit of those fields */
function commitOf([hash, parents, authorName, authorEmail, date, subject, refsHere]: string[]): HistoryCommit {
  return {
    hash: hash!.trim(),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName: authorName!,
    authorEmail: authorEmail!,
    date: date!,
    subject: subject!,
    refs: refsHere ? refsHere.split(', ').filter(Boolean) : [],
  }
}

const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url')

function decode(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    if (Array.isArray(parsed.tips) && parsed.tips.every(tip => /^[0-9a-f]{40,64}$/.test(tip)) && Number.isInteger(parsed.read) && parsed.read >= 0) {
      return { tips: parsed.tips, read: parsed.read, ...(typeof parsed.path === 'string' && { path: parsed.path }) }
    }
  } catch { /* said below */ }
  throw new Error(`Not a cursor this history gave: ${JSON.stringify(cursor)}`)
}
