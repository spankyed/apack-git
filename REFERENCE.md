# Reference

Generated from the source by `npm run reference:update`; `npm run reference:check` holds it to the source.

## `apack-git`

### `BlameLine`

Who last changed one line of a file, as `git blame` answers it

```ts
interface BlameLine {
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
```

### `BranchStanding`

A branch, local or a remote's, with what it follows and how far from it it is

```ts
interface BranchStanding {
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
```

### `changedAnything`

```ts
changedAnything(change: RepositoryChange): boolean
```

### `ChangedFile`

A file a commit or a stash changed, with its count

```ts
interface ChangedFile extends LineCount {
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange'
  /** Where a renamed or copied file came from */
  originalPath?: string
}
```

### `ChangedPaths`

What a report says changed: paths in the working tree, relative to the working directory with `/` between
their parts, when nothing else changed and they are few enough to name; `null` when anything may have.

```ts
type ChangedPaths = string[] | null
```

### `Checkpoint`

A copy of the working tree, kept outside the repository (`GitRepository.checkpoint`)

```ts
interface Checkpoint {
  /** Names it, for `changedSince` and `restoreCheckpoint` */
  id: string
  /** The paths left out, each larger than a checkpoint keeps: from the top of the checkout */
  notKept: string[]
}
```

### `CheckpointChange`

A file that differs from a checkpoint, by path from the top of the checkout

```ts
interface CheckpointChange {
  path: string
  /** `added`: there now and not in the checkpoint. `deleted`: in the checkpoint and not there now */
  change: 'added' | 'modified' | 'deleted'
}
```

### `classifyGitError`

Why git failed, from everything it printed; nothing when it does not say, or says something not known here

```ts
classifyGitError(printed: string): GitErrorCode | undefined
```

### `CommitLogEntry`

```ts
interface CommitLogEntry {
  hash: string
  shortHash: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  date: string
  refs: string
}
```

### `ConflictAnswer`

What a conflicted file is resolved with: one side as it is, or content written in its place

```ts
type ConflictAnswer = 'ours' | 'theirs' | { content: string }
```

### `ConflictKind`

```ts
type ConflictKind = (typeof CONFLICT_KINDS)[number]
```

### `ConflictSides`

The three sides of a conflicted file, read from the index: the version both started from, ours and theirs, each
absent where that side has no such file. Beside them the working file, and where git marked the conflicts in it.

```ts
interface ConflictSides {
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
```

### `DiffHunk`

One piece of a file's change, as git cuts it

```ts
interface DiffHunk {
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
```

### `DirectorySubscription`

A watch over a tree, as whoever opened it holds it

```ts
interface DirectorySubscription {
  unsubscribe(): Promise<void>
  /**
   * Brings the watch in line with the tree as it is now and with the directories to ignore as they are now,
   * without closing it: for a caller that knows the tree may have moved under it, or that events may have been
   * lost. A subscription without one is closed and opened again instead.
   */
  check?(options: { ignore: string[] }): Promise<void>
}
```

### `DiscardKept`

What a discard kept of what it removed

```ts
interface DiscardKept {
  /** Names what was kept, for `restoreDiscarded`. Absent when nothing was: every file was too large, or there was none */
  id?: string
  /** The paths removed without a copy, each larger than a discard keeps: from the top of the checkout */
  notKept: string[]
}
```

### `DiscardRestored`

What putting a discard back did, by path from the top of the checkout

```ts
interface DiscardRestored {
  restored: string[]
  /** Changed or made again since the discard, and left as they are */
  left: string[]
}
```

### `FileFollower`

A file being followed, as whoever follows it holds it

```ts
interface FileFollower {
  close(): void
  /** Looks at the file now, and watches it if it has none: for a caller that knows it may have been made */
  look(): void
}
```

### `followFile`

```ts
followFile(file: string, onChange: () => void): FileFollower
```

### `FollowFile`

Follows the file at a path and calls `onChange` each time it differs: made, written, replaced or deleted

```ts
type FollowFile = (file: string, onChange: () => void) => FileFollower
```

### `FoundRepository`

A repository found under a folder (`GitRepository.repositoriesUnder`)

```ts
interface FoundRepository {
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
```

### `GIT_FLOOR`

The oldest git the engine works with: the oldest the suite passes on in CI (`.github/workflows/ci.yml`, the `git`
jobs), which run it against the oldest git still-supported systems ship (Debian 12's and macOS's own, 2.39.5) and
against this floor, built. Ubuntu 22.04's 2.34.1 is below it: its `status --porcelain=v2 --show-stash` gives no
count of the stashes, which git 2.35 added, so a stash dropped below the newest goes unseen.

```ts
GIT_FLOOR: "2.35.0"
```

### `GitDirectories`

Where a checkout's git state lives, and where the working directory is in it

```ts
interface GitDirectories {
  gitDir: string
  commonDir: string
  /** The working directory's path from the top of the checkout, ending in `/`: empty when it is the top */
  prefix: string
}
```

### `GitError`

A git command that failed, with why where git said

