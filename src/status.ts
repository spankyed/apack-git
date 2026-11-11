// A status as git prints it, read into a snapshot, and what tells one reading of a repository from the next
import { REPOSITORY_PARTS } from './types.ts'
import type { ConflictKind, GitStatusFile, RepositoryChange, RepositoryOperation, RepositoryPart, RepositorySnapshot } from './types.ts'

/** The most changed files a snapshot lists; past it the list is cut and says so */
export const STATUS_LIMIT = 10_000

/**
 * What each part of a repository looked like when it was read, to tell which of them a later read finds changed.
 * `files` is the same for each changed file on its own, to say which of them it was: a reading that failed has none.
 */
export type SnapshotIdentity = Record<RepositoryPart, string> & { files?: Map<string, string> }

/**
 * More changed files than this are not named in the news of a change. A window then reads again every diff it has
 * open, which is at most its tabs, so the bound is on what is sent to every window and not on what any of them does.
 */
const NAMED_FILES_LIMIT = 100

/** The files whose entry differs between two readings: nothing when a reading has none, or there are too many to name */
export function differingFiles(before: Map<string, string> | undefined, now: Map<string, string> | undefined): { files?: string[] } {
  if (!before || !now) return {}
  const files = [...now].filter(([file, entry]) => before.get(file) !== entry).map(([file]) => file)
  for (const file of before.keys()) if (!now.has(file)) files.push(file)
  return files.length > NAMED_FILES_LIMIT ? {} : { files }
}

export const partsAll = <T>(value: T) => Object.fromEntries(REPOSITORY_PARTS.map(part => [part, value])) as Record<RepositoryPart, T>

export const NOTHING_CHANGED: RepositoryChange = partsAll(false)
export const changedAnything = (change: RepositoryChange): boolean => REPOSITORY_PARTS.some(part => change[part])

/** What each pair of columns git gives an unmerged path says the two sides did to it */
const CONFLICTS: Record<string, ConflictKind> = {
  UU: 'both-modified', AA: 'both-added', DD: 'both-deleted',
  AU: 'added-by-us', UA: 'added-by-them', DU: 'deleted-by-us', UD: 'deleted-by-them',
}

/** A commit as a person would name it: a branch or a tag that is at it, where there is one, else the start of its name */
export function nameOfCommit(refs: string[], commit: string): string {
  for (const kind of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    const ref = refs.find(line => line.startsWith(`${commit} ${kind}`))
    if (ref) return ref.slice(commit.length + 1 + kind.length)
  }
  return commit.slice(0, 7)
}

export function statusOf(code: string): GitStatusFile['status'] {
  switch (code) {
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case '?': return 'untracked'
    case 'T': return 'typechange'
    case 'U': return 'unmerged'
    default: return 'modified'
  }
}

/** One changed path as `git status --porcelain=v2 -z` printed it */
export interface StatusEntry {
  path: string
  /** Where a renamed or copied path came from */
  originalPath?: string
  /** A tracked path's index and worktree columns, `.` where that side is unchanged; a conflict and an untracked path have none */
  columns?: string
  /** An unmerged path's two columns: what each side did to it */
  conflict?: string
  /** The record as printed, which names what the path holds in HEAD and in the index */
  record: string
}

/**
 * A snapshot as it was read: what a window is shown of it, what tells a later change from none, and the status it
 * was made from, which a later read of a few paths is put into
 */
export interface LoadedSnapshot {
  value: RepositorySnapshot
  identity: SnapshotIdentity
  headers: string[]
  entries: StatusEntry[]
  /**
   * How git lists untracked files: a folder it tracks nothing in as one row, unless the user told it to list every
   * file in such a folder, or to list none
   */
  untracked: 'normal' | 'all' | 'no'
  /** Whether git takes two spellings of a name that differ by case for one file, as a file system that does has it do */
  ignoreCase: boolean
  /** What git is in the middle of, which it says in its own directory and so changes only when that does */
  operation?: RepositoryOperation
}

/**
 * The most paths read on their own after a watcher names them. Git matches each against every file it tracks,
 * so the saving over a whole status shrinks as they grow, and past this many the whole status is read.
 */
export const NOTED_PATHS_LIMIT = 32

/** Files whose change can move the standing of any other: what is ignored, how content is compared, where a submodule is */
export const WHOLE_TREE_FILES = new Set(['.gitignore', '.gitattributes', '.gitmodules'])

