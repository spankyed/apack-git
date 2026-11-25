// The git engine's door: the only module anything outside this folder imports.
//
// The engine owns one working tree's truth and every git process. A host owns who is looking, what to show and
// what to say: it hands in how a process is run, the environment git starts from and where to log
// (`RepositoryTies`), tells the engine what may have changed, and is told only what really differs.
export { GitRepository } from './repository.js'
export { GitWatcherService, type ChangedPaths } from './watcher.js'
export {
  nodeSubscriber, perDirectorySubscriber,
  type DirectorySubscription, type SubscribeToDirectory, type WatchDirectory, type WatchTree, type WatchedChange,
} from './directory-watch.js'
export { followFile, type FileFollower, type FollowFile, type WatchFile } from './file-watch.js'
export { GitError, HookRefusedError, HostRefusedError, LocalChangesError, UnsafeOwnershipError, classifyGitError, type GitErrorCode, type HostRule } from './errors.js'
export { GIT_FLOOR, GitUnusableError, gitVersionOf, olderThan, type GitUnusable } from './git-check.js'
export { UntrustedError, settingRunsNothing, type TrustAsk, type TrustReading } from './trust.js'
export { StashConflictError } from './writes.js'
export { GitObjectReader } from './objects.js'
export { progressReader, withoutProgress } from './progress.js'
export { KEPT_FILE_LIMIT } from './checkpoints.js'
export { UNTRACKED_LISTED_LIMIT } from './reads.js'
export { NOTHING_CHANGED, STATUS_LIMIT, changedAnything, parseStatus } from './status.js'
export { runUnbounded, type RepositoryLog, type RepositoryTies, type RunOptions, type RunProcess, type WatchProcess } from './ties.js'
export {
  REPOSITORY_PARTS,
  type Checkpoint, type CheckpointChange, type CommitLogEntry, type ConflictAnswer, type ConflictKind, type ConflictSides, type JournalEntry, type DiffHunk, type DiscardKept, type DiscardRestored, type GitDirectories, type GitProgress, type GitStatusFile, type OperationKind, type OperationMove, type ChangedFile, type FoundRepository, type LineCount, type HistoryCommit, type HistoryPage, type BlameLine, type BranchStanding, type RefsModel, type MergePreview, type RewriteStep,
  type BranchCheckout, type GitRemote, type RepositoryChange, type RepositoryOperation, type RepositoryPart, type RepositorySnapshot, type StashEntry, type Trailer, type Undoable, type Undone, type WorktreeEntry,
} from './types.js'