- `code: "locked" | "authentication" | "permission" | "remote-unreachable" | "non-fast-forward" | "diverged" | "conflict" | "local-changes" | "unknown-ref" | "not-a-repository" | "unsafe-ownership" | "signing-failed" | "unrelated-histories" | "nothing-to-commit" | "branch-exists" | "host-refused" | "aborted" | "git-not-found" | "developer-tools-missing" | "git-too-old" | "untrusted" | "content-missing" | "hook-refused" | "name-not-text" | "published" | undefined`

### `GitErrorCode`

```ts
type GitErrorCode = (typeof GIT_ERROR_CODES)[number]
```

### `GitObjectReader`

- `close(): Promise<void>` — Ends the git process, failing whatever was still being read. Settles once every git this reader ended has gone, so the repository's directory holds no process of this reader's when it does.
- `isOpen: boolean` — Whether the git process is open
- `read(name: string): Promise<Buffer | undefined>` — The file a name like `HEAD:src/a.ts` stands for, or nothing when git knows no such file. Rejects when git could not be asked, or for a name with a line break in it, which one line cannot carry: the caller reads that one another way.

### `GitProgress`

How far along git is with a command that talks to a remote or writes many files

```ts
interface GitProgress {
  /** What git is doing, in its own words: `Writing objects`, `Receiving objects`, `Updating files` */
  stage: string
  /** How much of that is done, from 0 to 100 */
  percent: number
}
```

### `GitRepository`

