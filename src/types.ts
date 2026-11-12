// The shapes the engine answers in. Plain data, all of it: a snapshot and a change cross a host's bus to its
// windows, so nothing here has methods.

/** One changed path of a checkout, as a status lists it: once for what is staged of it and once for what is not */
export interface GitStatusFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'copied' | 'typechange' | 'unmerged'
  staged: boolean
  /** Where a renamed or copied path came from */
  originalPath?: string
  /** How alike a renamed or copied path is to where it came from, from 0 to 100 */
  score?: number
  /** For an unmerged file: what each side did to it, which is what there is to settle */
  conflict?: ConflictKind
  /** An untracked folder, listed as one row: git tracks nothing in it. Its path ends with `/` */
  isDirectory?: boolean
  /**
   * For a submodule's row, how it differs, as git says in its parent's status: it is on another commit, files it
   * tracks changed, or it has files it does not track. Each is news of the submodule's own status as well
   */
  submodule?: { commit: boolean; modified: boolean; untracked: boolean }
}

/** A repository found under a folder (`GitRepository.repositoriesUnder`) */
export interface FoundRepository {
  /** Its working tree, as a path on this machine */
  path: string
  /** From the folder: the folder's own (empty), or the folder it is in */
  relative: string
  /**
   * `top`: the folder's own, or the repository it is in. `nested`: a repository of its own inside another's tree.
   * `submodule`: one its parent records as one. `worktree`: a linked worktree of another
   */
  kind: 'top' | 'nested' | 'submodule' | 'worktree'
}

/** How many lines a changed file adds and removes, as git counts them; none for a file that is not text */
export interface LineCount {
  path: string
  added: number
  removed: number
  /** Not text, so git counts no lines in it */
  binary: boolean
}

/** A file a commit or a stash changed, with its count */
export interface ChangedFile extends LineCount {
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange'
  /** Where a renamed or copied file came from */
  originalPath?: string
}

/**
 * How the two sides being brought together disagree about a file. `us` is the side the checkout was on and
 * `them` the one coming in, as git names them.
 */
export const CONFLICT_KINDS = ['both-modified', 'both-added', 'both-deleted', 'added-by-us', 'added-by-them', 'deleted-by-us', 'deleted-by-them'] as const
export type ConflictKind = (typeof CONFLICT_KINDS)[number]

/**
 * The three sides of a conflicted file, read from the index: the version both started from, ours and theirs, each
 * absent where that side has no such file. Beside them the working file, and where git marked the conflicts in it.
 */
export interface ConflictSides {
  base: string | null
  ours: string | null
  theirs: string | null
  /** The file as it is in the working tree, with git's markers in it; absent when it is not there */
  working: string | null
  /** Each conflict git marked in the working file, by line from 1: where it opens, where ours ends, where it closes */
  regions: { start: number; separator: number; end: number }[]
  /** Whether any side holds a byte that is not text, in which case the sides are not read as text and are empty */
  binary: boolean
}

/** What a conflicted file is resolved with: one side as it is, or content written in its place */
export type ConflictAnswer = 'ours' | 'theirs' | { content: string }

/** What git can be in the middle of in a checkout, each of which ends when it is carried on with or given up */
export const OPERATION_KINDS = ['merge', 'rebase', 'cherry-pick', 'revert'] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

/** What git is in the middle of in a checkout */
export interface RepositoryOperation {
  kind: OperationKind
  /** What is merged in, rebased onto, picked or reverted, as a person would name it: a branch where one is known, else a short commit */
  subject: string
  /** The branch a rebase is replaying, where it is replaying one */
  branch?: string
  /** A rebase's place among the commits it replays, counted from one */
  step?: number
  steps?: number
}

/** What can be done with what git is in the middle of: carry on once its conflicts are settled, leave out the commit a rebase stopped at, or give it up */
export const OPERATION_MOVES = ['continue', 'skip', 'abort'] as const
export type OperationMove = (typeof OPERATION_MOVES)[number]

/**
 * The parts of a repository, each read and refreshed on its own: its changed files with the branch and its
 * distance from upstream; the two sides of each changed file, which a diff of it shows; which branch is checked
 * out, the commit it is on and every branch and tag, which a log is read from; its stashes; its worktrees.
 */
export const REPOSITORY_PARTS = ['status', 'diffs', 'history', 'stashes', 'worktrees', 'refs'] as const
export type RepositoryPart = (typeof REPOSITORY_PARTS)[number]

/** Which parts of a repository differ from when it was last checked */
export type RepositoryChange = Record<RepositoryPart, boolean> & {
  /** The changed files whose diff differs, when they are few enough to name: without it, any of them may */
  files?: string[]
}

/** A branch, local or a remote's, with what it follows and how far from it it is */
export interface BranchStanding {
  /** As git names it short: `main`, `origin/main` */
  name: string
  /** `refs/heads/main`, `refs/remotes/origin/main` */
  ref: string
  remote: boolean
  commit: string
  /** Whether it is the branch checked out here */
  current: boolean
  /** The branch it follows, short, for a local branch that follows one */
  upstream?: string
  /** Whether that branch is gone from the remote's last fetched refs */
  upstreamGone?: boolean
  /** Commits it has that its upstream does not, and the other way round: 0 without an upstream */
  ahead: number
  behind: number
}

/** A repository's branches, remotes and tags, as one model */
export interface RefsModel {
  branches: BranchStanding[]
  /** Each remote with where it fetches from and pushes to, which are the same unless told otherwise */
  remotes: { name: string; fetchUrl: string; pushUrl: string }[]
  tags: { name: string; commit: string }[]
}