/** The order git prints a status in: changed paths, then conflicts, then untracked ones, each by the bytes of its path */
export function inStatusOrder(entries: StatusEntry[]): StatusEntry[] {
  const rank = (entry: StatusEntry) => entry.record.startsWith('? ') ? 2 : entry.columns ? 0 : 1
  return entries
    .map(entry => ({ entry, rank: rank(entry), bytes: Buffer.from(entry.path) }))
    .sort((a, b) => a.rank - b.rank || Buffer.compare(a.bytes, b.bytes))
    .map(({ entry }) => entry)
}

/**
 * Two spellings of one path made the same, as far as the file system and git make them: letters composed on
 * macOS, whose file system does not tell the composed from the decomposed, and the letters A to Z in one case
 * where git ignores case, which are the only ones it folds
 */
export const pathFolding = (ignoreCase: boolean) => (filePath: string): string => {
  const composed = process.platform === 'darwin' ? filePath.normalize('NFC') : filePath
  return ignoreCase ? composed.replace(/[A-Z]+/g, upper => upper.toLowerCase()) : composed
}

/** The headers of `git status --porcelain=v2 -z` and its record for each changed path, in the order printed */
export function splitStatus(output: string): { headers: string[]; entries: StatusEntry[] } {
  const headers: string[] = []
  const entries: StatusEntry[] = []
  const records = output.split('\0')
  /** A record's path is everything after its fixed fields, since a path may hold spaces */
  const pathAfter = (record: string, fields: number): string => record.split(' ').slice(fields).join(' ')

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.startsWith('# ')) headers.push(record)
    else if (record.startsWith('? ')) entries.push({ path: record.slice(2), record })
    else if (record.startsWith('u ')) entries.push({ path: pathAfter(record, 10), conflict: record.slice(2, 4), record })
    else if (record.startsWith('1 ')) entries.push({ path: pathAfter(record, 8), columns: record.slice(2, 4), record })
    else if (record.startsWith('2 ')) {
      // A rename or copy is followed by the path it came from, as a record of its own
      const originalPath = records[++i]
      entries.push({ path: pathAfter(record, 9), originalPath, columns: record.slice(2, 4), record: `${record}\0${originalPath}` })
    }
  }
  return { headers, entries }
}

export function snapshotOf({ headers, entries }: { headers: string[]; entries: StatusEntry[] }): RepositorySnapshot {
  const snapshot: RepositorySnapshot = { files: [], truncated: false, branch: 'HEAD', hasUpstream: false, ahead: 0, behind: 0 }
  for (const header of headers) {
    if (header.startsWith('# branch.head ')) {
      const head = header.slice('# branch.head '.length)
      snapshot.branch = head === '(detached)' ? 'HEAD' : head
    } else if (header.startsWith('# branch.ab ')) {
      const [ahead, behind] = header.slice('# branch.ab '.length).split(' ')
      snapshot.hasUpstream = true
      snapshot.ahead = Math.abs(parseInt(ahead ?? '0', 10)) || 0
      snapshot.behind = Math.abs(parseInt(behind ?? '0', 10)) || 0
    }
  }
  for (const { path: filePath, originalPath, columns, conflict, record } of entries) {
    if (record.startsWith('? ')) {
      // A folder git tracks nothing in is one row, whatever it holds: git names it with a `/` at its end
      snapshot.files.push({ path: filePath, status: 'untracked', staged: false, ...(filePath.endsWith('/') && { isDirectory: true }) })
    } else if (!columns) {
      // A conflict fills both the index and the worktree column: one row, not committable until resolved
      snapshot.files.push({ path: filePath, status: 'unmerged', staged: false, conflict: CONFLICTS[conflict ?? ''] })
    } else {
      const [index, worktree] = [columns[0]!, columns[1]!]
      if (index !== '.') {
        snapshot.files.push({
          path: filePath, status: statusOf(index), staged: true,
          originalPath: index === 'R' || index === 'C' ? originalPath : undefined,
        })
      }
      if (worktree !== '.') snapshot.files.push({ path: filePath, status: statusOf(worktree), staged: false, originalPath: undefined })
    }
  }
  return snapshot
}

/** Reads `git status --porcelain=v2 --branch -z`: the branch headers and one record per changed path */
export function parseStatus(output: string): RepositorySnapshot {
  return snapshotOf(splitStatus(output))
}