- `addRemote(name: string, url: string): Promise<void>` — Adds a remote by its name and address
- `amend(options?: { message?: string; evenIfPublished?: boolean; }): Promise<void>` — Amends the last commit with what is staged, and with `message` when given. Refused with `published` for a commit a remote branch already holds unless `evenIfPublished`; `undo` takes it back, leaving what it took in staged
- `applyHunk(filePath: string, staged: boolean, id: string): Promise<void>` — Stages one piece of a file's change, or with `staged` takes one piece out of what is staged. The piece is named by its id, and is one this repository cuts from the file as it is now: one whose file changed under it is refused, rather than applied to lines it was not made from.
- `blame(filePath: string, options?: { revision?: string; onLines?: (lines: BlameLine[]) => void; }): Promise<BlameLine[]>` — Who last changed each line of a file, at `revision` or as the working tree has it, in line order, leaving out the commits the repository lists to be ignored. `onLines` is handed each group of lines as git finds it. Blame runs the conversion programs a repository names, as a diff does, so it is refused like any other command in a repository not trusted to.
- `changedSince(id: string, paths?: string[]): Promise<CheckpointChange[]>` — What differs now from a checkpoint, of these paths when given; a file it left out is not compared
- `changesIn(commit: string): Promise<ChangedFile[]>` — The files a commit changed against its first parent, each with its count
- `checkoutBranch(branchName: string, onProgress?: (progress: GitProgress) => void): Promise<void>`
- `checkpoint(paths?: string[]): Promise<Checkpoint>` — Keeps a copy of the working tree outside the repository, in the store `RepositoryTies.checkpointDirectory` names: of these paths (from the top of the checkout) when given, and of every file git would add otherwise. Nothing of the repository's own is written. A file larger than `KEPT_FILE_LIMIT` is left out and named.
- `cherryPick(commits: string[]): Promise<void>` — Applies commits onto what is checked out, oldest first, as `merge` does its work
- `clearCache(): void`
- `close(): Promise<void>` — Lets go of what is held open for this repository, and waits for what it was asked: the git kept running while files are read from commits is ended, and every command already running or waiting its turn runs to its end. It is used again as before, and that git is started again by the next read of a file from a commit.  Settles once no git of this repository is left running. On a platform that will not delete a directory a process is in, the repository's can be deleted then and not before.
- `commit(message: string): Promise<void>`
- `commitMessage(commit: string): Promise<string>` — A commit's whole message, its subject and its body, as it was written
- `commitsExist(...refs: string[]): Promise<boolean>` — Whether each of these names a commit in this repository
- `conflictSides(filePath: string): Promise<ConflictSides>` — The three sides of a conflicted file, the working file and where its conflicts are marked (`ConflictSides`)
- `createTag(name: string, options?: { commit?: string; message?: string; }): Promise<void>` — Makes a tag at `commit` (what is checked out when none), annotated with `message` when one is given
- `deleteBranch(name: string): Promise<void>` — Deletes a local branch, merged or not; `undo` makes it again where it was, with what it followed
- `deleteRemoteBranch(branch: string, remote?: string): Promise<void>` — Deletes `branch` on `remote` (`origin` unless named)
- `deleteTag(name: string): Promise<void>`
- `discardNotKept(filePaths: string[]): Promise<string[]>` — The paths, among what discarding these would remove, that are too large for a discard to keep a copy of: what a host says cannot be brought back, before it is discarded
- `fetch(signal?: AbortSignal): Promise<{ success: boolean; code?: GitErrorCode; error?: string; }>` — Fetches from the remote this branch follows, and says whether it did and, when it did not, why. When to fetch is the host's to decide: nothing here fetches unasked.
- `fetchingMissing<T>(read: () => Promise<T>): Promise<T>` — Runs `read`, whose reads of this repository may fetch what a partial clone has not: what a read answers with `content-missing` otherwise. They wait in line with the fetches and pushes while they do, since they reach the remote. Only what `read` calls is let fetch; every other read goes on fetching nothing.
- `fetchPullRequest(number: number, remote?: string): Promise<string>` — Fetches what a pull request proposes from where GitHub keeps it, `refs/pull/<number>/head`, into `refs/remotes/<remote>/pull/<number>`, and answers that ref. GitHub keeps it after the pull request's branch is deleted, and for a pull request from a fork, whose branch is on no remote of this repository. Throws a `GitError` when the remote has no such pull request
- `fetchRemoteBranch(branch: string, remote?: string): Promise<string>` — Fetches `branch` from `remote` (`origin` unless named) into its remote-tracking ref, and answers that ref. Throws a `GitError` when the fetch fails, the remote having no such branch included
- `findBaseBranch(options?: { preferUpstream?: boolean; }): Promise<string>`
- `findNearbyMergedBranches(depth: number): Promise<string[]>` — The branches merged into the checked-out commit whose tip is within `depth` commits of it
- `getWorkingDir(): string`
- `gitLog(count?: number): Promise<CommitLogEntry[]>`
- `hasWatchFailed: boolean` — Whether this checkout's watches failed: a panel showing it then changes only when it is asked again
- `history(options?: { refs?: string[]; cursor?: string; path?: string; limit?: number; }): Promise<HistoryPage>` — A page of history to draw: from `refs` (`HEAD` when none), each commit with its parents and the refs at it, never one before a commit that descends from it; or from the `cursor` the page before gave, which continues from where the first page stood, so the pages neither repeat nor drop a commit whatever moves meanwhile. With `path`, that file's history from the first ref, followed across its renames.
- `invalidateCache(paths?: string[]): void`
- `isGitRepository(): Promise<boolean>` — Whether the working directory is in a repository. Rejects when there is no git to ask, and with an `UnsafeOwnershipError` naming the repository when git will not read it for who owns it.
- `isWriteInProgress: boolean`
- `lastUndoable(): Promise<JournalEntry | undefined>` — The last write made here that `undo` would take back: a commit, a reset to a commit, a deleted branch, a dropped or cleared stash. Nothing when there is none in the last 14 days
- `lineCounts(): Promise<(LineCount & { staged: boolean; })[]>` — How many lines each changed file adds and removes, as git counts them: what is staged against the last commit, and the working tree against what is staged. A file git does not track yet has no count.
- `listIgnoredDirectories(): Promise<string[]>` — The directories git ignores under the working directory, relative to it: what a watcher of the working tree need not report from.
- `listUntracked(directory: string): Promise<{ files: string[]; truncated: boolean; }>` — The files in an untracked folder that git would list, were it asked to list every one: those it does not ignore. `directory` is a folder row's path, from the top of the checkout.
- `markSnapshotStale(): void` — The repository may have changed in any way: the next snapshot asked for is read from git, all of it
- `merge(target: string): Promise<void>` — Merges a branch or a commit into what is checked out, after a checkpoint of the working tree. One that stops on conflicts is the operation in progress the snapshot describes, and is refused with `conflict`; one that goes through can be undone, which puts the branch and its files back and keeps what the user changed since
- `mergeBase(first: string, second: string): Promise<string | undefined>` — The commit two commits' histories last share, or nothing when they share none or one is not a commit here
- `moveOperation(move: OperationMove): Promise<void>` — Carries on with what git is in the middle of, leaves out the commit a rebase stopped at, or gives it up. Carrying on takes the message git proposes, there being no editor for it to open (`gitEnvironment`).
- `noteChanged(paths: string[] | null): void` — Notes what a watcher saw change, which is what the next snapshot asked for reads: these paths in the working tree, relative to the working directory with `/` between their parts, or everything when it could not name them
- `onWriteComplete(callback: () => void): void` — Register a one-shot callback that fires when all pending writes finish.
- `previewMerge(target: string): Promise<MergePreview>` — What merging `target` into what is checked out would do, before it is done: nothing, a fast-forward, a clean merge, or one that stops on conflicts in the files it names. For a pull, `target` is the upstream after a fetch. Nothing moves: no ref, no index and no file. `unknown` on a git older than 2.38.
- `pullBranch(onProgress?: (progress: GitProgress) => void): Promise<void>`
- `pushBranch(onProgress?: (progress: GitProgress) => void, signal?: AbortSignal): Promise<void>` — Pushes the branch; `signal` stops it, and the push then rejects with a `GitError` coded `aborted`
- `pushTag(name: string, options?: { remote?: string; onProgress?: (progress: GitProgress) => void; signal?: AbortSignal; }): Promise<void>` — Pushes a tag to a remote, `origin` unless another is named, with progress, stopped through `signal`
- `readBranchDiff(baseBranch: string, targetBranch?: string): Promise<GitStatusFile[]>`
- `readBranches(): Promise<string[]>`
- `readCommitDistance(branch: string): Promise<number>` — How many commits the checked-out commit has that this branch does not: `Infinity` when git cannot say
- `readCommitsBetween(baseBranch: string, targetBranch?: string): Promise<{ subject: string; body: string; }[]>`
- `readCurrentBranch(): Promise<string>`
- `readDiff(filePath?: string, staged?: boolean): Promise<string>`
- `readDiffs(paths: string[]): Promise<string>` — Efficient multi-path diff: issues a single `git diff -- path1 path2 …` for tracked files and builds synthetic diffs for untracked ones, avoiding one git subprocess per file.
- `readFileBytes(filePath: string, version?: "HEAD" | "working" | "index"): Promise<Buffer | undefined>` — A file's bytes: as the working tree has it, as the last commit has it, or as it is staged. Nothing when there is no such file, or it could not be read.
- `readFileBytesFromBranch(filePath: string, branch: string): Promise<Buffer | undefined>` — A file's bytes as a branch has it, or nothing when the branch has no such file
- `readFileContent(filePath: string, version?: "HEAD" | "working" | "index"): Promise<string>`
- `readFileContentFromBranch(filePath: string, branch: string): Promise<string>`
- `readHunks(filePath: string, staged: boolean): Promise<DiffHunk[]>` — The pieces of a file's change that can be staged one at a time, or unstaged when `staged`: of the working tree against the index, or of the index against the last commit. None for a file that is not plainly modified.
- `readRemote(): Promise<{ name: string; url: string; } | undefined>` — The remote a pull request or a push goes to: the one the current branch follows, else `origin`, else the only remote there is; with its address as git would use it. Nothing where there is no remote, or several and none of them is followed or named `origin`
- `readRemoteUrl(): Promise<string | undefined>` — The address of the remote this branch follows, as git would use it (its `insteadOf` rewrites applied). Nothing where there is no remote.
- `readSnapshot(): Promise<RepositorySnapshot>` — The checkout's changed files, branch and distance from its upstream.  A snapshot is reused until something says the repository may have changed: a watcher's event, a write made here, a reconcile. It never waits on the remote: `fetchIfDue` is what fetches.
- `readStagedFiles(): Promise<GitStatusFile[]>`
- `readStashChanges(index: number): Promise<ChangedFile[]>` — The files a stash holds against the commit it was made on, each with its count, its untracked files among them as added: what applying it would bring, read without applying it. A file's two sides are `readFileContentFromBranch(path, 'stash@{n}^1')` and `(path, 'stash@{n}')`, or `'stash@{n}^3'` for an untracked one
- `readStatus(): Promise<GitStatusFile[]>`
- `readTrust(): Promise<TrustReading>` — What this repository would have git run, read without running any of it: the settings of its own that are not known to run nothing, and its hooks. While it names anything and the host has not said the repository is trusted (`RepositoryTies.isTrusted`), every other command here is refused with an `UntrustedError`.
- `rebaseOnto(target: string): Promise<void>` — Replays what is checked out onto a branch or a commit, as `merge` does its work: checkpointed, and undone the same
- `refreshSnapshot(reading?: "everything" | "noted", options?: { refreshIndex?: boolean; }): Promise<RepositoryChange>` — Reads the repository from git and says which parts of it differ from the last check. A watcher's event is a hint that something changed; this is what decides whether anything did, and what.  A check a watcher's event started reads `noted`: what the watcher said changed (`noteChanged`), and nothing when it said nothing since the last read. Any other check has no event to go by, and reads everything.  **`refreshIndex` lets this one status write git's index**, which no other read here may (`GIT_OPTIONAL_LOCKS`). Git keeps in the index what it last saw of each file, and a status that may not write it re-reads every file whose time moved, on every run: after a checkout or a formatter over the tree, that is every file, every time. Writing it holds git's lock for as long as the status takes, in which a git run from a terminal would be refused, so it is the caller's to say when: at a moment nothing else is likely to be running git, and only when something says the index may be stale.
- `refsModel(): Promise<RefsModel>` — Every branch, local and each remote's, with what it follows and how far ahead and behind it is, read in one command; the remotes with their addresses; and the tags. The snapshot's `refs` part says when any of it moved.
- `rememberedBaseOf(branch: string): Promise<string | undefined>` — The branch this one was made from, where something wrote that down: this engine when it made the branch, VS Code when it did, or git itself, whose record of a branch's first move says what it was made from when it was given a name. Nothing when none did, or when what they name is gone.
- `removeRemote(name: string): Promise<void>` — Removes a remote, and the branches of it git keeps
- `renameBranch(name: string, to: string): Promise<void>` — Renames a local branch, and what it follows with it; refused with `branch-exists` when the name is taken
- `renameRemote(name: string, to: string): Promise<void>` — Renames a remote, and the branches of it git keeps with it
- `resetToCommit(hash: string): Promise<void>`
- `resolveConflict(filePath: string, answer: ConflictAnswer): Promise<void>` — Resolves a conflicted file with one side, or with content written in its place, and marks it resolved. A side that deleted the file resolves it by deleting it
- `resolveGitDirectories(): Promise<GitDirectories | null>` — Where this checkout's git state lives: its own git directory (index, HEAD) and the common one holding refs. The two differ in a linked worktree. Null when the working directory is in no repository.
- `restoreCheckpoint(id: string, paths?: string[]): Promise<CheckpointChange[]>` — Puts the working tree back as a checkpoint has it, of these paths when given: a file changed since is put back, one made since is removed, and one it left out is left alone. Answers what it changed. The index is not touched, so what was staged reads as changed against it.
- `restoreDiscarded(id: string): Promise<DiscardRestored>` — Puts back what a discard kept, by the id it answered with. A path changed or made again since is left as it is and named. Rejects when git no longer keeps it, which it does for as long as it keeps objects nothing refers to: two weeks, unless the user's settings or a prune say otherwise.
- `revertCommit(hash: string): Promise<void>`
- `revertFile(filePath: string): Promise<DiscardKept>` — Discards a file's changes, or an untracked file or folder, and answers with what it kept of what that removed: `restoreDiscarded` puts it back. Nothing is removed when the copy could not be taken.
- `revertFiles(filePaths: string[]): Promise<DiscardKept>` — The same for several at once, kept as one
- `rewrite(base: string, steps: RewriteStep[], options?: { evenIfPublished?: boolean; }): Promise<void>` — Rewrites the commits after `base` by the steps given, in the order they are to stand: each kept, reworded, folded into the one before, or dropped. Refused with `published` for a range a remote branch already holds part of unless `evenIfPublished`; checkpointed first, and undone with `undo`
- `setRemoteUrl(name: string, url: string, { push }?: { push?: boolean; }): Promise<void>` — Changes where a remote is fetched from, or with `push` where it is pushed to
- `setStatusNote(note: string): void` — What the host shows beside the status and is no part of git's, such as whether it is fetching: a change to it reads as a change to the status at the next check, so the windows showing the checkout are told
- `setWatched(watched: boolean, failed?: boolean): void` — Says whether a watcher reports this checkout's changes, which is what lets a snapshot be reused. `failed` says its watches could not be opened or have stopped, as opposed to not being open yet or not being wanted.
- `speedUpStatus(): Promise<{ fileMonitor: boolean; untrackedCache: boolean; }>` — Turns on what makes a whole status faster in this repository's own settings: git's untracked cache, and its own file monitor where git has one (macOS and Windows, from 2.37). It writes the user's git settings, so a host does it only when the user asks. Answers what is on now
- `stageFiles(filePaths: string[]): Promise<void>`
- `stashApply(index: number): Promise<void>`
- `stashClear(): Promise<void>`
- `stashDrop(index: number): Promise<void>`
- `stashList(): Promise<StashEntry[]>`
- `stashPop(index: number): Promise<void>`
- `stashPush(message?: string, stagedOnly?: boolean, paths?: string[]): Promise<string>` — Stashes the changes, untracked files included: only what is staged with `stagedOnly`, and only these paths (from the top of the checkout) when `paths` names any
- `trustOwnership(directory: string): Promise<void>` — Adds a repository git refused for who owns it to the user's `safe.directory` entries, which is what git's refusal says to do. It writes the user's global git configuration, so it is run only when the user asks. `directory` is an `UnsafeOwnershipError`'s, the path as git printed it.
- `undo(options?: { evenIfPublished?: boolean; }): Promise<JournalEntry>` — Takes back the last write `lastUndoable` names, and answers it. A commit is taken off its branch with what it held left staged; a reset puts the branch and the index back; a branch is made again; a stash is put back on top. Refused with a `GitError` when a ref it moved has moved since, and with `published` for a commit a remote branch already holds, unless `evenIfPublished`.
- `unstageFiles(filePaths: string[]): Promise<void>`
- `worktreeAdd(wtPath: string, branch?: string, createBranch?: boolean): Promise<string>`
- `worktreeList(): Promise<WorktreeEntry[]>`
- `worktreeRemove(wtPath: string, force?: boolean): Promise<void>`