/** A checkout's changed files, branch and distance from its upstream, read in one pass */
export interface RepositorySnapshot {
  files: GitStatusFile[]
  /** Whether there are more changed files than `files` lists */
  truncated: boolean
  /** The branch checked out, or `HEAD` when none is */
  branch: string
  /** Whether the branch tracks a remote branch that exists */
  hasUpstream: boolean
  ahead: number
  behind: number
  /**
   * Whether git has a name and an email to write a commit with, from its settings or the environment. Without them
   * a commit is refused, asking who the user is
   */
  hasIdentity: boolean
  /** What git is in the middle of here, when it is in the middle of anything */
  operation?: RepositoryOperation
}

/** How far along git is with a command that talks to a remote or writes many files */
export interface GitProgress {
  /** What git is doing, in its own words: `Writing objects`, `Receiving objects`, `Updating files` */
  stage: string
  /** How much of that is done, from 0 to 100 */
  percent: number
}

/** One piece of a file's change, as git cuts it */
export interface DiffHunk {
  /** What names this piece when it is staged or unstaged: the same for as long as git cuts the same piece */
  id: string
  /** Where it begins on the left side of the diff, and how many lines of that side it covers */
  oldStart: number
  oldLines: number
  /** The same on the right side */
  newStart: number
  newLines: number
  /** The piece as text, to show: its header and its lines. Git is handed the piece by its `id`, never this */
  patch: string
}

export interface StashEntry {
  index: number
  ref: string
  message: string
  date: string
}

export interface WorktreeEntry {
  path: string
  head: string
  branch: string
  isBare: boolean
  isCurrent: boolean
  isMain: boolean
  isLocked: boolean
  lockedReason?: string
}

/** A commit as a history draws it: with every parent, and the refs that point at it */
export interface HistoryCommit {
  hash: string
  /** Its parents, first first: none for a first commit, two or more for a merge */
  parents: string[]
  authorName: string
  authorEmail: string
  /** When it was written, as ISO 8601 */
  date: string
  subject: string
  /** The refs that point at it, as git decorates it: `HEAD -> main`, `origin/main`, `tag: v1` */
  refs: string[]
}

/** One page of a history (`GitRepository.history`) */
export interface HistoryPage {
  commits: HistoryCommit[]
  /** Hands back to `history` for the next page; absent when this page ends the history */
  cursor?: string
}

/** Who last changed one line of a file, as `git blame` answers it */
export interface BlameLine {
  /** The line, from 1, in the file as it was asked for */
  line: number
  commit: string
  author: string
  authorEmail: string
  /** When the commit was written, as ISO 8601 */
  date: string
  summary: string
  /** Where the line was in the file as that commit had it, and what the file was called there */
  originalLine: number
  originalPath: string
}
/**
 * What merging a branch into what is checked out would do: nothing, a fast-forward, a merge that goes through, or
 * one that stops on conflicts in `files` (paths from the top of the checkout). `unknown` on a git that cannot say
 */
export type MergePreview =
  | { kind: 'up-to-date' | 'fast-forward' | 'clean' | 'unknown' }
  | { kind: 'conflicts'; files: string[] }

export interface CommitLogEntry {
  hash: string
  shortHash: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  date: string
  refs: string
}

/** What a discard kept of what it removed */
export interface DiscardKept {
  /** Names what was kept, for `restoreDiscarded`. Absent when nothing was: every file was too large, or there was none */
  id?: string
  /** The paths removed without a copy, each larger than a discard keeps: from the top of the checkout */
  notKept: string[]
}

/** A copy of the working tree, kept outside the repository (`GitRepository.checkpoint`) */
export interface Checkpoint {
  /** Names it, for `changedSince` and `restoreCheckpoint` */
  id: string
  /** The paths left out, each larger than a checkpoint keeps: from the top of the checkout */
  notKept: string[]
}

/** A file that differs from a checkpoint, by path from the top of the checkout */
export interface CheckpointChange {
  path: string
  /** `added`: there now and not in the checkpoint. `deleted`: in the checkpoint and not there now */
  change: 'added' | 'modified' | 'deleted'
}

/** A write the engine made that can be taken back (`GitRepository.undo`) */
export interface JournalEntry {
  id: string
  /** What was done */
  operation: 'commit' | 'reset' | 'delete-branch' | 'drop-stash' | 'clear-stashes' | 'merge' | 'rebase' | 'cherry-pick'
  /** When, in milliseconds since the epoch */
  at: number
  /** What it was, in a few words: `commit "Fix the parser"`, `deleting branch topic` */
  summary: string
  /** Each ref it moved, where it was and where it was left: `null` for no such ref */
  refs: { ref: string; before: string | null; after: string | null }[]
  /** Settings it removed with what it removed, as `[key, value]`: a deleted branch's upstream */
  config?: [string, string][]
  /** Stashes it removed, newest first */
  stashes?: { commit: string; message: string }[]
  /** The checkpoint taken before it, of the whole working tree */
  checkpoint?: string
}

/** What putting a discard back did, by path from the top of the checkout */
export interface DiscardRestored {
  restored: string[]
  /** Changed or made again since the discard, and left as they are */
  left: string[]
}

/** Where a checkout's git state lives, and where the working directory is in it */
export interface GitDirectories {
  gitDir: string
  commonDir: string
  /** The working directory's path from the top of the checkout, ending in `/`: empty when it is the top */
  prefix: string
}