### `GitStatusFile`

One changed path of a checkout, as a status lists it: once for what is staged of it and once for what is not

```ts
interface GitStatusFile {
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
   * The file's name is not text, so `path` is not the name it has and nothing can be done to it here: listed so it
   * is not lost from sight, and refused by name (`name-not-text`) when asked for
   */
  nameNotText?: true
  /**
   * For a submodule's row, how it differs, as git says in its parent's status: it is on another commit, files it
   * tracks changed, or it has files it does not track. Each is news of the submodule's own status as well
   */
  submodule?: { commit: boolean; modified: boolean; untracked: boolean }
}
```

### `GitUnusable`

Why a git cannot be used

```ts
type GitUnusable =
  | { code: 'git-not-found'; git: string }
  /** On macOS, `/usr/bin/git` before the developer tools are installed: running it offers to install them */
  | { code: 'developer-tools-missing'; git: string }
  | { code: 'git-too-old'; git: string; version: string }
```

### `GitUnusableError`

A command not run because the git it would run cannot be used

- `unusable: GitUnusable`

### `gitVersionOf`

The version `git --version` printed, whatever a build adds after it: `2.39.5 (Apple Git-154)`, `2.47.1.windows.1`

```ts
gitVersionOf(printed: string): string | undefined
```

### `GitWatcherService`

Reports that a checkout may have changed: its working tree, its index and HEAD, or its refs.

**An event is a hint, and git is what says whether anything changed.** So nothing here needs to be exact: an
event for a file git ignores costs one status that finds no difference, and an event the platform never
delivered is made up for by `check`, which whoever knows the repository may have moved calls — a window
gaining focus, a terminal command finishing, an agent's turn ending.

- `check(): Promise<void>` — Brings the watches in line with the checkout as it is now, for a caller that knows it may have moved. A directory that became a repository starts being watched, a watch that failed or ended with its directory is opened again, and the ignored directories are taken afresh.
- `isActive(): boolean`
- `setChangeCallback(callback: (paths: ChangedPaths) => void): void`
- `setGitRepository(repo: GitRepository): void`
- `startWatching(signal: AbortSignal): Promise<void>` — Opens the watches and resolves once they are open, which is not once they report: the platform starts delivering a moment later and says nothing when it does, so an edit made in between has no event. A while after opening (`catchUpAfterMs`, two seconds unless a host says otherwise), the checkout is reported once as one in which anything may have changed, which covers that edit; a later change no event reported is what `check` is for.
- `stopWatching(): Promise<void>`

### `HistoryCommit`

A commit as a history draws it: with every parent, and the refs that point at it

```ts
interface HistoryCommit {
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
```

### `HistoryPage`

One page of a history (`GitRepository.history`)

```ts
interface HistoryPage {
  commits: HistoryCommit[]
  /** Hands back to `history` for the next page; absent when this page ends the history */
  cursor?: string
}
```

### `HookRefusedError`

A command a repository's hook refused, with the hook's name, the code it exited with and what it printed

- `exitCode: number`
- `hook: string`
- `output: string`

### `JournalEntry`

A write the engine made that can be taken back (`GitRepository.undo`)

```ts
interface JournalEntry {
  id: string
  /** What was done */
  operation: 'commit' | 'reset' | 'delete-branch' | 'drop-stash' | 'clear-stashes' | 'merge' | 'rebase' | 'cherry-pick' | 'amend' | 'rewrite'
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
```

### `KEPT_FILE_LIMIT`

The largest file a checkpoint keeps a copy of. A larger one is left out, and the checkpoint names it

```ts
KEPT_FILE_LIMIT: number
```

### `LineCount`

How many lines a changed file adds and removes, as git counts them; none for a file that is not text

```ts
interface LineCount {
  path: string
  added: number
  removed: number
  /** Not text, so git counts no lines in it */
  binary: boolean
}
```

### `MergePreview`

What merging a branch into what is checked out would do: nothing, a fast-forward, a merge that goes through, or
one that stops on conflicts in `files` (paths from the top of the checkout). `unknown` on a git that cannot say

```ts
type MergePreview =
  | { kind: 'up-to-date' | 'fast-forward' | 'clean' | 'unknown' }
  | { kind: 'conflicts'; files: string[] }
```

### `nodeSubscriber`

Node's own recursive watch. The platform reports every change under the directory, so the ignored ones are
dropped here; a change to the watched directory itself arrives under that directory's own name. Deleting
the directory does not end the watch on macOS, where one made again at the path is reported on, and is an
error on Windows.

```ts
nodeSubscriber(watch?: WatchTree): SubscribeToDirectory
```

### `NOTHING_CHANGED`

```ts
NOTHING_CHANGED: RepositoryChange
```

### `olderThan`

Whether version `a` is older than `b`, comparing the numbers each part holds

```ts
olderThan(a: string, b: string): boolean
```

### `OperationKind`

```ts
type OperationKind = (typeof OPERATION_KINDS)[number]
```

### `OperationMove`

```ts
type OperationMove = (typeof OPERATION_MOVES)[number]
```

### `parseStatus`

Reads `git status --porcelain=v2 --branch -z`: the branch headers and one record per changed path

```ts
parseStatus(output: string): RepositorySnapshot
```

### `perDirectorySubscriber`

A watch on every directory of a tree, one each, for a platform that has no watch over a tree.

A directory is watched and then read, in that order, so what is made in it meanwhile is either reported by
its watch or found by the reading. One that appears later is watched the same way, and reported once more
when its watches are in place: what was made in it before then was reported by nothing, and whoever hears a
directory changed asks about everything under it. One that goes has its watches closed with it, and the
watched directory itself going is an error, since nothing reports on one made again at its path.

**A watch is on the directory that was at a path when it was opened, not on the path.** A directory deleted
and made again at once (`rm -rf dist && mkdir dist`) is another directory under the same name, and the watch
on the first reports nothing of it. So each watch is held with which directory it is on, and a path that is
found to hold another is watched again.

The platform's limit on watches is reached one directory at a time. Running out while the tree is first
read fails the subscription, and running out later is reported as an error: either way the tree is not all
watched, and whoever opened the watch is told so rather than left with part of one.

```ts
perDirectorySubscriber(watch?: WatchDirectory): SubscribeToDirectory
```

### `progressReader`

Reads git's error stream as it arrives and reports each step forward: a stage, and the percent of it done.
Git repeats a line when a stage ends, and a chunk can end in the middle of one, so only whole lines are read
and only a change is reported.

```ts
progressReader(report: (progress: GitProgress) => void): (chunk: string) => void
```

### `RefsModel`

A repository's branches, remotes and tags, as one model

```ts
interface RefsModel {
  branches: BranchStanding[]
  /** Each remote with where it fetches from and pushes to, which are the same unless told otherwise */
  remotes: { name: string; fetchUrl: string; pushUrl: string }[]
  tags: { name: string; commit: string }[]
}
```

### `REPOSITORY_PARTS`

The parts of a repository, each read and refreshed on its own: its changed files with the branch and its
distance from upstream; the two sides of each changed file, which a diff of it shows; which branch is checked
out, the commit it is on and every branch and tag, which a log is read from; its stashes; its worktrees.

```ts
REPOSITORY_PARTS: readonly ["status", "diffs", "history", "stashes", "worktrees", "refs"]
```

### `RepositoryChange`

Which parts of a repository differ from when it was last checked

```ts
type RepositoryChange = Record<RepositoryPart, boolean> & {
  /** The changed files whose diff differs, when they are few enough to name: without it, any of them may */
  files?: string[]
}
```

### `RepositoryLog`

```ts
interface RepositoryLog {
  warn?(message: string, data?: Record<string, unknown>): void
  error?(message: string, data?: Record<string, unknown>): void
  /** Every git command run, with how long it took and whether it worked: a line each */
  command?(line: string): void
}
```

### `RepositoryOperation`

What git is in the middle of in a checkout

```ts
interface RepositoryOperation {
  kind: OperationKind
  /** What is merged in, rebased onto, picked or reverted, as a person would name it: a branch where one is known, else a short commit */
  subject: string
  /** The branch a rebase is replaying, where it is replaying one */
  branch?: string
  /** A rebase's place among the commits it replays, counted from one */
  step?: number
  steps?: number
}
```

### `RepositoryPart`

```ts
type RepositoryPart = (typeof REPOSITORY_PARTS)[number]
```

### `RepositorySnapshot`

A checkout's changed files, branch and distance from its upstream, read in one pass

```ts
interface RepositorySnapshot {
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
  /**
   * Whether live updates have stopped arriving here: checks with nothing to go by keep finding changes the watcher
   * never reported, as a watch on a network drive or past the system's limit on watches does. A host says the
   * view may be behind, and goes on checking when the window is looked at
   */
  watchSilent?: true
  /**
   * A whole status took longer than its budget (`RepositoryTies.statusBudgetMs`), and git's own file monitor or its
   * untracked cache is off, either of which would make it faster: `speedUpStatus` turns them on. Absent when the
   * status was within its budget, or both are on already
   */
  slowStatus?: { ms: number; budgetMs: number; fileMonitor: boolean; untrackedCache: boolean }
  /** What git is in the middle of here, when it is in the middle of anything */
  operation?: RepositoryOperation
}
```

### `RepositoryTies`

```ts
interface RepositoryTies {
  /**
   * The git to run: a path, or a name the PATH is searched for. `git` when not given. Where a host looks for one
   * is the host's to decide; whether it can be used is the engine's, asked before the first command
   */
  git?: string
  /** The environment git's children start from, over which the engine lays its own. The process's own when not given */
  environment?: () => NodeJS.ProcessEnv
  run?: RunProcess
  /** Without one, a git kept open is not watched */
  watchProcess?: WatchProcess
  log?: RepositoryLog
  /** How long a command waits for another git to let go of a lock it needs */
  lockPatienceMs?: number
  /** How long a whole status may take before the snapshot says it is slow (`STATUS_BUDGET_MS` when not given) */
  statusBudgetMs?: number
  /**
   * Whether the repository whose git state lives at this real path is one the host trusts to have git run what
   * its own configuration and hooks name. Without one, no repository is, and one that names anything is refused
   */
  isTrusted?: (repository: string) => boolean
  /**
   * Where the store that keeps copies of this repository's working tree is (`GitRepository.checkpoint`), for the
   * repository whose common git directory is at this real path. Under the system's temporary directory when not
   * given, which the system may empty
   */
  checkpointDirectory?: (commonDir: string) => string
}
```

### `RewriteStep`

One commit of a range being rewritten, in the order it is to stand: kept as it is, kept with a new message,
folded into the one before it (with `message` for the two, or the one before's), or dropped

```ts
interface RewriteStep {
  commit: string
  action: 'pick' | 'reword' | 'squash' | 'drop'
  message?: string
}
```

### `RunOptions`

What a git is run with

```ts
interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  maxBuffer: number
  encoding: BufferEncoding
}
```

### `RunProcess`

Runs a process: `execFile`'s promise, with the child beside it. A host that ends a process which has stopped
working hands in the function that does; without one the process runs for as long as it runs.

```ts
type RunProcess = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }> & { child: ChildProcess }
```

### `runUnbounded`

`execFile` as a promise with its child beside it, unbounded: what runs git when a host hands nothing in

```ts
runUnbounded(file: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string; }> & { child: ChildProcess; }
```

### `settingRunsNothing`

Whether a setting is known to run nothing. A key is `section.variable` or `section.subsection.variable`, the
section and the variable in lower case as git prints them, the subsection as it is spelled and with any dots.

```ts
settingRunsNothing(key: string, value: string): boolean
```

### `StashConflictError`

A stash applied or popped with conflicts: its changes are in the working tree with conflict markers


### `StashEntry`

```ts
interface StashEntry {
  index: number
  ref: string
  message: string
  date: string
}
```

### `STATUS_LIMIT`

The most changed files a snapshot lists; past it the list is cut and says so

```ts
STATUS_LIMIT: 10000
```

### `SubscribeToDirectory`

Watches a directory and everything under it, apart from the directories `ignore` names relative to it.
An error means the watch has stopped reporting, or may have.

`onEvent` is called for every event the platform delivers, the ones under an ignored directory included,
which `onChanges` never hears of. How many arrive is the one thing known here about how hard the platform's
queue is being pressed: it drops events when the queue is full and says so to nobody.

```ts
type SubscribeToDirectory = (
  directory: string,
  onChanges: (error: Error | null, changes: WatchedChange[]) => void,
  options: { ignore: string[]; onEvent?: () => void },
) => Promise<DirectorySubscription>
```

### `TrustAsk`

One thing a repository would have git run, or a setting not known to run nothing

```ts
type TrustAsk =
  /** A setting in the repository's own configuration, or in a file that includes */
  | { kind: 'setting'; key: string; value: string; file: string }
  /** A hook the repository holds, which git runs at the moment the hook is named for */
  | { kind: 'hook'; name: string; file: string }
```

### `TrustReading`

What a repository asks to be trusted for, and whether a host has said it is

```ts
interface TrustReading {
  trusted: boolean
  /** What it would have git run. With none, nothing is refused whether it is trusted or not */
  asks: TrustAsk[]
  /** What names the repository to a host that remembers trust: where its git state lives, by its real path */
  repository?: string
}
```

### `UnsafeOwnershipError`

A repository git will not read because another user owns it: on a shared or external drive, in a container,
in a folder made under `sudo`. `directory` is the path as git printed it, which is the one git matches against
the user's `safe.directory` entries (`GitRepository.trustOwnership`).

- `directory: string`

### `UNTRACKED_LISTED_LIMIT`

The most files of an untracked folder that are listed when it is opened; past it the list is cut and says so

```ts
UNTRACKED_LISTED_LIMIT: 1000
```

### `UntrustedError`

A git command refused because the repository would have git run something and has not been trusted

- `asks: TrustAsk[]`
- `repository: string | undefined`

### `WatchDirectory`

The part of `fs.watch` a watch on one directory uses

```ts
type WatchDirectory = (
  directory: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }
```

### `WatchedChange`

Where under a watched directory something changed, relative to it; `null` when the platform could not say

```ts
type WatchedChange = string | null
```

### `WatchFile`

The part of `fs.watch` a watch on one file uses

```ts
type WatchFile = (
  file: string,
  options: { persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }
```

### `WatchProcess`

Watches a process that is kept open while it owes an answer, and calls `onStalled` once it has done no work and
written nothing for too long. `output()` says it wrote something, and `stop()` ends the watch.

```ts
type WatchProcess = (pid: number, onStalled: () => void, idleMs?: number) => { output(): void; stop(): void }
```

### `WatchTree`

The part of `fs.watch` a watch over a tree uses

```ts
type WatchTree = (
  directory: string,
  options: { recursive: true; persistent: false },
  listener: (eventType: string, filename: string | null) => void,
) => { on(event: 'error', listener: (error: Error) => void): unknown; close(): void }
```

### `withoutProgress`

What git printed to its error stream without the progress in it, which is what there is to say of a failure

```ts
withoutProgress(printed: string): string
```

### `WorktreeEntry`

```ts
interface WorktreeEntry {
  path: string
  head: string
  branch: string
  isBare: boolean
  isCurrent: boolean
  isMain: boolean
  isLocked: boolean
  lockedReason?: string
}
```

## `apack-git/staging`

### `withStaged`

The list once these paths are staged

```ts
withStaged(files: GitStatusFile[], paths: string[]): GitStatusFile[]
```

### `withUnstaged`

The list once these paths are unstaged

```ts
withUnstaged(files: GitStatusFile[], paths: string[]): GitStatusFile[]
```

## `apack-git/availability`

### `Availability`

```ts
type Availability = { possible: true } | { possible: false; reason: UnavailableReason }
```

### `UnavailableReason`

```ts
type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]
```

### `whatCanBeDone`

What can be done now, from a snapshot as the engine reads it

```ts
whatCanBeDone(snapshot: RepositorySnapshot): WhatCanBeDone
```

### `WhatCanBeDone`

Whether a commit, a push, a pull and a sync (a pull then a push) can be done now, and the first reason when not

```ts
interface WhatCanBeDone {
  commit: Availability
  push: Availability
  pull: Availability
  sync: Availability
}
```
